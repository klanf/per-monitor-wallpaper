'use strict';

/**
 * 多频道轮播调度器。
 *
 * 【为什么调度器必须在主进程】
 *   旧版把「定时推进 + 写系统壁纸」放在渲染进程里 —— 一个窗口只有一条时间线，
 *   物理上就不可能有「A 屏每 30 秒换、B 屏每 5 分钟换」。
 *   要做每屏独立，就必须有 N 条互不干扰的时间线，而它们又不能依赖某个窗口活着。
 *   所以：一个频道 = 一路独立轮播，状态（图片列表 / 索引 / 随机序列 / 定时器）
 *   全在主进程，渲染进程退化成一台「监视器」——只负责把频道当前帧画出来。
 *
 *   channels[]                      渲染进程（只预览其中一个频道）
 *   ┌──────────────┐
 *   │ 频道 = 屏 0   │ ── timer 30s ──► IDesktopWallpaper::SetWallpaper(屏0, 图)
 *   ├──────────────┤                        │
 *   │ 频道 = 屏 1   │ ── timer 300s ─► SetWallpaper(屏1, 图)
 *   └──────────────┘                        │
 *        │  channel:tick                   │
 *        └──────────────────────────────────┘
 *
 * 【两种模式】
 *   perMonitor = false → 只有一条「统一频道」，行为与旧版一致（目标由 monitor 字段决定）
 *   perMonitor = true  → 每台检测到的显示器一条频道，各自独立的目录 / 间隔 / 动画 / 顺序
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

/**
 * 失效图片处理的几个常量。
 *
 * 背景：播放列表来自扫描缓存，而图片可能被外部删掉（资源管理器 / Syncthing 同步删除）。
 * 只要列表里还留着一条已不存在的路径，切到它时就会「桌面不动一拍 + 弹错误」。
 * 现在的策略是写前预检、就地摘除、立即补一张（用户拍板：静默跳过，看不到死帧）。
 */
const MAX_WRITE_ATTEMPTS = 4;          // 一次切换最多试几张（全读不出来时别死循环）
const MASS_SKIP = 12;                  // 一次切换里连续摘掉这么多张 → 列表大概率整体过期，触发重扫
const MASS_RESCAN_COOLDOWN_MS = 60000; // 两次「大面积失效重扫」之间的最小间隔

/*
 * 扫描缓存持久化（2026-10-16 冷开机提速，方案 A）。
 *
 * 背景：相库在机械盘（F: 4TB HDD）上，冷开机时 4 万+ 文件的目录遍历与杀毒扫描、
 * Syncthing 自启扫描抢盘，实测把启动重建拖到 90 秒以上，而 `await rebuild('startup')`
 * 又串行堵着舞台窗口的创建 —— 登录后壁纸两分钟才出来。
 * 热缓存实测同一份扫描只要 0.21 秒，所以把扫描结果落盘、启动时同步水合，
 * 重建就不再碰磁盘（失效条目由写入链的 existsSync 预检 + 大面积失效重扫兜底，
 * 与「Syncthing 同步删除」的既有容错策略同源）。
 */
const SCAN_CACHE_SAVE_DELAY_MS = 3000;              // 扫描后延迟落盘（合并同一次 rebuild 的多次扫描）
const SCAN_CACHE_REFRESH_AFTER_STARTUP_MS = 300000; // 启动用了磁盘缓存 → 五分钟后后台刷新一次（第七十六轮：120s→300s，避开开机后用户点托盘/看预览的操作高峰，别让全量重扫抢那几分钟的 IO）
const SCAN_CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 缓存条目 30 天不用 —— 目录结构大改后老缓存不值得信
const SCAN_CACHE_MAX_FILES = 400000;                 // 单目录条目的文件数护栏（防异常膨胀）
const EMPTY_RECHECK_DELAY_MS = 60000;                // 「有图 → 突然扫空」的复核延迟：给同步/盘忙留恢复窗口

/** 拼接邻居（r38）：拼格里只放得下静态图，这些扩展名之外的（视频/网页）跳过 */
const COLLAGE_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.avif', '.gif', '.tif', '.tiff']);

/** 写失败的错误文案算不算「文件已经没了」 */
function isMissingError(text) {
  return typeof text === 'string' && (text.includes('文件不存在') || text.includes('ENOENT'));
}

const { scanFolder, kindFor } = require('./scanner');
const { resolveProfile, findAlbum } = require('./store');
const { probeFile } = require('./scanner');
const win32 = require('./win32');
const liveDesktop = require('./liveDesktop');

const UNIFIED_ID = '__unified__';

/**
 * 洗牌时做「相邻同体积」整理的张数上限 —— 要 stat 全部文件，
 * 几百张是几十毫秒，而 30348 张要 20 秒以上，所以只对小目录做。
 */
const SHUFFLE_TWIN_MAX = 4096;

/** 洗一次最多重试几次，直到没有「相邻同体积」 */
const SHUFFLE_TRIES = 16;

/**
 * Fisher-Yates 洗牌（原地）。壁纸顺序用不上密码学强度，Math.random 够了。
 */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

class MonitorScheduler {
  /**
   * @param {object} deps
   * @param {import('./store').Store} deps.store
   * @param {string} deps.cacheDir
   * @param {() => {ok:boolean, error?:string, monitors:Array}} deps.enumerate
   *        枚举显示器（每台含 id / label / width / height / primary）
   * @param {() => {monitorId:string|null, label:string}} deps.resolveUnifiedTarget
   *        统一模式的写入目标解析（all / primary / window / 指定设备）
   * @param {(type:string, payload:object) => void} [deps.onEvent]
   * @param {(path:string, cacheDir:string, options:object) => Promise<object>} [deps.writeWallpaper]
   *        实际写入系统壁纸的函数。默认走 win32；测试时可注入替身，
   *        这样既能完整验证调度逻辑，又不会真的改用户的桌面。
   * @param {import('./playbackState').PlaybackState} [deps.playback]
   *        播放位置的磁盘存档（跨进程重启）。不传就只有内存进度，
   *        行为跟以前一样（重启从第一张开始）—— 测试可以按需注入。
   * @param {() => boolean} [deps.isLiveDegraded]
   *        动态桌面窗口是否已失效（挂载失败 / 被拆且救不回来）。由 liveStage 层注入；
   *        失效时降频写自动放开（degraded-fallback），显示职责交回系统壁纸。
   *        不传按「从未失效」处理 —— 单测里也能注入来验证这条兜底。
   * @param {string} [deps.scanCacheFile]
   *        扫描结果持久化文件（userData/scan-cache.json）。不传 = 维持旧行为：
   *        每次启动全量重扫（单测不注入，行为不变）。
   */
  constructor({ store, cacheDir, enumerate, resolveUnifiedTarget, onEvent, writeWallpaper, playback, orders, isLiveDegraded, isPaused, scanCacheFile }) {
    this.store = store;
    this.cacheDir = cacheDir;
    this.enumerate = enumerate;
    this.resolveUnifiedTarget = resolveUnifiedTarget;
    this.onEvent = onEvent || (() => {});
    this.writeWallpaper = writeWallpaper
      || ((imagePath, cacheDir, options) => win32.setWallpaper(imagePath, cacheDir, options));
    this.playback = playback || null;
    // 顺序持久化（r34）：跨重启保留每频道的列表顺序（shuffleOrders.js）。
    // 不注入（单测多数场景）= 维持旧行为：每次启动重新洗。
    this.ordersStore = orders || null;
    this.isLiveDegraded = isLiveDegraded || (() => false);
    this.isPaused = isPaused || (() => false);   // 显示器被冻结（全屏/挂机）时不推进轮播

    this.channels = new Map();
    /** 目录扫描结果缓存：多个频道指向同一目录时不重复扫盘 */
    this.scanCache = new Map();
    /** 重建之间要保留的播放进度（改个间隔不该把轮播打回第一张） */
    this.progress = new Map();
    /**
     * 本次会话每个频道播放过的序号集合，key = 频道 id。
     * 存在这里而不是只挂在 channel 上，是为了让 rebuild 之后胶片条的
     * 「看过 / 没看过」标记不丢。channel.played 是这个 Set 的同一引用。
     */
    this.played = new Map();
    /** 每个频道上次绑的相簿；换相簿时用来判断该不该清空 played */
    this.playedAlbum = new Map();
    /** 每个频道的列表顺序（随机模式下跨 rebuild 保留，只有走完一轮才重排） */
    this.orders = new Map();
    // r34：把磁盘存档里上次的顺序水合进内存 —— 重启后 _orderFor 直接按上次的
    // 顺序复用，不再重新洗。相簿变了 / 切了播放模式时 saved 会被 _orderFor 判废。
    if (this.ordersStore) {
      for (const [id, rec] of Object.entries(this.ordersStore.all())) {
        this.orders.set(id, { albumId: rec.albumId, shuffle: Boolean(rec.shuffle), paths: rec.paths.slice() });
      }
    }
    /** 每个频道走完了几轮 —— 每走完一轮重洗一次，这个数只增不减 */
    this.rounds = new Map();
    /**
     * 正在进行的壁纸写入（Promise 集合）。
     * 重建前要等它们结束 —— 写系统壁纸是 COM 调用，可能几百毫秒，
     * 不等的话会出现「改了配置之后，旧配置的那一张才落到桌面上」，把新图盖掉。
     */
    this.pendingWrites = new Set();
    this.buildChain = Promise.resolve();
    this.tookOver = false;
    this.lastEnumError = null;
    /** 定时自动扫描的定时器（见 _armAutoScan）；关闭时为 null */
    this.scanTimer = null;
    /** 「有图 → 突然扫空」复核定时器（见 _rebuild 末尾的空态自愈）；闲时为 null */
    this._emptyRecheckTimer = null;
    /** 上次自动扫描的时刻（时间戳，0 = 本次会话还没扫过）；渲染层据此显示「上次扫描 …」 */
    this.lastAutoScanAt = 0;

    /*
     * 扫描缓存持久化（方案 A，2026-10-16）：构造时同步水合磁盘缓存，
     * 启动 rebuild 的 _scan 全部命中内存 → 不碰机械盘，冷开机的 90 秒消失。
     * 水合是同步读（几 MB JSON，NVMe 上几十毫秒）：后面的 takeover 写壁纸
     * 指望这份列表，异步水合会把竞态引进「第一张上屏」的链路。
     */
    this.scanCacheFile = scanCacheFile || null;
    this._scanDirty = false;          // 内存缓存有磁盘上没有的新鲜扫描 → 该落盘
    this._scanSaveTimer = null;
    this._startupRefreshTimer = null;
    this._hydratedKeys = new Set();   // 从磁盘水合来的缓存键（命中才算「启动用了缓存」）
    this._usedDiskScan = false;       // 本次启动 rebuild 是否吃到过磁盘缓存
    if (this.scanCacheFile) this._hydrateScanCache();
  }

  _emit(type, payload) {
    try {
      this.onEvent(type, { type, ...payload });
    } catch (err) {
      console.error('[scheduler] 事件回调异常:', err.message);
    }
  }

  /* ------------------------------------------------------------ 构建 */

  /** 串行化重建，避免连续改配置时两次 build 交叉 */
  rebuild(reason = 'manual') {
    this.buildChain = this.buildChain
      .then(() => this._rebuild(reason))
      .catch((err) => console.error('[scheduler] 重建失败:', err && err.message));
    return this.buildChain;
  }

  async _rebuild(reason) {
    /*
     * 光 clearTimeout 是不够的。
     *
     * _advance 是异步的（要 stat 体积、要 await 写壁纸），重建发生时它可能正卡在
     * 中间；那一轮走完会执行到 goTo 末尾的 _schedule(ch) —— 把这个**已经被丢弃**的
     * 频道重新武装起来。结果就是：切到统一模式 / 拔掉一块屏之后，旧频道仍在按自己的
     * 节奏写壁纸，和新配置抢桌面。
     *
     * 所以除了取消定时器，还要打上 retired 标记，让在途的那一轮自己停手。
     */
    for (const ch of this.channels.values()) {
      clearTimeout(ch.timer);
      ch.timer = null;
      ch.retired = true;
    }
    // 清掉之前记一份「每路原有几张图」：空态自愈（见 _rebuild 末尾）要用它判断
    // 「原来有图 → 这一轮扫出 0 张」的突变，而不是把本来就空的相簿反复复核
    const prevCounts = new Map();
    for (const ch of this.channels.values()) prevCounts.set(ch.id, ch.files.length);
    this.channels.clear();

    // 等在途的写入收尾：否则旧配置的那一张会在切换之后才写上去，把新配置的图盖掉。
    // 上有 1.5 秒上限 —— 写入函数万一卡住，也不能把整个重建堵死。
    if (this.pendingWrites.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.pendingWrites]),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    }

    const config = this.store.get();
    let monitors = [];
    try {
      const result = this.enumerate();
      this.lastEnumError = result.ok ? null : (result.error || '枚举显示器失败');
      monitors = result.monitors || [];
    } catch (err) {
      this.lastEnumError = err.message;
    }

    const specs = [];
    if (config.perMonitor && monitors.length) {
      for (const monitor of monitors) {
        specs.push({
          id: monitor.id,
          kind: 'monitor',
          monitor,
          profile: resolveProfile(config, monitor.id),
        });
      }
    } else {
      specs.push({
        id: UNIFIED_ID,
        kind: 'unified',
        monitor: null,
        profile: resolveProfile(config, null),
      });
    }

    // 并行扫描各频道的相簿（同目录命中缓存；相簿 = 启用目录按序拼接）
    const built = await Promise.all(specs.map(async (spec) => {
      const scan = await this._scanAlbum(spec.profile);
      return { ...spec, ...scan };
    }));

    /** 本次 rebuild 中「用户显式切换了相簿」的频道 id（下面循环里填，切换后立即上屏用） */
    const albumSwitchedIds = new Set();

    // 逐个频道定下这一轮的顺序（随机模式在这里洗牌，见 _orderFor）
    for (const item of built) {
      if (item.files.length) {
        item.files = await this._orderFor(item.id, item.files, item.profile, item.profile.albumId);
      }
    }

    const takeOver = !this.tookOver && config.applyOnStart !== false;

    for (const item of built) {
      /*
       * 起点从哪来，优先级：
       *   ① 本次会话已经播过 → 内存里的 progress（改个间隔不该把轮播打回第一张）
       *   ② 磁盘上的存档 → 上一次进程（可能是昨天关机前）停在哪张
       *   ③ 都没有 → 第一张
       */
      const saved = this.progress.get(item.id)
        || this._restoreProgress(item.id, item.files, item.profile, config);
      const max = Math.max(0, item.files.length - 1);

      // played 集合跨 rebuild 复用；拿同一引用回写，channel 上改就等于 map 里改
      let played = this.played.get(item.id);
      if (!played) {
        played = new Set();
        this.played.set(item.id, played);
      }

      // 换相簿了 → 旧的「看过」序号对新列表毫无意义，留着只会把没看过的标成看过
      const prevAlbum = this.playedAlbum.get(item.id);
      const albumSwitched = prevAlbum !== undefined && prevAlbum !== item.profile.albumId;
      if (albumSwitched) {
        played.clear();
        albumSwitchedIds.add(item.id);
      }
      this.playedAlbum.set(item.id, item.profile.albumId);

      // 显式切换相簿 → 从新相簿开头播（随机模式下是洗牌后的第一张），
      // **不再沿用旧相簿的进度序号**：沿用的话桌面只是「从新相簿中间继续轮」，
      // 用户看到的还是又换了一张动画图，完全没有「切到新相簿」的可见跳变
      // （2026-10-09 用户实测：切相簿后观感 = 没切）。改间隔等普通 rebuild
      // 不受影响（albumId 没变，照旧从 progress 续播）。
      const index = albumSwitched ? 0 : (saved ? Math.min(saved.index, max) : 0);
      // 当前正在显示的这张算「看过」，否则刚开软件时胶片条会把首图标成未看
      if (item.files.length) played.add(index);

      const channel = {
        ...item,
        index,
        playing: saved && typeof saved.playing === 'boolean'
          ? saved.playing
          : config.autoPlay !== false,
        timer: null,
        lastWrite: null,
        lastError: item.error,
        /**
         * 本轮（本次会话）读不出来的图片：文件还在但解码/转码失败，
         * 常见于 Syncthing 半同步、下载中的文件、损坏文件。
         * 标记后本次不再尝试它，重扫或重启会重新开一轮（文件可能已经同步好）。
         */
        badFiles: new Set(),
        /** 上一次「跳过了失效图片」的统计，渲染层据此做聚合提示 */
        lastSkip: null,
        lastMassRescan: 0,
        writes: 0,
        ticks: 0,          // 累计推进次数 —— 索引会绕回，这个只会单调增长
        rev: 0,            // 文件列表修订号 —— 删除/移动后就地更新时自增
        rounds: this.rounds.get(item.id) || 0,
        played,
      };
      this.channels.set(channel.id, channel);
    }

    /*
     * 空态自愈：原来有图的频道这一轮扫出 0 张 —— 几乎可以断定是扫描那一瞬间
     * 目录读不到 / 正被搬空的误判（空结果已不进缓存，见 _scan），但本次 rebuild
     * 已经把空列表 adopt 进来了，光不缓存救不了这一轮。安排一次延迟 autoScan
     * 复核：目录恢复 → 图回来（autoScan 不洗牌不动画面）；目录真被清空/删掉
     * → 复核结果还是 0，prevCounts 归零后不再复核，不会循环。
     * （目录失效和短暂不可读在 probeFile 层面区分不了，统一复核 —— 代价只是
     * 60s 后多一次扫描。）
     */
    const wentEmpty = [...built].filter((item) =>
      !item.files.length && (prevCounts.get(item.id) || 0) > 0);
    if (wentEmpty.length) {
      console.log(`[scheduler] ${wentEmpty.length} 个频道从有图扫成空（目录都在），${Math.round(EMPTY_RECHECK_DELAY_MS / 1000)}s 后复核一次`);
      this._armEmptyRecheck();
    }

    this.tookOver = true;

    // 启动接管：立刻把当前帧写上去，否则最长要等一个 interval 才看得到变化。
    // 第七十六轮：不再 await —— 写系统壁纸 = 冷盘读图 + COM 调用，冷开机下
    // 拖住 rebuild 2~3s（实测 rebuild('startup') 3906ms 的大头）。动态舞台的显示
    // 走 channels:changed 自己上屏，不依赖这次写入；写入 Promise 已登记
    // pendingWrites，后续任何 rebuild 开头都会先等在途写入收尾（1.5s 上限），
    // 不会出现「旧图盖新图」。
    if (takeOver) {
      const targets = [...this.channels.values()].filter((ch) => ch.profile.enabled && ch.files.length);
      for (const ch of targets) this._write(ch, 'takeover').catch(() => {});
    }

    // 显式切换相簿的频道：立刻把新相簿第一张推上桌面，不等下一个 interval。
    // stage 路径靠 channels:changed 的 applyChannels 也会立即换图，但这里同时
    // 覆盖系统壁纸路径（applyToSystem）并刷新 playback.json 存档，两条路都齐。
    if (!takeOver && albumSwitchedIds.size) {
      const switched = [...this.channels.values()].filter(
        (ch) => albumSwitchedIds.has(ch.id) && ch.profile.enabled && ch.files.length);
      await Promise.all(switched.map((ch) => this._write(ch, 'album-switch')));
    }

    for (const ch of this.channels.values()) this._schedule(ch);

    // 无论从哪条路径进的重建（启动 / 改配置 / 插拔显示器 / 扫描完），定时扫描都按最新配置重新计时
    this._armAutoScan();

    // 启动吃了磁盘缓存 → 安排一次延迟的后台刷新（见 _armStartupRefresh）
    if (reason === 'startup' && this._usedDiskScan) this._armStartupRefresh();

    this._emit('channels', { reason, channels: this.list() });
  }

  /**
   * 按配置重新武装「定时自动扫描」定时器。
   *
   * 挂在 _rebuild 末尾而不是各自调用点 —— 改配置、切模式、插拔显示器、手动重扫
   * 最后都会落到 rebuild，于是不管哪条路径改的间隔都能立刻生效，
   * 不用每个调用点都记得去刷一次定时器（漏一处的代价是「改了间隔却按旧间隔扫」）。
   */
  _armAutoScan() {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    const minutes = Number(this.store.get().autoScanMinutes) || 0;
    if (minutes <= 0) return;

    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.autoScan().catch((err) => console.error('[scheduler] 自动扫描失败:', err && err.message));
    }, Math.round(minutes * 60000));

    /*
     * unref：这个定时器不该把进程钉住。
     * 单测里没调 stop() 也能干净收尾；Electron 主进程的存活本来就靠窗口 / 托盘，
     * 不靠这个定时器 —— 而定时器到点照旧会开火（只要进程还活着）。
     */
    if (typeof this.scanTimer.unref === 'function') this.scanTimer.unref();
  }

  /**
   * 「有图 → 突然扫空」的延迟复核（自愈链的最后一环，见 _rebuild 末尾）。
   * 走 autoScan：不洗牌、按路径找回当前帧，画面不动；只挂一个，重复触发不叠加。
   */
  _armEmptyRecheck() {
    if (this._emptyRecheckTimer) return;
    this._emptyRecheckTimer = setTimeout(() => {
      this._emptyRecheckTimer = null;
      console.log('[scheduler] 空态复核：重新扫描一次');
      this.autoScan().catch((err) => console.error('[scheduler] 空态复核失败:', err && err.message));
    }, EMPTY_RECHECK_DELAY_MS);
    if (typeof this._emptyRecheckTimer.unref === 'function') this._emptyRecheckTimer.unref();
  }

  /**
   * 自动扫描：丢掉扫描缓存 + 重建，**不洗牌**。
   *
   * 与手动「重新扫描」唯一的差别就在这一句 orders 不去动：
   *   手动重扫 = 用户明确要「重来一遍」，连播放顺序一起洗（rescan 的既定语义）；
   *   自动扫描 = 后台静默发生，把正在看的顺序搅乱只会让人莫名其妙。
   * 只清缓存的效果是：新丢进目录的图接在列表末尾（_orderFor 的既定行为）、
   * 已删的图自然消失、当前这张靠 progress 按路径找回 —— 画面和顺序都不动。
   */
  async autoScan() {
    /*
     * 先记下每路「当前正在显示的是哪张」——记**路径**而不是序号。
     *
     * progress 里存的是序号，而列表前面少了一张图时序号会整体前移：
     * 播到第 2 张、第 1 张被删 → 序号 1 现在指的是原来的第 3 张，画面凭空跳一张。
     * （实测就是这个现象：s-1 被删后，当前帧从 s-2 跳成了 s-3。）
     * 所以扫描完要按路径把当前帧找回去 —— 后台静默发生的事，画面不该有动静。
     */
    const before = new Map();
    for (const [id, ch] of this.channels) {
      const entry = ch.files[ch.index];
      if (entry) before.set(id, entry.path);
    }

    // 记在扫描前：扫描本身只有几十毫秒，而这样推送出去的时间就是准的
    this.lastAutoScanAt = Date.now();
    this.scanCache.clear();
    await this.rebuild('auto-scan');

    for (const [id, wanted] of before) {
      const ch = this.channels.get(id);
      if (!ch || !ch.files.length) continue;
      const at = ch.files.findIndex((f) => f.path === wanted);
      // 当前这张自己被删了才真的换一张（那时也别挑，停在原位等价的下一张）
      if (at >= 0 && at !== ch.index) {
        ch.index = at;
        this._remember(ch);
      }
    }
  }

  /**
   * 从磁盘存档里恢复「上次停在哪张」。
   *
   * 为什么**先按路径找**：万一顺序对不上号（存档损坏 / orders 被手动删了导致
   * 重洗），序号就没了意义 —— 只有路径能找回「就是这张」。
   * 路径找不到（图被删了、改了名）才退回序号，并对齐到当前列表范围内：
   * 少几张也不至于甩回第一张。
   *
   * 换过目录则整条记录不认 —— 上一次的「第 27 张」指的是另一个目录里的另一张图，
   * 拿过来用只会莫名其妙地跳过一段。
   */
  _restoreProgress(id, files, profile, config) {
    if (!this.playback || !files.length) return null;
    if (config && config.resumeLast === false) return null;

    const rec = this.playback.get(id);
    if (!rec) return null;

    /*
     * 记录对齐：新记录存相簿 id；旧版（v17 及以前）存的是目录路径。
     * 旧记录用「路径属于这个相簿」来认亲 —— 升级后的第一次重启还能接着播，
     * 而不是甩回第一张。两边都对不上才判定「换源了」，整条记录不认。
     */
    if (rec.album) {
      if (rec.album !== profile.albumId) return null;
    } else if (rec.folder) {
      const album = findAlbum(config, profile.albumId);
      const paths = album ? album.folders.map((f) => f.path.toLowerCase()) : [];
      if (!paths.includes(rec.folder.toLowerCase())) return null;
    }

    let index = -1;
    if (rec.path) index = files.findIndex((f) => f.path === rec.path);
    if (index < 0) index = Number.isFinite(rec.index) && rec.index >= 0 ? rec.index : 0;
    index = Math.max(0, Math.min(index, files.length - 1));

    return { index, playing: rec.playing };
  }

  /**
   * 记住这一路播到哪张。
   *
   * 两个去处，各管一段：
   *   progress（内存）→ 本次会话内 rebuild 时不被重置（原有行为）
   *   playback（磁盘）→ 下次启动时接着播（本次新增）
   * 所有会改变「当前是哪张」的地方统一走这里，免得漏一处就出个「偶尔回到第一张」。
   * 磁盘记录按相簿 id 归属（旧版存目录路径，恢复时两种都认，见 _restoreProgress）。
   */
  _remember(ch) {
    this.progress.set(ch.id, { index: ch.index, playing: ch.playing });
    if (!this.playback) return;
    if (this.store.get().resumeLast === false) return;

    const entry = ch.files[ch.index];
    this.playback.set(ch.id, {
      index: ch.index,
      path: entry ? entry.path : null,
      album: ch.profile.albumId || '',
      playing: Boolean(ch.playing),
    });
  }

  /**
   * 扫描目录（带缓存）。只负责「目录里有什么」，顺序交给频道层（见 _orderFor）——
   * 缓存是多个频道共享的，在里面洗牌会让「一个频道走完一轮重洗」波及另一个频道。
   */
  async _scan(folder, recursive) {
    const key = `${folder}::${recursive ? 1 : 0}`;
    const cached = this.scanCache.get(key);
    if (cached) {
      // 磁盘水合来的缓存被启动重建用上了 → 记一笔，rebuild 末尾据此安排后台刷新
      if (this._hydratedKeys.has(key)) this._usedDiskScan = true;
      return cached;
    }

    const started = Date.now();
    const { files, truncated } = await scanFolder(folder, { recursive });
    const result = {
      files: files.map((f) => ({ ...f, url: pathToFileURL(f.path).href })),
      truncated,
      elapsedMs: Date.now() - started,
      folder,
      recursive,
    };
    /*
     * 空结果**不进缓存**：目录读不到的那一瞬间（Syncthing 同步锁、盘繁忙、
     * 杀软扫描），scanFolder 会把 readdir 失败静默当「目录为空」返回 ——
     * 缓存住它之后每次 rebuild 都复用，相簿就被钉死在空态，只能手动重扫
     * （2026-10-28 用户实报：桌面还在播、托盘却说没图）。空目录每次 rebuild
     * 重扫一遍只是一次 readdir 的开销，换来「误判空」在下次重建必然自愈。
     */
    if (result.files.length) {
      this.scanCache.set(key, result);
      this._markScanDirty();
    }
    return result;
  }

  /**
   * 每个相簿的图片张数（顶栏相簿快切菜单的「空相簿禁切」闸门用，2026-11-08）。
   *
   * 缓存命中的目录直接用（零磁盘）；没命中的现场扫一遍 —— 空结果不进缓存
   * （见 _scan），所以「缓存里没有」可能是从未扫过、也可能目录已失效
   * （如目录被改名/盘没挂），必须 readdir 才能确认，不能只信缓存把空相簿放行。
   * scanFolder 只是 readdir 级开销，菜单打开时几百毫秒可接受；扫过的结果
   * 顺手进缓存，下次 rebuild 直接复用。
   *
   * @returns {Promise<Map<string, number>>} albumId → 图片张数（无启用目录 = 0）
   */
  async countAlbumImages() {
    const albums = this.store.get().albums || [];
    const out = new Map();
    for (const a of albums) {
      const seen = new Set();   // 按文件路径去重：父子目录同加、递归/非递归两键都在时不重复计
      let hasEnabled = false;
      for (const f of a.folders || []) {
        if (f.enabled === false) continue;
        hasEnabled = true;
        let files = null;
        for (const recursive of [1, 0]) {
          const cached = this.scanCache.get(`${f.path}::${recursive}`);
          if (cached) { files = cached.files; break; }
        }
        if (!files) files = (await this._scan(f.path, true)).files;
        for (const file of files) seen.add(file.path);
      }
      out.set(a.id, hasEnabled ? seen.size : 0);
    }
    return out;
  }

  /**
   * 构造时同步水合磁盘扫描缓存（scanCacheFile 存在才调用）。
   *
   * 只恢复「目录里有什么」，不复核每个文件是否还在 —— 逐个 existsSync 就把
   * 冷开机的磁盘风暴请回来了，违背本优化的初衷。失效条目由既有容错链兜底：
   * 写前 existsSync 预检就地摘除、一次切换摘掉 ≥12 张触发重扫、12 小时 autoScan。
   * 条目超龄（30 天）/ 超量 / 结构不对 / 目录不复存在都不认，宁可重扫。
   */
  _hydrateScanCache() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.scanCacheFile, 'utf8');
    } catch {
      return;   // 不存在 / 首次运行：冷启动照旧全量扫
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.warn('[scheduler] 扫描缓存损坏，本次启动全量重扫:', err.message);
      return;
    }
    if (!data || data.version !== 1 || !data.entries || typeof data.entries !== 'object') return;

    const now = Date.now();
    for (const [key, entry] of Object.entries(data.entries)) {
      if (!entry || !Array.isArray(entry.files)) continue;
      if (typeof entry.folder !== 'string' || typeof entry.recursive !== 'boolean') continue;
      if (!Number.isFinite(entry.savedAt) || now - entry.savedAt > SCAN_CACHE_MAX_AGE_MS) continue;
      if (entry.files.length > SCAN_CACHE_MAX_FILES) continue;
      if (!fs.existsSync(entry.folder)) continue;   // 目录没了（断盘/删除/改名）→ 这条整个不认
      const files = [];
      for (const row of entry.files) {
        // 落盘格式是紧凑三元组 [path, name, ext]（4.4 万条能省一半体积）
        if (!Array.isArray(row) || row.length < 3) continue;
        const [p, name, ext] = row;
        if (typeof p !== 'string') continue;
        files.push({ path: p, name, ext, url: pathToFileURL(p).href });
      }
      if (!files.length) continue;
      this.scanCache.set(key, {
        files,
        truncated: Boolean(entry.truncated),
        elapsedMs: 0,
        folder: entry.folder,
        recursive: entry.recursive,
      });
      this._hydratedKeys.add(key);
    }
    if (this._hydratedKeys.size) {
      const total = [...this._hydratedKeys].reduce((n, k) => n + (this.scanCache.get(k).files.length), 0);
      console.log(`[scheduler] 已从磁盘恢复 ${this._hydratedKeys.size} 个目录的扫描缓存（共 ${total} 条）`);
    }
  }

  /** 有新的真实扫描结果 → 合并延迟落盘（同一次 rebuild 的多目录扫描只写一次盘） */
  _markScanDirty() {
    if (!this.scanCacheFile) return;
    this._scanDirty = true;
    if (this._scanSaveTimer) return;
    this._scanSaveTimer = setTimeout(() => {
      this._scanSaveTimer = null;
      this._saveScanCache();
    }, SCAN_CACHE_SAVE_DELAY_MS);
    if (typeof this._scanSaveTimer.unref === 'function') this._scanSaveTimer.unref();
  }

  /**
   * 把当前内存扫描缓存整体落盘（原子写：tmp + rename）。
   * 是「全量镜像」而不是增量 —— rescan/失效摘除清掉的键自然也随之从盘上消失。
   */
  async _saveScanCache() {
    if (!this.scanCacheFile || !this._scanDirty) return;
    this._scanDirty = false;
    const entries = {};
    for (const [key, r] of this.scanCache) {
      if (!r || !Array.isArray(r.files) || !r.files.length) continue;
      if (r.files.length > SCAN_CACHE_MAX_FILES) continue;
      entries[key] = {
        folder: r.folder,
        recursive: r.recursive,
        truncated: Boolean(r.truncated),
        savedAt: Date.now(),
        files: r.files.map((f) => [f.path, f.name, f.ext]),
      };
    }
    const tmp = `${this.scanCacheFile}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), entries }), 'utf8');
      await fsp.rename(tmp, this.scanCacheFile);
    } catch (err) {
      console.warn('[scheduler] 扫描缓存写盘失败:', err.message);
    }
  }

  /**
   * 启动吃了磁盘缓存 → 列表可能是旧的（关机期间新进的图不在）。
   * 两分钟后盘已热，后台静默刷新一次 —— 走 autoScan：不洗牌、按路径找回
   * 当前帧，画面不动；刷完 _markScanDirty 把新鲜结果写回磁盘。
   */
  _armStartupRefresh() {
    if (this._startupRefreshTimer) return;
    this._startupRefreshTimer = setTimeout(() => {
      this._startupRefreshTimer = null;
      console.log('[scheduler] 启动用了磁盘缓存，后台刷新一次扫描');
      this.autoScan().catch((err) => console.error('[scheduler] 启动后刷新扫描失败:', err && err.message));
    }, SCAN_CACHE_REFRESH_AFTER_STARTUP_MS);
    if (typeof this._startupRefreshTimer.unref === 'function') this._startupRefreshTimer.unref();
  }

  /**
   * 扫描一个频道的相簿 —— 相簿里每个启用的目录各扫各的，再按目录顺序拼接。
   *
   * 「目录顺序即播放顺序」：顺序模式（非随机）下胶片条会呈现出章节感 ——
   * 哪个目录排在前面就先播哪个，组内保持按名称排；随机模式不受影响（拼好再全池洗）。
   * 拼接按完整路径去重：目录之间有嵌套/重叠时同一张图只收一次。
   * 失效目录（被删 / 改名 / 断盘）不炸整个相簿 —— 跳过并在 missingDirs 里标注，
   * 让设置面板能给出看得见的警告。
   */
  async _scanAlbum(profile) {
    const empty = { files: [], truncated: false, scanMs: 0, error: null, missingDirs: [], albumName: '', activeDirs: [] };
    const album = findAlbum(this.store.get(), profile.albumId);
    if (!album) {
      return { ...empty, error: profile.albumId ? '绑定的相簿不存在（可能已被删除）' : null };
    }
    const active = album.folders.filter((f) => f.enabled);
    if (!active.length) {
      return { ...empty, albumName: album.name, error: '相簿里还没有启用的目录' };
    }

    const started = Date.now();
    const missingDirs = [];
    await Promise.all(active.map(async (f) => {
      const probe = await probeFile(f.path);
      if (!probe.exists) missingDirs.push(f.path);
    }));

    const results = await Promise.all(active.map(async (f) => {
      try {
        return await this._scan(f.path, profile.recursive);
      } catch (err) {
        return { files: [], truncated: false, elapsedMs: 0, error: err.message };
      }
    }));

    const files = [];
    const seen = new Set();
    let truncated = false;
    let error = null;
    // results 与 active 一一对应：拼进条目的 dir 字段记录「这张图来自哪个目录」，
    // 胶片条的目录分隔和图片信息面板的「来源」都靠它，调度逻辑本身不用
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const dirPath = active[i].path;
      if (r.error && !error) error = r.error;
      if (r.truncated) truncated = true;
      for (const f of r.files) {
        const key = f.path.toLowerCase();
        if (seen.has(key)) continue;   // 嵌套目录 / 重复添加：同一张图只收一次
        seen.add(key);
        files.push({ ...f, dir: dirPath });
      }
    }

    return {
      files,
      truncated,
      scanMs: Date.now() - started,
      error,
      missingDirs,
      albumName: album.name,
      activeDirs: active.map((f) => f.path),
    };
  }

  /**
   * 顺序有变 → 交给磁盘存档（shuffleOrders.set 内部有内容比对：顺序没变
   * 就不标脏不写盘，所以 rebuild 原样重放内存顺序时这里是零成本）。
   */
  _persistOrder(id) {
    if (!this.ordersStore) return;
    const rec = this.orders.get(id);
    if (rec) this.ordersStore.set(id, { albumId: rec.albumId, shuffle: rec.shuffle, paths: rec.paths });
    else this.ordersStore.forget(id);
  }

  /**
   * 算出这个频道这一轮的**文件顺序** —— 随机模式的「随机」只作用在这里。
   *
   * 把列表本身摆成一个随机顺序，之后播放就是顺着列表走（见 _advance）。
   * 这样列表顺序 = 播放顺序 = 胶片条顺序：左边是刚看过的、右边是将要看的，
   * 「上一张」永远在左边一格。（不是「每次随机挑一个索引跳过去」——
   * 那样胶片条的位置会乱飞，历史无从追踪。）
   *
   * 顺序跨 rebuild 保留（`this.orders`），r34 起还跨重启保留（`ordersStore` 落盘）：
   * 改个间隔、调个动画时长、甚至关机重开，顺序都是上一次那份。只有换相簿、
   * 切「按名称 / 随机」、重新扫描、或**走完一轮**才会重排。
   * 相簿内加目录 / 删目录**不**触发重排：现有路径原位保留，新目录的图接在末尾 ——
   * 「往相簿里补一批图」不该把正在看的顺序搅乱。
   *
   * 每个频道拿一份自己的副本 —— 两个频道绑同一个相簿时，一个重洗不该影响另一个。
   */
  async _orderFor(id, files, profile, albumId) {
    const list = files.slice();
    const shuffled = Boolean(profile.shuffle);
    const saved = this.orders.get(id);
    // 相簿变了、或者播放顺序模式换了 —— 旧顺序都不能再用
    const reusable = saved && saved.albumId === albumId && saved.shuffle === shuffled
      ? saved.paths
      : null;

    if (!shuffled) {
      this.orders.set(id, { albumId, shuffle: false, paths: list.map((f) => f.path) });
      this._persistOrder(id);
      return list;
    }

    if (reusable && reusable.length) {
      const byPath = new Map(list.map((f) => [f.path, f]));
      const out = [];
      for (const p of reusable) {
        const f = byPath.get(p);
        if (f) { out.push(f); byPath.delete(p); }
      }
      // 相簿里新增的接在后面（顺序不重排，用户刚丢进来的图在末尾）
      for (const f of list) if (byPath.has(f.path)) out.push(f);
      this.orders.set(id, { albumId, shuffle: true, paths: out.map((f) => f.path) });
      this._persistOrder(id);
      return out;
    }

    await this._shuffleFiles(list, profile.skipSizeTwin !== false);
    this.orders.set(id, { albumId, shuffle: true, paths: list.map((f) => f.path) });
    this._persistOrder(id);
    return list;
  }

  /**
   * 走完一轮：重洗一次，让每一轮的顺序都不一样。
   *
   * 洗完之后把**当前正在显示的这张**挪到列表末尾 —— 于是 index 还在原位附近，
   * 「下一张」正好是新顺序的第一张，画面不会因为重排而跳。
   * played 也一起清空：新一轮的「看过 / 没看过」从头算。
   */
  async _startNextRound(ch) {
    const n = ch.files.length;
    if (n < 2) return;

    const currentPath = ch.files[ch.index] ? ch.files[ch.index].path : null;
    await this._shuffleFiles(ch.files, ch.profile.skipSizeTwin !== false);

    if (currentPath) {
      const at = ch.files.findIndex((f) => f.path === currentPath);
      if (at >= 0 && at !== n - 1) {
        const last = ch.files[n - 1];
        ch.files[n - 1] = ch.files[at];
        ch.files[at] = last;
      }
    }

    ch.index = n - 1;
    ch.played.clear();
    ch.rounds = (ch.rounds || 0) + 1;
    this.rounds.set(ch.id, ch.rounds);
    this.orders.set(ch.id, { albumId: ch.profile.albumId, shuffle: true, paths: ch.files.map((f) => f.path) });
    this._persistOrder(ch.id);
  }

  /**
   * 把列表打乱（Fisher-Yates 原地洗）。
   *
   * 小目录会一直洗到「没有相邻同体积」为止（**含首尾相接** —— 列表是循环播的，
   * 最后一张接回第一张，那一步同样会被看到）。内容完全相同的两张图（同一张存了
   * 两份文件名，图库里实测有 70 组）挨着播，看起来就是同一张连着来了两次。
   * 大目录跳过：检查一遍要 stat 全部文件，30348 张要 20 秒以上。
   *
   * 已知无解的情形：目录极小、同体积的图又占了大半时（3 张里 2 张字节一样），
   * 排成环必然有同色相邻。这时试到上限就照用 —— 没必要为了这个把顺序搅乱。
   */
  async _shuffleFiles(files, skipSizeTwin = true) {
    shuffleInPlace(files);
    if (!skipSizeTwin) return;
    if (files.length < 2 || files.length > SHUFFLE_TWIN_MAX) return;

    const cache = new Map();
    const sizeOf = async (entry) => {
      if (Number.isFinite(entry.size) && entry.size > 0) return entry.size;
      const hit = cache.get(entry.path);
      if (hit !== undefined) return hit;
      let size = 0;
      try { size = (await fsp.stat(entry.path)).size; } catch { size = 0; }
      cache.set(entry.path, size);
      return size;
    };

    for (let attempt = 0; attempt < SHUFFLE_TRIES; attempt += 1) {
      let clean = true;
      let prevSize = 0;
      let firstSize = 0;
      let lastSize = 0;
      for (let i = 0; i < files.length; i += 1) {
        const size = await sizeOf(files[i]);
        if (i === 0) firstSize = size;
        else if (prevSize && size && size === prevSize) { clean = false; break; }
        prevSize = size;
        lastSize = size;
      }
      // 列表是**循环**播的：最后一张接回第一张，那也算相邻
      if (clean && firstSize && lastSize && firstSize === lastSize) clean = false;
      if (clean) return;
      shuffleInPlace(files);
    }
  }

  /* ------------------------------------------------------------ 播放 */

  _schedule(ch) {
    // 已在重建中被丢弃的频道不许再武装自己（否则会变成野定时器一直写壁纸）
    if (ch.retired) return;
    clearTimeout(ch.timer);
    ch.timer = null;
    if (!ch.playing || ch.files.length < 2) return;
    /*
     * videoPlayFull（视频播完再切）：当前条目是视频且动态窗口正在显示它时，
     * 不挂定时器 —— 等渲染端播完（ended）或加载失败时发 stage:video-ended，
     * 由 videoEnded() 推进。动态没开 / 窗口已失效时视频根本没人播、没人报告，
     * 照旧按 interval 走，否则频道会永远停在视频上不动。
     */
    const config = this.store.get();
    const entry = ch.files[ch.index];
    if (config.videoPlayFull === true
      && config.liveWallpaper === true
      && !this.isLiveDegraded()
      && entry && kindFor(entry.ext) === 'video') {
      return;
    }
    const ms = Math.max(1, ch.profile.interval) * 1000;
    ch.timer = setTimeout(() => {
      ch.timer = null;
      /*
       * 暂停感知（2026-10-09）：显示器被冻结（全屏/挂机）时不推进轮播。
       * 之前画面冻着但调度器照走，造成两个问题：①托盘/右键删除按 index 找
       * 「当前张」与桌面显示脱节 —— 用户在恢复后的 60s 内右键删除，删掉的是
       * 从没显示过的图（实测踩中）；②退出全屏瞬间跳到没看过的图。
       * 到点重查：暂停期间每隔一个 interval 空转一次，恢复后自然续播。
       */
      if (this.isPaused(ch.id)) { this._schedule(ch); return; }
      this._advance(ch, 1, 'timer');
    }, ms);
  }

  async _advance(ch, dir, reason) {
    if (ch.retired) return;
    const n = ch.files.length;
    if (n === 0) return;
    if (n === 1) { this._schedule(ch); return; }

    /*
     * 拼接整页步长（r75）：填充方式为拼接时，渲染端每建成一幅 n 格拼图就回报 n
     * （setCollagePage / channel:collage-page），此后 timer 与手动推进都按 ±n 张
     * 整页走 —— 否则上一幅的右格就是下一幅的中格，每张图必然连播两次。
     * 例外：video-ended 保持 1（视频不进拼格，整页会跳过没播完的）；
     * 页步长 clamp 到 n-1，防短列表一步跨回原地。
     */
    let step = 1;
    if (reason !== 'video-ended') {
      step = Math.max(1, Math.min(ch.collageStep || 1, n - 1));
    }
    /*
     * 整页跳过的中间张也标「看过」：页面里每张都在屏幕上出现过，
     * 胶片条的「看过」标记与「全部看过」判定不能把它们漏掉
     * （正向跳到位的那张由 goTo 自己标）。反向不摘标记 —— 往回看不算没看过。
     */
    for (let s = 1; s < step; s += 1) {
      ch.played.add(((ch.index + dir * s) % n + n) % n);
    }

    /*
     * 顺序推进。「随机」已经在定顺序那一步做完了（见 _orderFor），
     * 所以这里不需要区分模式 —— 列表顺序就是播放顺序，
     * 「上一张」永远在左边一格，胶片条可以直接当历史来读。
     *
     * 唯一的例外：正向**跨过**列表末尾 = 一轮走完 → 重洗一次，
     * 让下一轮的顺序和这一轮不一样（用户要的「每轮不同」）。
     * r75 前判定是「落点=开头」（步长恒 1 时等价）；页步长经常踩不准 n-1，
     * 改成「本次前进会跨过末尾」。
     */
    if (dir > 0 && ch.profile.shuffle && ch.index + step >= n) {
      await this._startNextRound(ch);
      /*
       * 一轮走完重洗了列表 —— 这是「频道的文件顺序变了」，不是普通的推进，
       * 必须走 channels 通道告诉渲染层。
       *
       * 只发 tick 是不够的：渲染层判断「要不要重取文件列表」的指纹比较住在
       * applyChannelInfo 里，而它只在 channels:changed 时才跑。只发 tick 的话
       * 那次比较根本不会执行，于是窗口里的顺序停在上一轮 —— 而 onTick 又是用
       * state.files[index] 取图的，结果就是窗口预览与桌面壁纸各显示一张不同的图。
       */
      this._emit('channels', { reason: 'new-round', channels: this.list() });
    }
    await this.goTo(ch.id, (((ch.index + dir * step) % n) + n) % n, dir, reason);
  }

  /**
   * 找出一张**真正可用**的图：文件还在、且不是本次会话已判定读不出的。
   *
   * 途中遇到已不存在的条目就地摘除（复用删除链路：索引对齐 / rev++ / 作废扫描缓存 /
   * 通知渲染层），遇到坏图标进跳过集合 —— 两种情况都记进 skipped 集合，供聚合提示。
   *
   * @param {object} ch 频道
   * @param {{droppedPaths:Set<string>, badPaths:Set<string>}} skipped 计数集合（按路径去重）
   * @returns {{entry:object|null}}
   */
  _seekLiveEntry(ch, skipped) {
    let guard = ch.files.length + 1;
    while (guard-- > 0) {
      const entry = ch.files[ch.index];
      if (!entry) return { entry: null };

      if (ch.badFiles.has(entry.path)) {
        skipped.badPaths.add(entry.path);
        ch.index = (ch.index + 1) % ch.files.length;
        continue;
      }
      if (fs.existsSync(entry.path)) return { entry };

      // 文件已经没了（外部删除）→ 摘掉它。摘完索引会自动对齐，原位就是下一张
      skipped.droppedPaths.add(entry.path);
      this.applyFileMutation(entry.path, null, { skipRewrite: true });
      if (!ch.files.length) return { entry: null };
    }
    return { entry: null };
  }

  /** 真正落一次写入；抽出来是为了「这张不行就换下一张」时能复用 */
  async _writeOnce(entry, target) {
    // 登记在途写入：重建要等它结束，避免旧配置的图在切换之后才落到桌面（见 _rebuild）
    const attempt = (async () => {
      try {
        return await this.writeWallpaper(entry.path, this.cacheDir, { monitorId: target.monitorId });
      } catch (err) {
        return { ok: false, method: 'none', error: err.message };
      }
    })();
    this.pendingWrites.add(attempt);
    try {
      return await attempt;
    } finally {
      this.pendingWrites.delete(attempt);
    }
  }

  /**
   * 跳过失效图片之后的收尾：
   *   1. 目录大概率整体过期（一次切换摘掉一堆）→ 异步重扫拿真实列表，别逐张试到天亮；
   *   2. 索引变了 → 把播放进度落盘，免得重启后回到那张已删掉的图。
   */
  _afterSkip(ch, skipped) {
    this._remember(ch);

    // 只有「读不出来」时 applyFileMutation 没被调用过，列表本身没变 —— 但卡片状态区
    // 要显示跳过统计，所以补一次广播（摘除那一路已经由 applyFileMutation 广播过了）
    if (skipped.badPaths.size && !skipped.droppedPaths.size) {
      this._emit('channels', { reason: 'skip-bad-files', channels: this.list() });
    }

    if (skipped.droppedPaths.size >= MASS_SKIP
      && Date.now() - ch.lastMassRescan > MASS_RESCAN_COOLDOWN_MS) {
      ch.lastMassRescan = Date.now();
      console.log(`[scheduler] ${ch.id}: 一次切换里跳过 ${skipped.droppedPaths.size} 张失效图片，触发重扫`);
      this.rescan(ch.id).catch((err) => console.error('[scheduler] 失效重扫失败:', err.message));
    }
  }

  /** 写入当前帧到系统壁纸；返回写入结果 */
  async _write(ch, reason) {
    if (ch.retired) return null;
    if (!ch.files.length) return null;

    const target = this._targetFor(ch);
    const skipped = { droppedPaths: new Set(), badPaths: new Set() };
    const config = this.store.get();
    const previewOnly = !ch.profile.enabled || !config.applyToSystem;

    /*
     * 动态桌面降频写（方案 A，2026-09-24 拍板）：
     * 动态窗口开着时，系统壁纸只在锚点时机写（takeover / stop），其余时机这张图
     * 由动态窗口自己显示 —— 实测每写一次系统壁纸，Explorer 会重建 WorkerW 把
     * 动态窗口盖住约 1 秒（任务书 §2.14/§2.16），照原节奏桌面会每 30 秒闪一下。
     * 动态没开（live=false）或窗口已失效（degraded）时恢复「每轮都写」的兜底。
     * 判定细节见 liveDesktop.js（纯函数，test-live-desktop.js 全分支覆盖）。
     */
    const liveGate = liveDesktop.shouldWriteSystem({
      live: config.liveWallpaper === true,
      applyToSystem: config.applyToSystem,
      reason,
      degraded: this.isLiveDegraded() === true,
    });

    let result = null;
    let entry = null;

    /*
     * 一次切换最多试 MAX_WRITE_ATTEMPTS 张：
     *   已删除的 → 摘掉；读出/转码失败的 → 本次跳过（文件可能还在同步，下轮再试）。
     * 试到能用的为止，桌面上就永远不会停在一张死图上。
     */
    for (let i = 0; i < MAX_WRITE_ATTEMPTS; i++) {
      entry = this._seekLiveEntry(ch, skipped).entry;
      if (!entry) break;

      // 阶段 4/5：视频/网页条目系统壁纸吃不下（IDesktopWallpaper 只认图片）——
      // 由动态窗口显示它们，系统壁纸保持上一次锚点图片兜底，绝不拿视频去写。
      if (kindFor(entry.ext) !== 'image') {
        result = { ok: true, method: 'non-image-skip', skipped: true, at: Date.now() };
        break;
      }

      if (previewOnly) {
        result = { ok: true, method: 'preview-only', skipped: true, why: liveGate.why, at: Date.now() };
        break;
      }

      if (!liveGate.write) {
        // 动态窗口在显示这张，系统壁纸不必跟（保持上一次锚点的那张当兜底）
        result = { ok: true, method: 'live-skip', skipped: true, why: liveGate.why, at: Date.now() };
        break;
      }

      result = await this._writeOnce(entry, target);
      ch.writes += 1;
      if (result.ok) break;

      const error = result.error || result.method;
      if (isMissingError(error)) {
        // 预检之后才被删掉（竞态）→ 同样摘除
        skipped.droppedPaths.add(entry.path);
        this.applyFileMutation(entry.path, null, { skipRewrite: true });
      } else {
        // 文件还在但读不出来 → 本次会话跳过，不再反复试
        skipped.badPaths.add(entry.path);
        ch.badFiles.add(entry.path);
      }
      if (!ch.files.length) break;
      if (ch.files[ch.index] === entry) ch.index = (ch.index + 1) % ch.files.length;
    }

    const total = skipped.droppedPaths.size + skipped.badPaths.size;
    if (total) {
      ch.lastSkip = {
        dropped: skipped.droppedPaths.size,
        bad: skipped.badPaths.size,
        total,
        at: Date.now(),
      };
      this._afterSkip(ch, skipped);
    } else {
      ch.lastSkip = null;
    }

    if (!result) {
      // 一张都没写成：列表里全是失效条目（或只剩坏图）
      ch.lastError = total
        ? `相簿里的图片都不可用（已失效 ${total} 张）`
        : '没有可写入的图片';
      ch.lastWrite = { ok: false, method: 'none', error: ch.lastError, at: Date.now(), reason };
      return ch.lastWrite;
    }

    ch.lastWrite = {
      ...result,
      at: Date.now(),
      reason,
      monitorId: target.monitorId,
      monitorLabel: target.label,
      why: liveGate.why,   // 写入策略的判定依据（live-off / live-anchor / degraded-fallback / system-off）
    };
    ch.lastError = result.ok ? null : (result.error || result.method);
    return ch.lastWrite;
  }

  _targetFor(ch) {
    if (ch.kind === 'monitor' && ch.monitor) {
      return { monitorId: ch.monitor.id, label: ch.monitor.label };
    }
    try {
      return this.resolveUnifiedTarget();
    } catch (err) {
      return { monitorId: null, label: `全部显示器（目标解析失败：${err.message}）` };
    }
  }

  /**
   * 跳到指定序号：写入壁纸 → 广播 tick → 重新排下一次。
   * @param {string} id 频道 ID
   * @param {number} index
   * @param {number} dir 1 = 向后，-1 = 向前（渲染层据此决定滑动方向）
   * @param {string} reason manual | timer | command | goto | takeover
   */
  async goTo(id, index, dir = 1, reason = 'manual') {
    const ch = this.channels.get(id);
    if (!ch || ch.retired || ch.files.length === 0) return null;

    const n = ch.files.length;
    ch.index = ((Math.round(index) % n) + n) % n;
    ch.ticks += 1;
    ch.played.add(ch.index);

    this._remember(ch);

    await this._write(ch, reason);

    /*
     * 写入过程中可能摘掉了失效条目（索引随之对齐），所以这里要**重新取一次**当前帧 ——
     * 用上面那个 entry 广播的话，渲染层拿到的会是一张已经不存在的路径。
     */
    const live = ch.files[ch.index] || null;
    this._emit('tick', {
      id,
      index: ch.index,
      count: ch.files.length,
      dir,
      reason,
      entry: live ? { path: live.path, name: live.name, url: live.url } : null,
      write: ch.lastWrite,
      skipped: ch.lastSkip,   // 本次切换跳过了几张失效图片（渲染层做聚合提示）
    });

    this._schedule(ch);
    return live;
  }

  /** 下一张 / 上一张 */
  async step(id, dir) {
    const ch = this.channels.get(id);
    if (!ch) return null;
    await this._advance(ch, dir >= 0 ? 1 : -1, 'command');
    return ch.files[ch.index] || null;
  }

  /**
   * 拼接整页步长（r75）：渲染端每建成一幅 n 格拼图就回报 n（channel:collage-page），
   * 调度器此后 timer / 手动推进按 ±n 张整页走，相邻两幅拼图零重复。
   * 只存内存不落盘 —— 重启后首幅按 1 步进，渲染端首次回报即恢复整页
   * （只影响重启后的第一次切换，不值得为它写盘）。
   */
  setCollagePage(id, page) {
    const ch = this.channels.get(id);
    if (!ch || ch.retired) return;
    const p = Math.round(Number(page) || 1);
    ch.collageStep = Math.max(1, Math.min(4, p));
  }

  /**
   * 拼接邻居（r38 起，r75 修序 + 从 main.js 搬来可单测）：给舞台取「当前张前后的
   * 邻居条目」，跳过视频/网页只给图片。左右各走 span 格还凑不齐就少给——
   * 渲染端用中心图兜底（重复不上黑格）。
   *
   * **r75 修序**：left 此前被 `.reverse()` 翻成「由远到近」，而渲染端拼格是从内到外
   * 取（paths[centerIdx-k] = left[k-1]，k=1 是最内格）——结果最内格拿到的是**最远**
   * 那张：中心 3 号显示成 1 3 4 而不是 2 3 4。现在 left/right 统一「距中心由近到远」。
   */
  collageNeighbors(id, index, span = 2) {
    const ch = this.channels.get(id);
    if (!ch || !ch.files.length) return { center: null, left: [], right: [] };
    const n = ch.files.length;
    const idx = Math.max(0, Math.min(n - 1, Number(index) || 0));
    const spanN = Math.max(1, Math.min(3, Number(span) || 2));
    const isImg = (ent) => ent && COLLAGE_IMAGE_EXT.has(String(ent.ext || '').toLowerCase());
    const walk = (dir) => {
      const list = [];
      for (let s = 1; s <= n && list.length < spanN; s += 1) {
        const ent = ch.files[((idx + dir * s) % n + n) % n];
        if (isImg(ent)) list.push({ path: ent.path, name: ent.name, ext: ent.ext, url: ent.url });
      }
      return list;                       // s=1 是最近邻 → 列表天然「由近到远」
    };
    const center = ch.files[idx];
    return {
      center: isImg(center) ? { path: center.path, name: center.name, ext: center.ext, url: center.url } : null,
      left: walk(-1),                    // 左右都由近到远：渲染端拼格从内到外取，内格=最近邻
      right: walk(1),
    };
  }

  /**
   * 舞台渲染端报告「视频播完了 / 加载失败了」（stage:video-ended）。
   * videoPlayFull 开启时调度器对视频条目不挂定时器（见 _schedule），全靠这里推进。
   *
   * 校验当前条目确实是视频且在播：配置切换瞬间旧渲染端迟到的报告、
   * 或者暂停状态下播到头的视频，都不能把当前帧顶掉。
   * 返回推进后的当前条目（没推进返回 null，渲染端据此决定要不要原地重播）。
   */
  async videoEnded(id) {
    const ch = this.channels.get(id);
    if (!ch || ch.retired || !ch.playing) return null;
    const entry = ch.files[ch.index];
    if (!entry || kindFor(entry.ext) !== 'video') return null;
    await this._advance(ch, 1, 'video-ended');
    return ch.files[ch.index] || null;
  }

  setPlaying(id, playing) {
    const ch = this.channels.get(id);
    if (!ch) return null;
    ch.playing = Boolean(playing) && ch.files.length > 1;
    this._remember(ch);
    this._schedule(ch);
    this._emit('channels', { reason: 'playing', channels: this.list() });
    return ch.playing;
  }

  /** 暂停全部频道（窗口关闭前的礼貌行为，可选） */
  pauseAll() {
    for (const ch of this.channels.values()) {
      ch.playing = false;
      this._remember(ch);
      clearTimeout(ch.timer);
      ch.timer = null;
    }
  }

  /**
   * 锚点补写：把每个频道的当前帧真正落到系统壁纸（reason='stop'）。
   *
   * 在「停止动态桌面」（关开关）与「应用退出」时调用 —— 平时降频写
   * （见 _write 的 liveGate），这时必须落一次：否则退出/崩溃之后桌面停在的是
   * 上一次锚点（启动/换相簿）的那张，而不是用户最后看到的那张。
   * reason 走 'stop' ⇒ shouldWriteSystem 判为 live-anchor，必定真写。
   */
  async anchorSystem() {
    const targets = [...this.channels.values()].filter((ch) => !ch.retired && ch.files.length);
    return await Promise.all(targets.map((ch) => this._write(ch, 'stop')));
  }

  /**
   * 文件被移动 / 删除后**就地**更新所有引用它的频道。
   *
   * 为什么不直接 rebuild：
   *   重建要走一遍扫盘 + 重置索引，用户右键删掉一张图，画面会跳回第一张 —— 不可接受。
   *   这里只做最小改动：把那条记录摘掉 / 换掉路径，并把索引重新对齐，
   *   让「当前这张」尽量还是原来那张。
   *
   * @param {string} oldPath 变更前的完整路径
   * @param {string|null} newPath 新路径；null 表示文件已删除
   * @param {{skipRewrite?:boolean}} [opts] skipRewrite：调用方自己会补写当前帧时设 true，
   *        避免这里再写一次（两笔写入并发会打架）
   * @returns {{affected:Array<{id:string,count:number,index:number}>, rewritten:string[]}}
   */
  applyFileMutation(oldPath, newPath = null, opts = {}) {
    // 同目录改名 → 就地更新路径；移到别的目录 → 从这条轮播里摘掉
    // （移到别处意味着「这张我不想要了」，留在轮播里只会在下次切换时黑洞一下）
    const sameFolder = Boolean(newPath) && (
      path.dirname(path.resolve(oldPath)).toLowerCase()
      === path.dirname(path.resolve(newPath)).toLowerCase()
    );

    const touchedArrays = new Set();
    const affected = [];
    const rewritten = [];
    /** 受影响的目录 —— 用来把扫描缓存也一起作废，见下面的注释 */
    const touchedFolders = new Set();

    for (const ch of this.channels.values()) {
      const index = ch.files.findIndex((f) => f.path === oldPath);
      if (index < 0) continue;

      const arr = ch.files;
      // 受影响的是相簿里启用的那些目录 —— 缓存按目录建，逐个作废
      for (const dir of (ch.activeDirs || [])) touchedFolders.add(dir);

      // 多个频道可以共享同一个扫描结果数组，同一数组只改一次
      if (!touchedArrays.has(arr)) {
        touchedArrays.add(arr);
        if (sameFolder) {
          arr[index] = {
            ...arr[index],
            path: newPath,
            name: path.basename(newPath),
            ext: path.extname(newPath).toLowerCase(),
            url: pathToFileURL(newPath).href,
          };
        } else {
          arr.splice(index, 1);
        }
      }

      // 索引对齐：删掉的在当前之前 → 整体前移；正好是当前 → 当前这张的内容真的换了
      let currentReplaced = false;
      if (!sameFolder) {
        if (index === ch.index) currentReplaced = true;
        else if (index < ch.index) ch.index -= 1;
      }
      ch.index = Math.max(0, Math.min(ch.index, arr.length - 1));

      /*
       * 必须把新索引写回「播放进度」。
       *
       * rebuild 时索引是从 progress 里取的（_rebuild），而只有 goTo 会写 progress。
       * 这里只改 ch.index 不同步 progress 的话，删除之后只要发生一次重建
       * （改间隔、切每屏独立、插拔显示器都算），索引就会被那份过期进度**顶回原位** ——
       * 画面莫名其妙跳到别的图，正好把「删除不打扰正在看的这张」这件事毁掉。
       *
       * 磁盘存档同理：这里不同步，重启后还会回到那张已经删掉的图的位置。
       */
      this._remember(ch);

      // played 序号跟着列表一起位移：被删掉的那个丢掉，其后的整体前移一格
      if (sameFolder) {
        for (const i of [...ch.played]) if (i >= arr.length) ch.played.delete(i);
      } else {
        const shifted = new Set();
        for (const i of ch.played) {
          if (i === index) continue;
          const j = i > index ? i - 1 : i;
          if (j >= 0 && j < arr.length) shifted.add(j);
        }
        ch.played.clear();
        for (const j of shifted) ch.played.add(j);
      }

      ch.rev += 1;
      if (currentReplaced) ch.needsRewrite = true;
      affected.push({ id: ch.id, count: arr.length, index: ch.index });
    }

    /*
     * 扫描缓存必须一起作废。
     *
     * 频道持有的 `ch.files` 是「扫描结果经过排序/洗牌后的副本」，不是缓存里的那个数组，
     * 所以在它上面 splice 并不会动到缓存。不处理的话，只要之后发生一次重建
     * （改个间隔、切每屏独立、插拔显示器都算），被删掉的图就会**从缓存里复活**，
     * 于是列表里出现一个本地已经不存在的路径 —— 下一张切到它就会黑洞一下。
     *
     * 只丢掉受影响目录的缓存：重建时重扫一遍（3 万张约 300ms），代价可以接受，
     * 而且这是删除/移动之后的必要成本。
     */
    for (const folder of touchedFolders) {
      for (const key of [...this.scanCache.keys()]) {
        if (key.startsWith(`${folder}::`)) this.scanCache.delete(key);
      }
    }

    for (const ch of this.channels.values()) {
      if (!affected.some((a) => a.id === ch.id)) continue;
      const pending = ch.needsRewrite;
      ch.needsRewrite = false;
      // 当前这张被删了 → 立刻把新的当前帧写上去，别让桌面挂着一张已进回收站的图
      // （skipRewrite 时由调用方负责补写 —— 播放链路自己会立刻换下一张）
      if (pending && !opts.skipRewrite) {
        rewritten.push(ch.id);
        this._write(ch, 'file-mutation').catch(() => {});
      }
      this._schedule(ch);
    }

    if (affected.length) {
      this._emit('channels', { reason: 'file-mutation', channels: this.list() });
    }
    return { affected, rewritten };
  }

  /** 丢掉扫描缓存并重建（适配「新增了图片」；顺带重新洗一次牌） */
  async rescan(id) {
    // 全量清缓存：rescan 的语义就是「磁盘上现在有什么就认什么」。只清本频道
    // activeDirs 对应的键会漏掉共享缓存里其他频道/其他相簿的陈旧结果 ——
    // 重建重扫 3 万张约 300ms（见 file-mutation 注释），这个代价 rescan 付得起。
    this.scanCache.clear();
    if (id) {
      this.orders.delete(id);          // 重新扫描 = 重新洗牌，别把旧顺序按回去
      this.rounds.delete(id);
      this._persistOrder(id);          // r34：磁盘上的旧顺序一并作废
    } else {
      this.orders.clear();
      this.rounds.clear();
      if (this.ordersStore) this.ordersStore.clear();
    }
    await this.rebuild('rescan');
  }

  stop() {
    for (const ch of this.channels.values()) clearTimeout(ch.timer);
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this._startupRefreshTimer) {
      clearTimeout(this._startupRefreshTimer);
      this._startupRefreshTimer = null;
    }
    if (this._emptyRecheckTimer) {
      clearTimeout(this._emptyRecheckTimer);
      this._emptyRecheckTimer = null;
    }
    this.channels.clear();
    // 退出前把最后那张的位置落盘 —— 否则「刚换完图就关程序」会丢掉这一步
    if (this.playback) this.playback.flush();
    if (this.ordersStore) this.ordersStore.flush();   // r34：顺序存档同样兜底
    // 扫描缓存还没来得及落盘（延迟写窗口内退出）→ 现在写；进程被硬杀也只丢这一份
    // 新鲜扫描，tmp+rename 原子写保证旧文件完好（下次启动照常水合）
    if (this._scanSaveTimer) {
      clearTimeout(this._scanSaveTimer);
      this._scanSaveTimer = null;
      this._saveScanCache();
    }
  }

  /* ------------------------------------------------------------ 查询 */

  list() {
    return [...this.channels.values()].map((ch) => ({
      id: ch.id,
      kind: ch.kind,
      monitorId: ch.monitor ? ch.monitor.id : null,
      // 注意：index 是「当前播到第几张」，monitorIndex 才是「第几台显示器」，别混用
      monitorIndex: ch.monitor ? ch.monitor.index : 0,
      label: ch.kind === 'monitor' && ch.monitor ? ch.monitor.label : this._targetFor(ch).label,
      primary: ch.monitor ? Boolean(ch.monitor.primary) : true,
      width: ch.monitor ? ch.monitor.width : 0,
      height: ch.monitor ? ch.monitor.height : 0,
      x: ch.monitor ? ch.monitor.x : 0,
      y: ch.monitor ? ch.monitor.y : 0,
      albumId: ch.profile.albumId || '',
      albumName: ch.albumName || '',
      missingDirs: ch.missingDirs || [],
      count: ch.files.length,
      rev: ch.rev,
      truncated: Boolean(ch.truncated),
      index: ch.index,
      ticks: ch.ticks,
      writes: ch.writes,
      playing: ch.playing,
      enabled: ch.profile.enabled,
      profile: ch.profile,
      scanMs: ch.scanMs,
      playedCount: ch.played.size,
      /** 列表洗过牌没有（随机模式）。顺序模式下 index+1 就是「第几张」 */
      shuffled: Boolean(ch.profile.shuffle),
      /** 走完几轮了（每走完一轮会重洗，所以这个数也是「重洗过几次」） */
      rounds: ch.rounds || 0,
      current: ch.files[ch.index] ? ch.files[ch.index].path : null,
      name: ch.files[ch.index] ? ch.files[ch.index].name : null,
      /** 上一次切换跳过了几张失效图片（已删除 / 读不出来），渲染层据此显示「已跳过 N 张失效」 */
      skipped: ch.lastSkip,
      lastWrite: ch.lastWrite,
      lastError: ch.lastError,
    }));
  }

  files(id) {
    const ch = this.channels.get(id);
    return ch ? ch.files : [];
  }

  /** 本次会话播放过的序号（升序），胶片条用来区分「看过的」和「没看过的」 */
  playedIndices(id) {
    const ch = this.channels.get(id);
    if (!ch) return [];
    return [...ch.played].sort((a, b) => a - b);
  }

  /** 供测试脚本读取的内部状态 */
  stats() {
    return [...this.channels.values()].map((ch) => ({
      id: ch.id,
      kind: ch.kind,
      monitorId: ch.monitor ? ch.monitor.id : null,
      count: ch.files.length,
      index: ch.index,
      ticks: ch.ticks,
      playing: ch.playing,
      interval: ch.profile.interval,
      enabled: ch.profile.enabled,
      writes: ch.writes,
      album: ch.albumName || '',
      albumId: ch.profile.albumId || '',
      skipped: ch.lastSkip,
      lastWrite: ch.lastWrite,
    }));
  }
}

module.exports = { MonitorScheduler, UNIFIED_ID, shuffleInPlace };
