'use strict';

/**
 * Win32 壁纸接口。
 *
 * 对照原 Python 版：
 *   ctypes.windll.user32.SystemParametersInfoW(...)   →   koffi + user32.dll
 *
 * 关键差异：Electron 主进程本身是 Node 运行时，没有 ctypes。
 * 这里用 koffi（FFI，带预编译二进制，无需 node-gyp）直接调用 user32.dll。
 * koffi 不可用时降级到 PowerShell 的 Add-Type 方案。
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const desktopWallpaper = require('./desktopWallpaper');

const execFileAsync = promisify(execFile);

const SPI_SETDESKWALLPAPER = 0x0014;
const SPI_GETDESKWALLPAPER = 0x0073;
const SPIF_UPDATEINIFILE = 0x0001;
const SPIF_SENDWININICHANGE = 0x0002;

/** Windows 内核壁纸加载器能直接吃的扩展名，其余需要转码 */
const NATIVE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp']);

/**
 * 内核不吃、但 Windows 自己有可能读出来的格式（GIF/TIFF 这类）。
 *
 * 转码失败时只对这些格式「交给系统碰运气」；webp / avif 这类系统根本不认识的格式
 * 继续把原路径递上去只会得到一次**假成功**：SPI 返回成功、桌面却黑一下或纹丝不动，
 * 而且没有任何错误提示 —— 用户看到的就是「这张壁纸加载不出来」。这种情况必须报错，
 * 让调度器把这张图本轮跳过（见 scheduler 的失效处理）。
 */
const SYSTEM_MAYBE_EXT = new Set(['.gif', '.jfif', '.tif', '.tiff']);

/** koffi 对调用约定的兼容写法，逐个尝试直到某个原型注册成功 */
const PROTO_STR = [
  'bool __stdcall SystemParametersInfoW(uint uiAction, uint uiParam, str16 pvParam, uint fWinIni)',
  'bool SystemParametersInfoW(uint uiAction, uint uiParam, str16 pvParam, uint fWinIni)',
];
const PROTO_BUF = [
  'bool __stdcall SystemParametersInfoW(uint uiAction, uint uiParam, void *pvParam, uint fWinIni)',
  'bool SystemParametersInfoW(uint uiAction, uint uiParam, void *pvParam, uint fWinIni)',
];

let koffi = null;
let spiSet = null;
let spiGet = null;
let getCursorPosFn = null;
let loadError = null;

function load() {
  if (spiSet || loadError) return;
  if (process.platform !== 'win32') {
    loadError = new Error('仅支持 Windows');
    return;
  }
  try {
    koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    for (const proto of PROTO_STR) {
      try { spiSet = user32.func(proto); break; } catch { /* 换下一个原型 */ }
    }
    for (const proto of PROTO_BUF) {
      try { spiGet = user32.func(proto); break; } catch { /* 换下一个原型 */ }
    }
    if (!spiSet) throw new Error('SystemParametersInfoW 原型注册失败');
  } catch (err) {
    loadError = err;
    spiSet = null;
    spiGet = null;
  }
}

/**
 * 读光标位置（物理像素）。
 *
 * 桌面右键菜单那条命令是靠「光标在哪块屏」判断该删哪台显示器的壁纸的。
 * 特意不用 Electron 的 `screen.getCursorScreenPoint()`：那套是 DIP 坐标，
 * 混屏不同缩放时会和 IDesktopWallpaper 的物理矩形对不上（`monitorIdForRect`
 * 吃的就是物理像素），一混用就会删错屏。
 */
function cursorPoint() {
  load();
  if (loadError) return null;
  try {
    // GetCursorPos 和结构体只注册一次（koffi 重复注册同名 struct 会抛）
    if (!getCursorPosFn) {
      const user32 = koffi.load('user32.dll');
      koffi.struct('WpCursorPoint', { x: 'int32', y: 'int32' });
      getCursorPosFn = user32.func('bool __stdcall GetCursorPos(_Out_ WpCursorPoint *pt)');
    }
    const buf = koffi.alloc('WpCursorPoint', 1);
    if (!getCursorPosFn(buf)) return null;
    const pt = koffi.decode(buf, 'WpCursorPoint');
    return { x: pt.x, y: pt.y };
  } catch {
    return null;
  }
}

/**
 * 把非原生格式（webp / avif / gif …）转成 PNG 落盘。
 * 原 Python 版靠 Pillow 做这件事，这里用 Electron 自带的 nativeImage，
 * 省掉一个图像库依赖。
 */
function ensureNativeFormat(imagePath, cacheDir) {
  const ext = path.extname(imagePath).toLowerCase();
  if (NATIVE_EXT.has(ext)) return imagePath;

  const { nativeImage } = require('electron');
  const img = nativeImage.createFromPath(imagePath);
  if (img.isEmpty()) {
    // 解不出来：GIF/TIFF 还值得让系统自己试试；webp/avif 这类递上去必然是假的成功
    if (SYSTEM_MAYBE_EXT.has(ext)) return imagePath;
    throw new Error(`无法解码图片（可能损坏或还没同步完成）：${path.basename(imagePath)}`);
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `wp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  fs.writeFileSync(out, img.toPNG());
  return out;
}

function pruneCache(cacheDir, keep = 8) {
  try {
    const files = fs.readdirSync(cacheDir)
      .filter((f) => f.startsWith('wp-'))
      .map((f) => ({ f, t: fs.statSync(path.join(cacheDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.unlinkSync(path.join(cacheDir, f));
  } catch { /* 缓存清理失败不影响主流程 */ }
}

/** PowerShell 兜底：Add-Type 编译一段 P/Invoke 后调用 */
async function setViaPowershell(imagePath) {
  const escaped = imagePath.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
if (-not ('WpNative' -as [type])) {
  Add-Type -Namespace WpNative -Name Spi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)]
public static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, string pvParam, uint fWinIni);
'@
}
$ok = [WpNative.Spi]::SystemParametersInfoW(0x0014, 0, '${escaped}', 0x0001 -bor 0x0002)
if (-not $ok) { throw "SystemParametersInfoW failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
`;
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true, timeout: 15000 });
    return { ok: true, method: 'powershell' };
  } catch (err) {
    return { ok: false, method: 'powershell', error: err.message };
  }
}

/**
 * 设置系统壁纸。
 *
 * 两条通道：
 *   1. IDesktopWallpaper（COM）—— 支持「只写某一台显示器」，且不会重置其他屏幕；
 *   2. SystemParametersInfoW —— 只有全局单槽位，一旦调用就会把每屏设置抹平成同一张图。
 * 所以只要能拿到 COM 就走通道 1；通道 2 仅在 COM 不可用时兜底，且只用于「全部显示器」。
 *
 * @param {string} imagePath
 * @param {string} cacheDir
 * @param {{monitorId?: string|null}} [options] monitorId 为空表示全部显示器
 * @returns {Promise<{ok:boolean, method:string, target?:string, error?:string}>}
 */
async function setWallpaper(imagePath, cacheDir, options = {}) {
  load();
  if (!fs.existsSync(imagePath)) {
    return { ok: false, method: 'none', error: `文件不存在: ${imagePath}` };
  }

  let target = imagePath;
  try {
    target = ensureNativeFormat(imagePath, cacheDir);
    pruneCache(cacheDir);
  } catch (err) {
    return { ok: false, method: 'transcode', error: err.message };
  }

  const monitorId = options.monitorId || null;

  // 通道 1：每屏接口
  if (desktopWallpaper.available()) {
    const result = desktopWallpaper.setWallpaper(monitorId, target);
    if (result.ok) return { ...result, target };
    // 指定了单屏就不要再退回全局通道 —— 那会把所有屏幕都改掉，与用户意图相反
    if (monitorId) return { ...result, target };
  } else if (monitorId) {
    return {
      ok: false,
      method: 'com-unavailable',
      target,
      error: `无法写入指定显示器：每屏壁纸接口不可用（${desktopWallpaper.diagnose().error || '未知原因'}）`,
    };
  }

  // 通道 2：全局兜底
  if (spiSet) {
    try {
      const flags = SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE;
      const ok = spiSet(SPI_SETDESKWALLPAPER, 0, target, flags);
      if (ok) return { ok: true, method: 'koffi', target };
    } catch (err) {
      loadError = err;
    }
  }

  const ps = await setViaPowershell(target);
  return { ...ps, target };
}

/** 读取当前系统壁纸路径（用于 HUD 校验） */
function getCurrentWallpaper() {
  load();
  if (!spiGet || !koffi) return null;
  try {
    // koffi 3.x 的 out() 签名有变，这里用 alloc + decode 的老写法，跨版本更稳。
    // MAX_PATH = 260 个 wchar。
    const buf = koffi.alloc('char16_t', 260);
    const ok = spiGet(SPI_GETDESKWALLPAPER, 260, buf, 0);
    if (!ok) return null;
    return koffi.decode(buf, 'char16_t', -1) || null;   // -1 = 读到 NUL 结束
  } catch {
    return null;
  }
}

function backendName() {
  load();
  if (desktopWallpaper.available()) return 'com:IDesktopWallpaper';
  if (spiSet) return 'koffi → user32（仅全局壁纸）';
  if (loadError) return `fallback(powershell) — 加载失败: ${loadError.message}`;
  return 'unavailable';
}

module.exports = {
  setWallpaper,
  getCurrentWallpaper,
  backendName,
  ensureNativeFormat,
  cursorPoint,
  NATIVE_EXT,
  SPI_SETDESKWALLPAPER,
  SPIF_UPDATEINIFILE,
  SPIF_SENDWININICHANGE,
  desktopWallpaper,
};
