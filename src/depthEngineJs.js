'use strict';

/**
 * depthEngineJs —— 深度生成引擎的 JS 实现（方案 B，2026-10-10 可行性验证后工程化）。
 *
 * 替代 Python worker（tools/depth_worker.py）的**深度环节**：
 *   sharp 预处理（SmartResize 对齐 HF DPTImageProcessor）→ onnxruntime-node 推理
 *   → 半尺寸 + 边缘外扩（dilate 2×）→ 8bit PNG 原子写。
 *
 * 与 Python 版的边界（有意不复刻的部分）：
 *   - mask（ISNet）/ bg（LaMa）不做 —— depthService 第十轮起只派深度任务，
 *     图层分割路线已终止，Python worker 里那段代码保留给将来复活分层用。
 *   - 只吃 CPU EP：实测 DirectML（GPU）对本模型反而慢 4~5 倍（调度开销 > 算力收益）。
 *
 * 复刻自 depth-onnx-exp/depth_infer.cjs（与生产 Python 管线对拍 corr=0.9995/0.9991）。
 * 三个 sharp 深坑已在代码里钉死，别"优化"掉：
 *   ① resize 必须 fit:'fill'（默认 cover 会裁边，对齐 PIL 语义）；
 *   ② 1 通道 raw resize 后必须 toColourspace('b-w') 再 .raw()（否则输出 3 通道，
 *      灰度被 RGB 交错污染成"变焦"伪影）；
 *   ③ 不能 Buffer.from(Float32Array)（拷的是底层字节，长度×4 全错位）。
 */

const fs = require('node:fs');
const path = require('node:path');
const debugLog = require('./debugLog');

const MAX_SIDE = 518;          // HF 预处理器 shortest_edge（模型训练分辨率短边）
const MULTIPLE = 14;           // ViT patch=14，输入必须是 14 的倍数
const PRESHRINK_SIDE = 2048;   // 与 Python worker 一致：先压到 2048 再进模型
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const IDLE_RELEASE_MS = 10 * 60 * 1000;   // 与 Python worker 的空闲回收对齐

const state = {
  ort: null,
  sharp: null,
  session: null,
  onnxModel: '',
  releaseTimer: null,
  failed: false,               // require 失败后不再反复试（降级交由 depthService 决策）
  failReason: '',
};

function log(...args) {
  debugLog.dlog('depth-js', ...args);
}

/* Python round() = 银行家舍入（Math.round 的 .5 恒进位，两者在 .5 处不同） */
function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/* HF DPTImageProcessor SmartResize：取 |1-scale| 更小的轴定 scale，再取整到 14 的倍数 */
function smartResize(w, h) {
  const sh = MAX_SIDE / h;
  const sw = MAX_SIDE / w;
  let scaleH = sh;
  let scaleW = sw;
  if (Math.abs(1 - sw) < Math.abs(1 - sh)) scaleH = sw; else scaleW = sh;
  const constrain = (val) => Math.max(0, pyRound(val / MULTIPLE) * MULTIPLE);
  return { nh: constrain(scaleH * h), nw: constrain(scaleW * w) };
}

/* 3x3 最大值滤波 ×2（等价 worker 的 cv2.dilate 3x3 iterations=2） */
function dilate2x(gray, w, h) {
  let src = gray;
  let dst = new Float32Array(gray.length);
  for (let it = 0; it < 2; it++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(w - 1, x + 1);
        let m = 0;
        for (let yy = y0; yy <= y1; yy++) {
          const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) {
            if (src[row + xx] > m) m = src[row + xx];
          }
        }
        dst[y * w + x] = m;
      }
    }
    const t = src;
    src = dst;
    dst = t;
  }
  return src;
}

/* 临时名 + rename 原子落盘（主进程 stat 到的一定是完整文件，与 Python worker 一致） */
async function writeAtomic(sharpInst, out) {
  const tmp = `${out}.tmp`;
  await sharpInst.png().toFile(tmp);
  fs.renameSync(tmp, out);
}

/**
 * 生成一张深度图。job: { path, out, depthIn? } —— 契约与 Python worker 的任务行一致。
 * depthIn 存在时跳过推理直接复用（旧缓存回填场景；当前调度路径不派这种活，留作兼容）。
 * 失败抛异常（调用方计 fail / 可切引擎），成功静默返回。
 */
async function generate(job) {
  if (state.failed) throw new Error(state.failReason || 'JS 引擎不可用');
  const { sharp } = state;
  if (!sharp) throw new Error('sharp 未加载');

  // ── 深度已就绪（旧缓存回填）：直接拷贝，不碰模型 ──
  if (job.depthIn && fs.existsSync(job.depthIn)) {
    const tmp = `${job.out}.tmp`;
    fs.copyFileSync(job.depthIn, tmp);
    fs.renameSync(tmp, job.out);
    return;
  }

  const meta = await sharp(job.path).metadata();
  if (!meta.width || !meta.height) throw new Error('读不到图片尺寸');
  let w0 = meta.width;
  let h0 = meta.height;

  // ── 预缩（对齐 worker：LANCZOS 压到长边 2048）──
  let resizeSource = sharp(job.path).removeAlpha();
  if (Math.max(w0, h0) > PRESHRINK_SIDE) {
    const s = PRESHRINK_SIDE / Math.max(w0, h0);
    const tw = Math.max(1, Math.round(w0 * s));
    const th = Math.max(1, Math.round(h0 * s));
    w0 = tw;
    h0 = th;
    resizeSource = resizeSource.resize(tw, th, { kernel: 'lanczos3', fit: 'fill' });
  }

  // ── SmartResize 到 14 的倍数 + ImageNet 归一化 ──
  const { nh, nw } = smartResize(w0, h0);
  const raw = await resizeSource.resize(nw, nh, { kernel: 'cubic', fit: 'fill' })
    .toColourspace('srgb').raw().toBuffer();
  const N = nw * nh;
  const px = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) {
      px[c * N + i] = (raw[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    }
  }

  // ── 推理（CPU EP；会话懒加载常驻）──
  const session = await ensureSession();
  const out = await session.run({ pixel_values: new state.ort.Tensor('float32', px, [1, 3, nh, nw]) });
  const depth = out.predicted_depth.data;   // [1,nh,nw]
  const dims = out.predicted_depth.dims;
  if (dims[1] !== nh || dims[2] !== nw) {
    throw new Error(`ONNX 输出 dims ${dims} != [1,${nh},${nw}] —— 模型文件与导出图不符`);
  }

  // ── 后处理：minmax → 8bit → 半尺寸 resize → dilate 2× → 再 minmax → PNG ──
  const dw = Math.max(1, Math.floor(w0 / 2));
  const dh = Math.max(1, Math.floor(h0 / 2));
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    if (depth[i] < mn) mn = depth[i];
    if (depth[i] > mx) mx = depth[i];
  }
  const span0 = (mx - mn) || 1;
  const norm = Buffer.alloc(N);
  for (let i = 0; i < N; i++) norm[i] = Math.round((depth[i] - mn) / span0 * 255);

  // ⚠️ 深坑②：1 通道 raw resize 必须 toColourspace('b-w') 钉死单通道输出
  const resized = await sharp(norm, { raw: { width: nw, height: nh, channels: 1 } })
    .resize(dw, dh, { kernel: 'cubic', fit: 'fill' })
    .toColourspace('b-w').raw().toBuffer();
  if (resized.length !== dw * dh) {
    throw new Error(`resize 输出 ${resized.length} != ${dw * dh}（通道数异常）`);
  }
  const g = new Float32Array(dw * dh);
  for (let i = 0; i < g.length; i++) g[i] = resized[i];
  const dil = dilate2x(g, dw, dh);
  mn = Infinity;
  mx = -Infinity;
  for (let i = 0; i < dil.length; i++) {
    if (dil[i] < mn) mn = dil[i];
    if (dil[i] > mx) mx = dil[i];
  }
  const span = (mx - mn) || 1;
  const out8 = Buffer.alloc(dw * dh);
  for (let i = 0; i < dil.length; i++) out8[i] = Math.round((dil[i] - mn) / span * 255);

  await writeAtomic(sharp(out8, { raw: { width: dw, height: dh, channels: 1 } }), job.out);
  armReleaseTimer();
}

/* ---- 会话生命周期 ---- */

async function ensureSession() {
  if (state.session) {
    clearTimeout(state.releaseTimer);
    return state.session;
  }
  const ort = state.ort;
  const t0 = Date.now();
  state.session = await ort.InferenceSession.create(state.onnxModel, {
    executionProviders: ['cpu'],
  });
  log(`ONNX 会话就绪 ${path.basename(state.onnxModel)}（${((Date.now() - t0) / 1000).toFixed(1)}s，CPU EP）`);
  return state.session;
}

function armReleaseTimer() {
  clearTimeout(state.releaseTimer);
  state.releaseTimer = setTimeout(() => {
    if (state.session) {
      state.session.release().catch(() => { /* 已释放 */ });
      state.session = null;
      log('闲置释放 ONNX 会话（省内存，下次 miss 重拉）');
    }
  }, IDLE_RELEASE_MS);
  if (state.releaseTimer.unref) state.releaseTimer.unref();
}

/**
 * 探测 JS 引擎可用性：onnxruntime-node / sharp 可 require 且 ONNX 模型存在。
 * 成功 = 引擎就绪（会话懒加载，首张图才付加载成本）；失败返回原因，不抛异常。
 */
async function probe(onnxModel) {
  // 测试钩子：设 WP_NO_JS_DEPTH=1 时 JS 引擎探测直接判负（回落 Python），
  // 用于 A/B 验证「原生模块常驻主进程是否拖死退出链」（2026-10-10 重启挂死排查）
  if (process.env.WP_NO_JS_DEPTH) {
    state.failed = true;
    state.failReason = 'WP_NO_JS_DEPTH 测试钩子：JS 引擎禁用';
    return { ok: false, reason: state.failReason };
  }
  if (state.failed) return { ok: false, reason: state.failReason };
  if (!onnxModel || !fs.existsSync(onnxModel)) {
    state.failed = true;
    state.failReason = `ONNX 模型不存在（${onnxModel || '未配置'}）`;
    return { ok: false, reason: state.failReason };
  }
  try {
    state.ort = require('onnxruntime-node');
    state.sharp = require('sharp');
  } catch (err) {
    state.failed = true;
    state.failReason = `JS 推理依赖缺失: ${err.message.split('\n')[0]}`;
    return { ok: false, reason: state.failReason };
  }
  state.onnxModel = onnxModel;
  return { ok: true, model: onnxModel };
}

function close() {
  clearTimeout(state.releaseTimer);
  if (state.session) {
    state.session.release().catch(() => { /* 已释放 */ });
    state.session = null;
  }
}

module.exports = { probe, generate, close, isReady: () => Boolean(state.onnxModel) && !state.failed };
