'use strict';

/**
 * 在 Windows 的系统文件里搜字符串（UTF-16LE），用来定位某句界面文案属于哪个组件。
 *
 *   node tools/_probe-winstrings.js "要搜的文字" [搜索目录...]
 *
 * 默认搜 C:\Windows\System32 下的 .mui（本地化文案都在这儿）。
 */

const fs = require('node:fs');
const path = require('node:path');

const needle = process.argv[2];
if (!needle) { console.error('用法：node tools/_probe-winstrings.js "文字" [目录...]'); process.exit(2); }

const dirs = process.argv.slice(3).length ? process.argv.slice(3) : [
  'C:\\Windows\\System32\\zh-CN',
  'C:\\Windows\\System32',
  'C:\\Windows\\SystemResources',
];

// 同时搜 UTF-16LE 和 UTF-8 / GBK 附近的形式
const patterns = [
  Buffer.from(needle, 'utf16le'),
];

const MAX_SIZE = 40 * 1024 * 1024;
let scanned = 0, hits = [];

function walk(dir, depth) {
  if (depth > 3) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!/\.(mui|dll|exe|msc|cpl)$/i.test(e.name)) continue;
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.size === 0 || st.size > MAX_SIZE) continue;
    let buf;
    try { buf = fs.readFileSync(p); } catch { continue; }
    scanned += 1;
    for (const pat of patterns) {
      if (buf.includes(pat)) {
        const at = buf.indexOf(pat);
        // 取上下文看看
        const ctx = buf.subarray(Math.max(0, at - 80), at + pat.length + 80)
          .toString('utf16le').replace(/[\u0000-\u001f]+/g, '·').trim();
        hits.push({ file: p, size: st.size, ctx: ctx.slice(0, 160) });
        break;
      }
    }
  }
}

console.log(`搜索「${needle}」（UTF-16LE），目录：${dirs.join(' , ')}\n`);
for (const d of dirs) walk(d, 0);

console.log(`扫描 ${scanned} 个文件，命中 ${hits.length} 处\n`);
for (const h of hits) {
  console.log(`· ${h.file}  (${(h.size / 1024).toFixed(0)} KB)`);
  console.log(`    …${h.ctx}…\n`);
}
