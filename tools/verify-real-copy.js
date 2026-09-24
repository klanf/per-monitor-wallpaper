'use strict';

/**
 * 「复制图像到剪贴板」在**真实图片**上的耗时 A/B。
 *
 * 为什么需要它：`verify-clipboard` §7 用的是**合成纯色图**（为了跑得快），
 * 而纯色极易压缩 —— 量出来的「快路 vs 老路」倍率被严重低估（约 2.3×）。
 * 真实照片上的数字要好得多：66.7 MP 的 PNG 是 1003 ms vs 6209 ms（6.2×）。
 * 所以对外说倍数时以这个脚本的输出为准。
 *
 * 用法（路径自己给，脚本里刻意不写任何真实图库路径）：
 *     python tools/run-electron.py tools/verify-real-copy.js <图片> [<图片> ...]
 *
 * 副作用：会写真剪贴板，但开跑拍快照、结束还原，跑完不留痕迹。
 */

const path = require('node:path');
const { app } = require('electron');

const SRC = path.join(__dirname, '..', 'src');
const fileActions = require(path.join(SRC, 'fileActions.js'));
const clipboardWin = require(path.join(SRC, 'clipboardWin.js'));
const clipboardReader = require('./clipboardReader.js');

// 只认图片后缀：Electron 的 argv 里还可能混进脚本自己的路径
const FILES = [...new Set(
  process.argv.slice(1).filter((a) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(a)),
)];

(async () => {
  await app.whenReady();

  if (!FILES.length) {
    console.log('用法：python tools/run-electron.py tools/verify-real-copy.js <图片> [<图片> ...]');
    app.exit(2);
    return;
  }

  const snap = clipboardReader.snapshot();
  console.log(`剪贴板快照：${clipboardReader.describeSnapshot(snap)}`);

  for (const file of FILES) {
    const plan = fileActions.planCopy(file);
    if (!plan.width) { console.log(`\n跳过（读不到尺寸）：${file}`); continue; }

    const mp = (plan.width * plan.height / 1e6).toFixed(1);
    console.log(`\n================ ${plan.width}×${plan.height} = ${mp} MP ================`);
    console.log(`  planCopy: fast=${plan.fast}（阈值 ${fileActions.FAST_PATH_PIXELS / 1e6} MP）`);

    const runs = [
      ['自动（新代码走的这条）', {}],
      ['强制快路 fast:true', { fast: true }],
      ['强制老路 fast:false（旧行为）', { fast: false }],
    ];
    const cost = {};
    for (const [label, opts] of runs) {
      const t = Date.now();
      const r = await fileActions.copyImage(file, opts);
      cost[label] = Date.now() - t;
      const dib = r.ok ? Math.round(r.clipboard.dibv5 / 1048576) : 0;
      console.log(`  ${label.padEnd(26)} ${String(cost[label]).padStart(6)} ms  ` +
        `ok=${r.ok} method=${r.method} fast=${r.fast === true} dibv5=${dib} MiB`);
      if (!r.ok) console.log(`      error=${r.error}`);
    }

    const newMs = cost['自动（新代码走的这条）'];
    const oldMs = cost['强制老路 fast:false（旧行为）'];
    if (oldMs && newMs) console.log(`  ⇒ ${(oldMs / newMs).toFixed(1)}× 快`);

    // 「先报进度」的时序：提示必须发生在冻结之前
    const notices = [];
    const t0 = Date.now();
    await fileActions.copyImageWithNotice(file, (text) => notices.push({ text, at: Date.now() - t0 }));
    console.log(`  copyImageWithNotice: 提示「${notices[0] && notices[0].text}」` +
      `at ${notices[0] && notices[0].at}ms，总 ${Date.now() - t0}ms`);
  }

  const after = clipboardWin.readImageStatus();
  console.log(`\n还原前剪贴板：${after.ok ? `dibv5=${after.dibv5}` : after.error}`);
  const back = clipboardReader.restore(snap);
  console.log(`还原：${back.ok ? back.restored.join(' + ') : '失败 ' + back.error}`);

  app.exit(0);
})().catch((err) => {
  console.error('崩溃：', err);
  app.exit(2);
});
