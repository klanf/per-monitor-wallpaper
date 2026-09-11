'use strict';

/**
 * 复现「胶片条偶尔出现重复缩略图」。
 *
 * 思路：胶片条的窗口同步（syncFilmWindow）只在窗口**平移**时走增量分支，
 * 随机跳转、贴边回填、来回小步移动都会踩到不同的分支组合。
 * 所以这里用 120 张的固定素材，反复做「随机大跳 + ±1 小步 + 贴边折返」，
 * 每一步都校验四条不变量：
 *   · film.els.size 等于窗口长度
 *   · DOM 里的 .film-item 数量等于 film.els.size
 *   · data-index 恰好铺满 [start, end) 且顺序正确、无重复
 *   · 没有两条 data-path 相同（不同序号指向同一个文件）
 *
 * 用 applyToSystem:false 跑，全程不动用户的桌面。
 */

const path = require('node:path');
const fs = require('node:fs');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const GALLERY = path.resolve(__dirname, 'fixtures', 'gallery');
const ROUNDS = Number(process.argv[2] || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = await (await fetch(CDP_LIST)).json();
      const page = t.find((x) => x.type === 'page' && String(x.url).includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch { /* 继续等 */ }
    await sleep(400);
  }
  throw new Error('等不到渲染进程，应用是否带 --remote-debugging-port=9222 启动了？');
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
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
  });
}

(async () => {
  const page = await waitForPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable', {});

  async function ev(expression) {
    const out = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.result?.exceptionDetails) {
      throw new Error(out.result.exceptionDetails.exception?.description?.split('\n')[0] || '异常');
    }
    return out.result?.result?.value;
  }

  const cfg = await ev('window.wp.getConfig()');
  const total = fs.readdirSync(GALLERY).length;
  console.log(`素材 ${total} 张   轮数 ${ROUNDS}`);

  console.log('临时切到测试素材（applyToSystem:false，不动桌面）…');
  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: GALLERY, recursive: false, perMonitor: false, monitor: 'primary',
    interval: 9999, shuffle: false, autoPlay: false,
    applyToSystem: false, filmstrip: true, filmstripRange: 40, filmstripAutoCenter: false,
  }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1500);

  const chId = (await ev('window.__rendererState()')).previewId;
  const state = await ev('window.__rendererState()');
  if (state.count !== total) throw new Error(`频道只载入 ${state.count} 张，期望 ${total}`);

  /** 一次性把 DOM 与内部状态取回来比对 */
  const INSPECT = `(() => {
    const st = window.__rendererState();
    const items = [...document.querySelectorAll('#film-track .film-item')];
    const idx = items.map((e) => Number(e.dataset.index));
    const paths = items.map((e) => e.dataset.path);
    const w = st.filmstrip.window || {};
    const dupIdx = idx.filter((v, i) => idx.indexOf(v) !== i);
    const dupPath = paths.filter((v, i) => v && paths.indexOf(v) !== i);
    let contiguous = true;
    for (let i = 0; i < idx.length; i += 1) if (idx[i] !== w.start + i) { contiguous = false; break; }
    return {
      index: st.index,
      count: st.count,
      nodes: st.filmstrip.nodes,
      dom: items.length,
      window: w,
      span: (w.end - w.start) || 0,
      contiguous,
      dupIdx: [...new Set(dupIdx)],
      dupPath: [...new Set(dupPath)].map((p) => p.split('\\\\').pop()),
      hasCurrent: st.filmstrip.currentInDom,
    };
  })()`;

  let violations = 0;
  let worst = null;

  function check(step, label, snap) {
    const problems = [];
    if (snap.span !== snap.nodes) problems.push(`els.size=${snap.nodes} ≠ 窗口长度=${snap.span}`);
    if (snap.dom !== snap.nodes) problems.push(`DOM=${snap.dom} ≠ els.size=${snap.nodes}`);
    if (!snap.contiguous) problems.push(`data-index 不是连续的 [start,end)`);
    if (snap.dupIdx.length) problems.push(`重复序号 ${snap.dupIdx.slice(0, 5).join(',')}`);
    if (snap.dupPath.length) problems.push(`重复路径 ${snap.dupPath.slice(0, 5).join(',')}`);
    if (problems.length) {
      violations += 1;
      console.log(`  ✗ #${step} ${label}  index=${snap.index} window=[${snap.window.start},${snap.window.end})`);
      problems.forEach((p) => console.log(`      - ${p}`));
      if (!worst) worst = { step, label, snap, problems };
      return false;
    }
    return true;
  }

  let prevIndex = (await ev('window.__rendererState()')).index;
  let rnd = 12345;
  const nextRnd = () => { rnd = (rnd * 1103515245 + 12345) & 0x7fffffff; return rnd / 0x7fffffff; };

  for (let i = 0; i < ROUNDS; i += 1) {
    const r = nextRnd();
    let target;
    if (r < 0.45) target = Math.floor(nextRnd() * total);            // 随机大跳
    else if (r < 0.75) target = (prevIndex + 1) % total;             // 向后一步
    else if (r < 0.9) target = (prevIndex - 1 + total) % total;      // 向前一步
    else target = (prevIndex + 40) % total;                          // 正好半个窗口

    await ev(`window.wp.channelCommand(${JSON.stringify(chId)}, 'goto', { index: ${target} })`);
    await sleep(45);

    const snap = await ev(INSPECT);
    if (!check(i, `→${target}`, snap)) {
      if (violations >= 5) { console.log('  已连续出现 5 次，提前结束'); break; }
    }
    prevIndex = snap.index;
  }

  console.log(`\n共 ${ROUNDS} 轮，发现 ${violations} 次不变量被破坏`);

  console.log('还原原配置…');
  await ev('window.wp.setConfig(' + JSON.stringify(cfg) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1200);
  console.log(`  已还原：${(await ev('window.wp.getConfig()')).folder}`);

  cdp.close();
  process.exit(violations ? 1 : 0);
})().catch((err) => {
  console.error('复现脚本异常：', err.message);
  process.exit(2);
});
