'use strict';

/**
 * 动态桌面的原图协议 `wpimg://`。
 *
 * 【为什么必须有它】
 *   主窗口渲染层现在只吃 `wpthumb://` 的 256px 缩略图（app.js 头注释明说不加载原图）
 *   —— 预览窗够用，但动态桌面的舞台是**全屏物理像素**，256px 放上去就是马赛克。
 *   而让 <img> 直接吃 `file://` 又要手工处理中文路径转义和来源控制；
 *   项目里已有成熟的「路径编码进 URL」方案（wpthumb://），照抄一份成本最低。
 *
 * 【与 wpthumb:// 的两个关键差别】
 *   1. **绝不缓存**（Cache-Control: no-store）：缩略图是几 KB 的小 JPEG，
 *      Chromium 磁盘缓存利大于弊；原图动辄几十 MB，而 Chromium 的磁盘缓存默认
 *      在 C 盘（用户在意 SSD 寿命）—— 图源就在本地磁盘上，缓存它纯属浪费 SSD。
 *   2. **零加工**：不生成、不落盘，直接把原文件字节流回去。
 *
 * 【流式】
 *   用 createReadStream 而不是 readFile：8K 图几十 MB，不值得先整块读进主进程堆
 *   再交给 Response。Range 支持等阶段 4（视频 mp4）要播流时再加，静态图用不到。
 */

const { protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SCHEME = 'wpimg';

/** 与 scanner.js 的 IMAGE_EXT / thumbnails.js 的 MIME 保持同一集合 */
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
  '.png': 'image/png', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  // 阶段 4/5：视频与网页
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.html': 'text/html', '.htm': 'text/html',
};

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 路径 → URL 安全的 token（编码必须与 preload.js 的 stageUrl 对应：UTF-16LE） */
function encodePath(imagePath) {
  return Buffer.from(imagePath, 'utf16le').toString('base64url');
}

function decodePath(token) {
  return Buffer.from(token, 'base64url').toString('utf16le');
}

/** 给渲染层的原图 URL（主进程侧用；渲染层走 preload 暴露的同名方法） */
function stageUrl(imagePath) {
  return `${SCHEME}://img/${encodePath(imagePath)}`;
}

/** 必须在 app ready 之前调用 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true, secure: true, supportFetchAPI: true, stream: true,
      // 关键：stage 页面源是 file://，对 wpimg 的 fetch 是跨源请求 —— 没有这一项
      // Chromium 直接拒掉（实测 Failed to fetch，ACAO 响应头都轮不到看）
      corsEnabled: true,
    },
  }]);
}

/** 必须在 app ready 之后调用 */
function handleProtocol() {
  protocol.handle(SCHEME, (request) => {
    let imagePath;
    try {
      const url = new URL(request.url);
      imagePath = decodePath(url.pathname.replace(/^\/+/, ''));
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!imagePath) return new Response('missing path', { status: 400 });

    // 只放行图片扩展名。路径来自调度器的 tick（可信），这一层只是把
    // 「传错参数」从 500 变成明确的 415；阶段 4 接视频时在这里扩集合。
    if (!MIME[path.extname(imagePath).toLowerCase()]) {
      return new Response('unsupported type', { status: 415 });
    }

    let stat;
    try {
      stat = fs.statSync(imagePath);
    } catch (err) {
      return new Response(`not found: ${err.code || err.message}`, { status: 404 });
    }
    if (!stat.isFile()) return new Response('not a file', { status: 404 });

    // Range（阶段 4：<video> 的循环/seek 靠它，免得每次循环都全量重拉）
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const extraHeaders = {};
    const range = request.headers.get('range');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          // 后缀形式 bytes=-N：最后 N 字节
          const n = Math.min(parseInt(m[2], 10), stat.size);
          start = stat.size - n;
          end = stat.size - 1;
        } else {
          start = parseInt(m[1], 10);
          end = m[2] !== '' ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        }
        if (start > end || start >= stat.size) {
          return new Response('range not satisfiable', {
            status: 416,
            headers: { 'content-range': `bytes */${stat.size}` },
          });
        }
        status = 206;
        extraHeaders['content-range'] = `bytes ${start}-${end}/${stat.size}`;
      }
    }

    const stream = fs.createReadStream(imagePath, { start, end });
    // 流出错时若响应头已发出就无法改状态码了 —— 记日志即可；
    // 正常情况下渲染层只会请求调度器刚验过存活的文件（_seekLiveEntry 已摘掉死条目）
    stream.on('error', (err) => {
      console.warn('[stage-protocol] 读取失败:', imagePath, err.message);
    });

    return new Response(stream, {
      status,
      headers: {
        'content-type': mimeFor(imagePath),
        // 关键：绝不进 Chromium 磁盘缓存（默认在 C 盘）。见文件头注释
        'cache-control': 'no-store',
        // stage 页面源是 file://（origin=null），fetch 跨源取本协议时会被 CORS 拦死
        // （实测：Failed to fetch）。img 标签不受限，但我们要 fetch→createImageBitmap，
        // 所以必须放行任意源 —— 本协议只回本地文件字节，源头放行没有风险面。
        'access-control-allow-origin': '*',
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'last-modified': stat.mtime.toUTCString(),
        ...extraHeaders,
      },
    });
  });
}

module.exports = {
  SCHEME,
  registerScheme,
  handleProtocol,
  stageUrl,
  encodePath,
  decodePath,
};
