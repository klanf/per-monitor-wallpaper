'use strict';

/**
 * 找出目录里「内容相同但路径不同」的图片。
 *
 * 为什么需要它：轮播偶尔「重复加载同一张图片」时，现象可能是
 *   ① 预览区同一张图重新淡入  ② 胶片条两张缩略图一模一样  ③ 桌面连着两轮挂同一张
 * 这三件事同时出现，说明**同一张图被当成了列表里两个不同序号**。
 * 来源只有两种，本脚本两种都能查：
 *   · 磁盘层面：同一份内容有两个名字（复制/下载重复），或是 junction/symlink
 *     让同一棵子树被遍历了两遍
 *   · 程序层面：扫描器把同一个文件列了两次（dupCount 会 > 0）
 *
 * 算法：先按**体积**分组 —— 字节完全相同必然体积相同，体积唯一的文件直接排除，
 * 这样只需要对少数候选做完整哈希。30348 个文件里真正要读内容的通常只有几十个。
 *
 *   node tools/find-duplicates.js <目录> [--recursive] [--json 输出路径] [--md 输出路径]
 *
 * --md 会输出一份可直接照着删的 Markdown 清单（按浪费空间从大到小排）。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.bmp', '.webp', '.gif', '.avif', '.tif', '.tiff',
]);

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--json' && args[args.indexOf(a) - 1] !== '--md');
const recursive = args.includes('--recursive');
const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const mdAt = args.includes('--md') ? args[args.indexOf('--md') + 1] : null;

if (!root) {
  console.error('用法：node tools/find-duplicates.js <目录> [--recursive] [--json 输出路径] [--md 输出路径]');
  process.exit(2);
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/** 收集文件，并记录遇到的符号链接 / junction */
async function walk(dir, out, links, depth = 0) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    out.errors.push(`${dir}: ${err.code || err.message}`);
    return;
  }

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      links.push(full);
      continue;                                   // 不跟进链接：跟进就会重复遍历
    }
    if (e.isDirectory()) {
      if (recursive) await walk(full, out, links, depth + 1);
      continue;
    }
    if (!e.isFile()) continue;
    if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    try {
      const st = await fsp.stat(full);
      out.files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    } catch { /* 读不到就跳过 */ }
  }
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

(async () => {
  const started = Date.now();
  const out = { files: [], errors: [] };
  const links = [];

  console.log(`扫描 ${root}（recursive=${recursive}）…`);
  await walk(root, out, links);

  const totalBytes = out.files.reduce((a, f) => a + f.size, 0);
  console.log(`图片 ${out.files.length} 个 / ${(totalBytes / 1073741824).toFixed(2)} GB  ` +
    `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // ① 同一路径出现两次（扫描器层面的重复）
  const byPath = new Map();
  for (const f of out.files) {
    const k = f.path.toLowerCase();
    byPath.set(k, (byPath.get(k) || 0) + 1);
  }
  const dupPaths = [...byPath.entries()].filter(([, n]) => n > 1);

  // ② 按体积分组：只有同体积才可能是同一份内容
  const bySize = new Map();
  for (const f of out.files) {
    if (f.size === 0) continue;
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const sameSizeGroups = [...bySize.entries()].filter(([, g]) => g.length > 1);
  const candidateFiles = sameSizeGroups.reduce((a, [, g]) => a + g.length, 0);

  console.log(`\n同体积候选：${sameSizeGroups.length} 组 / ${candidateFiles} 个文件  ` +
    `（体积唯一的 ${out.files.length - candidateFiles} 个直接排除）`);

  // ③ 只对候选做完整哈希
  const byHash = new Map();
  let hashed = 0;
  for (const [, group] of sameSizeGroups) {
    for (const f of group) {
      try {
        const h = await sha256(f.path);
        hashed += 1;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(f);
      } catch (err) {
        out.errors.push(`哈希失败 ${f.path}: ${err.message}`);
      }
    }
  }
  const dups = [...byHash.values()].filter((g) => g.length > 1);
  const wastedBytes = dups.reduce((a, g) => a + g[0].size * (g.length - 1), 0);

  console.log(`\n===== 结果 =====`);
  console.log(`同一路径重复列出 : ${dupPaths.length} 处${dupPaths.length ? '（扫描器问题！）' : ''}`);
  dupPaths.slice(0, 5).forEach(([p, n]) => console.log(`   ${n}× ${p}`));

  console.log(`符号链接 / junction : ${links.length} 个${links.length ? '（不会重复遍历，已跳过）' : ''}`);
  links.slice(0, 10).forEach((l) => console.log(`   ${l}`));

  console.log(`内容完全相同的分组 : ${dups.length} 组，涉及 ${dups.reduce((a, g) => a + g.length, 0)} 个文件，` +
    `浪费 ${(wastedBytes / 1048576).toFixed(1)} MB`);
  const top = dups.sort((a, b) => b[0].size - a[0].size).slice(0, 8);
  for (const g of top) {
    console.log(`   ${g.length} 份 × ${(g[0].size / 1024).toFixed(0)} KB`);
    g.slice(0, 4).forEach((f) => console.log(`      ${f.path}`));
    if (g.length > 4) console.log(`      …还有 ${g.length - 4} 份`);
  }

  if (jsonAt) {
    const payload = {
      root, recursive, scanned: out.files.length, hashed,
      duplicatePaths: dupPaths.map(([p, n]) => ({ path: p, times: n })),
      symlinks: links,
      duplicateContentGroups: dups.map((g) => g.map((f) => f.path)),
      errors: out.errors,
    };
    fs.writeFileSync(jsonAt, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\n已写出 ${jsonAt}`);
  }

  if (mdAt) {
    const lines = [
      '# 内容完全相同的重复图片清单',
      '',
      `扫描目录：\`${root}\`${recursive ? '（含子目录）' : ''}`,
      '',
      `| 指标 | 数值 |`,
      `|---|---|`,
      `| 图片总数 | ${out.files.length} |`,
      `| 占用空间 | ${(totalBytes / 1073741824).toFixed(2)} GB |`,
      `| 同一路径重复列出 | ${dupPaths.length} 处 |`,
      `| 符号链接 / junction | ${links.length} 个 |`,
      `| **内容相同的重复组** | **${dups.length} 组 / ${dups.reduce((a, g) => a + g.length, 0)} 个文件** |`,
      `| **可回收空间** | **${mb(wastedBytes)}** |`,
      '',
      '## 为什么会有这个清单',
      '',
      '轮播时偶尔会「连着出现同一张图」—— 因为图库里同一张图存了两份（不同文件名），',
      '随机抽取时有一定概率先抽到 A 再抽到它的孪生兄弟 B。',
      '程序侧已经加了护栏（洗牌时避开体积相同的相邻候选，见 `src/scheduler.js` 的 `_avoidSizeTwin`），',
      '但要彻底干净，删掉多余的副本即可。',
      '',
      '## 建议做法',
      '',
      '每组里**保留一个、删掉其余**（内容完全一样，留哪个都行）。',
      '下面每组按路径长度排序，第一个通常命名更规范、更适合保留。',
      '删除前建议先在回收站里躺一阵子。',
      '',
    ];

    const sorted = dups.slice().sort((a, b) => (b.length - 1) * b[0].size - (a.length - 1) * a[0].size);
    sorted.forEach((g, i) => {
      const per = g.length - 1;
      lines.push(`### ${i + 1}. ${g.length} 份 × ${mb(g[0].size)}　可省 ${mb(g[0].size * per)}`);
      lines.push('');
      const byShortest = g.slice().sort((a, b) => a.path.length - b.path.length);
      byShortest.forEach((f, k) => {
        lines.push(`${k === 0 ? '保留' : '删除'}：\`${f.path}\``);
      });
      lines.push('');
    });

    fs.writeFileSync(mdAt, lines.join('\n'), 'utf8');
    console.log(`已写出 ${mdAt}`);
  }

  console.log(`\n总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
})().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(1);
});
