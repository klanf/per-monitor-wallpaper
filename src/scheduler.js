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
   */
  constructor({ store, cacheDir, enumerate, resolveUnifiedTarget, onEvent, writeWallpaper, playback, isLiveDegraded, isPaused }) {
    this.store = store;
    this.cacheDir = cacheDir;
    this.enumerate = enumerate;
    this.resolveUnifiedTarget = resolveUnifiedTarget;
    this.onEvent = onEvent || (() => {});
    this.writeWallpaper = writeWallpaper
      || ((imagePath, cacheDir, options) => win32.setWallpaper(imagePath, cacheDir, options));
    this.playback = playback || null;
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
    /** 上次自动扫描的时刻（时间戳，0 = 本次会话还没扫过）；渲染层据此显示「上次扫描 …」 */
    this.lastAutoScanAt = 0;
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

    this.tookOver = true;

    // 启动接管：立刻把当前帧写上去，否则最长要等一个 interval 才看得到变化
    if (takeOver) {
      const targets = [...this.channels.values()].filter((ch) => ch.profile.enabled && ch.files.length);
      await Promise.all(targets.map((ch) => this._write(ch, 'takeover')));
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
   * 为什么**先按路径找**：随机模式下列表顺序每次启动都会重洗（见 _orderFor），
   * 序号对不上号 —— 只有路径能找回「就是这张」。
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
    if (cached) return cached;

    const started = Date.now();
    const { files, truncated } = await scanFolder(folder, { recursive });
    const result = {
      files: files.map((f) => ({ ...f, url: pathToFileURL(f.path).href })),
      truncated,
      elapsedMs: Date.now() - started,
      folder,
      recursive,
    };
    this.scanCache.set(key, result);
    return result;
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
   * 算出这个频道这一轮的**文件顺序** —— 随机模式的「随机」只作用在这里。
   *
   * 把列表本身摆成一个随机顺序，之后播放就是顺着列表走（见 _advance）。
   * 这样列表顺序 = 播放顺序 = 胶片条顺序：左边是刚看过的、右边是将要看的，
   * 「上一张」永远在左边一格。（不是「每次随机挑一个索引跳过去」——
   * 那样胶片条的位置会乱飞，历史无从追踪。）
   *
   * 顺序跨 rebuild 保留（`this.orders`）：改个间隔、调个动画时长不会把刚熟悉起来的
   * 顺序打乱。只有换相簿、切「按名称 / 随机」、重新扫描、或**走完一轮**才会重排。
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
      return out;
    }

    await this._shuffleFiles(list, profile.skipSizeTwin !== false);
    this.orders.set(id, { albumId, shuffle: true, paths: list.map((f) => f.path) });
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
     * 顺序推进。「随机」已经在定顺序那一步做完了（见 _orderFor），
     * 所以这里不需要区分模式 —— 列表顺序就是播放顺序，
     * 「上一张」永远在左边一格，胶片条可以直接当历史来读。
     *
     * 唯一的例外：正向即将绕回开头 = 一轮走完 → 重洗一次，
     * 让下一轮的顺序和这一轮不一样（用户要的「每轮不同」）。
     */
    if (dir > 0 && ch.profile.shuffle && (ch.index + 1) % n === 0) {
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
    await this.goTo(ch.id, (ch.index + dir + n) % n, dir, reason);
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
    } else {
      this.orders.clear();
      this.rounds.clear();
    }
    await this.rebuild('rescan');
  }

  stop() {
    for (const ch of this.channels.values()) clearTimeout(ch.timer);
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.channels.clear();
    // 退出前把最后那张的位置落盘 —— 否则「刚换完图就关程序」会丢掉这一步
    if (this.playback) this.playback.flush();
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
