'use strict';

/**
 * 区域内的颜色聚类：把相近颜色合并，输出每类的**包围盒 + 占比**。
 * 用来判断「这块是图标 / 开关 / 按钮 / 文字」——形状靠 bbox，颜色靠主色。
 *
 *   node tools/_probe-colors.js <图片路径> x,y,w,h [颜色容差]
 */

const fs = require('node:fs');
const path = require('node:path');
const img_ = require('./imgcodec');

const [file, zone, tolArg] = process.argv.slice(2);
const [rx, ry, rw, rh] = String(zone).split(',').map(Number);
const TOL = Number(tolArg || 24);

const img = img_.decodePng(fs.readFileSync(path.resolve(file)));
const { width: W, data } = img;

const hex = (r, g, b) => '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');

// 先统计全局背景（整图最高频色），用来标出「非背景」的范围
const allFreq = new Map();
for (let i = 0; i < data.length; i += 4) {
  const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  allFreq.set(k, (allFreq.get(k) || 0) + 1);
}
const bgKey = [...allFreq.entries()].sort((a, b) => b[1] - a[1])[0][0];
const bg = [(bgKey >> 16) & 255, (bgKey >> 8) & 255, bgKey & 255];

const clusters = [];
function findCluster(r, g, b) {
  for (const c of clusters) {
    if (Math.abs(c.r - r) <= TOL && Math.abs(c.g - g) <= TOL && Math.abs(c.b - b) <= TOL) return c;
  }
  return null;
}

let bgCount = 0;
for (let y = ry; y < ry + rh; y += 1) {
  for (let x = rx; x < rx + rw; x += 1) {
    const i = (y * W + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.abs(r - bg[0]) <= 12 && Math.abs(g - bg[1]) <= 12 && Math.abs(b - bg[2]) <= 12) { bgCount += 1; continue; }
    let c = findCluster(r, g, b);
    if (!c) {
      c = { r, g, b, n: 0, x0: x, x1: x, y0: y, y1: y, sr: 0, sg: 0, sb: 0 };
      clusters.push(c);
    }
    c.n += 1; c.sr += r; c.sg += g; c.sb += b;
    if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
    if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
  }
}

const total = rw * rh;
console.log(`区域 ${rx},${ry} ${rw}×${rh}   背景占 ${(bgCount / total * 100).toFixed(0)}%   聚类 ${clusters.length} 类\n`);
clusters.sort((a, b) => b.n - a.n).slice(0, 14).forEach((c) => {
  const r = Math.round(c.sr / c.n), g = Math.round(c.sg / c.n), b = Math.round(c.sb / c.n);
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  console.log(`  ${hex(r, g, b)}  ${String(c.n).padStart(5)}px (${(c.n / total * 100).toFixed(1)}%)  bbox x=${c.x0}..${c.x1}(${c.x1 - c.x0 + 1}) y=${c.y0}..${c.y1}(${c.y1 - c.y0 + 1})  ${sat > 40 ? '彩色' : '灰阶'}`);
});
