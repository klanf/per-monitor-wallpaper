#!/usr/bin/env node
'use strict';

/**
 * 桌面窗口树探针 —— **只读**打印真实的桌面窗口层级（阶段 0 产物 ①）。
 *
 * 为什么要有它：
 *   动态桌面（Wallpaper Engine 那种）的核心动作是「把自己的窗口挂进桌面的窗口树」，
 *   而这件事**高度依赖 Windows 版本**。网上流传的写法在本机（Windows 11 25H2 build 26200）
 *   会**静默失效**（挑中一个 202×56 的隐形 WorkerW，`SetParent` 返回成功但屏幕上什么都没有）。
 *   所以先拿真实数据，再写挂载逻辑；这份输出就是这个项目里所有挂载代码的**真值来源**。
 *
 * 用法：
 *   node tools/desktop-tree.js                # 只读，打印窗口树 + 判定表
 *   node tools/desktop-tree.js --json         # 输出 JSON（供 PoC / 单测当夹具）
 *   node tools/desktop-tree.js --spawn        # 额外：发一次 0x052C 并 diff 前后（退路方案诊断用）
 *   node tools/desktop-tree.js --watch=60     # 持续 60 秒采样挂载层句柄稳定性
 *   node tools/desktop-tree.js --json --out=path.json
 *
 * ⚠️ 只有 `--spawn` 会动系统（发一条消息），默认全程只读；它也不需要重启 explorer 就能恢复。
 *
 * ⚠️ DPI：本机两块屏都是 150%，进程不声明 DPI 感知时 `GetWindowRect` 会返回虚拟化 DIP
 *   （实测读到 3627×1707，而真值是 5440×2560）。所以第一行就先 `ensureDpiAwareness()`，
 *   且必须早于任何 COM / GDI 调用。
 */

const fs = require('fs');
const path = require('path');

const desktopHost = require('../src/desktopHost');
const desktopWallpaper = require('../src/desktopWallpaper');

// ⚠️ 必须最早调用：任何取坐标的调用都会把进程的 DPI 感知锁死
const DPI = desktopHost.ensureDpiAwareness();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => '0x' + Number(n || 0).toString(16);
const pad = (s, n) => String(s).padEnd(n, ' ');

function parseArgs(argv) {
  const out = { json: false, spawn: false, out: null, watch: 0 };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--spawn') out.spawn = true;
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--watch=')) out.watch = Number(a.slice(8)) || 0;
  }
  return out;
}

function buildSnapshot() {
  const mon = desktopWallpaper.enumMonitors();
  return desktopHost.snapshot({ monitors: mon.ok ? mon.monitors : [] });
}

/** 窗口树 → 文本行（带 Z 序与关键样式标注） */
function renderSubtree(node, indent, lines, siblingsIndex) {
  for (let i = 0; i < node.length; i += 1) {
    const n = node[i];
    const tags = [];
    if (n.cls === 'Progman') tags.push('★ 顶层桌面窗口');
    if (n.cls === 'WorkerW') tags.push('WorkerW');
    if (n.cls === desktopHost.CONST.DEFVIEW_CLASS) tags.push('★ 图标层');
    if (n.children && n.children.length) tags.push(`${n.children.length} 个子窗口`);
    lines.push(
      `${indent}[${i}] ${pad(n.cls, 18)} ${hx(n.hwnd).padEnd(10)} ` +
      `${pad(`${n.rect.w}×${n.rect.h}`, 12)} @${n.rect.x},${n.rect.y}  ` +
      `${n.visible ? '可见' : '隐藏'}  pid=${n.pid}${tags.length ? '  ← ' + tags.join(' / ') : ''}` +
      `${n.title ? `  "${n.title}"` : ''}`
    );
    if (n.children && n.children.length) renderSubtree(n.children, indent + '    ', lines, i);
  }
}

function printReport(snap) {
  const L = [];
  L.push('='.repeat(96));
  L.push('桌面窗口树真值  ' + snap.at);
  L.push('='.repeat(96));
  L.push(`DPI 感知声明   : ${snap.dpi}`);
  L.push(`虚拟桌面(物理) : ${snap.virtualDesktop.w}×${snap.virtualDesktop.h} @ ${snap.virtualDesktop.x},${snap.virtualDesktop.y}`);
  L.push(`explorer.exe   : pid ${snap.explorerPid} ${snap.progman && snap.progman.exe ? `(${snap.progman.exe})` : ''}`);
  L.push(`顶层窗口总数   : ${snap.topLevel.length}`);
  L.push('');

  // ---- 显示器 ----
  L.push('-' + ' 显示器（口径：IDesktopWallpaper devicePath → 物理矩形，不要自己算）'.trim());
  if (!snap.monitors.length) {
    L.push('  (拿不到显示器列表 —— COM 不可用)');
  }
  for (const m of snap.monitors) {
    L.push(`  ${pad(`${m.width}×${m.height}`, 12)} @${m.x},${m.y}  ${m.primary ? '[主屏]' : '      '}  ${m.id}`);
  }
  L.push('');

  // ---- Progman 子树 ----
  L.push('-' + ' Progman 子树（Z 序：数字小的在上层）'.trim());
  if (snap.progman) {
    const lines = [];
    renderSubtree([snap.progman], '  ', lines, 0);
    L.push(...lines);
  } else {
    L.push('  ⚠️ 找不到 Progman 窗口');
  }
  L.push('');

  // ---- 顶层 WorkerW ----
  const workerws = snap.topLevel.filter((n) => n.cls === 'WorkerW');
  L.push('-' + ` 顶层 WorkerW：${workerws.length} 个`.trim());
  if (workerws.length) {
    L.push(`  ${pad('#', 4)}${pad('句柄', 12)}${pad('尺寸', 12)}${pad('可见', 8)}${pad('pid', 8)}子窗口`);
    for (let i = 0; i < workerws.length; i += 1) {
      const w = workerws[i];
      L.push(`  ${pad(i, 4)}${pad(hx(w.hwnd), 12)}${pad(`${w.rect.w}×${w.rect.h}`, 12)}${pad(w.visible ? '是' : '否', 8)}${pad(w.pid, 8)}${w.children.length}`);
    }
  } else {
    L.push('  (无)');
  }
  L.push('');

  // ---- 挂载决策 ----
  const decision = desktopHost.chooseMountParent(snap);
  L.push('-' + ' 挂载决策（chooseMountParent）'.trim());
  for (const c of decision.checks) {
    L.push(`  ${c.pass ? '[✓]' : '[✗]'} ${pad(c.name, 40)} ${c.detail}`);
  }
  L.push(`  ⇒ ok=${decision.ok}  strategy=${decision.strategy}`);
  L.push(`     ${decision.reason}`);
  if (decision.ok) {
    L.push(`     挂到        : ${hx(decision.parentHwnd)} (${decision.parentCls})`);
    L.push(`     插入到其后  : ${hx(decision.insertAfterHwnd)} (${desktopHost.CONST.DEFVIEW_CLASS})`);
  }
  L.push('');

  // ---- 退路：WorkerW 四条判定表（同时用来证伪"找没有 DefView 的 WorkerW"）----
  const verdicts = desktopHost.judgeWorkerWCandidates(snap, null);
  L.push('-' + ' 退路候选：顶层 WorkerW 四条判定（这是为了证伪网上那套写法）'.trim());
  L.push('  判据：① 发 0x052C 后新出现 ② 尺寸≈虚拟桌面 ③ 可见 ④ 属于 explorer');
  if (!verdicts.length) {
    L.push('  (没有顶层 WorkerW)');
  }
  for (const v of verdicts) {
    const c = v.checks;
    L.push(`  ${v.pass ? '[✓通过]' : '[✗落选]'} ${hx(v.hwnd).padEnd(10)} ` +
      `①${c.isNew.pass ? '✓' : '✗'} ②${c.sizeOk.pass ? '✓' : '✗'} ` +
      `③${c.visible.pass ? '✓' : '✗'} ④${c.explorerOwned.pass ? '✓' : '✗'}   ` +
      `②${c.sizeOk.detail}`);
  }
  L.push('');

  // ---- 结论 ----
  const invisible = verdicts.filter((v) => !v.checks.sizeOk.pass).length;
  L.push('-' + ' 一句话结论'.trim());
  if (decision.strategy === 'progman') {
    L.push(`  ✅ 图标层 ${desktopHost.CONST.DEFVIEW_CLASS} 在 Progman 里 → 挂 Progman，插到图标层之后。`);
    L.push('     不需要发 0x052C，双写兜底（每换图写一次系统壁纸）也不会拆掉挂载点。');
  } else if (decision.strategy === 'workerw-holder') {
    L.push(`  ⚠️ 图标层在顶层 WorkerW 里 → 挂那个 WorkerW。注意它可能被 Explorer 重建，看门狗必须更勤。`);
  } else {
    L.push(`  ❌ 无法确定挂载点：${decision.reason}`);
    L.push('     ⇒ 按任务书 §2.1 的纪律：拒绝挂载，退回静态壁纸，绝不"将就挂"一个不确定的窗口。');
  }
  if (invisible) {
    L.push(`  ⚠️ 另外有 ${invisible} 个顶层 WorkerW 尺寸远离虚拟桌面 —— 它们就是"网上写法"会误挑中的那批。`);
  }
  L.push('='.repeat(96));
  return L.join('\n');
}

/** 发 0x052C 并 diff 窗口树（退路方案诊断） */
async function runSpawnDiff() {
  const before = buildSnapshot();
  const preTop = new Set(before.topLevel.map((n) => n.hwnd));
  const preChild = new Set(desktopHost.flatten([before.progman]).map((n) => n.hwnd));
  const r = desktopHost.sendSpawnMessage();
  console.log(`\n--- 0x052C --- 投递=${r.ok} result=${r.result} progman=${hx(r.progman)}`);
  await sleep(600);
  const after = buildSnapshot();
  const postTop = new Set(after.topLevel.map((n) => n.hwnd));
  const postChild = new Set(desktopHost.flatten([after.progman]).map((n) => n.hwnd));

  const newTop = after.topLevel.filter((n) => !preTop.has(n.hwnd));
  const newChildren = desktopHost.flatten([after.progman]).filter((n) => !preChild.has(n.hwnd));
  console.log(`新增顶层窗口     : ${newTop.length}`);
  for (const n of newTop) console.log(`   + ${n.cls} ${hx(n.hwnd)} ${n.rect.w}×${n.rect.h} visible=${n.visible} pid=${n.pid}`);
  console.log(`Progman 新增子窗口: ${newChildren.length}`);
  for (const n of newChildren) console.log(`   + ${n.cls} ${hx(n.hwnd)} ${n.rect.w}×${n.rect.h} visible=${n.visible} pid=${n.pid}`);

  const v1 = desktopHost.judgeWorkerWCandidates(before, null);
  const preHandles = desktopHost.snapshotWorkerWHandles(before);
  const v2 = desktopHost.judgeWorkerWCandidates(after, preHandles);
  console.log(`\n发消息前的顶层 WorkerW 句柄: [${preHandles.map(hx).join(', ')}]`);
  console.log(`发消息后的四条判定表：`);
  for (const v of v2) {
    const c = v.checks;
    console.log(`  ${v.pass ? '[✓通过]' : '[✗落选]'} ${hx(v.hwnd).padEnd(10)} ①新出现=${c.isNew.pass ? '✓' : '✗'} ②尺寸=${c.sizeOk.pass ? '✓' : '✗'}(${c.sizeOk.detail}) ③可见=${c.visible.pass ? '✓' : '✗'} ④explorer=${c.explorerOwned.pass ? '✓' : '✗'}`);
  }
  const added = v2.filter((v) => v.checks.isNew.pass);
  console.log(`\n⇒ 0x052C 新造出 ${added.length} 个顶层 WorkerW；发消息前已有 ${v1.length} 个。`);
  if (newChildren.filter((n) => n.cls === 'WorkerW').length) {
    console.log('⇒ 注意：新 WorkerW 出现在 **Progman 的子窗口**里（不是顶层兄弟）—— 这正是本机的形态。');
  }
  return after;
}

/** 持续采样：看 Progman / DefView / 子 WorkerW 的句柄稳不稳定 */
async function runWatch(seconds) {
  const keys = ['Progman', desktopHost.CONST.DEFVIEW_CLASS];
  console.log(`\n--- 稳定性采样 ${seconds}s（每 5s 一次）---`);
  console.log(`${pad('时刻', 10)}${pad('Progman', 12)}${pad('DefView', 12)}${pad('子WorkerW', 14)}壁纸mtime`);
  const deadline = Date.now() + seconds * 1000;
  const wpPath = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
  const mtime = () => { try { return new Date(fs.statSync(wpPath).mtimeMs).toLocaleTimeString('zh-CN'); } catch { return 'n/a'; } };
  while (Date.now() < deadline) {
    const s = buildSnapshot();
    const flat = desktopHost.flatten([s.progman]);
    const dv = flat.find((n) => n.cls === desktopHost.CONST.DEFVIEW_CLASS);
    const cw = flat.filter((n) => n.cls === 'WorkerW' && n.parentHwnd === (s.progman ? s.progman.hwnd : 0));
    console.log(
      `${pad(new Date().toLocaleTimeString('zh-CN'), 10)}` +
      `${pad(s.progman ? hx(s.progman.hwnd) : 'n/a', 12)}` +
      `${pad(dv ? hx(dv.hwnd) : 'n/a', 12)}` +
      `${pad(cw.length ? hx(cw[0].hwnd) : '(无)', 14)}` +
      `${mtime()}`
    );
    await sleep(5000);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const diag = desktopHost.diagnose();
  if (!diag.ok) {
    console.error(`[desktop-tree] koffi 不可用：${diag.error}`);
    process.exitCode = 1;
    return;
  }

  const snap = buildSnapshot();
  if (!snap.ok) {
    console.error(`[desktop-tree] 采集失败：${snap.error}`);
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    const text = JSON.stringify(snap, null, 2);
    if (args.out) {
      fs.writeFileSync(args.out, text, 'utf8');
      console.error(`[desktop-tree] JSON 已写入 ${args.out}（DPI=${DPI}）`);
    } else {
      process.stdout.write(text + '\n');
    }
  } else {
    console.log(printReport(snap));
  }

  if (args.spawn) await runSpawnDiff();
  if (args.watch > 0) await runWatch(args.watch);

  desktopWallpaper.release();
}

main().catch((err) => {
  console.error('[desktop-tree] 未捕获异常:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
