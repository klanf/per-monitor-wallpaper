'use strict';

/**
 * Electron 主进程。
 *
 * 职责边界（和原 Python 版最大的结构差异）：
 *   Python 版：UI、动画、解码、缩放、壁纸设置、文件管理全在一个类里，跑在唯一的主线程。
 *   Electron 版：渲染和动画交给 Chromium 渲染进程（独立进程 + GPU 合成线程），
 *                主进程只做「文件系统 + Win32 调用 + 配置 + 每屏调度 + 系统集成」这类不能放前端的活。
 *                解码/缩放由 Blink 图像解码器接管，主进程完全不碰像素。
 *
 * 多显示器轮播的调度权在主进程（见 scheduler.js）：
 *   渲染进程退化成「监视器」，只负责把某个频道当前帧画出来，不再自己数秒。
 *
 * 主进程的四个「系统侧」能力，各自独立成一个模块：
 *   thumbnails.js     缩略图生成 + wpthumb:// 协议（胶片条用）
 *   exif.js           图片完整信息
 *   fileActions.js    复制 / 移动 / 删除到回收站 / 外部打开
 *   tray.js           托盘图标 + 开机自启
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const thumbnails = require('./thumbnails');
const { readImageInfo } = require('./exif');
const { readImageSize } = require('./imageSize');
const fileActions = require('./fileActions');
const tray = require('./tray');
const shellMenu = require('./shellMenu');
const stageProtocol = require('./stageProtocol');
const videoOptimize = require('./videoOptimize');
const liveStage = require('./liveStage');
const fullscreenWatch = require('./fullscreenWatch');
const swipeWatch = require('./swipeWatch');

// 自定义协议必须在 app ready 之前注册，所以放在模块顶层
thumbnails.registerScheme();
stageProtocol.registerScheme();

const { Store, UNIFIED_MONITOR, newAlbumId, findAlbum } = require('./store');
const { probeFile } = require('./scanner');
const win32 = require('./win32');
const desktopWallpaper = require('./desktopWallpaper');
const { MonitorScheduler, UNIFIED_ID } = require('./scheduler');
const { PlaybackState } = require('./playbackState');

const CACHE_DIR = path.join(os.tmpdir(), 'electron-wallpaper-cache');

// 未处理 Promise 拒绝必须留痕 —— 2026-09-25 排障实测：whenReady 链上的静默
// 中断（如启动序列中段抛错）在 Windows GUI 子系统下什么都不打印，主进程活着
// 但启动流程断在半路，表象就是「功能没起来又没有报错」，极难排查。
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason && reason.stack ? reason.stack : reason);
  try { require('./debugLog').dlog('crash', 'unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason))); } catch (_) {}
});

/*
 * 未捕获异常：记日志继续跑，绝不弹 Electron 的模态错误框。
 *
 * 背景（2026-09-26 实弹）：wpimg 流被渲染端取消后 undici 适配层竞态调
 * controller.close() 抛 TypeError —— 没有处理器时 Electron 弹模态框，
 * 壁纸应用的「模态框」弹在用户桌面上就是画面静止，比异常本身严重。
 * 这类异常多半是单次竞态，主进程的事件循环和定时器都还活着，记下现场
 * 继续跑是正确的降级（根因照样在 stageProtocol 里修）。
 *
 * ⚠️ 必须 dlog 落盘而不只 console.error：GUI 子系统 stdout 接不住
 * （dev.log 恒 0 字节），2026-10-09 晚实例三连消失、现场全丢的教训。
 */
process.on('uncaughtException', (err) => {
  console.error('[uncaught-exception] 继续运行:', err && err.stack ? err.stack : err);
  try { require('./debugLog').dlog('crash', 'uncaughtException(继续运行): ' + (err && err.stack ? err.stack : String(err))); } catch (_) {}
});

/*
 * 防降帧三连（阶段 0 PoC 的教训进生产）：
 * 舞台窗口挂进 Progman 之后就是个子窗口，Chromium 的「窗口遮挡检测」会把
 * 「被其它子窗口盖住」当成「用户看不见」而停止出帧 —— 表现和合成器死了一样。
 * 这三个开关必须在 ready 之前挂上，动态桌面开着时缺一不可。
 */
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/*
 * 测试隔离钩子：环境变量把 userData（配置 / 单实例锁 / 播放存档）整个换目录。
 * requestSingleInstanceLock 按 userData 分钥匙，所以端到端验证得以和
 * 用户正在跑的真实实例并存，互不干扰。必须在下面拿锁之前生效。
 */
if (process.env.WP_USER_DATA) app.setPath('userData', path.resolve(process.env.WP_USER_DATA));

/*
 * 同一件事的命令行形式：桌面右键菜单的注册表命令会带 `--wp-user-data="<路径>"`
 * （shellMenu.commandLine 注入）。不带的话，点菜单新起的进程会用**默认** userData
 * —— 锁按 userData 分钥匙，它跟正在跑的隔离实例互不认识，就自己成了完整实例：
 * 挂自己的舞台盖住原实例（用户看到「舞台消失又瞬间加回来」），800ms 后把动作
 * 办在一个将死的进程上再退出 —— 运行中的实例毫无感知（暂停不生效、删错图的根因）。
 * Windows 引号规则 `a="b c"` 解析成单个参数 `a=b c`，但这里还是兼容带引号的形式。
 */
(function applyArgvUserData() {
  const raw = process.argv.find((a) => typeof a === 'string' && a.startsWith('--wp-user-data='));
  if (!raw) return;
  const p = raw.slice('--wp-user-data='.length).replace(/^"(.*)"$/, '$1').trim();
  if (p) app.setPath('userData', path.resolve(p));
})();

let store = null;
let mainWindow = null;
let scheduler = null;
const depthService = require('./depthService');
const debugLog = require('./debugLog');
/** 播放位置的磁盘存档（跨进程重启「接着上次那张播」，见 playbackState.js） */
let playback = null;
let quitting = false;
let hideNoticeShown = false;

/* ------------------------------------------------------------------ 显示器 */

/**
 * 枚举显示器（走 IDesktopWallpaper 的设备路径，而不是 Electron 的 screen 模块）。
 * 原因：写系统壁纸时需要的 monitorID 就是这套设备路径，
 *       Electron 的 display.id 是另一套编号，混用会写错屏。
 */
function listMonitors() {
  const result = desktopWallpaper.enumMonitors();
  return {
    ok: result.ok,
    error: result.error,
    backend: desktopWallpaper.backendName(),
    monitors: (result.monitors || []).map((m) => ({
      id: m.id, index: m.index, label: m.label, width: m.width, height: m.height,
      x: m.x, y: m.y, primary: m.primary, current: m.current,
    })),
  };
}

/** 取主窗口的原生 HWND（x64 下 getNativeWindowHandle 给的是 8 字节 Buffer） */
function currentHwnd() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const handle = mainWindow.getNativeWindowHandle();
    return handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
  } catch {
    return null;
  }
}

/**
 * 统一模式的写入目标（配置项 monitor）：
 *   'all'      全部显示器（每屏同一张）
 *   'primary'  仅主显示器
 *   'window'   仅程序窗口当前所在的那台
 *   '<设备路径>' 仅指定的那一台
 */
function resolveUnifiedTarget() {
  const target = store.get().monitor || 'all';
  if (target === 'all') return { monitorId: null, label: '全部显示器' };

  if (target === 'window') {
    const hwnd = currentHwnd();
    const id = hwnd === null ? null : desktopWallpaper.monitorIdForWindow(hwnd);
    return id
      ? { monitorId: id, label: '窗口所在显示器' }
      : { monitorId: null, label: '全部显示器（未匹配到窗口屏幕）' };
  }

  if (target === 'primary') {
    const id = desktopWallpaper.primaryMonitorId();
    return id ? { monitorId: id, label: '主显示器' } : { monitorId: null, label: '全部显示器（未找到主屏）' };
  }

  return { monitorId: target, label: '指定显示器' };
}

/* ------------------------------------------------------------------ 窗口 */

function createWindow() {
  const cfg = store.get();
  // 桌面右键菜单拉起来的进程也算「不该弹窗」：用户正看着桌面，
  // 窗口糊上来正好挡住他要看的那块屏。它办完事就自己退了（见 whenReady 里那段）。
  const fromDesktopMenu = Boolean(shellMenu.itemFromArgv(process.argv));
  const startHidden = process.argv.includes('--hidden') || cfg.startHidden === true || fromDesktopMenu;

  mainWindow = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0d',   // 避免首帧白闪
    autoHideMenuBar: true,
    title: '壁纸切换器 · Electron',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 窗口失焦 / 隐藏时不要降帧
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
    if (cfg.window.fullscreen && !startHidden) mainWindow.setFullScreen(true);
  });

  // 记住窗口尺寸（全屏状态下不记录，避免把全屏尺寸写进配置）
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return;
    const [width, height] = mainWindow.getSize();
    store.set({ window: { width, height, fullscreen: false } });
  };
  mainWindow.on('resized', persistBounds);
  mainWindow.on('enter-full-screen', () => store.set({ window: { fullscreen: true } }));
  mainWindow.on('leave-full-screen', () => {
    store.set({ window: { fullscreen: false } });
    persistBounds();
  });

  // 关窗口 = 隐藏到托盘。调度器在主进程，隐藏窗口不影响桌面继续切换
  mainWindow.on('close', (event) => {
    if (quitting || !store.get().closeToTray || !tray.isInstalled()) return;
    event.preventDefault();
    mainWindow.hide();
    if (!hideNoticeShown) {
      hideNoticeShown = true;
      tray.notify('仍在后台运行', '窗口已隐藏到托盘，壁纸轮播继续。右键托盘图标可以控制每块屏。');
    }
  });

  mainWindow.on('show', () => tray.refresh(scheduler ? scheduler.list() : []));
  mainWindow.on('hide', () => tray.refresh(scheduler ? scheduler.list() : []));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isWindowVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (isWindowVisible()) mainWindow.hide();
  else showWindow();
}

/**
 * 重新启动本程序（托盘菜单 / 窗口菜单共用）。
 *
 * 改了主进程代码之后最省事的一步就是重启 —— 以前得「退出 → 再双击 VBS」两步，
 * 从托盘退出后桌面还停在最后一张，得手动找回去。
 *
 * 两个细节：
 *   ① `relaunch` 是「当前实例退出时再拉起新进程」，不会和单实例锁抢 —— 所以不用自己 sleep；
 *   ② 用 `app.quit()` 而不是 `app.exit(0)`：后者不发 will-quit，playback 就不会 flush，
 *      「记住上次播放位置」这一步会丢。quitting 置 true 是让「关窗口=藏托盘」别把退出流程拦下来。
 */
function restartApp() {
  quitting = true;
  // 带上原来的启动参数（比如 --hidden），重启后行为和手动重开一致
  app.relaunch({ args: process.argv.slice(1) });
  app.quit();
}

/* ------------------------------------------------------------------ 菜单 */

function buildMenu() {
  const action = (name) => {
    showWindow();
    send('menu:action', name);
  };

  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '相簿（添加图片目录）…', accelerator: 'CmdOrCtrl+O', click: () => action('pick-folder') },
        { label: '重新扫描', accelerator: 'CmdOrCtrl+R', click: () => action('rescan') },
        { type: 'separator' },
        { label: '打开配置目录', click: () => shell.openPath(app.getPath('userData')) },
        { label: '打开缩略图缓存目录', click: () => thumbnails.stats().then((s) => shell.openPath(s.dir)) },
        { type: 'separator' },
        { label: '隐藏到托盘', click: () => mainWindow && mainWindow.hide() },
        { type: 'separator' },
        { label: '重新启动', click: () => restartApp() },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '播放',
      // 方向键 / 空格 / F11 交给渲染进程的 keydown 处理。
      // 这里如果也挂 accelerator，菜单会先截走按键，渲染层再响应一次 —— 结果就是一次按键跳两张图。
      submenu: [
        { label: '上一张', click: () => action('prev') },
        { label: '下一张', click: () => action('next') },
        { label: '暂停 / 继续', click: () => action('toggle-play') },
        { type: 'separator' },
        { label: '立即设为系统壁纸', accelerator: 'CmdOrCtrl+S', click: () => action('apply-now') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '全屏', click: () => action('toggle-fullscreen') },
        { label: '设置面板', accelerator: 'CmdOrCtrl+,', click: () => action('toggle-settings') },
        { type: 'separator' },
        { label: '缩略图胶片条', accelerator: 'CmdOrCtrl+B', click: () => action('toggle-filmstrip') },
        { label: '图片信息面板', accelerator: 'CmdOrCtrl+I', click: () => action('toggle-info') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'reload', label: '重新加载', accelerator: 'CmdOrCtrl+Shift+R' },
      ],
    },
  ]);

  Menu.setApplicationMenu(menu);
}

/* ------------------------------------------------------------------ 文件操作 */

/**
 * 移动 / 复制到指定文件夹，并让调度器就地更新。
 * 关键点：走 scheduler.applyFileMutation 而不是 rebuild ——
 * 重建会把轮播打回第一张，用户只是想把一张图挪个位置，不该付这个代价。
 */
async function performTransfer(imagePath, targetDir, mode) {
  const result = await fileActions.transfer(imagePath, targetDir, mode);
  if (result.ok) {
    // 只有「移动」才改变了文件的位置。复制之后源文件还在原地，
    // 要是也走 applyFileMutation，就会把这张图从轮播里凭空摘掉。
    const mutation = mode === 'move'
      ? scheduler.applyFileMutation(imagePath, result.dest)
      : { affected: [], rewritten: [] };
    send('files:changed', {
      reason: mode, path: imagePath, dest: result.dest, mutation,
    });
    send('notice', {
      text: `已${mode === 'move' ? '移动' : '复制'}「${path.basename(imagePath)}」到 ${result.name}`,
    });
  } else {
    send('notice', { text: `操作失败：${result.error}`, error: true });
  }
  return result;
}

/**
 * 删除前的「请求许可」。
 *
 * 图片库是长期积累的，误删的代价远大于多点一下的成本，所以默认每次都要问一次。
 * 觉得烦就勾「不再询问」，那会把 confirmDelete 落盘关掉，设置里随时能再打开。
 *
 * @returns {Promise<boolean>} 是否允许删除
 */
async function askDeletePermission(imagePath) {
  if (store.get().confirmDelete === false) return true;

  const name = path.basename(imagePath);
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['移入回收站', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: '请求删除照片的权限',
    message: `请求删除「${name}」的权限`,
    detail: '只会移入回收站，随时可以从回收站还原。\n'
      + '不想每次都问的话，勾选下面的选项，或到「设置 → 删除与热键」里关掉。',
    checkboxLabel: '以后删除时不再询问',
    checkboxChecked: false,
  });

  if (checkboxChecked) {
    store.set({ confirmDelete: false });
    send('confirm-delete:changed', { confirmDelete: false });
    send('notice', { text: '已关闭删除确认（可在设置里重新打开）' });
  }

  return response === 0;
}

/** 所有删除入口都走这里：先请求许可，再真正移入回收站 */
async function trashWithPermission(imagePath) {
  if (!imagePath) return { ok: false, error: '没有文件' };
  if (!fs.existsSync(imagePath)) return { ok: false, error: '文件已经不存在了' };
  if (!(await askDeletePermission(imagePath))) return { ok: false, canceled: true };
  return performTrash(imagePath);
}

async function performTrash(imagePath) {
  const result = await fileActions.trash(imagePath);
  if (result.ok) {
    const mutation = scheduler.applyFileMutation(imagePath, null);
    send('files:changed', { reason: 'trash', path: imagePath, mutation });
    send('notice', { text: `已移入回收站：${result.name}（可从回收站还原）` });
  } else {
    send('notice', { text: `删除失败：${result.error}`, error: true });
  }
  return result;
}

/**
 * 删掉某一路轮播**当前正在显示**的那张（托盘菜单用）。
 *
 * 走的是和其它入口一样的确认流程；删完 applyFileMutation 会就地收敛索引，
 * 当前那张被删时会立刻补写下一张，桌面不会留着一张已经进回收站的图。
 */
async function trashChannelCurrent(channelId) {
  const ch = scheduler.channels.get(channelId);
  if (!ch) return { ok: false, error: '找不到这一路轮播' };

  const entry = ch.files[ch.index];
  if (!entry) return { ok: false, error: '这一路现在没有图片' };

  const result = await trashWithPermission(entry.path);
  if (!result.ok && !result.canceled) {
    send('notice', { text: `删除失败：${result.error}`, error: true });
  }
  return result;
}

/**
 * 「光标在哪块屏」要重试几次才问得出来。
 *
 * 桌面右键菜单点下去的那一瞬间，shell 自己正忙着（它刚把菜单收起来、又起了我们这个进程），
 * 这时候调 IDesktopWallpaper 会被直接拒掉 —— COM 返回 0x8001010D（RPC_E_CALL_REJECTED）。
 * 表现是「定位不到显示器」，删不掉还没提示，看着像功能没做。
 * 隔一两百毫秒再问就好了，退避重试到两秒左右。
 */
async function monitorIdForPointRetry(x, y) {
  for (let i = 0; i < 6; i += 1) {
    const id = desktopWallpaper.monitorIdForPoint(x, y);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 150 + i * 120));
  }
  console.warn('[desktop-menu] 光标定位显示器失败（COM 一直拒绝调用）');
  return null;
}

/**
 * 「光标在哪块屏」→ 那块屏接管的轮播频道。
 *
 * 菜单项是注册表里的一条命令，点下去会再起一个 App 进程；新进程拿不到单实例锁，
 * 把参数转交给已在跑的那个（见 second-instance），于是「动哪块屏」只能自己判断：
 * 菜单是被点在桌面空白处弹出来的，光标就在那块屏上。
 *
 * 切下一张和删除都要先过这一步，抽出来免得两边各写一份、各自漏掉回退分支。
 * 每条失败路径都要给说法 —— 桌面菜单点下去无声无息的话，用户只会以为功能坏了。
 */
async function channelAt(pt) {
  const monitorId = await monitorIdForPointRetry(pt.x, pt.y);

  let id = monitorId && scheduler.channels.has(monitorId) ? monitorId : null;
  // 统一模式（perMonitor 关掉）只有一路频道，光标在哪块屏都归它
  if (!id && scheduler.channels.has(UNIFIED_ID)) id = UNIFIED_ID;
  if (!id && scheduler.channels.size === 1) id = [...scheduler.channels.keys()][0];

  if (!id) {
    const labels = scheduler.list().map((c) => c.label).join('、');
    return {
      ok: false,
      text: monitorId
        ? `光标这块屏没有接管轮播，当前接管的是：${labels || '无'}`
        : '没识别出光标所在显示器',
    };
  }
  return { ok: true, id, label: channelLabel(id), channel: scheduler.channels.get(id) };
}

async function channelAtCursor() {
  const pt = win32.cursorPoint();
  if (!pt) return { ok: false, text: '读不到光标位置' };
  return channelAt(pt);
}

/**
 * 把「光标所在那块屏」的轮播往后拨一张 —— 桌面右键菜单「切换到下一张壁纸」。
 *
 * 只动这一路频道：别的屏不受影响。scheduler.step 内部会把新的一张写进系统壁纸，
 * 所以点完菜单桌面上那块屏当场就换图。
 */
async function stepWallpaperAt(pt, dir) {
  const at = await channelAt(pt);
  if (!at.ok) {
    send('notice', { text: `${at.text}，切不了`, error: true });
    return { ok: false, error: at.text };
  }
  if (at.channel.files.length < 2) {
    send('notice', { text: `${at.label} 只有一张图，没得切`, error: true });
    return { ok: false, error: '这一路只有一张图', channelId: at.id, label: at.label };
  }

  console.log(`[wallpaper-step] ${dir > 0 ? '下一' : '上一'}张 @(${pt.x},${pt.y})：${at.label}`);
  // step 返回的是「换完之后正在放的那张」，不是被跳过的那张
  const entry = await scheduler.step(at.id, dir);
  tray.refresh(scheduler.list());

  // 窗口可见时界面自己会跟着刷，别重复打扰；藏进托盘才需要气泡
  if (entry && !isWindowVisible() && store.get().tray !== false) {
    tray.notify('壁纸切换器', `已切到${dir > 0 ? '下一' : '上一'}张：${entry.name}（${at.label}）`);
  }
  return {
    ok: true,
    channelId: at.id,
    label: at.label,
    entry: entry ? { path: entry.path, name: entry.name } : null,
  };
}

async function stepWallpaperAtCursor() {
  const pt = win32.cursorPoint();
  if (!pt) {
    send('notice', { text: '读不到光标位置，切不了', error: true });
    return { ok: false, error: '读不到光标位置' };
  }
  return stepWallpaperAt(pt, 1);
}

/* 手动暂停集（桌面右键「暂停/继续壁纸」）：与 fullscreenWatch 的自动暂停并集生效。
 * 存的是 **Electron displayId**（与 fullscreenWatch/liveStage 同一口径）；
 * unified 频道不对应单屏，用哨兵表示「全部舞台」。 */
const manualPausedDisplays = new Set();
const PAUSE_ALL = '__all__';

/** IDesktopWallpaper 设备路径 → Electron displayId（频道 id 和舞台 id 是两套体系）。
 *  直接把设备路径塞进暂停集，liveStage 的 pauseDisplays.has(rec.displayId)
 *  永远是 false —— 这是第十五轮「点了暂停舞台照转」的第二层根因。 */
function monitorPathToDisplayId(monitorId) {
  if (!monitorId || monitorId === UNIFIED_ID) return null;
  const result = desktopWallpaper.enumMonitors();
  const m = (result.monitors || []).find((x) => x.id === monitorId);
  if (!m) return null;
  return liveStage.displayIdForMonitor(m);   // 几何匹配（±2px 容差），可能 null
}

/** 把自动暂停与手动暂停合并后广播（fullscreenWatch 每拍 / 手动切换后都走这里） */
function broadcastPauseState(pausedIds, away, reasons) {
  const merged = new Set(pausedIds);
  const rs = { ...(reasons || {}) };
  for (const id of manualPausedDisplays) {
    if (id === PAUSE_ALL) {
      for (const did of liveStage.allDisplayIds()) { merged.add(did); rs[did] = 'manual'; }
    } else {
      merged.add(id);
      rs[id] = 'manual';
    }
  }
  liveStage.applyPauseState({ pausedIds: [...merged], away, reasons: rs });
}

/**
 * 桌面右键「暂停 / 继续壁纸」：切换光标所在那块屏的手动暂停。
 * 暂停 = 渲染冻结（rAF 停、GPU 归零）+ 调度器该屏不推进（isPaused 感知）。
 */
async function togglePauseAtCursor() {
  const at = await channelAtCursor();
  if (!at.ok) {
    send('notice', { text: `${at.text}，暂停不了`, error: true });
    return { ok: false, error: at.text };
  }
  const { id, label } = at;

  // 频道 id（设备路径）→ Electron displayId；unified 直接全暂停。
  // 换算失败时兜底：只有一块舞台就用它的 displayId，多屏时宁可报错也不乱暂停。
  let pausedId;
  if (id === UNIFIED_ID) {
    pausedId = PAUSE_ALL;
  } else {
    const did = monitorPathToDisplayId(id);
    if (did != null) pausedId = did;
    else {
      const ids = liveStage.allDisplayIds();
      if (ids.length === 1) pausedId = ids[0];
    }
  }
  if (pausedId == null) {
    send('notice', { text: `${label} 对不上渲染舞台，暂停不了`, error: true });
    return { ok: false, error: '显示器与舞台映射失败', channelId: id, label };
  }

  const paused = !manualPausedDisplays.has(pausedId);
  if (paused) manualPausedDisplays.add(pausedId);
  else manualPausedDisplays.delete(pausedId);
  // 切换动作落盘：console.log 只进 stdout（GUI 子系统接不住），这里必须
  // dlog 才能进 live-debug.log —— 没有它就无法区分「一次点击翻两次」和
  // 「暂停集与舞台对不上」（2026-10-09 用户报暂停无效时的诊断盲区）。
  debugLog.dlog('desktop-menu', `${paused ? '暂停' : '继续'} pausedId=${pausedId} label=${label} 手动集=[${[...manualPausedDisplays]}]`);
  // 先采样一次全屏/挂机的当前暂停集再广播 —— 直接传 [] 会把 fullscreenWatch
  // 已生效但「状态未变、不会重发」的全屏暂停一并清掉：手动继续之后，全屏
  // 暂停就静默失效直到下一次全屏状态翻转（2026-10-09 实锤：21:43 手动继续
  // 后主屏全屏暂停再没接上）。tickNow 顺带刷新 watch 的内部状态，语义对齐。
  const fs = fullscreenWatch.tickNow();
  broadcastPauseState(fs.ok ? fs.pausedIds : [], fs.away, fs.ok ? fs.reasons : {});
  console.log(`[desktop-menu] ${paused ? '暂停' : '继续'} ${label}（手动，pausedId=${pausedId}）`);
  send('notice', { text: `${label} 壁纸已${paused ? '暂停' : '恢复'}` });
  return { ok: true, channelId: id, label, paused };
}

/**
 * 删掉「光标所在那块屏」正在轮播的那张 —— 桌面右键菜单「删除当前显示器的壁纸」。
 */
async function deleteWallpaperAtCursor() {
  const at = await channelAtCursor();
  if (!at.ok) {
    send('notice', { text: `${at.text}，删不掉`, error: true });
    return { ok: false, error: at.text };
  }

  const { id, label } = at;
  const entry = at.channel.files[at.channel.index];
  if (!entry) {
    send('notice', { text: `${label} 现在没有图片，没什么可删的`, error: true });
    return { ok: false, error: '这一路没有图片' };
  }

  console.log(`[desktop-menu] 删除 ${label} 当前这张：${entry.path}`);
  const result = await trashChannelCurrent(id);
  tray.refresh(scheduler.list());

  // 窗口可见时 performTrash 已经弹过 toast，别重复；藏进托盘才需要气泡
  if (result.ok && !isWindowVisible() && store.get().tray !== false) {
    tray.notify('壁纸切换器', `已移入回收站：${result.name}（${label}）`);
  }
  return { ...result, channelId: id, label };
}

/**
 * 桌面右键菜单点了哪一项 → 干什么。
 * 第二实例转发（App 已经在跑）和启动补办（App 没在跑）都走这一个入口，
 * 免得两条路径各写一份 switch、加菜单项时漏改一处。
 */
function runDesktopMenuAction(item) {
  debugLog.dlog('desktop-menu', `入口 key=${item && item.key}（second-instance 转发或启动补办）`);
  switch (item.key) {
    case 'next': return stepWallpaperAtCursor();
    case 'delete': return deleteWallpaperAtCursor();
    case 'pause': return togglePauseAtCursor();
    default:
      console.warn('[desktop-menu] 不认识的菜单项:', item.key);
      return Promise.resolve({ ok: false, error: `不认识的菜单项：${item.key}` });
  }
}


async function addQuickFolder(folderPath, name) {
  const folders = [...(store.get().quickFolders || [])];
  if (folders.some((f) => f.path.toLowerCase() === folderPath.toLowerCase())) {
    return { ok: false, error: '这个文件夹已经在预设里了' };
  }
  const entry = fileActions.makeQuickFolder(folderPath, name);
  folders.push(entry);
  store.set({ quickFolders: folders });
  return { ok: true, folder: entry, folders };
}

/* ------------------------------------------------------------------ 右键菜单 */

function quickFolderSubmenu(imagePath, mode) {
  const folders = store.get().quickFolders || [];
  const items = folders.map((f) => ({
    label: `${f.name}     ${f.path}`.slice(0, 96),
    click: () => performTransfer(imagePath, f.path, mode),
  }));

  if (items.length === 0) {
    items.push({ label: '（还没有预设文件夹）', enabled: false });
  }
  items.push({ type: 'separator' });
  items.push({
    label: '把「当前所在文件夹」加为预设',
    click: async () => {
      const dir = path.dirname(imagePath);
      const r = await addQuickFolder(dir);
      send('notice', r.ok
        ? { text: `已添加预设：${r.folder.name}` }
        : { text: r.error, error: true });
    },
  });
  items.push({
    label: '添加预设文件夹…',
    click: async () => {
      const folder = await fileActions.pickFolderForQuick(mainWindow);
      if (!folder) return;
      const r = await addQuickFolder(folder.path, folder.name);
      send('notice', r.ok
        ? { text: `已添加预设：${r.folder.name}` }
        : { text: r.error, error: true });
      send('quick-folders:changed', { folders: store.get().quickFolders });
    },
  });
  if (folders.length > 0) {
    items.push({
      label: '管理预设文件夹…',
      click: () => {
        showWindow();
        send('menu:action', 'open-quick-folders');
      },
    });
  }
  return items;
}

/**
 * 「用其他程序打开」子菜单。
 *
 * 两层入口，覆盖两种习惯：
 *   · **记住的程序列表** —— 沿用原版 Python 的做法（`open_with.programs`），
 *     选过一次就记住，下次一点就开。常用来回看的那几个看图 / 修图软件排在这儿。
 *   · **系统的「打开方式」对话框** —— 第一次遇到的新格式、或想临时换个程序时用。
 *     （原实现走的是 `rundll32.exe shell32.dll,OpenAs_RunDLL`：慢、拿不到结果，
 *     而且每张图都要重选一遍 —— 所以它只该是「列表之外的补充」，不是主路径。）
 */
function openWithSubmenu(imagePath) {
  const programs = store.get().openWith || [];
  const displayName = (p) => path.basename(p, path.extname(p));

  const items = programs.map((p) => ({
    label: displayName(p),
    toolTip: p,
    click: async () => {
      const r = await fileActions.launchWith(p, imagePath);
      send('notice', r.ok
        ? { text: `已用「${displayName(p)}」打开` }
        : { text: r.error, error: true });
    },
  }));

  if (!items.length) items.push({ label: '（还没有添加程序）', enabled: false });

  items.push({ type: 'separator' });
  items.push({
    label: '选择程序…',
    click: async () => {
      const picked = await fileActions.pickProgram(mainWindow);
      if (!picked) return;

      const list = [...(store.get().openWith || [])];
      const isNew = !list.includes(picked);
      if (isNew) list.push(picked);
      if (isNew) {
        store.set({ openWith: list });
        send('open-with:changed', { programs: list });
        send('notice', { text: `已记住「${displayName(picked)}」，下次直接点它` });
      }
      // 添加完顺手就用它打开这一张 —— 用户加程序就是为了用它看
      const r = await fileActions.launchWith(picked, imagePath);
      if (!r.ok) send('notice', { text: r.error, error: true });
    },
  });
  items.push({
    label: '打开方式…（系统对话框）',
    toolTip: 'Windows 的「你要如何打开这个文件？」——任意已安装程序都能选，不用先加进列表',
    click: async () => {
      const r = await fileActions.openWithDialog(imagePath);
      if (!r.ok) send('notice', { text: r.error, error: true });
    },
  });

  if (programs.length) {
    items.push({
      label: `清空程序列表（${programs.length} 个）`,
      click: () => {
        store.set({ openWith: [] });
        send('open-with:changed', { programs: [] });
        send('notice', { text: '已清空「用其他程序打开」的程序列表' });
      },
    });
  }

  return items;
}

/**
 * 图片右键菜单。
 * 用 Electron 原生 Menu 而不是 HTML 自绘：菜单要跟随系统主题与高 DPI 缩放、
 * 要能弹原生文件对话框，自绘得把这些重做一遍。
 */
function showImageMenu(payload) {
  const template = buildImageMenuTemplate(payload);
  if (!template) return;
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
}

/**
 * 把菜单模板压成纯数据（去掉 function），供验证脚本核对菜单项是否齐全。
 * Electron 的 template 里 click 是函数，没法直接经 IPC 传出去。
 */
function describeMenuTemplate(template) {
  return template.map((item) => ({
    type: item.type || 'normal',
    label: item.label || null,
    enabled: item.enabled !== false,
    accelerator: item.accelerator || null,
    hasClick: typeof item.click === 'function',
    submenu: item.submenu ? describeMenuTemplate(item.submenu) : null,
  }));
}

function buildImageMenuTemplate(payload) {
  const imagePath = payload && payload.path;
  if (!imagePath) return null;

  const cfg = store.get();
  const canModify = fs.existsSync(imagePath);

  const template = [];

  /*
   * 文件不在的时候，别只是把菜单项灰掉 —— 一排灰项不写任何理由，用户看到的
   * 就是「点了没反应」。顶上顶一行说明，比给每一项加后缀清楚，也不破坏
   * 验证脚本「这些项应当置灰」的断言。
   */
  if (!canModify) {
    template.push({
      label: '文件已不在（可能被移走或删掉了）',
      enabled: false,
    });
    template.push({ type: 'separator' });
  }

  template.push({
    label: '复制图像到剪贴板',
    enabled: canModify,
    click: async () => {
      /*
       * 先报进度、再干活。
       *
       * 复制本身可能要 1~7 秒（取决于图的像素数），而那几秒里主进程是**同步冻住**的
       * —— 提示如果和同步段发在同一次事件循环里，屏幕上什么都没画出来，
       * 用户看到的就是「点了没反应、也粘贴不出来」。所以进度必须先出去、先画出来。
       */
      const r = await fileActions.copyImageWithNotice(
        imagePath,
        (text) => send('notice', { text }),
      );
      if (!r.ok) {
        send('notice', { text: r.error, error: true });
        return;
      }
      /*
       * 两条路都要说清楚，因为它们对用户是不同的信息：
       *   · 快路（大图跳过 PNG 编码）—— 正常且更快，用户知道「大图这次是有意走快的」；
       *   · 兜底（Electron 那条路当时不可用）—— 异常情况，得让用户知道。
       */
      let via = '';
      if (r.method === 'native') {
        via = r.fast
          ? '（大图，走快速通道）'
          : '（Electron 写入未生效，已走系统兜底写入）';
      }
      send('notice', { text: `已复制图像（${r.width}×${r.height}）${via}，可直接粘贴` });
    },
  });
  template.push({
    label: '复制文件到剪贴板',
    enabled: canModify,
    click: () => {
      const r = fileActions.copyFile(imagePath);
      send('notice', r.ok
        ? { text: '已复制文件，可在资源管理器里粘贴' }
        : { text: r.error, error: true });
    },
  });
  template.push({ type: 'separator' });
  template.push({ label: '移动到', submenu: quickFolderSubmenu(imagePath, 'move') });
  template.push({ label: '复制到', submenu: quickFolderSubmenu(imagePath, 'copy') });

  template.push({ type: 'separator' });
  // 只留一项：showItemInFolder 本身就是「打开文件夹 + 选中 + 滚动到可见」，
  // 原来「在资源管理器中显示」和「打开所在文件夹」其实是同一件事，摆两项只会让人犹豫点哪个。
  template.push({
    label: '打开所在文件夹',
    enabled: canModify,
    click: async () => {
      const r = await fileActions.openContainingFolder(imagePath);
      if (!r.ok) send('notice', { text: r.error, error: true });
    },
  });
  template.push({
    label: '用其他程序打开',
    enabled: canModify,
    submenu: openWithSubmenu(imagePath),
  });

  template.push({ type: 'separator' });
  template.push({
    label: '删除到回收站',
    enabled: canModify,
    click: () => trashWithPermission(imagePath),
  });

  return template;
}

/* -------------------------------------------------------------- 全局热键 */

/**
 * 当前预览的频道。渲染层每次切预览都上报（`preview:set`）。
 *
 * 主进程必须自己记一份：热键是全局的，窗口很可能正藏在托盘里，
 * 这时候渲染层的状态拿不到，但热键要照样能作用于「你刚才在看的那块屏」。
 */
let currentPreviewId = null;
/** 上一次注册的结果，供设置面板回显（哪些被别的程序占用了） */
let hotkeyStatus = { registered: {}, failed: [] };

/** 热键能做的动作。键名和 config.hotkeys 一一对应 */
const HOTKEY_ACTIONS = {
  cycleMonitor: '切到下一台显示器',
  next: '下一张',
  prev: '上一张',
  playPause: '暂停 / 继续',
  delete: '删除当前这张到回收站',
  toggleWindow: '显示 / 隐藏主窗口',
  info: '查看当前这张的图片信息',
  reveal: '打开所在文件夹',
};

const MODIFIER_WORDS = new Set([
  'ctrl', 'control', 'alt', 'shift', 'super', 'meta', 'cmd', 'command',
  'commandorcontrol', 'cmdorctrl', 'altgr',
]);

/**
 * 校验 accelerator。
 *
 * 必须带修饰键 —— 单键全局热键（比如把「下一张」设成 `Space`）会抢掉全系统的输入，
 * 那是能把人逼疯的体验。这里直接拒绝，而不是等用户踩了坑再来问。
 */
function validateAccelerator(accel) {
  if (typeof accel !== 'string' || !accel.trim()) return { ok: false, reason: '没有设置' };
  const parts = accel.split('+').map((s) => s.trim()).filter(Boolean);
  const hasModifier = parts.some((p) => MODIFIER_WORDS.has(p.toLowerCase()));
  const keys = parts.filter((p) => !MODIFIER_WORDS.has(p.toLowerCase()));
  if (!hasModifier) return { ok: false, reason: '必须带修饰键（Ctrl / Alt / Shift / Win）' };
  if (parts.length < 2) return { ok: false, reason: '必须带修饰键（Ctrl / Alt / Shift / Win）' };
  if (keys.length !== 1) return { ok: false, reason: '只能有一个主键' };
  return { ok: true };
}

/**
 * Electron 拒绝某个键名时抛的原文长这样：
 *   Error processing argument at index 0, conversion failure from Ctrl+Period
 * 对着用户念「conversion failure」等于什么都没说。这里翻成人话，并给出替代写法。
 *
 * 表里的名字都是 DOM 的 KeyboardEvent.code 名，不是 Electron 的 accelerator 名 ——
 * 录制代码如果误用它们（旧版本就会把 `.` 写成 `Period`），注册必失败。
 */
const ACCEL_NAME_HINTS = {
  period: '.', comma: ',', slash: '/', semicolon: ';', quote: "'",
  bracketleft: '[', bracketright: ']', backslash: '\\', backquote: '`',
  minus: '-', equal: '=', plus: 'Plus', spacebar: 'Space',
};

function explainAcceleratorError(message, accel) {
  const text = String(message || '');
  if (!/conversion failure/i.test(text)) return text;
  const bad = String(accel).split('+').pop().trim();
  const low = bad.toLowerCase();
  if (/^numpad/.test(low)) {
    return `小键盘的键（${bad}）Electron 绑不上，请改用主键盘的数字`;
  }
  const hint = ACCEL_NAME_HINTS[low];
  return hint
    ? `键名「${bad}」不是 Electron 认识的名字，改成「${hint}」就行`
    : `键名「${bad}」不是 Electron 认识的键`;
}

/** 热键最终落在哪一路轮播上：优先当前预览，没有就用第一路 */
function hotkeyTargetChannelId() {
  if (currentPreviewId && scheduler.channels.has(currentPreviewId)) return currentPreviewId;
  const first = scheduler.channels.values().next().value;
  return first ? first.id : null;
}

/**
 * 「切到下一台显示器」—— 在全部频道里循环推进「当前操作的那一路」。
 *
 * next / prev / 删除 / 信息这些热键的目标都跟着 `currentPreviewId` 走，
 * 所以切完之后必须把它回传给渲染层，否则会出现「热键作用在 A 屏、界面却在看 B 屏」的漂移。
 * 窗口藏在托盘里时渲染层照样收得到（只是看不见）—— 保持单一真相源比省一次渲染更重要。
 * 只有统一模式那一路时切不动，要明说原因，不然用户只会觉得「这个热键没反应」。
 */
function cycleMonitorTarget() {
  const ids = [...scheduler.channels.keys()];
  if (!ids.length) return { ok: false, reason: 'empty', text: '还没有可用的显示器' };
  if (ids.length < 2) {
    return {
      ok: false,
      reason: 'single',
      text: '当前只有一路轮播（统一模式），没有别的显示器可切',
    };
  }

  const from = hotkeyTargetChannelId();
  const at = ids.indexOf(from);
  const next = ids[(at + 1) % ids.length];

  currentPreviewId = next;
  send('preview:select', { id: next, reason: 'hotkey' });

  return { ok: true, id: next, from, index: ids.indexOf(next), total: ids.length };
}

/**
 * 热键统一的反馈出口。
 *
 * 窗口可见 → 界面 toast；藏进托盘 → 托盘气泡。
 * 少了这一层，热键在托盘态做了什么（或失败在哪）用户**完全看不到** ——
 * 表现就是「按了没反应」，然后只能来问为什么。
 */
function notifyHotkey(text, isError = false) {
  if (isWindowVisible()) send('notice', { text, error: isError });
  else tray.notify('壁纸切换器', text);
  console.log(`[hotkey] ${text}`);
}

/** 热键动作落在哪块屏上 —— 通知里带上它，免得「删的是另一块屏」被误当成没生效 */
function channelLabel(id) {
  const ch = id ? scheduler.channels.get(id) : null;
  if (!ch) return '';
  if (ch.kind === 'monitor' && ch.monitor) return ch.monitor.label;
  return '统一配置';
}

function runHotkeyAction(action) {
  const id = hotkeyTargetChannelId();

  switch (action) {
    case 'cycleMonitor': {
      const result = cycleMonitorTarget();
      if (!result.ok) notifyHotkey(result.text, true);
      break;
    }
    case 'next':
      if (id) runChannelCommand(id, 'next');
      break;
    case 'prev':
      if (id) runChannelCommand(id, 'prev');
      break;
    case 'playPause':
      if (id) runChannelCommand(id, 'toggle-play');
      break;
    case 'delete': {
      /*
       * 这一条以前写的是 `if (id) trashChannelCurrent(id).then(...)` —— 目标为空时静默跳过，
       * 删不掉也不吭声；而且托盘态下 toast 根本看不见。删不掉又没有任何反馈，
       * 用户只能得出「热键不生效」这一个结论。这里把三条失败路径都补上说法。
       */
      if (!id) { notifyHotkey('没有可删除的目标：当前没有任何一路轮播', true); break; }
      const ch = scheduler.channels.get(id);
      const entry = ch && ch.files[ch.index];
      if (!entry) { notifyHotkey(`${channelLabel(id)} 现在没有图片，没什么可删的`, true); break; }

      const label = channelLabel(id);
      trashChannelCurrent(id).then((result) => {
        tray.refresh(scheduler.list());
        // 窗口可见时 performTrash 已经弹过 toast 了，别重复；藏进托盘才需要气泡
        if (isWindowVisible()) return;
        if (result.ok) {
          console.log(`[hotkey] 已移入回收站：${result.name}（${label}）`);
          tray.notify('壁纸切换器', `已移入回收站：${result.name}（${label}）`);
        } else if (!result.canceled) {
          console.log(`[hotkey] 删除失败：${result.error}`);
          tray.notify('壁纸切换器', `删除失败：${result.error}`);
        }
      });
      break;
    }
    case 'toggleWindow':
      toggleWindow();
      break;
    case 'info': {
      const ch = id ? scheduler.channels.get(id) : null;
      const entry = ch && ch.files[ch.index];
      if (!entry) { send('notice', { text: '当前没有可查看的图片', error: true }); break; }
      showWindow();
      send('info:open', { path: entry.path, channelId: id });
      break;
    }
    case 'reveal': {
      /*
       * 打开所在文件夹 —— 目标跟 next / delete / info 一样，是「当前操作的那块屏」。
       *
       * 这一条**不开主窗口**：用户想看的是文件管理器，把 App 一起翻出来只会挡路。
       * 也正因为不开窗，托盘态下（窗口藏着）必须靠气泡回话，不然按完热键
       * 只有资源管理器弹出来，用户不知道开的是哪块屏的那张图。
       */
      const ch = id ? scheduler.channels.get(id) : null;
      const entry = ch && ch.files[ch.index];
      if (!entry) { notifyHotkey('当前没有可打开的图片', true); break; }

      const label = channelLabel(id);
      const name = path.basename(entry.path);
      // 目录还在但图被挪走/删掉时，showItemInFolder 只会闷头打开那个目录 —— 先自己判
      if (!fs.existsSync(entry.path)) {
        notifyHotkey(`这张图已经不在了：${name}${label ? `（${label}）` : ''}`, true);
        break;
      }
      fileActions.openContainingFolder(entry.path).then((r) => {
        if (r.ok) notifyHotkey(`已在文件管理器中定位：${name}${label ? `（${label}）` : ''}`);
        else notifyHotkey(`打开失败：${r.error}`, true);
      });
      break;
    }
    default:
      break;
  }
}

/**
 * 按配置重新注册全部全局热键。
 * 返回 `{ registered, failed }`：失败的项要显示给用户（多半是被别的程序占了）。
 */
function applyHotkeys() {
  globalShortcut.unregisterAll();

  const cfg = store.get().hotkeys || {};
  const registered = {};
  const failed = [];

  for (const action of Object.keys(HOTKEY_ACTIONS)) {
    const accel = (cfg[action] || '').trim();
    if (!accel) continue;

    const valid = validateAccelerator(accel);
    if (!valid.ok) {
      failed.push({ action, accelerator: accel, reason: valid.reason });
      continue;
    }

    try {
      const ok = globalShortcut.register(accel, () => runHotkeyAction(action));
      if (ok) registered[action] = accel;
      else failed.push({ action, accelerator: accel, reason: '已被其它程序占用' });
    } catch (err) {
      failed.push({ action, accelerator: accel, reason: explainAcceleratorError(err.message, accel) });
    }
  }

  hotkeyStatus = { registered, failed };
  return hotkeyStatus;
}

/* ------------------------------------------------------------------ IPC */

/**
 * 组装 channels:changed 的载荷。
 *
 * 频道列表之外还要带上「配置派生」的开关：渲染层判断要不要画每屏卡片，
 * 看的是 state.perMonitor，而它只在收到带 perMonitor 的载荷时才更新。
 * 之前只发 { channels }，于是从设置面板切「统一配置 / 每屏独立」时
 * 卡片不会立刻出现或消失 —— 得等下一次 listChannels() 才补上。
 */
function channelBroadcast(payload = {}) {
  const cfg = store.get();
  return {
    ...payload,
    perMonitor: Boolean(cfg.perMonitor),
    applyToSystem: Boolean(cfg.applyToSystem),
    lastAutoScanAt: scheduler.lastAutoScanAt || 0,
  };
}

/**
 * 开箱即用：接了两块以上的屏、而且用户已经选好目录时，自动打开「每屏独立」。
 *
 * 只做判断和改配置，**不自己重建** —— 调用方紧接着就会重建，
 * 一次重建把「新配置 + 自动配置」一起生效，别白扫两遍目录。
 *
 * 为什么必须等「已选目录」—— 全新安装时 folder 是空的，这时候每块屏都是空频道，
 * 开了也看不到任何效果，只会让用户一头雾水。所以触发点是「第一次有目录 + 有多块屏」，
 * 不管是启动时读到的，还是用户刚在设置里选完目录。
 *
 * 只做一次（autoMonitorSetup 标记）。用户手动关掉之后不会再自动打开 —— 那叫抢方向盘。
 * 只有「真的检测到多屏」才会落标记，所以先单屏跑、后来接了第二块屏的机器还能补上。
 *
 * @returns {null|{monitors:number}} 真改了配置就返回信息，供界面提示一次
 */
function planAutoMonitorSetup() {
  const cfg = store.get();
  if (cfg.autoMonitorSetup === true) return null;
  // 还没绑任何相簿（顶层和每块屏都没有）→ 等配置好了再说
  const boundSomewhere = Boolean(cfg.albumId)
    || Object.values(cfg.monitors || {}).some((ov) => ov && ov.albumId);
  if (!boundSomewhere) return null;

  let monitors = [];
  try {
    monitors = listMonitors().monitors || [];
  } catch {
    return null;                                 // 枚举不了就先不动，下次再说
  }
  if (monitors.length < 2) return null;           // 单屏：不落标记，等接了第二块屏再来

  if (cfg.perMonitor) {
    // 用户自己已经开过了（或本来就开着）—— 只补标记，别重复改配置
    store.set({ autoMonitorSetup: true });
    return null;
  }

  store.set({ perMonitor: true, autoMonitorSetup: true });
  return { monitors: monitors.length };
}

/**
 * 自动配置完成后提示一次。
 *
 * 启动那一次刻意走托盘气泡而不是界面 toast：`createWindow()` 之后渲染层可能还没加载完，
 * 这时 `send()` 过去的事件会被丢掉，用户就什么提示都看不到了。
 * 改配置那一次渲染层肯定活着，走 toast 更贴合操作位置。
 */
function announceAutoSetup(info, viaBalloon = false) {
  if (!info) return;
  const content = `检测到 ${info.monitors} 块显示器，已自动打开「每屏独立」。`
    + '每块屏可以有自己的目录和间隔，在设置面板里逐块调整。';
  if (!viaBalloon && mainWindow && mainWindow.isVisible()) {
    send('monitors:auto-setup', info);
    return;
  }
  tray.notify('已为每块屏建立独立轮播', content);
}

/**
 * 只影响界面、跟轮播无关的配置键。
 *
 * 这些键走的是同一条 config:set，但改它们不该把频道重建一遍 ——
 * 比如点一下设置面板的分类标签就重建，等于每点一次都重新扫一遍相簿、重排定时器。
 */
const UI_ONLY_KEYS = ['settingsTab', 'swipeSwitch'];

/** 改动配置后统一走这里重建，保证「改完立刻生效」 */
/* ---------------------------------------------------------------- 全屏暂停（阶段 3） */

/**
 * 全屏 / 挂机暂停轮询：随动态桌面启停。
 * 开关实时读配置（轮询每轮 getFlags），用户在 UI 里改 pauseOn* 不用重启。
 */
function startFullscreenWatch() {
  // hideOnPaused：暂停藏窗开关（52 轮，默认关；独占全屏游戏防驱动挂死）
  liveStage.setPauseHide(((store && store.get().liveStage) || {}).hideOnPaused === true);
  fullscreenWatch.start({
    getFlags: () => {
      const st = (store && store.get()) || {};
      const ls = st.liveStage || {};
      // 每屏覆盖：monitors[displayId].pauseOnFullscreen（undefined = 跟全局）
      const perDisplay = {};
      for (const [did, mo] of Object.entries(st.monitors || {})) {
        if (mo && typeof mo === 'object' && mo.pauseOnFullscreen !== undefined) {
          perDisplay[did] = { pauseOnFullscreen: Boolean(mo.pauseOnFullscreen) };
        }
      }
      return {
        pauseOnFullscreen: ls.pauseOnFullscreen !== false,
        pauseOnAway: ls.pauseOnLock !== false,
        perDisplay,
        // 电池暂停（主树 48/58 轮）：kernel32 GetSystemPowerStatus 直查 ACLineStatus，
        // 查不到（无电池/异常）退回 Electron 缓存值
        battery: (() => {
          const b = fullscreenWatch.isOnBattery();
          if (b != null) return b;
          try { return powerMonitor.isOnBatteryPower(); } catch { return false; }
        })(),
        pauseOnBattery: ls.pauseOnBattery === true,
        // 挂机/熄屏暂停（主树 57 轮）：纯熄屏不触发 QUNS，靠无输入超时兜底
        pauseOnIdle: ls.pauseOnIdle !== false,
        idlePauseSeconds: Math.max(0, Number(ls.idlePauseMinutes) || 0) * 60,
        idleSec: (() => { try { return powerMonitor.getSystemIdleTime(); } catch { return 0; } })(),
      };
    },
    onTick: ({ pausedIds, away, reasons }) => {
      // 手动暂停（桌面右键「暂停/继续壁纸」）在 broadcastPauseState 里并集：
      // fullscreenWatch 每 2s 重发全量状态，必须在这里合并才不会被覆盖掉。
      broadcastPauseState(pausedIds, away, reasons);
    },
  });
}

function stopFullscreenWatch() {
  fullscreenWatch.stop();
  broadcastPauseState([], false, {});   // 兜底解冻（手动暂停集保留，继续生效）
}

/* ---------------------------------------------------------------- 深度预取 */

/** 深度预取只认图片（视频/网页没有深度一说） */
const DEPTH_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const DEPTH_PREFETCH_AHEAD = 2;

/**
 * 空闲预取（第十一轮）：每次切图后，把每个频道接下来要显示的前两张的深度
 * 提前喂给 depthService。队列空了才派活（不跟「正在看的那张」抢优先级），
 * 已缓存/非图片自动跳过 —— 具体纪律都在 depthService.prefetch 里。
 */
function prefetchUpcomingDepths() {
  try {
    if (!scheduler) return;
    for (const ch of scheduler.list()) {
      if (!ch.count) continue;
      const files = scheduler.files(ch.id);
      if (!files.length) continue;
      for (let k = 1; k <= DEPTH_PREFETCH_AHEAD; k++) {
        const ent = files[(ch.index + k) % files.length];
        const p = ent && ent.path;
        if (!p || !DEPTH_IMAGE_EXTS.has(path.extname(p).toLowerCase())) continue;
        depthService.prefetch(p);
      }
    }
  } catch (err) {
    console.warn('[depth-prefetch]', err.message);
  }
}

async function applyConfigChange(patch) {
  const keys = Object.keys(patch || {});
  const uiOnly = keys.length > 0 && keys.every((key) => UI_ONLY_KEYS.includes(key));
  const hadHotkeys = patch && Object.prototype.hasOwnProperty.call(patch, 'hotkeys');
  const liveBefore = Boolean(store.get().liveWallpaper);
  store.set(patch);
  // 纯界面状态：写盘就够了，别惊动调度器
  if (uiOnly) return store.get();
  // 先把「要不要自动开每屏独立」定下来，再重建 —— 一次重建就全生效
  const auto = planAutoMonitorSetup();
  await scheduler.rebuild('config');
  // hideOnPaused / pauseOn* 改动实时生效（轮询还开着时也要立刻跟上新设置）
  // （60~72 轮重构丢了这整块 → 全屏/锁屏暂停监控从未启动，2026-10-09 恢复）
  if (keys.includes('liveStage')) {
    // hideOnPaused 改动实时生效（藏窗与否读的是这里的运行态）
    liveStage.setPauseHide(((store && store.get().liveStage) || {}).hideOnPaused === true);
    if (store.get().liveWallpaper) {
      startFullscreenWatch();
      liveStage.syncTo(scheduler.list());
    }
  }
  // 从设置面板整体写配置时也要让热键生效（单独改热键走 hotkeys:set）
  if (hadHotkeys) applyHotkeys();
  announceAutoSetup(auto);

  // 动态桌面开关：只在它变化时启停（改别的配置不惊动它，避免无谓的窗口重建）
  const liveAfter = Boolean(store.get().liveWallpaper);
  if (liveBefore !== liveAfter) {
    if (liveAfter) {
      liveStage.start();
      liveStage.syncTo(scheduler.list());
      // 暂停轮询（57 轮起常驻，不随动态桌面启停）：开着也无妨，start 幂等
      startFullscreenWatch();
    } else {
      liveStage.stop();
      // 关掉动态桌面：系统壁纸还停在最后一次锚点图 → 补写当前帧
      // （reason='stop' 在锚点白名单里，必定真写，见 liveDesktop.js）
      scheduler.anchorSystem().catch((err) => console.warn('[live-stage] 停止补写失败:', err.message));
    }
  }
  return store.get();
}

/** 频道命令的单一入口 —— IPC 与托盘菜单共用同一份实现 */
async function runChannelCommand(id, command, payload) {
  switch (command) {
    case 'next': await scheduler.step(id, 1); break;
    case 'prev': await scheduler.step(id, -1); break;
    case 'goto': await scheduler.goTo(id, Number(payload && payload.index) || 0, 1, 'goto'); break;
    case 'play': scheduler.setPlaying(id, true); break;
    case 'pause': scheduler.setPlaying(id, false); break;
    case 'toggle-play': {
      const ch = scheduler.channels.get(id);
      scheduler.setPlaying(id, ch ? !ch.playing : true);
      break;
    }
    case 'set-profile': return setChannelProfile(id, payload || {});
    case 'rescan': await scheduler.rescan(id); break;
    default: return { ok: false, error: `未知命令: ${command}` };
  }
  return { ok: true, channels: scheduler.list() };
}

function registerIpc() {
  ipcMain.handle('config:get', () => store.get());
  // 舞台置顶吃掉了桌面右键：渲染端捕获后转发 DefView 弹原生菜单（见 liveStage）
  ipcMain.handle('desktop:context-menu', (_e, x, y) => liveStage.showDesktopContextMenu(x, y));
  // 菜单是模态的、等不到舞台上的点击：任何按下时由渲染端通知这里解除
  ipcMain.handle('desktop:cancel-context-menu', () => liveStage.cancelDesktopMenu());
  ipcMain.handle('config:set', (_e, patch) => applyConfigChange(patch || {}));
  // videoPlayFull（视频播完再切）：舞台渲染端视频 ended / 加载失败时推进频道。
  // advanced=false（暂停中 / 当前已不是视频）时渲染端原地重播，视频不会停在最后一帧。
  ipcMain.on('stage:log', (_e, msg) => {
    debugLog.dlog('stage', msg);
  });

  ipcMain.handle('stage:video-ended', async (_e, channelId) => {
    if (!scheduler || typeof channelId !== 'string') return { advanced: false };
    const next = await scheduler.videoEnded(channelId);
    return { advanced: Boolean(next) };
  });

  // 深度视差：查深度 sidecar（命中→路径；未命中→入队后台生成并返回 null）
  ipcMain.handle('depth:lookup', (_e, imagePath) => {
    try { return depthService.lookup(imagePath); } catch { return null; }
  });

  // ---- 频道 ----

  ipcMain.handle('channels:list', () => {
    const monitorInfo = listMonitors();
    return {
      channels: scheduler.list(),
      perMonitor: Boolean(store.get().perMonitor),
      backend: win32.backendName(),
      platform: process.platform,
      applyToSystem: Boolean(store.get().applyToSystem),
      monitors: monitorInfo.monitors,
      monitorsError: monitorInfo.error || scheduler.lastEnumError,
      // 定时自动扫描的「上次扫描时刻」——渲染层在设置里显示（0 = 本次会话还没扫过）
      lastAutoScanAt: scheduler.lastAutoScanAt || 0,
      globalWallpaper: win32.getCurrentWallpaper(),
      windowMonitorId: (() => {
        const hwnd = currentHwnd();
        if (hwnd === null) return null;
        const rect = desktopWallpaper.windowMonitorRect(hwnd);
        return desktopWallpaper.monitorIdForRect(rect);
      })(),
    };
  });

  ipcMain.handle('channel:files', (_e, id) => {
    const ch = scheduler.channels.get(id);
    return {
      id,
      files: scheduler.files(id),
      index: ch ? ch.index : 0,
      rev: ch ? ch.rev : 0,
      truncated: ch ? Boolean(ch.truncated) : false,
      scanMs: ch ? ch.scanMs : 0,
      error: ch ? ch.lastError : null,
      played: scheduler.playedIndices(id),
    };
  });

  ipcMain.handle('channel:command', (_e, id, command, payload) => runChannelCommand(id, command, payload));

  /** 忽略 applyToSystem 开关，强制把当前帧写到该频道对应的屏幕 */
  ipcMain.handle('channel:apply', async (_e, id) => {
    const ch = scheduler.channels.get(id);
    if (!ch) return { ok: false, error: '频道不存在' };
    const entry = ch.files[ch.index];
    if (!entry) return { ok: false, error: '该频道还没有图片' };

    const target = ch.kind === 'monitor' && ch.monitor
      ? { monitorId: ch.monitor.id, label: ch.monitor.label }
      : resolveUnifiedTarget();

    const result = await win32.setWallpaper(entry.path, CACHE_DIR, { monitorId: target.monitorId });
    ch.lastWrite = { ...result, at: Date.now(), reason: 'manual', monitorId: target.monitorId, monitorLabel: target.label };
    ch.lastError = result.ok ? null : (result.error || result.method);
    return { ...result, monitorId: target.monitorId, monitorLabel: target.label, name: entry.name };
  });

  ipcMain.handle('channels:rebuild', async (_e, forgetScanCache = false) => {
    if (forgetScanCache) scheduler.scanCache.clear();
    await scheduler.rebuild('manual');
    return { channels: scheduler.list() };
  });

  // ---- 目录与文件 ----

  // 「上次选择的目录」记忆：选完目录记下来，下次打开选目录框直接落在原地。
  // 存独立小文件而不进 config.json —— 纯 UI 便利状态，不值得进带 schema 的配置
  const lastPickFile = () => path.join(app.getPath('userData'), 'last-pick.json');
  function readLastPickDir() {
    try {
      const d = JSON.parse(fs.readFileSync(lastPickFile(), 'utf8')).dir;
      return typeof d === 'string' && fs.existsSync(d) ? d : null;   // 目录没了（盘被拔了）就当没记过
    } catch { return null; }
  }
  function saveLastPickDir(dir) {
    try { fs.writeFileSync(lastPickFile(), JSON.stringify({ dir, at: Date.now() })); } catch { /* 记不住不影响主流程 */ }
  }

  /**
   * 为某一路频道选目录：选中的目录**加入该频道绑定的相簿**（没有相簿就建一个）。
   * 支持多选 —— 一次勾几个目录全部收进相簿，正是相簿功能的日常用法。
   * 相同目录已在相簿里时会跳过并提示，不会收两份。
   */
  ipcMain.handle('folder:pick', async (_e, channelId) => {
    const ch = channelId ? scheduler.channels.get(channelId) : null;
    const cfg = store.get();
    const currentAlbum = findAlbum(cfg, ch ? ch.profile.albumId : cfg.albumId);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: ch ? `为「${ch.label}」添加图片目录` : '添加图片目录',
      defaultPath: readLastPickDir()
        || (currentAlbum && currentAlbum.folders.length ? currentAlbum.folders[0].path : undefined),
      properties: ['openDirectory', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    saveLastPickDir(result.filePaths[0]);

    let album = currentAlbum;
    if (!album) {
      // 频道还没绑相簿：建一个，名字取第一个目录名，绑上再收目录
      album = {
        id: newAlbumId(),
        name: path.basename(result.filePaths[0]) || '我的相簿',
        folders: [],
      };
      store.set({ albums: [...(cfg.albums || []), album] });
      await setChannelProfile(channelId || UNIFIED_ID, { albumId: album.id });
    }

    const folders = album.folders.map((f) => f.path);
    const added = [];
    const skipped = [];
    for (const p of result.filePaths) {
      const hit = folders.some((existing) => existing.toLowerCase() === p.toLowerCase());
      if (hit) skipped.push(p);
      else { folders.push(p); added.push(p); }
    }

    if (added.length) {
      album.folders = folders.map((p) => ({ path: p, enabled: true }));
      store.set({ albums: [...(store.get().albums || []).filter((a) => a.id !== album.id), album] });
      await scheduler.rebuild('album');
      send('albums:changed', { albums: store.get().albums });
    }

    if (skipped.length) {
      send('notice', {
        text: added.length
          ? `已加入 ${added.length} 个目录；${skipped.length} 个已在相簿里，跳过`
          : '所选目录已经在这个相簿里了',
      });
    } else if (added.length) {
      send('notice', { text: `已加入相簿「${album.name}」：${added.map((p) => path.basename(p)).join('、')}` });
    }
    return added[0] || null;
  });

  // ---- 相簿管理 ----

  ipcMain.handle('album:list', () => (store.get().albums || []).map((a) => ({ ...a, cover: albumCoverPath(a) })));

  /**
   * 相簿封面：第一个启用目录在扫描缓存里的第一张图。
   * 只查缓存不做额外扫盘 —— 还没被任何频道用过的相簿先没有封面，
   * 等它被绑定并扫过一次后自然就有了。相簿选择器里的一眼可辨靠它。
   */
  function albumCoverPath(album) {
    for (const f of album.folders) {
      if (f.enabled === false) continue;
      for (const recursive of [1, 0]) {
        const cached = scheduler && scheduler.scanCache.get(`${f.path}::${recursive}`);
        if (cached && cached.files.length) return cached.files[0].path;
      }
    }
    return null;
  }

  /** 纯选目录对话框（不改配置）：相簿管理区「往相簿里加目录」用，支持多选 */
  ipcMain.handle('album:pick-dirs', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要加入相簿的图片目录',
      defaultPath: readLastPickDir() || undefined,
      properties: ['openDirectory', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    saveLastPickDir(result.filePaths[0]);
    return result.filePaths;
  });

  ipcMain.handle('album:create', (_e, name) => {
    const album = { id: newAlbumId(), name: (name || '').trim() || '新相簿', folders: [] };
    store.set({ albums: [...(store.get().albums || []), album] });
    send('albums:changed', { albums: store.get().albums });
    return album;
  });

  /**
   * 全量更新一个相簿（name / folders）， folders 由界面组装好整包传上来。
   * 改完重建：目录增删、启用开关、排序都会改变频道的文件列表；
   * scheduler 对「同一相簿」会复用既有随机顺序并把新目录追加到末尾，正在看的不受影响。
   */
  ipcMain.handle('album:update', async (_e, id, patch) => {
    const albums = (store.get().albums || []).map((a) => {
      if (a.id !== id) return a;
      const next = { ...a };
      if (patch && typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
      if (patch && Array.isArray(patch.folders)) {
        next.folders = patch.folders
          .filter((f) => f && typeof f.path === 'string' && f.path.trim())
          .map((f) => ({ path: f.path.trim(), enabled: f.enabled !== false }));
      }
      return next;
    });
    store.set({ albums });
    await scheduler.rebuild('album');
    send('albums:changed', { albums: store.get().albums });
    return { ok: true, albums: store.get().albums };
  });

  /**
   * 删除相簿：绑在它上面的频道（顶层 + 每块屏）解绑成「未选择相簿」，
   * 不连带删别的相簿、不碰磁盘上的图片。解绑后频道无图可播，卡片会显示空态。
   */
  ipcMain.handle('album:delete', async (_e, id) => {
    const albums = (store.get().albums || []).filter((a) => a.id !== id);
    const patch = { albums };
    if (store.get().albumId === id) patch.albumId = '';
    const monitors = { ...(store.get().monitors || {}) };
    let monitorTouched = false;
    for (const [mid, ov] of Object.entries(monitors)) {
      if (ov && ov.albumId === id) { monitors[mid] = { ...ov, albumId: '' }; monitorTouched = true; }
    }
    if (monitorTouched) patch.monitors = monitors;
    store.set(patch);
    await scheduler.rebuild('album');
    send('albums:changed', { albums: store.get().albums });
    return { ok: true, albums: store.get().albums };
  });

  ipcMain.handle('image:probe', async (_e, imagePath) => {
    const stat = await probeFile(imagePath);
    const size = readImageSize(imagePath);
    return { ...stat, ...(size || {}) };
  });

  /** 完整图片信息（EXIF 面板） */
  ipcMain.handle('image:info', (_e, imagePath) => readImageInfo(imagePath));

  ipcMain.handle('shell:reveal', (_e, imagePath) => {
    shell.showItemInFolder(imagePath);
    return true;
  });

  // ---- 文件操作 ----

  ipcMain.handle('file:stats', (_e, imagePath) => fileActions.fileStats(imagePath));
  // 和右键菜单走同一套编排：大图用快路，并且先报进度再干活
  // （渲染层自绘菜单将来若启用，也不需要再各自实现一遍）
  ipcMain.handle('file:copy-image', (_e, imagePath) => fileActions.copyImageWithNotice(
    imagePath,
    (text) => send('notice', { text }),
  ));
  ipcMain.handle('file:copy-file', (_e, imagePath) => fileActions.copyFile(imagePath));
  ipcMain.handle('file:copy-path', (_e, imagePath) => fileActions.copyText(imagePath));
  // 右键菜单里已经不放「用默认程序打开」了，但信息面板和「打开目录」还在用这条通道
  ipcMain.handle('file:open', (_e, imagePath) => fileActions.openExternally(imagePath));
  ipcMain.handle('file:open-folder', (_e, imagePath) => fileActions.openContainingFolder(imagePath));
  /** 系统的「打开方式」对话框（另起 rundll32 画，不卡主进程消息循环） */
  ipcMain.handle('file:open-with-dialog', (_e, imagePath) => fileActions.openWithDialog(imagePath));
  ipcMain.handle('file:trash', (_e, imagePath) => trashWithPermission(imagePath));

  /* 「用其他程序打开」的程序列表 —— 右键子菜单与设置面板共用这一套 */

  ipcMain.handle('open-with:list', () => store.get().openWith || []);

  ipcMain.handle('open-with:add', (_e, programPath) => {
    if (!programPath) return { ok: false, error: '没有指定程序' };
    const list = [...(store.get().openWith || [])];
    if (!list.includes(programPath)) list.push(programPath);
    store.set({ openWith: list });
    send('open-with:changed', { programs: list });
    return { ok: true, programs: list };
  });

  ipcMain.handle('open-with:remove', (_e, programPath) => {
    const list = (store.get().openWith || []).filter((p) => p !== programPath);
    store.set({ openWith: list });
    send('open-with:changed', { programs: list });
    return { ok: true, programs: list };
  });

  ipcMain.handle('open-with:clear', () => {
    store.set({ openWith: [] });
    send('open-with:changed', { programs: [] });
    return { ok: true, programs: [] };
  });

  ipcMain.handle('open-with:launch', (_e, programPath, imagePath) =>
    fileActions.launchWith(programPath, imagePath));

  /**
   * 带确认的删除（旧入口，保留兼容）。
   *
   * 现在确认逻辑已经统一进 trashWithPermission —— 开关关掉时它也一样直接删，
   * 所以这条和 `file:trash` 行为完全一致，不再有「有的入口问、有的不问」。
   */
  ipcMain.handle('file:trash-confirm', (_e, imagePath) => trashWithPermission(imagePath));
  ipcMain.handle('file:transfer', (_e, imagePath, targetDir, mode) => performTransfer(imagePath, targetDir, mode));

  /* ---- 桌面右键菜单（注册表集成）---- */

  /** 现状：装在不在、命令行是不是我们期望的那条（换过安装目录会 stale） */
  ipcMain.handle('shell:desktop-menu-status', () => shellMenu.statusAll());
  /**
   * 装上 / 卸掉。都是 HKCU，不需要管理员权限。
   * 不带 key 就是整组一起动（设置面板那个总开关走这条）。
   */
  ipcMain.handle('shell:desktop-menu-set', (_e, on, key = null) => {
    const result = on
      ? (key ? shellMenu.installItem(key) : shellMenu.installAll())
      : (key ? shellMenu.uninstallItem(key) : shellMenu.uninstallAll());
    if (!result.ok) send('notice', { text: `桌面右键菜单设置失败：${result.error}`, error: true });
    return { ...result, status: shellMenu.statusAll() };
  });

  /** 渲染层自绘菜单时的入口（当前用原生菜单，保留以便换实现） */
  ipcMain.on('context:image-menu', (_e, payload) => showImageMenu(payload || {}));

  /**
   * 只给验证脚本用：把右键菜单模板取出来核对。
   * 不弹菜单是为了避免验证过程在用户桌面上留一个悬停的菜单，
   * 而菜单项是否齐全、是否都接上了 click，光看代码是看不出来的。
   */
  ipcMain.handle('context:image-menu-template', (_e, payload) => {
    const template = buildImageMenuTemplate(payload || {});
    return template ? describeMenuTemplate(template) : null;
  });

  // ---- 预设文件夹 ----

  ipcMain.handle('quick:list', () => store.get().quickFolders || []);
  ipcMain.handle('quick:pick', async () => {
    const folder = await fileActions.pickFolderForQuick(mainWindow);
    if (!folder) return null;
    const r = await addQuickFolder(folder.path, folder.name);
    if (!r.ok) return { error: r.error };
    return { folders: r.folders, folder: r.folder };
  });
  ipcMain.handle('quick:add', (_e, folderPath, name) => addQuickFolder(folderPath, name));
  ipcMain.handle('quick:remove', (_e, id) => {
    const folders = (store.get().quickFolders || []).filter((f) => f.id !== id);
    store.set({ quickFolders: folders });
    return folders;
  });
  ipcMain.handle('quick:rename', (_e, id, name) => {
    const folders = (store.get().quickFolders || []).map((f) => (f.id === id ? { ...f, name } : f));
    store.set({ quickFolders: folders });
    return folders;
  });

  // ---- 缩略图 ----

  ipcMain.handle('thumbs:stats', () => thumbnails.stats());
  ipcMain.handle('thumbs:prune', () => thumbnails.pruneCache());
  ipcMain.handle('thumbs:clear', async () => {
    await thumbnails.clearCache();
    return thumbnails.stats();
  });

  // ---- 托盘与开机自启 ----

  ipcMain.handle('tray:state', () => ({
    installed: tray.isInstalled(),
    launchAtLogin: tray.getLaunchAtLogin(),
    loginCommand: `${process.execPath} ${tray.loginArgs().join(' ')}`,
  }));
  ipcMain.handle('tray:set-launch-at-login', (_e, enabled) => {
    const result = tray.setLaunchAtLogin(enabled);
    store.set({
      launchAtLogin: result.ok
        ? Boolean(result.launchAtLogin)
        : Boolean(enabled),
    });
    tray.refresh(scheduler.list());
    return result;
  });

  // ---- 全局热键 ----

  ipcMain.handle('hotkeys:get', () => ({
    actions: HOTKEY_ACTIONS,
    hotkeys: store.get().hotkeys || {},
    registered: hotkeyStatus.registered,
    failed: hotkeyStatus.failed,
  }));

  /**
   * 写入并立即重注册。
   * patch 里值为空串表示解绑；返回注册结果，失败的项（被占用）由界面回显。
   */
  ipcMain.handle('hotkeys:set', (_e, patch) => {
    store.set({ hotkeys: patch || {} });
    const status = applyHotkeys();
    const cfg = store.get().hotkeys || {};

    if (status.failed.length) {
      send('notice', {
        text: `有 ${status.failed.length} 个热键没注册上：${status.failed.map((f) => `${HOTKEY_ACTIONS[f.action] || f.action}（${f.reason}）`).join('、')}`,
        error: true,
      });
    } else {
      const bound = Object.values(cfg).filter(Boolean);
      send('notice', { text: bound.length ? `已保存 ${bound.length} 个全局热键` : '已清空全部全局热键' });
    }

    return { ok: true, hotkeys: cfg, registered: status.registered, failed: status.failed };
  });

  /**
   * 交给验证脚本用：不按键、直接触发某个热键动作，
   * 用来把「动作本身对不对」和「按键能不能送达」这两件事分开验证。
   */
  ipcMain.handle('hotkeys:invoke', (_e, action) => {
    if (!HOTKEY_ACTIONS[action]) return { ok: false, error: `未知动作: ${action}` };
    runHotkeyAction(action);
    return { ok: true, target: hotkeyTargetChannelId() };
  });

  /** 渲染层上报「现在预览的是哪一路」—— 热键要作用于它 */
  ipcMain.on('preview:set', (_e, id) => {
    currentPreviewId = typeof id === 'string' ? id : null;
  });

  /** 取托盘菜单的结构（不弹菜单），给验证脚本核对 */
  ipcMain.handle('tray:menu-template', () => tray.menuTemplate());

  // ---- 窗口 ----

  ipcMain.handle('app:free-memory', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.session.clearCodeCaches({});
    }
    try {
      const stale = fs.readdirSync(CACHE_DIR)
        .filter((f) => f.startsWith('wp-'))
        .map((f) => path.join(CACHE_DIR, f))
        .filter((f) => Date.now() - fs.statSync(f).mtimeMs > 3600_000);
      for (const f of stale) fs.unlinkSync(f);
    } catch { /* 缓存清理失败不影响主流程 */ }
    const mem = process.memoryUsage();
    return { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) };
  });

  ipcMain.handle('window:fullscreen', () => {
    if (!mainWindow) return false;
    const next = !mainWindow.isFullScreen();
    mainWindow.setFullScreen(next);
    return next;
  });

  ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('window:close', () => mainWindow && mainWindow.close());
  ipcMain.on('window:hide', () => mainWindow && mainWindow.hide());
  ipcMain.on('window:show', () => showWindow());
}

/**
 * 改一路频道的配置。
 *   统一频道 → 写顶层字段
 *   显示器频道 → 写 monitors[设备路径]，只存与顶层不同的差异
 */
async function setChannelProfile(channelId, patch) {
  if (!channelId || channelId === UNIFIED_ID) {
    store.set(patch);
  } else {
    store.setMonitorProfile(channelId, patch);
  }
  /*
   * 首次运行「选文件夹」走的正是这条路（`folder:pick` → 这里），而不是 config:set。
   * 所以自动开「每屏独立」的机会必须在这里也给一次 ——
   * 只在 applyConfigChange 里挂的话，用户从没改过任何设置，就永远触发不到。
   */
  const auto = planAutoMonitorSetup();
  await scheduler.rebuild('profile');
  announceAutoSetup(auto);
  return { ok: true, channels: scheduler.list(), config: store.get() };
}

/* ------------------------------------------------------------------ 生命周期 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  /*
   * 这个进程只是「来转交一个开关的」，要立刻死掉。
   *
   * 用 app.exit 而不是 app.quit：桌面右键菜单那条注册表命令点一下就起一个进程，
   * ready 之前的 quit 会走一遍正常的退出流程（实测能吊住 30 秒不退出，
   * 每次点菜单都留一个僵尸进程），exit 是直接终止，这里没有需要收尾的东西。
   */
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    // 桌面右键菜单那条注册表命令：第二个进程只为转交一个开关，
    // 别把窗口翻出来打断用户（他正在看桌面）。
    const item = shellMenu.itemFromArgv(argv);
    if (item) {
      runDesktopMenuAction(item).catch((err) => console.error('[desktop-menu]', err.message));
      return;
    }
    showWindow();
  });

  app.whenReady().then(async () => {
    store = new Store(path.join(app.getPath('userData'), 'config.json'));

    /*
     * 播放位置存档：跟配置文件放同一个目录，但**是独立文件**。
     * 它每次换图都要写（间隔可能只有几秒），而 config.json 是「配置」——
     * 高频状态混进配置会让 diff 全是噪声，也容易跟用户手改配置撞车。
     */
    playback = new PlaybackState(path.join(app.getPath('userData'), 'playback.json'));

    // 缩略图缓存目录可配置（用户想把缓存放到别的盘就用 thumbCacheDir）
    thumbnails.configure({
      dir: store.get().thumbCacheDir || undefined,
      size: store.get().thumbSize,
    });
    thumbnails.handleProtocol();
    stageProtocol.handleProtocol();   // wpimg:// 动态桌面的原图通道（no-store）

    // 深度视差（按需生成 + 集中缓存，fail-soft 降级）：缓存目录可配置
    // （config.depthCacheDir，想放 F 盘就写 "F:\\壁纸\\.depth-cache"）；
    // Python/模型目录同理（depthPython / depthModelDir）。默认值见 depthService.js。
    debugLog.init(path.join(app.getPath('userData'), 'logs'));
    depthService.configure({
      cacheDir: store.get().depthCacheDir || path.join(app.getPath('userData'), 'depth-cache'),
      python: store.get().depthPython,
      modelDir: store.get().depthModelDir,
      onReady: (imagePath) => {
        // 现场升级：正在显示这张图的舞台立刻从 2D 切视差
        send('depth:ready', { path: imagePath });
        liveStage.broadcast('depth:ready', { path: imagePath });
      },
    });

    // 视频优化转码（遇到才转）：协议层在服务视频前会调 resolveForPlayback，
    // 这里只负责接上配置。getter 每次现取 config —— 改配置不用重启。
    videoOptimize.configure({ getConfig: () => store.get() });
    // 启动 10 分钟后清一次缓存：源已删除的副本跟着删、孤儿/半成品兜底、超容量 LRU
    setTimeout(() => {
      videoOptimize.cleanup().catch((e) => console.warn('[video-optimize] 清理失败:', e.message));
    }, 10 * 60 * 1000);

    scheduler = new MonitorScheduler({
      store,
      cacheDir: CACHE_DIR,
      playback,
      // 动态舞台降级（挂载失败/被拆且救不回来）时，调度器恢复「每轮都写系统壁纸」
      isLiveDegraded: () => liveStage.isDegraded(),
      // 暂停感知：被冻结（全屏/挂机）的显示器不推进轮播（2026-10-09，
      // 修复「暂停期间 index 走了、恢复后右键删除删到没显示过的图」）。
      // ⚠️ 调度器传进来的是频道 id（设备路径），必须先换算成 Electron
      // displayId 再查暂停集 —— 原样查永远 false，感知形同虚设。
      isPaused: (monitorId) => {
        if (monitorId === UNIFIED_ID) return liveStage.anyDisplayPaused();
        const did = monitorPathToDisplayId(monitorId);
        return did != null ? liveStage.isPausedForDisplay(did) : false;
      },
      enumerate: () => {
        const info = listMonitors();
        return { ok: info.ok, error: info.error, monitors: info.monitors };
      },
      resolveUnifiedTarget,
      onEvent: (type, payload) => {
        if (type === 'tick') {
          console.log(`[tick-bus] tick id=${payload.id} index=${payload.index}/${payload.count}`);
          send('channel:tick', payload);
          // stage 窗口也收全量 tick，各自按频道 id 过滤（每块屏只听自己的频道）
          liveStage.broadcast('channel:tick', payload);
          tray.refresh(scheduler.list());
          prefetchUpcomingDepths();
        } else {
          console.log(`[tick-bus] ${type} reason=${payload.reason} channels=${(payload.channels || []).length}`);
          const broadcast = channelBroadcast(payload);
          send('channels:changed', broadcast);
          liveStage.broadcast('channels:changed', broadcast);
          liveStage.syncTo(payload.channels || scheduler.list());
          tray.refresh(payload.channels || scheduler.list());
        }
      },
    });

    buildMenu();
    registerIpc();
    createWindow();

    if (store.get().tray !== false) installTray();

    // 全局热键：窗口藏进托盘也要能切壁纸，所以注册在主进程
    const hotkeys = applyHotkeys();
    if (hotkeys.failed.length) {
      console.warn('[hotkeys] 以下热键没注册上:', hotkeys.failed.map((f) => `${f.accelerator}(${f.reason})`).join(', '));
      /*
       * 以前只写了 console.warn —— 打包版没有控制台，用户看不到。
       * 于是「设置里明明绑着、按下去没反应」就成了一个无解的谜。
       * 启动这次走托盘气泡（跟 announceAutoSetup 同一套做法）。
       */
      const names = hotkeys.failed
        .map((f) => `${HOTKEY_ACTIONS[f.action] || f.action}（${f.reason}）`)
        .join('、');
      if (store.get().tray !== false) {
        tray.notify('有全局热键没注册上', `${names}\n多半是被别的程序占用了，换一个组合即可。`);
      }
    }

    // 老用户换到多屏机器、或本来就有多屏但还没配过 —— 启动时补一次自动配置
    const autoAtStartup = planAutoMonitorSetup();
    await scheduler.rebuild('startup');
    announceAutoSetup(autoAtStartup, true);
    thumbnails.pruneCache().catch(() => {});

    // 动态桌面：配置开着就随应用启动（窗口在这里创建并挂到桌面图标下面）
    if (store.get().liveWallpaper) {
      liveStage.start();
      liveStage.syncTo(scheduler.list());
      // 全屏/锁屏暂停轮询（57 轮起常驻）。⚠️ 60~72 轮重构丢了这行 → 暂停系统
      // 整个没启动（2026-10-09 从日志与调用点对拍实锤），恢复。
      startFullscreenWatch();
    }

    // 桌面手势切壁纸（54 轮追记五）：横向拖拽/触摸横扫。不依赖动态桌面 ——
    // 静态系统壁纸模式同样能切（scheduler.step 会写系统壁纸）。
    // ⚠️ 60~72 轮重构把 swipeWatch 整个删了（含设置开关），2026-10-09 恢复。
    swipeWatch.start({
      getEnabled: () => store.get().swipeSwitch !== false,
      onSwipe: (dir, pt) => {
        stepWallpaperAt(pt, dir === 'next' ? 1 : -1).catch((err) => {
          console.warn('[swipe] 切换失败:', err.message);
        });
      },
    });

    /*
     * 桌面右键菜单点下去时 App 可能没在跑（比如开机后还没启动过）。
     * 那条注册表命令会把这个进程拉起来，起来之后得把事补办 ——
     * 否则用户点完菜单，程序是开了，图没换，比不装还费解。
     *
     * 这一趟是「替菜单跑腿」，不是用户想开这个程序：窗口不显示（见 createWindow
     * 的 startHidden），办完就退，别留一个谁也没叫它起的常驻进程。
     * 延迟一下等频道扫描完（动作要知道那块屏现在放的是哪张）。
     */
    const startupItem = shellMenu.itemFromArgv(process.argv);
    if (startupItem) {
      setTimeout(() => {
        runDesktopMenuAction(startupItem)
          .catch((err) => console.error('[desktop-menu]', err.message))
          .finally(() => app.quit());
      }, 800);
    }

    // 插拔显示器 / 改分辨率后要重建频道；派发事件很密集，节流一下
    let settle = null;
    const notifyMonitorsChanged = () => {
      clearTimeout(settle);
      settle = setTimeout(async () => {
        await scheduler.rebuild('display');
        send('monitors:changed', { channels: scheduler.list() });
      }, 600);
    };
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(event, notifyMonitorsChanged);
    }

    // 系统里的自启状态和配置可能不一致（用户在别处改过），启动时对齐一次
    const actualLogin = tray.getLaunchAtLogin();
    if (Boolean(store.get().launchAtLogin) !== actualLogin) {
      store.set({ launchAtLogin: actualLogin });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  /*
   * 退出前的锚点补写（方案 A 降频写的收尾）：
   * 动态桌面开着时系统壁纸只在锚点时机写 —— 退出就是最后一次锚点。
   * 不补这一帧的话，退出/崩溃后桌面停的是「上次启动/换相簿」那张，
   * 不是用户最后看到的那张。写完再真正退出（preventDefault + 再 quit）。
   */
  let anchorFlushed = false;
  app.on('before-quit', (event) => {
    // 退出原因落盘：实例「安静消失」时分辨托盘退出 / window-all-closed / 异常
    // （2026-10-09 晚实例三连消失、事件日志无崩溃记录、dev.log 0 字节的排查盲区）
    try {
      debugLog.dlog('lifecycle', `before-quit quitting=${quitting} live=${store && store.get().liveWallpaper} running=${liveStage.stats().running}`);
    } catch (_) {}
    quitting = true;
    // 只在「动态桌面开且舞台正在跑」时才需要补写：没开过、或刚关掉
    // （applyConfigChange 已补写过）、或舞台降级中（每轮都在写，桌面已是最新）都放行
    const needFlush = scheduler && store.get().liveWallpaper && liveStage.stats().running && !anchorFlushed;
    if (needFlush) {
      event.preventDefault();
      scheduler.anchorSystem()
        .catch((err) => console.warn('[quit] 锚点补写失败:', err.message))
        .finally(() => { anchorFlushed = true; app.quit(); });
    }
  });

  // 释放 COM 接口 + CoUninitialize，避免留下悬挂的 out-of-proc 引用
  app.on('will-quit', () => {
    stopFullscreenWatch();   // 停轮询（stop 内部会把舞台全部解冻）
    swipeWatch.stop();       // 停桌面手势轮询（54 轮追记五）
    liveStage.stop();   // 卸载舞台窗口（先脱离桌面树再销毁，不留残影）
    if (scheduler) scheduler.stop();
    tray.destroy();
    globalShortcut.unregisterAll();       // 不注销的话热键会留给下一个实例（或失效占用）
    desktopWallpaper.release();
  });

  app.on('window-all-closed', () => {
    // 动态桌面当班时不退出 —— Explorer 重启会连带销毁挂在其下的舞台窗口
    // （window-all-closed 会先于看门狗重建触发），此时必须活着等看门狗把窗口建回来。
    if (!quitting && store && store.get().liveWallpaper && liveStage.stats().running) return;
    // 托盘还在当班时不退出 —— 关窗口只是把界面收起来，桌面轮播继续
    if (!quitting && store && store.get().closeToTray && tray.isInstalled()) return;
    app.quit();
  });
}

function installTray() {
  tray.install({
    listChannels: () => scheduler.list(),
    channelCommand: (id, cmd) => runChannelCommand(id, cmd),
    applyChannel: async (id) => {
      const ch = scheduler.channels.get(id);
      const entry = ch && ch.files[ch.index];
      if (!entry) return;
      const target = ch.kind === 'monitor' && ch.monitor
        ? { monitorId: ch.monitor.id }
        : resolveUnifiedTarget();
      await win32.setWallpaper(entry.path, CACHE_DIR, { monitorId: target.monitorId });
      tray.refresh(scheduler.list());
    },
    rescanChannel: (id) => scheduler.rescan(id),
    /** 托盘里删掉某一路当前正在显示的那张（走统一确认流程） */
    deleteChannelCurrent: async (id) => {
      await trashChannelCurrent(id);
      tray.refresh(scheduler.list());
    },
    setAllPlaying: (playing) => {
      for (const ch of scheduler.channels.values()) scheduler.setPlaying(ch.id, playing);
      send('channels:changed', channelBroadcast({ reason: 'tray', channels: scheduler.list() }));
    },
    isWindowVisible,
    toggleWindow,
    openSettings: () => {
      showWindow();
      send('menu:action', 'toggle-settings');
    },
    openConfigDir: () => shell.openPath(app.getPath('userData')),
    restart: () => restartApp(),
    quit: () => { quitting = true; app.quit(); },
    onLaunchAtLoginChanged: (result) => {
      store.set({ launchAtLogin: Boolean(result.launchAtLogin) });
      send('launch-at-login:changed', result);
      send('notice', result.ok
        ? { text: result.launchAtLogin ? '已开启开机自启' : '已关闭开机自启' }
        : { text: `设置开机自启失败：${result.error}`, error: true });
    },
  });
}
