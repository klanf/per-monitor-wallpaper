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
 * 现在到底会不会开机自启？
 *
 * 坑：Windows 上 `getLoginItemSettings()` 返回的 `openAtLogin` **永远是 false**，
 * 真正表示「启动项存在且指向当前可执行文件」的是 `executableWillLaunchAtLogin`。
 * 只看 openAtLogin 的话，开关会一直显示「关」，用户一开一关反复横跳。
 * 两个字段都读一遍，任一为真即视为已开启（macOS 上只有 openAtLogin 有意义）。
 */
function getLaunchAtLogin() {
  try {
    const state = app.getLoginItemSettings({ path: process.execPath, args: loginArgs() });
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
      path: process.execPath,
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

  template.push({ label: '打开配置目录', click: () => actions.openConfigDir() });
  template.push({ type: 'separator' });
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
  /** 给验证脚本用：菜单模板的纯数据形式（不会弹菜单） */
  menuTemplate: () => menuToPlain(buildMenuTemplate()),
};
