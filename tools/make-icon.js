'use strict';

/**
 * 从一张源图生成 Windows 图标（.ico）+ 一张 256×256 的 PNG。
 *
 * 为什么需要它：electron-builder 要求 ICO 里必须有一帧 **256×256**，
 * 否则打包直接报 `image ... must be at least 256x256` 然后退出。
 * 而手头的图标常常是「从别处裁下来的一张图」，尺寸不是正方形、也没有 256 那一档。
 *
 * 做法：
 *   1. 把源图按 **cover** 居中裁成正方形（短边铺满，不是拉伸，不会变形）；
 *   2. 从 256×256 用**盒式平均**缩出 128 / 64 / 48 / 32 / 16；
 *   3. 每帧都以 PNG 形式装进 ICO（Vista 以后都支持，也是现代 ICO 的通行做法）。
 *
 * 退出码非 0 表示自检没过：目录项与载荷的尺寸不一致、或缺 256×256 那一帧。
 * 这两种错 electron-builder 都不一定会拦（它只看目录项），所以必须自己在生成时查出来。
 *
 * 用法：
 *   node tools/make-icon.js <源图> [--out assets/icon.ico] [--png assets/icon.png] [--radius 0]
 *
 * 支持 PNG 源图；其它格式先自己转成 PNG。
 */

const fs = require('node:fs');
const path = require('node:path');
const imgcodec = require('./imgcodec');

const SIZES = [256, 128, 64, 48, 32, 16];

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('用法：node tools/make-icon.js <源图.png> [--out assets/icon.ico] [--png assets/icon.png] [--radius 0]');
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const outIco = opt('out', path.join(__dirname, '..', 'assets', 'icon.ico'));
const outPng = opt('png', path.join(__dirname, '..', 'assets', 'icon.png'));
const radius = Number(opt('radius', 0));

/* ------------------------------------------------------------ 图像处理 */

/**
 * cover 裁切成**严格 size×size** 的正方形。
 *
 * 这里有两个坑，都是踩过才明白的：
 *
 * ① 缩放基准必须是**短边**（`size / min(w, h)`）。
 *    用 `min(size/w, size/h)` 其实是 contain —— 短边到不了 size，
 *    之后的 crop 会被 imgcodec.crop 的边界夹住，产出 249×256 这种矩形。
 *    而 ICO 目录项是按「边长」记的（写 0 表示 256），于是图标被横向拉伸；
 *    electron-builder 也照样放过（它只看目录项），属于静默错误。
 *
 * ② 缩小时用盒式平均，不要用 resize 的双线性采样 ——
 *    采样在缩图时等于抽点，人物头发这种高频细节会起噪点，
 *    而 16/32px 恰恰是任务栏与托盘的实际显示尺寸。
 */
function squareCover(img, size) {
  const side = Math.min(img.width, img.height);
  const x = Math.max(0, Math.round((img.width - side) / 2));
  const y = Math.max(0, Math.round((img.height - side) / 2));
  const square = imgcodec.crop(img, { x, y, width: side, height: side });

  if (square.width === size) return square;
  if (square.width > size) return boxDownscale(square, size);
  return imgcodec.resize(square, size / square.width);    // 源图比目标还小：只能放大
}

/** 四角圆角（带一点抗锯齿）；radius=0 表示不动 */
function roundCorners(img, r) {
  if (!r) return img;
  const { width: W, height: H, data } = img;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      // 到最近的圆心距离；四角之外按距离衰减 alpha
      const cx = x < r ? r : (x > W - r ? W - r : x);
      const cy = y < r ? r : (y > H - r ? H - r : y);
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r - 1) continue;
      const i = (y * W + x) * 4;
      const fade = Math.max(0, Math.min(1, r - d));
      data[i + 3] = Math.round(data[i + 3] * fade);
    }
  }
  return img;
}

/**
 * 盒式滤波缩小（每个目标像素 = 它覆盖到的源像素的平均）。
 *
 * 为什么不用现成的 `imgcodec.resize`：那个是双线性**采样**，缩小的时候只是抽点，
 * 照片缩到 16×16 会明显起噪点（图标在任务栏/托盘就是 16~32px，看得很清楚）。
 * 盒式平均才是缩图的正确做法。
 */
function boxDownscale(img, size) {
  const { width: SW, height: SH, data } = img;
  const out = new Uint8Array(size * size * 4);
  const stepX = SW / size;
  const stepY = SH / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * stepY);
    const y1 = Math.max(y0 + 1, Math.min(SH, Math.floor((y + 1) * stepY)));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * stepX);
      const x1 = Math.max(x0 + 1, Math.min(SW, Math.floor((x + 1) * stepX)));

      // 按 alpha 加权求平均：分子 Σ(颜色×alpha)，分母 Σ(alpha)。
      //
      // 曾经这里除的是 r+g+b，等于把颜色强行归一化到「三通道和 = 255」——
      // 实测 256 帧平均色 rgb(167,161,174)，缩到 16px 变成 rgb(83,81,91)，
      // 亮度直接掉一半，任务栏/托盘的小图标全偏暗。分母只能是 alpha 之和。
      let r = 0; let g = 0; let b = 0; let aSum = 0; let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * SW + sx) * 4;
          const a = data[i + 3];             // 全透明像素权重为 0，不会把颜色往黑里拉
          r += data[i] * a;
          g += data[i + 1] * a;
          b += data[i + 2] * a;
          aSum += a;
          n += 1;
        }
      }

      const wi = (y * size + x) * 4;
      out[wi] = aSum > 0 ? Math.round(r / aSum) : 0;
      out[wi + 1] = aSum > 0 ? Math.round(g / aSum) : 0;
      out[wi + 2] = aSum > 0 ? Math.round(b / aSum) : 0;
      out[wi + 3] = Math.round(aSum / n);
    }
  }
  return { width: size, height: size, data: out };
}

/* ------------------------------------------------------------------ ICO */

/**
 * 组装 ICO。
 * 目录项里的宽高是 1 字节，**0 表示 256** —— 这一档就是 electron-builder 要找的。
 */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type = 1 (icon)
  header.writeUInt16LE(frames.length, 4);

  const dir = Buffer.alloc(frames.length * 16);
  let offset = 6 + frames.length * 16;

  frames.forEach((frame, i) => {
    const o = i * 16;
    dir[o] = frame.size >= 256 ? 0 : frame.size;
    dir[o + 1] = frame.size >= 256 ? 0 : frame.size;
    dir[o + 2] = 0;                        // 调色板数量（真彩色为 0）
    dir[o + 3] = 0;                        // reserved
    dir.writeUInt16LE(1, o + 4);           // color planes
    dir.writeUInt16LE(32, o + 6);          // bits per pixel
    dir.writeUInt32LE(frame.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += frame.png.length;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

/* ------------------------------------------------------------------ 主流程 */

const source = imgcodec.decodePng(fs.readFileSync(src));
console.log(`源图：${src}  ${source.width}×${source.height}`);

const master = roundCorners(squareCover(source, 256), radius);
if (master.width !== 256 || master.height !== 256) {
  console.error(`自检失败：主帧是 ${master.width}×${master.height}，必须是 256×256`);
  process.exit(1);
}

const frames = SIZES.map((size) => {
  const img = size === 256 ? master : boxDownscale(master, size);
  return { size, png: imgcodec.encodePng(img) };
});

/*
 * 载荷 PNG 自己的尺寸也要核。
 * ICO 目录项的宽高是 1 字节、256 写成 0，所以「目录项说 256、载荷其实是 249×256」
 * 这种不一致光看目录项发现不了 —— 上面那个 squareCover 的坑就是这么漏过去的。
 */
for (const f of frames) {
  const w = f.png.readUInt32BE(16);
  const h = f.png.readUInt32BE(20);
  if (w !== f.size || h !== f.size) {
    console.error(`自检失败：${f.size} 那一帧的载荷实际是 ${w}×${h}`);
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(outIco), { recursive: true });
fs.writeFileSync(outIco, buildIco(frames));
fs.writeFileSync(outPng, imgcodec.encodePng(master));

console.log(`已写出：${outIco}  ${(fs.statSync(outIco).size / 1024).toFixed(0)} KB`);
console.log(`已写出：${outPng}  ${(fs.statSync(outPng).size / 1024).toFixed(0)} KB`);
console.log(`帧：${frames.map((f) => `${f.size}×${f.size}`).join(' / ')}`);

// 顺手自检：重新解析一遍，确认 256 那一帧真的在（打包就是卡在这一条）
const check = fs.readFileSync(outIco);
const count = check.readUInt16LE(4);
let has256 = false;
for (let i = 0; i < count; i += 1) {
  const o = 6 + i * 16;
  const w = check[o] === 0 ? 256 : check[o];
  const h = check[o + 1] === 0 ? 256 : check[o + 1];
  if (w === 256 && h === 256) has256 = true;
}
console.log(has256 ? '自检通过：ICO 里有一帧 256×256' : '自检失败：没有 256×256 帧');
process.exit(has256 ? 0 : 1);
