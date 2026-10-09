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

const state = {
  enabled: true,
  python: 'F:\\miniconda3\\python.exe',
  workerScript: path.join(__dirname, '..', 'tools', 'depth_worker.py'),
  modelDir: 'D:\\workbuddy\\tools\\MoyuFloat\\wallpaper\\model',
  cacheDir: null,
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
  disabledReason: '',
  stats: { hits: 0, misses: 0, generated: 0, failed: 0, dropped: 0 },
};

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

function spawnWorker() {
  if (state.workerFails >= SPAWN_FAIL_LIMIT) {
    if (state.enabled) {
      state.enabled = false;
      state.disabledReason = `worker 连续失败 ${state.workerFails} 次，深度功能已降级`;
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
  state.queuedSet.add(job.path);
  state.queue.push(job);
  pump();
}

/* ---------------------------------------------------------------- 对外 */

function lookup(entryPath) {
  if (!state.enabled || !entryPath || !state.cacheDir) return null;
  const trio = trioFor(entryPath);
  if (!trio) return null;
  if (fs.existsSync(trio.depth)) {
    state.stats.hits += 1;
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
  for (const k of ['python', 'workerScript', 'modelDir', 'cacheDir', 'onReady']) {
    if (patch && patch[k] !== undefined) state[k] = patch[k];
  }
  if (state.cacheDir) {
    try { fs.mkdirSync(state.cacheDir, { recursive: true }); } catch (err) {
      state.enabled = false;
      state.disabledReason = `缓存目录建不了: ${err.message}`;
      log(state.disabledReason);
    }
  }
}

function stats() {
  return { ...state.stats, queue: state.queue.length, workerAlive: Boolean(state.worker),
    enabled: state.enabled, disabledReason: state.disabledReason };
}

module.exports = { lookup, configure, stats };
