'use strict';

/**
 * 每显示器壁纸 —— IDesktopWallpaper COM 接口（Windows 8+）。
 *
 * 为什么必须走 COM：
 *   老 API SystemParametersInfoW(SPI_SETDESKWALLPAPER) 只有一个全局壁纸槽位，
 *   而 Windows 的「每个显示器不同壁纸」能力只通过 IDesktopWallpaper 暴露
 *   （对应设置面板里的"选择适合每台显示器的图片"）。
 *
 * koffi 没有 COM 封装，所以这里手工做 vtable 分发：
 *   接口指针 → 解引用拿到 vtable 地址 → 按槽位偏移取函数指针 → koffi.call 调用。
 *
 * IDesktopWallpaper vtable 布局（IUnknown 占 0–2）：
 *   0 QueryInterface        1 AddRef              2 Release
 *   3 SetWallpaper          4 GetWallpaper        5 GetMonitorDevicePathAt
 *   6 GetMonitorDevicePathCount                     7 GetMonitorRECT
 *   8 SetBackgroundColor    9 GetBackgroundColor
 *  10 SetPosition          11 GetPosition
 *
 * ⚠️ 索引错一位就会把「读」变成「写」（SetWallpaper 是第 3 槽），
 *    所以启动时先用 QueryInterface 校验 vtable 起点，不通过就整体禁用。
 */

const koffi = require('koffi');

const CLSID_DESKTOP_WALLPAPER = { d1: 0xC2CF3110, d2: 0x460E, d3: 0x4FC1, d4: [0xB9, 0xD0, 0x8A, 0x1C, 0x0C, 0x9C, 0xC4, 0xBD] };
const IID_IDESKTOP_WALLPAPER = { d1: 0xB92B56A9, d2: 0x8B55, d3: 0x4E14, d4: [0x9A, 0x89, 0x01, 0x99, 0xBB, 0xB6, 0xF9, 0x3B] };

/**
 * CLSCTX_ALL。
 * 实测：这台机器上 IDesktopWallpaper 是 LocalServer 注册，
 * 只用 CLSCTX_INPROC_SERVER(0x1) 会返回 0x80040154 REGDB_E_CLASSNOTREG。
 */
const CLSCTX_ALL = 0x17;
const COINIT_APARTMENTTHREADED = 0x2;
const RPC_E_CHANGED_MODE = 0x80010106;

const SLOT = {
  QUERY_INTERFACE: 0,
  RELEASE: 2,
  SET_WALLPAPER: 3,
  GET_WALLPAPER: 4,
  GET_DEVICE_PATH_AT: 5,
  GET_DEVICE_PATH_COUNT: 6,
  GET_MONITOR_RECT: 7,
};

/** HRESULT 常见值，用于把错误翻译成人话 */
const HRESULT_TEXT = {
  0x80004005: 'E_FAIL（接口不支持该操作）',
  0x80070002: 'ERROR_FILE_NOT_FOUND（图片路径无效或系统尚未初始化每屏壁纸）',
  0x80070005: 'E_ACCESSDENIED（权限不足）',
  0x80040154: 'REGDB_E_CLASSNOTREG（系统未注册该类）',
  0x80070057: 'E_INVALIDARG（参数无效）',
};

let Ty = null;          // 注册过的 struct / proto 类型缓存
let api = null;         // ole32 函数表
let com = null;         // { thisPtr, vtbl, call(slot, ...) }
let loadError = null;
let coInitialized = false;
let coUninitSafe = false;

const hex = (hr) => '0x' + (hr >>> 0).toString(16).toUpperCase().padStart(8, '0');

function describeHr(hr) {
  const key = hr >>> 0;
  return `${hex(key)}${HRESULT_TEXT[key] ? ' ' + HRESULT_TEXT[key] : ''}`;
}

function ensureTypes() {
  if (Ty) return;
  // 名字加前缀，避免与同进程其他模块注册的类型撞名（koffi 类型表是进程级的）
  const Guid = koffi.struct('WpDesktopWallpaperGuid', {
    d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]',
  });
  const Rect = koffi.struct('WpDesktopWallpaperRect', {
    left: 'int32', top: 'int32', right: 'int32', bottom: 'int32',
  });

  Ty = {
    Guid,
    Rect,
    P_QueryInterface: koffi.proto('int32 WpIdwQueryInterface(void *thiz, const WpDesktopWallpaperGuid *riid, void *out)'),
    P_Release: koffi.proto('uint32 WpIdwRelease(void *thiz)'),
    P_SetWallpaper: koffi.proto('int32 WpIdwSetWallpaper(void *thiz, char16_t *monitorId, char16_t *wallpaper)'),
    P_GetWallpaper: koffi.proto('int32 WpIdwGetWallpaper(void *thiz, char16_t *monitorId, void *out)'),
    P_GetDevicePathAt: koffi.proto('int32 WpIdwGetMonitorDevicePathAt(void *thiz, uint32 index, void *out)'),
    P_GetDevicePathCount: koffi.proto('int32 WpIdwGetMonitorDevicePathCount(void *thiz, uint32 *out)'),
    P_GetMonitorRect: koffi.proto('int32 WpIdwGetMonitorRECT(void *thiz, char16_t *monitorId, void *out)'),
  };
}

/** 把 JS 对象编码成 GUID 缓冲区（koffi 的结构体入参也可以直接传对象，这里显式编码更稳） */
function encodeGuid(obj) {
  const buf = koffi.alloc(Ty.Guid, 1);
  koffi.encode(buf, Ty.Guid, obj);
  return buf;
}

function load() {
  if (com || loadError) return;

  if (process.platform !== 'win32') {
    loadError = new Error('每屏壁纸仅支持 Windows 8 及以上');
    return;
  }

  try {
    ensureTypes();

    const ole32 = koffi.load('ole32.dll');
    const CoInitializeEx = ole32.func('int32 CoInitializeEx(void *reserved, uint32 flags)');
    const CoCreateInstance = ole32.func(
      'int32 CoCreateInstance(const WpDesktopWallpaperGuid *clsid, void *outer, uint32 ctx, const WpDesktopWallpaperGuid *iid, void **out)'
    );
    const CoTaskMemFree = ole32.func('void CoTaskMemFree(void *ptr)');

    const hrInit = CoInitializeEx(null, COINIT_APARTMENTTHREADED) >>> 0;
    if (hrInit === 0 || hrInit === 1) {
      coInitialized = true;
      coUninitSafe = true;
    } else if (hrInit === RPC_E_CHANGED_MODE) {
      // 主进程别处已把线程初始化成 MTA。LocalServer 对象走代理仍可调用，继续。
      coInitialized = true;
      coUninitSafe = false;
    } else {
      throw new Error(`CoInitializeEx 失败 ${describeHr(hrInit)}`);
    }

    const ppv = koffi.alloc('void *', 1);
    const hrCreate = CoCreateInstance(
      encodeGuid(CLSID_DESKTOP_WALLPAPER), null, CLSCTX_ALL,
      encodeGuid(IID_IDESKTOP_WALLPAPER), ppv
    ) >>> 0;
    if (hrCreate !== 0) throw new Error(`CoCreateInstance 失败 ${describeHr(hrCreate)}`);

    const thisPtr = koffi.decode(ppv, 'void *');
    const vtbl = koffi.decode(thisPtr, 'void *');
    if (typeof thisPtr !== 'bigint' || thisPtr === 0n) throw new Error('接口指针为空');

    const fnAt = (slot) => koffi.address(koffi.decode(vtbl, slot * 8, 'void *'));
    const call = (slot, proto, ...args) => koffi.call(fnAt(slot), proto, thisPtr, ...args) >>> 0;

    // ---- 安全校验：槽 0 必须是 QueryInterface，且用本接口 IID 查询应返回同一指针 ----
    const iidBuf = encodeGuid(IID_IDESKTOP_WALLPAPER);
    const ppQi = koffi.alloc('void *', 1);
    const hrQi = call(SLOT.QUERY_INTERFACE, Ty.P_QueryInterface, iidBuf, ppQi);
    const qiPtr = koffi.decode(ppQi, 'void *');
    if (hrQi !== 0 || qiPtr !== thisPtr) {
      throw new Error(
        `vtable 布局校验失败（QueryInterface hr=${describeHr(hrQi)}，返回指针${qiPtr === thisPtr ? '相同' : '不同'}）` +
        ' —— 为避免误调 SetWallpaper 破坏桌面壁纸，已禁用每屏壁纸功能'
      );
    }

    api = { CoTaskMemFree, fnAt };
    com = { thisPtr, vtbl, call, fnAt };
  } catch (err) {
    loadError = err;
    com = null;
  }
}

/** 读出 CoTaskMem 分配的 UTF-16 字符串并释放；空指针返回 null */
function takeString(address) {
  if (typeof address !== 'bigint' || address === 0n) return null;
  try {
    return koffi.decode(address, 'char16_t', -1) || null;
  } finally {
    api.CoTaskMemFree(address);
  }
}

function getWallpaper(monitorId) {
  load();
  if (!com) return null;
  const pp = koffi.alloc('void *', 1);
  const hr = com.call(SLOT.GET_WALLPAPER, Ty.P_GetWallpaper, monitorId || null, pp);
  if (hr !== 0) return null;
  return takeString(koffi.decode(pp, 'void *'));
}

function enumMonitors() {
  load();
  if (!com) return { ok: false, error: loadError ? loadError.message : 'COM 不可用', monitors: [] };

  const cntBuf = koffi.alloc('uint32', 1);
  const hrCount = com.call(SLOT.GET_DEVICE_PATH_COUNT, Ty.P_GetDevicePathCount, cntBuf);
  if (hrCount !== 0) return { ok: false, error: describeHr(hrCount), monitors: [] };

  const count = koffi.decode(cntBuf, 'uint32');
  const monitors = [];

  for (let i = 0; i < count; i += 1) {
    const ppPath = koffi.alloc('void *', 1);
    const hrPath = com.call(SLOT.GET_DEVICE_PATH_AT, Ty.P_GetDevicePathAt, i, ppPath);
    if (hrPath !== 0) continue;

    // takeString 内部已经把 CoTaskMem 指针释放掉了，
    // 后面统一用取回来的 JS 字符串（koffi 会重新编组），不要再碰那个裸指针。
    const devicePath = takeString(koffi.decode(ppPath, 'void *'));
    if (!devicePath) continue;

    const rectBuf = koffi.alloc(Ty.Rect, 1);
    let rect = null;
    if (com.call(SLOT.GET_MONITOR_RECT, Ty.P_GetMonitorRect, devicePath, rectBuf) === 0) {
      const rc = koffi.decode(rectBuf, Ty.Rect);
      rect = { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom };
    }

    const width = rect ? rect.right - rect.left : 0;
    const height = rect ? rect.bottom - rect.top : 0;
    // Windows 约定：主显示器的原点就是虚拟桌面原点 (0,0)
    const primary = Boolean(rect && rect.left === 0 && rect.top === 0);

    monitors.push({
      id: devicePath,
      index: i,
      x: rect ? rect.left : 0,
      y: rect ? rect.top : 0,
      width,
      height,
      primary,
      current: getWallpaper(devicePath),
      label: `${width}×${height}${primary ? '（主显示器）' : ''} @ ${rect ? rect.left : 0},${rect ? rect.top : 0}`,
    });
  }

  return { ok: true, monitors, count };
}

function setWallpaper(monitorId, imagePath) {
  load();
  if (!com) {
    return { ok: false, method: 'com-unavailable', error: loadError ? loadError.message : 'COM 不可用' };
  }
  const hr = com.call(SLOT.SET_WALLPAPER, Ty.P_SetWallpaper, monitorId || null, imagePath);
  if (hr !== 0) return { ok: false, method: 'com', error: describeHr(hr), hresult: hr };
  return {
    ok: true,
    method: monitorId ? 'com:per-monitor' : 'com:all',
    monitorId: monitorId || null,
  };
}

/**
 * 用 Win32 找出某个窗口所在的显示器，再把它的物理矩形匹配到本文档枚举出的显示器。
 *
 * 为什么不直接用 Electron 的 screen.getDisplayNearestPoint：
 *   Electron 的 bounds 是 DIP（按各自的缩放比例折算过），
 *   混 DPI 双屏下和这里的物理像素矩形对不上，会错配到另一台显示器。
 *   MonitorFromWindow + GetMonitorInfoW 拿到的 rcMonitor 是纯物理像素，能精确比对。
 */
const MONITOR_DEFAULTTONEAREST = 2;

let u32 = null;
let MonitorFromWindow = null;
let GetMonitorInfoW = null;
let MonInfo = null;
let monitorApiError = null;

function ensureMonitorApi() {
  if (MonitorFromWindow) return true;
  try {
    u32 = u32 || koffi.load('user32.dll');
    MonInfo = koffi.struct('WpDesktopWallpaperMonitorInfo', {
      cbSize: 'uint32',
      rcMonitor: 'WpDesktopWallpaperRect',
      rcWork: 'WpDesktopWallpaperRect',
      dwFlags: 'uint32',
    });
    // ⚠️ koffi.func(definition) 会把定义串里的函数名当成 DLL 导出符号去查，
    //    所以这里必须用真实导出名 —— 不能像 koffi.proto 那样自己起名字，
    //    否则会静默地查不到符号（异常还会被下面的 catch 吞掉）。
    MonitorFromWindow = u32.func('void *MonitorFromWindow(void *hwnd, uint32 flags)');
    GetMonitorInfoW = u32.func('bool GetMonitorInfoW(void *hmonitor, void *info)');
    return true;
  } catch (err) {
    monitorApiError = err.message;
    return false;
  }
}

/** 取窗口所在显示器的物理矩形；失败返回 null */
function windowMonitorRect(hwnd) {
  if (!ensureMonitorApi() || hwnd === null || hwnd === undefined) return null;
  try {
    const hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if (typeof hmon !== 'bigint' || hmon === 0n) {
      monitorApiError = 'MonitorFromWindow 返回空句柄';
      return null;
    }

    const info = koffi.alloc(MonInfo, 1);
    koffi.encode(info, MonInfo, { cbSize: koffi.sizeof(MonInfo) });
    if (!GetMonitorInfoW(hmon, info)) {
      monitorApiError = 'GetMonitorInfoW 返回 false';
      return null;
    }

    const rc = koffi.decode(info, MonInfo).rcMonitor;
    return { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom };
  } catch (err) {
    monitorApiError = err.message;
    return null;
  }
}

/** 按物理矩形在枚举结果里找对应显示器 ID */
function monitorIdForRect(rect) {
  if (!rect) return null;
  const { monitors, ok } = enumMonitors();
  if (!ok) return null;
  const hit = monitors.find((m) => m.x === rect.left && m.y === rect.top
    && m.width === rect.right - rect.left && m.height === rect.bottom - rect.top);
  return hit ? hit.id : null;
}

/** 窗口所在显示器 → IDesktopWallpaper 的设备路径；失败返回 null（调用方应回退到"全部"） */
function monitorIdForWindow(hwnd) {
  return monitorIdForRect(windowMonitorRect(hwnd));
}

/** 主显示器（虚拟桌面原点所在的那台）的设备路径 */
function primaryMonitorId() {
  const { monitors, ok } = enumMonitors();
  if (!ok || monitors.length === 0) return null;
  return (monitors.find((m) => m.primary) || monitors[0]).id;
}

function available() {
  load();
  return Boolean(com);
}

function backendName() {
  load();
  if (com) return 'com:IDesktopWallpaper';
  return loadError ? `unavailable — ${loadError.message}` : 'unavailable';
}

/** 进程退出时释放接口 + 反初始化 COM */
function release() {
  if (!com) return;
  try {
    com.call(SLOT.RELEASE, Ty.P_Release);
  } catch { /* 释放失败不影响退出 */ }
  com = null;
  if (coInitialized && coUninitSafe) {
    try {
      koffi.load('ole32.dll').func('void CoUninitialize(void)')();
    } catch { /* ignore */ }
  }
  coInitialized = false;
}

module.exports = {
  available,
  backendName,
  enumMonitors,
  getWallpaper,
  setWallpaper,
  release,
  describeHr,
  monitorIdForWindow,
  monitorIdForRect,
  primaryMonitorId,
  windowMonitorRect,
  // 供测试脚本使用的内部诊断
  diagnose: () => {
    load();
    return {
      available: Boolean(com),
      error: loadError ? loadError.message : null,
      coInitialized,
      monitorApiError,
    };
  },
};
