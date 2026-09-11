'use strict';

/**
 * 逐字切分：把「一行文字」切成单字，输出每个字的宽度。
 *
 * 用途：即使读不出字，也能从**字宽**反推字号与字数 ——
 * 方块字（中日韩）宽 ≈ 字号，拉丁字母宽窄不一。
 * 于是「9 个汉字 ≈ 183px 墨迹宽 → 每个约 20px → 在 DPR 1.5 下是 13px 字号」
 * 这类结论是可以算出来的，用来和 OCR 结果互相印证（字数对不上就是 OCR 错了）。
 *
 * 纯 JS 解 PNG，不需要应用在跑。
 *
 *   node tools/screenshot-glyphs.js <图片路径> [x,y,w,h]
 */

const fs = require('node:fs');
const path = require('node:path');
const img_ = require('./imgcodec');

const file = process.argv[2];
if (!file) { console.error('用法：node tools/screenshot-glyphs.js <图片路径> [x,y,w,h]'); process.exit(2); }

const img = img_.decodePng(fs.readFileSync(path.resolve(file)));
const { width: W, height: H, data } = img;
const [rx, ry, rw, rh] = process.argv[3]
  ? process.argv[3].split(',').map(Number)
  : [0, 0, W, H];

const hex = (k) => '#' + k.toString(16).padStart(6, '0');
const key = (x, y) => {
  const i = (y * W + x) * 4;
  return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
};

const freq = new Map();
for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
  const k = key(x, y);
  freq.set(k, (freq.get(k) || 0) + 1);
};
const bg = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
const bgLum = 0.299 * ((bg >> 16) & 255) + 0.587 * ((bg >> 8) & 255) + 0.114 * (bg & 255);
const isInk = (k) => Math.abs(((k >> 16) & 255) - ((bg >> 16) & 255))
  + Math.abs(((k >> 8) & 255) - ((bg >> 8) & 255))
  + Math.abs((k & 255) - (bg & 255)) > 55;

/* 先在该区域内找出文字带的纵向范围 */
let y0 = ry + rh; let y1 = ry;
for (let y = ry; y < ry + rh; y += 1) {
  let n = 0;
  for (let x = rx; x < rx + rw; x += 1) if (isInk(key(x, y))) n += 1;
  if (n > 0) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
}
if (y1 < y0) { console.log('区域内没有内容'); process.exit(0); }

/* 列投影 → 连续有墨的列段 */
const cols = [];
for (let x = rx; x < rx + rw; x += 1) {
  let n = 0;
  for (let y = y0; y <= y1; y += 1) if (isInk(key(x, y))) n += 1;
  cols.push(n);
}

const runs = [];
let s = -1;
for (let i = 0; i <= cols.length; i += 1) {
  const on = i < cols.length && cols[i] > 0;
  if (on && s < 0) s = i;
  if (!on && s >= 0) { runs.push([s + rx, i - 1 + rx]); s = -1; }
}

console.log(`区域 ${rx},${ry} ${rw}×${rh}   背景 ${hex(bg)}   内容纵向 y=${y0}..${y1}（高 ${y1 - y0 + 1}）`);

const detail = runs.map(([a, b]) => {
  let ty = y1; let by = y0;
  const col = new Map();
  for (let y = y0; y <= y1; y += 1) for (let x = a; x <= b; x += 1) {
    const k = key(x, y);
    if (!isInk(k)) continue;
    col.set(k, (col.get(k) || 0) + 1);
    if (y < ty) ty = y;
    if (y > by) by = y;
  }
  const main = [...col.entries()].sort((p, q) => q[1] - p[1])[0][0];
  const lum = 0.299 * ((main >> 16) & 255) + 0.587 * ((main >> 8) & 255) + 0.114 * (main & 255);
  return { x: a, x2: b, w: b - a + 1, y: ty, h: by - ty + 1, color: hex(main), lighter: lum > bgLum };
});

/* 再按「间距 > 6px」把段聚成块 */
const blocks = [];
for (const r of detail) {
  const last = blocks[blocks.length - 1];
  if (last && r.x - last.x2 <= 6) {
    last.x2 = r.x2;
    last.w = last.x2 - last.x + 1;
    last.glyphs.push(r);
    last.y = Math.min(last.y, r.y);
    last.y2 = Math.max(last.y2, r.y + r.h - 1);
    last.h = last.y2 - last.y + 1;
  } else {
    blocks.push({ x: r.x, x2: r.x2, w: r.w, y: r.y, y2: r.y + r.h - 1, h: r.h, glyphs: [r] });
  }
}

console.log(`\n块 ${blocks.length} 个（按 6px 间距聚合，一个块通常是一个词/一个控件）：`);
for (const b of blocks) {
  const colors = [...new Set(b.glyphs.map((g) => g.color))].slice(0, 4);
  console.log(`  x=${String(b.x).padStart(4)}..${String(b.x2).padStart(4)} 宽 ${String(b.w).padStart(4)}`
    + `  y=${b.y}..${b.y2} 高 ${String(b.h).padStart(3)}`
    + `  ${String(b.glyphs.length).padStart(2)} 段  段宽 [${b.glyphs.map((g) => g.w).join(',')}]`
    + `  ${colors.join('/')} ${b.glyphs[0].lighter ? '亮于底' : '暗于底'}`);
}

console.log(`\n细分段 ${detail.length} 个（连在一起的笔画算一段，可用于估字数）：`);
for (const g of detail) {
  console.log(`  x=${String(g.x).padStart(4)}..${String(g.x2).padStart(4)} 宽 ${String(g.w).padStart(3)}`
    + `  y=${g.y}..${g.y + g.h - 1} 高 ${String(g.h).padStart(3)}  ${g.color} ${g.lighter ? '亮' : '暗'}`);
}
