'use strict';

/**
 * 从 Windows 侧独立读取剪贴板的真实格式与内容（测试用）。
 *
 * 存在的意义：`window.wp.copyImage()` 这类 IPC 只要不抛异常就会返回 ok:true，
 * 但「Electron 自己觉得写成功了」和「系统剪贴板里真有可供粘贴的数据」是两件事
 * —— 本轮就真踩到了这个坑：Electron 44 用 `CF_HDROP` 这个名字写出来的其实是
 * 一个同名自定义格式（id 0xc323），系统标准 CF_HDROP（id 15）里什么都没有。
 * 所以复制类操作必须由这里回读复核。
 *
 * 另外提供 snapshot / restore：验证脚本为了验「复制图像」，必须把测试图写进**真剪贴板**，
 * 不收尾的话用户下次粘贴拿到的就是夹具 —— 2026-09-24 就是这么暴露的
 * （用户粘出来一张 1280×720 红渐变色带图，正是 fixtures/gallery/g-001-h0.png）。
 * 所以凡是要写真剪贴板的脚本，开跑前拍快照、结束时还原。
 *
 * 还原范围是「背后是 HGLOBAL 的格式」。CF_BITMAP / CF_METAFILEPICT / CF_ENHMETAFILE
 * 这些是 GDI 句柄，读不出字节，只能记进 skipped；好在图片内容不受影响 ——
 * 只要 CF_DIBV5 还原回去，系统会自动合成出 CF_DIB 和 CF_BITMAP。
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
      EmptyClipboard: user32.func('bool EmptyClipboard()'),
      EnumClipboardFormats: user32.func('uint32 EnumClipboardFormats(uint32 format)'),
      GetClipboardFormatNameW: user32.func('int GetClipboardFormatNameW(uint32 format, _Out_ uint16 *name, int cch)'),
      GetClipboardData: user32.func('void *GetClipboardData(uint32 uFormat)'),
      SetClipboardData: user32.func('void *SetClipboardData(uint32 uFormat, void *hMem)'),
      RegisterClipboardFormatW: user32.func('uint32 RegisterClipboardFormatW(str16 lpszFormat)'),
      DragQueryFileW: shell32.func('uint32 DragQueryFileW(void *hDrop, uint32 iFile, _Out_ uint16 *buf, uint32 cch)'),
      GlobalAlloc: kernel32.func('void *GlobalAlloc(uint32 uFlags, size_t dwBytes)'),
      GlobalFree: kernel32.func('void *GlobalFree(void *hMem)'),
      GlobalLock: kernel32.func('void *GlobalLock(void *hMem)'),
      GlobalUnlock: kernel32.func('bool GlobalUnlock(void *hMem)'),
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

/* ---------------------------------------------- 快照 / 还原（给写真剪贴板的测试用） */

const GMEM_MOVEABLE = 0x0002;

/**
 * 背后是 GDI 句柄或由属主程序绘制的格式：GlobalLock 读不出字节（CF_BITMAP 上强读会崩），
 * 快照只能跳过。它们不影响「图片能不能粘回来」—— 有 CF_DIBV5 就够了。
 */
function snapshotable(id) {
  if (!id) return false;
  if (id === 2 || id === 3 || id === 9 || id === 14) return false; // CF_BITMAP / METAFILEPICT / PALETTE / ENHMETAFILE
  if (id >= 0x0080 && id <= 0x00ff) return false; // CF_OWNERDISPLAY / CF_DSP*
  if (id >= 0x0200 && id <= 0x03ff) return false; // CF_PRIVATEFIRST .. CF_GDIOBJLAST
  return true;
}

/**
 * 给当前剪贴板拍快照。
 * @returns {{ok:boolean, error?:string, entries:{id:number,name:string,registered:boolean,bytes:Buffer}[],
 *            skipped:{id:number,name:string,why:string}[], total:number}}
 */
function snapshot() {
  const a = load();
  if (!a) return { ok: false, error: `剪贴板读取不可用：${loadError && loadError.message}`, entries: [], skipped: [], total: 0 };
  if (!a.OpenClipboard(null)) return { ok: false, error: '打不开剪贴板（被别的程序占着）', entries: [], skipped: [], total: 0 };

  const entries = [];
  const skipped = [];
  try {
    for (let id = a.EnumClipboardFormats(0); id !== 0; id = a.EnumClipboardFormats(id)) {
      const name = nameOf(id);
      if (!snapshotable(id)) {
        skipped.push({ id, name, why: 'GDI 句柄 / 所有者绘制格式，读不出字节' });
        continue;
      }
      const handle = a.GetClipboardData(id);
      if (!handle) { skipped.push({ id, name, why: '句柄为空' }); continue; }
      const size = Number(a.GlobalSize(handle));
      if (!size) { skipped.push({ id, name, why: '体积为 0' }); continue; }
      const p = a.GlobalLock(handle);
      if (!p) { skipped.push({ id, name, why: 'GlobalLock 失败' }); continue; }
      try {
        entries.push({
          id,
          name,
          registered: id >= 0xc000 && !name.startsWith('注册格式 #'),
          bytes: Buffer.from(koffi.decode(p, koffi.array('uint8', size))),
        });
      } finally {
        a.GlobalUnlock(handle);
      }
    }
  } finally {
    a.CloseClipboard();
  }
  return { ok: true, entries, skipped, total: entries.reduce((n, e) => n + e.bytes.length, 0) };
}

/** 快照的单行摘要，给日志用 */
function describeSnapshot(snap) {
  if (!snap || !snap.ok) return `快照不可用（${(snap && snap.error) || '未知'}）`;
  if (!snap.entries.length) return '原来剪贴板是空的（还原时就清空）';
  const list = snap.entries.map((e) => `${e.name}(${e.bytes.length}B)`).join(' + ');
  return `${snap.entries.length} 个格式 / ${snap.total} 字节：${list}`;
}

/**
 * 还原一份快照。
 * @returns {{ok:boolean, error?:string, restored:string[], failed:{name:string,why:string}[], skipped:object[]}}
 */
function restore(snap) {
  const a = load();
  if (!a) return { ok: false, error: `剪贴板接口不可用：${loadError && loadError.message}`, restored: [], failed: [] };
  if (!snap || !snap.ok) return { ok: false, error: `没有可用的快照：${(snap && snap.error) || '空'}`, restored: [], failed: [] };
  if (!a.OpenClipboard(null)) return { ok: false, error: '打不开剪贴板（被别的程序占着）', restored: [], failed: [] };

  const restored = [];
  const failed = [];
  try {
    if (!a.EmptyClipboard()) return { ok: false, error: '清空剪贴板失败', restored, failed };

    // 标准格式先放（系统要靠 CF_DIBV5 合成 CF_DIB / CF_BITMAP），注册格式排后面
    const sorted = [...snap.entries].sort(
      (x, y) => Number(x.registered) - Number(y.registered) || x.id - y.id,
    );

    for (const e of sorted) {
      let format = e.id;
      if (e.registered) {
        format = a.RegisterClipboardFormatW(e.name);
        if (!format) { failed.push({ name: e.name, why: '重新注册格式名失败' }); continue; }
      }
      const hMem = a.GlobalAlloc(GMEM_MOVEABLE, e.bytes.length);
      if (!hMem) { failed.push({ name: e.name, why: 'GlobalAlloc 失败' }); continue; }
      const target = a.GlobalLock(hMem);
      if (!target) { a.GlobalFree(hMem); failed.push({ name: e.name, why: 'GlobalLock 失败' }); continue; }
      koffi.encode(target, 'uint8', e.bytes, e.bytes.length);
      a.GlobalUnlock(hMem);
      if (!a.SetClipboardData(format, hMem)) {
        a.GlobalFree(hMem); // 移交失败时所有权还在自己手上，必须自己释放
        failed.push({ name: e.name, why: 'SetClipboardData 失败' });
        continue;
      }
      restored.push(`${e.name}(${e.bytes.length}B)`);
    }
  } catch (err) {
    return { ok: false, error: err.message, restored, failed };
  } finally {
    a.CloseClipboard();
  }
  return { ok: failed.length === 0, restored, failed, skipped: snap.skipped || [] };
}

/**
 * 往剪贴板里**追加**一段 Unicode 文本，不清空既有内容。
 * 只给测试拼夹具用：真实的 Electron `clipboard.writeText()` 会先 EmptyClipboard，
 * 想把「文字 + 图片」同时放进剪贴板就得像这样自己挂格式。
 * @returns {boolean} 成功与否
 */
function setUnicodeText(text) {
  const a = load();
  if (!a) return false;
  if (!a.OpenClipboard(null)) return false;
  try {
    const bytes = Buffer.from(`${text}\0`, 'ucs2');
    const hMem = a.GlobalAlloc(GMEM_MOVEABLE, bytes.length);
    if (!hMem) return false;
    const target = a.GlobalLock(hMem);
    if (!target) { a.GlobalFree(hMem); return false; }
    koffi.encode(target, 'uint8', bytes, bytes.length);
    a.GlobalUnlock(hMem);
    if (!a.SetClipboardData(CF_UNICODETEXT, hMem)) { a.GlobalFree(hMem); return false; }
    return true;
  } finally {
    a.CloseClipboard();
  }
}

module.exports = {
  inspect,
  snapshot,
  restore,
  describeSnapshot,
  setUnicodeText,
  CF_DIB,
  CF_DIBV5,
  CF_UNICODETEXT,
  CF_HDROP,
};
