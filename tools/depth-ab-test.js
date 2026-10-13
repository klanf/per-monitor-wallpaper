// -*- coding: utf-8 -*-
// 深度 A/B 实测：同一张图分别跑 V2 / DA3-letterbox（现行）/ DA3-中心裁方，
// 后处理链路完全一致（crop→归一化→半分辨率 cubic→dilate2x→归一化），
// 量化「边缘撕裂」的物质基础：Sobel 梯度统计 + 锐边密度。
// 用法：node tools/depth-ab-test.js <img1> [img2 ...]（缺省取 Anima-Random 前 3 张）
// 产物：tools/out/depth-ab/<名>.<variant>.png + 汇总表（stdout）
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const engineTest = require('../src/depthEngineJs').__test;

const ROOT = path.join(__dirname, '..');
const MODELS = {
  v2: path.join(ROOT, 'models', 'depth-anything', 'depth_anything_v2_small.onnx'),
  da3: path.join(ROOT, 'models', 'depth-anything', 'da3_small.onnx'),
};
const SIDE = 518, MULTIPLE = 14, PRESHRINK_SIDE = 2048;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const LETTERBOX = { r: 124, g: 116, b: 104 };

// —— 以下函数与 depthEngineJs.js 逐行同源 ——
function pyRound(x) { const f = Math.floor(x), d = x - f; if (d > 0.5) return f + 1; if (d < 0.5) return f; return f % 2 === 0 ? f : f + 1; }
function smartResize(w, h) {
  const sh = SIDE / h, sw = SIDE / w; let scaleH = sh, scaleW = sw;
  if (Math.abs(1 - sw) < Math.abs(1 - sh)) scaleH = sw; else scaleW = sh;
  const c = (v) => Math.max(MULTIPLE, pyRound(v / MULTIPLE) * MULTIPLE);
  return { nh: c(scaleH * h), nw: c(scaleW * w) };
}
function letterboxPlan(w, h, side = SIDE) {
  const scale = Math.min(side / w, side / h);
  const cw = Math.max(1, Math.min(side, Math.round(w * scale)));
  const ch = Math.max(1, Math.min(side, Math.round(h * scale)));
  const left = Math.floor((side - cw) / 2), top = Math.floor((side - ch) / 2);
  return { side, contentW: cw, contentH: ch, left, top, right: side - cw - left, bottom: side - ch - top };
}
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
function cropLetterboxDepth(depth, dims, plan) {
  const oh = dims[dims.length - 2], ow = dims[dims.length - 1];
  const x0 = Math.round(plan.left * ow / plan.side), y0 = Math.round(plan.top * oh / plan.side);
  const x1 = Math.max(x0 + 1, Math.min(ow, Math.round((plan.left + plan.contentW) * ow / plan.side)));
  const y1 = Math.max(y0 + 1, Math.min(oh, Math.round((plan.top + plan.contentH) * oh / plan.side)));
  const cw = x1 - x0, ch = y1 - y0, cropped = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) cropped.set(depth.subarray((y0 + y) * ow + x0, (y0 + y) * ow + x0 + cw), y * cw);
  return { depth: cropped, width: cw, height: ch };
}
function dilate2x(gray, w, h) {
  let src = gray, dst = new Float32Array(gray.length);
  for (let it = 0; it < 2; it++) {
    for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        let m = 0;
        for (let yy = y0; yy <= y1; yy++) { const row = yy * w;
          for (let xx = x0; xx <= x1; xx++) if (src[row + xx] > m) m = src[row + xx]; }
        dst[y * w + x] = m; } }
    const t = src; src = dst; dst = t;
  }
  return src;
}

async function runVariant(session, variant, imgPath) {
  const meta = await sharp(imgPath).metadata();
  let w0 = meta.width, h0 = meta.height;
  let src = sharp(imgPath).removeAlpha();
  if (Math.max(w0, h0) > PRESHRINK_SIDE) {
    const s = PRESHRINK_SIDE / Math.max(w0, h0);
    w0 = Math.max(1, Math.round(w0 * s)); h0 = Math.max(1, Math.round(h0 * s));
    src = src.resize(w0, h0, { kernel: 'lanczos3', fit: 'fill' });
  }
  let feeds, plan = null, inputW, inputH, raw;
  const toNchw = (rgb, W, H) => {
    const n = W * H, px = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) px[c * n + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    return px;
  };
  if (variant === 'v2') {
    const s = smartResize(w0, h0);
    inputW = s.nw; inputH = s.nh;
    raw = await src.resize(inputW, inputH, { kernel: 'cubic', fit: 'fill' }).toColourspace('srgb').raw().toBuffer();
    feeds = { pixel_values: new ort.Tensor('float32', toNchw(raw, inputW, inputH), [1, 3, inputH, inputW]) };
  } else if (variant === 'da3' || variant === 'da3-rep') {
    plan = letterboxPlan(w0, h0);
    if (variant === 'da3') {
      // 旧实现：灰板 letterbox（撕裂来源，留作对照）
      raw = await src.resize(plan.contentW, plan.contentH, { kernel: 'cubic', fit: 'fill' })
        .extend({ top: plan.top, bottom: plan.bottom, left: plan.left, right: plan.right, background: LETTERBOX })
        .toColourspace('srgb').raw().toBuffer();
    } else {
      // 新实现：边缘复制填充 —— 直接用引擎同源实现（__test 导出）
      raw = await engineTest.letterboxReplicate(sharp, src, plan);
    }
    feeds = { image: new ort.Tensor('uint8', raw, [1, SIDE, SIDE, 3]) };
  } else { // da3-crop：中心裁方（不喂灰边带，看撕裂是否来自 letterbox 污染）
    const side = Math.min(w0, h0);
    const left0 = Math.floor((w0 - side) / 2), top0 = Math.floor((h0 - side) / 2);
    raw = await src.extract({ left: left0, top: top0, width: side, height: side })
      .resize(SIDE, SIDE, { kernel: 'cubic', fit: 'fill' }).toColourspace('srgb').raw().toBuffer();
    feeds = { image: new ort.Tensor('uint8', raw, [1, SIDE, SIDE, 3]) };
  }
  const t0 = Date.now();
  const out = await session.run(feeds);
  const tInf = Date.now() - t0;
  const key = variant === 'v2' ? 'predicted_depth' : 'depth';
  const data = Float32Array.from(out[key].data);
  const dims = out[key].dims;

  let depth, sw, sh;
  if (variant === 'v2') { depth = data; sw = inputW; sh = inputH; }
  else if (variant === 'da3') { const c = cropLetterboxDepth(data, dims, plan); depth = c.depth; sw = c.width; sh = c.height; }
  else { depth = data; sw = dims[dims.length - 1]; sh = dims[dims.length - 2]; }

  // 与引擎一致的后处理：归一化(8bit) → 半分辨率 cubic → dilate2x → 再归一化
  const norm = normalizeDepth(depth, variant !== 'v2');
  const dw = Math.max(1, Math.floor(w0 / 2)), dh = Math.max(1, Math.floor(h0 / 2));
  const mid = await sharp(norm, { raw: { width: sw, height: sh, channels: 1 } })
    .resize(dw, dh, { kernel: 'cubic', fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
  const g = new Float32Array(dw * dh);
  for (let i = 0; i < g.length; i++) g[i] = mid[i];
  const fin = normalizeDepth(dilate2x(g, dw, dh), false);
  return { fin, dw, dh, tInf, meta: { w0, h0 } };
}

function sobelStats(g, w, h) {
  let sum = 0, p95n = 0, sharpN = 0, total = (w - 2) * (h - 2);
  const grads = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
    const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
    const m = Math.hypot(gx, gy);
    sum += m; grads.push(m);
    if (m > 255) sharpN++;
  }
  grads.sort((a, b) => a - b);
  p95n = grads[Math.floor(grads.length * 0.95)];
  return { mean: sum / total, p95: p95n, sharpPx: sharpN, sharpPct: 100 * sharpN / total };
}

(async () => {
  const imgs = process.argv.slice(2);
  const picks = imgs.length ? imgs : fs.readdirSync('F:/Syncthing/Download/Anima-Random')
    .filter(f => /\.(png|jpg|jpeg)$/i.test(f)).slice(0, 3)
    .map(f => 'F:/Syncthing/Download/Anima-Random/' + f);
  const outDir = path.join(__dirname, 'out', 'depth-ab');
  fs.mkdirSync(outDir, { recursive: true });
  const sessions = { v2: await ort.InferenceSession.create(MODELS.v2, { executionProviders: ['dml', 'cpu'] }),
                     da3: await ort.InferenceSession.create(MODELS.da3, { executionProviders: ['dml', 'cpu'] }) };
  const rows = [];
  for (const img of picks) {
    const base = path.basename(img).replace(/\.[^.]+$/, '').slice(0, 40);
    for (const variant of ['v2', 'da3', 'da3-rep', 'da3-crop']) {
      const sess = sessions[variant === 'v2' ? 'v2' : 'da3'];
      const r = await runVariant(sess, variant, img);
      const st = sobelStats(r.fin, r.dw, r.dh);
      rows.push({ img: base, variant, ...st, ms: r.tInf, size: `${r.dw}x${r.dh}` });
      await sharp(r.fin, { raw: { width: r.dw, height: r.dh, channels: 1 } })
        .png().toFile(path.join(outDir, `${base}.${variant}.png`));
    }
  }
  console.log('\n| 图 | 变体 | 梯度均值 | p95梯度 | 锐边像素占比 | 推理ms | 深度尺寸 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows)
    console.log(`| ${r.img.slice(0, 18)} | ${r.variant} | ${r.mean.toFixed(1)} | ${r.p95.toFixed(0)} | ${r.sharpPct.toFixed(2)}% | ${r.ms} | ${r.size} |`);
})().catch(e => { console.error(e); process.exit(1); });
