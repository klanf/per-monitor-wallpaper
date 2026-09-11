'use strict';

/**
 * README 预览渲染器。
 *
 * 用途：把 README.md 渲染成一份可直接在浏览器 / Electron 里打开的 HTML，
 * 用来核对 Markdown 的真实渲染结果（表格、代码块、图片、锚点）。
 *
 * 设计取舍：
 *   · 零依赖 —— 只覆盖 README 实际用到的 Markdown 子集，不引入 marked 之类的大包；
 *   · 本地图片一律内联成 data URI —— 预览文件可以放在任意位置都不掉图；
 *   · shields.io 徽章替换为等价的本地 SVG —— 离线时不会渲染成破损图标，
 *     保证预览结果稳定可复现（README 原文里的远程徽章不受影响）。
 *
 * 用法：node tools/render-readme.js [输出路径]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'README.md');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'tmp', 'readme-preview.html'));

/* ------------------------------------------------------------------ 工具 */

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 标题 → 锚点 id。规则与 GitHub 一致：小写、去标点、空格转连字符（中文原样保留） */
function slug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/** 本地图片 → data URI；读不到则原样返回（渲染时会被检出为破损图） */
function inlineImage(src) {
  if (/^https?:/i.test(src) || src.startsWith('data:')) return src;
  const file = path.resolve(ROOT, src);
  try {
    const buf = fs.readFileSync(file);
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return src;
  }
}

/**
 * shields.io 徽章 → 本地等价 SVG。
 *
 * 只做预览替换，目的是让渲染结果不依赖网络；文本与配色取自 README 原文。
 */
const BADGE_STYLE = {
  '0078D6': '#0078D6',
  '47848F': '#47848F',
  '339933': '#339933',
  blue: '#007ec6',
};

function localBadge(src, alt) {
  const m = /shields\.io\/badge\/([^?]*)/.exec(src);
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split('-');
  const color = parts.pop() || 'blue';
  const text = parts.join('-');
  const [left, right] = text.split('_');
  const fill = BADGE_STYLE[color] || color;
  const rightW = Math.max(46, [...(right || '')].length * 7.4 + 16);
  const leftW = Math.max(46, [...(left || '')].length * 7.4 + 16);
  const total = leftW + rightW;
  return `<svg class="badge" xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(alt || text)}">`
    + `<title>${esc(alt || text)}</title>`
    + `<rect width="${leftW}" height="20" fill="#555"/>`
    + `<rect x="${leftW}" width="${rightW}" height="20" fill="${fill}"/>`
    + `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">`
    + `<text x="${leftW / 2}" y="14">${esc(left || '')}</text>`
    + `<text x="${leftW + rightW / 2}" y="14">${esc(right || '')}</text>`
    + `</g></svg>`;
}

/* -------------------------------------------------------------- 行内解析 */

function inline(text) {
  const codes = [];
  // 先把行内代码抽走，避免其中的 ** 或 [] 被当成语法
  let s = String(text).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = esc(s);

  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    const badge = localBadge(src, alt);
    if (badge) return badge;
    return `<img src="${inlineImage(src)}" alt="${alt}">`;
  });

  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) =>
    `<a href="${href}">${label}</a>`);

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)])}</code>`);
  return s;
}

/* ------------------------------------------------------------------ 块解析 */

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function render(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码围栏
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || 'text';
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre class="code" data-lang="${esc(lang)}"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 水平分隔线
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    // 标题
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      const level = head[1].length;
      const text = head[2].trim();
      const id = slug(text);
      out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}">#</a>${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    // 表格：当前行以 | 开头，且下一行是分隔行
    if (line.trim().startsWith('|') && i + 1 < lines.length
        && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        if (/^:-+:$/.test(t)) return 'center';
        if (/^-+:$/.test(t)) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const cell = (c, idx) =>
        `<${idx === 0 ? 'th' : 'td'} style="text-align:${aligns[idx] || 'left'}">${inline(c)}</${idx === 0 ? 'th' : 'td'}>`;
      const thead = `<thead><tr>${header.map((c) => cell(c, 0)).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c, idx) => cell(c, idx)).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i += 1;
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    // 空行
    if (line.trim() === '') { i += 1; continue; }

    // 段落
    const buf = [];
    while (i < lines.length && lines[i].trim() !== ''
           && !/^(#{1,6}\s|```|>|[-*]\s|\d+\.\s|---+\s*$)/.test(lines[i])
           && !lines[i].trim().startsWith('|')) {
      buf.push(lines[i]);
      i += 1;
    }
    if (buf.length) out.push(`<p>${inline(buf.join(' '))}</p>`);
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ 样式 */

const CSS = `
:root{--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--soft:#f6f8fa;--link:#0969da;--accent:#cf222e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.7 -apple-system,"Segoe UI","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;}
.wrap{max-width:1000px;margin:0 auto;padding:40px 32px 96px}
h1,h2,h3{line-height:1.3;font-weight:600}
h1{font-size:2em;margin:.3em 0 .5em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
h2{font-size:1.5em;margin:2em 0 .6em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
h3{font-size:1.17em;margin:1.6em 0 .5em}
p{margin:.9em 0}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
hr{border:0;border-top:1px solid var(--line);margin:2.4em 0}
.anchor{float:left;margin-left:-1.1em;color:var(--muted);opacity:0;font-weight:400}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor{opacity:1}
img{max-width:100%;display:block;margin:1em 0;border-radius:6px}
img.badge{display:inline-block;margin:0 4px 0 0;border-radius:3px;vertical-align:middle}
blockquote{margin:1em 0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--line)}
blockquote p{margin:.5em 0}
ul,ol{padding-left:1.9em;margin:.9em 0}
li{margin:.3em 0}
code{background:var(--soft);padding:.2em .4em;border-radius:4px;
  font:85%/1.5 "Cascadia Mono",Consolas,"Courier New",monospace}
pre.code{position:relative;background:var(--soft);border:1px solid var(--line);border-radius:6px;
  padding:14px 16px;overflow:auto;margin:1em 0}
pre.code code{background:none;padding:0;font-size:13.5px;line-height:1.6;white-space:pre}
pre.code[data-lang]::after{content:attr(data-lang);position:absolute;top:8px;right:12px;
  color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.table-wrap{overflow-x:auto;margin:1.1em 0}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th,td{border:1px solid var(--line);padding:7px 12px;vertical-align:top}
th{background:var(--soft);font-weight:600}
tbody tr:nth-child(2n){background:#fbfcfd}
.banner{background:#fff8e5;border:1px solid #e6c65c;border-radius:6px;padding:10px 14px;
  color:#6b5518;font-size:13.5px;margin:0 0 28px}
.banner b{color:#4a3a0d}
.broken{outline:2px dashed var(--accent);outline-offset:2px}
`;

/* ------------------------------------------------------------------ 主流程 */

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到 ${SRC}`);
    process.exit(1);
  }
  const markdown = fs.readFileSync(SRC, 'utf8');
  const body = render(markdown);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>README 渲染预览 · 壁纸切换器</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<div class="banner">这是 <b>README.md</b> 的真实渲染预览（由 <b>tools/render-readme.js</b> 生成）。
本地图片已内联，shields.io 徽章替换为等价的本地 SVG，因此离线也能看到完整效果。</div>
${body}
</div>
</body>
</html>`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');

  const stat = fs.statSync(OUT);
  console.log(`已生成: ${OUT}`);
  console.log(`体积: ${(stat.size / 1024).toFixed(1)} KB`);
}

main();
