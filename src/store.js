'use strict';

/**
 * 配置持久化。
 *
 * 对照原 Python 版 load_unified_config / save_unified_config / _merge_config：
 *   Python 里配置迁移要手写几百行（_normalize_config_paths + _migrate_old_configs），
 *   这里用「默认值深合并」一次性解决，写盘走 tmp + rename 保证原子性。
 *
 * 配置模型（v2 起支持每屏独立）：
 *   ┌ 顶层字段 ─────────────────────────────────────────────┐
 *   │  folder / interval / animation / …  ← 「默认配置」      │
 *   └───────────────────────────────────────────────────────┘
 *                     ↓ 被继承
 *   ┌ monitors[<设备路径>] ──────────────────────────────────┐
 *   │  { folder, interval, animation, enabled, … }  ← 覆盖项 │
 *   └───────────────────────────────────────────────────────┘
 *   单屏只写自己关心的字段，其余自动回落到顶层默认值。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  folder: '',
  recursive: true,
  interval: 60,            // 秒
  animation: 'slide',      // slide | fade | zoom
  duration: 520,           // 毫秒
  shuffle: false,
  autoPlay: true,
  applyToSystem: true,     // 总开关：是否真正写系统壁纸
  monitor: 'all',          // 统一模式的写入目标：all | primary | window | <设备路径>
  fit: 'cover',            // cover | contain

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
  'folder', 'recursive', 'interval', 'animation', 'duration', 'shuffle', 'fit', 'skipSizeTwin',
];

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
  'shuffle', 'recursive', 'autoPlay', 'applyToSystem', 'applyOnStart', 'resumeLast',
  'perMonitor', 'skipSizeTwin', 'confirmDelete', 'autoMonitorSetup',
  'tray', 'closeToTray', 'startHidden', 'launchAtLogin',
  'filmstrip', 'filmstripAutoCenter', 'infoPanel', 'contextMenu',
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

/** 写盘 / 读盘前统一收一遍：布尔键收紧，热键只留字符串 */
function normalizeConfig(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = normalizeBooleans(obj);
  if ('hotkeys' in out) out.hotkeys = normalizeHotkeys(out.hotkeys);
  return out;
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
 * @returns {{folder:string, recursive:boolean, interval:number, animation:string,
 *            duration:number, shuffle:boolean, fit:string, enabled:boolean}}
 */
function resolveProfile(config, monitorId) {
  const base = {};
  for (const key of PROFILE_KEYS) base[key] = config[key];

  if (!monitorId) {
    return { ...base, folder: config.folder || '', enabled: Boolean(config.applyToSystem) };
  }

  const override = isPlainObject(config.monitors) ? config.monitors[monitorId] : null;
  const merged = override ? { ...base, ...override } : { ...base };
  if (!merged.folder) merged.folder = config.folder || '';

  return {
    ...merged,
    interval: clampInterval(merged.interval),
    duration: clampDuration(merged.duration),
    animation: ANIMATIONS.has(merged.animation) ? merged.animation : 'slide',
    fit: merged.fit === 'contain' ? 'contain' : 'cover',
    recursive: toBool(merged.recursive),
    shuffle: toBool(merged.shuffle),
    // 单屏是否被本程序接管；总开关 applyToSystem 仍然是一票否决
    enabled: (override && override.enabled === false) ? false : Boolean(config.applyToSystem),
  };
}

const ANIMATIONS = new Set(['slide', 'fade', 'zoom']);

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
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const merged = deepMerge(DEFAULTS, JSON.parse(raw));
      if (!isPlainObject(merged.monitors)) merged.monitors = {};
      // 历史配置里可能躺着 'random' / 'order' 这类字符串，读进来就顺手收干净，
      // 下次 _write 会把规范化后的值写回文件
      for (const id of Object.keys(merged.monitors)) {
        merged.monitors[id] = normalizeBooleans(merged.monitors[id]);
      }
      return normalizeConfig(merged);
    } catch {
      return { ...DEFAULTS, monitors: {} };
    }
  }

  get() {
    return this.data;
  }

  set(patch) {
    this.data = deepMerge(this.data, normalizeConfig(patch));
    this._write();
    return this.data;
  }

  /** 只改某一台显示器的配置；patch 里值为 null 的键表示「删掉覆盖，回落默认」 */
  setMonitorProfile(monitorId, patch) {
    this.data = { ...this.data, monitors: writeProfile(this.data, monitorId, patch || {}) };
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
  PROFILE_KEYS,
  deepMerge,
  resolveProfile,
  writeProfile,
  clampInterval,
};
