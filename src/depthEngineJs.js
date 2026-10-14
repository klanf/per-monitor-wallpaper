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
  sessionPath: '',             // 当前会话对应的模型路径（切换模型时判失效用）
  releaseTimer: null,
  depthDevice: 'gpu',
  failed: false,
  failReason: '',
  segSession: null,            // u2netp 人像分割会话（恒 CPU EP，不抢深度引擎的 GPU）
  segFailed: false,            // 模型缺失/加载失败 → 本 worker 生命周期内回落 Otsu 深度 mask
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

/**
 * letterbox 的「边缘复制填充」版：内容居中，四周空带不填灰板，而是把内容
 * 边缘 1px 拉伸过去 —— 模型看到的是内容的自然延续而非突兀灰板。
 * 实测（tools/depth-ab-test.js）：灰板会让 DA3 在内容边界预测出硬边竖带
 * （注意力把 band 上下文渗进内容边缘），视差时就是用户看到的「边缘撕裂」；
 * 复制填充后硬带消失。返回 518×518 RGB raw（NHWC 直喂）。
 */
async function letterboxReplicate(sharp, resizeSource, plan) {
  const { side, contentW, contentH, left, top, right, bottom } = plan;
  const contentRaw = await resizeSource
    .resize(contentW, contentH, { kernel: 'cubic', fit: 'fill' })
    .toColourspace('srgb').raw().toBuffer();
  if (left === 0 && right === 0 && top === 0 && bottom === 0) return contentRaw;

  const contentImg = () => sharp(contentRaw, { raw: { width: contentW, height: contentH, channels: 3 } });
  const stretch = async (buf, srcW, srcH, dstW, dstH) => sharp(buf, { raw: { width: srcW, height: srcH, channels: 3 } })
    .resize(dstW, dstH, { kernel: 'cubic', fit: 'fill' }).toColourspace('srgb').raw().toBuffer();

  // ① 中段行：[左带|内容|右带]（左右带 = 内容边缘列拉伸）
  const midParts = [];
  if (left > 0) {
    const col = await contentImg().extract({ left: 0, top: 0, width: 1, height: contentH }).raw().toBuffer();
    midParts.push({ input: await stretch(col, 1, contentH, left, contentH), raw: { width: left, height: contentH, channels: 3 }, left: 0, top: 0 });
  }
  midParts.push({ input: contentRaw, raw: { width: contentW, height: contentH, channels: 3 }, left, top: 0 });
  if (right > 0) {
    const col = await contentImg().extract({ left: contentW - 1, top: 0, width: 1, height: contentH }).raw().toBuffer();
    midParts.push({ input: await stretch(col, 1, contentH, right, contentH), raw: { width: right, height: contentH, channels: 3 }, left: left + contentW, top: 0 });
  }
  const midRaw = midParts.length
    ? await sharp({ create: { width: side, height: contentH, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .composite(midParts).removeAlpha().toColourspace('srgb').raw().toBuffer()
    : contentRaw;
  const midImg = () => sharp(midRaw, { raw: { width: side, height: contentH, channels: 3 } });

  // ② 整幅：[顶带|中段|底带]（上下带 = 中段边缘行拉伸）
  const canvasParts = [];
  if (top > 0) {
    const row = await midImg().extract({ left: 0, top: 0, width: side, height: 1 }).raw().toBuffer();
    canvasParts.push({ input: await stretch(row, side, 1, side, top), raw: { width: side, height: top, channels: 3 }, left: 0, top: 0 });
  }
  canvasParts.push({ input: midRaw, raw: { width: side, height: contentH, channels: 3 }, left: 0, top });
  if (bottom > 0) {
    const row = await midImg().extract({ left: 0, top: contentH - 1, width: side, height: 1 }).raw().toBuffer();
    canvasParts.push({ input: await stretch(row, side, 1, side, bottom), raw: { width: side, height: bottom, channels: 3 }, left: 0, top: top + contentH });
  }
  if (!canvasParts.length) return midRaw;
  return sharp({ create: { width: side, height: side, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(canvasParts).removeAlpha().toColourspace('srgb').raw().toBuffer();
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
    const last = Number(shape[shape.length - 1]);
    const w = Number(shape[shape.length - 3]);
    // NHWC uint8 变体（社区 fold-preprocess 导出，输入 [B,S,S,3] RGB 0..255）：
    // 归一化已折叠进图，引擎直接喂 sharp raw（RGB HWC uint8），不再自己做 MEAN/STD
    if (last === 3 && h === DA3_INPUT_SIDE && w === DA3_INPUT_SIDE) {
      return {
        family: 'da3-small',
        version: 'DA3-SMALL',
        inputName: 'image',
        outputName: 'depth',
        inputSize: DA3_INPUT_SIDE,
        fixedSquare: true,
        invertDepth: true,
        layout: 'nhwc-u8',
      };
    }
    if (h !== DA3_INPUT_SIDE || last !== DA3_INPUT_SIDE) {
      throw new Error(`DA3 ONNX 输入必须是 [B,3,${DA3_INPUT_SIDE},${DA3_INPUT_SIDE}]（或折叠预处理 [B,${DA3_INPUT_SIDE},${DA3_INPUT_SIDE},3]），实际 ${shape}`);
    }
    return {
      family: 'da3-small',
      version: 'DA3-SMALL',
      inputName: 'image',
      outputName: 'depth',
      inputSize: DA3_INPUT_SIDE,
      fixedSquare: true,
      invertDepth: true,
      layout: 'nchw-f32',
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

/**
 * 十字核膨胀 ×1 + 7-tap 可分离高斯羽化（σ≈1.7 texel）。
 * 替代旧 dilate2x（方形 3×3 ×2）：方形结构元在斜轮廓上产出轴对齐楼梯齿，
 * 半分辨率深度上采样到屏幕后 ≈ 每 2 texel 一格的方块锯齿（tools/pom-sim.py
 * 渲染复现实拍；DA3 锐边下尤其刺眼，V2 软边被斜坡掩盖故当年未暴露）。
 * 保留 1 texel 菱形外扩维持旧 dilate 的防白边意图，羽化把台阶圆化。
 */
function featherDilate(gray, w, h) {
  const dil = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    const rUp = y0 * w, rMid = y * w, rDn = y1 * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      dil[rMid + x] = Math.max(gray[rMid + x], gray[rUp + x], gray[rDn + x],
                               gray[rMid + x0], gray[rMid + x1]);
    }
  }
  const K = [1, 6, 15, 20, 15, 6, 1];
  const KS = 64;
  const tmp = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < 7; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k - 3));
        s += dil[row + xx] * K[k];
      }
      tmp[row + x] = s / KS;
    }
  }
  const out = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < 7; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k - 3)) * w;
        s += tmp[yy + x] * K[k];
      }
      out[row + x] = s / KS;
    }
  }
  return out;
}

/**
 * 可分离滑动窗口均值（边缘复制 clamp），O(1)/像素，Float64 累加防精度损失。
 * 返回 Float64Array（除以窗口数后），供引导滤波做二阶矩统计。
 */
function boxMean(src, w, h, r) {
  const tmp = new Float64Array(src.length);
  const out = new Float64Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  const cnt = (2 * r + 1) * (2 * r + 1);
  for (let i = 0; i < out.length; i++) out[i] /= cnt;
  return out;
}

/**
 * RGB 引导滤波（He et al. guided filter，外部引导图版）。
 * 与 2026-10-13 回退掉的 self-guided（引导图=深度自身）的本质差异：
 * 引导图换原图亮度 —— 原图边缘在哪，深度边缘就跟到哪；平坦区回归平面，
 * 过渡带沿真实轮廓重新分布而不是按深度自身梯度乱抹。DA3 锐边下
 * 「深度过渡带取中间值 → 视差外扩成暗晕」正是社区 Depthbake 定性的
 * 「alpha 问题被当深度问题」，引导滤波是其中最轻的后处理缓解路线。
 * eps 语义：引导值域 0~255，variance 单位同域；取 2400（≈49²）——
 * 压掉动漫图内部纹理边与背景画线（var<2400 不跟随，防止深度被纹理爬走
 * → 视差把旁边角色拉变形，2026-10-14 用户实测），真实物体轮廓照常保留。
 * strength=0.5 线性混合（q' = p + 0.5(q-p)）：引导滤波对"不该动的区域"
 * 的误拉偏也砍半，保边收益保留大半。r=4 texel（半分辨率深度，屏幕 8px）
 * 覆盖过渡带宽度。
 */
function rgbGuided(p, guide, w, h, r = 4, eps = 2400, strength = 0.5) {
  const n = w * h;
  const I = new Float64Array(n);
  for (let i = 0; i < n; i++) I[i] = guide[i];
  const meanI = boxMean(I, w, h, r);
  const meanP = boxMean(p, w, h, r);
  const II = new Float64Array(n);
  const IP = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    IP[i] = I[i] * p[i];
  }
  const mII = boxMean(II, w, h, r);
  const mIP = boxMean(IP, w, h, r);
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - meanI[i] * meanI[i];
    const covIP = mIP[i] - meanI[i] * meanP[i];
    a[i] = covIP / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const mA = boxMean(a, w, h, r);
  const mB = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const q = mA[i] * I[i] + mB[i];
    out[i] = p[i] + strength * (q - p[i]);  // 强度混合：误拉偏（背景纹理带偏深度）同样减半
  }
  return out;
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

/** Otsu 自动阈值（256 bin 直方图类间方差最大）：返回最优阈值；无可分峰返回 -1 */
function otsuThreshold(u8) {
  const hist = new Float64Array(256);
  for (let i = 0; i < u8.length; i++) hist[u8[i]] += 1;
  const total = u8.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

/**
 * 前景 mask（idle 微动画用，第六十二轮方案 A）：深度图 Otsu 阈值切前景 + 高斯羽化。
 * 纯 f(depth) 派生品 —— 与深度图同分辨率同缓存键；生成失败/阈值退化只影响该图的
 * idle 动画（渲染端 uHasMask=0 自动跳过），绝不影响深度本体（已先落盘）。
 * 深度值大 = 离镜头近（两个模型契约同向），前景取 > 阈值一侧。
 */
async function writeMask(sharp, depth8, w, h, outPath) {
  const thr = otsuThreshold(depth8);
  if (thr < 0) return;   // 深度近乎平坦：没有可分前景，跳过
  const bin = Buffer.allocUnsafe(w * h);
  let fg = 0;
  for (let i = 0; i < depth8.length; i++) {
    const on = depth8[i] > thr;
    bin[i] = on ? 255 : 0;
    if (on) fg += 1;
  }
  // 前景占比过小/过大 = 阈值切飞了（纯背景/全图特写没有「分层」可言）—— 宁可不做 idle
  const ratio = fg / (w * h);
  if (ratio < 0.02 || ratio > 0.95) return;
  // 双通道：R=2.5σ 紧羽化（呼吸/飘动/亮度脉动），G=10σ 宽羽化（差速视差权重）。
  // 差速 0.12×off 的位移差若压在紧羽化 2~4px 过渡带上会撕出锯齿（复现 1.26px/px 剪切），
  // 摊到宽羽化 ~60px 带上后与纯 POM 基线持平（0.55px/px）。
  const raw1 = { raw: { width: w, height: h, channels: 1 } };
  // 注意：sharp 的 blur 会把 1ch 输入升成 3ch（R=G=B），必须 toColourspace('b-w') 锁回单通道再 raw
  const [rBuf, gBuf] = await Promise.all([
    sharp(bin, raw1).clone().blur(2.5).toColourspace('b-w').raw().toBuffer(),
    sharp(bin, raw1).clone().blur(10).toColourspace('b-w').raw().toBuffer(),
  ]);
  const rgb = Buffer.allocUnsafe(w * h * 3);
  for (let i = 0; i < bin.length; i++) {
    rgb[i * 3] = rBuf[i];
    rgb[i * 3 + 1] = gBuf[i];
  }
  await writeAtomic(sharp(rgb, { raw: { width: w, height: h, channels: 3 } }), outPath);
}

// ---- u2netp 人像分割（第六十五轮）：mask 从「深度阈值近似」升级为「贴人物轮廓」 ----
// Otsu 深度阈值在特写图上会把头切掉、轮廓从身体中间穿过 → idle 位移在角色内部不连续
// （用户真机验收实锤）。u2netp 仅 4.5MB，恒跑 CPU EP（单张 ~220ms，只在该图首次生成时
// 执行一次就进缓存），不与 ComfyUI 等显卡负载抢算力。失败回落 Otsu 深度 mask。
function segModelPath() {
  return path.join(__dirname, '..', 'models', 'segmentation', 'u2netp.onnx');
}

async function ensureSegSession() {
  if (state.segSession) return state.segSession;
  if (state.segFailed) throw new Error('u2netp 此前加载失败（本 worker 不再重试）');
  const modelPath = segModelPath();
  if (!fs.existsSync(modelPath)) {
    state.segFailed = true;
    throw new Error(`缺少分割模型 ${modelPath}`);
  }
  try {
    state.segSession = await state.ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  } catch (err) {
    state.segFailed = true;
    throw new Error(`u2netp 会话创建失败：${err.message}`);
  }
  return state.segSession;
}

/** 跑 u2netp 出人像显著图，缩放到深度分辨率并做 min-max 拉伸，返回 u8 Buffer（亮=人物）。 */
async function segmentPerson(sharp, imgPath, dw, dh) {
  const session = await ensureSegSession();
  const SEG = 320;
  const img = await sharp(imgPath).removeAlpha()
    .resize(SEG, SEG, { kernel: 'cubic', fit: 'fill' })
    .toColourspace('srgb').raw().toBuffer();
  const n = SEG * SEG;
  const px = new Float32Array(3 * n);
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) px[c * n + i] = (img[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const inputName = session.inputNames[0];
  const outName = session.outputNames[0];
  const out = await session.run({ [inputName]: new state.ort.Tensor('float32', px, [1, 3, SEG, SEG]) });
  const tensor = out[outName];
  if (!tensor || !tensor.data) throw new Error('u2netp 无输出');
  const logits = tensor.data;
  let mn = Infinity;
  let mx = -Infinity;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = 1 / (1 + Math.exp(-logits[i]));
    sig[i] = s;
    if (s < mn) mn = s;
    if (s > mx) mx = s;
  }
  const stretched = Buffer.allocUnsafe(n);
  const span = mx - mn;
  for (let i = 0; i < n; i++) {
    stretched[i] = span > 1e-6 ? Math.round(((sig[i] - mn) / span) * 255) : 0;
  }
  return sharp(stretched, { raw: { width: SEG, height: SEG, channels: 1 } })
    .resize(dw, dh, { kernel: 'cubic', fit: 'fill' })
    .toColourspace('b-w').raw().toBuffer();
}

function toNchwFloat(raw, w, h) {  const n = w * h;
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
    // 边缘复制填充（不喂灰板）：灰板会污染 DA3 对内容边界的预测，
    // 产生硬边竖带 → 视差「边缘撕裂」（tools/depth-ab-test.js 实测）
    raw = await letterboxReplicate(sharp, resizeSource, plan);
    inputW = contract.inputSize;
    inputH = contract.inputSize;
  } else {
    const sized = smartResize(w0, h0);
    inputW = sized.nw;
    inputH = sized.nh;
    raw = await resizeSource.resize(inputW, inputH, { kernel: 'cubic', fit: 'fill' })
      .toColourspace('srgb').raw().toBuffer();
  }

  let feeds;
  if (contract.layout === 'nhwc-u8') {
    // 折叠预处理变体：归一化在图内，sharp raw 出来的就是 RGB HWC uint8，直接喂
    feeds = { [contract.inputName]: new state.ort.Tensor('uint8', raw, [1, inputH, inputW, 3]) };
  } else {
    const px = toNchwFloat(raw, inputW, inputH);
    feeds = { [contract.inputName]: new state.ort.Tensor('float32', px, [1, 3, inputH, inputW]) };
  }
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
  // RGB 引导滤波：引导图取原图亮度缩到深度分辨率（几何与裁剪回内容区后的
  // 深度图对齐 —— 两条契约都是深度图最终落回全图比例），从原图直缩一趟
  // 避开 resizeSource 已带 preshrink resize 再链 resize 的语义坑。
  const dil = featherDilate(gray, dw, dh);
  const gbuf = await sharp(job.path).removeAlpha()
    .resize(dw, dh, { kernel: 'cubic', fit: 'fill' })
    .toColourspace('b-w').raw().toBuffer();
  if (gbuf.length !== dw * dh) throw new Error(`引导图输出 ${gbuf.length} != ${dw * dh}`);
  const guide = new Float32Array(dw * dh);
  for (let i = 0; i < guide.length; i++) guide[i] = gbuf[i];
  const out8 = normalizeDepth(rgbGuided(dil, guide, dw, dh), false);
  await writeAtomic(sharp(out8, { raw: { width: dw, height: dh, channels: 1 } }), job.out);
  // mask 顺手派生（同一次会话里省一次解码）：失败不影响上面已落盘的深度
  if (job.outMask) {
    // 优先人像分割（贴轮廓）；u2netp 缺失/失败回落 Otsu 深度阈值（深度近似，切不准）
    try {
      const seg = await segmentPerson(sharp, job.path, dw, dh);
      await writeMask(sharp, seg, dw, dh, job.outMask);
    } catch (err) {
      log('人像分割不可用，回落 Otsu 深度 mask:', err.message);
      try { await writeMask(sharp, out8, dw, dh, job.outMask); } catch (err2) {
        log('mask 生成失败（该图 idle 降级关闭）:', path.basename(job.path), err2.message);
      }
    }
  }
  armReleaseTimer();
}

async function ensureSession() {
  if (state.session) {
    if (state.sessionPath === state.onnxModel) {
      clearTimeout(state.releaseTimer);
      return state.session;
    }
    // 模型被切换（设置页 V2/DA3 切换 → 下一个任务的 onnxModel 变了）：
    // 旧会话立刻释放，按新路径重建 —— 不判路径的话旧模型会一直活到闲置回收
    const stale = state.session;
    state.session = null;
    state.modelContract = null;
    clearTimeout(state.releaseTimer);
    stale.release().catch(() => {});
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
  state.sessionPath = state.onnxModel;
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
  __test: { smartResize, letterboxPlan, letterboxReplicate, detectModelContract, normalizeDepth, cropLetterboxDepth, dilate2x, featherDilate, boxMean, rgbGuided, otsuThreshold, writeMask },
};
