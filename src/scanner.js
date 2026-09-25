'use strict';

/**
 * 图片目录扫描。
 *
 * 对照原 Python 版 get_image_files()：
 *   Python 用 os.walk 同步遍历 → 这里用 fs.promises 异步遍历，
 *   并且**不在扫描阶段统计文件大小**（5000 张图逐个 stat 会明显拖慢首屏），
 *   体积/分辨率改为按需探测（probeImage）。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.bmp',
  '.webp', '.gif', '.avif', '.tif', '.tiff',
]);

/** 阶段 4：视频壁纸（Chromium 原生能解的容器；mkv/avi 不保证，先不放行） */
const VIDEO_EXT = new Set(['.mp4', '.webm']);

/** 阶段 5：网页壁纸（目录里丢一个 html 就能当壁纸） */
const DOC_EXT = new Set(['.html', '.htm']);

/** 条目类型：渲染端据此决定画 canvas / 起视频 / 嵌 iframe */
function kindFor(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (DOC_EXT.has(ext)) return 'html';
  return 'image';
}

/**
 * 排序器只建一次。
 * 十万张图规模下，逐次调用 String.prototype.localeCompare 会重新构造 Collator，
 * 实测能吃掉整个扫描流程一大半时间；缓存成常量后排序开销降一个数量级。
 */
const COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/**
 * @param {string} folder 起始目录
 * @param {{recursive?:boolean, maxDepth?:number, limit?:number}} [options]
 * @returns {Promise<{files:Array<{path:string,name:string,ext:string}>, truncated:boolean}>}
 */
async function scanFolder(folder, options = {}) {
  const { recursive = true, maxDepth = 8, limit = 200000 } = options;
  const out = [];
  const stack = [{ dir: folder, depth: 0 }];
  let truncated = false;

  while (stack.length > 0) {
    if (out.length >= limit) { truncated = true; break; }

    const { dir, depth } = stack.pop();

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 权限不足或目录已消失，跳过
    }

    for (const entry of entries) {
      // 上限必须在内层也判断，否则一个装了几万张图的大目录会直接突破上限
      if (out.length >= limit) { truncated = true; break; }

      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (recursive && depth < maxDepth) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext) || DOC_EXT.has(ext)) {
          out.push({ path: full, name: entry.name, ext });
        }
      }
    }
  }

  out.sort((a, b) => COLLATOR.compare(a.name, b.name));
  return { files: out, truncated };
}

/** 按需读取单张图的大小与修改时间 */
async function probeFile(filePath) {
  try {
    const st = await fs.stat(filePath);
    return { size: st.size, mtime: st.mtimeMs, exists: true };
  } catch {
    return { size: 0, mtime: 0, exists: false };
  }
}

module.exports = { scanFolder, probeFile, IMAGE_EXT, VIDEO_EXT, DOC_EXT, kindFor };
