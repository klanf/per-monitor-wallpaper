'use strict';

/**
 * 图片完整信息读取。
 *
 * 分三层，按「拿到信息的代价」从低到高：
 *   1. 文件系统属性（stat）           —— 任何时候都有，零成本
 *   2. 格式头部解析（imageSize.js）   —— 读 64 KB 头部，拿到分辨率/位深/通道/色彩类型
 *   3. EXIF / XMP / IPTC（exifr）     —— 相机参数、拍摄时间、GPS、软件、版权
 *
 * 为什么不自己写 EXIF 解析：TIFF IFD 要处理大小端、IFD 指针、子 IFD、
 * 有理数（分子/分母）、值类型分支，还要兼容各家相机写坏的偏移。exifr 是纯 JS、
 * 无原生依赖、只读需要的字节区间，这块没必要重造。
 *
 * 输出不做成「一堆原始标签」，而是**分组 + 标签/值对**：
 * 渲染层拿到就能直接画表，加字段不用改前端。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const { readImageDetails, aspectRatio } = require('./imageSize');

let exifr = null;
let exifrError = null;
try {
  exifr = require('exifr');
} catch (err) {
  exifrError = err.message;
}

/* ---------------------------------------------------------------- 格式化 */

function humanSize(bytes) {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const EXIF_DATETIME = /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/;

/**
 * EXIF 里的时间字符串是 `2026:05:18 16:42:07` 这种格式（日期部分用冒号）。
 * 直接丢给 `new Date('2026:05:18')` 会被现代引擎当成非法格式，
 * 退回实现相关的解析 —— 实测把它当成了 2026-01-01。所以自己解析。
 */
function fmtDate(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const m = EXIF_DATETIME.exec(value.trim());
    if (m) {
      const [, y, mo, d, hh, mm, ss] = m;
      return hh === undefined
        ? `${y}-${mo}-${d}`
        : `${y}-${mo}-${d} ${hh}:${mm}:${ss}`;
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** EXIF 里这些枚举值 exifr 不翻译，得自己映射，否则面板上就是一个裸数字 */
const COLOR_SPACE = { 1: 'sRGB', 2: 'Adobe RGB', 65535: '未校准 (Uncalibrated)' };
const ALTITUDE_REF = { 0: '海平面以上', 1: '海平面以下' };
const RESOLUTION_UNIT = { 1: '无单位', 2: '英寸 (dpi)', 3: '厘米 (dpcm)' };

/** 快门：0.002 → 1/500 秒；2.5 → 2.5 秒 */
function fmtExposure(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value);
  if (n >= 1) return `${Math.round(n * 10) / 10} 秒`;
  return `1/${Math.round(1 / n)} 秒`;
}

/** 光圈：2.8 → f/2.8 */
function fmtAperture(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value);
  return `f/${Math.round(n * 10) / 10}`;
}

function fmtFocal(value, value35) {
  const parts = [];
  if (Number.isFinite(Number(value)) && Number(value) > 0) parts.push(`${Math.round(Number(value) * 10) / 10} mm`);
  if (Number.isFinite(Number(value35)) && Number(value35) > 0) parts.push(`等效 ${Math.round(Number(value35))} mm`);
  return parts.length ? parts.join('  ·  ') : null;
}

function fmtEv(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0 EV';
  return `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10} EV`;
}

function fmtMegapixels(width, height) {
  if (!width || !height) return null;
  const mp = (width * height) / 1e6;
  return `${mp.toFixed(mp >= 10 ? 1 : 2)} MP`;
}

function fmtCoordinate(value, positive, negative) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const hemi = n >= 0 ? positive : negative;
  return `${Math.abs(n).toFixed(6)}° ${hemi}`;
}

function bytesToText(value) {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) {
    const s = value.toString('utf8').replace(/\0/g, '').trim();
    return s || null;
  }
  const s = String(value).replace(/\0/g, '').trim();
  return s || null;
}

/** 空值统一过滤：null / undefined / 空串 / 空数组都不进面板 */
function push(rows, label, value) {
  if (value === null || value === undefined) return;
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text === '—') return;
  if (Array.isArray(text) && text.length === 0) return;
  rows.push({ label, value: String(text) });
}

/* ---------------------------------------------------------------- 主流程 */

/**
 * @param {string} filePath
 * @returns {Promise<object>} 分组信息；即使 EXIF 完全读不到也会返回文件与图像两组
 */
async function readImageInfo(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  let stat = null;
  try {
    stat = await fsp.stat(filePath);
  } catch (err) {
    return { ok: false, error: `文件不可读：${err.code || err.message}`, path: filePath, groups: [] };
  }

  const details = readImageDetails(filePath) || {};
  const width = details.width || 0;
  const height = details.height || 0;

  // ---- EXIF / XMP / IPTC ----
  let raw = null;
  let exifNote = null;
  if (!exifr) {
    exifNote = `EXIF 解析器不可用：${exifrError || '未安装'}`;
  } else {
    try {
      raw = await exifr.parse(filePath, {
        tiff: true, ifd0: true, exif: true, gps: true,
        interop: false, ifd1: false, icc: false,
        iptc: true, xmp: true, jfif: true, jhdr: true,
        translateKeys: true, translateValues: true, reviveValues: true,
        mergeOutput: true, sanitize: true, silentErrors: true,
      });
    } catch (err) {
      exifNote = `EXIF 解析失败：${err.message}`;
    }
  }
  const x = raw || {};

  /* ---------------- 文件 ---------------- */
  const fileRows = [];
  push(fileRows, '文件名', path.basename(filePath));
  push(fileRows, '所在文件夹', path.dirname(filePath));
  push(fileRows, '完整路径', filePath);
  push(fileRows, '格式', details.format || ext.replace('.', '').toUpperCase());
  push(fileRows, '文件大小', humanSize(stat.size));
  push(fileRows, '修改时间', fmtDate(stat.mtimeMs));
  push(fileRows, '创建时间', fmtDate(stat.birthtimeMs || stat.ctimeMs));
  push(fileRows, '只读', (stat.mode & 0o200) === 0 ? '是' : null);

  /* ---------------- 图像 ---------------- */
  const imageRows = [];
  if (width && height) {
    push(imageRows, '分辨率', `${width} × ${height}`);
    const ratio = aspectRatio(width, height);
    if (ratio) {
      // 只给小数时（1.41:1）不要再重复一遍
      push(imageRows, '宽高比', ratio.short === ratio.decimal
        ? ratio.short
        : `${ratio.short}  (${ratio.decimal})`);
    }
    push(imageRows, '像素', fmtMegapixels(width, height));
    push(imageRows, '方向', width > height ? '横向' : (width < height ? '纵向' : '正方形'));
  }
  push(imageRows, '色彩类型', details.colorType);
  push(imageRows, '位深', details.bitDepth ? `${details.bitDepth} 位/通道` : null);
  push(imageRows, '通道数', details.channels);
  push(imageRows, '渐进式', details.progressive === undefined ? null : (details.progressive ? '是' : '否'));
  push(imageRows, '隔行扫描', details.interlaced === undefined ? null : (details.interlaced ? '是' : '否'));
  push(imageRows, '含 Alpha 通道', details.hasAlpha === undefined ? null : (details.hasAlpha ? '是' : '否'));
  push(imageRows, '压缩方式', details.compression);
  push(imageRows, '色彩空间', COLOR_SPACE[x.ColorSpace] || x.ColorSpace);
  push(imageRows, 'EXIF 方向', x.Orientation);
  // ResolutionUnit 在 translateValues 下会变成字符串（"inches"），
  // 没翻译时又是数字（2）—— 两种形态都要能吃
  const unitRaw = x.ResolutionUnit;
  const unitText = unitRaw === undefined || unitRaw === null
    ? ''
    : (RESOLUTION_UNIT[unitRaw] || String(unitRaw));
  const unitSuffix = /inch|英寸/i.test(unitText) ? 'dpi'
    : (/centimet|厘米/i.test(unitText) ? 'dpcm' : '');
  push(imageRows, '分辨率单位', unitText || null);
  push(imageRows, 'X 分辨率', x.XResolution ? `${x.XResolution}${unitSuffix ? ` ${unitSuffix}` : ''}` : null);
  push(imageRows, 'Y 分辨率', x.YResolution ? `${x.YResolution}${unitSuffix ? ` ${unitSuffix}` : ''}` : null);

  /* ---------------- 拍摄参数 ---------------- */
  const shotRows = [];
  push(shotRows, '拍摄时间', fmtDate(x.DateTimeOriginal || x.CreateDate || x.ModifyDate));
  push(shotRows, '相机厂商', x.Make);
  push(shotRows, '相机型号', x.Model);
  push(shotRows, '镜头', bytesToText(x.LensModel || x.Lens || x.LensInfo));
  push(shotRows, '焦距', fmtFocal(x.FocalLength, x.FocalLengthIn35mmFormat));
  push(shotRows, '光圈', fmtAperture(x.FNumber || x.ApertureValue));
  push(shotRows, '快门速度', fmtExposure(x.ExposureTime || x.ShutterSpeedValue));
  push(shotRows, 'ISO', x.ISO || x.ISOSpeedRatings);
  push(shotRows, '曝光补偿', fmtEv(x.ExposureCompensation ?? x.ExposureBiasValue));
  push(shotRows, '曝光程序', x.ExposureProgram);
  push(shotRows, '测光模式', x.MeteringMode);
  push(shotRows, '闪光灯', x.Flash);
  push(shotRows, '白平衡', x.WhiteBalance);
  push(shotRows, '曝光模式', x.ExposureMode);
  push(shotRows, '场景类型', x.SceneCaptureType);
  push(shotRows, '对比度', x.Contrast);
  push(shotRows, '饱和度', x.Saturation);
  push(shotRows, '锐度', x.Sharpness);
  push(shotRows, '感光度类型', x.SensitivityType);

  /* ---------------- 位置 ---------------- */
  const gpsRows = [];
  const lat = x.latitude ?? x.GPSLatitude;
  const lon = x.longitude ?? x.GPSLongitude;
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    push(gpsRows, '纬度', fmtCoordinate(lat, 'N', 'S'));
    push(gpsRows, '经度', fmtCoordinate(lon, 'E', 'W'));
  }
  push(gpsRows, '海拔', Number.isFinite(Number(x.GPSAltitude))
    ? `${Math.round(Number(x.GPSAltitude) * 10) / 10} m` : null);
  // exifr 把 GPSAltitudeRef 给成单字节数组（如 Uint8Array([0])），不是数字
  const altRef = Array.isArray(x.GPSAltitudeRef) || ArrayBuffer.isView(x.GPSAltitudeRef)
    ? Number(x.GPSAltitudeRef[0])
    : Number(x.GPSAltitudeRef);
  push(gpsRows, '海拔基准', ALTITUDE_REF[altRef] || (Number.isFinite(altRef) ? `未知 (${altRef})` : null));
  push(gpsRows, '坐标基准', x.GPSMapDatum);
  push(gpsRows, '拍摄方向', Number.isFinite(Number(x.GPSImgDirection))
    ? `${Math.round(Number(x.GPSImgDirection))}°` : null);
  push(gpsRows, '定位时间', fmtDate(x.GPSDateStamp));
  push(gpsRows, '定位方式', x.GPSProcessingMethod);

  /* ---------------- 来源信息 ---------------- */
  const originRows = [];
  push(originRows, '标题', bytesToText(x.ObjectName || x.Title || x.XPTitle));
  push(originRows, '作者', bytesToText(x.Artist || x.Creator || x.Byline));
  push(originRows, '版权', bytesToText(x.Copyright || x.CopyrightNotice));
  push(originRows, '软件', bytesToText(x.Software || x.CreatorTool));
  push(originRows, '描述', bytesToText(x.ImageDescription || x.Description || x.Caption));
  push(originRows, '关键词', Array.isArray(x.Keywords) ? x.Keywords.join('、') : bytesToText(x.Keywords));

  /* ---------------- 其他（未归类的原始标签） ---------------- */
  const KNOWN = new Set([
    'ColorSpace', 'Orientation', 'XResolution', 'YResolution',
    'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Make', 'Model',
    'LensModel', 'Lens', 'LensInfo', 'FocalLength', 'FocalLengthIn35mmFormat',
    'FNumber', 'ApertureValue', 'ExposureTime', 'ShutterSpeedValue', 'ISO', 'ISOSpeedRatings',
    'ExposureCompensation', 'ExposureBiasValue', 'ExposureProgram', 'MeteringMode',
    'Flash', 'WhiteBalance', 'ExposureMode', 'SceneCaptureType', 'Contrast',
    'Saturation', 'Sharpness', 'SensitivityType',
    'latitude', 'longitude', 'GPSLatitude', 'GPSLongitude', 'GPSAltitude',
    'GPSAltitudeRef', 'GPSImgDirection', 'GPSDateStamp', 'GPSProcessingMethod',
    'ObjectName', 'Title', 'XPTitle', 'Artist', 'Creator', 'Byline',
    'Copyright', 'CopyrightNotice', 'Software', 'CreatorTool',
    'ImageDescription', 'Description', 'Caption', 'Keywords',
    'ExifVersion', 'FlashpixVersion', 'ResolutionUnit', 'YCbCrPositioning',
    'ComponentsConfiguration', 'ExifImageWidth', 'ExifImageHeight', 'thumbnail',
    'GPSMapDatum',
    // PNG/WebP 的块信息 —— 头部解析器已经在「图像」组里给出了同样的内容
    'BitDepth', 'ColorType', 'Compression', 'Filter', 'Interlace',
    'ImageWidth', 'ImageHeight', 'Level',
  ]);

  const otherRows = [];
  for (const [key, value] of Object.entries(x)) {
    if (KNOWN.has(key) || key.startsWith('GPS')) continue;
    // JFIF 版本号、内嵌缩略图尺寸这些对看图的人没有意义，纯噪音
    if (/^(JFIF|Jfif|Thumbnail)/.test(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      if (value instanceof Date) { /* 上面已处理过时间类字段 */ }
      if (Buffer.isBuffer(value)) continue;
      if (Array.isArray(value)) {
        if (value.length > 12) continue;                 // 长数组（如 MakerNote）不展示
        push(otherRows, key, value.join(', '));
        continue;
      }
      continue;
    }
    push(otherRows, key, value);
  }
  otherRows.sort((a, b) => a.label.localeCompare(b.label));

  /* ---------------- 组装 ---------------- */
  const groups = [
    { id: 'file', title: '文件', rows: fileRows },
    { id: 'image', title: '图像', rows: imageRows },
  ];
  if (shotRows.length) groups.push({ id: 'shot', title: '拍摄参数', rows: shotRows });
  if (gpsRows.length) groups.push({ id: 'gps', title: '位置', rows: gpsRows });
  if (originRows.length) groups.push({ id: 'origin', title: '来源', rows: originRows });
  if (otherRows.length) groups.push({ id: 'other', title: '其他标签', rows: otherRows, collapsed: true });

  // HUD 用的一行摘要 —— 不必展开面板就能看到关键信息
  const summaryParts = [];
  if (width && height) summaryParts.push(`${width} × ${height}`);
  summaryParts.push(humanSize(stat.size));
  const camera = [x.Make, x.Model].filter(Boolean).join(' ');
  if (camera) summaryParts.push(camera);
  const shot = [fmtAperture(x.FNumber), fmtExposure(x.ExposureTime), x.ISO ? `ISO ${x.ISO}` : null]
    .filter(Boolean).join(' ');
  if (shot) summaryParts.push(shot);

  return {
    ok: true,
    path: filePath,
    name: path.basename(filePath),
    ext,
    hasExif: Boolean(raw && Object.keys(raw).length),
    exifNote,
    width, height,
    size: stat.size,
    sizeText: humanSize(stat.size),
    mtime: stat.mtimeMs,
    summary: summaryParts.join('   ·   '),
    gps: (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)))
      ? { lat: Number(lat), lon: Number(lon), url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}` }
      : null,
    groups,
    // 面板里只画 groups；raw 留给测试脚本核对
    rawKeys: Object.keys(x).length,
  };
}

module.exports = { readImageInfo, humanSize };
