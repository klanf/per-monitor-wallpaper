'use strict';

/**
 * 系统托盘 + 开机自启。
 *
 * 为什么需要托盘：调度器在主进程里，窗口只是「一路轮播的显示器」。
 * 所以关掉窗口完全不该停止轮播 —— 托盘就是让程序真正变成后台服务的那一环：
 *   · 关窗口 → 隐藏到托盘（可配置成真退出）
 *   · 托盘菜单可直接控制每块屏的轮播，不用把窗口调出来
 *   · tooltip 常显每块屏当前挂着哪张图
 *
 * 开机自启用 app.setLoginItemSettings（Windows 内置的 Run 项），不额外写注册表。
 */

const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { resolvePortableExecutablePath } = require('./portablePath');

let tray = null;
let actions = null;

/* ---------------------------------------------------------------- 图标 */

function loadIcon() {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
  ];
  for (const file of candidates) {
    try {
      const img = nativeImage.createFromPath(file);
      if (img && !img.isEmpty()) return img;
    } catch { /* 换下一个 */ }
  }
  // 兜底：1×1 透明图。托盘创建失败比图标难看严重得多
  return nativeImage.createEmpty();
}

/* ---------------------------------------------------------------- 开机自启 */

/**
 * 开发模式（electron.exe . ）下自启命令是 `electron.exe <项目目录> --hidden`；
 * 打包后才是 exe 自己带 --hidden。两种都要写对，否则重启后弹一个空窗口。
 */
function loginArgs() {
  if (app.isPackaged) return ['--hidden'];
  const entry = process.argv[1];
  return entry ? [path.resolve(entry), '--hidden'] : ['--hidden'];
}

/**
 * 应该写进启动项 / relaunch 的可执行文件路径。
 *
 * portable 坑：`process.execPath` 是解包到 %TEMP% 的临时 exe，退出即被删，
 * 拿它写自启项 = 开机永远起不来。portable 启动器会把原始 exe 位置放进
 * 环境变量（PORTABLE_EXECUTABLE_FILE 等），解析得到就用它。
 * 非 portable（NSIS 安装版 / 开发模式）返回 null，调用方回落到 execPath。
 */
function launcherPath() {
  return resolvePortableExecutablePath();
}

/**
 * 现在到底会不会开机自启？
 *
 * 坑：Windows 上 `getLoginItemSettings()` 返回的 `openAtLogin` **永远是 false**，
 * 真正表示「启动项存在且指向当前可执行文件」的是 `executableWillLaunchAtLogin`。
 * 只看 openAtLogin 的话，开关会一直显示「关」，用户一开一关反复横跳。
 * 两个字段都读一遍，任一为真即视为已开启（macOS 上只有 openAtLogin 有意义）。
 */
function getLaunchAtLogin() {
  try {
    const state = app.getLoginItemSettings({ path: launcherPath() || process.execPath, args: loginArgs() });
    return Boolean(state.executableWillLaunchAtLogin || state.openAtLogin);
  } catch {
    try {
      const state = app.getLoginItemSettings();
      return Boolean(state.executableWillLaunchAtLogin || state.openAtLogin);
    } catch { return false; }
  }
}

function setLaunchAtLogin(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: launcherPath() || process.execPath,
      args: loginArgs(),
      name: app.getName() || 'electron-wallpaper',
    });
    return {
      ok: true,
      launchAtLogin: getLaunchAtLogin(),
      command: `${process.execPath} ${loginArgs().join(' ')}`,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------------------------------------------------------------- 菜单 */

/**
 * 构造托盘菜单的模板（纯数据，不弹菜单）。
 *
 * 拆出来是为了能被验证脚本取走核对 —— 托盘菜单是原生窗口，
 * 弹出来就没人点、会一直挡着用户，所以验证只能走「核对结构」这条路。
 */
function buildMenuTemplate() {
  if (!actions) return [];

  const channels = actions.listChannels() || [];
  const anyPlaying = channels.some((c) => c.playing && c.enabled && c.count > 1);

  const channelItems = channels.map((ch) => {
    const title = ch.kind === 'monitor'
      ? `显示器 ${(ch.monitorIndex || 0) + 1} · ${ch.width}×${ch.height}`
      : '全部显示器';

    const status = [];
    if (ch.lastError) status.push(`⚠ ${ch.lastError}`);
    else if (!ch.enabled) status.push('未接管');
    else if (ch.playing) status.push('播放中');
    else status.push('已暂停');
    status.push(`${ch.count} 张`);
    if (ch.count) status.push(`第 ${ch.index + 1} 张`);
    // 相簿名让「这块屏在播哪个池子」一眼可辨（目录集合比一路径更好认）
    if (ch.albumName) status.push(`相簿：${ch.albumName}`);

    const sub = [
      { label: status.join('  ·  '), enabled: false },
      { type: 'separator' },
      { label: '下一张', enabled: ch.count > 1, click: () => actions.channelCommand(ch.id, 'next') },
      { label: '上一张', enabled: ch.count > 1, click: () => actions.channelCommand(ch.id, 'prev') },
      {
        label: ch.playing ? '暂停' : '继续',
        enabled: ch.count > 1,
        click: () => actions.channelCommand(ch.id, 'toggle-play'),
      },
      { type: 'separator' },
      { label: '立即设为壁纸', enabled: ch.count > 0, click: () => actions.applyChannel(ch.id) },
      { label: '重新扫描', enabled: Boolean(ch.albumId), click: () => actions.rescanChannel(ch.id) },
      {
        // 删掉这一路当前正在显示的那张。和右键菜单、胶片条垃圾桶走同一套确认流程
        label: '删除到回收站',
        enabled: ch.count > 0,
        click: () => actions.deleteChannelCurrent(ch.id),
      },
    ];
    if (ch.current) {
      sub.push({ type: 'separator' });
      sub.push({ label: `当前：${ch.name || ''}`.slice(0, 60), enabled: false });
    }
    return { label: title, submenu: sub };
  });

  const template = [
    {
      label: actions.isWindowVisible() ? '隐藏主窗口' : '显示主窗口',
      click: () => actions.toggleWindow(),
    },
    { label: '设置…', click: () => actions.openSettings() },
    { type: 'separator' },
  ];

  if (channelItems.length > 0) {
    template.push(...channelItems);
    template.push({ type: 'separator' });
    template.push({
      label: anyPlaying ? '全部暂停' : '全部继续',
      click: () => actions.setAllPlaying(!anyPlaying),
    });
    template.push({ type: 'separator' });
  } else {
    template.push({ label: '还没有可轮播的目录', enabled: false }, { type: 'separator' });
  }

  template.push({
    label: '开机自启',
    type: 'checkbox',
    checked: getLaunchAtLogin(),
    click: (item) => {
      const result = setLaunchAtLogin(item.checked);
      if (actions.onLaunchAtLoginChanged) actions.onLaunchAtLoginChanged(result);
      refresh();
    },
  });

  // 接管系统壁纸（57 轮）：关掉 = 让位给 Windows 自带幻灯片，程序其余功能照常跑。
  // 不让位的话，轮播每个间隔都会用 IDesktopWallpaper 把个性化里刚选的幻灯片
  // 打回「图片」模式并清空 slideshow.ini —— 表现就是「幻灯片怎么都切不动」。
  template.push({
    label: '接管系统壁纸',
    type: 'checkbox',
    checked: actions.isApplyToSystem ? actions.isApplyToSystem() : true,
    click: (item) => {
      if (actions.setApplyToSystem) actions.setApplyToSystem(item.checked);
      notify(
        item.checked ? '已接管系统壁纸' : '已让出系统壁纸',
        item.checked
          ? '轮播恢复写入桌面壁纸；Windows 自带幻灯片会被本程序覆盖。'
          : '本程序不再写入系统壁纸，可以去 Windows 个性化里用幻灯片放映了（动态桌面画面不受影响）。',
      );
      refresh();
    },
  });

  template.push({ label: '打开配置目录', click: () => actions.openConfigDir() });
  template.push({ type: 'separator' });
  template.push({
    label: '重新启动',
    // 改了主进程代码后不用「退出 → 再双击 VBS」两步了；启动参数照旧（比如 --hidden）
    click: () => { if (actions.restart) actions.restart(); else actions.quit(); },
  });
  template.push({ label: `关于 ${app.getName() || '壁纸切换器'} v${app.getVersion()}`, enabled: false });
  template.push({ label: '退出', click: () => actions.quit() });

  return template;
}

/** 把模板压成纯数据（递归），给验证脚本核对用 —— 不弹菜单，不打扰用户 */
function menuToPlain(template) {
  const strip = (items) => (items || []).map((item) => {
    if (!item || typeof item !== 'object') return { label: String(item) };
    const out = {
      type: item.type || null,
      label: item.label || null,
      enabled: item.enabled !== false,
      hasClick: typeof item.click === 'function',
    };
    if (item.type === 'checkbox') out.checked = Boolean(item.checked);
    if (Array.isArray(item.submenu)) out.submenu = strip(item.submenu);
    return out;
  });
  return strip(template);
}

function buildMenu() {
  if (!tray || !actions) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

/** 每来一次 tick 都重建菜单太重；只在「状态真的变了」时重建 */
let lastMenuKey = null;
function menuKey(channels) {
  return JSON.stringify(channels.map((c) => [
    c.id, c.playing, c.enabled, c.count, c.lastError, Math.floor(c.index / 1),
  ]));
}

function refresh(channels) {
  if (!tray) return;
  const list = channels || (actions ? actions.listChannels() : []);
  const key = menuKey(list || []);
  if (key !== lastMenuKey) {
    lastMenuKey = key;
    buildMenu();
  }
  updateTooltip(list);
}

function updateTooltip(channels) {
  if (!tray || !channels) return;
  const lines = [];
  for (const ch of channels) {
    const name = ch.kind === 'monitor'
      ? `屏${(ch.monitorIndex || 0) + 1}`
      : '全部';
    const state = ch.count === 0
      ? '无图片'
      : `${ch.playing ? '▶' : '❚❚'} ${String(ch.index + 1)}/${ch.count}`;
    lines.push(`${name} ${state}  ${(ch.name || '').slice(0, 28)}`);
  }
  // Windows 托盘 tooltip 上限约 127 字符，超了会被截断成乱码，这里主动收
  const text = (lines.join('\n') || '壁纸切换器').slice(0, 120);
  try { tray.setToolTip(text); } catch { /* 某些 shell 不支持多行，忽略 */ }
}

/* ---------------------------------------------------------------- 生命周期 */

/**
 * @param {object} handlers
 * @param {() => Array} handlers.listChannels
 * @param {(id:string, cmd:string) => void} handlers.channelCommand
 * @param {(id:string) => void} handlers.applyChannel
 * @param {(id:string) => void} handlers.rescanChannel
 * @param {(playing:boolean) => void} handlers.setAllPlaying
 * @param {() => boolean} handlers.isWindowVisible
 * @param {() => void} handlers.toggleWindow
 * @param {() => void} handlers.openSettings
 * @param {() => void} handlers.openConfigDir
 * @param {() => void} [handlers.restart] 重新启动（缺省时「重新启动」退化为退出）
 * @param {() => void} handlers.quit
 * @param {(result:object) => void} [handlers.onLaunchAtLoginChanged]
 */
function install(handlers) {
  actions = handlers;
  if (tray) return tray;

  try {
    tray = new Tray(loadIcon());
  } catch (err) {
    console.error('[tray] 创建托盘失败:', err.message);
    return null;
  }

  tray.setToolTip('壁纸切换器');
  tray.on('click', () => actions.toggleWindow());
  tray.on('double-click', () => actions.openSettings());
  tray.on('balloon-click', () => actions.toggleWindow());

  buildMenu();
  return tray;
}

function isInstalled() {
  return Boolean(tray);
}

/** 托盘气泡提示（Windows）。失败无所谓，只是少一次提示 */
function notify(title, content) {
  if (!tray) return false;
  try {
    tray.displayBalloon({ title, content, noSound: true });
    return true;
  } catch {
    return false;
  }
}

function destroy() {
  if (tray) {
    try { tray.destroy(); } catch { /* ignore */ }
    tray = null;
  }
  lastMenuKey = null;
}

module.exports = {
  install,
  refresh,
  destroy,
  isInstalled,
  notify,
  getLaunchAtLogin,
  setLaunchAtLogin,
  loginArgs,
  /** portable 原始 exe 路径（非 portable 返回 null）；设置面板展示自启命令也用它 */
  launcherPath,
  /** 给验证脚本用：菜单模板的纯数据形式（不会弹菜单） */
  menuTemplate: () => menuToPlain(buildMenuTemplate()),
};
