'use strict';

/**
 * 渲染进程 —— 频道预览器 + 过渡动画 + 胶片条 + 图片信息。
 *
 * 调度权在主进程（scheduler.js），一个窗口只是「N 路轮播中的一路的显示屏」：
 *   主进程 channel:tick(频道, 索引, 图片)  ──►  本进程只负责把这一帧画出过渡
 *
 * 渲染侧的关键点：
 *   1. 动画只改 transform / opacity，走合成器线程，不触发重排；
 *   2. 缩放交给 Blink 的 object-fit，不在 JS 里做重采样；
 *   3. 预解码用 img.decode()，解码在浏览器线程池里做；
 *   4. 双图层交替：进出的两张图各占一个合成层，天然双缓冲；
 *   5. 胶片条是**窗口化渲染**：两万张的目录也只存在 2×range+1 个缩略图节点，
 *      图片走 wpthumb:// 协议取系统缩略图，不加载原图。
 */

const $ = (id) => document.getElementById(id);

const UNIFIED_ID = '__unified__';

const layers = {
  A: { root: $('layerA'), img: $('layerA').querySelector('img') },
  B: { root: $('layerB'), img: $('layerB').querySelector('img') },
};

const els = {
  stage: $('stage'),
  empty: $('empty'),
  folderLabel: $('folder-label'),
  backendBadge: $('backend-badge'),
  previewBadge: $('preview-badge'),
  hudTitle: $('hud-title'),
  hudMeta: $('hud-meta'),
  counter: $('counter'),
  progressFill: $('progress-fill'),
  settings: $('settings'),
  albums: $('albums'),
  toast: $('toast'),
  iconPlay: $('icon-play'),
  iconPause: $('icon-pause'),
  memLabel: $('mem-label'),
  monitorCards: $('monitor-cards'),
  monitorHint: $('monitor-hint'),
  modeHint: $('mode-hint'),

  filmTrack: $('film-track'),
  filmPrev: $('film-prev'),
  filmNext: $('film-next'),
  filmJump: $('film-jump'),

  info: $('info'),
  infoThumb: $('info-thumb'),
  infoName: $('info-name'),
  infoSub: $('info-sub'),
  infoGroups: $('info-groups'),
  infoCopy: $('btn-info-copy'),
  infoClose: $('btn-info-close'),
  infoReveal: $('btn-info-reveal'),
  infoOpen: $('btn-info-open'),


  quickList: $('quick-list'),
  thumbStats: $('thumb-stats'),
  thumbDir: $('thumb-dir'),
  loginHint: $('login-hint'),
  hotkeyList: $('hotkey-list'),
  hotkeyHint: $('hotkey-hint'),
};

const state = {
  config: null,
  channels: [],
  perMonitor: false,
  previewId: UNIFIED_ID,      // 当前窗口正在预览哪一路轮播
  loadedSignature: null,      // 已经取过文件列表的那一路的指纹
  previewLoading: false,
  files: [],
  index: 0,
  active: 'B',                // 当前可见图层
  playing: false,
  cleanupTimer: null,
  animToken: 0,
  firstPaintDone: false,
  metaCache: new Map(),
  settingsOpen: false,
  albumsPageOpen: false,
  infoOpen: false,
  infoPath: null,
  infoToken: 0,
  backendInfo: null,
  previewErrors: new Set(),   // 已经提示过错误的频道，避免每次 tick 都弹
  played: new Set(),          // 本次会话播放过的序号（胶片条用来标灰）
  quickFolders: [],
  albums: [],                 // 相簿列表（config.albums 的镜像，主进程改了会推过来）
  lastAutoScanAt: 0,          // 上次定时自动扫描的时刻（0 = 本次会话还没扫过）
};

/* ------------------------------------------------------------ 胶片条状态 */

const film = {
  els: new Map(),      // index → 元素
  first: 0,
  last: 0,
  window: null,        // { start, end }
  range: 40,
  autoCenter: true,
  /** 用户刚手动滚过 → 这段时间内不要抢滚动条 */
  holdUntil: 0,
};

const preloadCache = new Map();
const PRELOAD_LIMIT = 6;

/* ------------------------------------------------------------ 工具 */

function humanSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 长路径只保留末两段 —— 前面的公共前缀每张卡片都一样，没有信息量 */
function shortPath(full, max = 46) {
  if (!full) return '';
  if (full.length <= max) return full;
  const parts = full.split(/[\\/]+/).filter(Boolean);
  const tail = parts.slice(-2).join('\\');
  return tail.length <= max - 2 ? `…\\${tail}` : `…\\${parts[parts.length - 1]}`;
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop() || '';

let toastTimer = null;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('err', isError);
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3200);
}

/* ------------------------------------------------------------ 频道状态 */

const channelById = (id) => state.channels.find((c) => c.id === id) || null;

function previewChannel() {
  return channelById(state.previewId);
}

function profileOf(id) {
  const ch = channelById(id);
  return (ch && ch.profile) || {
    interval: 60, duration: 520, animation: 'slide', shuffle: false, fit: 'cover',
    albumId: '', recursive: true, enabled: true,
  };
}

/** 频道显示名：统一模式 → 写入目标；每屏模式 → 分辨率 + 主屏标记 */
function channelName(ch) {
  if (!ch) return '—';
  if (ch.kind === 'monitor') {
    return `显示器 ${(ch.monitorIndex || 0) + 1} · ${ch.width}×${ch.height}${ch.primary ? ' 主屏' : ''}`;
  }
  return ch.label === '全部显示器' ? '全部显示器' : `全部显示器 · ${ch.label}`;
}

/**
 * 这张图属于哪个相簿的哪个目录 —— 信息面板的「来源」用。
 * 相簿目录之间允许嵌套（父目录递归已包含子目录），所以按最长前缀取最具体的那一个。
 * @returns {{album:object, dir:string}|null}
 */
function findAlbumSource(imagePath) {
  const lower = String(imagePath || '').toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const album of state.albums) {
    for (const f of album.folders) {
      const dir = String(f.path || '').replace(/[\\/]+$/, '').toLowerCase();
      if (!dir) continue;
      if ((lower.startsWith(`${dir}\\`) || lower.startsWith(`${dir}/`)) && dir.length > bestLen) {
        best = { album, dir: f.path };
        bestLen = dir.length;
      }
    }
  }
  return best;
}

/**
 * 频道指纹：任何会让**文件顺序**或**列表内容**变化的因素都要放进来，
 * 变了就说明预览必须重新取一次图。反过来，只是改间隔 / 动画时长这类
 * 不影响顺序的设置，指纹不该变 —— 否则画面会被打回第一张。
 *
 * 这里踩过两次同一个坑，都是「顺序变了但指纹没变」：
 *   1. 切换「播放顺序」（`profile.shuffle`）—— 调度器会把列表整个重排，
 *      但指纹里没有这一项，于是主页面还是旧顺序，怎么切都不动；
 *   2. 走完一轮（`rounds` 自增）—— `_startNextRound` 会重洗列表，
 *      同样不进指纹；而 onTick 是用 `state.files[index]` 取图的，
 *      结果就是窗口预览与桌面壁纸各显示一张不同的图。
 *
 * rev 是文件被删除或移动后自增的 —— 只比张数的话，「移动」（张数不变）会漏掉。
 */
function previewSignature(ch) {
  if (!ch) return 'none';
  // 相簿内容（目录集合 / 启用开关）也属于「列表会变」的因素：
  // 加目录恰好为空、或关 A 开 B 数量恰好相等时，count 不动但列表真的变了
  const album = state.albums.find((a) => a.id === ch.profile.albumId);
  const albumSig = album
    ? album.folders.map((f) => `${f.path}:${f.enabled ? 1 : 0}`).join(',')
    : '';
  return [
    ch.id,
    ch.profile.albumId,
    albumSig,
    ch.profile.recursive ? 1 : 0,
    ch.profile.shuffle ? 'r' : 'n',   // 播放顺序模式
    ch.rounds || 0,                    // 走完一轮会重洗
    ch.count,
    ch.rev || 0,
  ].join('|');
}

function syncProgressPlayState() {
  els.progressFill.style.animationPlayState = state.playing ? 'running' : 'paused';
}

/**
 * 按当前频道间隔重启进度条动画。
 * 用 `animation = 'none'` + 强制 reflow 把上一次的动画彻底清掉再挂新的，
 * 否则同一个动画名不会重新开始计时（换张之后进度条会停在满格）。
 */
function restartProgress() {
  const profile = profileOf(state.previewId);
  const fill = els.progressFill;
  if (!fill) return;
  const seconds = Math.max(1, Number(profile.interval) || 60);
  fill.style.animation = 'none';
  void fill.offsetWidth;
  fill.style.animation = `progress-run ${seconds}s linear forwards`;
  fill.style.animationPlayState = state.playing ? 'running' : 'paused';
}

/** 播放 / 暂停按钮的图标与 body 标记 */
function updatePlayIcon() {
  document.body.classList.toggle('playing', Boolean(state.playing));
  if (els.iconPause) els.iconPause.style.display = state.playing ? '' : 'none';
  if (els.iconPlay) els.iconPlay.style.display = state.playing ? 'none' : '';
}

/* ------------------------------------------------------------ 解码预热 */

/**
 * 提前把图片解码进 Chromium 的图像缓存。
 * 这样真正切换时 <img src> 命中的是已解码资源，不会出现半张图。
 */
function preload(entry) {
  if (!entry) return Promise.resolve(null);

  const cached = preloadCache.get(entry.path);
  if (cached) return cached;

  const img = new Image();
  img.decoding = 'async';
  img.src = entry.url;

  const task = (typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve())
    .then(() => img);

  preloadCache.set(entry.path, task);

  while (preloadCache.size > PRELOAD_LIMIT) {
    preloadCache.delete(preloadCache.keys().next().value);
  }
  return task;
}

function warmNeighbours() {
  const n = state.files.length;
  if (n < 2) return;
  for (const offset of [1, -1]) {
    preload(state.files[(state.index + offset + n) % n]);
  }
}

/* ------------------------------------------------------------ 过渡动画 */

function variantFor(animation, dir) {
  const sign = dir >= 0 ? 1 : -1;
  switch (animation) {
    case 'fade':
      return {
        enterFrom: { transform: 'translate3d(0,0,0)', opacity: '0' },
        exitTo: { transform: 'translate3d(0,0,0)', opacity: '0' },
      };
    case 'zoom':
      return {
        enterFrom: { transform: 'scale(1.07)', opacity: '0' },
        exitTo: { transform: 'scale(0.985)', opacity: '0' },
      };
    case 'slide':
    default:
      return {
        enterFrom: { transform: `translate3d(${sign * 100}%,0,0)`, opacity: '1' },
        exitTo: { transform: `translate3d(${-sign * 100}%,0,0)`, opacity: '1' },
      };
  }
}

function applyVars(el, vars) {
  for (const [key, value] of Object.entries(vars)) el.style[key] = value;
}

/**
 * 画出第 index 帧。
 * @param {number} index
 * @param {number} dir  1 = 向后，-1 = 向前（决定滑动方向）
 * @param {boolean} animate
 */
async function render(index, dir, animate) {
  const entry = state.files[index];
  if (!entry) return;

  const profile = profileOf(state.previewId);
  const token = ++state.animToken;
  await preload(entry);
  if (token !== state.animToken) return;   // 等待期间又被切走了，放弃这一帧

  const incomingKey = state.active === 'A' ? 'B' : 'A';
  const incoming = layers[incomingKey];
  const outgoing = layers[state.active];
  const duration = animate ? Math.max(0, profile.duration || 0) : 0;

  incoming.img.src = entry.url;

  if (duration === 0) {
    incoming.root.style.transition = 'none';
    applyVars(incoming.root, { transform: 'translate3d(0,0,0)', opacity: '1' });
    outgoing.root.style.transition = 'none';
    applyVars(outgoing.root, { opacity: '0' });
  } else {
    const { enterFrom, exitTo } = variantFor(profile.animation, dir);
    const transition = `transform ${duration}ms var(--ease), opacity ${duration}ms var(--ease)`;

    // 第一帧先关掉过渡把入场图层摆到起始位置
    incoming.root.style.transition = 'none';
    applyVars(incoming.root, enterFrom);

    // 强制样式结算，否则浏览器会把「起始位置 + 终点位置」合并成一次样式更新，动画不触发
    void incoming.root.offsetWidth;

    incoming.root.style.transition = transition;
    outgoing.root.style.transition = transition;
    applyVars(incoming.root, { transform: 'translate3d(0,0,0)', opacity: '1' });
    applyVars(outgoing.root, exitTo);
  }

  state.active = incomingKey;

  // 动画结束后把后层钉死在透明+原位，避免下次复用时残留位移
  clearTimeout(state.cleanupTimer);
  state.cleanupTimer = setTimeout(() => {
    if (token !== state.animToken) return;
    const stale = layers[state.active === 'A' ? 'B' : 'A'];
    stale.root.style.transition = 'none';
    applyVars(stale.root, { transform: 'translate3d(0,0,0)', opacity: '0' });
  }, duration + 60);
}

/* ------------------------------------------------------------ HUD */

function formatMeta(info) {
  const parts = [];
  if (info.width && info.height) parts.push(`${info.width} × ${info.height}`);
  if (info.size) parts.push(humanSize(info.size));
  if (info.mtime) parts.push(new Date(info.mtime).toLocaleDateString('zh-CN'));
  return parts.join('   ·   ') || '—';
}

async function updateHud() {
  const entry = state.files[state.index];
  els.counter.textContent = `${state.files.length ? state.index + 1 : 0} / ${state.files.length}`;

  if (!entry) {
    els.hudTitle.textContent = '—';
    els.hudMeta.textContent = '—';
    return;
  }

  els.hudTitle.textContent = entry.name;
  els.hudTitle.title = entry.path;

  const cached = state.metaCache.get(entry.path);
  if (cached) {
    els.hudMeta.textContent = cached;
    return;
  }

  els.hudMeta.textContent = '读取信息…';
  const info = await window.wp.probeImage(entry.path);
  const text = formatMeta(info);
  state.metaCache.set(entry.path, text);

  // 异步返回时可能已经切到别的图了，确认一下再写
  const now = state.files[state.index];
  if (now && now.path === entry.path) els.hudMeta.textContent = text;
}

/* ------------------------------------------------------------ 胶片条 */

function filmReset() {
  film.els.clear();
  film.window = null;
  film.first = 0;
  film.last = 0;
  /*
   * 轨道清空 = 换了一份列表（切预览目标 / 目录变了 / 重扫）。
   * 这时「用户刚手动翻过」的宽限期必须一起作废 —— 它是针对上一份列表的，
   * 留着会让新列表连一次自动跟随都捞不到，看上去就是切回来后胶片条不动。
   */
  film.holdUntil = 0;
  els.filmTrack.innerHTML = '';
  els.filmTrack.scrollLeft = 0;
}

function makeFilmItem(index) {
  const entry = state.files[index];
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'film-item';
  el.dataset.index = String(index);
  el.dataset.path = entry.path;
  el.title = `${index + 1} / ${state.files.length}\n${entry.name}`;

  /*
   * 目录分隔标记（顺序模式专属）：相簿把多个目录拼成一份列表，
   * 播到「目录边界」时在缩略图上画一条线 —— 像书的章节分隔一样，
   * 不用点开信息面板也知道现在播到了哪个目录。随机模式整个是洗过的，标了反而误导。
   */
  const prev = index > 0 ? state.files[index - 1] : null;
  if (prev && entry.dir && prev.dir && entry.dir !== prev.dir
      && !profileOf(state.previewId).shuffle) {
    el.classList.add('seg-start');
    el.title += `\n目录：${entry.dir}`;
  }

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.draggable = false;
  img.alt = '';
  img.src = window.wp.thumbUrl(entry.path);
  // 极端格式（avif / 部分 tiff）缩略图生成失败时会 404，别留一个破图占位
  img.addEventListener('error', () => { img.classList.add('broken'); el.classList.add('broken'); });

  const no = document.createElement('span');
  no.className = 'film-no';
  no.textContent = String(index + 1);

  /*
   * 右上角的删除按钮。
   * 必须是 span 而不是 button —— 外层 .film-item 本身就是 <button>，按钮不能嵌套。
   * 点击要 stopPropagation：胶片条用的是事件委托，不拦的话会先跳过去再删
   * （用户看到的是「点了删除，画面却跳到了那张，然后才弹确认框」）。
   */
  const del = document.createElement('span');
  del.className = 'film-del';
  del.setAttribute('role', 'button');
  del.title = `删除到回收站：${entry.name}`;
  del.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"'
    + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.4M9.2 7v3.4"/></svg>';
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    requestFilmDelete(index);
  });

  el.append(img, no, del);
  return el;
}

/**
 * 删除胶片条上某一张（走系统确认框）。
 * @param {number} index
 */
async function requestFilmDelete(index) {
  const entry = state.files[index];
  if (!entry) return;

  const result = await window.wp.trashWithConfirm(entry.path);
  if (result.canceled) return;
  if (!result.ok) {
    toast(result.error || '删除失败', true);
    return;
  }
  toast(`已移入回收站：${result.name}（可从回收站还原）`);
  // 主进程会广播新的文件列表，胶片条与「当前图片」那一行随后自己刷新
}

/**
 * 把 DOM 里的缩略图节点对齐到 [start, end) 这个窗口。
 *
 * 不能每次重建 innerHTML：切换一次就重来 81 个 <img>，
 * 即使命中磁盘缓存也会闪一下。这里只做增删两端 + 循环复用中间部分。
 */
function syncFilmWindow(start, end) {
  const track = els.filmTrack;
  const prev = film.window;

  const size = end - start;
  const canPatch = prev
    && prev.end > start && prev.start < end          // 有重叠
    && (prev.end - prev.start) === size;             // 且窗口大小没变

  if (canPatch) {
    while (film.first < start) {
      const el = film.els.get(film.first);
      if (el) el.remove();
      film.els.delete(film.first);
      film.first += 1;
    }
    while (film.last > end) {
      film.last -= 1;
      const el = film.els.get(film.last);
      if (el) el.remove();
      film.els.delete(film.last);
    }
    while (film.first > start) {
      film.first -= 1;
      const el = makeFilmItem(film.first);
      track.insertBefore(el, track.firstChild);
      film.els.set(film.first, el);
    }
    while (film.last < end) {
      const el = makeFilmItem(film.last);
      track.appendChild(el);
      film.els.set(film.last, el);
      film.last += 1;
    }
  } else {
    track.innerHTML = '';
    film.els.clear();
    film.first = start;
    film.last = start;
    for (let i = start; i < end; i += 1) {
      const el = makeFilmItem(i);
      track.appendChild(el);
      film.els.set(i, el);
      film.last = i + 1;
    }
  }

  film.window = { start, end };
}

function updateFilmStates() {
  for (const [index, el] of film.els) {
    const isCurrent = index === state.index;
    el.classList.toggle('current', isCurrent);
    el.classList.toggle('played', !isCurrent && state.played.has(index));
    el.classList.toggle('future', !isCurrent && !state.played.has(index));
  }
}

function renderFilmstrip() {
  const n = state.files.length;
  if (n === 0) {
    filmReset();
    els.filmTrack.innerHTML = '<div class="film-empty">这一路还没有图片</div>';
    return;
  }

  const range = film.range;
  const span = range * 2 + 1;
  let start = Math.max(0, state.index - range);
  let end = Math.min(n, state.index + range + 1);

  // 贴边时把窗口补满，别让首尾两端缩水
  if (end - start < span) {
    if (start === 0) end = Math.min(n, start + span);
    else if (end === n) start = Math.max(0, end - span);
  }

  syncFilmWindow(start, end);
  updateFilmStates();
}

function centerFilm(smooth = true) {
  if (!film.autoCenter) return;
  if (Date.now() < film.holdUntil) return;      // 用户正在翻看，别抢滚动条
  const el = film.els.get(state.index);
  if (!el) return;
  const track = els.filmTrack;
  const target = el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2;
  track.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
}

/**
 * tick / 切频道 / 重新取文件列表后统一走这里。
 *
 * `smooth=false` 用于「整条轨道刚被清空重建」的场合 —— 那时 scrollLeft 是 0，
 * 再平滑滚到中间会横穿几十张缩略图，看起来像在乱窜。直接落位才对。
 */
function updateFilmstrip(center = true, smooth = true) {
  renderFilmstrip();
  if (center) centerFilm(smooth);
}

function filmPage(dir) {
  const track = els.filmTrack;
  const step = Math.max(200, track.clientWidth * 0.8);
  film.holdUntil = Date.now() + 8000;
  track.scrollBy({ left: dir * step, behavior: 'smooth' });
}

/* ------------------------------------------------------------ 图片信息面板 */

function renderInfo(data) {
  els.infoGroups.innerHTML = '';

  if (!data || !data.ok) {
    els.infoSub.textContent = '读取失败';
    const div = document.createElement('div');
    div.className = 'ig-note';
    div.textContent = (data && data.error) || '未知错误';
    els.infoGroups.appendChild(div);
    return;
  }

  els.infoName.textContent = data.name;
  els.infoName.title = data.path;
  els.infoSub.textContent = data.summary || '—';

  // 相簿来源：这张图是通过哪个相簿、哪个目录进入轮播的（最长前缀匹配 —— 嵌套目录时取最具体的）
  const source = findAlbumSource(data.path);
  if (source) {
    const box = document.createElement('div');
    box.className = 'ig';
    const title = document.createElement('div');
    title.className = 'ig-title';
    title.textContent = '来源';
    box.appendChild(title);
    const rowAlbum = document.createElement('div');
    rowAlbum.className = 'ig-row';
    rowAlbum.innerHTML = `<div class="ig-label">相簿</div><div class="ig-value">${escapeHtml(source.album.name)}</div>`;
    const rowDir = document.createElement('div');
    rowDir.className = 'ig-row';
    rowDir.innerHTML = `<div class="ig-label">目录</div><div class="ig-value mono" title="${escapeHtml(source.dir)}">${escapeHtml(source.dir)}</div>`;
    box.append(rowAlbum, rowDir);
    els.infoGroups.appendChild(box);
  }

  if (data.exifNote) {
    const note = document.createElement('div');
    note.className = 'ig-note';
    note.textContent = data.exifNote;
    els.infoGroups.appendChild(note);
  }
  if (!data.hasExif) {
    const note = document.createElement('div');
    note.className = 'ig-note';
    note.textContent = '这个文件没有 EXIF 信息（常见于 AI 生成图、截图和经过二次压缩的图）。';
    els.infoGroups.appendChild(note);
  }

  for (const group of data.groups) {
    const box = document.createElement('div');
    box.className = 'ig';

    const title = document.createElement('div');
    title.className = 'ig-title';
    title.textContent = `${group.title}  ${group.rows.length}`;
    box.appendChild(title);

    for (const row of group.rows) {
      const line = document.createElement('div');
      line.className = 'ig-row';

      const label = document.createElement('div');
      label.className = 'ig-label';
      label.textContent = row.label;

      const value = document.createElement('div');
      value.className = 'ig-value';
      // 路径和长串用等宽字体，方便肉眼比对
      if (/路径|文件夹|文件名/.test(row.label)) value.classList.add('mono');
      value.textContent = row.value;
      value.title = row.value;

      line.append(label, value);
      box.appendChild(line);
    }
    els.infoGroups.appendChild(box);
  }

  // GPS 单独给一个可点链接（有坐标的图基本就是相机拍的，这项很少出现）
  if (data.gps) {
    const line = document.createElement('div');
    line.className = 'ig-row';
    line.innerHTML = '<div class="ig-label">地图</div>'
      + `<div class="ig-value"><a href="${escapeHtml(data.gps.url)}" target="_blank" rel="noreferrer">在 OpenStreetMap 中查看</a></div>`;
    els.infoGroups.appendChild(line);
  }
}

/**
 * 打开图片信息面板。
 * @param {string} imagePath
 * @param {{keepContent?:boolean}} [options]
 *   keepContent=true 用于「跟着轮播自动刷新」：先不擦掉旧内容，
 *   等新数据回来直接替换。否则每次切换都会闪一下「读取中…」。
 */
async function openInfo(imagePath, options = {}) {
  if (!imagePath) return;
  const keepContent = options.keepContent === true;

  state.infoPath = imagePath;
  state.infoOpen = true;
  els.info.classList.add('open');
  els.info.setAttribute('aria-hidden', 'false');
  document.body.classList.remove('idle');

  els.infoThumb.src = window.wp.thumbUrl(imagePath);
  els.infoName.textContent = baseName(imagePath);
  els.infoName.title = imagePath;
  if (!keepContent) {
    els.infoSub.textContent = '读取中…';
    els.infoGroups.innerHTML = '';
  }

  const token = ++state.infoToken;
  const data = await window.wp.imageInfo(imagePath);
  if (token !== state.infoToken) return;          // 期间又点了别的图
  renderInfo(data);
}

/** 信息面板开着的时候，让它跟着当前壁纸走 */
function syncInfoToCurrent() {
  if (!state.infoOpen) return;
  const entry = state.files[state.index];
  if (entry) openInfo(entry.path, { keepContent: true });
  else closeInfo();
}

function closeInfo() {
  state.infoOpen = false;
  els.info.classList.remove('open');
  els.info.setAttribute('aria-hidden', 'true');
}

function toggleInfo() {
  if (state.infoOpen) closeInfo();
  else {
    const entry = state.files[state.index];
    if (!entry) { toast('还没有可查看的图片', true); return; }
    openInfo(entry.path);
  }
}

function infoAsText() {
  const lines = [els.infoName.textContent, els.infoSub.textContent, ''];
  for (const box of els.infoGroups.querySelectorAll('.ig')) {
    lines.push(`【${box.querySelector('.ig-title').textContent.trim()}】`);
    for (const row of box.querySelectorAll('.ig-row')) {
      const label = row.querySelector('.ig-label').textContent;
      const value = row.querySelector('.ig-value').textContent;
      lines.push(`${label}：${value}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------ 频道加载与命令 */

let loadingChain = Promise.resolve();

/*
 * 补载定时器：fetch 期间签名又变了（首跑选目录 → 自动切每屏 → 双重建是最典型的
 * 交错）时，本次结果按设计丢弃；丢弃后如果再没有新的 channels 推送来触发
 * applyChannelInfo 末尾的补载（推送停了），预览就会永久搁浅在空态。
 * 所以每次丢弃都挂一个去抖定时器，触发时签名仍和已加载不符就再来一次 ——
 * 最多多花一次 21ms 的缓存取列表，换来这类时序竞态的自愈。
 */
let previewRetryTimer = null;

function schedulePreviewRetry() {
  if (previewRetryTimer) clearTimeout(previewRetryTimer);
  previewRetryTimer = setTimeout(() => {
    previewRetryTimer = null;
    const ch = channelById(state.previewId);
    if (ch && previewSignature(ch) !== state.loadedSignature) loadPreviewChannel();
  }, 300);
}

function loadPreviewChannel() {
  loadingChain = loadingChain.then(doLoadPreviewChannel).catch((err) => {
    console.error('[preview] 载入频道失败:', err);
  });
  return loadingChain;
}

async function doLoadPreviewChannel() {
  const id = state.previewId;
  // 主进程要拿这个决定全局热键作用于哪块屏（窗口藏在托盘里时它自己看不到预览状态）
  window.wp.setPreviewChannel(id || null);
  if (!id) {
    state.files = [];
    state.index = 0;
    state.loadedSignature = 'none';
    els.empty.hidden = false;
    filmReset();
    updateHud();
    return;
  }

  const ch = channelById(id);
  const signature = previewSignature(ch);
  const result = await window.wp.channelFiles(id);

  // 取文件期间用户又切了频道 / 配置变了，丢弃这次结果；并安排补载兜底（见上）
  if (state.previewId !== id || previewSignature(channelById(id)) !== signature) {
    schedulePreviewRetry();
    return;
  }

  state.loadedSignature = signature;
  state.files = result.files || [];
  state.metaCache.clear();
  preloadCache.clear();
  state.index = result.index || 0;
  state.firstPaintDone = false;
  state.playing = ch ? Boolean(ch.playing) : false;
  state.played = new Set(result.played || []);

  applyFit();
  filmReset();

  if (!state.files.length) {
    els.empty.hidden = false;
    setLayerEmpty();
    updateHud();
    updatePlayIcon();
    syncProgressPlayState();
    updateFilmstrip(false);
    return;
  }

  els.empty.hidden = true;
  await render(state.index, 1, false);
  state.firstPaintDone = true;
  updateHud();
  updatePlayIcon();
  restartProgress();
  warmNeighbours();
  // 切到（或切回）某一路，胶片条要立刻对准它当前正在播的那张 ——
  // 否则要等下一次定时切换才滚过去，看上去像是切回来后胶片条停在别处。
  updateFilmstrip(true, false);
  syncInfoToCurrent();      // 换频道 / 列表变了，信息面板跟着走
}

function setLayerEmpty() {
  for (const key of ['A', 'B']) {
    layers[key].root.style.transition = 'none';
    applyVars(layers[key].root, { transform: 'translate3d(0,0,0)', opacity: '0' });
    layers[key].img.removeAttribute('src');
  }
  state.active = 'B';
}

function applyFit() {
  const profile = profileOf(state.previewId);
  document.body.classList.toggle('fit-contain', profile.fit === 'contain');
}

/** 统一走主进程：切换立刻写入对应屏幕，再由 tick 事件回到这里画过渡 */
async function command(action, payload) {
  const id = state.previewId;
  if (!id) return null;
  const result = await window.wp.channelCommand(id, action, payload);
  if (result && result.channels) applyChannelInfo({ channels: result.channels });
  return result;
}

/** 跳到某个序号（胶片条点击走这里） */
async function goToIndex(index) {
  if (!state.previewId || !state.files.length) return;
  film.holdUntil = 0;                     // 用户明确选了某张，恢复跟随
  state.played.add(index);
  await command('goto', { index });
}

/* ------------------------------------------------------------ 预览目标选择 */

/**
 * 点顶栏的「预览：xxx」弹出可选目标（统一频道 / 每一块屏）。
 *
 * 以前这个徽标只是一块牌子 —— 想换预览目标得滚到设置面板里、点每张卡片右上角
 * 那只小眼睛。现在点它就能直接选，当前正在预览的那一项会高亮。
 */
function closePreviewMenu() {
  const open = document.getElementById('preview-menu');
  if (open) open.remove();
}

function openPreviewMenu() {
  closePreviewMenu();
  if (!state.channels.length) return;

  const menu = document.createElement('div');
  menu.className = 'preview-menu';
  menu.id = 'preview-menu';
  menu.setAttribute('role', 'menu');

  for (const ch of state.channels) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pm-item' + (ch.id === state.previewId ? ' active' : '');
    item.setAttribute('role', 'menuitem');

    const name = document.createElement('span');
    name.textContent = channelName(ch);
    item.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'pm-meta';
    meta.textContent = `${ch.count} 张 · ${ch.profile.interval}s`;
    item.appendChild(meta);

    item.addEventListener('click', async (event) => {
      event.stopPropagation();
      closePreviewMenu();
      await setPreview(ch.id);
    });
    menu.appendChild(item);
  }

  // 挂在预览徽章自己身上（徽章 position:relative）：菜单左缘对齐徽章左缘，
  // 以前挂在整组按钮的容器上，菜单会飘到「壁纸通道 / 相簿 / 设置」那边去，看着没对齐
  els.previewBadge.appendChild(menu);

  // 点别处关掉（捕获阶段，免得先被别的处理吃掉）
  setTimeout(() => {
    const away = (event) => {
      if (event.target.closest('#preview-menu, #preview-badge')) return;
      closePreviewMenu();
      document.removeEventListener('pointerdown', away, true);
    };
    document.addEventListener('pointerdown', away, true);
  }, 0);
}

async function setPreview(id) {
  if (id === state.previewId) return;
  const previous = channelById(state.previewId);
  state.previewId = id;
  state.firstPaintDone = false;
  renderCards();
  updateBadges();
  await loadPreviewChannel();
  const now = channelById(id);
  if (previous && now) toast(`预览已切换到「${channelName(now)}」`);
}

/* ------------------------------------------------------------ 主进程事件 */

/**
 * 「跳过了 N 张失效图片」的聚合文案。
 *
 * 之所以要聚合而不是逐张弹：一次切换可能摘掉一整批（用户删了整个目录），
 * 逐张弹会在几秒里刷出几十条提示；而且 toast 只有一个槽位，后一条会顶掉前一条。
 */
function skipMessage(skipped) {
  const parts = [];
  if (skipped.dropped) parts.push(`${skipped.dropped} 张已被删除`);
  if (skipped.bad) parts.push(`${skipped.bad} 张读不出来`);
  return `已跳过 ${skipped.total} 张失效图片（${parts.join('，')}）`;
}

function onTick(payload) {
  if (!payload) return;

  // 本次切换跳过了几张失效图片（可能为 ''）
  const skippedMsg = payload.skipped && payload.skipped.total ? skipMessage(payload.skipped) : '';

  // 不是当前预览的频道：只更新设置面板里的状态文字，不动画面
  if (payload.id !== state.previewId) {
    updateCardStatus(payload.id, { index: payload.index, count: payload.count });
    const ch = channelById(payload.id);
    if (ch) {
      ch.index = payload.index;
      ch.current = payload.entry ? payload.entry.path : ch.current;
    }
    const write = payload.write;
    if (write && !write.ok && !isMissingWrite(write)) {
      const key = `${payload.id}:${write.error}`;
      if (!state.previewErrors.has(key)) {
        state.previewErrors.add(key);
        toast(`「${channelName(ch)}」写入失败：${write.error || write.method}`
          + (skippedMsg ? `（${skippedMsg}）` : ''), true);
      }
    } else if (skippedMsg) {
      toast(skippedMsg);
    }
    return;
  }

  const previousIndex = state.index;
  state.index = payload.index;
  state.played.add(payload.index);
  applyFit();
  render(payload.index, payload.dir || 1, state.firstPaintDone);
  state.firstPaintDone = true;

  updateHud();
  restartProgress();
  warmNeighbours();
  updateFilmstrip(previousIndex !== payload.index);
  if (previousIndex !== payload.index) {
    syncInfoToCurrent();
  }

  // 真正的写入失败：把「跳过了几张失效图片」并进同一条消息（toast 只有一个槽位，
  // 分两条发的话后者会把前者顶掉，跳过信息就永远看不见了）
  if (payload.write && !payload.write.ok && !payload.write.skipped && !isMissingWrite(payload.write)) {
    toast(`系统壁纸写入失败：${payload.write.error || payload.write.method}`
      + (skippedMsg ? `（${skippedMsg}）` : ''), true);
  } else if (skippedMsg) {
    toast(skippedMsg);
  }
}

function applyChannelInfo(info) {
  if (info.channels) state.channels = info.channels;
  if (info.perMonitor !== undefined) state.perMonitor = Boolean(info.perMonitor);
  // 定时自动扫描完成的时刻（主进程带上来的），设置面板里显示「上次扫描 …」
  if (info.lastAutoScanAt !== undefined) {
    state.lastAutoScanAt = Number(info.lastAutoScanAt) || 0;
    renderAutoScanHint();
  }

  document.body.classList.toggle('mode-per-monitor', state.perMonitor);
  setSegment('cfg-mode', state.perMonitor ? 'per-monitor' : 'unified');
  els.modeHint.textContent = state.perMonitor
    ? '每屏独立：每台显示器各用一套目录与节奏，互不影响。'
    : '统一配置：所有显示器共用一套目录与节奏。';

  // 预览目标失效（换模式 / 显示器被拔掉）时自动落一个有效的
  const ids = state.channels.map((c) => c.id);
  if (!ids.includes(state.previewId)) {
    state.previewId = ids[0] || null;
    state.firstPaintDone = false;
  }

  const previewing = previewChannel();
  if (previewing) {
    state.playing = Boolean(previewing.playing);
    updatePlayIcon();
    syncProgressPlayState();
  }

  renderCards();
  updateBadges();
  // 别的频道的索引也顺手刷新，避免设置面板显示旧值
  updateFilmStates();

  // 目录 / 递归 / 张数 / 修订号变了才重新取文件列表，单纯改间隔不该把画面打回第一张
  if (previewSignature(previewing) !== state.loadedSignature) loadPreviewChannel();
}

/* ------------------------------------------------------------ 设置面板 */

/**
 * seg 控件的 data-value 是字符串，但配置里有几个字段必须是布尔值。
 *
 * 「播放顺序」就是踩过坑的那个：把 `'random'` / `'order'` 原样写进配置后，
 * resolveProfile 里 `shuffle === true` 永远不成立，于是「从随机切到按名称之后
 * 再也切不回随机」。这里按字段声明各自的取值方式，别再让字符串漏进配置。
 */
const SEG_VALUE = {
  shuffle: (v) => v === 'random',
};

function segValue(field, raw) {
  const convert = SEG_VALUE[field];
  return convert ? convert(raw) : raw;
}

function setSegment(containerId, value) {
  const container = $(containerId);
  if (!container) return;
  for (const item of container.querySelectorAll('.seg-item')) {
    item.classList.toggle('active', item.dataset.value === value);
  }
}

function segHtml(field, value, options) {
  return options.map(([val, text]) => (
    `<button class="seg-item${val === value ? ' active' : ''}" data-value="${val}" data-field="${field}">${text}</button>`
  )).join('');
}

function albumOf(id) {
  return state.albums.find((a) => a.id === id) || null;
}

function updateBadges() {
  const ch = previewChannel();
  if (ch) {
    const album = albumOf(ch.profile.albumId);
    els.previewBadge.textContent = `预览：${channelName(ch)}`;
    els.previewBadge.title = [
      `相簿：${album ? album.name : '（未选择）'}`,
      album ? `目录 ${album.folders.length} 个（启用 ${album.folders.filter((f) => f.enabled).length} 个）` : '',
      `共 ${ch.count} 张，当前第 ${ch.count ? ch.index + 1 : 0} 张`,
      `间隔 ${formatInterval(ch.profile.interval)}`,
      `接管：${ch.profile.enabled ? '是' : '否'}`,
    ].filter(Boolean).join('\n');
    els.folderLabel.textContent = album
      ? `${album.name} · ${album.folders.filter((f) => f.enabled).length}/${album.folders.length} 目录`
      : '未选择相簿';
    els.folderLabel.title = album ? album.folders.map((f) => `${f.enabled ? '●' : '○'} ${f.path}`).join('\n') : '';
  } else {
    els.previewBadge.textContent = '预览：—';
    els.folderLabel.textContent = '未选择相簿';
  }

  const info = state.backendInfo;
  if (!info) return;
  const com = String(info.backend).startsWith('com:');
  els.backendBadge.textContent = com
    ? `壁纸通道：IDesktopWallpaper（${(info.monitors || []).length} 屏）`
    : `壁纸通道：${info.backend}`;
  els.backendBadge.classList.toggle('ok', com);
  els.backendBadge.classList.toggle('warn', !com);
  els.backendBadge.title = [
    `平台：${info.platform}`,
    `全局壁纸槽位：${info.globalWallpaper || '未能读取'}`,
    ...(info.monitors || []).map((m) => `${m.label} → ${m.current || '(未单独设置)'}`),
  ].join('\n');
}

/** 相簿下拉的公共选项（每屏卡片与统一模式共用同一份） */
function albumOptions(selectedId, withBlank = true) {
  const opts = [];
  if (withBlank) opts.push('<option value="">（未选择相簿）</option>');
  for (const album of state.albums) {
    const dirs = album.folders.filter((f) => f.enabled).length;
    opts.push(`<option value="${escapeHtml(album.id)}"${album.id === selectedId ? ' selected' : ''}>`
      + `${escapeHtml(album.name)}（${dirs}/${album.folders.length} 目录）</option>`);
  }
  return opts.join('');
}

function cardHtml(ch) {
  const p = ch.profile;
  const previewing = ch.id === state.previewId;
  const classes = ['monitor-card'];
  if (previewing) classes.push('previewing');
  if (!p.enabled) classes.push('off');

  const album = albumOf(p.albumId);
  const albumPathTitle = album ? album.folders.map((f) => `${f.enabled ? '●' : '○'} ${f.path}`).join('\n') : '';
  const missing = (ch.missingDirs || []);
  const status = [];
  status.push(`<span>${ch.count} 张</span>`);
  status.push(`<span>第 ${ch.count ? ch.index + 1 : 0}/${ch.count}</span>`);
  if (ch.truncated) status.push('<span>已达扫描上限</span>');
  if (missing.length) status.push(`<span class="err" title="${escapeHtml(missing.join('\n'))}">${missing.length} 个目录不可用</span>`);
  // 失效图片：已被程序自动跳过（从列表摘掉 / 本轮不写），只是让用户知道列表为什么变短了
  if (ch.skipped && ch.skipped.total) {
    const parts = [];
    if (ch.skipped.dropped) parts.push(`${ch.skipped.dropped} 张已被删除`);
    if (ch.skipped.bad) parts.push(`${ch.skipped.bad} 张读不出来`);
    status.push(`<span class="warn" title="这些图片已自动跳过并换下一张：${escapeHtml(parts.join('，'))}">已跳过 ${ch.skipped.total} 张失效</span>`);
  }
  if (ch.lastError) status.push(`<span class="err">${escapeHtml(ch.lastError)}</span>`);
  else if (p.enabled && ch.count) status.push(`<span class="ok">已接管</span>`);
  else if (!p.enabled) status.push('<span>未接管</span>');
  if (ch.scanMs) status.push(`<span>扫描 ${ch.scanMs} ms</span>`);
  // 「第几张」—— 随机模式是「列表洗过牌」，播放就顺着列表走，
  // 所以 index+1 在这里和顺序模式一样有意义：它就是胶片条上的位置
  if (ch.count) status.push(`<span>第 ${ch.index + 1} / ${ch.count} 张</span>`);

  return `
  <div class="${classes.join(' ')}" data-id="${escapeHtml(ch.id)}">
    <div class="mc-head">
      <div>
        <div class="mc-title">${escapeHtml(channelName(ch))}</div>
        <div class="mc-res">@ ${ch.x},${ch.y}${ch.primary ? ' · 主屏' : ''}</div>
      </div>
      <button class="eye" data-act="preview" title="把窗口预览切到这块屏">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M1 8s2.6-4.4 7-4.4S15 8 15 8s-2.6 4.4-7 4.4S1 8 1 8z"/><circle cx="8" cy="8" r="1.8"/>
        </svg>${previewing ? '预览中' : '预览'}
      </button>
    </div>
    <div class="mc-path${album ? '' : ' empty'}" title="${escapeHtml(albumPathTitle)}">${
      album
        ? `${escapeHtml(album.name)} · ${album.folders.filter((f) => f.enabled).length}/${album.folders.length} 目录`
        : '未选择相簿'
    }</div>
    <div class="mc-status">${status.join('')}</div>
    <div class="mc-row">
      <select class="select sm" data-field="albumId" title="选择这块屏轮播的相簿">${albumOptions(p.albumId)}</select>
      <button class="btn sm" data-act="pick" title="选目录加入这块屏的相簿（没有相簿会自动创建）">添加目录</button>
    </div>
    <div class="mc-row">
      <button class="btn sm" data-act="rescan">重新扫描</button>
      <button class="btn sm" data-act="apply">设为壁纸</button>
      <button class="btn sm" data-act="toggle-play">${ch.playing ? '暂停' : '播放'}</button>
    </div>
    <label class="check"><input type="checkbox" data-field="enabled"${p.enabled ? ' checked' : ''}><span>由本程序接管这块屏</span></label>
    <div class="mc-block">
      <label class="field-label">轮播间隔</label>
      <div class="field-row">
        <input type="range" data-field="interval" min="3" max="3600" step="1" value="${p.interval}">
        <output class="field-value" data-out="interval">${formatInterval(p.interval)}</output>
      </div>
      <div class="preset-row">
        ${[30, 60, 300, 1800].map((s) => `<button type="button" class="preset-chip${p.interval === s ? ' active' : ''}" data-sec="${s}">${formatInterval(s)}</button>`).join('')}
      </div>
    </div>
    <details class="mc-more"${ch._open ? ' open' : ''}>
      <summary>更多设置</summary>
      <div class="mc-block">
        <label class="field-label">过渡动画</label>
        <div class="seg" data-seg="animation">${segHtml('animation', p.animation, [['slide', '滑动'], ['fade', '淡入'], ['zoom', '缩放']])}</div>
      </div>
      <div class="mc-block">
        <label class="field-label">动画时长</label>
        <div class="field-row">
          <input type="range" data-field="duration" min="120" max="1500" step="20" value="${p.duration}">
          <output class="field-value" data-out="duration">${p.duration} ms</output>
        </div>
      </div>
      <div class="mc-block">
        <label class="field-label">播放顺序</label>
        <div class="seg" data-seg="shuffle">${segHtml('shuffle', p.shuffle ? 'random' : 'order', [['order', '按名称'], ['random', '随机不重复']])}</div>
      </div>
      <div class="mc-block">
        <label class="field-label">填充方式</label>
        <div class="seg" data-seg="fit">${segHtml('fit', p.fit, [['cover', '铺满裁切'], ['contain', '完整显示']])}</div>
      </div>
      <label class="check"><input type="checkbox" data-field="recursive"${p.recursive ? ' checked' : ''}><span>包含子文件夹</span></label>
    </details>
  </div>`;
}

function renderCards() {
  if (!state.perMonitor) {
    els.monitorCards.innerHTML = '';
    return;
  }

  // 用户正在拖滑块时不要重建 DOM，否则拖到一半会被替换掉
  const active = document.activeElement;
  if (active && active.type === 'range' && els.monitorCards.contains(active)) return;

  // 记住哪些卡片的「更多设置」是展开的，重建后恢复
  const openIds = new Set();
  for (const details of els.monitorCards.querySelectorAll('details.mc-more[open]')) {
    const card = details.closest('.monitor-card');
    if (card) openIds.add(card.dataset.id);
  }
  for (const ch of state.channels) ch._open = openIds.has(ch.id);

  els.monitorCards.innerHTML = state.channels.map(cardHtml).join('');

  els.monitorHint.textContent = state.channels.length
    ? `已检测到 ${state.channels.length} 台显示器；每台选择一个相簿，各自定节奏。`
    : '没有检测到显示器，或每屏壁纸接口不可用。';
}

/** 只改状态行文字，避免每来一次 tick 就重建整个面板 */
function updateCardStatus(id, patch) {
  const card = els.monitorCards.querySelector(`.monitor-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const spans = card.querySelectorAll('.mc-status span');
  if (spans.length >= 2 && patch.count !== undefined) {
    spans[0].textContent = `${patch.count} 张`;
    spans[1].textContent = `第 ${patch.count ? patch.index + 1 : 0}/${patch.count}`;
  }
}

async function pushProfile(id, patch) {
  const result = await window.wp.channelCommand(id, 'set-profile', patch);
  if (result && result.channels) applyChannelInfo({ channels: result.channels });
  return result;
}

/* ------------------------------------------------------------ 快捷文件夹 */

function renderQuickFolders() {
  els.quickList.innerHTML = state.quickFolders.map((f) => `
    <div class="quick-item" data-id="${escapeHtml(f.id)}">
      <div class="quick-item-text">
        <div class="quick-item-name">${escapeHtml(f.name)}</div>
        <div class="quick-item-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>
      </div>
      <button class="btn sm" data-act="quick-reveal" title="在资源管理器中打开">打开</button>
      <button class="btn sm" data-act="quick-remove" title="从预设里移除">移除</button>
    </div>`).join('');
}

async function refreshQuickFolders() {
  state.quickFolders = await window.wp.listQuickFolders();
  renderQuickFolders();
}

/* ------------------------------------------------------------ 相簿管理 */

/** 展开的相簿卡片（重绘后保持展开状态） */
const albumsOpen = new Set();

async function refreshAlbums() {
  state.albums = await window.wp.listAlbums();
  renderAlbums();
  syncAlbumSelect();
  /*
   * 相簿列表是频道推送之后才就位的（init 顺序 / albums:changed 时机都可能晚半拍），
   * 而卡片上的相簿下拉、顶栏的相簿状态都是渲染频道时画的 —— 不补这一脚，
   * 启动后的头几秒它们全停留在「未选择相簿」占位，等下一次频道推送才自愈，
   * 看上去就是「设置时好时坏」。列表一变，凡引用它的界面全部重画。
   */
  renderCards();
  updateBadges();
}

/** 统一模式的相簿下拉与卡片里的下拉共用这一份选项 */
function syncAlbumSelect() {
  const select = $('cfg-album');
  if (select && state.config) select.innerHTML = albumOptions(state.config.albumId);
}

function renderAlbums() {
  const list = $('album-list');
  if (!list) return;

  if (!state.albums.length) {
    list.innerHTML = '<div class="album-empty">还没有相簿。点「新建相簿」，再把图片目录加进去。</div>';
    return;
  }

  const usedBy = (albumId) => state.channels.filter((c) => c.profile && c.profile.albumId === albumId).length;

  list.innerHTML = state.albums.map((album) => {
    const enabledCount = album.folders.filter((f) => f.enabled).length;
    const used = usedBy(album.id);
    const cover = album.cover
      ? `<img class="album-cover" src="${window.wp.thumbUrl(album.cover)}" alt="" loading="lazy">`
      : '<div class="album-cover empty" aria-hidden="true"></div>';
    const dirsHtml = album.folders.map((f, i) => `
      <div class="album-dir${f.enabled ? '' : ' off'}">
        <input type="checkbox" data-album-act="toggle" data-path="${escapeHtml(f.path)}"${f.enabled ? ' checked' : ''}
               title="启用 / 停用这个目录（停用后不参与轮播，配置保留）">
        <span class="album-dir-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
        <button class="btn icon sm" data-album-act="up" data-path="${escapeHtml(f.path)}" title="上移（顺序模式下排在前面的目录先播）"${i === 0 ? ' disabled' : ''}>↑</button>
        <button class="btn icon sm" data-album-act="down" data-path="${escapeHtml(f.path)}" title="下移"${i === album.folders.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="btn icon sm" data-album-act="remove" data-path="${escapeHtml(f.path)}" title="从相簿移除这个目录（不删除图片文件）">×</button>
      </div>`).join('');

    return `
    <div class="album-card${albumsOpen.has(album.id) ? ' open' : ''}" data-album-id="${escapeHtml(album.id)}">
      <div class="album-head" data-album-act="toggle-open" title="点击展开 / 收起目录列表">
        ${cover}
        <div class="album-head-text">
          <div class="album-name">${escapeHtml(album.name)}</div>
          <div class="album-meta">${enabledCount}/${album.folders.length} 目录启用${used ? ` · ${used} 块屏在用` : ' · 未绑定屏幕'}</div>
        </div>
        <button class="btn sm" data-album-act="rename" title="重命名这个相簿">改名</button>
        <button class="btn sm danger" data-album-act="delete" title="删除相簿（图片文件不受影响）">删除</button>
      </div>
      <div class="album-dirs"${albumsOpen.has(album.id) ? '' : ' hidden'}>
        ${dirsHtml || '<div class="album-empty">还没有目录，点下面「添加目录…」。</div>'}
        <div class="field-row">
          <button class="btn sm" data-album-act="add">添加目录…</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

/** 对某相簿的目录数组做一次变换，然后整包写回（主进程重建，界面随后被推着刷新） */
async function mutateAlbumDirs(albumId, mutator) {
  const album = state.albums.find((a) => a.id === albumId);
  if (!album) return;
  const folders = album.folders.map((f) => ({ ...f }));
  mutator(folders);
  await window.wp.updateAlbum(albumId, { folders });
}

/** 原生多选目录对话框 → 追加进相簿 */
async function addDirsToAlbum(albumId) {
  const album = state.albums.find((a) => a.id === albumId);
  if (!album) return;
  const dirs = await window.wp.pickDirs();
  if (!dirs || !dirs.length) return;
  const existing = new Set(album.folders.map((f) => f.path.toLowerCase()));
  const fresh = dirs.filter((p) => !existing.has(p.toLowerCase()));
  if (!fresh.length) { toast('所选目录都已在这个相簿里了'); return; }
  await window.wp.updateAlbum(albumId, {
    folders: [...album.folders, ...fresh.map((p) => ({ path: p, enabled: true }))],
  });
  toast(`已加入相簿「${album.name}」：${fresh.map(baseName).join('、')}`);
}

async function onAlbumListClick(e) {
  const card = e.target.closest('.album-card');
  if (!card) return;
  const albumId = card.dataset.albumId;
  const album = state.albums.find((a) => a.id === albumId);
  if (!album) return;

  const act = e.target.closest('[data-album-act]');
  const kind = act ? act.dataset.albumAct : 'toggle-open';
  // 点在目录行的按钮/勾选框上时不当成「展开/收起」
  if (!act && e.target.closest('.album-dirs')) return;

  switch (kind) {
    case 'toggle-open':
      if (albumsOpen.has(albumId)) albumsOpen.delete(albumId);
      else albumsOpen.add(albumId);
      renderAlbums();
      break;
    case 'add':
      await addDirsToAlbum(albumId);
      break;
    case 'rename': {
      // 行内改名：名字换成输入框，Enter 或失焦提交，Esc 取消
      const nameEl = card.querySelector('.album-name');
      if (!nameEl || nameEl.querySelector('input')) break;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'album-rename';
      input.value = album.name;
      nameEl.textContent = '';
      nameEl.appendChild(input);
      input.focus();
      input.select();
      let done = false;
      const commit = async () => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (name && name !== album.name) await window.wp.updateAlbum(albumId, { name });
        else renderAlbums();
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { done = true; renderAlbums(); }
        ev.stopPropagation();
      });
      input.addEventListener('blur', commit);
      input.addEventListener('click', (ev) => ev.stopPropagation());
      break;
    }
    case 'delete':
      await window.wp.deleteAlbum(albumId);
      albumsOpen.delete(albumId);
      toast(`已删除相簿「${album.name}」（图片文件不受影响）`);
      break;
    case 'up':
      await mutateAlbumDirs(albumId, (folders) => {
        const i = folders.findIndex((f) => f.path === act.dataset.path);
        if (i > 0) [folders[i - 1], folders[i]] = [folders[i], folders[i - 1]];
      });
      break;
    case 'down':
      await mutateAlbumDirs(albumId, (folders) => {
        const i = folders.findIndex((f) => f.path === act.dataset.path);
        if (i >= 0 && i < folders.length - 1) [folders[i + 1], folders[i]] = [folders[i], folders[i + 1]];
      });
      break;
    case 'remove':
      await mutateAlbumDirs(albumId, (folders) => {
        const i = folders.findIndex((f) => f.path === act.dataset.path);
        if (i >= 0) folders.splice(i, 1);
      });
      break;
    default:
      break;
  }
}

async function onAlbumListChange(e) {
  const card = e.target.closest('.album-card');
  if (!card) return;
  if (e.target.dataset.albumAct !== 'toggle') return;
  const albumId = card.dataset.albumId;
  const path = e.target.dataset.path;
  await mutateAlbumDirs(albumId, (folders) => {
    const item = folders.find((f) => f.path === path);
    if (item) item.enabled = e.target.checked;
  });
}

/* ------------------------------------------------------------ 设置面板交互 */

function openSettings() {
  state.settingsOpen = true;
  els.settings.classList.add('open');
  els.settings.setAttribute('aria-hidden', 'false');
  document.body.classList.remove('idle');
  closeAlbumsPage();              // 两个覆盖层互斥，别叠在一起
  refreshThumbStats();
  refreshTrayState();
  refreshHotkeys();
}

function closeSettings() {
  state.settingsOpen = false;
  els.settings.classList.remove('open');
  els.settings.setAttribute('aria-hidden', 'true');
  cancelHotkeyCapture();          // 关面板时别把录制态留着
}

function toggleSettings() {
  if (state.settingsOpen) closeSettings(); else openSettings();
}

/* ------------------------------------------------------------ 相簿页交互 */

function openAlbumsPage() {
  state.albumsPageOpen = true;
  els.albums.classList.add('open');
  els.albums.setAttribute('aria-hidden', 'false');
  document.body.classList.remove('idle');
  if (state.settingsOpen) closeSettings();
  refreshAlbums();
}

function closeAlbumsPage() {
  if (!state.albumsPageOpen) return;
  state.albumsPageOpen = false;
  els.albums.classList.remove('open');
  els.albums.setAttribute('aria-hidden', 'true');
}

function toggleAlbumsPage() {
  if (state.albumsPageOpen) closeAlbumsPage(); else openAlbumsPage();
}

async function refreshThumbStats() {
  try {
    const s = await window.wp.thumbStats();
    els.thumbStats.textContent = `${s.files.toLocaleString('zh-CN')} 个 / ${s.mb} MB`
      + `   （命中 ${s.hits} · 生成 ${s.misses})`;
    els.thumbDir.textContent = s.dir;
  } catch (err) {
    els.thumbStats.textContent = `读取失败：${err.message}`;
  }
}

async function refreshTrayState() {
  try {
    const s = await window.wp.trayState();
    $('cfg-launch-at-login').checked = Boolean(s.launchAtLogin);
    els.loginHint.textContent = s.launchAtLogin
      ? `自启命令：${s.loginCommand}`
      : `托盘${s.installed ? '已启用' : '未启用'}。开启自启后写入的是：${s.loginCommand}`;
  } catch { /* 托盘不可用时忽略 */ }
}

/* ---------------------------------------------------------------- 热键 */

/**
 * 录制热键：把一次按键事件换算成 Electron accelerator。
 *
 * 这里有两条**实测出来的**硬约束，不是照文档抄的 —— 每一条都对应一个已经发生过的故障：
 *
 * 1. 必须优先看 `e.code`，不能只看 `e.key`。
 *    主键盘 `0` 和小键盘 `0` 的 `e.key` 都是 `"0"`，但小键盘那个键
 *    Electron **绑不上**：`Numpad0` 直接抛 "conversion failure"，
 *    `num0` 能注册成功却永远不触发（已用 keybd_event 注入 + GetAsyncKeyState
 *    做对照，确认注入本身有效，排除是注入路径的问题）。
 *    只按 e.key 换算，用小键盘录出来的就是一个「看着对、按下去没反应」的绑定，
 *    用户只能得出「热键失效」这一个结论。这里直接把小键盘拒掉并说清原因。
 *
 * 2. 标点要用**字面字符**，不能用 DOM 的 `.code` 名。
 *    Electron 认 `.` `,` `/` `;` `'` `[` `]` `\` `` ` `` `-` `=` `~` `!` 这些字符，
 *    但不认 `Period` `Comma` `Slash` `Semicolon` `Quote` `BracketLeft`
 *    `BracketRight` `Backslash` `Backquote` `Minus` —— 后者会让
 *    globalShortcut.register 抛异常。原表把 `.` 映成 `Period`，方向正好反了，
 *    于是配置里留下了 `Ctrl+Period` 这种永远注册不上的绑定。
 */

/** 物理键（e.code）→ accelerator 主键。用 code 才能区分主键盘/小键盘，也不受输入法布局影响 */
const CODE_KEYS = {
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F',
  KeyG: 'G', KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L',
  KeyM: 'M', KeyN: 'N', KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R',
  KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X',
  KeyY: 'Y', KeyZ: 'Z',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  Comma: ',', Period: '.', Slash: '/',
};

/** 具名键（e.key / e.code 两种写法都收） */
const NAMED_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right',
  Escape: 'Esc', Esc: 'Esc',
  ' ': 'Space', Space: 'Space', Spacebar: 'Space',
  Enter: 'Return', Return: 'Return', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};

/** Electron 认的字面标点。`+` 不在内 —— accelerator 用 `+` 当分隔符，加号只能写 `Plus` */
const PUNCT_CHARS = new Set([
  '`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/',
  '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '{', '}', '|', ':', '"', '<', '>', '?',
]);

/** 按下去、但不该单独当主键的东西 */
const DEAD_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified']);

/**
 * 一次按键 → `{ accelerator }`，或 `{ error: '给用户看的原因' }`。
 * 拿不准的一律拒绝，绝不把 Electron 不认识的字符串写进配置。
 */
function acceleratorFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const raw = e.key;
  const code = e.code || '';
  if (DEAD_KEYS.has(raw)) return { error: '这只是修饰键，还得再配一个字母或数字' };

  // 小键盘：accelerator 语法表达不了，硬录下来只会得到「按了没反应」
  if (/^Numpad/.test(code)) {
    return { error: '小键盘的键绑不上全局热键，请改用主键盘的数字' };
  }

  let key = CODE_KEYS[code] || NAMED_KEYS[raw];
  if (!key) {
    if (/^F\d{1,2}$/.test(raw)) key = raw;                 // F1 – F24
    else if (/^[a-z0-9]$/i.test(raw)) key = raw.toUpperCase();
    else if (PUNCT_CHARS.has(raw)) key = raw;
  }
  if (!key) return { error: `「${raw || code || '这个键'}」不能当热键，换个字母或数字试试` };

  if (!mods.length) return { error: '必须带修饰键（Ctrl / Alt / Shift / Win）' };  // 单键会抢掉全系统输入
  return { accelerator: [...mods, key].join('+') };
}

const HOTKEY_ORDER = ['cycleMonitor', 'next', 'prev', 'playPause', 'delete', 'info', 'reveal', 'toggleWindow'];
let hotkeyState = { actions: {}, hotkeys: {}, registered: {}, failed: [] };
let recordingAction = null;

/** 把 accelerator 显示得好看一点 */
function prettyAccelerator(accel) {
  return String(accel)
    .replace(/\bCtrl\b/g, 'Ctrl')
    .replace(/\bSuper\b/g, 'Win')
    .replace(/\+/g, ' + ');
}

function renderHotkeys() {
  const list = $('hotkey-list');
  list.innerHTML = '';

  const failedByAction = new Map((hotkeyState.failed || []).map((f) => [f.action, f]));

  for (const action of HOTKEY_ORDER) {
    const name = hotkeyState.actions[action] || action;
    const accel = hotkeyState.hotkeys[action] || '';
    const bad = failedByAction.get(action);
    const recording = recordingAction === action;

    const row = document.createElement('div');
    row.className = `hotkey-row${recording ? ' recording' : ''}${bad ? ' bad' : ''}`;
    row.dataset.action = action;

    const label = document.createElement('span');
    label.className = 'hotkey-name';
    label.textContent = name;

    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'hotkey-key';
    key.dataset.action = action;
    if (recording) key.textContent = '按下组合键… (Esc 取消)';
    else if (!accel) key.textContent = '未设置';
    else if (bad) key.textContent = `${prettyAccelerator(accel)}（${bad.reason}）`;
    else key.textContent = prettyAccelerator(accel);
    key.title = accel ? '点击修改，右键清除' : '点击录制';

    row.append(label, key);
    list.appendChild(row);
  }

  const bound = HOTKEY_ORDER.filter((a) => hotkeyState.hotkeys[a]);
  els.hotkeyHint.textContent = bound.length
    ? `已绑定 ${bound.length} 个：${bound.map((a) => `${hotkeyState.actions[a]}=${hotkeyState.hotkeys[a]}`).join('   ')}`
    : '还没有绑定任何热键。';
}

async function refreshHotkeys() {
  try {
    hotkeyState = await window.wp.getHotkeys();
    renderHotkeys();
  } catch { /* 主进程没起来时忽略 */ }
}

async function saveHotkey(action, accelerator) {
  const patch = { [action]: accelerator };
  const result = await window.wp.setHotkeys(patch);
  hotkeyState = {
    actions: hotkeyState.actions,
    hotkeys: result.hotkeys,
    registered: result.registered,
    failed: result.failed,
  };
  renderHotkeys();
  return result;
}

function beginHotkeyCapture(action) {
  recordingAction = action;
  renderHotkeys();
}

function cancelHotkeyCapture() {
  if (!recordingAction) return false;
  recordingAction = null;
  renderHotkeys();
  return true;
}

/** 录制态下的按键处理（capture 阶段，别让其它快捷键处理器先吃掉） */
function onHotkeyCaptureKey(e) {
  if (!recordingAction) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') { cancelHotkeyCapture(); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    const action = recordingAction;
    recordingAction = null;
    saveHotkey(action, '').then(() => toast('已解除绑定'));
    return;
  }

  const { accelerator, error } = acceleratorFromEvent(e);
  // 出错时不退出录制态 —— 用户多半只是按错了键，让他直接换一个再按
  if (error) { toast(error, true); return; }

  const action = recordingAction;
  recordingAction = null;
  saveHotkey(action, accelerator).then((r) => {
    const bad = (r.failed || []).find((f) => f.action === action);
    if (bad) toast(`没注册上：${bad.reason}`, true);
    else toast(`已绑定 ${prettyAccelerator(accelerator)}`);
  });
}

/**
 * 删除当前预览频道正在显示的那张。
 * 确认框由主进程按 confirmDelete 开关决定弹不弹，这里不用管。
 */
async function deleteCurrentImage() {
  const entry = state.files[state.index];
  if (!entry) { toast('当前没有图片', true); return; }
  const result = await window.wp.trashFile(entry.path);
  if (result.canceled) return;
  if (result.ok) toast(`已移入回收站：${result.name}`);
  else toast(`删除失败：${result.error}`, true);
}

// 间隔秒数 → 展示文案：不满一分钟显示秒，否则显示分钟（30/60/300/1800 预设也是这个口径）
function formatInterval(sec) {
  return sec < 60 ? `${sec} 秒` : `${sec % 60 === 0 ? sec / 60 : (sec / 60).toFixed(1)} 分钟`;
}

/** 自动扫描间隔（分钟）→ 展示文案：整小时的换算成小时（60 → 「每 1 小时」） */
function describeScanMinutes(min) {
  return min % 60 === 0 ? `每 ${min / 60} 小时` : `每 ${min} 分钟`;
}

/** 设置里「自动扫描相簿」的说明行 —— 关着和开着、扫过和没扫过，说法都不一样 */
function renderAutoScanHint() {
  const el = $('cfg-auto-scan-hint');
  if (!el) return;
  const min = Number(state.config && state.config.autoScanMinutes) || 0;
  if (!min) {
    el.textContent = '关闭后，只有手动「重新扫描」或重启程序才会更新图片列表。';
    return;
  }
  const stamp = state.lastAutoScanAt
    ? `上次扫描 ${new Date(state.lastAutoScanAt).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '本次启动后还没扫过';
  el.textContent = `${describeScanMinutes(min)}重新扫描一次相簿目录：新图接在列表末尾、`
    + `已删的图自动清掉，当前正在显示的那张和播放顺序都不动。${stamp}。`;
}

/**
 * 「文件不存在」类的写入失败要不要弹错误。
 *
 * 主进程现在会先探测再写：文件没了就直接跳过并补下一张，根本轮不到这里报错。
 * 真出现在这里说明是探测之后才被删的极端竞态 —— 属于已被自动处理的情况，
 * 再弹红色错误只会让人以为坏了，所以静默（卡片状态区仍能查到）。
 */
function isMissingWrite(write) {
  const text = `${write.error || ''} ${write.method || ''}`;
  return text.includes('文件不存在') || text.includes('ENOENT');
}

// 高亮与当前间隔一致的预设 chip
function syncIntervalPresetActive(container, value) {
  if (!container) return;
  for (const chip of container.querySelectorAll('.preset-chip')) {
    chip.classList.toggle('active', Number(chip.dataset.sec) === value);
  }
}

function applyConfigToUI() {
  const c = state.config;

  $('cfg-interval').value = c.interval;
  $('cfg-interval-out').textContent = formatInterval(c.interval);
  syncIntervalPresetActive($('cfg-interval-presets'), c.interval);
  $('cfg-duration').value = c.duration;
  $('cfg-duration-out').textContent = `${c.duration} ms`;
  $('cfg-recursive').checked = c.recursive;
  $('cfg-auto-scan').value = String(c.autoScanMinutes || 0);
  renderAutoScanHint();
  $('cfg-apply').checked = c.applyToSystem;
  $('cfg-apply-on-start').checked = c.applyOnStart !== false;
  $('cfg-resume-last').checked = c.resumeLast !== false;

  // ---- 后台驻留 ----
  $('cfg-tray').checked = c.tray !== false;
  $('cfg-close-to-tray').checked = c.closeToTray !== false;
  $('cfg-start-hidden').checked = c.startHidden === true;

  // ---- 删除 ----
  $('cfg-confirm-delete').checked = c.confirmDelete !== false;
  // 桌面右键菜单的开关状态不在 config 里，而在注册表里 —— 以实际注册结果为准
  refreshDesktopMenu();

  // ---- 工具栏自动隐藏 ----
  $('cfg-auto-hide').value = c.autoHideDelay;
  $('cfg-auto-hide-out').textContent = describeAutoHide(c.autoHideDelay);

  // ---- 胶片条 ----
  $('cfg-filmstrip').checked = c.filmstrip !== false;
  $('cfg-filmstrip-center').checked = c.filmstripAutoCenter !== false;
  film.range = Math.min(Math.max(Number(c.filmstripRange) || 40, 8), 200);
  film.autoCenter = c.filmstripAutoCenter !== false;
  $('cfg-filmstrip-range').value = film.range;
  $('cfg-filmstrip-range-out').textContent = `${film.range} 张`;

  // ---- 右键菜单 ----
  $('cfg-context-menu').checked = c.contextMenu !== false;
  $('cfg-info-panel').checked = c.infoPanel !== false;

  setSegment('cfg-animation', c.animation);
  setSegment('cfg-fit', c.fit);
  setSegment('cfg-shuffle', c.shuffle ? 'random' : 'order');
  setSegment('cfg-mode', c.perMonitor ? 'per-monitor' : 'unified');

  const select = $('cfg-monitor');
  select.value = c.monitor || 'all';
  if (!select.value) { select.value = 'all'; c.monitor = 'all'; }

  // 统一模式的相簿下拉（选项列表来自 state.albums，见 albumOptions）
  syncAlbumSelect();

  document.body.classList.toggle('mode-per-monitor', Boolean(c.perMonitor));
  document.body.classList.toggle('fit-contain', c.fit === 'contain');
  document.body.classList.toggle('filmstrip-off', c.filmstrip === false);
}

/** 统一模式的目标下拉框：动态追加具体显示器 */
function refreshMonitorTargets() {
  const select = $('cfg-monitor');
  for (const group of select.querySelectorAll('optgroup')) group.remove();

  const monitors = (state.backendInfo && state.backendInfo.monitors) || [];
  if (monitors.length > 1) {
    const group = document.createElement('optgroup');
    group.label = '指定某一台';
    for (const monitor of monitors) {
      const option = document.createElement('option');
      option.value = monitor.id;
      option.textContent = monitor.label;
      group.appendChild(option);
    }
    select.appendChild(group);
  }

  select.value = state.config.monitor || 'all';
  if (!select.value) select.value = 'all';

  const hint = $('monitor-target-hint');
  const err = (state.backendInfo && state.backendInfo.monitorsError) || null;
  if (err) hint.textContent = `每屏壁纸接口不可用：${err}`;
  else if (monitors.length <= 1) hint.textContent = '当前只检测到 1 台显示器；接入第二台后这里会自动出现独立选项。';
  else hint.textContent = `已检测到 ${monitors.length} 台显示器。仅修改所选屏幕，其他屏幕保持原样。`;
}

function bindSettings() {
  const save = async (patch) => {
    state.config = await window.wp.setConfig(patch);
    applyConfigToUI();
    return state.config;
  };

  // ---- 相簿 ----
  $('album-list').addEventListener('click', onAlbumListClick);
  $('album-list').addEventListener('change', onAlbumListChange);
  $('btn-album-create').addEventListener('click', async () => {
    const album = await window.wp.createAlbum();
    albumsOpen.add(album.id);
    toast(`已创建相簿「${album.name}」—— 展开它来添加图片目录`);
  });

  $('cfg-album').addEventListener('change', async (e) => {
    await save({ albumId: e.target.value });
    const album = state.albums.find((a) => a.id === e.target.value);
    toast(album ? `统一模式已切换到相簿「${album.name}」` : '已清空统一模式的相簿');
  });

  // ---- 模式切换 ----
  $('cfg-mode').addEventListener('click', async (event) => {
    const item = event.target.closest('.seg-item');
    if (!item) return;
    const perMonitor = item.dataset.value === 'per-monitor';
    setSegment('cfg-mode', item.dataset.value);
    await save({ perMonitor });
    toast(perMonitor
      ? '已切换到每屏独立模式：可以给每台显示器单独设置目录和节奏'
      : '已切换到统一配置模式：所有显示器共用一套设置');
  });

  // ---- 统一模式的字段 ----
  $('cfg-interval').addEventListener('input', (e) => {
    $('cfg-interval-out').textContent = formatInterval(Number(e.target.value));
    syncIntervalPresetActive($('cfg-interval-presets'), Number(e.target.value));
  });
  $('cfg-interval').addEventListener('change', (e) => save({ interval: Number(e.target.value) }));

  // 预设间隔：点 chip 直接落值（复用滑条的 change 保存路径）
  $('cfg-interval-presets').addEventListener('click', (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    const slider = $('cfg-interval');
    slider.value = chip.dataset.sec;
    slider.dispatchEvent(new Event('change'));
    $('cfg-interval-out').textContent = formatInterval(Number(chip.dataset.sec));
    syncIntervalPresetActive($('cfg-interval-presets'), Number(chip.dataset.sec));
  });

  $('cfg-duration').addEventListener('input', (e) => {
    $('cfg-duration-out').textContent = `${e.target.value} ms`;
  });
  $('cfg-duration').addEventListener('change', (e) => save({ duration: Number(e.target.value) }));

  $('cfg-animation').addEventListener('click', (e) => {
    const item = e.target.closest('.seg-item');
    if (!item) return;
    setSegment('cfg-animation', item.dataset.value);
    save({ animation: item.dataset.value });
  });

  $('cfg-fit').addEventListener('click', (e) => {
    const item = e.target.closest('.seg-item');
    if (!item) return;
    setSegment('cfg-fit', item.dataset.value);
    save({ fit: item.dataset.value });
    applyFit();
  });

  $('cfg-shuffle').addEventListener('click', (e) => {
    const item = e.target.closest('.seg-item');
    if (!item) return;
    setSegment('cfg-shuffle', item.dataset.value);
    save({ shuffle: item.dataset.value === 'random' });
  });

  $('cfg-recursive').addEventListener('change', async (e) => {
    await save({ recursive: e.target.checked });
    toast(e.target.checked ? '已开启子目录扫描' : '已关闭子目录扫描');
  });

  $('cfg-auto-scan').addEventListener('change', async (e) => {
    const min = Number(e.target.value) || 0;
    await save({ autoScanMinutes: min });
    renderAutoScanHint();
    toast(min ? `已开启自动扫描：${describeScanMinutes(min)}一次` : '已关闭自动扫描');
  });

  $('cfg-apply').addEventListener('change', async (e) => {
    await save({ applyToSystem: e.target.checked });
    toast(e.target.checked ? '已开启：切换时同步写入系统壁纸' : '已关闭：仅在本窗口预览');
  });

  $('cfg-apply-on-start').addEventListener('change', async (e) => {
    await save({ applyOnStart: e.target.checked });
    toast(e.target.checked ? '下次启动会立即接管所选屏幕' : '下次启动不会主动改壁纸');
  });

  $('cfg-resume-last').addEventListener('change', async (e) => {
    await save({ resumeLast: e.target.checked });
    toast(e.target.checked ? '下次启动会从上次那张继续播' : '下次启动会从第一张开始');
  });

  $('cfg-monitor').addEventListener('change', async (e) => {
    await save({ monitor: e.target.value });
    const label = e.target.selectedOptions[0] ? e.target.selectedOptions[0].textContent : e.target.value;
    toast(e.target.value !== 'all' ? `只写入「${label}」` : '所有显示器都会跟着切换');
  });

  // ---- 后台驻留 ----
  $('cfg-tray').addEventListener('change', async (e) => {
    await save({ tray: e.target.checked });
    toast(e.target.checked ? '托盘图标会在下次启动时出现' : '托盘图标会在下次启动时移除（当前实例仍保留）');
  });

  $('cfg-close-to-tray').addEventListener('change', async (e) => {
    await save({ closeToTray: e.target.checked });
    toast(e.target.checked
      ? '关闭窗口后将在托盘继续运行，用托盘菜单的「退出」才能真正结束'
      : '关闭窗口将直接退出程序');
  });

  $('cfg-start-hidden').addEventListener('change', async (e) => {
    await save({ startHidden: e.target.checked });
    toast(e.target.checked ? '下次启动只驻留托盘，不弹窗口' : '下次启动会正常显示窗口');
  });

  // ---- 删除 ----

  $('cfg-confirm-delete').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ confirmDelete: on });
    toast(on
      ? '删除前会先弹确认对话框'
      : '删除将直接移入回收站（不再询问）');
  });

  $('btn-del-current').addEventListener('click', deleteCurrentImage);

  // ---- 桌面右键菜单 ----
  // 两项（切下一张 / 删除）各自一个开关，各自读写自己那条注册表项。
  // 不是所有人都想要「删除」摆在桌面右键上——误点的代价比多点一下大得多。
  for (const [key, el] of [['next', $('cfg-desktop-menu-next')], ['delete', $('cfg-desktop-menu-delete')]]) {
    el.addEventListener('change', async (e) => {
      const on = e.target.checked;
      e.target.disabled = true;
      const r = await window.wp.desktopMenuSet(on, key);
      e.target.disabled = false;
      if (!r || !r.ok) {
        e.target.checked = !on;   // 写注册表失败就把开关弹回去，别留一个骗人的勾
        toast(`桌面右键菜单设置失败：${(r && r.error) || '未知错误'}`);
        return;
      }
      applyDesktopMenuStatus(r.status);
      const item = (r.status && r.status.items || []).find((x) => x.key === key);
      toast(on
        ? (item && item.installed
          ? `已加上「${item.label}」：桌面右键 → 「显示更多选项」`
          : '菜单项已写入，但回读不一致，请重试')
        : '已从桌面右键菜单移除');
    });
  }

  // ---- 全局热键 ----

  els.hotkeyList.addEventListener('click', (e) => {
    const btn = e.target.closest('.hotkey-key');
    if (!btn) return;
    const action = btn.dataset.action;

    // 正在录另一个就先取消，避免两个行同时进录制态
    cancelHotkeyCapture();
    beginHotkeyCapture(action);
  });

  els.hotkeyList.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('.hotkey-key');
    if (!btn) return;
    e.preventDefault();
    cancelHotkeyCapture();
    saveHotkey(btn.dataset.action, '').then(() => toast('已解除绑定'));
  });

  // 录制态：capture 阶段抢在其它快捷键处理器之前拿到按键
  window.addEventListener('keydown', onHotkeyCaptureKey, true);

  $('btn-hotkey-clear').addEventListener('click', async () => {
    cancelHotkeyCapture();
    const patch = {};
    for (const action of HOTKEY_ORDER) patch[action] = '';
    const result = await window.wp.setHotkeys(patch);
    hotkeyState = {
      actions: hotkeyState.actions,
      hotkeys: result.hotkeys,
      registered: result.registered,
      failed: result.failed,
    };
    renderHotkeys();
    toast('已清空全部热键');
  });

  $('cfg-launch-at-login').addEventListener('change', async (e) => {
    const want = e.target.checked;
    const result = await window.wp.setLaunchAtLogin(want);
    if (result.ok) {
      $('cfg-launch-at-login').checked = Boolean(result.launchAtLogin);
      await save({ launchAtLogin: Boolean(result.launchAtLogin) });
      toast(result.launchAtLogin ? '已开启开机自启' : '已关闭开机自启');
      refreshTrayState();
    } else {
      $('cfg-launch-at-login').checked = !want;
      toast(`设置失败：${result.error}`, true);
    }
  });

  // ---- 工具栏自动隐藏 ----
  $('cfg-auto-hide').addEventListener('input', (e) => {
    $('cfg-auto-hide-out').textContent = describeAutoHide(Number(e.target.value));
  });
  $('cfg-auto-hide').addEventListener('change', async (e) => {
    await save({ autoHideDelay: Number(e.target.value) });
    pokeBars();          // 按新时长重新起算，松手就能感觉到差别
  });

  // ---- 胶片条 ----
  $('cfg-filmstrip').addEventListener('change', async (e) => {
    await save({ filmstrip: e.target.checked });
    if (e.target.checked) updateFilmstrip(true);
  });

  $('cfg-filmstrip-center').addEventListener('change', async (e) => {
    await save({ filmstripAutoCenter: e.target.checked });
  });

  $('cfg-filmstrip-range').addEventListener('input', (e) => {
    $('cfg-filmstrip-range-out').textContent = `${e.target.value} 张`;
  });
  $('cfg-filmstrip-range').addEventListener('change', async (e) => {
    film.range = Number(e.target.value);
    await save({ filmstripRange: film.range });
    filmReset();
    updateFilmstrip(true);
  });

  // ---- 右键菜单 ----
  $('cfg-context-menu').addEventListener('change', (e) => save({ contextMenu: e.target.checked }));
  $('cfg-info-panel').addEventListener('change', async (e) => {
    await save({ infoPanel: e.target.checked });
    if (!e.target.checked) closeInfo();
  });

  // ---- 快捷文件夹 ----
  $('btn-quick-add').addEventListener('click', async () => {
    const result = await window.wp.pickQuickFolder();
    if (!result) return;
    if (result.error) { toast(result.error, true); return; }
    state.quickFolders = result.folders;
    renderQuickFolders();
    toast(`已添加预设：${result.folder.name}`);
  });

  $('btn-quick-add-current').addEventListener('click', async () => {
    const ch = previewChannel();
    if (!ch || !ch.folder) { toast('当前这一路还没有设置目录', true); return; }
    const result = await window.wp.addQuickFolder(ch.folder);
    if (!result.ok) { toast(result.error, true); return; }
    state.quickFolders = result.folders;
    renderQuickFolders();
    toast(`已添加预设：${result.folder.name}`);
  });

  els.quickList.addEventListener('click', async (e) => {
    const item = e.target.closest('.quick-item');
    if (!item) return;
    const id = item.dataset.id;
    const folder = state.quickFolders.find((f) => f.id === id);
    if (!folder) return;

    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'quick-reveal') {
      await window.wp.openContainingFolder(`${folder.path}\\`);
    } else if (act.dataset.act === 'quick-remove') {
      state.quickFolders = await window.wp.removeQuickFolder(id);
      renderQuickFolders();
      toast(`已移除预设：${folder.name}`);
    }
  });

  // ---- 缓存 ----
  $('btn-thumb-open').addEventListener('click', async () => {
    const s = await window.wp.thumbStats();
    const r = await window.wp.openExternally(s.dir);
    if (!r.ok) toast(`打开失败：${r.error}`, true);
  });
  $('btn-thumb-prune').addEventListener('click', async () => {
    const r = await window.wp.thumbPrune();
    await refreshThumbStats();
    toast(r.removed ? `已清理 ${r.removed} 个超额的缩略图` : '缓存没有超出上限，无需清理');
  });
  $('btn-thumb-clear').addEventListener('click', async () => {
    await window.wp.thumbClear();
    await refreshThumbStats();
    filmReset();
    updateFilmstrip(false);
    toast('缩略图缓存已清空');
  });

  // ---- 每屏卡片（事件委托，卡片会整体重绘）----
  els.monitorCards.addEventListener('input', (e) => {
    const input = e.target;
    if (input.type !== 'range') return;
    const out = input.parentElement.querySelector(`output[data-out="${input.dataset.field}"]`);
    if (!out) return;
    out.textContent = input.dataset.field === 'interval' ? formatInterval(Number(input.value)) : `${input.value} ms`;
    if (input.dataset.field === 'interval') syncIntervalPresetActive(input.closest('.mc-block'), Number(input.value));
  });

  // 每屏卡片上的预设间隔 chip：落值后走滑条同款 change 保存路径
  els.monitorCards.addEventListener('click', async (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    const slider = chip.closest('.mc-block').querySelector('input[data-field="interval"]');
    if (!slider) return;
    slider.value = chip.dataset.sec;
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    const out = slider.parentElement.querySelector('output[data-out="interval"]');
    if (out) out.textContent = formatInterval(Number(chip.dataset.sec));
    syncIntervalPresetActive(chip.closest('.mc-block'), Number(chip.dataset.sec));
  });

  els.monitorCards.addEventListener('change', async (e) => {
    const card = e.target.closest('.monitor-card');
    if (!card) return;
    const id = card.dataset.id;
    const field = e.target.dataset.field;
    if (!field) return;

    if (e.target.tagName === 'SELECT') {
      // 换相簿：写入频道 profile 并重建。scheduler 对同一相簿会保留播放位置
      const album = albumOf(e.target.value);
      await pushProfile(id, { albumId: e.target.value });
      toast(album
        ? `已切换到相簿「${album.name}」`
        : '已清空这块屏的相簿（不再轮播图片）');
    }
    else if (e.target.type === 'range') await pushProfile(id, { [field]: Number(e.target.value) });
    else if (e.target.type === 'checkbox') await pushProfile(id, { [field]: e.target.checked });
  });

  els.monitorCards.addEventListener('click', async (e) => {
    const card = e.target.closest('.monitor-card');
    if (!card) return;
    const id = card.dataset.id;

    const segItem = e.target.closest('.seg-item');
    if (segItem) {
      const field = segItem.dataset.field;
      await pushProfile(id, { [field]: segValue(field, segItem.dataset.value) });
      return;
    }

    const action = e.target.closest('[data-act]');
    if (!action) return;

    switch (action.dataset.act) {
      case 'preview':
        await setPreview(id);
        break;
      case 'pick': {
        // folder:pick 的语义是「选目录加入这块屏的相簿」（没有相簿会自动建一个）
        const folder = await window.wp.pickFolder(id);
        if (folder) toast(`已把「${baseName(folder)}」加入相簿`);
        break;
      }
      case 'rescan':
        await window.wp.channelCommand(id, 'rescan');
        break;
      case 'apply': {
        const result = await window.wp.applyChannel(id);
        toast(result.ok
          ? `已把「${result.name || ''}」写入 ${result.monitorLabel || '全部显示器'}`
          : `写入失败：${result.error}`, !result.ok);
        break;
      }
      case 'toggle-play':
        await window.wp.channelCommand(id, 'toggle-play');
        break;
      default:
        break;
    }
  });

  $('btn-free-memory').addEventListener('click', async () => {
    const mem = await window.wp.freeMemory();
    els.memLabel.textContent = `主进程 RSS ${mem.rss} MB · 堆 ${mem.heap} MB`;
    toast(`已清理缓存   ·   主进程内存 ${mem.rss} MB`);
  });

  $('btn-settings-close').addEventListener('click', closeSettings);


  // ---- 图片信息面板 ----
  els.infoClose.addEventListener('click', closeInfo);
  els.infoCopy.addEventListener('click', async () => {
    await window.wp.copyPath(infoAsText());
    toast('已复制全部信息到剪贴板');
  });
  els.infoReveal.addEventListener('click', () => {
    if (state.infoPath) window.wp.revealInExplorer(state.infoPath);
  });
  els.infoOpen.addEventListener('click', async () => {
    if (!state.infoPath) return;
    const r = await window.wp.openExternally(state.infoPath);
    if (!r.ok) toast(`打开失败：${r.error}`, true);
  });
}

/* ------------------------------------------------------------ 界面交互 */

/**
 * 桌面右键菜单的开关状态。
 *
 * 它不进 config.json —— 状态就在注册表里（装了就有、卸了就没了）。
 * 另存一份到 config 只会多出一个和现实不一致的副本，
 * 换过安装目录后「配置里关着、菜单却还在」这类鬼故事都是这么来的。
 */
async function refreshDesktopMenu() {
  try {
    applyDesktopMenuStatus(await window.wp.desktopMenuStatus());
  } catch {
    applyDesktopMenuStatus(null);
  }
}

function applyDesktopMenuStatus(status) {
  const boxes = { next: $('cfg-desktop-menu-next'), delete: $('cfg-desktop-menu-delete') };
  const hint = $('desktop-menu-hint');
  const list = Object.values(boxes).filter(Boolean);
  if (!list.length) return;

  if (hint && !hint.dataset.defaultText) hint.dataset.defaultText = hint.textContent.trim();

  if (!status || !status.available) {
    for (const box of list) { box.checked = false; box.disabled = true; }
    if (hint) hint.textContent = `这台机器上用不了注册表接口：${(status && status.error) || '未知原因'}`;
    return;
  }

  const byKey = {};
  for (const it of status.items || []) byKey[it.key] = it;
  for (const [key, box] of Object.entries(boxes)) {
    if (!box) continue;
    box.disabled = false;
    box.checked = Boolean(byKey[key] && byKey[key].installed);
  }

  if (hint) {
    hint.textContent = status.stale
      ? '注册的命令行和当前程序位置对不上（多半是挪过目录）——'
        + '关掉再打开一次这个开关就会重写。'
        + 'Windows 11 里这两项在桌面右键的「显示更多选项」下面。'
      : hint.dataset.defaultText;
  }
}

/** 把毫秒数说成人话：0 = 一直显示 */
function describeAutoHide(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '一直显示';
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(1)} 秒`;
}

let idleTimer = null;

/**
 * 「有动作了」—— 把工具栏叫回来，并按配置的时长重新起算隐藏倒计时。
 *
 * 时长读的是 `autoHideDelay`（毫秒，0 = 一直显示）。以前写死 2400ms：
 * 快速翻图时嫌它挡着、慢慢挑图时又嫌它缩太快，两种节奏不可能用一个常数同时满足。
 * 面板开着时一律不隐藏 —— 否则一开设置面板，工具栏就缩走了。
 */
function pokeBars() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!state.config) return;                        // 配置还没到就先别藏，不拿默认值猜
  const delay = Number(state.config.autoHideDelay);
  if (!Number.isFinite(delay) || delay <= 0) return; // 0 = 一直显示
  idleTimer = setTimeout(() => {
    if (!state.settingsOpen && !state.infoOpen) document.body.classList.add('idle');
  }, delay);
}

async function refreshChannelInfo() {
  const info = await window.wp.listChannels();
  state.backendInfo = info;
  refreshMonitorTargets();
  applyChannelInfo(info);
}

function bindEvents() {
  $('btn-pick').addEventListener('click', async () => {
    const folder = await window.wp.pickFolder(state.previewId);
    if (folder) toast(`已把「${baseName(folder)}」加入相簿`);
  });
  $('empty-pick').addEventListener('click', () => $('btn-pick').click());
  $('btn-rescan').addEventListener('click', async () => {
    if (!state.previewId) { $('btn-pick').click(); return; }
    const result = await window.wp.channelCommand(state.previewId, 'rescan');
    if (result && result.channels) applyChannelInfo({ channels: result.channels });
    toast('已重新扫描', false);
  });
  $('btn-settings').addEventListener('click', toggleSettings);
  $('btn-albums').addEventListener('click', toggleAlbumsPage);
  $('btn-albums-close').addEventListener('click', closeAlbumsPage);
  // 点页面空隙（内容栏以外）也返回 —— 页面铺满全窗，总得有个「点一下就走」的地方
  els.albums.addEventListener('click', (e) => {
    if (!e.target.closest('.page-inner') && !e.target.closest('.page-head-inner')) closeAlbumsPage();
  });
  $('btn-info').addEventListener('click', toggleInfo);

  /*
   * 点面板以外的地方就关掉它（图片信息、设置都适用）。
   *
   * 用 pointerdown + 捕获阶段：比 click 早一步，切换面板时不会出现
   * 「先开新的、又被旧面板的关闭逻辑带一下」这类错位。
   * 但两个开关按钮必须放过 —— 否则「点开关想关面板」会先被这里关掉、
   * 紧接着开关的 click 又把它打开，看起来像点了没反应。
   */
  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (event.button !== 0) return;      // 只处理左键：右键要弹菜单，中键要滚动

    if (state.infoOpen && !els.info.contains(target) && !target.closest('#btn-info')) {
      closeInfo();
    }
    if (state.settingsOpen && !els.settings.contains(target) && !target.closest('#btn-settings')) {
      closeSettings();
    }

    /*
     * 点了热键格子之后又去点别处 —— 必须退出录制态。
     *
     * 不退出的后果很隐蔽：录制态一直挂着，用户接下来随手按的任意一个键
     * （哪怕只是想按 Esc 关面板、按空格暂停）都会被存成热键，
     * 而他完全不知道发生了什么，之后只会觉得「怎么多了个奇怪的快捷键」。
     */
    if (recordingAction && !target.closest('#hotkey-list')) cancelHotkeyCapture();
  }, true);

  $('btn-filmstrip').addEventListener('click', async () => {
    const next = state.config.filmstrip === false;
    state.config = await window.wp.setConfig({ filmstrip: next });
    applyConfigToUI();
    if (next) updateFilmstrip(true);
    toast(next ? '已显示缩略图胶片条' : '已隐藏缩略图胶片条');
  });

  // ---- 顶栏「预览：xxx」：点开可以选预览哪一块屏 ----
  els.previewBadge.addEventListener('click', (event) => {
    event.stopPropagation();
    if (document.getElementById('preview-menu')) closePreviewMenu();
    else openPreviewMenu();
  });

  $('btn-next').addEventListener('click', () => command('next'));
  $('btn-prev').addEventListener('click', () => command('prev'));

  /* ---- 图片区按住左右拖 = 切换上/下一张 ---- */

  /*
   * 往左拖 = 下一张，往右拖 = 上一张。
   *
   * 判定收得比较紧：横向位移 ≥ 60px，且横向要大于纵向的 1.5 倍 —— 否则斜着拖一下
   * （用户本来可能在选文字或只是手抖）就会莫名切图。松手时位移不够就什么都不做。
   * 拖动过程中只换光标，不做跟手位移：图片层的 transform 被切换动画占着，硬抢会打架。
   *
   * 触摸板横向滑动也接上（大多数触控板会把双指左右滑发成 wheel 的 deltaX），
   * 但加 400ms 节流 —— 一次连续滑动会连发几十个事件。
   */
  {
    const SWIPE_MIN = 60;
    let swipe = null;
    let lastWheelAt = 0;

    els.stage.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // 面板里的拖动不算（那里面的路径要能选中）
      if (event.target.closest('#settings, #info, #bottombar, header')) return;
      swipe = { x: event.clientX, y: event.clientY, id: event.pointerId, hit: false };
    });

    els.stage.addEventListener('pointermove', (event) => {
      if (!swipe || event.pointerId !== swipe.id) return;
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      if (!swipe.hit && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) {
        swipe.hit = true;
        els.stage.classList.add('swiping');
      }
    });

    const endSwipe = (event) => {
      if (!swipe || event.pointerId !== swipe.id) return;
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      const hit = swipe.hit;
      swipe = null;
      els.stage.classList.remove('swiping');
      if (!hit) return;
      if (Math.abs(dx) < SWIPE_MIN) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
      command(dx < 0 ? 'next' : 'prev');
    };

    els.stage.addEventListener('pointerup', endSwipe);
    els.stage.addEventListener('pointercancel', () => {
      swipe = null;
      els.stage.classList.remove('swiping');
    });

    els.stage.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaX) < 30) return;
      if (Date.now() - lastWheelAt < 400) return;
      lastWheelAt = Date.now();
      command(event.deltaX > 0 ? 'next' : 'prev');
    }, { passive: true });
  }
  $('btn-play').addEventListener('click', () => command('toggle-play'));

  $('btn-apply').addEventListener('click', async () => {
    if (!state.previewId) { toast('还没有可用的频道', true); return; }
    const result = await window.wp.applyChannel(state.previewId);
    toast(result.ok
      ? `已写入系统壁纸（通道：${result.method}） → ${result.monitorLabel || '全部显示器'}`
      : `写入失败：${result.error}`, !result.ok);
  });

  // ---- 胶片条交互 ----
  els.filmTrack.addEventListener('click', (event) => {
    const item = event.target.closest('.film-item');
    if (!item) return;
    const index = Number(item.dataset.index);
    if (Number.isNaN(index) || index === state.index) return;
    goToIndex(index);
  });

  els.filmTrack.addEventListener('wheel', () => { film.holdUntil = Date.now() + 8000; }, { passive: true });
  els.filmTrack.addEventListener('pointerdown', () => { film.holdUntil = Date.now() + 8000; });

  els.filmPrev.addEventListener('click', () => filmPage(-1));
  els.filmNext.addEventListener('click', () => filmPage(1));
  els.filmJump.addEventListener('click', () => {
    film.holdUntil = 0;
    centerFilm(true);
  });

  // ---- 右键菜单（交给主进程弹原生菜单）----
  document.addEventListener('contextmenu', (event) => {
    if (!state.config || state.config.contextMenu === false) return;
    // 面板里保留系统默认菜单：那里面的路径是需要能选中复制的
    if (event.target.closest('#settings, #info')) return;

    const filmItem = event.target.closest('.film-item');
    let imagePath = null;
    let index = null;

    if (filmItem) {
      index = Number(filmItem.dataset.index);
      imagePath = filmItem.dataset.path;
    } else {
      const entry = state.files[state.index];
      if (entry) { imagePath = entry.path; index = state.index; }
    }
    if (!imagePath) return;

    event.preventDefault();
    window.wp.showImageMenu({ path: imagePath, channelId: state.previewId, index });
  });

  // ESC 关闭面板时打不到 input 上，这里统一放行
  /*
   * 唤醒工具栏。用 pointerdown 而不是 mousedown：触摸屏和触控笔不会发 mousedown，
   * 而触摸屏上又没有「鼠标移动」这个动作 —— 只用 mousemove + mousedown 的话，
   * 工具栏一旦自动隐藏，手指就再也叫不回来了（点一下都不行）。
   */
  document.addEventListener('mousemove', pokeBars);
  document.addEventListener('pointerdown', pokeBars);

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement) return;

    switch (event.key) {
      case 'ArrowRight': command('next'); break;
      case 'ArrowLeft': command('prev'); break;
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        command('toggle-play');
        break;
      case 'f':
      case 'F':
      case 'F11':
        event.preventDefault();
        window.wp.toggleFullscreen();
        break;
      case 'Escape':
        closeAlbumsPage();
        closeSettings();
        closeInfo();
        break;
      default:
        break;
    }
  });

  window.wp.onMenuAction((action) => {
    switch (action) {
      case 'pick-folder': $('btn-pick').click(); break;
      case 'rescan': $('btn-rescan').click(); break;
      case 'prev': command('prev'); break;
      case 'next': command('next'); break;
      case 'toggle-play': command('toggle-play'); break;
      case 'apply-now': $('btn-apply').click(); break;
      case 'toggle-fullscreen': window.wp.toggleFullscreen(); break;
      case 'toggle-settings': toggleSettings(); break;
      case 'toggle-filmstrip': $('btn-filmstrip').click(); break;
      case 'toggle-info': toggleInfo(); break;
      case 'open-quick-folders': {
        openSettings();
        $('quick-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
      default: break;
    }
  });

  // 主进程每次推进都会广播 tick —— 这是唯一的画面驱动源
  window.wp.onChannelTick(onTick);

  window.wp.onChannelsChanged((payload) => {
    applyChannelInfo(payload || {});
  });

  /**
   * 主进程按「切到下一台显示器」热键时，把预览切过去。
   * 主进程已经改过它自己的 currentPreviewId，这里跟着切才不会有「热键在 A 屏、界面在看 B 屏」的漂移。
   */
  window.wp.onPreviewSelect((payload) => {
    const id = payload && payload.id;
    if (!id) return;
    setPreview(id);
  });

  window.wp.onMonitorsChanged(async () => {
    await refreshChannelInfo();
    toast(`显示器配置已变化，当前检测到 ${state.channels.length} 路`);
  });

  // 主进程自动打开了「每屏独立」—— 说一声，并让设置面板的开关跟着变
  window.wp.onAutoMonitorSetup(async (payload) => {
    await refreshChannelInfo();
    if (state.settingsOpen) applyConfigToUI();
    toast(`检测到 ${(payload && payload.monitors) || state.channels.length} 块显示器，已自动开启每屏独立`);
  });

  window.wp.onNotice((payload) => {
    if (payload && payload.text) toast(payload.text, Boolean(payload.error));
  });

  window.wp.onFilesChanged((payload) => {
    if (payload && payload.dest) state.metaCache.clear();
  });

  window.wp.onInfoOpen((payload) => {
    if (payload && payload.path) openInfo(payload.path);
  });

  window.wp.onQuickFoldersChanged((payload) => {
    if (payload && payload.folders) {
      state.quickFolders = payload.folders;
      renderQuickFolders();
    }
  });

  /**
   * 相簿被主进程改了（folder:pick 建相簿 / album:update / album:delete）。
   * 列表、统一模式的下拉、频道卡片里的下拉都要跟着刷新；
   * 卡片重绘有滑块焦点保护，正常改动不会打断正在进行的调整。
   */
  window.wp.onAlbumsChanged((payload) => {
    if (!payload || !Array.isArray(payload.albums)) return;
    state.albums = payload.albums;
    renderAlbums();
    syncAlbumSelect();
    renderCards();
    updateBadges();
  });

  window.wp.onLaunchAtLoginChanged(() => refreshTrayState());

  /** 用户在删除确认框里勾了「不再询问」，把设置里的开关同步过来 */
  window.wp.onConfirmDeleteChanged((payload) => {
    const on = payload ? payload.confirmDelete !== false : false;
    state.config.confirmDelete = on;
    $('cfg-confirm-delete').checked = on;
  });

  // 拉取最新频道状态（供外部测试脚本与手动刷新共用）
  window.__refreshChannels = refreshChannelInfo;

  /**
   * 重新读一遍配置并回填界面。
   *
   * 界面上看到的开关状态来自 `state.config`，而它只在页面启动和本地保存时刷新；
   * 如果配置是主进程那边改的（比如确认框里勾了「不再询问」之外的场景），
   * 界面就会停在旧值上。测试脚本也需要它来确认「界面确实跟着配置走」。
   */
  window.__reloadConfig = async () => {
    state.config = await window.wp.getConfig();
    applyConfigToUI();
    return state.config;
  };
  window.__rendererState = () => ({
    previewId: state.previewId,
    perMonitor: state.perMonitor,
    index: state.index,
    count: state.files.length,
    playing: state.playing,
    played: [...state.played].sort((a, b) => a - b),
    currentName: state.files[state.index] ? state.files[state.index].name : null,
    activeLayer: state.active,
    channelIds: state.channels.map((c) => c.id),
    filmstrip: {
      enabled: state.config ? state.config.filmstrip !== false : false,
      nodes: film.els.size,
      window: film.window,
      currentInDom: film.els.has(state.index),
      scrollLeft: els.filmTrack.scrollLeft,
      firstIndex: film.first,
      lastIndex: film.last - 1,
    },
    infoOpen: state.infoOpen,
    infoPath: state.infoPath,
    quickFolders: state.quickFolders.length,
  });
}

/* ------------------------------------------------------------ 启动 */

async function init() {
  state.config = await window.wp.getConfig();
  applyConfigToUI();
  bindSettings();
  bindEvents();
  pokeBars();

  await refreshChannelInfo();
  await refreshQuickFolders();
  await refreshAlbums();
  updatePlayIcon();
}

init();
