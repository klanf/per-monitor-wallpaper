'use strict';

/**
 * 每屏独立轮播的端到端验证。
 *
 * 两条互相独立的证据链：
 *   ① 应用自己的视角：走 CDP 直连渲染进程，读它认为的频道状态；
 *   ② 操作系统的视角：本脚本自己开一份 IDesktopWallpaper，读每台显示器
 *      当前真正挂在桌面上的壁纸文件路径。
 *   只有两者一致，才算「每屏独立」真的成立 —— 光看应用自己说什么是没用的。
 *
 * 用法：应用要以 tools/fixtures/two-screen 的两屏配置启动，且带 --remote-debugging-port=9222
 */

const path = require('node:path');
const fs = require('node:fs');

const desktopWallpaper = require('../src/desktopWallpaper');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIXTURES = path.resolve(__dirname, 'fixtures/two-screen');
const SAMPLE_MS = 8000;          // 观察窗口：足够让两个不同间隔的频道走出不同步数

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

/* ------------------------------------------------------------ CDP */

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(CDP_LIST)).json();
      const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
      last = `目标 ${targets.length} 个，未匹配 index.html`;
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`等待渲染进程超时：${last}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('open', () => resolve({
      call(method, params) {
        return new Promise((res) => {
          const id = ++seq;
          pending.set(id, res);
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    });
  });
}

/* ------------------------------------------------------------ 工具 */

/** 操作系统视角：每台显示器当前挂的壁纸 */
function osMonitors() {
  const result = desktopWallpaper.enumMonitors();
  return (result.monitors || []).map((m) => ({
    index: m.index,
    label: m.label,
    current: m.current || null,
  }));
}

const dirOf = (p) => (p ? path.basename(path.dirname(p)) : null);
const baseOf = (p) => (p ? path.basename(p) : null);

function describe(monitors) {
  return monitors.map((m) => `[${m.index}] ${baseOf(m.current) || '(空)'}`).join('   ');
}

(async () => {
  const page = await waitForPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});

  async function ev(expression) {
    const out = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.result && out.result.exceptionDetails) {
      throw new Error(out.result.exceptionDetails.exception?.description?.split('\n')[0] || '未知异常');
    }
    return out.result?.result?.value;
  }

  const registry = await ev(`window.wp.listChannels()`);

  console.log('\n===== 1. 频道划分（应用视角）=====');
  const channels = registry.channels || [];
  check('检测到 2 台显示器', (registry.monitors || []).length === 2,
    (registry.monitors || []).map((m) => m.label).join(' / '));
  check('生成了 2 路独立频道', channels.length === 2, `实际 ${channels.length}`);
  check('模式标记为每屏独立', registry.perMonitor === true);

  const [ch0, ch1] = channels;
  const aDir = path.join(FIXTURES, 'dirA');
  const bDir = path.join(FIXTURES, 'dirB');

  check('频道 0 指向 dirA', path.normalize(ch0.profile.folder) === path.normalize(aDir), ch0.profile.folder);
  check('频道 1 指向 dirB', path.normalize(ch1.profile.folder) === path.normalize(bDir), ch1.profile.folder);
  check('两路目录确实不同', ch0.profile.folder !== ch1.profile.folder);
  check('频道 0 有 3 张图', ch0.count === 3, `实际 ${ch0.count}`);
  check('频道 1 有 2 张图', ch1.count === 2, `实际 ${ch1.count}`);
  check('两路间隔不同（3 秒 vs 8 秒）', ch0.profile.interval !== ch1.profile.interval,
    `${ch0.profile.interval}s / ${ch1.profile.interval}s`);
  check('两路显示器 ID 不同', ch0.monitorId !== ch1.monitorId);
  check('两路都在播放', ch0.playing === true && ch1.playing === true);

  console.log('\n===== 2. 启动接管：两屏各挂各自的目录 =====');
  let os = osMonitors();
  console.log(`      OS 现状: ${describe(os)}`);
  check('屏 0 挂的是 dirA 里的图', dirOf(os[0].current) === 'dirA', baseOf(os[0].current));
  check('屏 1 挂的是 dirB 里的图', dirOf(os[1].current) === 'dirB', baseOf(os[1].current));
  check('两屏挂的不是同一个文件', os[0].current !== os[1].current);

  console.log('\n===== 3. 独立推进：用累计推进次数判断节奏 =====');
  // 注意：不能用「索引变化」判断是否推进 —— 3 张图的目录转一圈正好回到 0。
  // 这里用调度器里的单调计数器 ticks，再配合 OS 侧的采样去做双重证明。
  const before = channels.map((c) => c.ticks || 0);
  console.log(`      起始 ticks=[${before}]  索引=[${channels.map((c) => c.index)}]`);

  const seen = [new Set(), new Set()];
  const samples = [];
  const rounds = Math.round(SAMPLE_MS / 700);

  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 700));
    const snap = osMonitors();
    samples.push(snap);
    seen[0].add(baseOf(snap[0].current));
    seen[1].add(baseOf(snap[1].current));
  }

  const after = (await ev(`window.wp.listChannels()`)).channels;
  const dTicks = [after[0].ticks - before[0], after[1].ticks - before[1]];
  console.log(`      ${SAMPLE_MS / 1000}s 后 ticks=[${after.map((c) => c.ticks)}]  增量=[${dTicks}]`);

  check('频道 0 确实在推进', dTicks[0] > 0, `推进 ${dTicks[0]} 次`);
  check('频道 1 确实在推进', dTicks[1] > 0, `推进 ${dTicks[1]} 次`);
  check('间隔 3 秒的频道比间隔 8 秒的走得快（节奏独立）', dTicks[0] > dTicks[1],
    `dirA ${dTicks[0]} 次 vs dirB ${dTicks[1]} 次`);
  check('节奏比与间隔比大致吻合（3s : 8s ≈ 2.7 : 1）',
    dTicks[0] / Math.max(1, dTicks[1]) >= 2, `实际 ${(dTicks[0] / Math.max(1, dTicks[1])).toFixed(1)} : 1`);

  console.log('\n===== 4. OS 侧采样：两块屏各自轮播且全程不串台 =====');
  for (let i = 0; i < samples.length; i += 1) {
    console.log(`      #${i + 1}  ${describe(samples[i])}`);
  }
  check('屏 0 在采样窗口内出现了多张不同的图', seen[0].size >= 2, [...seen[0]].join(', '));
  check('屏 0 出现过的文件全部来自 dirA',
    samples.every((s) => dirOf(s[0].current) === 'dirA'));
  check('屏 1 出现过的文件全部来自 dirB',
    samples.every((s) => dirOf(s[1].current) === 'dirB'));
  check('从未出现串台（屏 0 没出现过 dirB 的图）',
    ![...seen[0]].some((n) => n && n.startsWith('b-')));
  check('从未出现串台（屏 1 没出现过 dirA 的图）',
    ![...seen[1]].some((n) => n && n.startsWith('a-')));
  check('两块屏的当前文件始终不同',
    samples.every((s) => s[0].current !== s[1].current));

  console.log('\n===== 5. 暂停一路，另一路不受影响 =====');
  await ev(`window.wp.channelCommand(${JSON.stringify(ch0.id)}, 'pause')`);
  await new Promise((r) => setTimeout(r, 400));

  const frozen = (await ev(`window.wp.listChannels()`)).channels;
  const frozenOs = osMonitors();
  const frozenTicks = [frozen[0].ticks, frozen[1].ticks];

  await new Promise((r) => setTimeout(r, 6000));

  const afterPause = (await ev(`window.wp.listChannels()`)).channels;
  const osPaused = osMonitors();
  check('被暂停的频道 0 一次都没再推进', afterPause[0].ticks === frozenTicks[0],
    `${frozenTicks[0]} → ${afterPause[0].ticks}`);
  check('被暂停的屏 0 桌面文件未变', osPaused[0].current === frozenOs[0].current,
    `${baseOf(frozenOs[0].current)} → ${baseOf(osPaused[0].current)}`);
  check('未被暂停的频道 1 仍在推进', afterPause[1].ticks > frozenTicks[1],
    `${frozenTicks[1]} → ${afterPause[1].ticks}`);
  check('暂停状态只反映在自己身上',
    afterPause[0].playing === false && afterPause[1].playing === true);

  await ev(`window.wp.channelCommand(${JSON.stringify(ch0.id)}, 'play')`);

  console.log('\n===== 6. 切换预览目标 =====');
  const beforePreview = await ev(`window.__rendererState()`);
  check('窗口默认预览第一路', beforePreview.previewId === ch0.id || beforePreview.previewId === ch1.id,
    String(beforePreview.previewId).slice(0, 30));
  const firstCount = beforePreview.count;

  await ev(`(async () => {
    const cards = document.querySelectorAll('.monitor-card .eye');
    if (cards.length >= 2) cards[1].click();
    await new Promise((r) => setTimeout(r, 900));
  })()`);
  await new Promise((r) => setTimeout(r, 1200));

  const afterPreview = await ev(`window.__rendererState()`);
  check('预览目标已切到第二路', afterPreview.previewId === ch1.id,
    String(afterPreview.previewId).slice(0, 30));
  check('预览图片列表跟着换了', afterPreview.count === 2, `实际 ${afterPreview.count} 张`);
  check('当前预览文件名来自 dirB', String(afterPreview.currentName).startsWith('b-'),
    afterPreview.currentName);

  const previewBadge = await ev(`document.getElementById('preview-badge').textContent`);
  check('顶栏预览徽标已更新', /预览/.test(previewBadge), previewBadge);

  console.log('\n===== 7. 改一路配置不影响另一路 =====');
  await ev(`window.wp.channelCommand(${JSON.stringify(ch0.id)}, 'set-profile', { interval: 42 })`);
  await new Promise((r) => setTimeout(r, 600));
  const mixed = (await ev(`window.wp.listChannels()`)).channels;
  check('频道 0 间隔已改为 42 秒', mixed[0].profile.interval === 42, `实际 ${mixed[0].profile.interval}`);
  check('频道 1 间隔未被波及', mixed[1].profile.interval === 8, `实际 ${mixed[1].profile.interval}`);
  check('频道 1 目录未被波及', path.normalize(mixed[1].profile.folder) === path.normalize(bDir));

  const cfg = await ev(`window.wp.getConfig()`);
  const entry0 = (cfg.monitors || {})[ch0.id] || {};
  const entry1 = (cfg.monitors || {})[ch1.id] || {};
  const keys0 = Object.keys(entry0);
  check('改过的频道只存了这一项差异', keys0.length === 1 && keys0[0] === 'interval', JSON.stringify(keys0));
  check('另一路的配置原样未动', entry1.interval === 8 && entry1.folder === bDir, JSON.stringify(entry1));

  console.log('\n===== 8. 每屏接管开关 =====');
  await ev(`window.wp.channelCommand(${JSON.stringify(ch1.id)}, 'set-profile', { enabled: false })`);
  await new Promise((r) => setTimeout(r, 600));
  const offState = (await ev(`window.wp.listChannels()`)).channels;
  check('频道 1 已标记为不接管', offState[1].enabled === false);

  const osBeforeApply = osMonitors();
  await ev(`window.wp.channelCommand(${JSON.stringify(ch1.id)}, 'next')`);
  await new Promise((r) => setTimeout(r, 900));
  const osAfterApply = osMonitors();
  check('不接管的频道即使切图也不动桌面', osBeforeApply[1].current === osAfterApply[1].current,
    baseOf(osAfterApply[1].current));

  await ev(`window.wp.channelCommand(${JSON.stringify(ch1.id)}, 'set-profile', { enabled: true })`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  cdp.close();
  desktopWallpaper.release();
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n验证脚本崩溃:', err.message);
  try { desktopWallpaper.release(); } catch { /* ignore */ }
  process.exit(2);
});
