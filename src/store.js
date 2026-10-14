'use strict';

/**
 * 配置持久化。
 *
 * 对照原 Python 版 load_unified_config / save_unified_config / _merge_config：
 *   Python 里配置迁移要手写几百行（_normalize_config_paths + _migrate_old_configs），
 *   这里用「默认值深合并」一次性解决，写盘走 tmp + rename 保证原子性。
 *
 * 配置模型（v2 起支持每屏独立，v3 起目录组织成相簿）：
 *   ┌ 顶层字段 ─────────────────────────────────────────────┐
 *   │  albumId / interval / animation / …  ← 「默认配置」     │
 *   ├ albums[] ─────────────────────────────────────────────┤
 *   │  { id, name, folders: [{ path, enabled }] }  ← 全局相簿 │
 *   └───────────────────────────────────────────────────────┘
 *                     ↓ 被继承
 *   ┌ monitors[<设备路径>] ──────────────────────────────────┐
 *   │  { albumId, interval, animation, enabled, … }  ← 覆盖项 │
 *   └───────────────────────────────────────────────────────┘
 *   单屏只写自己关心的字段，其余自动回落到顶层默认值。
 *
 * 相簿是全局实体、频道只存引用：两个频道绑同一个相簿时，
 * 扫描缓存共享、洗牌与进度各自独立（见 scheduler）。
 * 旧版直接存目录路径（folder 字段），读入时自动包装成相簿 —— 见 migrateLegacyFolders。
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 设置面板的分类页 id —— 顺序即标签栏的显示顺序。
 *
 * 放在 store 里而不是 renderer 里，是为了让写盘前能收紧这个值：
 * 用户手改 config.json 或老版本的残留值（比如拼错的 'playback'）不该把面板点成空白。
 */
const SETTINGS_TABS = ['play', 'look', 'action', 'system'];

const DEFAULTS = {
  albumId: '',             // 频道绑定的相簿 id；空 = 没绑定（无图可播）
  albums: [],              // [{ id, name, folders: [{ path, enabled }] }]
  recursive: true,
  interval: 60,            // 秒

  /**
   * 定时重新扫描相簿目录的间隔（分钟）。0 = 不自动扫描。
   *
   * 扫描缓存只在「手动重新扫描 / 目录内容变动」时失效，所以外部往目录里丢新图
   * （Syncthing 同步、ComfyUI 出图）程序自己是不知道的 —— 这个定时就是补这一段。
   * 自动扫描**只丢扫描缓存**，不洗牌：新图接在列表末尾、已删的图消失，
   * 当前正在显示的那张和播放顺序都不动（与手动「重新扫描」的重洗语义区分开）。
   */
  autoScanMinutes: 0,

  /**
   * 设置面板停在哪个分类页（见 SETTINGS_TABS）。
   *
   * 设置面板有几十个字段，以前是一整条长列，找个开关要滚很久。改成分类标签页后
   * 默认应该落回用户上次看的那一页 —— 否则每次打开都要重新点一遍。
   */
  settingsTab: 'play',
  /**
   * 界面记忆（r24）：主窗口上次预览的频道 id / 设置面板每屏卡片上次编辑的显示器 id。
   * 频道 id 对显示器是稳定值（IDesktopWallpaper 设备路径），跨重启可复原；
   * 失效（拔显示器/换模式）时渲染端自动回落，不用在这里校验。
   */
  lastPreviewId: '',
  settingsEditMonitor: '',
  animation: 'slide',      // 全清单见下方 ANIMATIONS（含 random 随机轮换）
  duration: 520,           // 毫秒
  shuffle: false,
  autoPlay: true,
  applyToSystem: true,     // 总开关：是否真正写系统壁纸
  /**
   * 视频播完再切：当前条目是视频时等它播完（ended）才推进下一张，
   * 不按 interval 定时切。只在动态桌面开着时有意义（系统壁纸显示不了视频，
   * 没人播就没人报告 ended）。渲染端加载失败也会报告，视频坏掉不会卡死轮播。
   */
  videoPlayFull: false,

  /**
   * 视频优化转码（遇到才转）：视频首次被播放时后台转一份 30fps 副本进缓存目录，
   * 之后轮播永远直接服务副本，解码负载约减半（实测基线见 src/videoOptimize.js 头注释）。
   * 源文件一字不动（库在 Syncthing 同步目录，原地替换会触发全量重同步）；
   * 源删除/被改动后副本自动回收；副本总量超 optimizeCacheMaxGB 按 LRU 逐出。
   * 首播那次照常播原件，体验零变化。
   */
  videoOptimize: true,
  optimizeTargetFps: 30,                       // 目标帧率（60→30 是收益大头）
  optimizeCacheDir: 'D:/video-optimize-cache', // 副本缓存目录（放 D 盘，不在 Syncthing 同步范围内）
  optimizeCacheMaxGB: 40,                      // 缓存容量上限（超出按 lastUsed 逐出）
  ffmpegPath: '',                              // 空 = 项目约定位置 D:/workbuddy/tools/bin/ffmpeg.exe → PATH

  /**
   * 动态桌面总开关：把渲染窗口挂到桌面图标**下面**实时渲染（Wallpaper Engine 那种活桌面）。
   *
   * 挂法是 `SetParent` 到「持有 `SHELLDLL_DefView` 的那个窗口」（本机是 `Progman`），
   * 再把自己插到图标层之后 —— 不用网上流传的「找没有 DefView 的 WorkerW」，
   * 那套在本机必然误选（16 个 202×56 的隐形小窗等着，且 SetParent 还返回成功），
   * 详见 `src/desktopHost.js` 的头注释与 `docs/任务书-动态桌面.md` §2.1。
   *
   * 开启后系统壁纸**降频写**（只在锚点时机写，口径见 `src/liveDesktop.js`）：
   * 实测每写一次系统壁纸，Explorer 会新建 WorkerW 把我们的窗口盖住约 1 秒，
   * 照原来「每换图都写」的节奏，桌面会每 30 秒闪一下。
   */
  liveWallpaper: false,

  /**
   * 动态桌面的性能策略（用户拍板：省电优先，且暂停必须**按屏独立** ——
   * 一块屏全屏玩游戏时只暂停那块，另一块照常播）。
   *
   * `fpsCap` 只约束渲染层**自己 tick 驱动**的动画：纯 CSS 动画跑在合成器里，
   * 用 rAF 节流对它无效（任务书 §2.8），所以过渡与缓动一律由渲染层出帧。
   * 默认 30 而不是跟随刷新率 —— 桌面画面静止时 GPU 占用要尽量为零。
   */
  liveStage: {
    fpsCap: 30,              // 帧率上限（5~240）
    pauseOnFullscreen: true, // 某块屏被全屏应用占满时，只暂停那一块
    pauseOnBattery: true,    // 电池供电时暂停
    pauseOnLock: true,       // 锁屏 / 息屏 / 睡眠时暂停
    pauseOnIdle: true,       // 无输入超时也算「人离开」（主树 57 轮：纯熄屏不锁屏的平板合盖就靠它）
    idlePauseMinutes: 5,     // 无输入判定阈值（分钟，0~120；0 = 关闭该判定）
    hideOnPaused: false,     // 暂停时把舞台窗口整个藏起来（默认关；独占全屏游戏前手动开）
  },
  monitor: 'all',          // 统一模式的写入目标：all | primary | window | <设备路径>
  fit: 'cover',            // cover（铺满裁切）| contain（完整显示·模糊底）| mirror（完整显示·镜像延展）| collage（拼接填充）

  /**
   * 随机模式下，避开「体积与当前这张相同」的候选。
   *
   * 内容完全相同的两张图体积必然相同，所以这一步能挡住「同一张图连着出现两次」。
   * 实测用户的图库里有 70 组内容完全一样的重复文件（同一张图存了日文名和罗马音名），
   * 30k 张里随机抽到的概率约 0.23%/次，11 秒间隔下一小时能撞上一次 —— 就是「偶尔重复」。
   * 用体积判断是零成本的近似，不需要为了 30k 张图去做内容哈希；
   * 误伤的代价只是这一轮不显示那张恰好同体积的图（约 0.5% 的图会受影响）。
   */
  skipSizeTwin: true,

  // ---- 每屏独立模式 ----
  perMonitor: false,       // 打开后：每台显示器各自一条独立轮播
  applyOnStart: true,      // 启动时立即用当前帧接管所选屏幕
  monitors: {},            // { [IDesktopWallpaper 设备路径]: Partial<Profile> }

  // 「切到每屏独立时提示粒子去哪设置」弹窗已看过（53 轮，true = 不再弹）
  hintParticlesPerMonitor: false,

  /**
   * 记住上一次停在哪张 —— 重启（含开机自启）后从那张接着播，而不是回到第一张。
   *
   * 记录落在 userData/playback.json，**不写进这份配置**：它是每次换图都要写的高频状态，
   * 混进配置文件只会让 diff 全是噪声，还会和用户手改配置撞车（见 playbackState.js）。
   * 随机模式下列表每次启动都会重洗，所以记的是「路径」而不是序号 —— 详见 scheduler
   * 的 _restoreProgress。
   */
  resumeLast: true,

  /**
   * 「检测到多屏就自动开每屏独立」做过没有。
   *
   * 只做一次：用户要是嫌不合适、手动关掉之后，绝不能再自动打开（那会变成抢方向盘）。
   * 只有真的检测到 2 块以上屏幕、并且用户已经选好目录时才写这个标记 ——
   * 所以「先在一台单屏机器上跑了，之后接了第二块屏」这种情况还能补上。
   */
  autoMonitorSetup: false,

  // ---- 后台驻留 ----
  tray: true,              // 显示托盘图标
  closeToTray: true,       // 关窗口 = 隐藏到托盘（false 则直接退出）
  startHidden: false,      // 启动时不显示窗口（配合开机自启）
  launchAtLogin: false,    // 开机自启（实际状态以系统为准，见 tray.getLaunchAtLogin）

  // ---- 工具栏自动隐藏 ----
  /**
   * 顶栏与胶片条在「没有动作」多久之后淡出（毫秒）。0 = 一直显示。
   *
   * 之前写死 2400ms。改成可配置是因为两种用法想要完全不同：
   * 快速翻图时希望它赶紧让开，慢悠悠挑图时又希望它多停一会儿。
   */
  autoHideDelay: 2400,

  // ---- 胶片条（缩略图导航） ----
  filmstrip: true,         // 是否显示底部缩略图条
  filmstripRange: 40,      // 当前帧左右各保留多少张（窗口化渲染，不是全部）
  filmstripAutoCenter: true,

  // ---- 缩略图缓存 ----
  thumbSize: 256,          // 生成尺寸（像素，长边）
  thumbCacheDir: '',       // 空 = userData/thumbs

  // ---- 图片信息面板 ----
  infoPanel: true,         // 右键菜单里的「图片信息…」

  /**
   * 删除到回收站之前是否先弹确认框。
   *
   * 图片库是长期积累的，误删代价不对称，所以默认开着。
   * 关掉之后所有删除入口（右键菜单 / 胶片条垃圾桶 / 托盘 / 热键）都直接删。
   */
  confirmDelete: true,

  /**
   * 全局热键（Electron accelerator 字符串，如 'Ctrl+Alt+Right'）。
   *
   * 空字符串 = 不绑定。由主进程 globalShortcut 注册，所以窗口藏在托盘里也生效。
   * 必须带修饰键 —— 单键全局热键会抢掉全系统的输入。
   */
  hotkeys: {
    cycleMonitor: '',  // 切到下一台显示器（切换「当前操作的那块屏」）
    next: '',          // 下一张（作用于当前预览的屏幕）
    prev: '',          // 上一张
    playPause: '',     // 暂停 / 继续
    delete: '',        // 把当前这张移入回收站
    toggleWindow: '',  // 显示 / 隐藏主窗口
    info: '',          // 当前这张的图片信息
    reveal: '',        // 打开这张图所在的文件夹（并选中它）
  },

  // ---- 右键菜单 ----
  contextMenu: true,
  // 桌面手势切壁纸（54 轮追记五）：横向拖拽/触摸横扫切上/下一张，不写 = 默认开
  swipeSwitch: true,
  // 快捷移动/复制目标，[{ id, name, path }]
  quickFolders: [],
  /**
   * 「用其他程序打开」的程序列表 —— 用户自己挑的 exe，选过一次就记住。
   * 沿用原版 Python 的 `open_with.programs` 做法（不是每次弹系统的「打开方式」对话框）。
   */
  openWith: [],

  window: {
    width: 1360,
    height: 860,
    fullscreen: false,
  },
};

/** 构成「一路轮播」的字段 —— 单屏覆盖只允许出现在这些键上 */
const PROFILE_KEYS = [
  'albumId', 'recursive', 'interval', 'animation', 'duration', 'shuffle', 'fit', 'skipSizeTwin',
  'kenBurns',                  // 动态桌面舞台的 Ken Burns 微缩放开关（不写 = 默认开）
  'fpsCap',                    // 动态桌面舞台过渡帧率上限（不写 = 默认 60）
  'videoPlayFull',             // 视频播完再切下一张（不写 = 默认关，按 interval 定时切）
  'breath',                    // 呼吸缩放特效（不写 = 默认关；与 Ken Burns 叠加）
  'breathPeriod',              // 呼吸缩放周期 ms（不写 = 渲染端默认 6000；收紧 2000~15000）
  'breathAmplitude',           // 呼吸缩放幅度 %（不写 = 渲染端默认 2，即 ±2%；收紧 0.5~5）
  'particles',                 // 舞台粒子特效：rain/sakura/.../random（不写 = 关；白名单收紧在渲染端 particles.js）
  'cropPan',                   // 鼠标平移裁切（r37，不写 = 默认开；只对铺满裁切且图片有溢出时生效）
  'particleCount',             // 舞台粒子数量（不写 = 渲染端默认 256；收紧 0~1000 在 particles.js）
  'particleCursor',            // 粒子绕开鼠标（不写 = 默认开；斥力实现在 particles.js）
  'particlePool',              // 粒子随机池（r21）：random 时只抽池内种类；空数组 = 全部参与
  'timeOfDay',                 // 时段滤镜：morning/noon/overcast/dusk/night（不写 = 无）
  'todRandom',                 // 时段滤镜随机（r21）：每次换图抽一种（true 时无视 timeOfDay 固定值）
  'todPool',                   // 时段滤镜随机池（r21）：空数组 = 全部参与
  // ---- 深度视差（第十一轮起进设置面板；不写 = stage.js 内置默认）----
  'depthParallax',             // 深度视差总开关
  // depthFlow 键已退役（r23）：流动模式恒开（用户实测关掉效果非常差）。
  // 从 PROFILE_KEYS 移除 = resolveProfile 不再透传 → applyProfile 收不到
  // → stage 恒走内置默认 true（POM 流模式）；旧配置里的残留值无人读取，无害。
  'depthAmp',                  // 单平面视差幅度
  'depthDrift',                // 自动漂移速度倍率
  'depthLight',                // 灯光强度
  'flowIntensity',             // 流模式轨迹幅度（Circle 预设 0.5）
  'flowIso',                   // 流模式斜视角（0.6）
  'flowSteady',                // 流模式背景稳定点（0.3）
  'flowHeight',                // 流模式视差强度主旋钮（0.2）
  'flowStyle',                 // 流模式动效轨迹：circle/orbital/dolly（不写 = circle）
  'flowQuality',               // 流模式 POM 步进质量 0.15~1（0.5=CLI 默认，低=省 GPU）
  'idleFx',                    // idle 微动画（r62）：前景呼吸+飘动+差速视差（不写 = 默认关）
  'depthAtmo',                 // 分层氛围（r71）：时段光照+环境雾+金边（不写 = 默认关）
  'atmoPalette',               // 氛围调色板（r73）：auto/golden/tealorange/cyberpunk/moonlight/faded（不写 = auto）
  'pointerFx',                 // 鼠标影响动效（r70）：开=鼠标临时接管镜头；关=恒走预设轨迹（不写 = 默认开）
];

/** 生成相簿 id：时间戳 + 随机尾巴，撞不上同毫秒的两次创建 */
function newAlbumId() {
  return `alb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 相簿数组收紧：字段补默认值、路径去重（Windows 大小写不敏感）、剔除坏条目。
 * 配置文件是用户能直接手改的地方，这里宁可宽容修整也不能让坏数据炸掉调度器。
 */
function normalizeAlbums(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) continue;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newAlbumId();
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '未命名相簿';
    const folders = [];
    const seen = new Set();
    for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
      if (!isPlainObject(f)) continue;
      const p = typeof f.path === 'string' ? f.path.trim() : '';
      if (!p) continue;
      const key = p.toLowerCase();
      if (seen.has(key)) continue;          // 同一目录在相簿里加两次只算一次
      seen.add(key);
      folders.push({ path: p, enabled: f.enabled === false ? false : true });
    }
    out.push({ id, name, folders });
  }
  return out;
}

/** 按 id 找相簿；找不到返回 null */
function findAlbum(config, albumId) {
  if (!albumId) return null;
  return (Array.isArray(config.albums) ? config.albums : []).find((a) => a.id === albumId) || null;
}

/**
 * 旧式 folder 字段的自动换算：把「频道直接绑目录」包装成相簿。
 *
 * 触发条件：顶层或某块屏的覆盖里躺着 folder（旧版配置文件、手改配置、
 * 或仍按旧 API 发 { folder } 载荷的验证脚本）。已有相簿也参与复用：
 * 恰好只含这一个目录的相簿直接绑回去，没有才另建 —— 相同目录合并成同一个相簿，
 * 名字取目录名。绑定关系原样保留，播放进度不受影响
 * （scheduler 里旧进度记录按 folder 匹配不到时才退序号，这里把 albumId 补上后
 * 由 scheduler 的 folder→albumId 记录映射兜底，见 _restoreProgress）。
 * folder 换算完即清空，函数幂等：反复跑不会重复建相簿。
 */
function migrateLegacyFolders(config) {
  const monitors = isPlainObject(config.monitors) ? { ...config.monitors } : {};
  const legacyTop = typeof config.folder === 'string' ? config.folder.trim() : '';
  const legacyMonitors = Object.entries(monitors)
    .filter(([, ov]) => isPlainObject(ov) && typeof ov.folder === 'string' && ov.folder.trim())
    .map(([id, ov]) => ({ id, folder: ov.folder.trim() }));

  if (!legacyTop && legacyMonitors.length === 0) return config;

  const albums = Array.isArray(config.albums) ? config.albums.slice() : [];
  const byPath = new Map();
  const ensure = (folderPath) => {
    const key = folderPath.toLowerCase();
    if (byPath.has(key)) return byPath.get(key);
    const reused = albums.find((a) => a.folders.length === 1
      && String(a.folders[0].path).toLowerCase() === key);
    if (reused) {
      byPath.set(key, reused);
      return reused;
    }
    const album = {
      id: newAlbumId(),
      name: path.basename(folderPath) || '默认相簿',
      folders: [{ path: folderPath, enabled: true }],
    };
    byPath.set(key, album);
    albums.push(album);
    return album;
  };

  const out = { ...config, albums };
  if (legacyTop) {
    out.albumId = ensure(legacyTop).id;
    out.folder = '';                       // 换算完成即清空，避免语义含混
  }
  for (const { id, folder } of legacyMonitors) {
    const override = { ...monitors[id] };
    delete override.folder;
    override.albumId = ensure(folder).id;
    monitors[id] = override;
  }
  out.monitors = monitors;
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 宽松布尔化。
 *
 * 存在的理由：早期每屏独立卡片里的「播放顺序」seg 控件把 data-value 原样写进了配置，
 * 于是 `shuffle` 存成了 `'random'` / `'order'` 字符串，而 resolveProfile 里
 * `shuffle === true` 永远不成立 —— 表现就是「从随机切到按名称之后再也切不回随机」。
 * 这里把历史遗留的字符串一并认下来，已经写坏的配置下次读到就自动恢复正常。
 */
function toBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'on' || s === 'random') return true;
    if (s === 'false' || s === 'no' || s === 'off' || s === 'order' || s === '') return false;
  }
  return Boolean(v);
}

/** 这几个键在配置里必须是布尔值，写盘前统一收一遍 */
const BOOL_KEYS = new Set([
  'shuffle', 'recursive', 'autoPlay', 'applyToSystem', 'applyOnStart', 'resumeLast', 'liveWallpaper',
  'perMonitor', 'skipSizeTwin', 'confirmDelete', 'autoMonitorSetup',
  'tray', 'closeToTray', 'startHidden', 'launchAtLogin',
  'filmstrip', 'filmstripAutoCenter', 'infoPanel', 'contextMenu',
  'videoPlayFull', 'swipeSwitch',
  'videoOptimize',
  'depthParallax',             // 深度视差总开关（不写 = 默认开）
  'todRandom',                 // 时段滤镜随机开关（r21）
]);

/** 热键字段：值必须是非空字符串或空串，别让 undefined / 数字混进来 */
const HOTKEY_KEYS = ['cycleMonitor', 'next', 'prev', 'playPause', 'delete', 'toggleWindow', 'info', 'reveal'];

function normalizeHotkeys(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const key of HOTKEY_KEYS) {
    if (!(key in value)) continue;                 // 只收出现过的键，避免局部 patch 把别的热键清空
    const v = value[key];
    out[key] = typeof v === 'string' ? v.trim() : '';
  }
  return out;
}

/** 写盘 / 读盘前统一收一遍：布尔键收紧，热键只留字符串，相簿结构收紧 */
function normalizeConfig(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = normalizeBooleans(obj);
  if ('hotkeys' in out) out.hotkeys = normalizeHotkeys(out.hotkeys);
  if ('albums' in out) out.albums = normalizeAlbums(out.albums);
  if ('autoScanMinutes' in out) out.autoScanMinutes = clampAutoScanMinutes(out.autoScanMinutes);
  if ('settingsTab' in out) out.settingsTab = clampSettingsTab(out.settingsTab);
  if ('liveStage' in out) out.liveStage = clampLiveStage(out.liveStage);
  if ('particlePool' in out) out.particlePool = clampStringArray(out.particlePool, PARTICLE_KIND_WHITELIST);
  if ('todPool' in out) out.todPool = clampStringArray(out.todPool, TOD_KIND_WHITELIST);
  // 界面记忆键（r24）：只收字符串，不校验有效性（失效时渲染端自动回落）
  for (const k of ['lastPreviewId', 'settingsEditMonitor']) {
    if (k in out && typeof out[k] !== 'string') out[k] = '';
  }
  return out;
}

/** 粒子种类白名单（r21，与渲染端 PARTICLE_KINDS / particles.js 的收紧保持一致） */
const PARTICLE_KIND_WHITELIST = [
  'rain', 'sakura', 'snow', 'fireflies', 'stars', 'bubbles', 'leaves',
  'confetti', 'fireworks', 'embers', 'splash', 'raindrops',
];

/** 时段滤镜白名单（r21，与 stage.js TOD_FILTERS 的键一致） */
const TOD_KIND_WHITELIST = ['morning', 'noon', 'overcast', 'dusk', 'night'];

/** 随机池收紧：只留白名单内的字符串，去重（空数组 = 全部参与，语义在消费端兜底） */
function clampStringArray(value, whitelist) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => typeof v === 'string' && whitelist.includes(v)))];
}

function normalizeBooleans(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = { ...obj };
  for (const key of BOOL_KEYS) if (key in out) out[key] = toBool(out[key]);
  return out;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 解析某一路轮播的生效配置。
 *
 * @param {object} config
 * @param {string|null} monitorId  显示器设备路径；null = 统一频道（直接用顶层配置）
 * @returns {{albumId:string, recursive:boolean, interval:number, animation:string,
 *            duration:number, shuffle:boolean, fit:string, enabled:boolean}}
 */
function resolveProfile(config, monitorId) {
  const base = {};
  for (const key of PROFILE_KEYS) base[key] = config[key];

  // 只读派生的 folder：绑定的是单目录相簿时回填目录路径。
  // 目的不是回退数据模型，而是让 tools/status.js 显示和旧验证脚本的断言继续可用；
  // 多目录相簿没有单一「目录」可言，留空。
  const legacyFolder = (albumId) => {
    const album = findAlbum(config, albumId || '');
    return album && album.folders.length === 1 ? album.folders[0].path : '';
  };

  if (!monitorId) {
    const withAlbum = { ...base, albumId: config.albumId || '', enabled: Boolean(config.applyToSystem) };
    return { ...withAlbum, folder: legacyFolder(withAlbum.albumId) };
  }

  const override = isPlainObject(config.monitors) ? config.monitors[monitorId] : null;
  const merged = override ? { ...base, ...override } : { ...base };
  if (!merged.albumId) merged.albumId = config.albumId || '';

  return {
    ...merged,
    interval: clampInterval(merged.interval),
    duration: clampDuration(merged.duration),
    animation: ANIMATIONS.has(merged.animation) ? merged.animation : 'slide',
    // fit：cover（铺满裁切）/ contain（完整显示·模糊底）/ mirror（完整显示·镜像延展）/
    //      collage（拼接填充：非同比例图按相簿邻居拼 N 联铺满，格数自动算、1 格退化单图）
    fit: ['contain', 'mirror', 'collage'].includes(merged.fit) ? merged.fit : 'cover',
    recursive: toBool(merged.recursive),
    shuffle: toBool(merged.shuffle),
    // 鼠标平移裁切：不写 = 默认开（只有显式 false 才关）
    cropPan: merged.cropPan !== false,
    folder: legacyFolder(merged.albumId),
    // 单屏是否被本程序接管；总开关 applyToSystem 仍然是一票否决
    enabled: (override && override.enabled === false) ? false : Boolean(config.applyToSystem),
  };
}

// 过渡动画全清单 —— 必须与 renderer/app.js 顶部 ANIMATIONS 表（下拉框）保持一致；
// 白名单外的值一律回落 slide（防旧配置/手改配置塞脏值炸调度器）。
const ANIMATIONS = new Set([
  'slide', 'fade', 'zoom', 'zoom-in', 'zoom-out', 'slide-zoom',
  'wipe', 'iris', 'blur-dissolve', 'clock', 'blinds', 'split', 'random',
]);

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.interval;
  return Math.min(Math.max(Math.round(n), 1), 24 * 3600);
}

function clampDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.duration;
  return Math.min(Math.max(Math.round(n), 0), 5000);
}

/**
 * 自动扫描间隔（分钟）：0 = 关闭，最小 1 分钟，上限 24 小时。
 *
 * 下限卡在 1 分钟不是随便定的 —— 相簿动辄上万张图，扫一次要走一遍目录树，
 * 太频繁就变成后台常驻的磁盘压力（用户的图库在 Syncthing 目录里，本来就有同步 IO）。
 */
function clampAutoScanMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.autoScanMinutes;
  return Math.min(Math.max(Math.round(n), 0), 24 * 60);
}

/** 设置面板分类页：不认识的 id 一律退回第一页，保证面板不会变成一片空白 */
function clampSettingsTab(value) {
  return SETTINGS_TABS.includes(value) ? value : DEFAULTS.settingsTab;
}
/**
 * 动态桌面的帧率上限：下限 5（再低就不像动画了），上限 240 纯防手滑（配置能手改）。
 * 只约束渲染层自己 tick 驱动的动画 —— CSS 动画在合成器里，rAF 节流无效。
 */
function clampLiveFps(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.liveStage.fpsCap;
  return Math.min(Math.max(Math.round(n), 5), 240);
}

/** 动态桌面子配置收紧：字段补默认、布尔归位；整体不是对象时整块回默认。 */
function clampLiveStage(value) {
  const src = isPlainObject(value) ? value : {};
  const d = DEFAULTS.liveStage;
  const idleMinRaw = Math.round(Number(src.idlePauseMinutes));
  return {
    fpsCap: clampLiveFps(src.fpsCap),
    pauseOnFullscreen: 'pauseOnFullscreen' in src ? toBool(src.pauseOnFullscreen) : d.pauseOnFullscreen,
    pauseOnBattery: 'pauseOnBattery' in src ? toBool(src.pauseOnBattery) : d.pauseOnBattery,
    pauseOnLock: 'pauseOnLock' in src ? toBool(src.pauseOnLock) : d.pauseOnLock,
    pauseOnIdle: 'pauseOnIdle' in src ? toBool(src.pauseOnIdle) : d.pauseOnIdle,
    idlePauseMinutes: Number.isFinite(idleMinRaw)
      ? Math.min(Math.max(idleMinRaw, 0), 120)
      : d.idlePauseMinutes,
    hideOnPaused: 'hideOnPaused' in src ? toBool(src.hideOnPaused) : d.hideOnPaused,
  };
}


/**
 * 计算一台显示器写入 monitors[id] 后的覆盖表。
 *
 * 两条规则：
 *   1. patch 里值为 null 的键 = 删除该覆盖，回落到顶层默认值；
 *   2. 与顶层默认值相同的键不落盘 —— 配置文件里只留「这台屏真正的差异」，
 *      以后改顶层默认值能一次性带动所有没单独设过的屏。
 */
function writeProfile(config, monitorId, patch) {
  const current = isPlainObject(config.monitors) ? config.monitors : {};
  const existing = isPlainObject(current[monitorId]) ? current[monitorId] : {};
  const merged = { ...existing };

  for (const [key, value] of Object.entries(normalizeBooleans(patch) || {})) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }

  const defaults = {};
  for (const key of PROFILE_KEYS) defaults[key] = config[key];

  const trimmed = {};
  if (merged.enabled === false) trimmed.enabled = false;   // 只有「显式关闭」才落盘
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'enabled') continue;
    if (defaults[key] !== value) trimmed[key] = value;
  }

  if (Object.keys(trimmed).length === 0) delete current[monitorId];
  else current[monitorId] = trimmed;

  return { ...current };
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._read();
  }

  _read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const merged = deepMerge(DEFAULTS, raw);
      if (!isPlainObject(merged.monitors)) merged.monitors = {};
      // 旧版「频道直接绑目录」的配置在这里自动变成相簿（只做一次，见函数注释）
      const migrated = migrateLegacyFolders(merged);
      migrated.albums = normalizeAlbums(migrated.albums);
      // 历史配置里可能躺着 'random' / 'order' 这类字符串，读进来就顺手收干净，
      // 下次 _write 会把规范化后的值写回文件
      for (const id of Object.keys(migrated.monitors)) {
        migrated.monitors[id] = normalizeBooleans(migrated.monitors[id]);
      }
      return normalizeConfig(migrated);
    } catch {
      return { ...DEFAULTS, monitors: {} };
    }
  }

  get() {
    return this.data;
  }

  set(patch) {
    this.data = deepMerge(this.data, normalizeConfig(patch));
    // 兜底迁移：patch 或旧数据里还躺着 folder 字段时（测试脚本 / 手改配置）也自动包装成相簿
    this.data = migrateLegacyFolders(this.data);
    this.data.albums = normalizeAlbums(this.data.albums);
    this._write();
    return this.data;
  }

  /** 只改某一台显示器的配置；patch 里值为 null 的键表示「删掉覆盖，回落默认」 */
  setMonitorProfile(monitorId, patch) {
    this.data = { ...this.data, monitors: writeProfile(this.data, monitorId, patch || {}) };
    // 兜底迁移与 set() 同款：旧脚本 / 旧入口还在用 { folder } 这种载荷时（set-profile），
    // folder 会作为差异键落进 monitors[id]，这里把它包装成相簿再换算成 albumId
    this.data = migrateLegacyFolders(this.data);
    this.data.albums = normalizeAlbums(this.data.albums);
    this._write();
    return resolveProfile(this.data, monitorId);
  }

  /** 清掉某台显示器的全部覆盖项 */
  clearMonitorProfile(monitorId) {
    const current = { ...(this.data.monitors || {}) };
    delete current[monitorId];
    this.data = { ...this.data, monitors: current };
    this._write();
    return resolveProfile(this.data, monitorId);
  }

  _write() {
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[store] 写入配置失败:', err.message);
    }
  }
}

module.exports = {
  Store,
  DEFAULTS,
  SETTINGS_TABS,
  PROFILE_KEYS,
  deepMerge,
  resolveProfile,
  writeProfile,
  clampInterval,
  clampLiveStage,
  newAlbumId,
  normalizeAlbums,
  findAlbum,
  migrateLegacyFolders,
};
