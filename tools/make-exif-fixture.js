'use strict';

/**
 * 生成一张带完整 EXIF（相机参数 + GPS）的 JPEG 测试样本。
 *
 *   electron tools/make-exif-fixture.js
 *
 * 为什么要造：用户的壁纸库全是 AI 生成图和网络图，没有任何相机 EXIF。
 * 「EXIF 完整信息面板」这个功能如果没有样本，就只能验证「空的时候不崩」，
 * 验证不到「字段映射对不对、单位格式化对不对」。
 *
 * 做法分两步：
 *   1. 用 nativeImage 造一张渐变 JPEG（省得自己写 JPEG 编码器）；
 *   2. 手写一个 TIFF/IFD 序列化器，把 APP1(Exif) 段插到 SOI 之后。
 *      JPEG 本来就是「标记段 + 熵编码数据」的流，插一个 APP1 是合法操作。
 */

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'fixtures', 'exif-camera.jpg');

/* ------------------------------------------------------------------ TIFF */

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function encodeValues(type, values) {
  if (type === 2) return Buffer.from(`${values}\0`, 'latin1');        // ASCII
  if (type === 7) return Buffer.from(String(values), 'latin1');       // UNDEFINED

  const list = Array.isArray(values) ? values : [values];

  if (type === 5 || type === 10) {                                    // RATIONAL
    const buf = Buffer.alloc(list.length * 8);
    list.forEach((v, i) => {
      const [num, den] = Array.isArray(v) ? v : [v, 1];
      if (type === 5) {
        buf.writeUInt32LE(num >>> 0, i * 8);
        buf.writeUInt32LE(den >>> 0, i * 8 + 4);
      } else {
        buf.writeInt32LE(num, i * 8);
        buf.writeInt32LE(den, i * 8 + 4);
      }
    });
    return buf;
  }

  const size = TYPE_SIZE[type];
  const buf = Buffer.alloc(list.length * size);
  list.forEach((v, i) => {
    if (type === 1) buf.writeUInt8(v, i);
    else if (type === 3) buf.writeUInt16LE(v, i * 2);
    else if (type === 4) buf.writeUInt32LE(v >>> 0, i * 4);
    else if (type === 9) buf.writeInt32LE(v, i * 4);
  });
  return buf;
}

function countOf(type, values) {
  if (type === 2) return Buffer.from(`${values}\0`, 'latin1').length;
  if (type === 7) return Buffer.from(String(values), 'latin1').length;
  return Array.isArray(values) ? values.length : 1;
}

/** 序列化一个 IFD。超过 4 字节的值放进 data pool，条目里写偏移 */
function serializeIfd(entries, poolStart) {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const size = 2 + sorted.length * 12 + 4;

  const out = Buffer.alloc(size);
  out.writeUInt16LE(sorted.length, 0);

  const poolParts = [];
  let pool = poolStart;
  let offset = 2;

  for (const entry of sorted) {
    const data = encodeValues(entry.type, entry.values);
    const count = countOf(entry.type, entry.values);

    out.writeUInt16LE(entry.tag, offset);
    out.writeUInt16LE(entry.type, offset + 2);
    out.writeUInt32LE(count, offset + 4);

    if (data.length <= 4) {
      data.copy(out, offset + 8);
    } else {
      out.writeUInt32LE(pool, offset + 8);
      const padded = data.length % 2 === 0 ? data : Buffer.concat([data, Buffer.alloc(1)]);
      poolParts.push(padded);
      pool += padded.length;
    }
    offset += 12;
  }

  out.writeUInt32LE(0, offset);          // 没有下一个 IFD
  return { ifd: out, poolParts, poolEnd: pool };
}

/**
 * @param {Array} ifd0 IFD0 条目
 * @param {Array} exif ExifIFD 条目
 * @param {Array} gps  GPS IFD 条目
 * @returns {Buffer} 完整的 TIFF 块（不含 "Exif\0\0" 前缀）
 */
function buildTiff(ifd0, exif, gps) {
  // ⚠️ IFD0 里会被追加两个指针条目（ExifIFD / GPS），
  //    算尺寸时必须用追加后的条目数，否则后面所有偏移都会差 24 字节。
  const ifd0Count = ifd0.length + 2;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifSize = 2 + exif.length * 12 + 4;
  const gpsSize = 2 + gps.length * 12 + 4;

  const ifd0Offset = 8;                              // 紧跟 8 字节 TIFF 头
  const exifOffset = ifd0Offset + ifd0Size;
  const gpsOffset = exifOffset + exifSize;
  const poolStart = gpsOffset + gpsSize;

  // 三个 IFD 指针要在写之前就知道
  const withPointers = [
    ...ifd0,
    { tag: 0x8769, type: 4, values: exifOffset },
    { tag: 0x8825, type: 4, values: gpsOffset },
  ];

  let pool = poolStart;
  const ifds = [];
  const poolParts = [];

  for (const entries of [withPointers, exif, gps]) {
    const r = serializeIfd(entries, pool);
    ifds.push(r.ifd);
    poolParts.push(...r.poolParts);
    pool = r.poolEnd;
  }

  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');                   // 小端
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);                        // IFD0 偏移

  return Buffer.concat([header, ...ifds, ...poolParts]);
}

function app1Segment(tiff) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = 0xe1;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** 把 APP1 插到 JPEG 里。APP0(JFIF) 之后、其他段之前 */
function spliceExif(jpeg, app1) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('不是 JPEG');
  let pos = 2;
  if (jpeg[pos] === 0xff && jpeg[pos + 1] === 0xe0) {          // 跳过 APP0
    pos += 2 + jpeg.readUInt16BE(pos + 2);
  }
  return Buffer.concat([jpeg.subarray(0, pos), app1, jpeg.subarray(pos)]);
}

/* ------------------------------------------------------------------ 主流程 */

app.whenReady().then(() => {
  const W = 800;
  const H = 450;

  // 1) 造一张渐变图并编码为 JPEG
  const bgra = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const off = (y * W + x) * 4;
      bgra[off] = Math.round(40 + (y / H) * 150);          // B
      bgra[off + 1] = Math.round(60 + (x / W) * 120);      // G
      bgra[off + 2] = Math.round(90 + ((x + y) / (W + H)) * 120); // R
      bgra[off + 3] = 255;
    }
  }
  const base = nativeImage.createFromBitmap(bgra, { width: W, height: H }).toJPEG(92);
  if (!base || base.length === 0) {
    console.error('生成基础 JPEG 失败');
    app.exit(1);
    return;
  }
  console.log('基础 JPEG:', base.length, 'bytes');

  // 2) 造 EXIF。坐标取北京天安门附近，方便肉眼核对
  const lat = [[39, 1], [54, 1], [26, 1]];        // 39°54'26"
  const lon = [[116, 1], [23, 1], [29, 1]];       // 116°23'29"

  const ifd0 = [
    { tag: 0x010f, type: 2, values: 'Canon' },                        // Make
    { tag: 0x0110, type: 2, values: 'Canon EOS R6 Mark II' },         // Model
    { tag: 0x0112, type: 3, values: 1 },                              // Orientation
    { tag: 0x011a, type: 5, values: [[300, 1]] },                     // XResolution
    { tag: 0x011b, type: 5, values: [[300, 1]] },                     // YResolution
    { tag: 0x0128, type: 3, values: 2 },                              // ResolutionUnit: inch
    { tag: 0x0131, type: 2, values: 'Wallpaper Switcher Test Fixture' }, // Software
    { tag: 0x0132, type: 2, values: '2026:05:18 16:42:07' },          // DateTime
    { tag: 0x013b, type: 2, values: 'Test Fixture' },                 // Artist
  ];

  const exifIfd = [
    { tag: 0x829a, type: 5, values: [[1, 500]] },                     // ExposureTime 1/500
    { tag: 0x829d, type: 5, values: [[28, 10]] },                     // FNumber f/2.8
    { tag: 0x8827, type: 3, values: 400 },                            // ISO
    { tag: 0x8822, type: 3, values: 3 },                              // ExposureProgram 光圈优先
    { tag: 0x9000, type: 7, values: '0232' },                         // ExifVersion
    { tag: 0x9003, type: 2, values: '2026:05:18 16:42:07' },          // DateTimeOriginal
    { tag: 0x9004, type: 2, values: '2026:05:18 16:42:07' },          // DateTimeDigitized
    { tag: 0x9204, type: 10, values: [[1, 3]] },                      // ExposureBias +1/3 EV
    { tag: 0x9207, type: 3, values: 5 },                              // MeteringMode 图案测光
    { tag: 0x9209, type: 3, values: 16 },                             // Flash 强制关闭
    { tag: 0x920a, type: 5, values: [[85, 1]] },                      // FocalLength 85mm
    { tag: 0xa001, type: 3, values: 1 },                              // ColorSpace sRGB
    { tag: 0xa002, type: 4, values: W },                              // PixelXDimension
    { tag: 0xa003, type: 4, values: H },                              // PixelYDimension
    { tag: 0xa402, type: 3, values: 0 },                              // ExposureMode 自动
    { tag: 0xa403, type: 3, values: 0 },                              // WhiteBalance 自动
    { tag: 0xa405, type: 3, values: 85 },                             // FocalLengthIn35mm
    { tag: 0xa434, type: 2, values: 'RF85mm F1.2 L USM' },            // LensModel
  ];

  const gpsIfd = [
    { tag: 0x0000, type: 1, values: 2 },                              // GPSVersionID
    { tag: 0x0001, type: 2, values: 'N' },                            // GPSLatitudeRef
    { tag: 0x0002, type: 5, values: lat },                            // GPSLatitude
    { tag: 0x0003, type: 2, values: 'E' },                            // GPSLongitudeRef
    { tag: 0x0004, type: 5, values: lon },                            // GPSLongitude
    { tag: 0x0005, type: 1, values: 0 },                              // GPSAltitudeRef 海平面以上
    { tag: 0x0006, type: 5, values: [[52, 1]] },                      // GPSAltitude 52m
    { tag: 0x0012, type: 2, values: 'WGS-84' },                       // GPSMapDatum
    { tag: 0x001d, type: 2, values: '2026:05:18' },                   // GPSDateStamp
  ];

  const tiff = buildTiff(ifd0, exifIfd, gpsIfd);
  console.log('TIFF 块:', tiff.length, 'bytes');

  const withExif = spliceExif(base, app1Segment(tiff));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, withExif);
  console.log('已写出:', OUT);
  console.log('  大小:', withExif.length, 'bytes   （基础图', base.length, '）');

  // 3) 立刻用 exifr 回读，确认插进去的段是有效的
  const exifr = require('../node_modules/exifr');
  exifr.parse(OUT, { tiff: true, ifd0: true, exif: true, gps: true, translateKeys: true, reviveValues: true })
    .then((parsed) => {
      const want = ['Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO',
        'FocalLength', 'FocalLengthIn35mmFormat', 'ExposureProgram', 'MeteringMode',
        'Flash', 'WhiteBalance', 'ColorSpace', 'Orientation', 'Software', 'Artist',
        'DateTimeOriginal', 'ExposureCompensation', 'latitude', 'longitude', 'GPSAltitude'];
      console.log('\n=== 回读校验 ===');
      let miss = 0;
      for (const key of want) {
        const v = parsed ? parsed[key] : undefined;
        if (v === undefined || v === null) { miss += 1; console.log(`  ✗ ${key}`); }
        else console.log(`  ✓ ${key.padEnd(26)} ${v instanceof Date ? v.toISOString() : String(v).slice(0, 46)}`);
      }
      console.log(miss === 0 ? '\n全部字段读回成功' : `\n有 ${miss} 个字段没读回`);
      app.exit(miss === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error('回读失败:', err.message);
      app.exit(1);
    });
});

app.on('window-all-closed', () => { /* 无窗口，等 whenReady 里的流程自己退出 */ });
