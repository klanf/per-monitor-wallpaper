'use strict';

/**
 * 驱动 Windows 原生模态对话框（测试用）。
 *
 * 为什么需要：`dialog.showMessageBox` 是原生窗口 —— CDP 点不到，
 * PowerShell 的 COM / SendKeys 又被安全策略禁。于是「带确认的删除」这类功能
 * 一直只能验证「入口接线」，没法端到端跑。这里用 koffi 直接调 user32。
 *
 * 两个必须守住的点（都是踩过的）：
 *
 * ① **必须按进程号锁定自己的对话框。**
 *    `FindWindowW('#32770', null)` 返回的是**全系统第一个**该类的窗口 ——
 *    实测抓到的是别的软件（Geek Uninstaller）的窗口，然后按键就发到人家那儿去了。
 *    正确做法：先按窗口标题找到自己的主窗口 → 拿它的 pid → 只认 pid 相同的 #32770。
 *
 * ② **发键前必须确认对话框就是前台窗口。**
 *    按键是发给前台窗口的；发错地方会漏进应用窗口（空格=暂停、方向键=切图），
 *    后果比测试失败严重。拿不到前台确认就直接返回 false，让调用方跳过断言。
 *
 * 遍历窗口用 `FindWindowExW(桌面, 上一个, null, null)` 逐个取桌面的子窗口
 * （也就是所有顶层窗口），比 EnumWindows 省掉给 koffi 传回调。
 * 注意别用 `GetWindow(hwnd, GW_HWNDFIRST)` —— 那个常量是「同级里的第一个」，
 * 桌面窗口没有同级，所以永远返回 0，看起来像"系统里没有窗口"。
 */

const koffi = require('koffi');

const VK = { RETURN: 0x0d, ESCAPE: 0x1b, LEFT: 0x25, RIGHT: 0x27, UP: 0x26, DOWN: 0x28, TAB: 0x09, SPACE: 0x20 };
const KEYEVENTF_KEYUP = 0x0002;

/** 任务对话框 / MessageBox 的标准窗口类名 */
const DIALOG_CLASS = '#32770';
/** 应用主窗口标题（见 renderer/index.html 的 <title>） */
const APP_WINDOW_TITLE = '壁纸切换器 · Electron';

const MAX_WINDOWS = 4000;

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  try {
    const user32 = koffi.load('user32.dll');
    api = {
      GetDesktopWindow: user32.func('void *GetDesktopWindow()'),
      FindWindowExW: user32.func('void *FindWindowExW(void *parent, void *after, str16 cls, str16 title)'),
      FindWindowW: user32.func('void *FindWindowW(str16 lpClassName, str16 lpWindowName)'),
      IsWindowVisible: user32.func('bool IsWindowVisible(void *hWnd)'),
      SetForegroundWindow: user32.func('bool SetForegroundWindow(void *hWnd)'),
      GetForegroundWindow: user32.func('void *GetForegroundWindow()'),
      GetWindowTextW: user32.func('int GetWindowTextW(void *hWnd, _Out_ uint16 *buf, int cch)'),
      GetClassNameW: user32.func('int GetClassNameW(void *hWnd, _Out_ uint16 *buf, int cch)'),
      GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *pid)'),
      keybd_event: user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, void *dwExtraInfo)'),
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

function available() {
  return Boolean(load());
}

function diagnose() {
  return { ok: available(), error: loadError ? loadError.message : null };
}

/** koffi 的指针不能直接 === 比较，统一转成数值地址 */
function addr(ptr) {
  if (!ptr) return 0;
  try { return Number(koffi.address(ptr)); } catch { return 0; }
}

function textOf(hWnd) {
  const a = load();
  const buf = Buffer.alloc(512 * 2);
  const n = a.GetWindowTextW(hWnd, koffi.as(buf, 'uint16 *'), 512);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function classNameOf(hWnd) {
  const a = load();
  const buf = Buffer.alloc(256 * 2);
  const n = a.GetClassNameW(hWnd, koffi.as(buf, 'uint16 *'), 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function pidOf(hWnd) {
  const a = load();
  const buf = koffi.alloc('uint32', 1);
  a.GetWindowThreadProcessId(hWnd, buf);
  return koffi.decode(buf, 'uint32');
}

/** 顶层窗口句柄列表（Z 序，从最前面开始） */
function topLevelWindows() {
  const a = load();
  const out = [];
  let h = a.FindWindowExW(a.GetDesktopWindow(), null, null, null);
  let guard = 0;
  while (h && guard < MAX_WINDOWS) {
    out.push(h);
    h = a.FindWindowExW(a.GetDesktopWindow(), h, null, null);
    guard += 1;
  }
  return out;
}

/** 应用主窗口 */
function findAppWindow(title = APP_WINDOW_TITLE) {
  const a = load();
  if (!a) return null;
  const h = a.FindWindowW(null, title);
  return h ? { handle: h, pid: pidOf(h), title } : null;
}

/**
 * 找**本应用**当前打开的对话框。
 * @param {{title?:string, titleIncludes?:string}} [options]
 */
function findDialog(options = {}) {
  const a = load();
  if (!a) return null;

  const appWin = findAppWindow(options.title);
  if (!appWin) return null;

  for (const h of topLevelWindows()) {
    if (classNameOf(h) !== DIALOG_CLASS) continue;
    if (pidOf(h) !== appWin.pid) continue;
    if (!a.IsWindowVisible(h)) continue;
    const title = textOf(h);
    if (options.titleIncludes && !title.includes(options.titleIncludes)) continue;
    return { handle: h, pid: appWin.pid, title };
  }
  return null;
}

/** 顺带看看系统里还有哪些 #32770 窗口（排查用，避免再误判成别人的窗口） */
function listForeignDialogs() {
  const appWin = findAppWindow();
  const out = [];
  for (const h of topLevelWindows()) {
    if (classNameOf(h) !== DIALOG_CLASS) continue;
    const pid = pidOf(h);
    out.push({ pid, ours: Boolean(appWin && pid === appWin.pid), title: textOf(h) });
  }
  return out;
}

async function waitForDialog(options = {}, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = findDialog(options);
    if (d) return d;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/** 等对话框消失（按键之后确认真的关掉了） */
async function waitForDialogGone(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findDialog()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/**
 * 对话框里的静态文本。
 * message / detail 都放在 Static 子控件里（窗口标题只是应用名，看不到正文），
 * 所以想验证「弹的是不是这张图的确认框」得读子控件。
 */
function dialogStaticTexts(handle) {
  const a = load();
  const out = [];
  let child = a.FindWindowExW(handle, null, 'Static', null);
  let guard = 0;
  while (child && guard < 60) {
    const t = textOf(child);
    if (t) out.push(t);
    child = a.FindWindowExW(handle, child, 'Static', null);
    guard += 1;
  }
  return out;
}

function ensureForeground(handle) {
  const a = load();
  if (addr(a.GetForegroundWindow()) === addr(handle)) return true;
  a.SetForegroundWindow(handle);
  const deadline = Date.now() + 600;
  while (Date.now() < deadline) {
    if (addr(a.GetForegroundWindow()) === addr(handle)) return true;
    const spin = Date.now() + 20;
    while (Date.now() < spin) { /* 忙等：调用方是同步流程 */ }
  }
  return addr(a.GetForegroundWindow()) === addr(handle);
}

function tap(vk) {
  const a = load();
  a.keybd_event(vk, 0, 0, null);
  a.keybd_event(vk, 0, KEYEVENTF_KEYUP, null);
}

/** 按 Esc = 点「取消」。返回 false 表示没能安全发键（调用方应跳过断言） */
function pressEscape() {
  const d = findDialog();
  if (!d) return false;
  if (!ensureForeground(d.handle)) return false;
  tap(VK.ESCAPE);
  return true;
}

/**
 * 按下对话框里的第一个按钮。
 *
 * 我们的确认框是 `[移入回收站, 取消]` 且 defaultId 指向「取消」，
 * 所以初始焦点在「取消」上 —— 先按一次左方向键把焦点挪到「移入回收站」，再回车。
 * 用方向键而不是按坐标点：不依赖对话框的实际像素尺寸、DPI 与缩放。
 *
 * @param {number} times 从默认按钮往左移动几次
 */
function pressFirstButton(times = 1) {
  const d = findDialog();
  if (!d) return false;
  if (!ensureForeground(d.handle)) return false;
  for (let i = 0; i < times; i += 1) tap(VK.LEFT);
  tap(VK.RETURN);
  return true;
}

/**
 * 依次按下一串键（各自按下 + 抬起）。
 * 用来走「Tab 到复选框 → 空格勾上 → Esc 取消」这类多步操作。
 * 按键前同样要求对话框就是前台窗口，校验不过直接放弃。
 */
function pressKeys(keys) {
  const d = findDialog();
  if (!d) return false;
  if (!ensureForeground(d.handle)) return false;
  for (const k of keys) tap(k);
  return true;
}

/** 把应用主窗口拉到前台（注入全局热键之前用，避免按键落到别的程序上） */
function focusAppWindow() {
  const w = findAppWindow();
  if (!w) return false;
  return ensureForeground(w.handle);
}

/**
 * 应用主窗口现在是不是显示着。
 *
 * 注意 `findAppWindow` 找得到 ≠ 窗口可见 —— 隐藏到托盘后 HWND 还在，
 * 只是不可见。要断言「窗口已经藏起来了」必须问 IsWindowVisible。
 */
function isAppWindowVisible() {
  const a = load();
  const w = findAppWindow();
  if (!a || !w) return false;
  return Boolean(a.IsWindowVisible(w.handle));
}

module.exports = {
  available, diagnose, findAppWindow, findDialog, listForeignDialogs, dialogStaticTexts,
  waitForDialog, waitForDialogGone, pressEscape, pressFirstButton, pressKeys,
  focusAppWindow, isAppWindowVisible, VK,
  DIALOG_CLASS, APP_WINDOW_TITLE,
};
