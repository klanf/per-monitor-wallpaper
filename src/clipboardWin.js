'use strict';

/**
 * Win32 剪贴板直写 / 直读 —— 做两件 Electron 44 靠不住的事：
 *   ① **把文件放进剪贴板**（CF_HDROP）；
 *   ② **图片写入的兜底 + 回读校验**（CF_DIBV5）。
 *
 * 背景（实测结论，别删这段，否则以后一定会有人想「用官方 API 不是更简单」）：
 *   Electron 44 的主进程 clipboard 换成了 W3C 异步风格，只剩
 *   clear / has / read / readText / write / writeText，旧的 writeBuffer / writeImage 全部消失。
 *   其中：
 *     · 图片 —— 写 `image/png` 的 ClipboardItem 时，Chromium 会自动转成
 *       CF_DIBV5 / CF_BITMAP / CF_DIB，Word、画图、PS 都能正常粘贴，够用；
 *     · 文本 —— writeText 会同时写 CF_UNICODETEXT / CF_TEXT，够用；
 *     · 文件 —— 用 `CF_HDROP` 这个名字去 write() 时，Electron 只是用
 *       RegisterClipboardFormat("CF_HDROP") 注册了一个**自定义格式**（实测 id 0xc323），
 *       而资源管理器认的是系统标准 CF_HDROP（id 15），所以粘贴不出文件。
 *
 * 所以这里直接用 koffi 走 user32/kernel32：EmptyClipboard → GlobalAlloc →
 * 填 DROPFILES 结构体 → SetClipboardData(CF_HDROP)。数据交给系统托管，
 * 本进程退出后依然可粘贴（我们本来就是常驻托盘，更不存在这个问题）。
 *
 * 图片这条同理：Chromium 写剪贴板用的是**延迟渲染**，`write()` resolve 只代表
 * 「我认领了剪贴板」，真实字节要等粘贴方来要的时候才生成。中间任何一环不顺
 * （属主忙、属主被关掉、粘贴方等不及），表现就是「菜单点了没反应、粘不出来」。
 * readImageStatus() 用来当场把真实格式与体积读出来核对；writeImage() 则是
 * 完全不依赖 Chromium 的兜底写法。
 */

const koffi = require('koffi');

const CF_BITMAP = 2;
const CF_DIB = 8;
const CF_HDROP = 15;
const CF_DIBV5 = 17;
const GMEM_MOVEABLE = 0x0002;
const DROPFILES_SIZE = 20;

/** BITMAPV5HEADER 的固定长度（含 4 个颜色掩码与 4 字节 CS 类型） */
const BITMAPV5HEADER_SIZE = 124;
/** BI_BITFIELDS：像素排列由掩码描述，32bpp 下带 alpha 必须用它 */
const BI_BITFIELDS = 3;
/** LCS_sRGB —— 'sRGB' 的 DWORD 形式，声明颜色空间，免得某些程序按默认色域解释 */
const LCS_SRGB = 0x73524742;

/** 清空/写入前的重试：剪贴板同一时刻只能被一个进程打开，被占着就等一下再来 */
const CLIP_TRIES = 12;
const CLIP_WAIT_MS = 100;

let lib = null;
let loadError = null;

/**
 * 同步睡眠 —— 剪贴板这一层是同步 API，重试时用 async 会把调用方染成 async。
 * Node 里唯一可靠的同步等待就是 Atomics.wait（浏览器里主线程禁用，Node 没这个限制）。
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function load() {
  if (lib || loadError) return lib;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    lib = {
      OpenClipboard: user32.func('bool OpenClipboard(void *hWnd)'),
      EmptyClipboard: user32.func('bool EmptyClipboard()'),
      CloseClipboard: user32.func('bool CloseClipboard()'),
      SetClipboardData: user32.func('void *SetClipboardData(uint32 uFormat, void *hMem)'),
      GetClipboardData: user32.func('void *GetClipboardData(uint32 uFormat)'),
      EnumClipboardFormats: user32.func('uint32 EnumClipboardFormats(uint32 format)'),
      RegisterClipboardFormatW: user32.func('uint32 RegisterClipboardFormatW(str16 lpszFormat)'),
      GlobalAlloc: kernel32.func('void *GlobalAlloc(uint32 uFlags, size_t dwBytes)'),
      GlobalLock: kernel32.func('void *GlobalLock(void *hMem)'),
      GlobalUnlock: kernel32.func('bool GlobalUnlock(void *hMem)'),
      GlobalFree: kernel32.func('void *GlobalFree(void *hMem)'),
      GlobalSize: kernel32.func('size_t GlobalSize(void *hMem)'),
    };
  } catch (err) {
    loadError = err;
  }
  return lib;
}

function available() {
  return Boolean(load());
}

function diagnose() {
  return { ok: available(), error: loadError ? loadError.message : null };
}

/**
 * 组装 CF_HDROP 的载荷：DROPFILES 头 + 路径列表。
 * 结构体（20 字节，全小端）：
 *   DWORD pFiles = 20   —— 路径表相对结构体起点的偏移
 *   POINT pt     = 0,0  —— 拖放落点，粘贴场景无意义
 *   BOOL  fNC    = 0
 *   BOOL  fWide  = 1    —— 路径是宽字符（必须，否则中文路径会烂）
 * 路径表：每条以 \0 结尾，整表再额外补一个 \0 收尾。
 */
function buildDropFiles(filePaths) {
  const list = Buffer.from(`${filePaths.join('\0')}\0\0`, 'ucs2');

  const header = Buffer.alloc(DROPFILES_SIZE);
  header.writeUInt32LE(DROPFILES_SIZE, 0);
  header.writeInt32LE(0, 4);
  header.writeInt32LE(0, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(1, 16);

  return Buffer.concat([header, list]);
}

/**
 * 把若干文件放进剪贴板（资源管理器里可以 Ctrl+V 粘贴出副本）。
 * @param {string[]} filePaths
 * @returns {{ok:boolean, count?:number, error?:string}}
 */
function writeFiles(filePaths) {
  const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  if (paths.length === 0) return { ok: false, error: '没有文件' };

  const api = load();
  if (!api) return { ok: false, error: `剪贴板接口不可用：${loadError && loadError.message}` };

  const payload = buildDropFiles(paths);
  let hMem = null;

  if (!api.OpenClipboard(null)) {
    return { ok: false, error: '打不开剪贴板（可能被其它程序独占）' };
  }

  try {
    if (!api.EmptyClipboard()) {
      return { ok: false, error: '清空剪贴板失败' };
    }

    hMem = api.GlobalAlloc(GMEM_MOVEABLE, payload.length);
    if (!hMem) return { ok: false, error: '分配剪贴板内存失败' };

    const target = api.GlobalLock(hMem);
    if (!target) return { ok: false, error: '锁定剪贴板内存失败' };

    koffi.encode(target, 'uint8', payload, payload.length);
    api.GlobalUnlock(hMem);

    // SetClipboardData 成功即代表所有权移交系统，之后不能再自己 GlobalFree
    if (!api.SetClipboardData(CF_HDROP, hMem)) {
      return { ok: false, error: '写入 CF_HDROP 失败' };
    }
    hMem = null;

    return { ok: true, count: paths.length };
  } finally {
    if (hMem) api.GlobalFree(hMem);
    api.CloseClipboard();
  }
}

/* ------------------------------------------------------------------ 图片 */

/**
 * 剪贴板里现在有什么（只读，不改内容）。
 *
 * 为什么需要它：`clipboard.write()` 成功返回，只代表「Electron 认为写进去了」，
 * 和「系统剪贴板里真的有一张能粘贴的图」是两件事 —— 本项目已经为 CF_HDROP
 * 踩过一次完全同类的坑（见文件头）。所以复制类操作一律以这里回读的结果为准。
 *
 * 只对 CF_DIB / CF_DIBV5 取句柄：它们的内容是 HGLOBAL，能 GlobalSize 量体积。
 * **不要去读 CF_BITMAP** —— 那是 HBITMAP（GDI 对象），GlobalSize 传进去会直接崩。
 *
 * @returns {{ok:boolean, error?:string, formats:number[], dib:number, dibv5:number,
 *            hasImage:boolean, hasBitmap:boolean}}
 */
function readImageStatus() {
  const api = load();
  if (!api) return { ok: false, error: `剪贴板接口不可用：${loadError && loadError.message}`, formats: [], dib: 0, dibv5: 0, hasImage: false, hasBitmap: false };

  let opened = false;
  for (let i = 0; i < CLIP_TRIES && !opened; i += 1) {
    opened = api.OpenClipboard(null);
    if (!opened) sleepSync(CLIP_WAIT_MS);
  }
  if (!opened) return { ok: false, error: '打不开剪贴板（被别的程序占着）', formats: [], dib: 0, dibv5: 0, hasImage: false, hasBitmap: false };

  try {
    const formats = [];
    for (let id = api.EnumClipboardFormats(0); id !== 0; id = api.EnumClipboardFormats(id)) formats.push(id);

    const sizeOf = (fmt) => {
      const h = api.GetClipboardData(fmt);
      return h ? Number(api.GlobalSize(h)) : 0;
    };
    const dib = formats.includes(CF_DIB) ? sizeOf(CF_DIB) : 0;
    const dibv5 = formats.includes(CF_DIBV5) ? sizeOf(CF_DIBV5) : 0;

    return {
      ok: true,
      formats,
      dib,
      dibv5,
      hasBitmap: formats.includes(CF_BITMAP),
      hasImage: dib > 0 || dibv5 > 0,
    };
  } finally {
    api.CloseClipboard();
  }
}

/**
 * 组装 CF_DIBV5 载荷：BITMAPV5HEADER(124) + BGRA 像素。
 *
 * 负高度是「自上而下」的意思 —— `nativeImage.toBitmap()` 给的就是从第一行开始的行序，
 * 用负高度就省掉一次整体倒序（几千万像素的倒序在 JS 里要几百毫秒）。
 */
function buildDibV5(bgra, width, height) {
  const pixels = width * height * 4;
  const buf = Buffer.alloc(BITMAPV5HEADER_SIZE + pixels);

  buf.writeUInt32LE(BITMAPV5HEADER_SIZE, 0);
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(-height, 8);
  buf.writeUInt16LE(1, 12);              // planes
  buf.writeUInt16LE(32, 14);             // bit count
  buf.writeUInt32LE(BI_BITFIELDS, 16);   // compression
  buf.writeUInt32LE(pixels, 20);         // sizeImage
  buf.writeInt32LE(3780, 24);            // 96 DPI
  buf.writeInt32LE(3780, 28);
  buf.writeUInt32LE(0x00FF0000, 40);     // red mask
  buf.writeUInt32LE(0x0000FF00, 44);     // green mask
  buf.writeUInt32LE(0x000000FF, 48);     // blue mask
  buf.writeUInt32LE(0xFF000000, 52);     // alpha mask
  buf.writeUInt32LE(LCS_SRGB, 56);       // cstype

  bgra.copy(buf, BITMAPV5HEADER_SIZE, 0, pixels);
  return buf;
}

/** GlobalAlloc + 拷贝 + SetClipboardData；成功即所有权移交系统，失败要自己释放 */
function setClipboardBlob(api, format, payload) {
  const hMem = api.GlobalAlloc(GMEM_MOVEABLE, payload.length);
  if (!hMem) throw new Error(`分配剪贴板内存失败（${format}）`);

  const target = api.GlobalLock(hMem);
  if (!target) { api.GlobalFree(hMem); throw new Error(`锁定剪贴板内存失败（${format}）`); }

  koffi.encode(target, 'uint8', payload, payload.length);
  api.GlobalUnlock(hMem);

  if (!api.SetClipboardData(format, hMem)) {
    api.GlobalFree(hMem);
    throw new Error(`写入格式 ${format} 失败`);
  }
}

/**
 * 亲手把一张图放进剪贴板（CF_DIBV5 + 注册格式 PNG）。
 *
 * 这条路绕开了 Electron/Chromium 的剪贴板实现，全部由本进程用 Win32 直接写：
 *   · 数据是**立即**交出去的（SetClipboardData 带真实句柄），不依赖 Chromium 的
 *     延迟渲染 —— 延迟渲染下若属主进程忙或提前退出，粘贴方拿不到数据；
 *   · 失败了能拿到具体错误码，而不是一个既不 resolve 也不 reject 的 Promise。
 *
 * 代价：位图要自己拼、要在 JS 里持有一份整图字节（8K 图约 130 MB），
 * 所以它只当**兜底**用，正常路径仍然走 Electron 的 clipboard.write。
 *
 * @param {{bgra:Buffer, width:number, height:number, png?:Buffer}} args
 */
function writeImage({ bgra, width, height, png }) {
  const api = load();
  if (!api) return { ok: false, error: `剪贴板接口不可用：${loadError && loadError.message}` };
  if (!bgra || !width || !height) return { ok: false, error: '没有像素数据' };
  if (bgra.length < width * height * 4) {
    return { ok: false, error: `像素缓冲区太小：${bgra.length} < ${width * height * 4}` };
  }

  const dib = buildDibV5(bgra, width, height);

  let opened = false;
  for (let i = 0; i < CLIP_TRIES && !opened; i += 1) {
    opened = api.OpenClipboard(null);
    if (!opened) sleepSync(CLIP_WAIT_MS);
  }
  if (!opened) return { ok: false, error: '打不开剪贴板（被别的程序占着）' };

  const wrote = [];
  try {
    if (!api.EmptyClipboard()) return { ok: false, error: '清空剪贴板失败' };

    setClipboardBlob(api, CF_DIBV5, dib);
    wrote.push('CF_DIBV5');

    // 顺带写一份原图 PNG（注册格式，和 Chromium 用的名字一致）——
    // 认 PNG 的程序能拿到无损带 alpha 的原始字节，不依赖 DIB 的 alpha 语义。
    if (png && png.length) {
      try {
        const pngFormat = api.RegisterClipboardFormatW('PNG');
        if (pngFormat) { setClipboardBlob(api, pngFormat, png); wrote.push('PNG'); }
      } catch {
        // PNG 只是加分项，失败不影响位图可用
      }
    }
    return { ok: true, bytes: dib.length, formats: wrote };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    api.CloseClipboard();
  }
}

module.exports = {
  writeFiles,
  readImageStatus,
  writeImage,
  buildDibV5,
  available,
  diagnose,
  buildDropFiles,
  CF_HDROP,
  CF_DIB,
  CF_DIBV5,
  CF_BITMAP,
};
