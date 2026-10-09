'use strict';

/**
 * 桌面右键菜单集成（Windows 桌面背景菜单）。
 *
 * 目标：在桌面空白处右键时多出两项 ——
 *   「切换到下一张壁纸」   把「光标所在那块屏」正在轮播的图往后拨一张
 *   「删除当前显示器的壁纸」把那一张移入回收站
 * 两项都只作用于**光标所在的那块屏**，不动别的屏。
 *
 * 为什么不用 reg.exe：本机安全策略把 reg.exe 拉黑了（含通过别的 shell 间接调用）。
 * 这里直接用 koffi 调 advapi32 —— 全是 HKCU 下的键，不需要管理员权限。
 *
 * 注册表位置（经典桌面背景菜单）：
 *   HKCU\Software\Classes\DesktopBackground\Shell\<键名>
 *        (默认)         = 菜单文字
 *        Icon           = "<ico 文件>" 或 "<exe>,0"
 *        SortOrderIndex = REG_DWORD，值小的排前面
 *        \command
 *          (默认) = "<exe>" "<app 目录>" --xxx-at-cursor
 *
 * 只在 HKCU 下写：不动 HKLM，不用提权，卸载就是把整棵子树删掉。
 *
 * 注意（这一点必须在 UI 里说清楚）：Windows 11 把这类经典动词收进了二级菜单 ——
 * 桌面上要先点「显示更多选项」（或 Shift+F10）才看得到。
 * 这不是注册表写错，是 Win11 的既定行为，改不了（想进一级菜单得做 MSIX 打包的
 * IExplorerCommand，代价和收益不成比例）。
 *
 * 只用到三个 API，都避开 PHKEY：
 *   RegSetKeyValueW  —— 建键 + 写值一步到位（Vista+）
 *   RegGetValueW     —— 读值，不需要先 OpenKey
 *   RegDeleteTreeW   —— 递归删子树
 */

const path = require('node:path');
const fs = require('node:fs');

/** 所有菜单项都挂在这个子键下 */
const SHELL_ROOT = 'Software\\Classes\\DesktopBackground\\Shell';

/**
 * 菜单项清单。加一项就在这里加一条 —— main.js 按 key 分发、设置面板按 key 出开关。
 *
 * keyName 是注册表里的键名（不要带空格和中文，注册表编辑器里好认）。
 * ⚠️ 已经发布过的项不要改 keyName：改了等于把用户装过的那一项丢在原地变孤儿，
 *    新的又装一份，桌面上会出现两条同名菜单。
 *
 * sortOrder 写进 SortOrderIndex（REG_DWORD，小的在前）。Explorer 未必老实遵守，
 * 但不写就一定按键名字母序（Delete 会排在 Next 前面），写了至少是个明确意图。
 */
const ITEMS = [
  {
    key: 'next',
    keyName: 'WallpaperSwitcherDesktopNext',
    label: '切换到下一张壁纸',
    arg: '--next-wallpaper-at-cursor',
    sortOrder: 10,
  },
  {
    key: 'delete',
    keyName: 'WallpaperSwitcherDesktopDelete',
    label: '删除当前显示器的壁纸',
    arg: '--delete-wallpaper-at-cursor',
    sortOrder: 20,
  },
  {
    key: 'pause',
    keyName: 'WallpaperSwitcherDesktopPause',
    label: '暂停 / 继续壁纸',
    arg: '--toggle-pause-wallpaper',
    sortOrder: 15,
  },
];

/** 图标：开发态直接用仓库里的 .ico（比 electron.exe 的图标好看），打包态用 exe 自带 */
const ICON_REL = path.join('assets', 'icon.ico');

const HKEY_CURRENT_USER = 0x80000001;
const REG_SZ = 1;
const REG_DWORD = 4;
/** RegGetValueW 的 RRF_RT_REG_SZ：只接受 REG_SZ，省得自己判类型 */
const RRF_RT_REG_SZ = 0x00000002;
/** ERROR_FILE_NOT_FOUND：删一个本来就不存在的键时返回它，按成功处理 */
const ERROR_FILE_NOT_FOUND = 2;

let api = null;
let loadError = null;

/** 懒加载 advapi32（koffi 不在就降级成「不支持」，不抛异常炸掉调用方） */
function load() {
  if (api || loadError) return api;
  try {
    const koffi = require('koffi');
    const advapi = koffi.load('advapi32.dll');
    api = {
      koffi,
      RegSetKeyValueW: advapi.func(
        'int32 __stdcall RegSetKeyValueW(void *hKey, str16 lpSubKey, str16 lpValueName,'
        + ' uint32 dwType, void *lpData, uint32 cbData)',
      ),
      RegGetValueW: advapi.func(
        'int32 __stdcall RegGetValueW(void *hKey, str16 lpSubKey, str16 lpValueName,'
        + ' uint32 dwFlags, void *pdwType, void *pvData, _Inout_ uint32 *pcbData)',
      ),
      RegDeleteTreeW: advapi.func(
        'int32 __stdcall RegDeleteTreeW(void *hKey, str16 lpSubKey)',
      ),
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

function available() {
  return Boolean(load());
}

function unavailableReason() {
  if (available()) return null;
  return loadError ? loadError.message : 'koffi 不可用';
}

/**
 * 命令行：怎么把「点菜单」变成「App 收到一个开关」。
 *
 * 开发态跑的是 `electron.exe <项目目录>`，打包后 exe 自己就是应用 ——
 * 两种情况的参数拼法不一样，不区分的话打包版会点不动。
 */
function entryPaths(override) {
  if (override && override.exe) {
    return { exe: override.exe, appPath: override.appPath || null };
  }

  const root = path.join(__dirname, '..');
  try {
    // 在 Electron 主进程里：execPath 就是 electron.exe，appPath 是源码目录
    const { app } = require('electron');
    if (app && app.isPackaged !== undefined) {
      return { exe: process.execPath, appPath: app.isPackaged ? null : app.getAppPath() };
    }
  } catch {
    // 脱离 Electron 跑（CLI 工具）—— 走下面的开发态推算
  }
  return {
    exe: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    appPath: root,
  };
}

/**
 * userData 注入（2026-10-09）：
 * 单实例锁按 userData 分钥匙。隔离 userData 的实例（WP_USER_DATA 环境变量 /
 * 验货 VBS）在跑时，菜单命令若不带 userData，点菜单新起的进程用默认 userData
 * —— 拿到的是另一把锁，它自己成为一个完整实例（挂自己的舞台盖住运行中的
 * 实例，800ms 后把动作办在一个将死的进程上再退出），运行中的实例毫无感知。
 * 命令行带上 `--wp-user-data="<路径>"` 后，新进程先换 userData 再抢锁：
 * 拿不到锁 → second-instance 正常转发到运行中的实例。
 * 在 Electron 主进程里从 app.getPath('userData') 现取；CLI 直装（脱离
 * Electron，require('electron') 拿到的是字符串）必须显式传 override.userData。
 */
function userDataForCommand(override) {
  if (override && override.userData) return override.userData;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function' && app.isPackaged !== undefined) {
      return app.getPath('userData');
    }
  } catch { /* 脱离 Electron（CLI 直装）—— 没有 override.userData 就不加 */ }
  return null;
}

/** 拼 `"exe" "appPath" --flag --wp-user-data="…"`（含引号：路径都可能带空格） */
function commandLine(item, override) {
  const { exe, appPath } = entryPaths(override);
  const parts = [`"${exe}"`];
  if (appPath) parts.push(`"${appPath}"`);
  parts.push(item.arg);
  const ud = userDataForCommand(override);
  if (ud) parts.push(`--wp-user-data="${ud}"`);
  return parts.join(' ');
}

function iconSpec(item, override) {
  const { exe } = entryPaths(override);
  const ico = path.join(__dirname, '..', ICON_REL);
  if (!override && fs.existsSync(ico)) return `"${ico}"`;
  return `"${exe}",0`;
}

/** 取一项的注册表路径与定义；key 不存在直接抛，省得后面到处判空 */
function locate(key) {
  const item = ITEMS.find((x) => x.key === key);
  if (!item) throw new Error(`未知的桌面菜单项：${key}`);
  const keyPath = `${SHELL_ROOT}\\${item.keyName}`;
  return { item, keyPath, commandPath: `${keyPath}\\command` };
}

/** REG_SZ 的字节形式：UTF-16LE + 结尾的 NUL */
function szBuffer(text) {
  return Buffer.from(`${text}\0`, 'utf16le');
}

function writeValue(subKey, name, text) {
  const a = load();
  const buf = szBuffer(text);
  const rc = a.RegSetKeyValueW(
    HKEY_CURRENT_USER, subKey, name === null ? null : name, REG_SZ, buf, buf.length,
  );
  if (rc !== 0) throw new Error(`写注册表失败（${subKey}\\${name || '(默认)'}）错误码 0x${(rc >>> 0).toString(16)}`);
  return rc;
}

function writeDword(subKey, name, value) {
  const a = load();
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  const rc = a.RegSetKeyValueW(HKEY_CURRENT_USER, subKey, name, REG_DWORD, buf, buf.length);
  if (rc !== 0) throw new Error(`写注册表失败（${subKey}\\${name}）错误码 0x${(rc >>> 0).toString(16)}`);
  return rc;
}

function readValue(subKey, name, cap = 2048) {
  const a = load();
  const buf = Buffer.alloc(cap);
  const size = a.koffi.alloc('uint32', 1);
  a.koffi.encode(size, 'uint32', cap);
  const rc = a.RegGetValueW(HKEY_CURRENT_USER, subKey, name, RRF_RT_REG_SZ, null, buf, size);
  if (rc !== 0) return null;
  const bytes = a.koffi.decode(size, 'uint32');
  return buf.toString('utf16le', 0, Math.max(0, bytes - 2));
}

/**
 * 装上单独一项。返回 { ok, key, label, command } ——
 * command 回给 UI，好让用户看到「到底注册了什么」。
 */
function installItem(key, override) {
  const a = load();
  if (!a) return { ok: false, error: `注册表接口不可用：${unavailableReason()}` };

  const { item, keyPath, commandPath } = locate(key);
  const command = commandLine(item, override);
  try {
    writeValue(keyPath, null, item.label);
    writeValue(keyPath, 'Icon', iconSpec(item, override));
    writeValue(commandPath, null, command);
    // 排序是「锦上添花」：Explorer 不认也无所谓，认了就把「下一张」放到「删除」前面
    writeDword(keyPath, 'SortOrderIndex', item.sortOrder);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true, key: item.key, label: item.label, command, keyPath };
}

/** 卸掉单独一项：RegDeleteTreeW 会把 <键名> 和它下面的 command 一起删掉 */
function uninstallItem(key) {
  const a = load();
  if (!a) return { ok: false, error: `注册表接口不可用：${unavailableReason()}` };
  const { keyPath } = locate(key);
  const rc = a.RegDeleteTreeW(HKEY_CURRENT_USER, keyPath);
  if (rc !== 0 && rc !== ERROR_FILE_NOT_FOUND) {
    return { ok: false, error: `删除注册表项失败，错误码 0x${(rc >>> 0).toString(16)}` };
  }
  return { ok: true, key };
}

/** 装上全部项（首次开启开关时用这个，一次把菜单配齐） */
function installAll(override) {
  const a = load();
  if (!a) return { ok: false, error: `注册表接口不可用：${unavailableReason()}` };
  const done = [];
  for (const it of ITEMS) {
    const r = installItem(it.key, override);
    if (!r.ok) return { ...r, key: it.key, done };
    done.push(r);
  }
  return { ok: true, items: done.map((r) => ({ key: r.key, label: r.label, command: r.command })) };
}

function uninstallAll() {
  const a = load();
  if (!a) return { ok: false, error: `注册表接口不可用：${unavailableReason()}` };
  for (const it of ITEMS) {
    const r = uninstallItem(it.key);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/**
 * 单项现状。installed 只认「命令行和我们期望的一致」——
 * 用户手动改过、或换了安装目录，都算需要重装（而不是显示一个骗人的勾）。
 */
function itemStatus(key, override) {
  const { item, keyPath, commandPath } = locate(key);
  const expected = commandLine(item, override);
  const actual = readValue(commandPath, null);
  return {
    key: item.key,
    label: item.label,
    arg: item.arg,
    keyPath,
    installed: actual !== null && actual.trim() === expected.trim(),
    stale: actual !== null && actual.trim() !== expected.trim(),
    actual,
    expected,
  };
}

/**
 * 整体现状。installed / stale 取的是「任一项」——
 * 开关的语义是「桌面上有没有我们的菜单」，而不是「每一项都装齐了」，
 * 这样单项被手删掉时开关不会自己跳回关闭状态。
 */
function statusAll(override) {
  const a = load();
  if (!a) {
    return { ok: false, available: false, installed: false, stale: false, items: [], error: unavailableReason() };
  }
  const items = ITEMS.map((it) => itemStatus(it.key, override));
  return {
    ok: true,
    available: true,
    items,
    installed: items.some((x) => x.installed),
    stale: items.some((x) => x.stale),
  };
}

/** 从命令行参数里认出「是桌面菜单哪一项触发的」；不是菜单触发的就返回 null */
function itemFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  return ITEMS.find((it) => argv.includes(it.arg)) || null;
}

module.exports = {
  ITEMS,
  SHELL_ROOT,
  available,
  unavailableReason,
  installItem,
  uninstallItem,
  installAll,
  uninstallAll,
  itemStatus,
  statusAll,
  itemFromArgv,
  commandLine,
  entryPaths,
};
