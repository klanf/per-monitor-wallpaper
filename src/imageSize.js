'use strict';

/**
 * 轻量图片头部解析 —— 只读文件头拿分辨率，不解码像素。
 *
 * 为什么需要它：原 Python 版 get_image_info() 走 PIL，读一次 EXIF/尺寸
 * 就要把图像解码进内存（8K 图约 95 MB）。这里改成纯头部解析，
 * 读几百字节就能拿到宽高，HUD 显示分辨率几乎零成本。
 */

const fs = require('node:fs');

const HEAD_BYTES = 64 * 1024; // JPEG 的 SOF 段可能靠后，读 64KB 足够覆盖

function readPng(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function readGif(buf) {
  if (buf.length < 10) return null;
  if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readBmp(buf) {
  if (buf.length < 26) return null;
  if (buf.toString('ascii', 0, 2) !== 'BM') return null;
  const width = Math.abs(buf.readInt32LE(18));
  const height = Math.abs(buf.readInt32LE(22));
  return { width, height };
}

function readWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  if (fourcc === 'VP8 ') {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (fourcc === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

const PARSERS = [readPng, readJpeg, readGif, readBmp, readWebp];

function readHead(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** @returns {{width:number,height:number}|null} */
function readImageSize(filePath) {
  const slice = readHead(filePath);
  if (!slice) return null;
  for (const parse of PARSERS) {
    try {
      const size = parse(slice);
      if (size && size.width > 0 && size.height > 0) return size;
    } catch { /* 换下一个解析器 */ }
  }
  return null;
}

/* ------------------------------------------------------------------ 扩展头部信息 */

const PNG_COLOR_TYPES = {
  0: '灰度',
  2: '真彩色 (RGB)',
  3: '索引色 (调色板)',
  4: '灰度 + Alpha',
  6: '真彩色 + Alpha (RGBA)',
};

/** 除了宽高，再给出位深 / 通道数 / 色彩类型等 EXIF 里没有的格式信息 */
function readImageDetails(filePath) {
  const buf = readHead(filePath);
  if (!buf || buf.length < 16) return null;

  const out = { format: null };

  // ---- PNG ----
  if (buf.readUInt32BE(0) === 0x89504e47) {
    out.format = 'PNG';
    out.width = buf.readUInt32BE(16);
    out.height = buf.readUInt32BE(20);
    out.bitDepth = buf[24];
    const colorType = buf[25];
    out.colorType = PNG_COLOR_TYPES[colorType] || `未知 (${colorType})`;
    out.channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || null;
    out.interlaced = buf[28] === 1;
    return out;
  }

  // ---- JPEG ----
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    out.format = 'JPEG';
    let offset = 2;
    let sawProgressive = false;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset += 1; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buf.readUInt16BE(offset + 2);
      if (marker === 0xc2) sawProgressive = true;
      const isSof = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        out.bitDepth = buf[offset + 4];
        out.height = buf.readUInt16BE(offset + 5);
        out.width = buf.readUInt16BE(offset + 7);
        out.channels = buf[offset + 9];
        out.colorType = { 1: '灰度', 3: 'YCbCr', 4: 'CMYK' }[out.channels] || null;
        out.progressive = sawProgressive;
        return out;
      }
      if (length <= 0) break;
      offset += 2 + length;
    }
    return out;
  }

  // ---- GIF ----
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    out.format = `GIF${buf.toString('ascii', 3, 6)}`;
    out.width = buf.readUInt16LE(6);
    out.height = buf.readUInt16LE(8);
    const packed = buf[10];
    out.bitDepth = (packed & 0x07) + 1;
    out.channels = 1;
    out.colorType = '索引色 (调色板)';
    return out;
  }

  // ---- BMP ----
  if (buf.toString('ascii', 0, 2) === 'BM') {
    out.format = 'BMP';
    out.width = Math.abs(buf.readInt32LE(18));
    out.height = Math.abs(buf.readInt32LE(22));
    out.bitDepth = buf.length >= 30 ? buf.readUInt16LE(28) : null;
    out.channels = out.bitDepth ? out.bitDepth / 8 : null;
    if (buf.length >= 34) {
      out.compression = { 0: '无压缩', 1: 'RLE8', 2: 'RLE4', 3: '位域', 4: 'JPEG', 5: 'PNG' }[buf.readUInt32LE(30)]
        || `未知 (${buf.readUInt32LE(30)})`;
    }
    return out;
  }

  // ---- WebP ----
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    out.format = 'WebP';
    if (fourcc === 'VP8X') {
      out.width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      out.height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      out.hasAlpha = (buf[20] & 0x10) !== 0;
    } else if (fourcc === 'VP8 ') {
      out.width = buf.readUInt16LE(26) & 0x3fff;
      out.height = buf.readUInt16LE(28) & 0x3fff;
    } else if (fourcc === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >> 14) & 0x3fff) + 1;
      out.hasAlpha = ((bits >> 28) & 1) === 1;
    }
    return out;
  }

  out.format = '未知';
  return out;
}

/** 最大公约数 */
function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) { const t = y; y = x % y; x = t; }
  return x || 1;
}

const COMMON_RATIOS = [
  [1, 1, '1:1'], [5, 4, '5:4'], [4, 3, '4:3'], [3, 2, '3:2'],
  [8, 5, '16:10'], [16, 9, '16:9'], [1.85, 1, '1.85:1'], [2, 1, '2:1'],
  [2.39, 1, '2.39:1'], [21, 9, '21:9'], [32, 9, '32:9'],
];

/**
 * 宽高比。
 *
 * 注意别退化成一个「化简后的分数」——3620×2560 化简出来是 181:128，
 * 这个分数没有任何信息量，读者还得自己除一遍。所以：
 *   命中常见比例（容差 0.5%）→ 用比例名（16:9 / 3:2 / 21:9 …）
 *   化简后分子分母都很小（≤ 32）→ 用化简分数
 *   其余 → 只给小数（1.41:1）
 * 两种情况下都同时给小数，方便对比。
 */
function aspectRatio(width, height) {
  if (!width || !height) return null;
  const actual = width / height;
  const decimal = `${actual.toFixed(2)}:1`;

  const portrait = actual < 1;
  const probe = portrait ? 1 / actual : actual;
  for (const [num, den, label] of COMMON_RATIOS) {
    const ratio = num / den;
    if (Math.abs(probe - ratio) / ratio < 0.005) {
      const text = portrait ? label.split(':').reverse().join(':') : label;
      return { short: text, decimal, approx: false };
    }
  }

  const d = gcd(width, height);
  const rw = width / d;
  const rh = height / d;
  if (rw <= 32 && rh <= 32) return { short: `${rw}:${rh}`, decimal, approx: false };

  return { short: decimal, decimal, approx: true };
}

module.exports = { readImageSize, readImageDetails, aspectRatio };
