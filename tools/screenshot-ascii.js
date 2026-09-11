'use strict';

/**
 * 把截图某块区域打成**字符画**，这样没有视觉能力也能「看」清形状
 * （复选框 / 图标 / 开关 / 箭头 各有各的轮廓）。
 *
 *   node tools/_probe-ascii.js <图片路径> [x,y,w,h] [每格像素数]
 *
 * 不传区域就是整图。每格像素数默认 2（越小越清晰）。
 * 字符含义：` ` 背景  `-` 比背景亮一点  `+` 亮  `#` 很亮  `=` 暗
 */

const fs = require('node:fs');
const path = require('node:path');
const img_ = require('./imgcodec');

const file = process.argv[2];
const img = img_.decodePng(fs.readFileSync(path.resolve(file)));
const { width: W, height: H, data } = img;

const region = process.argv[3] ? process.argv[3].split(',').map(Number) : [0, 0, W, H];
const cell = Number(process.argv[4] || 2);
const [rx, ry, rw, rh] = region;

// 背景取整图最高频色
const freq = new Map();
for (let i = 0; i < data.length; i += 4) {
  const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  freq.set(k, (freq.get(k) || 0) + 1);
}
const bg = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
const bgL = 0.299 * ((bg >> 16) & 255) + 0.587 * ((bg >> 8) & 255) + 0.114 * (bg & 255);

// 顺便报告这块区域的颜色构成（区分「彩色图标」还是「单色字」）
const colors = new Map();
let colored = 0;

const cols = Math.ceil(rw / cell);
const rows = Math.ceil(rh / cell);
const out = [];
for (let cy = 0; cy < rows; cy += 1) {
  let line = '';
  for (let cx = 0; cx < cols; cx += 1) {
    let ink = 0, n = 0, sumL = 0;
    let rSum = 0, gSum = 0, bSum = 0;
    for (let y = ry + cy * cell; y < Math.min(ry + (cy + 1) * cell, ry + rh, H); y += 1) {
      for (let x = rx + cx * cell; x < Math.min(rx + (cx + 1) * cell, rx + rw, W); x += 1) {
        const i = (y * W + x) * 4;
        n += 1;
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sumL += l;
        if (Math.abs(l - bgL) > 25) {
          ink += 1;
          rSum += data[i]; gSum += data[i + 1]; bSum += data[i + 2];
        }
      }
    }
    if (!n) { line += ' '; continue; }
    const ratio = ink / n;
    const avgL = sumL / n;
    if (ratio < 0.12) line += ' ';
    else if (ratio < 0.4) line += avgL > bgL ? '-' : '.';
    else if (ratio < 0.7) line += avgL > bgL ? '+' : ':';
    else line += avgL > bgL ? '#' : '=';

    if (ink > n * 0.4) {
      const r = Math.round(rSum / ink), g = Math.round(gSum / ink), b = Math.round(bSum / ink);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > 40) { colored += 1; colors.set(`#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`, (colors.get(`#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`) || 0) + 1); }
    }
  }
  out.push(line);
}

console.log(`整图 ${W}×${H}   区域 ${rx},${ry} ${rw}×${rh}   每格 ${cell}px   字符画 ${cols}×${rows}`);
console.log(`背景 ${'#' + bg.toString(16).padStart(6, '0')}`);
if (colored) console.log(`彩色格 ${colored} 个，颜色: ${[...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c}×${n}`).join('  ')}`);
console.log('');
console.log('    ' + Array.from({ length: cols }, (_, i) => (rx + i * cell) % 100 === 0 ? '|' : (Math.floor((rx + i * cell) / 10) % 10)).join(''));
out.forEach((l, i) => console.log(String(ry + i * cell).padStart(3) + ' ' + l));
