'use strict';

/**
 * 截图结构分析：分行 / 分列找出「文字带」与内容块。
 *
 * 用途：读一张截图时先搞清版式 —— 有几行文字、各行多高、
 * 内容集中在哪几段横向区间（左边图标？中间标题？右边开关？）。
 * 有了这些再去 OCR，能少走很多弯路。
 *
 * 纯 JS 解 PNG（tools/imgcodec.js），不需要应用在跑，也不依赖原生模块。
 *
 *   node tools/screenshot-layout.js <图片路径>
 *
 * 输出：主色分布 / 行段（文字行、分隔线）/ 列段（内容横向分布）/ 四角取样。
 */

const fs = require('node:fs');
const path = require('node:path');
const img_ = require('./imgcodec');

const file = process.argv[2];
if (!file) { console.error('用法：node tools/screenshot-layout.js <图片路径>'); process.exit(2); }

const img = img_.decodePng(fs.readFileSync(path.resolve(file)));
const { width: W, height: H, data } = img;

const hex = (k) => '#' + k.toString(16).padStart(6, '0');
const key = (x, y) => {
  const i = (y * W + x) * 4;
  return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
};
const diff = (a, b) => Math.abs(((a >> 16) & 255) - ((b >> 16) & 255))
  + Math.abs(((a >> 8) & 255) - ((b >> 8) & 255))
  + Math.abs((a & 255) - (b & 255));

/* 主色分布 */
const freq = new Map();
for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
  const k = key(x, y);
  freq.set(k, (freq.get(k) || 0) + 1);
};
const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
const bg = sorted[0][0];

console.log(`尺寸 ${W}×${H}`);
console.log('主色：' + sorted.slice(0, 6).map(([k, n]) => `${hex(k)} ${(n / (W * H) * 100).toFixed(1)}%`).join('   '));

/* 行墨迹：与**该行自身的主色**比较 —— 深底浅字、浅底深字都能认 */
const rowInk = [];
for (let y = 0; y < H; y += 1) {
  const row = new Map();
  for (let x = 0; x < W; x += 1) {
    const k = key(x, y);
    row.set(k, (row.get(k) || 0) + 1);
  }
  let bgRow = bg; let mx = -1;
  for (const [k, n] of row) if (n > mx) { mx = n; bgRow = k; }
  let ink = 0;
  for (let x = 0; x < W; x += 1) if (diff(key(x, y), bgRow) > 45) ink += 1;
  rowInk.push(ink / W);
}

const bands = [];
let s = -1;
for (let y = 0; y <= H; y += 1) {
  const on = y < H && rowInk[y] > 0.008;
  if (on && s < 0) s = y;
  if (!on && s >= 0) {
    let peak = 0;
    for (let k = s; k < y; k += 1) peak = Math.max(peak, rowInk[k]);
    bands.push({ y: s, y2: y - 1, h: y - s, peak: +(peak * 100).toFixed(1), bg: hex(key(W >> 1, (s + y) >> 1)) });
    s = -1;
  }
}

console.log(`\n行段 ${bands.length} 个（行间距大会把一行断成两段，可用它数「有几行字」）：`);
for (const b of bands) {
  console.log(`  y=${String(b.y).padStart(4)}..${String(b.y2).padStart(4)}  高 ${String(b.h).padStart(3)}  墨迹峰值 ${String(b.peak).padStart(5)}%  段内背景 ${b.bg}`);
}

/* 列墨迹 */
const colInk = [];
for (let x = 0; x < W; x += 1) {
  let ink = 0;
  for (let y = 0; y < H; y += 1) if (diff(key(x, y), bg) > 60) ink += 1;
  colInk.push(ink / H);
}
const cols = [];
s = -1;
for (let x = 0; x <= W; x += 1) {
  const on = x < W && colInk[x] > 0.02;
  if (on && s < 0) s = x;
  if (!on && s >= 0) { cols.push([s, x - 1]); s = -1; }
}

console.log(`\n列段 ${cols.length} 个（内容在横向上的分布，左/中/右一目了然）：`);
for (const [a, b] of cols) {
  console.log(`  x=${String(a).padStart(4)}..${String(b).padStart(4)}  宽 ${String(b - a + 1).padStart(4)}  (占宽 ${(a / W * 100).toFixed(1)}%~${((b + 1) / W * 100).toFixed(1)}%)`);
}

const at = (x, y) => hex(key(x, y));
console.log(`\n四角：${at(0, 0)} ${at(W - 1, 0)} ${at(0, H - 1)} ${at(W - 1, H - 1)}   内缩 3px：${at(3, 3)}   正中：${at(W >> 1, H >> 1)}`);
