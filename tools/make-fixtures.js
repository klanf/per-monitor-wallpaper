'use strict';
/**
 * 生成测试图。
 *
 * 1. 纯色 BMP（每张一色）—— 验证「每屏壁纸」时截图平均色对比给出无歧义证据；
 * 2. 一批渐变色 PNG（gallery/）—— 胶片条需要「能互相区分」的缩略图，
 *    纯色 BMP 太小看不出差异，而真实壁纸库又不能拿来做测试。
 *    PNG 用 zlib 手写，不引入任何图形库。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, 'fixtures');

/* ------------------------------------------------------------------ BMP */

function solidBmp(width, height, [r, g, b]) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;      // 行按 4 字节对齐
  const pixelBytes = rowSize * height;
  const fileSize = 54 + pixelBytes;

  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);                            // 像素数据偏移
  buf.writeUInt32LE(40, 14);                            // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);                             // planes
  buf.writeUInt16LE(24, 28);                            // bpp
  buf.writeUInt32LE(pixelBytes, 34);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const off = 54 + y * rowSize + x * 3;
      buf[off] = b; buf[off + 1] = g; buf[off + 2] = r;   // BMP 是 BGR
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * @param {(x:number, y:number) => [number,number,number]} pixel
 */
function makePng(width, height, pixel) {
  const stride = width * 3 + 1;                     // 每行开头 1 字节 filter type
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;                              // filter: None
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const off = rowStart + 1 + x * 3;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;        // bit depth
  ihdr[9] = 2;        // color type: truecolor
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** HSL → RGB，方便按序号铺色相 */
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return rgb.map((v) => Math.round((v + m) * 255));
}

/* ------------------------------------------------------------------ 输出 */

fs.mkdirSync(OUT_DIR, { recursive: true });

const bmpSpecs = [
  ['monitor-A-red.bmp', 320, 180, [220, 40, 40]],
  ['monitor-B-green.bmp', 320, 180, [40, 200, 90]],
  ['monitor-C-blue.bmp', 320, 180, [40, 90, 220]],
];

const rows = [];
for (const [name, w, h, color] of bmpSpecs) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, solidBmp(w, h, color));
  rows.push([name, `${w}×${h}`, `rgb(${color.join(',')})`, `${fs.statSync(file).size} B`]);
}

// ---- gallery：120 张渐变色 PNG，横竖混排 ----
const GALLERY = path.join(OUT_DIR, 'gallery');
fs.rmSync(GALLERY, { recursive: true, force: true });
fs.mkdirSync(GALLERY, { recursive: true });

const COUNT = Number(process.argv[2]) || 120;
let galleryBytes = 0;
let portrait = 0;

for (let i = 0; i < COUNT; i += 1) {
  // 每 5 张里放 1 张竖图，用来检查胶片条的混合宽高比
  const isPortrait = i % 5 === 4;
  const width = isPortrait ? 720 : 1280;
  const height = isPortrait ? 1280 : 720;
  if (isPortrait) portrait += 1;

  const hue = (i * 360) / COUNT;
  const accent = hslToRgb((hue + 40) % 360, 0.75, 0.55);
  // 一条随序号横向移动的色带 —— 缩略图上能一眼看出「这是第几张」
  const bandX = ((i * 37) % 100) / 100;

  const png = makePng(width, height, (x, y) => {
    const nx = x / width;
    const ny = y / height;
    const base = hslToRgb(hue, 0.6, 0.18 + 0.55 * ny);
    if (Math.abs(nx - bandX) < 0.06) return accent;
    return base;
  });

  const file = path.join(GALLERY, `g-${String(i + 1).padStart(3, '0')}-h${Math.round(hue)}.png`);
  fs.writeFileSync(file, png);
  galleryBytes += png.length;
}

rows.push(['gallery/', `${COUNT} 张`, `横 ${COUNT - portrait} / 竖 ${portrait}`, `${(galleryBytes / 1048576).toFixed(1)} MB`]);
rows.push(['（每张约）', '1280×720', '渐变色 + 序号色带', `${Math.round(galleryBytes / COUNT / 1024)} KB`]);

const w = [24, 12, 30, 12];
for (const row of rows) {
  console.log(row.map((cell, i) => String(cell).padEnd(w[i])).join(''));
}
