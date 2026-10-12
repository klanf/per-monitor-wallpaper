'use strict';

/**
 * depthEngineJs —— 深度生成引擎的 JS 实现。
 *
 * 默认模型是 DA3-SMALL 的单图深度 ONNX；仍兼容原来的 Depth Anything V2 Small
 * 自定义模型。两种模型共用 worker 线程、DirectML/CPU 会话和 PNG 后处理：
 *   - DA3：固定 518×518 letterbox，原始输出是“距离”（近小远大），写盘前反转；
 *   - V2：沿用 HF SmartResize 动态宽高，原始输出已经是“近大远小”。
 *
 * mask（ISNet）/ bg（LaMa）不在这里复刻：当前渲染链只消费深度图。
 */

const fs = require('node:fs');
const path = require('node:path');
const debugLog = require('./debugLog');

const DA3_INPUT_SIDE = 518;
const V2_MAX_SIDE = 518;
const MULTIPLE = 14;
const PRESHRINK_SIDE = 2048;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const LETTERBOX_RGB = { r: 124, g: 116, b: 104 };
const IDLE_RELEASE_MS = 10 * 60 * 1000;

const state = {
  ort: null,
  sharp: null,
  session: null,
  modelContract: null,
  onnxModel: '',
  releaseTimer: null,
  depthDevice: 'gpu',
  failed: false,
  failReason: '',
};

function log(...args) {
  debugLog.dlog('depth-js', ...args);
}

function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function smartResize(w, h) {
  const sh = V2_MAX_SIDE / h;
  const sw = V2_MAX_SIDE / w;
  let scaleH = sh;
  let scaleW = sw;
  if (Math.abs(1 - sw) < Math.abs(1 - sh)) scaleH = sw; else scaleW = sh;
  const constrain = (val) => Math.max(MULTIPLE, pyRound(val / MULTIPLE) * MULTIPLE);
  return { nh: constrain(scaleH * h), nw: constrain(scaleW * w) };
}

function letterboxPlan(w, h, side = DA3_INPUT_SIDE) {
  const scale = Math.min(side / w, side / h);
  const contentW = Math.max(1, Math.min(side, Math.round(w * scale)));
  const contentH = Math.max(1, Math.min(side, Math.round(h * scale)));
  const left = Math.floor((side - contentW) / 2);
  const top = Math.floor((side - contentH) / 2);
  return {
    side,
    contentW,
    contentH,
    left,
    top,
    right: side - contentW - left,
    bottom: side - contentH - top,
  };
}

function metadataFor(items, name) {
  if (Array.isArray(items)) return items.find((item) => item && item.name === name) || null;
  return items && items[name] ? items[name] : null;
}

function detectModelContract(session) {
  const inputs = Array.from(session.inputNames || []);
  const outputs = Array.from(session.outputNames || []);
  if (inputs.includes('image') && outputs.includes('depth')) {
    const meta = metadataFor(session.inputMetadata, 'image');
    const shape = (meta && (meta.shape || meta.dimensions)) || [];
    const h = Number(shape[shape.length - 2]);
    const w = Number(shape[shape.length - 1]);
    if (h !== DA3_INPUT_SIDE || w !== DA3_INPUT_SIDE) {
      throw new Error(`DA3 ONNX 输入必须是 [B,3,${DA3_INPUT_SIDE},${DA3_INPUT_SIDE}]，实际 ${shape}`);
    }
    return {
      family: 'da3-small',
      version: 'DA3-SMALL',
      inputName: 'image',
      outputName: 'depth',
      inputSize: DA3_INPUT_SIDE,
      fixedSquare: true,
      invertDepth: true,
    };
  }
  if (inputs.includes('pixel_values') && outputs.includes('predicted_depth')) {
    return {
      family: 'depth-anything-v2-small',
      version: 'Depth-Anything-V2-Small',
      inputName: 'pixel_values',
      outputName: 'predicted_depth',
      inputSize: V2_MAX_SIDE,
      fixedSquare: false,
      invertDepth: false,
    };
  }
  throw new Error(`不支持的深度 ONNX 契约：inputs=${inputs.join(',')} outputs=${outputs.join(',')}`);
}

function pendingModelInfo(modelPath = state.onnxModel) {
  const name = path.basename(modelPath || '').toLowerCase();
  if (name.includes('da3')) {
    return { family: 'da3-small', version: 'DA3-SMALL', inputSize: DA3_INPUT_SIDE, detected: false };
  }
  if (name.includes('v2') || name.includes('depth_anything')) {
    return { family: 'depth-anything-v2-small', version: 'Depth-Anything-V2-Small', inputSize: V2_MAX_SIDE, detected: false };
  }
  return { family: 'unknown', version: name || 'unknown', inputSize: null, detected: false };
}

function modelInfo() {
  return state.modelContract
    ? { family: state.modelContract.family, version: state.modelContract.version, inputSize: state.modelContract.inputSize, detected: true }
    : pendingModelInfo();
}

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

function normalizeDepth(depth, invertDepth) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    const v = Number(depth[i]);
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) throw new Error('深度输出没有有限数值');
  const span = (mx - mn) || 1;
  const out = Buffer.alloc(depth.length);
  for (let i = 0; i < depth.length; i++) {
    const v = Number.isFinite(depth[i]) ? depth[i] : mn;
    const unit = invertDepth ? (mx - v) / span : (v - mn) / span;
    out[i] = Math.round(Math.max(0, Math.min(1, unit)) * 255);
  }
  return out;
}

function cropLetterboxDepth(depth, dims, plan) {
  const oh = Number(dims[dims.length - 2]);
  const ow = Number(dims[dims.length - 1]);
  if (!Number.isInteger(oh) || !Number.isInteger(ow) || oh < 1 || ow < 1) {
    throw new Error(`DA3 ONNX 输出形状异常：${dims}`);
  }
  const x0 = Math.max(0, Math.min(ow - 1, Math.round(plan.left * ow / plan.side)));
  const y0 = Math.max(0, Math.min(oh - 1, Math.round(plan.top * oh / plan.side)));
  const x1 = Math.max(x0 + 1, Math.min(ow, Math.round((plan.left + plan.contentW) * ow / plan.side)));
  const y1 = Math.max(y0 + 1, Math.min(oh, Math.round((plan.top + plan.contentH) * oh / plan.side)));
  const cw = x1 - x0;
  const ch = y1 - y0;
  const cropped = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const row = (y0 + y) * ow + x0;
    cropped.set(depth.subarray(row, row + cw), y * cw);
  }
  return { depth: cropped, width: cw, height: ch };
}

async function writeAtomic(sharpInst, out) {
  const tmp = `${out}.tmp`;
  await sharpInst.png().toFile(tmp);
  fs.renameSync(tmp, out);
}

function toNchwFloat(raw, w, h) {
  const n = w * h;
  if (raw.length !== n * 3) throw new Error(`RGB 输入长度 ${raw.length} != ${n * 3}`);
  const px = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) px[c * n + i] = (raw[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return px;
}

async function generate(job) {
  if (state.failed) throw new Error(state.failReason || 'JS 引擎不可用');
  const { sharp } = state;
  if (!sharp) throw new Error('sharp 未加载');

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
  let resizeSource = sharp(job.path).removeAlpha();
  if (Math.max(w0, h0) > PRESHRINK_SIDE) {
    const s = PRESHRINK_SIDE / Math.max(w0, h0);
    w0 = Math.max(1, Math.round(w0 * s));
    h0 = Math.max(1, Math.round(h0 * s));
    resizeSource = resizeSource.resize(w0, h0, { kernel: 'lanczos3', fit: 'fill' });
  }

  const session = await ensureSession();
  const contract = state.modelContract;
  let inputW;
  let inputH;
  let plan = null;
  let raw;
  if (contract.fixedSquare) {
    plan = letterboxPlan(w0, h0, contract.inputSize);
    raw = await resizeSource
      .resize(plan.contentW, plan.contentH, { kernel: 'cubic', fit: 'fill' })
      .extend({ top: plan.top, bottom: plan.bottom, left: plan.left, right: plan.right, background: LETTERBOX_RGB })
      .toColourspace('srgb').raw().toBuffer();
    inputW = contract.inputSize;
    inputH = contract.inputSize;
  } else {
    const sized = smartResize(w0, h0);
    inputW = sized.nw;
    inputH = sized.nh;
    raw = await resizeSource.resize(inputW, inputH, { kernel: 'cubic', fit: 'fill' })
      .toColourspace('srgb').raw().toBuffer();
  }

  const px = toNchwFloat(raw, inputW, inputH);
  const feeds = { [contract.inputName]: new state.ort.Tensor('float32', px, [1, 3, inputH, inputW]) };
  const outputs = await session.run(feeds);
  const tensor = outputs[contract.outputName];
  if (!tensor || !tensor.data || !tensor.dims) throw new Error(`ONNX 缺少输出 ${contract.outputName}`);

  let sourceDepth;
  let sourceW;
  let sourceH;
  if (contract.fixedSquare) {
    const cropped = cropLetterboxDepth(tensor.data, tensor.dims, plan);
    sourceDepth = cropped.depth;
    sourceW = cropped.width;
    sourceH = cropped.height;
  } else {
    const dims = tensor.dims;
    sourceH = Number(dims[dims.length - 2]);
    sourceW = Number(dims[dims.length - 1]);
    if (sourceH !== inputH || sourceW !== inputW) {
      throw new Error(`V2 ONNX 输出 dims ${dims} != [1,${inputH},${inputW}]`);
    }
    sourceDepth = tensor.data;
  }

  const norm = normalizeDepth(sourceDepth, contract.invertDepth);
  const dw = Math.max(1, Math.floor(w0 / 2));
  const dh = Math.max(1, Math.floor(h0 / 2));
  const resized = await sharp(norm, { raw: { width: sourceW, height: sourceH, channels: 1 } })
    .resize(dw, dh, { kernel: 'cubic', fit: 'fill' })
    .toColourspace('b-w').raw().toBuffer();
  if (resized.length !== dw * dh) throw new Error(`resize 输出 ${resized.length} != ${dw * dh}（通道数异常）`);

  const gray = new Float32Array(dw * dh);
  for (let i = 0; i < gray.length; i++) gray[i] = resized[i];
  const out8 = normalizeDepth(dilate2x(gray, dw, dh), false);
  await writeAtomic(sharp(out8, { raw: { width: dw, height: dh, channels: 1 } }), job.out);
  armReleaseTimer();
}

async function ensureSession() {
  if (state.session) {
    clearTimeout(state.releaseTimer);
    return state.session;
  }
  const ort = state.ort;
  const t0 = Date.now();
  const wantGpu = state.depthDevice !== 'cpu';
  const mkSession = (providers) => ort.InferenceSession.create(state.onnxModel, { executionProviders: providers });
  try {
    state.session = await mkSession(wantGpu ? ['dml', 'cpu'] : ['cpu']);
  } catch (err) {
    if (!wantGpu) throw err;
    log(`GPU(DML) 会话创建失败，回落 CPU EP：${err.message}`);
    state.session = await mkSession(['cpu']);
  }
  try {
    state.modelContract = detectModelContract(state.session);
  } catch (err) {
    const bad = state.session;
    state.session = null;
    bad.release().catch(() => {});
    throw err;
  }
  const epDesc = wantGpu ? 'GPU(DML)+CPU兜底' : 'CPU EP';
  log(`ONNX 会话就绪 ${path.basename(state.onnxModel)} [${state.modelContract.version}]（${((Date.now() - t0) / 1000).toFixed(1)}s，${epDesc}）`);
  return state.session;
}

function configure(patch) {
  if (!patch || typeof patch.depthDevice !== 'string') return;
  const next = patch.depthDevice === 'cpu' ? 'cpu' : 'gpu';
  if (next === state.depthDevice) return;
  state.depthDevice = next;
  if (state.session) {
    const old = state.session;
    state.session = null;
    old.release().catch(() => {});
    log(`深度设备切换为 ${next}，旧会话已释放`);
  }
}

function armReleaseTimer() {
  clearTimeout(state.releaseTimer);
  state.releaseTimer = setTimeout(() => {
    if (state.session) {
      state.session.release().catch(() => {});
      state.session = null;
      log('闲置释放 ONNX 会话（省内存，下次 miss 重拉）');
    }
  }, IDLE_RELEASE_MS);
  if (state.releaseTimer.unref) state.releaseTimer.unref();
}

async function probe(onnxModel) {
  if (process.env.WP_NO_JS_DEPTH) {
    state.failed = true;
    state.failReason = 'WP_NO_JS_DEPTH 测试钩子：JS 引擎禁用';
    return { ok: false, reason: state.failReason };
  }
  if (!onnxModel || !fs.existsSync(onnxModel)) {
    state.failed = true;
    state.failReason = `ONNX 模型不存在（${onnxModel || '未配置'}）`;
    return { ok: false, reason: state.failReason };
  }
  if (state.onnxModel && path.resolve(state.onnxModel) !== path.resolve(onnxModel)) {
    close();
    state.modelContract = null;
  }
  state.failed = false;
  state.failReason = '';
  try {
    state.ort = require('onnxruntime-node');
    state.sharp = require('sharp');
  } catch (err) {
    state.failed = true;
    state.failReason = `JS 推理依赖缺失: ${err.message.split('\n')[0]}`;
    return { ok: false, reason: state.failReason };
  }
  state.onnxModel = onnxModel;
  return { ok: true, model: onnxModel, modelInfo: modelInfo() };
}

function close() {
  clearTimeout(state.releaseTimer);
  if (state.session) {
    state.session.release().catch(() => {});
    state.session = null;
  }
}

module.exports = {
  probe,
  generate,
  close,
  configure,
  device: () => state.depthDevice,
  isReady: () => Boolean(state.onnxModel) && !state.failed,
  modelInfo,
  __test: { smartResize, letterboxPlan, detectModelContract, normalizeDepth, cropLetterboxDepth },
};
