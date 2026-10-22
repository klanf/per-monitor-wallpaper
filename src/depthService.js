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
 *   - JS 引擎（r26 默认）跑在**worker 线程**（r33）：onnxruntime-node 的
 *     session.run/loadModel 是同步原生调用，留在主进程会把右键菜单/删除确认/
 *     调度器定时器全部卡住（实锤 4.5s），worker 里随便卡都波及不到主进程；
 *     任务超时直接 terminate 线程（推理硬取消），空闲 release 会话、线程热复用。
 *   - Python worker 是常驻子进程（模型只加载一次），单并发队列，单张失败不带走进程。
 *     空闲 10 分钟杀掉省显存（3070 Ti 还要跑 ComfyUI），下次 miss 自动重拉。
 *   - 全链路 fail-soft：Python 不存在 / 模型缺失 / worker 连挂 3 次 → 功能静默降级
 *     （lookup 永远返回 null，壁纸照常播 2D），绝不影响壁纸主业务。
 */

const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const debugLog = require('./debugLog');

const QUEUE_MAX = 64;             // 队列上限，满了丢弃（下次 miss 会再入队）
const IDLE_KILL_MS = 10 * 60 * 1000;
const JOB_TIMEOUT_MS = 90 * 1000; // 8K 图 + 冷启动也要不了这么久；超时按坏 worker 处理
const SPAWN_FAIL_LIMIT = 3;

/* ---- 探测超时与失败自愈（10-14 冷开机实锤）----
 * 冷开机时杀毒/磁盘风暴能把 require(ort/sharp) 拖过 20s → probe 判负 →
 * Python 回退也缺 → enabled=false 一票否决到会话结束，视差整场消失。
 * 改两刀：超时放大到 45s（真坏的情况 require 秒失败，不吃超时）；
 * 失败后若模型文件还在就退避重探（30s 起指数退避，封顶次数），成功即 pump 排空队列。
 */
const PROBE_TIMEOUT_MS = 45 * 1000;
const PROBE_RETRY_MAX = 5;              // 自愈重探次数上限，用尽后等下次 configure 重置
// 首次 30s，之后 ×2（30s/1min/2min/4min/8min）；WP_PROBE_RETRY_MS 测试钩子可缩到毫秒级
const PROBE_RETRY_BASE_MS = Number(process.env.WP_PROBE_RETRY_MS) || 30 * 1000;

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
  // 方案 B（r26）：JS 引擎的 ONNX 模型 legacy 候选（可行性验证产物）
  onnxModel: 'D:\\workbuddy\\projects\\electron-wallpaper\\depth-onnx-exp\\depth_anything_v2_small.onnx',
};

// 模型或后处理语义变化时必须升版；旧文件不删，由 2GB LRU 自然回收。
const DEPTH_CACHE_SCHEMA = 'depth-png-r11';  // r69：撤销 r67 mask 引导深度修复（2×2 对拍实锤把人物区深度σ再抹平 10%），r10 深度带修复全量失效重生成；r68 深度模型还原 V2_small

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
  onnxModel: '',               // JS 引擎的 ONNX 模型路径（r26）
  modelInfo: null,             // worker 首次建会话后由 ONNX metadata 回报
  engine: 'probing',           // 'js' | 'python' | 'probing'（探测完成前置 disabled 闸）
  jsFails: 0,                  // JS 引擎连败计数（≥3 且 Python 可用则切引擎，不回切）
  cacheDir: null,
  cacheLimitBytes: CACHE_LIMIT_BYTES,
  onReady: null,
  wantSeg: null,               // () => bool：是否有任何一路 profile 开着双层视差（缺省 null = 视为开，保持旧行为）
  wantMask: null,              // () => bool：是否有任何一路要前景 mask（双层视差 / 人物生动；缺省 null = 视为开）
  segBackend: 'auto',          // 分割后端（'auto'=isnetis 精准 / 'fast'=u2netp 快速），随任务下发引擎线程
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
  // JS 引擎 worker 线程（r33）：推理全部发生在这个线程里，主进程只收发消息
  wt: null,                    // Worker 实例；null = 没拉起（下次派活时再拉）
  wtSeq: 0,                    // 消息序号发号器
  wtJobSeq: 0,                 // 在途任务的 seq（回执对账；对不上 = 迟到的旧回执）
  wtWaiter: null,              // 在途任务的 resolve 钩子（job-result 到达时兑现）
  probeSeq: 0,                 // 在途探测的 seq
  probeWaiter: null,           // 在途探测的 resolve 钩子
  // 探测失败自愈（冷开机 probe-timeout 一票否决问题的修复）
  reprobeTries: 0,             // 已安排的自愈重探次数
  reprobeTimer: null,          // 待触发的重探定时器
  reprobeGaveUpLog: false,     // 放弃日志只打一次的闸
};

/**
 * 解析三样外部依赖的实际路径，写入 state；全部探测结果记进返回值
 * （status() 直接用）。覆盖项即使不存在也原样采用 —— 用户显式指定的路径
 * 找不到时要在 disabledReason 里如实说，而不是悄悄换一个。
 */
function resolveRuntime() {
  const appRoot = state.appRoot || path.join(__dirname, '..');
  const overrideModelDir = state.overrides && state.overrides.modelDir;
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
    onnxModel: [
      state.overrides && state.overrides.onnxModel,
      // 第六十八轮定版：DA3 弃用（2×2 隔离对拍实锤 —— 人物区深度σ比 V2 低 15~18%，
      // 「2D 纸片原地转」观感是模型特性不是后处理），候选链还原 master 只认 V2。
      (overrideModelDir && path.join(overrideModelDir, 'depth_anything_v2_small.onnx')) || '',
      path.join(appRoot, 'models', 'depth-anything', 'depth_anything_v2_small.onnx'),
      LEGACY_PATHS.onnxModel,
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
  state.onnxModel = out.onnxModel;
  return out;
}

function log(...args) {
  console.log('[depth]', ...args);
  debugLog.dlog('depth', ...args);   // VBS 启动丢 stdout，关键诊断要落文件
}

function modelFingerprint(engine = state.engine) {
  const target = engine === 'python'
    ? path.join(state.modelDir || '', 'model.safetensors')
    : state.onnxModel;
  let stat = null;
  try { stat = fs.statSync(target); } catch { /* 缺模型时仍给稳定诊断 token */ }
  return [
    DEPTH_CACHE_SCHEMA,
    engine === 'python' ? 'python' : 'js',
    path.resolve(target || '.'),
    stat ? stat.size : 0,
    stat ? stat.mtimeMs : 0,
  ].join('|');
}

function keyFor(entryPath, fingerprint = modelFingerprint()) {
  let st;
  try { st = fs.statSync(entryPath); } catch { return null; }
  return crypto.createHash('sha1')
    .update(`${fingerprint}|${entryPath}|${st.mtimeMs}|${st.size}`)
    .digest('hex');
}

/** 三件套路径：depth（单平面必需）+ mask/bg（图层分割，第六轮起） */
function trioFor(entryPath) {
  const key = keyFor(entryPath);
  if (!key) return null;
  const base = path.join(state.cacheDir, key);
  return { depth: `${base}.depth.png`, mask: `${base}.mask.png`, bg: `${base}.bg.jpg` };
}

/** 任务成功收尾（Python worker 的 DONE 与 JS 引擎的完成共用） */
function finishSuccess(job) {
  state.stats.generated += 1;
  if (fs.existsSync(job.out)) {
    log('生成完成:', path.basename(job.path), `[engine=${state.engine}]`);
    scheduleEvictSweep();   // 缓存总量又涨了，安排一次超限检查（内部节流）
    try { if (state.onReady) state.onReady(job.path); } catch (_) { /* 回调异常不传播 */ }
  } else {
    state.stats.failed += 1;
  }
}

/* ---- JS 引擎 worker 线程（r33）---- */

/** 拉起深度引擎线程（幂等）；消息分发与异常退出兜底都挂在这里 */
function spawnJsWorker() {
  if (state.wt) return state.wt;
  const w = new Worker(path.join(__dirname, 'depthEngineWorker.js'));
  w.on('message', (msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'probe-result') {
      // seq 对账：快速连发 configure 时旧探测会被新探测取代，旧回执直接丢弃
      if (msg.seq === state.probeSeq && state.probeWaiter) {
        if (msg.modelInfo) state.modelInfo = msg.modelInfo;
        const r = state.probeWaiter;
        state.probeWaiter = null;
        r(msg);
      }
    } else if (msg.type === 'job-result') {
      if (msg.seq === state.wtJobSeq && state.wtWaiter) {
        if (msg.modelInfo) state.modelInfo = msg.modelInfo;
        const r = state.wtWaiter;
        state.wtWaiter = null;
        r(msg);
      }
    }
  });
  w.on('error', (err) => onJsWorkerGone(`error: ${err.message}`));
  w.on('exit', (code) => {
    if (state.wt === w) onJsWorkerGone(`exit code=${code}`);
  });
  state.wt = w;
  return w;
}

/** 线程死了（异常/退出）：把所有在途 promise 落定成失败，busy/currentJob 交给调用方收拾 */
function onJsWorkerGone(why) {
  if (!state.wt) return;
  state.wt = null;
  log('深度引擎线程退出:', why);
  const probe = state.probeWaiter;
  state.probeWaiter = null;
  if (probe) probe({ seq: state.probeSeq, ok: false, reason: `深度引擎线程异常退出（${why}）` });
  const waiter = state.wtWaiter;
  state.wtWaiter = null;
  if (waiter) waiter({ seq: state.wtJobSeq, ok: false, error: `深度引擎线程异常退出（${why}）` });
}

/** 硬终止线程（推理不可协作取消，超时/退出时用）；在途 promise 全部落定为失败 */
function terminateJsWorker(why) {
  const w = state.wt;
  if (!w) return;
  state.wt = null;
  const probe = state.probeWaiter;
  state.probeWaiter = null;
  if (probe) probe({ seq: state.probeSeq, ok: false, reason: `深度引擎线程被终止（${why}）` });
  const waiter = state.wtWaiter;
  state.wtWaiter = null;
  if (waiter) waiter({ seq: state.wtJobSeq, ok: false, error: `深度引擎线程被终止（${why}）` });
  try { w.terminate(); } catch (_) { /* 已死 */ }
}

/** 探测 JS 引擎（在 worker 线程里 require ort/sharp + 查模型）；超时判负 */
function probeJs(onnxModel) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.probeWaiter = null;
      resolve(r);
    };
    const timer = setTimeout(() => {
      terminateJsWorker('probe-timeout');
      finish({ ok: false, reason: `JS 引擎线程探测超时（${PROBE_TIMEOUT_MS / 1000}s）` });
    }, PROBE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    try {
      // 已有在途探测（快速连发 configure）：先落定为「被取代」，让前一个
      // configure 的 .then 不去误切 Python 引擎 —— 引擎归属由最后一次 configure 决定
      if (state.probeWaiter) {
        const prev = state.probeWaiter;
        state.probeWaiter = null;
        prev({ seq: state.probeSeq, ok: false, superseded: true, reason: 'probe 被更新的探测取代' });
      }
      const w = spawnJsWorker();
      const seq = ++state.wtSeq;
      state.probeSeq = seq;
      state.probeWaiter = finish;
      w.postMessage({ type: 'probe', seq, onnxModel });
    } catch (err) {
      finish({ ok: false, reason: `深度引擎线程拉起失败: ${err.message}` });
    }
  });
}

/**
 * JS 引擎跑单（r33 起经 worker 线程）：主进程 postMessage 后只等结果，
 * sharp 预处理 / ORT 推理 / dilate 全部阻塞在 worker 自己的事件循环里。
 * 超时处理从「放弃等待」升级成「terminate 线程」—— 旧版超时后主进程其实
 * 还在替 ORT 背着同步推理跑，线程版是真正的硬取消。
 */
async function runJsJob(job) {
  clearTimeout(state.jobTimer);
  state.jobTimer = setTimeout(() => {
    log('JS 任务超时，终止引擎线程:', path.basename(job.path));
    terminateJsWorker('job-timeout');
    state.stats.failed += 1;
    state.jsFails += 1;
    state.busy = false;
    state.currentJob = null;
    maybeDegradeJsToPython();
    if (state.queue.length) pump();
  }, JOB_TIMEOUT_MS);
  if (state.jobTimer.unref) state.jobTimer.unref();
  try {
    const w = spawnJsWorker();
    const seq = ++state.wtSeq;
    state.wtJobSeq = seq;
    w.postMessage({ type: 'generate', seq, onnxModel: state.onnxModel, depthDevice: state.depthDevice, segBackend: state.segBackend, job });
    const res = await new Promise((resolve) => { state.wtWaiter = resolve; });
    if (state.currentJob !== job) return;   // 超时/换引擎后被放弃的迟到结果
    if (!res || !res.ok) throw new Error((res && res.error) || '深度引擎线程返回失败');
    if (res.modelInfo) state.modelInfo = res.modelInfo;
    state.jsFails = 0;
    clearTimeout(state.jobTimer);
    state.currentJob = null;
    state.busy = false;
    finishSuccess(job);
  } catch (err) {
    if (state.currentJob !== job) return;
    state.stats.failed += 1;
    state.jsFails += 1;
    log('JS 生成失败:', path.basename(job.path), err.message, `（连败 ${state.jsFails}）`);
    clearTimeout(state.jobTimer);
    state.currentJob = null;
    state.busy = false;
    maybeDegradeJsToPython();
  }
  pump();   // 下一单
}

/** JS 连败降级：Python 依赖齐全才切，否则维持 JS（降级闸照旧累计） */
function maybeDegradeJsToPython() {
  if (state.engine !== 'js' || state.jsFails < 3) return;
  if (fs.existsSync(state.python) && fs.existsSync(state.workerScript)) {
    state.engine = 'python';
    state.workerFails = 0;
    log(`JS 引擎连败 ${state.jsFails} 次，切换到 Python worker 引擎`);
  } else {
    log(`JS 引擎连败 ${state.jsFails} 次，但 Python 依赖缺失，继续用 JS（下次重试）`);
    state.jsFails = 0;   // 没有退路时别让计数无限涨
  }
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
    finishSuccess(job);
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

/** 是否还有消费方等着分割产物（背景板）。没探到 wantSeg 钩子时视为开（保持旧行为）。 */
function segWanted() {
  return typeof state.wantSeg !== 'function' ? true : Boolean(state.wantSeg());
}

/** 是否有消费方等着前景 mask（双层视差合成 / 人物生动）。没探到时视为开（保持旧行为）。 */
function maskWanted() {
  return typeof state.wantMask !== 'function' ? true : Boolean(state.wantMask());
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

/**
 * 全量扫缓存目录，超限就按 mtime 从旧到新删到 90%。
 * ⚠️ 必须异步 + 分批（第七十六轮）：旧版 readdirSync + 逐文件 statSync 全同步，
 * 冷开机（Defender 实扫 + 盘未热）下 8000+ 个 stat 每个几十 ms，一次扫掉
 * main 的 uv 事件循环 2~4 分钟 —— tick/probe 超时/手势轮询全部冻结，
 * stage 取图请求排不上 → 黑屏；堵完恢复瞬间积压定时器齐发还触发过 Electron
 * 内部 CHECK 崩溃（用户左滑闪退）。异步化后慢归慢，主线永不被咬死。
 */
const fsp = fs.promises;
const EVICT_BATCH = 256;          // 每批 stat 数，批间让出一拍事件循环
const evictYield = () => new Promise((r) => setImmediate(r));

async function evictSweep() {
  if (!state.cacheDir) return;
  let names;
  try { names = await fsp.readdir(state.cacheDir); } catch { return; }
  let total = 0;
  const items = [];
  for (let i = 0; i < names.length; i += 1) {
    try {
      const st = await fsp.stat(path.join(state.cacheDir, names[i]));
      if (!st.isFile()) continue;
      total += st.size;
      items.push({ name: names[i], size: st.size, mtime: st.mtimeMs });
    } catch (_) { /* 竞态消失：当没这文件 */ }
    if ((i + 1) % EVICT_BATCH === 0) await evictYield();
  }
  if (total <= state.cacheLimitBytes) return;
  const target = state.cacheLimitBytes * EVICT_TARGET;
  items.sort((a, b) => a.mtime - b.mtime);   // 最久未用在前
  let freed = 0, removed = 0;
  for (const it of items) {
    if (total - freed <= target) break;
    try {
      await fsp.unlink(path.join(state.cacheDir, it.name));
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
  if (state.engine === 'js') {
    // 闲时释放（与 Python 的 idle kill 对齐）：给线程发 release 关掉 ONNX 会话省
    // 显存，线程本身留着热复用（ort/sharp 已加载，下个任务不用重付启动成本）。
    // 线程已死就顺手清掉引用；jobTimer 无活可超时，一并清。
    if (state.wt) {
      try { state.wt.postMessage({ type: 'release' }); } catch (_) { terminateJsWorker('idle-post-failed'); }
    }
    state.busy = false;
    state.currentJob = null;
    clearTimeout(state.jobTimer);
    return;
  }
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
  if (!state.enabled || state.engine === 'probing') return;   // 探测中先攒队列
  if (state.workerFails >= SPAWN_FAIL_LIMIT) { state.queue = []; state.queuedSet.clear(); return; }
  // LIFO 取队尾：短时间快速切图时，入队顺序是 旧→新，正在看的那张永远最后
  // 生成（前面几十张 4K 积压能拖几分钟）。取队尾 = 最新看的图插队先生成，
  // 旧任务等切换停下来再慢慢补（缓存键去重，重复出现不会重复生成）。
  const job = state.queue.pop();
  state.queuedSet.delete(job.path);
  // 探测结束后才知道最终引擎；此刻再落缓存路径，避免 Python 回退结果写进
  // DA3 命名空间，也避免升级后继续命中 V2 的旧深度图。
  const trio = trioFor(job.path);
  if (!trio) { pump(); return; }
  if (fs.existsSync(trio.depth)) {
    // 双层视差（2026-10-16）/ 人物生动（r84）：老缓存缺 sidecar 时补一次派生 ——
    // JS 引擎恒 CPU（u2netp ~220ms + 人像区扩散填充亚秒），深度本体经 depth_in
    // 直接收编不再重推理。只补真正的消费方要的那几件（mask / bg 各算各的），
    // 没人要的产物不烧 CPU。Python 协议不认识 out_bg，无害。
    const needMask = maskWanted() && !fs.existsSync(trio.mask);
    const needBg = segWanted() && !fs.existsSync(trio.bg);
    if (state.engine === 'js' && (needMask || needBg)) {
      job.out = trio.depth;
      job.depthIn = trio.depth;
      if (needMask) job.outMask = trio.mask;
      if (needBg) job.outBg = trio.bg;
    } else { pump(); return; }
  } else {
    job.out = trio.depth;
    // 新图也按消费方派生 sidecar（r85 追记）：这里原来无条件带 mask+bg，
    // 双层视差关掉后每张新图仍在跑 isnetis + 人像区填充（真机实锤：13:52
    // 重启后白烧 163 张 bg）。mask = 双层视差/人物生动要，bg = 只有双层视差要。
    if (maskWanted()) job.outMask = trio.mask;
    if (segWanted()) job.outBg = trio.bg;
  }
  state.currentJob = job;
  state.busy = true;
  // ── JS 引擎（r26）：进程内异步推理，不走子进程协议 ──
  if (state.engine === 'js') {
    runJsJob(job);
    return;
  }
  if (!state.worker) spawnWorker();
  if (!state.worker || !state.worker.stdin.writable) return;   // exit 回调稍后重拉
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
 * 空闲预取（第十一轮；2026-10-17 重写纪律）：把「接下来要显示的图」提前派生。
 * 旧版「队列非空/worker 忙就放弃」实锤饿死：开机后台积压期间每次 tick 预取
 * 全部白跑，追不上切换节奏（用户实测：有的切过去已渲染好、有的切过去才开始渲）。
 * 新纪律：忙也照常入队 —— 队列 LIFO（队尾先出），后到的按需 miss 天然插队
 * 在预取前面，优先级不受损；消费者要的 sidecar 都齐了才跳过，缺 mask/bg 的老
 * 缓存借预取补派生（pump 里的补派生分支会走 depth_in 收编，不重推理深度）。
 * 不统计 hits/misses。
 */
function prefetch(entryPath) {
  if (!state.enabled || !entryPath || !state.cacheDir) return;
  // 第七十七轮：探测期也先查缓存 —— 深度已在盘上的图不用入队占位，
  // 把队首留给真正缺缓存的新图（lookup 侧同步改为探测期可命中）。
  // r84：mask 与 bg 分开判 —— 只开人物生动时缺的是 mask，不能按 bg 一刀跳过。
  const complete = (trio) => {
    if (!trio || !fs.existsSync(trio.depth)) return false;
    if (maskWanted() && !fs.existsSync(trio.mask)) return false;
    if (segWanted() && !fs.existsSync(trio.bg)) return false;
    return true;
  };
  if (complete(trioFor(entryPath))) return;
  if (state.engine === 'probing') { enqueue({ path: entryPath }); return; }
  const trio = trioFor(entryPath);
  if (!trio) return;
  if (complete(trio)) return;
  enqueue({ path: entryPath });
}

function lookup(entryPath) {
  if (!state.enabled || !entryPath || !state.cacheDir) return null;
  // 第七十七轮：缓存命中判定提前到引擎状态之前 —— 读磁盘缓存不需要引擎，
  // 探测期（probing，冷开机可拖 45s）也能命中，视差不必干等探测结束。
  // 旧版探测期一律 return null，缓存明明在盘上却要等模型就绪才显示。
  const trio = trioFor(entryPath);
  if (trio && fs.existsSync(trio.depth)) {
    state.stats.hits += 1;
    touchCacheFile(trio.depth);   // LRU 使用信号（第十九轮）
    // 第九轮：图层分割方向已放弃（第六/八轮两连败，贴纸感无法接受），
    // 停掉老缓存的 mask/bg 回填 —— 别让它空烧 GPU。
    // ⚠️ 返回契约=深度图路径字符串（渲染端第五轮版本按字符串用；
    // 第七轮曾误返 {depth,mask,bg} 对象导致 GL 深度路径整体失效、视差全没）
    return trio.depth;
  }
  state.stats.misses += 1;
  if (state.engine === 'probing') {
    enqueue({ path: entryPath });
    return null;
  }
  if (!trio) return null;
  // 第十轮追补：分层路线已终止且渲染端（第五轮单平面/第十轮 POM flow）只吃
  // 深度图，mask/bg 无任何消费方 —— 新图只派深度（省 ISNet+LaMa 约 6s/张）。
  // worker 的 mask/bg 能力保留，将来若复活分层只改这里。
  enqueue({ path: entryPath });
  return null;
}

function configure(patch) {
  const previousOnnx = state.onnxModel;
  for (const k of ['python', 'workerScript', 'modelDir', 'onnxModel', 'cacheDir', 'cacheLimitBytes', 'onReady', 'wantSeg', 'wantMask', 'segBackend', 'appRoot', 'depthDevice']) {
    if (patch && patch[k] !== undefined && patch[k] !== null && patch[k] !== '') state[k] = patch[k];
  }
  // 设备偏好落 state（r33 起随每个任务下发到引擎线程；引擎线程存活时这里
  // 同步推一条 configure —— 让「切换设备」立刻释放旧会话，下张按新设备重建）
  if (state.wt && state.engine === 'js') {
    try { state.wt.postMessage({ type: 'configure', depthDevice: state.depthDevice, segBackend: state.segBackend }); } catch (_) { /* 死线程下次派活会重拉 */ }
  }
  // 覆盖项单独记档（空串=显式清除覆盖），resolveRuntime 按覆盖→打包布局→legacy 探测。
  // configure 也被设置页用于单独切换 depthDevice；这种部分更新不能顺手丢掉
  // 用户配置的旧 V2 模型路径，否则下一次设备切换会悄悄改回内置 DA3。
  const previousOverrides = state.overrides || {};
  state.overrides = {};
  for (const key of ['python', 'workerScript', 'modelDir', 'onnxModel']) {
    state.overrides[key] = patch && Object.prototype.hasOwnProperty.call(patch, key)
      ? (patch[key] || '')
      : (previousOverrides[key] || '');
  }
  resolveRuntime();
  if (!previousOnnx || path.resolve(previousOnnx) !== path.resolve(state.onnxModel)) {
    state.modelInfo = null;
  }
  if (state.cacheDir) {
    try { fs.mkdirSync(state.cacheDir, { recursive: true }); } catch (err) {
      state.enabled = false;
      state.disabledReason = `缓存目录建不了: ${err.message}`;
      log(state.disabledReason);
    }
    scheduleEvictSweep();   // 启动时也查一次存量（上次退出前超了的话在这收尾）
  }
  if (state.disabledReason.startsWith('缓存目录建不了')) return;

  // ── 引擎选择（r26）：JS（onnxruntime-node，零 Python 依赖）优先 ──
  // r33 起探测也在引擎线程里做（require ort/sharp 有 IO，更不该占主进程）；
  // 探测是异步的，期间 engine='probing'，pump 攒队列不派活。
  // JS 不可用 → 回落 Python worker 三件套检查（r25 逻辑原样）。
  state.engine = 'probing';
  state.enabled = true;
  state.disabledReason = '';
  // 用户主动 configure = 全新一轮探测预算：清掉在途重探定时器、清零计数
  if (state.reprobeTimer) { clearTimeout(state.reprobeTimer); state.reprobeTimer = null; }
  state.reprobeTries = 0;
  state.reprobeGaveUpLog = false;
  probeJs(state.onnxModel).then((r) => {
    if (r && r.superseded) return;   // 已被更新的 configure 接管，别在这里改引擎归属
    if (r.ok) {
      state.engine = 'js';
      state.enabled = true;
      state.disabledReason = '';
      if (r.modelInfo) state.modelInfo = r.modelInfo;
      log('深度功能就绪 [engine=js·worker] onnx=', state.onnxModel,
        `model=${state.modelInfo && state.modelInfo.version || '待首张图识别'}`);
    } else {
      applyPythonAvailability(r.reason);
      armProbeRetry(r.reason);   // 探测失败自愈：模型还在盘上就退避重探
    }
    pump();   // 探测期间攒下的队列现在派活
  });
}

/** Python 引擎可用性检查（r25 逻辑原样：三件套缺一置降级 + 精确原因） */
function applyPythonAvailability(jsReason) {
  state.engine = 'python';
  state.modelInfo = { family: 'python-hf', version: 'Python-HF', inputSize: null, detected: true };
  state.enabled = true;
  state.disabledReason = '';
  const missing = [];
  if (!fs.existsSync(state.python)) missing.push(`Python 解释器（${state.python}）`);
  if (!fs.existsSync(state.workerScript)) missing.push(`worker 脚本（${state.workerScript}）`);
  if (!fs.existsSync(path.join(state.modelDir, 'model.safetensors'))) missing.push(`深度模型（${state.modelDir}）`);
  if (missing.length) {
    state.enabled = false;
    state.disabledReason = `JS 引擎不可用（${jsReason}），且缺少 ${missing.join('、')}`;
    log('深度功能不可用 ——', state.disabledReason);
  } else {
    log('深度功能就绪 [engine=python]: python=', state.python, ' model=', state.modelDir,
      '（JS 引擎回落原因:', jsReason, '）');
  }
}

/**
 * 探测失败自愈（10-14 冷开机实锤：杀毒把 require(ort/sharp) 拖过超时 → probe 判负
 * → Python 回退也缺 → enabled=false 一票否决到会话结束，视差整场消失）。
 * 只要 ONNX 模型文件还在盘上，就按退避间隔重探；成功即恢复 js 引擎，
 * pump 把 disabled 期间攒下的 miss 任务排空，视差自动追上。
 * 退避 30s 起每次 ×2、封顶 PROBE_RETRY_MAX 次；用尽后停手（下次 configure 重置预算）。
 */
function armProbeRetry(jsReason) {
  if (state.reprobeTimer) return;   // 已有重探在路上
  if (!state.onnxModel || !fs.existsSync(state.onnxModel)) return;   // 模型真缺，重探无意义
  if (state.reprobeTries >= PROBE_RETRY_MAX) {
    if (!state.reprobeGaveUpLog) {
      state.reprobeGaveUpLog = true;
      log(`深度引擎重探连续失败 ${PROBE_RETRY_MAX} 次，放弃自动重试（改设置或重启应用可再触发）`);
    }
    return;
  }
  state.reprobeTries += 1;
  const delay = PROBE_RETRY_BASE_MS * Math.pow(2, state.reprobeTries - 1);
  log(`深度引擎不可用（${jsReason}），${Math.round(delay / 1000)}s 后自动重探（第 ${state.reprobeTries}/${PROBE_RETRY_MAX} 次）`);
  state.reprobeTimer = setTimeout(() => {
    state.reprobeTimer = null;
    if (state.engine === 'js') return;   // 其他路径已恢复，不必再探
    state.engine = 'probing';
    probeJs(state.onnxModel).then((r) => {
      if (r && r.superseded) return;   // 期间来了新 configure，归属归它管
      if (r.ok) {
        state.engine = 'js';
        state.enabled = true;
        state.disabledReason = '';
        state.reprobeTries = 0;
        state.reprobeGaveUpLog = false;
        if (r.modelInfo) state.modelInfo = r.modelInfo;
        log('深度引擎重探成功，视差自愈恢复 [engine=js·worker] onnx=', state.onnxModel);
      } else {
        applyPythonAvailability(r.reason);
        armProbeRetry(r.reason);
      }
      pump();   // disabled 期间攒下的队列现在派活
    });
  }, delay);
  if (state.reprobeTimer.unref) state.reprobeTimer.unref();
}

/**
 * 分割后端热切换（设置页「分割模型」）：轻量转发，不触发 configure 全链路重探。
 * 线程活着就立刻推送；没活着（下次派活才拉起）就只落 state，随 generate 消息带下去。
 */
function forwardSegBackend(v) {
  state.segBackend = v === 'fast' ? 'fast' : 'auto';
  if (state.wt && state.engine === 'js') {
    try { state.wt.postMessage({ type: 'configure', segBackend: state.segBackend }); } catch (_) { /* 死线程随下次派活带上 */ }
  }
}

function stats() {
  return { ...state.stats, queue: state.queue.length, workerAlive: Boolean(state.worker),
    enabled: state.enabled, disabledReason: state.disabledReason,
    cacheLimitMB: Math.round(state.cacheLimitBytes / 1048576) };
}

/** 设置页的可用性面板（r25；r26 加引擎/ONNX 模型字段；r33 device 改读本进程偏好） */
function status() {
  return {
    ...stats(),
    engine: state.engine,
    device: state.engine === 'js' ? (state.depthDevice === 'cpu' ? 'cpu' : 'gpu') : undefined,
    python: state.python,
    workerScript: state.workerScript,
    modelDir: state.modelDir,
    onnxModel: state.onnxModel,
    modelFamily: state.modelInfo && state.modelInfo.family,
    modelVersion: state.modelInfo && state.modelInfo.version,
    modelInputSize: state.modelInfo && state.modelInfo.inputSize,
    modelDetected: Boolean(state.modelInfo && state.modelInfo.detected),
    cacheSchema: DEPTH_CACHE_SCHEMA,
    pythonFound: Boolean(state.python) && fs.existsSync(state.python),
    workerFound: Boolean(state.workerScript) && fs.existsSync(state.workerScript),
    modelFound: Boolean(state.modelDir) && fs.existsSync(path.join(state.modelDir, 'model.safetensors')),
    onnxFound: Boolean(state.onnxModel) && fs.existsSync(state.onnxModel),
  };
}

/**
 * 退出时收掉深度引擎（r33 重写）。
 *
 * r26~r32：JS 引擎把 onnxruntime-node + sharp 加载进**主进程**，退出时 ORT/libvips
 * 的原生线程池收不干净（Windows 已知坑，microsoft/onnxruntime#24579），Chromium
 * 终场挂死 threads=1 → `app.relaunch` 永不触发，靠 main.js 的 taskkill 引信硬保底。
 *
 * r33 起原生模块只存在于引擎线程里：terminate 直接杀线程，原生资源随线程消失，
 * 不经过 Chromium 的卸载路径 —— 退出挂死的根因整体消失。taskkill 引信保留当保险。
 */
function shutdown() {
  if (state.reprobeTimer) { clearTimeout(state.reprobeTimer); state.reprobeTimer = null; }
  terminateJsWorker('quit');
  log('深度引擎已释放（quit shutdown）');
}

module.exports = {
  lookup, prefetch, configure, stats, status, shutdown, forwardSegBackend,
  __test: { keyFor, modelFingerprint, cacheSchema: DEPTH_CACHE_SCHEMA },
};
