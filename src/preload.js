'use strict';

/**
 * 渲染进程 ←→ 主进程的安全桥。
 * contextIsolation 开启，渲染层拿不到 Node / ipcRenderer 本体，只能调下面这些白名单方法。
 *
 * 多显示器改造后，轮播的调度权在主进程，所以这里多了一层「频道」概念：
 *   一个频道 = 一路独立轮播（统一模式下 1 路；每屏模式下每台显示器 1 路）。
 */

const { contextBridge, ipcRenderer } = require('electron');

const THUMB_SCHEME = 'wpthumb';

/**
 * 磁盘路径 → 缩略图 URL。
 * 在 preload 里算而不是走 IPC：胶片条一屏要几十个 URL，
 * 每个都发一次 IPC 纯属浪费；这里只依赖 Buffer，是确定性的纯函数。
 * 注意编码必须是 UTF-16LE，和主进程 thumbnails.js 的 decodePath 对应
 * （Windows 路径里中文很常见，用 UTF-8 会错位）。
 */
function thumbUrl(filePath) {
  if (!filePath) return '';
  return `${THUMB_SCHEME}://t/${Buffer.from(String(filePath), 'utf16le').toString('base64url')}`;
}

const STAGE_SCHEME = 'wpimg';

/**
 * 磁盘路径 → 原图 URL（动态桌面舞台用）。
 * 与 thumbUrl 同一套编码（UTF-16LE → base64url），对端是主进程 stageProtocol.js
 * 的 decodePath。与缩略图的区别是返回**全尺寸原文件**且 no-store（不进 C 盘缓存）。
 */
function stageUrl(filePath) {
  if (!filePath) return '';
  return `${STAGE_SCHEME}://img/${Buffer.from(String(filePath), 'utf16le').toString('base64url')}`;
}

contextBridge.exposeInMainWorld('wp', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  /** 舞台吃掉的桌面右键 → 转发 Explorer DefView 弹桌面菜单（坐标为 CSS/DIP 屏幕坐标） */
  desktopContextMenu: (x, y) => ipcRenderer.invoke('desktop:context-menu', x, y),
  /** 舞台任意鼠标按下时解除已弹出的桌面菜单（菜单等不到别处的点击） */
  desktopCancelContextMenu: () => ipcRenderer.invoke('desktop:cancel-context-menu'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // ---- 频道 ----
  listChannels: () => ipcRenderer.invoke('channels:list'),
  channelFiles: (id) => ipcRenderer.invoke('channel:files', id),
  channelNeighbors: (id, index, span) => ipcRenderer.invoke('channel:neighbors', id, index, span),
  channelCollagePage: (id, page) => ipcRenderer.invoke('channel:collage-page', id, page),
  channelCommand: (id, command, payload) => ipcRenderer.invoke('channel:command', id, command, payload),
  applyChannel: (id) => ipcRenderer.invoke('channel:apply', id),
  rebuildChannels: (forgetScanCache = false) => ipcRenderer.invoke('channels:rebuild', forgetScanCache),

  pickFolder: (channelId) => ipcRenderer.invoke('folder:pick', channelId),

  // ---- 相簿 ----
  listAlbums: () => ipcRenderer.invoke('album:list'),
  /** 每个相簿的图片张数 { albumId: n }（快切菜单的空相簿禁切闸门） */
  albumCounts: () => ipcRenderer.invoke('album:counts'),
  createAlbum: (name) => ipcRenderer.invoke('album:create', name),
  /** 全量更新：{ name?, folders?: [{ path, enabled }] }；folders 由界面组装好整包传上来 */
  updateAlbum: (id, patch) => ipcRenderer.invoke('album:update', id, patch),
  deleteAlbum: (id) => ipcRenderer.invoke('album:delete', id),
  /** 弹原生目录多选框，只返回路径不改配置 */
  pickDirs: () => ipcRenderer.invoke('album:pick-dirs'),

  probeImage: (imagePath) => ipcRenderer.invoke('image:probe', imagePath),
  imageInfo: (imagePath) => ipcRenderer.invoke('image:info', imagePath),
  revealInExplorer: (imagePath) => ipcRenderer.invoke('shell:reveal', imagePath),
  freeMemory: () => ipcRenderer.invoke('app:free-memory'),

  // ---- 缩略图 ----
  thumbUrl,
  /** 原图 URL（动态桌面舞台用；no-store，不进 Chromium 磁盘缓存） */
  stageUrl,
  /** 舞台报告「当前视频播完了 / 加载失败了」（videoPlayFull 时调度器靠这个推进） */
  stageVideoEnded: (channelId) => ipcRenderer.invoke('stage:video-ended', channelId),
  thumbStats: () => ipcRenderer.invoke('thumbs:stats'),
  thumbPrune: () => ipcRenderer.invoke('thumbs:prune'),
  thumbClear: () => ipcRenderer.invoke('thumbs:clear'),

  // ---- 文件操作（右键菜单动作，主进程菜单与自绘菜单共用）----
  fileStats: (imagePath) => ipcRenderer.invoke('file:stats', imagePath),
  copyImage: (imagePath) => ipcRenderer.invoke('file:copy-image', imagePath),
  copyFile: (imagePath) => ipcRenderer.invoke('file:copy-file', imagePath),
  copyPath: (imagePath) => ipcRenderer.invoke('file:copy-path', imagePath),
  openExternally: (imagePath) => ipcRenderer.invoke('file:open', imagePath),
  openContainingFolder: (imagePath) => ipcRenderer.invoke('file:open-folder', imagePath),
  /** 系统「打开方式」对话框（Windows 的「你要如何打开这个文件？」） */
  openWithDialog: (imagePath) => ipcRenderer.invoke('file:open-with-dialog', imagePath),
  /** 「用其他程序打开」的程序列表（用户在右键子菜单里挑的 exe，存在配置里） */
  openWithList: () => ipcRenderer.invoke('open-with:list'),
  openWithAdd: (programPath) => ipcRenderer.invoke('open-with:add', programPath),
  openWithRemove: (programPath) => ipcRenderer.invoke('open-with:remove', programPath),
  openWithClear: () => ipcRenderer.invoke('open-with:clear'),
  openWithLaunch: (programPath, imagePath) => ipcRenderer.invoke('open-with:launch', programPath, imagePath),
  trashFile: (imagePath) => ipcRenderer.invoke('file:trash', imagePath),
  /**
   * 兼容旧调用点：确认逻辑已经统一进主进程的 trashWithPermission，
   * 所以这条和 trashFile 等价（开关关掉时都不问）。
   */
  trashWithConfirm: (imagePath) => ipcRenderer.invoke('file:trash-confirm', imagePath),
  /** 开启双层视差前的性能警告（r72）：勾过「不再提示」直接放行。返回是否允许开启 */
  dualLayerWithConfirm: () => ipcRenderer.invoke('dual-layer:confirm'),
  /** 分割模型按需下载（r73）：状态 / 下载（完成或失败时 resolve，进度走推送） / 取消 */
  segModelStatus: () => ipcRenderer.invoke('model:seg-status'),
  segModelDownload: () => ipcRenderer.invoke('model:seg-download'),
  segModelCancel: () => ipcRenderer.invoke('model:seg-cancel'),
  onSegModelProgress: (cb) => {
    ipcRenderer.on('model:seg-progress', (_event, payload) => cb(payload));
  },
  onSegModelStage: (cb) => {
    ipcRenderer.on('model:seg-stage', (_event, payload) => cb(payload));
  },
  transferFile: (imagePath, targetDir, mode) => ipcRenderer.invoke('file:transfer', imagePath, targetDir, mode),
  showImageMenu: (payload) => ipcRenderer.send('context:image-menu', payload),
  /** 取右键菜单的结构（不弹菜单），给验证脚本核对菜单项是否齐全 */
  imageMenuTemplate: (payload) => ipcRenderer.invoke('context:image-menu-template', payload),

  // ---- 桌面右键菜单（Windows 桌面背景菜单，注册表集成）----
  /** 装在不在 + 注册的命令行（换过目录会 stale，UI 据此提示重装） */
  desktopMenuStatus: () => ipcRenderer.invoke('shell:desktop-menu-status'),
  /** key = 'next' | 'delete'；不传就是整组一起装卸 */
  desktopMenuSet: (on, key = null) => ipcRenderer.invoke('shell:desktop-menu-set', on, key),

  // ---- 预设文件夹 ----
  listQuickFolders: () => ipcRenderer.invoke('quick:list'),
  pickQuickFolder: () => ipcRenderer.invoke('quick:pick'),
  addQuickFolder: (folderPath, name) => ipcRenderer.invoke('quick:add', folderPath, name),
  removeQuickFolder: (id) => ipcRenderer.invoke('quick:remove', id),
  renameQuickFolder: (id, name) => ipcRenderer.invoke('quick:rename', id, name),

  // ---- 托盘与开机自启 ----
  trayState: () => ipcRenderer.invoke('tray:state'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('tray:set-launch-at-login', enabled),
  /** 取托盘菜单结构（不弹菜单），给验证脚本核对菜单项 */
  trayMenuTemplate: () => ipcRenderer.invoke('tray:menu-template'),

  // ---- 软件更新 ----
  updateState: () => ipcRenderer.invoke('update:state'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // ---- 全局热键 ----
  /** 取动作表 + 当前绑定 + 上一次注册结果（哪些被别的程序占了） */
  getHotkeys: () => ipcRenderer.invoke('hotkeys:get'),
  /** 写入并立即重注册；patch 里给空串 = 解绑 */
  setHotkeys: (patch) => ipcRenderer.invoke('hotkeys:set', patch),
  /** 直接触发某个热键动作（验证用；也方便做「试一下」按钮） */
  invokeHotkey: (action) => ipcRenderer.invoke('hotkeys:invoke', action),
  /** 上报「现在预览的是哪一路」—— 全局热键作用在它上面 */
  setPreviewChannel: (id) => ipcRenderer.send('preview:set', id),

  // ---- 窗口 ----
  toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  showWindow: () => ipcRenderer.send('window:show'),

  // ---- 事件 ----
  onMenuAction: (cb) => {
    ipcRenderer.on('menu:action', (_event, action) => cb(action));
  },

  onMonitorsChanged: (cb) => {
    ipcRenderer.on('monitors:changed', (_event, payload) => cb(payload));
  },

  /** 主进程自动打开「每屏独立」之后通知一次（首次检测到多屏 + 已选目录） */
  onAutoMonitorSetup: (cb) => {
    ipcRenderer.on('monitors:auto-setup', (_event, payload) => cb(payload));
  },

  onChannelsChanged: (cb) => {
    ipcRenderer.on('channels:changed', (_event, payload) => cb(payload));
  },

  /** stage 报来的当前动效轨迹（主界面顶栏徽章用） */
  onFlowStyleChanged: (cb) => {
    ipcRenderer.on('flow-style:changed', (_event, payload) => cb(payload));
  },

  /**
   * 主进程要求切换「当前操作的显示器」（「切到下一台显示器」热键触发）。
   * 反向通道 —— 热键是全局的，窗口可能藏在托盘里，这时候只有主进程知道该切到哪一路。
   */
  onPreviewSelect: (cb) => {
    ipcRenderer.on('preview:select', (_event, payload) => cb(payload));
  },

  onChannelTick: (cb) => {
    ipcRenderer.on('channel:tick', (_event, payload) => cb(payload));
  },

  /** 深度视差：查某张图的深度 sidecar（命中返回缓存路径，未命中入队后台生成并返回 null） */
  depthFor: (imagePath) => ipcRenderer.invoke('depth:lookup', String(imagePath || '')),

  /** 深度生成完成广播：{path} = 原图路径（stage 收到后把当前帧升级成视差） */
  onDepthReady: (cb) => {
    ipcRenderer.on('depth:ready', (_event, payload) => cb(payload));
  },

  /** 深度视差可用性（r25）：Python/worker/模型三件套存在性 + 运行态（设置页状态行） */
  depthStatus: () => ipcRenderer.invoke('depth:status'),

  /** stage 渲染端诊断日志 → 主进程落 live-debug.log（VBS 丢 stdout 的兜底） */
  stageLog: (msg) => {
    ipcRenderer.send('stage:log', String(msg).slice(0, 500));
  },

  /** stage 上报当前动效轨迹（抽签/改配置时）→ 主进程转发主界面顶栏徽章 */
  reportFlowStyle: (payload) => {
    ipcRenderer.send('stage:flow-style', payload && typeof payload === 'object' ? payload : {});
  },

  /** 主进程告诉 stage 窗口「你绑定哪个频道」（动态桌面 stage 页专用） */
  onStageBind: (cb) => {
    ipcRenderer.on('stage:bind', (_event, payload) => cb(payload));
  },

  /** 主进程告诉 stage 窗口「暂停 / 恢复」（全屏占用 / 锁屏，阶段 3） */
  onStagePause: (cb) => {
    ipcRenderer.on('stage:pause', (_event, payload) => cb(payload));
  },

  /**
   * 主进程喂光标位置（30Hz，位置变化才发）：raised-WorkerW 挂载后舞台收不到
   * 原生 mousemove（图标层截走输入），深度视差接管 / 粒子避让改吃这条。
   * payload = { nx, ny, x, y }：归一化 [-1,1] + 舞台内 CSS 像素。
   */
  onStageMouse: (cb) => {
    ipcRenderer.on('stage:mouse', (_event, payload) => cb(payload));
  },

  /** 主进程主动弹提示（右键菜单操作、托盘操作的结果） */
  onNotice: (cb) => {
    ipcRenderer.on('notice', (_event, payload) => cb(payload));
  },

  /** 文件被移动 / 删除后的通知 */
  onFilesChanged: (cb) => {
    ipcRenderer.on('files:changed', (_event, payload) => cb(payload));
  },

  /** 从右键菜单打开图片信息面板 */
  onInfoOpen: (cb) => {
    ipcRenderer.on('info:open', (_event, payload) => cb(payload));
  },

  onQuickFoldersChanged: (cb) => {
    ipcRenderer.on('quick-folders:changed', (_event, payload) => cb(payload));
  },

  /** 相簿列表被主进程改了（folder:pick 新建相簿 / album:update / album:delete） */
  onAlbumsChanged: (cb) => {
    ipcRenderer.on('albums:changed', (_event, payload) => cb(payload));
  },

  onLaunchAtLoginChanged: (cb) => {
    ipcRenderer.on('launch-at-login:changed', (_event, payload) => cb(payload));
  },

  onUpdateState: (cb) => {
    ipcRenderer.on('update:state', (_event, payload) => cb(payload));
  },

  /** 用户在删除确认框里勾了「不再询问」，开关被主进程关掉了 */
  onConfirmDeleteChanged: (cb) => {
    ipcRenderer.on('confirm-delete:changed', (_event, payload) => cb(payload));
  },
  /** 用户在双层视差警告框里勾了「不再提示」 */
  onDualHintChanged: (cb) => {
    ipcRenderer.on('dual-hint:changed', (_event, payload) => cb(payload));
  },
});
