'use strict';

/**
 * 视频优化转码：遇到才转 + 副本缓存（2026-09-26，参考 zm-main 的「优化」思路改良）。
 *
 * 【动机 · 实测数据】
 *   壁纸库两个目录 1043 个视频 / 120.6 GB，抽样约半数是 60fps（1440x2560 等），
 *   解码开销 ∝ 宽×高×fps。2026-09-26 凌晨实测双屏视频壁纸 VideoDecode=45.6%
 *   （pid 396，nvidia-smi 挂了用 GPU Engine 计数器量的）。60→30fps 一刀：
 *   解码负载约减半（45.6% → 预期 20~25%）。
 *
 * 【为什么是「遇到才转」而不是全库预转】
 *   全库转一遍要 5~9 小时 GPU 时间且多数文件可能永远轮播不到；
 *   首播触发、转一次永久受益，没人看的文件零成本。
 *
 * 【为什么绝不原地替换（与 zm 的关键差异）】
 *   源库在 `D:\视频\Symcthing\...`，是 Syncthing 同步目录 —— 原地替换会触发
 *   上百 GB 重同步。原件一字不动，副本写到独立缓存目录（默认 D:/video-optimize-cache），
 *   对源库是**只读镜像关系**。副本文件名 = sha1(路径|大小|mtime)，源文件被
 *   Syncthing 改动（大小/mtime 变）指纹自动失效 → 旧副本成孤儿，被清理回收。
 *
 * 【删除联动】
 *   源删除（本地删或 Syncthing 同步删）→ 启动 10 分钟后的清理扫描发现
 *   源不存在 → 副本连索引条目一起删。孤儿文件 / .part 半成品同样兜底清理。
 *   容量上限（optimizeCacheMaxGB，默认 40GB）超出按 lastUsed LRU 逐出。
 *
 * 【转码参数】
 *   CPU 解码 → fps 滤镜降帧 → NVENC 硬编（静态 ffmpeg 带 h264_nvenc，
 *   探测失败自动回退 libx264）。码率 = min(源码率, 宽×高×fps×0.08)，
 *   下限 800kbps —— 保证副本只小不大（源 5Mbps 不会被拉到 8.8Mbps）。
 *   音频直接丢（-an，壁纸必须静音，stage 端本来就 muted）。
 *   只处理 fps≥31 且源码率≥1500kbps 的视频：≤30fps 的没有降帧空间；
 *   低码率小文件重编一次画质受损、绝对收益却只有零点几瓦。
 *   分辨率降档暂不做（抽样大头是 1440x2560 对 1600x2560 副屏，接近原生，
 *   降分辨率没收益；超采样的少数文件留待后续按屏幕分辨率裁）。
 *
 * 【时序】
 *   resolveForPlayback() 在 wpimg 协议层被调：命中缓存 → 直接服务副本；
 *   未命中且是候选 → 后台排队转码，**本次照常播原件**（首播体验零变化，
 *   下一个循环起自动切副本）。探测结果按 大小|mtime 记忆，同文件只探一次。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

/** 协议层能当视频流的扩展名（与 stageProtocol.MIME 的视频子集一致） */
const VIDEO_EXTS = new Set(['.mp4', '.webm']);

/** 转码失败后多久内不再重试 */
const RETRY_AFTER_MS = 24 * 3600 * 1000;

const state = {
  getConfig: null,        // () => 完整 config（每次调用现取，配置热改即时生效）
  index: null,            // Map hash -> { srcPath, srcSize, srcMtimeMs, createdAt, lastUsed, bytes, ... }
  probeCache: new Map(),  // `${size}|${mtimeMs}` -> 探测结果（进程内记忆）
  queue: [],              // 待转 srcPath（串行，同一时刻最多一个 ffmpeg）
  inFlight: null,
  failedUntil: new Map(), // hash -> 可重试时间戳
  encoder: undefined,     // 'nvenc' | 'libx264'（首次用时探测）
  ffmpegPath: undefined,  // 解析好的可执行文件路径
};

function cfg() {
  const c = (state.getConfig && state.getConfig()) || {};
  return {
    enabled: c.videoOptimize !== false,
    cacheDir: c.optimizeCacheDir || 'D:/video-optimize-cache',
    targetFps: Number(c.optimizeTargetFps) || 30,
    maxGB: Number(c.optimizeCacheMaxGB) || 40,
    ffmpegPath: c.ffmpegPath || '',
  };
}

/** ffmpeg 可执行文件：config 指定 → 项目约定位置 → PATH 兜底 */
function resolveFfmpeg() {
  if (state.ffmpegPath) return state.ffmpegPath;
  const candidates = [cfg().ffmpegPath, 'D:/workbuddy/tools/bin/ffmpeg.exe'].filter(Boolean);
  for (const p of candidates) {
    try { fs.accessSync(p); state.ffmpegPath = p; return p; } catch (_) { /* 下一个 */ }
  }
  state.ffmpegPath = 'ffmpeg';
  return state.ffmpegPath;
}

// ---------- 索引（cacheDir/index.json，副本的元数据账本） ----------

function indexFile() { return path.join(cfg().cacheDir, 'index.json'); }

function loadIndex() {
  if (state.index) return state.index;
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    state.index = new Map(Object.entries(raw.entries || {}));
  } catch {
    state.index = new Map();
  }
  return state.index;
}

function saveIndexNow() {
  if (!state.index) return;
  try {
    fs.mkdirSync(cfg().cacheDir, { recursive: true });
    fs.writeFileSync(indexFile(),
      JSON.stringify({ version: 1, entries: Object.fromEntries(state.index) }));
  } catch (err) {
    console.warn('[video-optimize] 写索引失败:', err.message);
  }
}

let saveTimer = null;
function saveIndexSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveIndexNow(); }, 2000);
}

// ---------- 探测（fps / 码率 / 分辨率） ----------

/**
 * 内容指纹：路径 | 大小 | mtime。Syncthing 改动文件（重写/更新）→ 指纹变，
 * 旧副本自动变孤儿；不计算内容 hash（120GB 库全量 hash 不可接受）。
 */
function fingerprint(srcPath, st) {
  return crypto.createHash('sha1')
    .update(`${srcPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex');
}

/** 跑一次 ffmpeg，收集 stdout/stderr/退出码；probe 用途允许非零退出（-i 无输出时） */
function runFfmpeg(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpeg(), ['-nostdin', ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ code, stdout, stderr, err: err || null });
    };
    const killer = setTimeout(() => { try { child.kill('killed'); } catch (_) {} finish(124, new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 512 * 1024) stderr += d; });
    child.on('error', (err) => finish(-1, err));
    child.on('close', (code) => finish(code));
  });
}

/** 探测视频规格（结果按 大小|mtime 进程内记忆；不落盘 —— 每次会话百来毫秒×一次可接受） */
async function probeVideo(srcPath, st) {
  const key = `${st.size}|${Math.round(st.mtimeMs)}`;
  if (state.probeCache.has(key)) return state.probeCache.get(key);

  const r = await runFfmpeg(['-hide_banner', '-i', srcPath]);
  const out = { fps: 0, kbps: 0, w: 0, h: 0, candidate: false, reason: '' };
  for (const line of r.stderr.split('\n')) {
    if (!/Video:/.test(line)) continue;
    const fpsM = /(\d+(?:\.\d+)?)\s*fps/.exec(line);
    const dimM = /(\d{2,5})x(\d{2,5})/.exec(line);
    const kbpsM = /(\d{3,6})\s*kb\/s/.exec(line);
    if (fpsM) out.fps = parseFloat(fpsM[1]);
    if (dimM) { out.w = +dimM[1]; out.h = +dimM[2]; }
    if (kbpsM) out.kbps = +kbpsM[1];
    break;  // 只看第一条视频流
  }
  if (!r.err && r.code !== 0 && !out.fps) {
    out.reason = 'ffmpeg 打不开';
  } else if (out.fps >= 31 && out.kbps >= 1500 && out.w > 0) {
    out.candidate = true;
  } else {
    out.reason = !out.fps ? 'fps 未知'
      : out.fps < 31 ? `fps=${out.fps} 已达标`
      : `码率过低(${out.kbps}kbps)`;
  }
  state.probeCache.set(key, out);
  return out;
}

// ---------- 转码 ----------

/** 输出码率：min(源码率, 宽×高×fps×0.08)（zm 公式），clamp [800k, 40M] —— 只小不大 */
function outBitrateKbps(p, targetFps) {
  const byFormula = Math.round((p.w * p.h * targetFps * 0.08) / 1000);
  return Math.max(800, Math.min(40000, Math.min(p.kbps || byFormula, byFormula)));
}

/**
 * 副本帧率是否与当前策略一致（56 轮：目标帧率做成用户可调后必须校验，
 * 否则 30 改 48 后旧 30fps 副本照样命中，按钮等于白按）。
 * 指纹 = 路径|大小|mtime 不含 targetFps，所以帧率记在索引条目里；
 * 老版本条目没这个字段 → 视为一致（不搞升级即全量重转）。
 */
function copyMatchesFps(entry, targetFps) {
  if (!entry || typeof entry !== 'object') return true;
  const t = Number(entry.targetFps);
  return !t || t === Number(targetFps);
}

function buildArgs(srcPath, outFile, p, targetFps, encoder) {
  const kbps = outBitrateKbps(p, targetFps);
  const vcodec = encoder === 'nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4',
       '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`]
    : ['-c:v', 'libx264', '-preset', 'veryfast',
       '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`];
  return ['-hide_banner', '-y', '-i', srcPath,
    '-vf', `fps=${targetFps}`, ...vcodec,
    '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', outFile];
}

/** NVENC 可用性探测（跑 0.1s 测试源；失败回退 libx264 并记住结论） */
async function detectEncoder() {
  if (state.encoder) return state.encoder;
  const r = await runFfmpeg([
    '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=0.1:size=320x240:rate=10',
    '-c:v', 'h264_nvenc', '-f', 'null', '-',
  ], 20000);
  state.encoder = r.code === 0 ? 'nvenc' : 'libx264';
  if (state.encoder === 'libx264') console.warn('[video-optimize] NVENC 不可用，回退 libx264（会慢很多）');
  return state.encoder;
}

/** 转单个文件：src → cacheDir/<hash>.mp4。返回 true=产出副本，false=非候选 */
async function transcodeOne(srcPath, st) {
  const c = cfg();
  const fp = fingerprint(srcPath, st);
  const finalPath = path.join(c.cacheDir, `${fp}.mp4`);
  const partPath = path.join(c.cacheDir, `${fp}.${process.pid}.part.mp4`);
  fs.mkdirSync(c.cacheDir, { recursive: true });

  const p = await probeVideo(srcPath, st);
  if (!p.candidate) return false;

  const encoder = await detectEncoder();
  let r = await runFfmpeg(buildArgs(srcPath, partPath, p, c.targetFps, encoder), 30 * 60 * 1000);
  if (r.code !== 0 && encoder === 'nvenc') {
    // 显卡驱动变化等导致 NVENC 中途失败 → 换软编重试一次
    state.encoder = 'libx264';
    r = await runFfmpeg(buildArgs(srcPath, partPath, p, c.targetFps, 'libx264'), 60 * 60 * 1000);
  }
  if (r.code !== 0) {
    try { fs.unlinkSync(partPath); } catch (_) { /* 可能还没建出来 */ }
    throw new Error(String(r.stderr || r.err || 'unknown').slice(-400));
  }

  const bytes = fs.statSync(partPath).size;
  fs.renameSync(partPath, finalPath);
  const index = loadIndex();
  index.set(fp, {
    srcPath, srcSize: st.size, srcMtimeMs: Math.round(st.mtimeMs),
    createdAt: Date.now(), lastUsed: Date.now(), bytes,
    fps: p.fps, srcKbps: p.kbps, outKbps: outBitrateKbps(p, c.targetFps), encoder,
    targetFps: c.targetFps,   // 56 轮：帧率策略入账，命中时校验（copyMatchesFps）
  });
  saveIndexNow();
  return true;
}

function enqueue(srcPath) {
  if (state.inFlight === srcPath || state.queue.includes(srcPath)) return;
  state.queue.push(srcPath);
  setImmediate(pump);
}

async function pump() {
  if (state.inFlight || !state.queue.length) return;
  const srcPath = state.queue.shift();
  state.inFlight = srcPath;
  const t0 = Date.now();
  try {
    const st = fs.statSync(srcPath);   // 排队期间可能已被删
    const fp = fingerprint(srcPath, st);
    if (Date.now() < (state.failedUntil.get(fp) || 0)) return;
    const ok = await transcodeOne(srcPath, st);
    console.log(`[video-optimize] ${ok ? '完成' : '跳过(非候选)'}: ${path.basename(srcPath)} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    try {
      const st = fs.statSync(srcPath);
      state.failedUntil.set(fingerprint(srcPath, st), Date.now() + RETRY_AFTER_MS);
    } catch (_) { /* 源没了就不用记了 */ }
    console.warn('[video-optimize] 转码失败:', path.basename(srcPath), String(err.message || err).slice(-300));
  } finally {
    state.inFlight = null;
    setImmediate(pump);
  }
}

// ---------- 对外入口 ----------

function configure(options = {}) {
  // 兼容 get / getConfig 两种键名 —— 曾经只认 getConfig，而调用方传 get，
  // 配置静默落空、转码全写进默认目录（早退返回值与正常返回同构，很难发现）
  state.getConfig = options.getConfig || options.get || null;
}

/**
 * 协议层取文件前调用。返回 { servePath } 表示改服务缓存副本；
 * 返回 null 表示照常服务原件（未启用 / 非视频 / 非候选 / 没缓存 / 失败冷却中）。
 * 未命中且是候选时会**顺手把转码排进后台队列** —— 这就是「遇到才转」的触发点。
 */
async function resolveForPlayback(srcPath) {
  const c = cfg();
  if (!c.enabled || !VIDEO_EXTS.has(path.extname(srcPath).toLowerCase())) return null;

  let st;
  try { st = fs.statSync(srcPath); } catch { return null; }
  const fp = fingerprint(srcPath, st);

  const cacheFile = path.join(c.cacheDir, `${fp}.mp4`);
  let cached = false;
  try { cached = fs.statSync(cacheFile).size > 0; } catch { cached = false; }
  if (cached) {
    const e = loadIndex().get(fp);
    if (!copyMatchesFps(e, c.targetFps)) {
      // 帧率策略变了：旧帧率副本不直供，往下走照常重转（part 转完 rename 覆盖旧副本）
      cached = false;
    } else {
      if (e) { e.lastUsed = Date.now(); saveIndexSoon(); }
      return { servePath: cacheFile, hit: true, hash: fp };
    }
  }

  if (Date.now() < (state.failedUntil.get(fp) || 0)) return null;

  let p;
  try { p = await probeVideo(srcPath, st); } catch { return null; }
  if (!p.candidate) return null;

  enqueue(srcPath);   // 后台转；本次先播原件
  return null;
}

/**
 * 缓存清理（启动后延迟调用，也可手动）：
 * ① 源已删除 → 删副本+条目；② 索引外孤儿（含 .part 半成品）→ 删；
 * ③ 总量超 optimizeCacheMaxGB → 按 lastUsed LRU 逐出。
 */
async function cleanup() {
  if (!state.getConfig) return { removedFiles: 0, freedBytes: 0 };
  const c = cfg();
  fs.mkdirSync(c.cacheDir, { recursive: true });
  const index = loadIndex();
  let removedFiles = 0;
  let freedBytes = 0;

  const tryUnlink = (fp) => {
    try {
      freedBytes += fs.statSync(path.join(c.cacheDir, `${fp}.mp4`)).size;
      removedFiles++;
    } catch (_) { /* 文件本来就不在 */ }
    try { fs.unlinkSync(path.join(c.cacheDir, `${fp}.mp4`)); } catch (_) { /* 同上 */ }
  };

  // ① 源已删除
  for (const [fp, e] of [...index]) {
    if (!fs.existsSync(e.srcPath)) { tryUnlink(fp); index.delete(fp); }
  }
  // ② 孤儿 / 半成品（index.json 本身跳过）
  for (const name of fs.readdirSync(c.cacheDir)) {
    if (name === 'index.json') continue;
    const fp = name.replace(/\.mp4$/, '');
    if (name.endsWith('.mp4') && index.has(fp)) continue;
    try {
      freedBytes += fs.statSync(path.join(c.cacheDir, name)).size;
      removedFiles++;
      fs.unlinkSync(path.join(c.cacheDir, name));
    } catch (_) { /* 被并发删了就算了 */ }
  }
  // ③ 容量上限 LRU
  let total = 0;
  for (const e of index.values()) total += e.bytes || 0;
  const limit = c.maxGB * 1024 ** 3;
  if (total > limit) {
    const oldestFirst = [...index.entries()]
      .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (const [fp, e] of oldestFirst) {
      if (total <= limit) break;
      tryUnlink(fp);
      total -= e.bytes || 0;
      index.delete(fp);
    }
  }
  saveIndexNow();
  console.log(`[video-optimize] 清理: 删 ${removedFiles} 个文件，释放 ${(freedBytes / 1024 ** 2).toFixed(1)} MB，现存 ${index.size} 条副本`);
  return { removedFiles, freedBytes };
}

module.exports = {
  VIDEO_EXTS,
  configure,
  resolveForPlayback,
  cleanup,
  copyMatchesFps,
};
