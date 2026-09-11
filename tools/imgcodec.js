'use strict';

/**
 * 纯 JS 的 PNG 编解码 + 裁剪 / 放大。不依赖任何原生模块，也不需要应用在跑。
 *
 * 为什么要它：本模型没有视觉能力，读用户截图只能靠像素分析 + OCR；
 * 而 OCR 对**小字**很不友好 —— 先把感兴趣的区域裁出来放大 3~4 倍再识别，
 * 准确率差别是「读得出来」和「读不出来」。
 *
 * 支持：PNG（灰度 / 调色板 / 灰度+Alpha / RGB / RGBA，1/2/4/8/16 位深，非隔行）
 * 不支持：JPEG —— 那种情况用 tools/enlarge-image.js（借应用渲染进程的 canvas 解）
 *
 *   const img = decodePng(buf);            // { width, height, data: RGBA Uint8Array }
 *   const big = resize(crop(img, rect), 4);
 *   fs.writeFileSync('out.png', encodePng(big));
 */

const zlib = require('node:zlib');

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ 解码 */

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 的第 b 位取出来的值（bitDepth < 8 时一行内多个像素打包在一个字节里） */
function readBits(row, bitDepth, index) {
  if (bitDepth === 8) return row[index];
  if (bitDepth === 16) return row[index * 2];          // 取高位字节，够看
  const perByte = 8 / bitDepth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('不是 PNG 文件（JPEG 请用 tools/enlarge-image.js）');

  let off = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let trns = null;

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    off += 12 + len;
  }

  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (ihdr.interlace) throw new Error('暂不支持隔行 PNG');

  const { width: W, height: H, bitDepth: bd, colorType: ct } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${ct}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, Math.ceil((channels * bd) / 8));       // 滤波时用的「每像素字节数」
  const stride = Math.ceil((W * channels * bd) / 8);
  const lines = Buffer.alloc(H * stride);

  let pos = 0;
  for (let y = 0; y < H; y += 1) {
    const filter = raw[pos]; pos += 1;
    const cur = raw.subarray(pos, pos + stride); pos += stride;
    const out = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      const x = cur[i];
      out[i] = {
        0: x,
        1: x + a,
        2: x + b,
        3: x + ((a + b) >> 1),
        4: x + paeth(a, b, c),
      }[filter] & 0xff;
    }
  }

  // 统一输出 RGBA
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const row = lines.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      if (ct === 0 || ct === 4) {
        const g = readBits(row, bd, x * channels);
        rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g;
        rgba[o + 3] = ct === 4 ? readBits(row, bd, x * channels + 1) : 255;
      } else if (ct === 2) {
        const i = x * 3;
        rgba[o] = readBits(row, bd, i);
        rgba[o + 1] = readBits(row, bd, i + 1);
        rgba[o + 2] = readBits(row, bd, i + 2);
        rgba[o + 3] = 255;
      } else if (ct === 6) {
        const i = x * 4;
        rgba[o] = readBits(row, bd, i);
        rgba[o + 1] = readBits(row, bd, i + 1);
        rgba[o + 2] = readBits(row, bd, i + 2);
        rgba[o + 3] = readBits(row, bd, i + 3);
      } else {
        const idx = readBits(row, bd, x);
        rgba[o] = palette[idx * 3];
        rgba[o + 1] = palette[idx * 3 + 1];
        rgba[o + 2] = palette[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
  }

  return { width: W, height: H, data: rgba };
}

/* ------------------------------------------------------------------ 编码 */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA → PNG（8 位、颜色类型 6） */
function encodePng(img) {
  const { width: W, height: H, data } = img;
  const stride = W * 4;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y += 1) {
    raw[y * (stride + 1)] = 0;                                   // 不用滤波，图小无所谓
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ 裁剪 / 放大 */

function crop(img, { x = 0, y = 0, width, height }) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const w = Math.min(img.width - x0, Math.round(width ?? img.width - x0));
  const h = Math.min(img.height - y0, Math.round(height ?? img.height - y0));
  const out = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy += 1) {
    const src = ((y0 + yy) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), yy * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** 双线性放大。factor 必须是 >1 的数；OCR 前放大 3~4 倍效果最好 */
function resize(img, factor) {
  const W = Math.round(img.width * factor);
  const H = Math.round(img.height * factor);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    const sy = Math.min(img.height - 1.001, y / factor);
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const y1 = Math.min(img.height - 1, y0 + 1);
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(img.width - 1.001, x / factor);
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const x1 = Math.min(img.width - 1, x0 + 1);
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p00 = img.data[(y0 * img.width + x0) * 4 + c];
        const p10 = img.data[(y0 * img.width + x1) * 4 + c];
        const p01 = img.data[(y1 * img.width + x0) * 4 + c];
        const p11 = img.data[(y1 * img.width + x1) * 4 + c];
        const top = p00 + (p10 - p00) * fx;
        const bot = p01 + (p11 - p01) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return { width: W, height: H, data: out };
}

/** 二值化（前景=黑，背景=白），低对比度的小字识别前用一下往往更准 */
function threshold(img, cutoff = 128, invert = false) {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    const v = (invert ? l < cutoff : l >= cutoff) ? 255 : 0;
    out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

module.exports = { decodePng, encodePng, crop, resize, threshold, crc32 };
