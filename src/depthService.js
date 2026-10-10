'use strict';

/**
 * depthService —— 壁纸深度图按需生成 + 集中缓存（深度视差功能的主进程侧）。
 *
 * 数据流：
 *   渲染端 depthFor(图片路径) → IPC depth:lookup → lookup()
 *     缓存命中 → 返回深度文件路径，渲染端走 WebGL 视差
 *     未命中   → 返回 null（渲染端先按普通 2D 播），同时入队后台生成；
 *                生成完回调 onReady → 主进程广播 depth:ready → 渲染端现场升级
 *
 * 设计要点：
 *   - 缓存键 = sha1(路径|mtimeMs|size)：图换了内容缓存自动失效，改名/移动视为新图。
 *     集中存放（不进相簿目录）—— 相簿在 Syncthing 同步范围内，sidecar 散落进去
 *     会把 2.4GB 垃圾同步到别的机器。
 *   - worker 是常驻 Python 进程（模型只加载一次），单并发队列，单张失败不带走进程。
 *     空闲 10 分钟杀掉省显存（3070 Ti 还要跑 ComfyUI），下次 miss 自动重拉。
 *   - 全链路 fail-soft：Python 不存在 / 模型缺失 / worker 连挂 3 次 → 功能静默降级
 *     （lookup 永远返回 null，壁纸照常播 2D），绝不影响壁纸主业务。
 */

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const debugLog = require('./debugLog');

const QUEUE_MAX = 64;             // 队列上限，满了丢弃（下次 miss 会再入队）
const IDLE_KILL_MS = 10 * 60 * 1000;
const JOB_TIMEOUT_MS = 90 * 1000; // 8K 图 + 冷启动也要不了这么久；超时按坏 worker 处理
const SPAWN_FAIL_LIMIT = 3;

/* ---- 缓存 LRU 上限（第十九轮）----
 * 实测 2026-10-09：2016 张深度图 ≈ 204MB（约 104KB/张），全图库 ~2.5 万张
 * 全部生成也就 ~2.6GB。定 2GB 上限 = 覆盖全库绰绰有余，又保证极端情况
 * （图库无限增长/换库）不会无限吃盘。命中时 touch mtime，超限删最久未用。
 */
const CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;   // 2GB
const EVICT_SWEEP_MIN_MS = 5 * 60 * 1000;           // 扫描节流：至多 5 分钟一次
const EVICT_TARGET = 0.9;                           // 超限后清到 90%，避免临界抖动

/* ---- 运行时路径解析（r25）----
 * 三样外部依赖（Python / worker 脚本 / 深度模型）按序探测，第一个存在的胜出：
 *   1. 配置覆盖（config.depthPython / depthWorkerScript / depthModelDir）
 *   2. 打包布局（appRoot 内：depth-env\python.exe、depth_worker.py、models\depth-anything）
 *   3. 本机开发布局（legacy 写死路径 —— 老机器升级上来不破坏现状）
 * 全找不到 → configure 时就置 disabled + 给出精确原因（不用等 worker 连挂 3 次）。
 */
const LEGACY_PATHS = {
  python: 'F:\\miniconda3\\python.exe',
  modelDir: 'D:\\workbuddy\\tools\\MoyuFloat\\wallpaper\\model',
};

/** 返回候选里第一个真实存在的路径；都没有返回 '' */
function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '';
}

const state = {
  enabled: true,
  appRoot: null,               // 打包布局的基准目录（main configure 传入；缺省 = 仓库根）
  python: '',
  workerScript: '',
  modelDir: '',
  cacheDir: null,
  cacheLimitBytes: CACHE_LIMIT_BYTES,
  onReady: null,
  // 运行态
  worker: null,
  workerBuf: '',
  workerFails: 0,
  busy: false,
  queue: [],
  queuedSet: new Set(),        // path 去重
  idleTimer: null,
  jobTimer: null,
  currentJob: null,
  lastEvictSweep: 0,
  disabledReason: '',
  stats: { hits: 0, misses: 0, generated: 0, failed: 0, dropped: 0 },
};

/**
 * 解析三样外部依赖的实际路径，写入 state；全部探测结果记进返回值
 * （status() 直接用）。覆盖项即使不存在也原样采用 —— 用户显式指定的路径
 * 找不到时要在 disabledReason 里如实说，而不是悄悄换一个。
 */
function resolveRuntime() {
  const appRoot = state.appRoot || path.join(__dirname, '..');
  const res = {
    python: [
      state.overrides && state.overrides.python,
      path.join(appRoot, 'depth-env', 'python.exe'),
      LEGACY_PATHS.python,
    ],
    workerScript: [
      state.overrides && state.overrides.workerScript,
      path.join(appRoot, 'depth_worker.py'),
      path.join(__dirname, '..', 'tools', 'depth_worker.py'),
    ],
    modelDir: [
      state.overrides && state.overrides.modelDir,
      path.join(appRoot, 'models', 'depth-anything'),
      LEGACY_PATHS.modelDir,
    ],
  };
  const out = {};
  for (const k of Object.keys(res)) {
    const [override, ...rest] = res[k];
    // 显式覆盖不存在也原样采用（disabledReason 里如实报告）；
    // 没覆盖才按候选序探测，全找不到时落最后一个候选（legacy 路径，
    // 状态行/原因里能看到它指哪 —— 比空串更有诊断价值）
    out[k] = (override && String(override)) || firstExisting(rest) || rest[rest.length - 1] || '';
  }
  state.python = out.python;
  state.workerScript = out.workerScript;
  state.modelDir = out.modelDir;
  return out;
}

function log(...args) {
  console.log('[depth]', ...args);
  debugLog.dlog('depth', ...args);   // VBS 启动丢 stdout，关键诊断要落文件
}

function keyFor(entryPath) {
  let st;
  try { st = fs.statSync(entryPath); } catch { return null; }
  return crypto.createHash('sha1')
    .update(`${entryPath}|${st.mtimeMs}|${st.size}`)
    .digest('hex');
}

/** 三件套路径：depth（单平面必需）+ mask/bg（图层分割，第六轮起） */
function trioFor(entryPath) {
  const key = keyFor(entryPath);
  if (!key) return null;
  const base = path.join(state.cacheDir, key);
  return { depth: `${base}.depth.png`, mask: `${base}.mask.png`, bg: `${base}.bg.jpg` };
}

/** 常驻 worker 的 stdout 行分发 */
function handleWorkerLine(line) {
  const text = line.trim();
  if (!text) return;
  if (text === 'READY') { log('worker 模型就绪'); return; }
  const job = state.currentJob;
  if (!job) return;                       // 迟到的行（超时已放弃）忽略
  if (text.startsWith('WARN')) {          // 图层分割子产物失败：不消耗 job，等 DONE
    log('WARN:', path.basename(job.path), text.slice(0, 160));
    return;
  }
  clearTimeout(state.jobTimer);
  state.currentJob = null;
  state.busy = false;
  if (text === 'DONE') {
    state.stats.generated += 1;
    if (fs.existsSync(job.out)) {
      log('生成完成:', path.basename(job.path));
      scheduleEvictSweep();   // 缓存总量又涨了，安排一次超限检查（内部节流）
      try { if (state.onReady) state.onReady(job.path); } catch (_) { /* 回调异常不传播 */ }
    } else {
      state.stats.failed += 1;
    }
  } else if (text.startsWith('FAIL') || text.startsWith('FATAL')) {
    state.stats.failed += 1;
    log('生成失败:', path.basename(job.path), text.slice(0, 200));
    if (text.startsWith('FATAL')) killWorker('FATAL');   // 模级错误：换进程重来
  } else {
    // 不认识的行（torch 加载进度条之类）→ 不消耗 job，等真正的结果行
    state.busy = true;
    state.currentJob = job;
    return;
  }
  pump();   // 下一单
}

/* ---- 缓存 LRU（第十九轮）---- */

/** 命中即 touch mtime（LRU 的「使用」信号；mtime 在 Windows 上可靠且 stat 免费顺带） */
function touchCacheFile(file) {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch (_) { /* 文件刚被清掉/占用：无所谓，下次 miss 会重新生成 */ }
}

/** 生成成功后排一次清理检查（节流：5 分钟内只排一次，错峰 30s 执行） */
function scheduleEvictSweep() {
  const now = Date.now();
  if (now - state.lastEvictSweep < EVICT_SWEEP_MIN_MS) return;
  state.lastEvictSweep = now;
  const t = setTimeout(evictSweep, 30 * 1000);
  if (t.unref) t.unref();
}

/** 全量扫缓存目录，超限就按 mtime 从旧到新删到 90% */
function evictSweep() {
  if (!state.cacheDir) return;
  let names;
  try { names = fs.readdirSync(state.cacheDir); } catch { return; }
  let total = 0;
  const items = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(state.cacheDir, name));
      if (!st.isFile()) continue;
      total += st.size;
      items.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch (_) { /* 竞态消失：当没这文件 */ }
  }
  if (total <= state.cacheLimitBytes) return;
  const target = state.cacheLimitBytes * EVICT_TARGET;
  items.sort((a, b) => a.mtime - b.mtime);   // 最久未用在前
  let freed = 0, removed = 0;
  for (const it of items) {
    if (total - freed <= target) break;
    try {
      fs.unlinkSync(path.join(state.cacheDir, it.name));
      freed += it.size; removed += 1;
    } catch (_) { /* 占用中/已消失：跳过，下一轮再收 */ }
  }
  log(`缓存清理：超限删 ${removed} 个文件释放 ${(freed / 1048576).toFixed(0)}MB`
    + `（${(total / 1048576).toFixed(0)}MB → 限 ${(state.cacheLimitBytes / 1048576).toFixed(0)}MB）`);
}

function spawnWorker() {
  if (state.workerFails >= SPAWN_FAIL_LIMIT) {
    if (state.enabled) {
      state.enabled = false;
      state.disabledReason = `worker 连续失败 ${state.workerFails} 次，深度功能已降级`;
      log(state.disabledReason);
    }
    return;
  }
  // 运行中环境消失（用户删了 env / 换了盘）：立刻降级并说清原因，别空转重试
  if (!fs.existsSync(state.python) || !fs.existsSync(state.workerScript)) {
    if (state.enabled) {
      state.enabled = false;
      state.disabledReason = `运行环境消失：python=${state.python} worker=${state.workerScript}`;
      log(state.disabledReason);
    }
    return;
  }
  log('拉起 worker...');
  try {
    // 钉死 Python 的 IO 编码：用户桌面环境没有 PYTHONUTF8，worker 会按 cp936
    // 解码任务行，中文/日文路径字节流吃掉 JSON 反斜杠 → Invalid \escape。
    // （worker 侧也 reconfigure 了，这里双保险 —— 进程环境是根，优先保证。）
    const w = spawn(state.python, [state.workerScript, '--model', state.modelDir], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    w.stdout.setEncoding('utf8');
    w.stdout.on('data', (chunk) => {
      state.workerBuf += chunk;
      let idx;
      while ((idx = state.workerBuf.indexOf('\n')) >= 0) {
        const line = state.workerBuf.slice(0, idx);
        state.workerBuf = state.workerBuf.slice(idx + 1);
        handleWorkerLine(line);
      }
    });
    w.stderr.setEncoding('utf8');
    w.stderr.on('data', () => { /* 噪声（进度条/警告），不进日志刷屏 */ });
    w.on('exit', (code) => {
      if (state.worker === w) {
        state.worker = null;
        state.busy = false;
        state.currentJob = null;
        clearTimeout(state.jobTimer);
        // 非礼貌退出（EXIT code 0 / 我们主动 kill）都算失败痕迹，累计降级
        if (code !== 0) {
          state.workerFails += 1;
          log(`worker 退出 code=${code}（累计失败 ${state.workerFails}）`);
          // 队列里还有活就重拉（spawnWorker 内部有降级闸）
          if (state.queue.length) setTimeout(pump, 1000);
        }
      }
    });
    state.worker = w;
    state.workerBuf = '';
  } catch (err) {
    state.workerFails += 1;
    log('worker 拉起失败:', err.message);
  }
}

function killWorker(why) {
  if (state.worker) {
    log('杀掉 worker:', why || 'idle');
    try { state.worker.kill(); } catch (_) { /* 已死 */ }
    state.worker = null;
  }
  state.busy = false;
  state.currentJob = null;
  clearTimeout(state.jobTimer);
}

function armIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (!state.busy && !state.queue.length) killWorker('idle');
  }, IDLE_KILL_MS);
  if (state.idleTimer.unref) state.idleTimer.unref();
}

function pump() {
  armIdleTimer();
  if (state.busy || !state.queue.length) return;
  if (!state.enabled || state.workerFails >= SPAWN_FAIL_LIMIT) { state.queue = []; state.queuedSet.clear(); return; }
  if (!state.worker) spawnWorker();
  if (!state.worker || !state.worker.stdin.writable) return;   // exit 回调稍后重拉
  // LIFO 取队尾：短时间快速切图时，入队顺序是 旧→新，正在看的那张永远最后
  // 生成（前面几十张 4K 积压能拖几分钟）。取队尾 = 最新看的图插队先生成，
  // 旧任务等切换停下来再慢慢补（缓存键去重，重复出现不会重复生成）。
  const job = state.queue.pop();
  state.queuedSet.delete(job.path);
  state.currentJob = job;
  state.busy = true;
  try {
    state.worker.stdin.write(`${JSON.stringify({
      path: job.path, out: job.out,
      out_mask: job.out_mask, out_bg: job.out_bg, depth_in: job.depth_in,
    })}\n`);
  } catch (err) {
    log('派活失败:', err.message);
    state.workerFails += 1;
    killWorker('stdin-broken');
    state.queue.unshift(job);
    state.queuedSet.add(job.path);
    state.busy = false;
    return;
  }
  clearTimeout(state.jobTimer);
  state.jobTimer = setTimeout(() => {
    log('任务超时，重置 worker:', path.basename(job.path));
    state.stats.failed += 1;
    killWorker('timeout');
    state.workerFails += 1;
    if (state.queue.length) setTimeout(pump, 1000);
  }, JOB_TIMEOUT_MS);
  if (state.jobTimer.unref) state.jobTimer.unref();
}

function enqueue(job) {
  if (state.queue.length >= QUEUE_MAX) { state.stats.dropped += 1; return; }
  if (state.queuedSet.has(job.path)) return;
  if (state.currentJob && state.currentJob.path === job.path) return;   // 正在生成中，别排两次
  state.queuedSet.add(job.path);
  state.queue.push(job);
  pump();
}

/* ---------------------------------------------------------------- 对外 */

/**
 * 空闲预取（第十一轮）：把「接下来要显示的图」的深度提前生成。
 * 纪律：队列非空或 worker 正忙时直接放弃（正事的优先级永远更高，
 * 下次 tick 会再试）；已缓存的直接跳过。不统计 hits/misses。
 */
function prefetch(entryPath) {
  if (!state.enabled || !entryPath || !state.cacheDir) return;
  if (state.queue.length > 0 || state.busy) return;
  const trio = trioFor(entryPath);
  if (!trio || fs.existsSync(trio.depth)) return;
  enqueue({ path: entryPath, out: trio.depth });
}

function lookup(entryPath) {
  if (!state.enabled || !entryPath || !state.cacheDir) return null;
  const trio = trioFor(entryPath);
  if (!trio) return null;
  if (fs.existsSync(trio.depth)) {
    state.stats.hits += 1;
    touchCacheFile(trio.depth);   // LRU 使用信号（第十九轮）
    // 第九轮：图层分割方向已放弃（第六/八轮两连败，贴纸感无法接受），
    // 停掉老缓存的 mask/bg 回填 —— 别让它空烧 GPU。
    // ⚠️ 返回契约=深度图路径字符串（渲染端第五轮版本按字符串用；
    // 第七轮曾误返 {depth,mask,bg} 对象导致 GL 深度路径整体失效、视差全没）
    return trio.depth;
  }
  state.stats.misses += 1;
  // 第十轮追补：分层路线已终止且渲染端（第五轮单平面/第十轮 POM flow）只吃
  // 深度图，mask/bg 无任何消费方 —— 新图只派深度（省 ISNet+LaMa 约 6s/张）。
  // worker 的 mask/bg 能力保留，将来若复活分层只改这里。
  enqueue({ path: entryPath, out: trio.depth });
  return null;
}

function configure(patch) {
  for (const k of ['python', 'workerScript', 'modelDir', 'cacheDir', 'cacheLimitBytes', 'onReady', 'appRoot']) {
    if (patch && patch[k] !== undefined && patch[k] !== null && patch[k] !== '') state[k] = patch[k];
  }
  // 覆盖项单独记档（空串=没覆盖），resolveRuntime 按覆盖→打包布局→legacy 探测
  state.overrides = {
    python: (patch && patch.python) || '',
    workerScript: (patch && patch.workerScript) || '',
    modelDir: (patch && patch.modelDir) || '',
  };
  resolveRuntime();
  if (state.cacheDir) {
    try { fs.mkdirSync(state.cacheDir, { recursive: true }); } catch (err) {
      state.enabled = false;
      state.disabledReason = `缓存目录建不了: ${err.message}`;
      log(state.disabledReason);
    }
    scheduleEvictSweep();   // 启动时也查一次存量（上次退出前超了的话在这收尾）
  }
  // 可用性检测（r25）：三样依赖缺哪样就在启动时置降级 + 精确原因，
  // 不用等 worker 连挂 3 次才静默失效；设置页把这段原因直接显示出来。
  // 先重新武装（configure 支持重入：改路径重配能救回来；运行中连挂降级
  // 仍由 workerFails 闸把守，不会被这里洗白 —— 那个闸看的是计数不是本开关）。
  if (!state.disabledReason.startsWith('缓存目录建不了')) {
    state.enabled = true;
    state.disabledReason = '';
    const missing = [];
    if (!fs.existsSync(state.python)) missing.push(`Python 解释器（${state.python}）`);
    if (!fs.existsSync(state.workerScript)) missing.push(`worker 脚本（${state.workerScript}）`);
    if (!fs.existsSync(path.join(state.modelDir, 'model.safetensors'))) missing.push(`深度模型（${state.modelDir}）`);
    if (missing.length) {
      state.enabled = false;
      state.disabledReason = `缺少 ${missing.join('、')}`;
      log('深度功能不可用 ——', state.disabledReason);
    } else {
      log('深度功能就绪: python=', state.python, ' model=', state.modelDir);
    }
  }
}

function stats() {
  return { ...state.stats, queue: state.queue.length, workerAlive: Boolean(state.worker),
    enabled: state.enabled, disabledReason: state.disabledReason,
    cacheLimitMB: Math.round(state.cacheLimitBytes / 1048576) };
}

/** 设置页的可用性面板（r25）：三样依赖的解析结果与存在性 + 运行态统计 */
function status() {
  return {
    ...stats(),
    python: state.python,
    workerScript: state.workerScript,
    modelDir: state.modelDir,
    pythonFound: Boolean(state.python) && fs.existsSync(state.python),
    workerFound: Boolean(state.workerScript) && fs.existsSync(state.workerScript),
    modelFound: Boolean(state.modelDir) && fs.existsSync(path.join(state.modelDir, 'model.safetensors')),
  };
}

module.exports = { lookup, prefetch, configure, stats, status };
