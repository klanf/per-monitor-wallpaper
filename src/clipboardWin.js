'use strict';

/**
 * Win32 剪贴板直写 —— 只做一件 Electron 44 已经做不到的事：**把文件放进剪贴板**。
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
 */

const koffi = require('koffi');

const CF_HDROP = 15;
const GMEM_MOVEABLE = 0x0002;
const DROPFILES_SIZE = 20;

let lib = null;
let loadError = null;

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
      GlobalAlloc: kernel32.func('void *GlobalAlloc(uint32 uFlags, size_t dwBytes)'),
      GlobalLock: kernel32.func('void *GlobalLock(void *hMem)'),
      GlobalUnlock: kernel32.func('bool GlobalUnlock(void *hMem)'),
      GlobalFree: kernel32.func('void *GlobalFree(void *hMem)'),
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

module.exports = { writeFiles, available, diagnose, buildDropFiles, CF_HDROP };
