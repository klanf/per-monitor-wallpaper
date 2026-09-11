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
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const { scanFolder } = require('./scanner');
const { resolveProfile } = require('./store');
const win32 = require('./win32');

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
   */
  constructor({ store, cacheDir, enumerate, resolveUnifiedTarget, onEvent, writeWallpaper }) {
    this.store = store;
    this.cacheDir = cacheDir;
    this.enumerate = enumerate;
    this.resolveUnifiedTarget = resolveUnifiedTarget;
    this.onEvent = onEvent || (() => {});
    this.writeWallpaper = writeWallpaper
      || ((imagePath, cacheDir, options) => win32.setWallpaper(imagePath, cacheDir, options));

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
    /** 每个频道上次用的目录；换目录时用来判断该不该清空 played */
    this.playedFolder = new Map();
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

    // 并行扫描各频道的目录（同目录命中缓存）
    const built = await Promise.all(specs.map(async (spec) => {
      const folder = spec.profile.folder;
      let files = [];
      let truncated = false;
      let scanMs = 0;
      let error = null;

      if (folder) {
        try {
          const scan = await this._scan(folder, spec.profile.recursive);
          files = scan.files;
          truncated = scan.truncated;
          scanMs = scan.elapsedMs;
        } catch (err) {
          error = err.message;
        }
      }
      return { ...spec, files, truncated, scanMs, error };
    }));

    // 逐个频道定下这一轮的顺序（随机模式在这里洗牌，见 _orderFor）
    for (const item of built) {
      if (item.files.length) {
        item.files = await this._orderFor(item.id, item.files, item.profile, item.profile.folder);
      }
    }

    const takeOver = !this.tookOver && config.applyOnStart !== false;

    for (const item of built) {
      const saved = this.progress.get(item.id);
      const max = Math.max(0, item.files.length - 1);

      // played 集合跨 rebuild 复用；拿同一引用回写，channel 上改就等于 map 里改
      let played = this.played.get(item.id);
      if (!played) {
        played = new Set();
        this.played.set(item.id, played);
      }

      // 换目录了 → 旧的「看过」序号对新列表毫无意义，留着只会把没看过的标成看过
      const prevFolder = this.playedFolder.get(item.id);
      if (prevFolder !== undefined && prevFolder !== item.profile.folder) played.clear();
      this.playedFolder.set(item.id, item.profile.folder);

      const index = saved ? Math.min(saved.index, max) : 0;
      // 当前正在显示的这张算「看过」，否则刚开软件时胶片条会把首图标成未看
      if (item.files.length) played.add(index);

      const channel = {
        ...item,
        index,
        playing: saved ? saved.playing : config.autoPlay !== false,
        timer: null,
        lastWrite: null,
        lastError: item.error,
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

    for (const ch of this.channels.values()) this._schedule(ch);

    this._emit('channels', { reason, channels: this.list() });
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
   * 算出这个频道这一轮的**文件顺序** —— 随机模式的「随机」只作用在这里。
   *
   * 把列表本身摆成一个随机顺序，之后播放就是顺着列表走（见 _advance）。
   * 这样列表顺序 = 播放顺序 = 胶片条顺序：左边是刚看过的、右边是将要看的，
   * 「上一张」永远在左边一格。（不是「每次随机挑一个索引跳过去」——
   * 那样胶片条的位置会乱飞，历史无从追踪。）
   *
   * 顺序跨 rebuild 保留（`this.orders`）：改个间隔、调个动画时长不会把刚熟悉起来的
   * 顺序打乱。只有换目录、切「按名称 / 随机」、重新扫描、或**走完一轮**才会重排。
   *
   * 每个频道拿一份自己的副本 —— 两个屏指同一个目录时，一个频道重洗不该影响另一个。
   */
  async _orderFor(id, files, profile, folder) {
    const list = files.slice();
    const shuffled = Boolean(profile.shuffle);
    const saved = this.orders.get(id);
    // 目录变了、或者播放顺序模式换了 —— 旧顺序都不能再用
    const reusable = saved && saved.folder === folder && saved.shuffle === shuffled
      ? saved.paths
      : null;

    if (!shuffled) {
      this.orders.set(id, { folder, shuffle: false, paths: list.map((f) => f.path) });
      return list;
    }

    if (reusable && reusable.length) {
      const byPath = new Map(list.map((f) => [f.path, f]));
      const out = [];
      for (const p of reusable) {
        const f = byPath.get(p);
        if (f) { out.push(f); byPath.delete(p); }
      }
      // 目录里新增的接在后面（顺序不重排，用户刚在资源管理器里丢进来的图在末尾）
      for (const f of list) if (byPath.has(f.path)) out.push(f);
      this.orders.set(id, { folder, shuffle: true, paths: out.map((f) => f.path) });
      return out;
    }

    await this._shuffleFiles(list, profile.skipSizeTwin !== false);
    this.orders.set(id, { folder, shuffle: true, paths: list.map((f) => f.path) });
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
    this.orders.set(ch.id, { folder: ch.profile.folder, shuffle: true, paths: ch.files.map((f) => f.path) });
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
    const ms = Math.max(1, ch.profile.interval) * 1000;
    ch.timer = setTimeout(() => {
      ch.timer = null;
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
    }
    await this.goTo(ch.id, (ch.index + dir + n) % n, dir, reason);
  }

  /** 写入当前帧到系统壁纸；返回写入结果 */
  async _write(ch, reason) {
    if (ch.retired) return null;
    const entry = ch.files[ch.index];
    if (!entry) return null;

    if (!ch.profile.enabled || !this.store.get().applyToSystem) {
      ch.lastWrite = { ok: true, method: 'preview-only', skipped: true, at: Date.now() };
      return ch.lastWrite;
    }

    const target = this._targetFor(ch);
    let result;
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
      result = await attempt;
    } finally {
      this.pendingWrites.delete(attempt);
    }

    ch.writes += 1;
    ch.lastWrite = {
      ...result,
      at: Date.now(),
      reason,
      monitorId: target.monitorId,
      monitorLabel: target.label,
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
    const entry = ch.files[ch.index];
    ch.played.add(ch.index);   // 胶片条据此区分「看过的」和「还没到的」

    this.progress.set(id, { index: ch.index, playing: ch.playing });

    await this._write(ch, reason);

    this._emit('tick', {
      id,
      index: ch.index,
      count: n,
      dir,
      reason,
      entry: { path: entry.path, name: entry.name, url: entry.url },
      write: ch.lastWrite,
    });

    this._schedule(ch);
    return entry;
  }

  /** 下一张 / 上一张 */
  async step(id, dir) {
    const ch = this.channels.get(id);
    if (!ch) return null;
    await this._advance(ch, dir >= 0 ? 1 : -1, 'command');
    return ch.files[ch.index] || null;
  }

  setPlaying(id, playing) {
    const ch = this.channels.get(id);
    if (!ch) return null;
    ch.playing = Boolean(playing) && ch.files.length > 1;
    this.progress.set(id, { index: ch.index, playing: ch.playing });
    this._schedule(ch);
    this._emit('channels', { reason: 'playing', channels: this.list() });
    return ch.playing;
  }

  /** 暂停全部频道（窗口关闭前的礼貌行为，可选） */
  pauseAll() {
    for (const ch of this.channels.values()) {
      ch.playing = false;
      this.progress.set(ch.id, { index: ch.index, playing: false });
      clearTimeout(ch.timer);
      ch.timer = null;
    }
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
   * @returns {{affected:Array<{id:string,count:number,index:number}>, rewritten:string[]}}
   */
  applyFileMutation(oldPath, newPath = null) {
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
      if (ch.profile && ch.profile.folder) touchedFolders.add(ch.profile.folder);

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
       * rebuild 时索引是从 progress 里取的（_buildChain），而 goTo 才写 progress。
       * 这里只改 ch.index 不同步 progress 的话，删除之后只要发生一次重建
       * （改间隔、切每屏独立、插拔显示器都算），索引就会被那份过期进度**顶回原位** ——
       * 画面莫名其妙跳到别的图，正好把「删除不打扰正在看的这张」这件事毁掉。
       */
      this.progress.set(ch.id, { index: ch.index, playing: ch.playing });

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
      if (pending) {
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

  /** 丢掉目录扫描缓存并重建（适配「新增了图片」；顺带重新洗一次牌） */
  async rescan(id) {
    if (id) {
      const ch = this.channels.get(id);
      if (ch && ch.profile.folder) {
        this.scanCache.delete(`${ch.profile.folder}::${ch.profile.recursive ? 1 : 0}`);
      }
      this.orders.delete(id);          // 重新扫描 = 重新洗牌，别把旧顺序按回去
      this.rounds.delete(id);
    } else {
      this.scanCache.clear();
      this.orders.clear();
      this.rounds.clear();
    }
    await this.rebuild('rescan');
  }

  stop() {
    for (const ch of this.channels.values()) clearTimeout(ch.timer);
    this.channels.clear();
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
      folder: ch.profile.folder || '',
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
      folder: ch.profile.folder,
      lastWrite: ch.lastWrite,
    }));
  }
}

module.exports = { MonitorScheduler, UNIFIED_ID, shuffleInPlace };
