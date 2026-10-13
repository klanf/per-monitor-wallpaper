// 一次性工具：跑 DA3(replicate letterbox) 推理，落两份半分辨率深度图：
//   <base>.da3-rep.png      —— 现行管线（normalize → 半分辨率 cubic → dilate2x → normalize）
//   <base>.da3-nodil.png    —— 同链但跳过 dilate2x（POM 锯齿对照实验用）
// 用法：node tools/dump-depth-nodilate.js <imgPath>
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const engineTest = require('../src/depthEngineJs').__test;

const ROOT = path.join(__dirname, '..');
const DA3 = path.join(ROOT, 'models', 'depth-anything', 'da3_small.onnx');
const SIDE = 518, PRESHRINK_SIDE = 2048;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

function normalizeDepth(depth, invert) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < depth.length; i++) { const v = depth[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = (mx - mn) || 1;
  const out = Buffer.alloc(depth.length);
  for (let i = 0; i < depth.length; i++) {
    const u = invert ? (mx - depth[i]) / span : (depth[i] - mn) / span;
    out[i] = Math.round(Math.max(0, Math.min(1, u)) * 255);
  }
  return out;
}

(async () => {
  const imgPath = process.argv[2];
  if (!imgPath) { console.error('usage: node dump-depth-nodilate.js <img>'); process.exit(1); }
  const meta = await sharp(imgPath).metadata();
  let w0 = meta.width, h0 = meta.height;
  let src = sharp(imgPath).removeAlpha();
  if (Math.max(w0, h0) > PRESHRINK_SIDE) {
    const s = PRESHRINK_SIDE / Math.max(w0, h0);
    w0 = Math.max(1, Math.round(w0 * s)); h0 = Math.max(1, Math.round(h0 * s));
    src = src.resize(w0, h0, { kernel: 'lanczos3', fit: 'fill' });
  }
  const plan = engineTest.letterboxPlan(w0, h0);
  const raw = await engineTest.letterboxReplicate(sharp, src, plan);
  const session = await ort.InferenceSession.create(DA3, { executionProviders: ['dml', 'cpu'] });
  const out = await session.run({ image: new ort.Tensor('uint8', raw, [1, SIDE, SIDE, 3]) });
  const data = Float32Array.from(out.depth.data);
  const dims = out.depth.dims;
  const sw = dims[dims.length - 1], sh = dims[dims.length - 2];
  const norm = normalizeDepth(data, true);   // da3 输出近=大，管线里 invert=true 拉回「近=白」

  const dw = Math.max(1, Math.floor(w0 / 2)), dh = Math.max(1, Math.floor(h0 / 2));
  const mid = await sharp(norm, { raw: { width: sw, height: sh, channels: 1 } })
    .resize(dw, dh, { kernel: 'cubic', fit: 'fill' }).toColourspace('b-w').raw().toBuffer();

  const outDir = path.join(__dirname, 'out', 'depth-ab');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(imgPath).replace(/\.[^.]+$/, '');
  await sharp(mid, { raw: { width: dw, height: dh, channels: 1 } })
    .png().toFile(path.join(outDir, `${base}.da3-nodil.png`));
  console.log(`saved ${base}.da3-nodil.png  (${dw}x${dh}, pre-dilate)`);
})().catch(e => { console.error(e); process.exit(1); });
