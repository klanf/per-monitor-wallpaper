'use strict';

/**
 * 从 Windows 侧独立读取剪贴板的真实格式与内容（测试用）。
 *
 * 存在的意义：`window.wp.copyImage()` 这类 IPC 只要不抛异常就会返回 ok:true，
 * 但「Electron 自己觉得写成功了」和「系统剪贴板里真有可供粘贴的数据」是两件事
 * —— 本轮就真踩到了这个坑：Electron 44 用 `CF_HDROP` 这个名字写出来的其实是
 * 一个同名自定义格式（id 0xc323），系统标准 CF_HDROP（id 15）里什么都没有。
 * 所以复制类操作必须由这里回读复核。
 */

const koffi = require('koffi');

const CF_DIB = 8;
const CF_UNICODETEXT = 13;
const CF_HDROP = 15;
const CF_DIBV5 = 17;

const STANDARD = {
  1: 'CF_TEXT',
  2: 'CF_BITMAP',
  3: 'CF_METAFILEPICT',
  8: 'CF_DIB',
  13: 'CF_UNICODETEXT',
  14: 'CF_ENHMETAFILE',
  15: 'CF_HDROP',
  16: 'CF_LOCALE',
  17: 'CF_DIBV5',
};

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  try {
    const user32 = koffi.load('user32.dll');
    const shell32 = koffi.load('shell32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    api = {
      OpenClipboard: user32.func('bool OpenClipboard(void *hWnd)'),
      CloseClipboard: user32.func('bool CloseClipboard()'),
      EnumClipboardFormats: user32.func('uint32 EnumClipboardFormats(uint32 format)'),
      GetClipboardFormatNameW: user32.func('int GetClipboardFormatNameW(uint32 format, _Out_ uint16 *name, int cch)'),
      GetClipboardData: user32.func('void *GetClipboardData(uint32 uFormat)'),
      DragQueryFileW: shell32.func('uint32 DragQueryFileW(void *hDrop, uint32 iFile, _Out_ uint16 *buf, uint32 cch)'),
      GlobalSize: kernel32.func('size_t GlobalSize(void *hMem)'),
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

/** 某个格式的载荷体积；取不到就 0（调用方必须已经 OpenClipboard） */
function globalSize(format) {
  const handle = api.GetClipboardData(format);
  return handle ? Number(api.GlobalSize(handle)) : 0;
}

function nameOf(id) {
  if (STANDARD[id]) return STANDARD[id];
  if (id < 0xc000) return `标准格式 #${id}`;
  const buf = Buffer.alloc(512 * 2);
  const n = api.GetClipboardFormatNameW(id, koffi.as(buf, 'uint16 *'), 512);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : `注册格式 #${id}`;
}

function dropFiles() {
  const handle = api.GetClipboardData(CF_HDROP);
  if (!handle) return null;
  const count = api.DragQueryFileW(handle, 0xffffffff, null, 0);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const len = api.DragQueryFileW(handle, i, null, 0);
    const buf = Buffer.alloc((len + 1) * 2);
    api.DragQueryFileW(handle, i, koffi.as(buf, 'uint16 *'), len + 1);
    out.push(buf.toString('utf16le', 0, len * 2));
  }
  return out;
}

/**
 * @returns {{ok:boolean, error?:string, formats:number[], names:string[],
 *            ids:{dib:number|null, dibv5:number|null, unicodeText:number|null, hdrop:number|null},
 *            sizes:{dib:number, dibv5:number},
 *            files:string[]|null}}
 */
function inspect() {
  const a = load();
  if (!a) return { ok: false, error: `剪贴板读取不可用：${loadError && loadError.message}`, formats: [], names: [] };

  if (!a.OpenClipboard(null)) {
    return { ok: false, error: '打不开剪贴板（可能被其它程序独占）', formats: [], names: [] };
  }

  try {
    const formats = [];
    for (let id = a.EnumClipboardFormats(0); id !== 0; id = a.EnumClipboardFormats(id)) {
      formats.push(id);
    }
    const has = (id) => formats.includes(id);
    return {
      ok: true,
      formats,
      names: formats.map(nameOf),
      ids: {
        dib: has(CF_DIB) ? CF_DIB : null,
        dibv5: has(CF_DIBV5) ? CF_DIBV5 : null,
        unicodeText: has(CF_UNICODETEXT) ? CF_UNICODETEXT : null,
        hdrop: has(CF_HDROP) ? CF_HDROP : null,
      },
      /**
       * 体积（字节）。「格式在不在」和「里面真的有没有一张完整的图」是两件事 ——
       * 位图载荷 = 头 + 宽×高×4，量一下就能分辨「空壳格式」和「真图」。
       * 只对 DIB 系格式取样：它们背后是 HGLOBAL。CF_BITMAP 是 GDI 对象，不能 GlobalSize。
       */
      sizes: {
        dib: has(CF_DIB) ? globalSize(CF_DIB) : 0,
        dibv5: has(CF_DIBV5) ? globalSize(CF_DIBV5) : 0,
      },
      files: has(CF_HDROP) ? dropFiles() : null,
    };
  } finally {
    a.CloseClipboard();
  }
}

module.exports = { inspect, CF_DIB, CF_DIBV5, CF_UNICODETEXT, CF_HDROP };
