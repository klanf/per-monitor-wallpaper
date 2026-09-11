'use strict';

/**
 * 缩略图服务 + 自定义协议。
 *
 * 【为什么需要它】
 *   胶片条一屏要显示几十张缩略图。如果直接让 <img> 去加载原图：
 *   8K 的 JPEG 解码一次要 200–400 ms / 约 95 MB 内存，60 张就是「几秒白屏 + 一个 G 内存」。
 *   原 Python 版用的是 PIL 的 draft() 模式 + 磁盘缩略图缓存，思路是对的。
 *
 * 【这里怎么做】
 *   走 Electron 的 nativeImage.createThumbnailFromPath —— 它在 Windows 上底层是
 *   IShellItemImageFactory（就是资源管理器图标/缩略图那一套），特点是：
 *     · 不把像素解进 JS 堆，不占主进程内存；
 *     · 保持宽高比（实测：横图 256×181，竖图 145×256）；
 *     · 命中系统缩略图缓存后约 6 ms。
 *   生成结果按「路径 + mtime + 尺寸」哈希落盘，之后直接读盘返回。
 *
 * 【为什么用自定义协议而不是 IPC 传 base64】
 *   走协议的话 <img src="wpthumb://..."> 是浏览器原生加载：
 *   自带磁盘缓存、并行请求、loading="lazy" 是真的懒加载。
 *   走 IPC 则要手动管理并发、序列化，还要把 JPEG 编成 base64 多付 33% 体积。
 */

const { app, nativeImage, protocol } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const SCHEME = 'wpthumb';

/** 生成尺寸：比胶片条实际显示尺寸（高度 64 CSS px）大得多，兼顾高 DPI 与悬停放大 */
const THUMB_SIZE = 256;

/** 缓存文件数上限，超出后按 mtime 淘汰到 80% */
const MAX_CACHE_FILES = 30000;

/** 同时进行的缩略图生成数。串行会让胶片条加载很慢，放开又会打满 shell 缩略图线程 */
const MAX_CONCURRENT = 6;

let cacheDir = null;
let thumbSize = THUMB_SIZE;
let ready = false;

/** 同一文件的并发请求合并成一个 Promise */
const inflight = new Map();

const queue = [];
let active = 0;

let hits = 0;
let misses = 0;
let failures = 0;

/* ---------------------------------------------------------------- 工具 */

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
  '.png': 'image/png', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function cacheKey(imagePath, mtimeMs, size, bytes) {
  return crypto.createHash('sha1')
    .update(`${imagePath}|${Math.round(mtimeMs)}|${size}|${bytes}`)
    .digest('hex');
}

/** 路径 → URL 安全的 token（中文、空格、盘符都不会出问题） */
function encodePath(imagePath) {
  return Buffer.from(imagePath, 'utf16le').toString('base64url');
}

function decodePath(token) {
  return Buffer.from(token, 'base64url').toString('utf16le');
}

/** 给渲染层的缩略图 URL */
function thumbUrl(imagePath) {
  return `${SCHEME}://t/${encodePath(imagePath)}`;
}

/* ---------------------------------------------------------------- 并发闸门 */

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    active += 1;
    job.task()
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/* ---------------------------------------------------------------- 生成与缓存 */

function subdirFor(key) {
  return path.join(cacheDir, key.slice(0, 2));
}

async function readCached(key) {
  try {
    const buf = await fsp.readFile(path.join(subdirFor(key), `${key}.jpg`));
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

async function writeCached(key, buf) {
  try {
    const dir = subdirFor(key);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${key}.jpg`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, target);
  } catch { /* 缓存写失败不影响本次返回 */ }
}

/**
 * 取缩略图字节。
 * @returns {Promise<{buffer:Buffer, type:string, source:'cache'|'generated'|'original'}>}
 */
async function fetchThumb(imagePath) {
  const merged = inflight.get(imagePath);
  if (merged) return merged;

  const task = (async () => {
    let stat;
    try {
      stat = await fsp.stat(imagePath);
    } catch (err) {
      throw new Error(`文件不可读: ${err.code || err.message}`);
    }
    if (!stat.isFile()) throw new Error('不是文件');

    const key = cacheKey(imagePath, stat.mtimeMs, thumbSize, stat.size);
    const cached = await readCached(key);
    if (cached) {
      hits += 1;
      return { buffer: cached, type: 'image/jpeg', source: 'cache' };
    }

    misses += 1;

    // 1) 首选系统缩略图
    try {
      const img = await nativeImage.createThumbnailFromPath(imagePath, {
        width: thumbSize, height: thumbSize,
      });
      if (img && !img.isEmpty()) {
        const buf = img.toJPEG(82);
        if (buf && buf.length) {
          writeCached(key, buf);           // 不 await：返回不等落盘
          return { buffer: buf, type: 'image/jpeg', source: 'generated' };
        }
      }
    } catch { /* 落到下面的回退 */ }

    // 2) 回退：直接回原图。
    //    shell 缩略图不支持的格式（avif / 部分 tiff）会走到这里，
    //    代价是 <img> 自己解码原图 —— 但要好过胶片条上开天窗。
    try {
      const buf = await fsp.readFile(imagePath);
      failures += 1;
      return { buffer: buf, type: mimeFor(imagePath), source: 'original' };
    } catch (err) {
      throw new Error(`缩略图与原图都读不到: ${err.message}`);
    }
  })();

  inflight.set(imagePath, task);
  try {
    return await schedule(() => task);
  } finally {
    inflight.delete(imagePath);
  }
}

/* ---------------------------------------------------------------- 缓存维护 */

async function walkCache() {
  const out = [];
  let dirs = [];
  try {
    dirs = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(cacheDir, d.name);
    let files = [];
    try { files = await fsp.readdir(sub); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jpg')) continue;
      const full = path.join(sub, f);
      try {
        const st = await fsp.stat(full);
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* ignore */ }
    }
  }
  return out;
}

async function pruneCache() {
  const files = await walkCache();
  if (files.length <= MAX_CACHE_FILES) return { removed: 0, kept: files.length };

  files.sort((a, b) => a.mtimeMs - b.mtimeMs);         // 最旧的先淘汰
  const target = Math.floor(MAX_CACHE_FILES * 0.8);
  const doomed = files.slice(0, files.length - target);
  let removed = 0;
  for (const f of doomed) {
    try { await fsp.unlink(f.path); removed += 1; } catch { /* ignore */ }
  }
  return { removed, kept: files.length - removed };
}

async function clearCache() {
  try { await fsp.rm(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await fsp.mkdir(cacheDir, { recursive: true }); } catch { /* ignore */ }
}

async function stats() {
  const files = await walkCache();
  let bytes = 0;
  for (const f of files) bytes += f.size;
  return {
    dir: cacheDir,
    size: thumbSize,
    files: files.length,
    bytes,
    mb: Math.round(bytes / 1048576 * 10) / 10,
    hits, misses, failures,
    maxFiles: MAX_CACHE_FILES,
  };
}

/* ---------------------------------------------------------------- 协议 */

/** 必须在 app ready 之前调用 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

/**
 * @param {{dir?:string, size?:number}} [options]
 *        dir 缺省时用 userData/thumbs（用户可在配置里改到别的盘）
 */
function configure(options = {}) {
  cacheDir = options.dir || path.join(app.getPath('userData'), 'thumbs');
  thumbSize = Number(options.size) > 0 ? Math.round(Number(options.size)) : THUMB_SIZE;
  ready = true;
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* ignore */ }
  return { dir: cacheDir, size: thumbSize };
}

/** 必须在 app ready 之后调用 */
function handleProtocol() {
  protocol.handle(SCHEME, async (request) => {
    if (!ready) return new Response('缩略图服务未就绪', { status: 503 });

    let imagePath;
    try {
      const url = new URL(request.url);
      imagePath = decodePath(url.pathname.replace(/^\/+/, ''));
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!imagePath) return new Response('missing path', { status: 400 });

    try {
      const result = await fetchThumb(imagePath);
      return new Response(result.buffer, {
        status: 200,
        headers: {
          'content-type': result.type,
          'cache-control': 'public, max-age=600',
          'x-thumb-source': result.source,
        },
      });
    } catch (err) {
      console.warn('[thumbnails] 生成失败:', imagePath, err.message);
      return new Response('thumbnail failed', { status: 404 });
    }
  });
}

module.exports = {
  SCHEME,
  registerScheme,
  handleProtocol,
  configure,
  thumbUrl,
  encodePath,
  decodePath,
  fetchThumb,
  pruneCache,
  clearCache,
  stats,
};
