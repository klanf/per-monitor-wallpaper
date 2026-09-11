'use strict';

/**
 * 「随机 = 把列表本身洗乱，然后顺着列表播」的端到端验证。
 *
 * 用户的原话：
 *   「打开程序的时候先做乱序排序，然后就按乱序的顺序切换壁纸就行，
 *     这样的话有个好处，就是在看缩略图胶片条的时候就是图片的历史顺序，
 *     而不是像现在这个先是第一页，下一页就跑 100 页去了，
 *     然后我还没办法追踪上一张我看的图片是哪一张」
 *
 * 所以这个脚本盯三件事：
 *   ① 列表确实被打乱了（但没丢也没多）
 *   ② 播放顺着列表一格一格走 —— 「下一张」只挪一格，不会跳到第 100 页
 *   ③ 胶片条上的顺序 == 列表顺序 == 播放顺序，可以直接当历史来读
 *
 * 全程 applyToSystem=false —— 只推进内部状态，不动用户的桌面。
 *
 * 用法：应用以 --remote-debugging-port=9222 启动，然后
 *   node tools/verify-shuffle-order.js
 */

const path = require('node:path');
const fs = require('node:fs');

const testConfig = require('./testConfig');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const N = 40;
const TMP = path.resolve(__dirname, 'tmp', 'order');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; failures.push(label); console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n===== ${t} =====`);

/* ------------------------------------------------------------ CDP */

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const t = await (await fetch(CDP_LIST)).json();
      const page = t.find((x) => x.type === 'page' && String(x.url).includes('index.html'));
      if (page && page.webSocketDebuggerUrl) return page;
      last = `目标 ${t.length} 个，未匹配 index.html`;
    } catch (e) { last = e.message; }
    await sleep(400);
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
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
  });
}

/* ------------------------------------------------------------ 夹具 */

/** 40 张各不相同的图。文件名保留原始编号，方便对照「按名称的顺序」。 */
function buildFixture() {
  const dir = path.join(TMP, 'src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const gallery = path.resolve(__dirname, 'fixtures', 'gallery');
  const pool = fs.readdirSync(gallery).filter((f) => /\.png$/i.test(f)).sort();
  if (pool.length < N) throw new Error(`fixtures/gallery 里只有 ${pool.length} 张，不够 ${N} 张`);
  for (let i = 0; i < N; i += 1) {
    fs.copyFileSync(path.join(gallery, pool[i]), path.join(dir, `b-${String(i).padStart(2, '0')}.png`));
  }
  return dir;
}

/* ------------------------------------------------------------ 主流程 */

(async () => {
  const SRC = buildFixture();
  console.log(`夹具：${N} 张图 → ${SRC}`);

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

  const base = testConfig.begin();
  const baselineWarn = testConfig.describeBaseline(base);
  if (baselineWarn) console.log(baselineWarn);

  section('0. 切到测试目录，开随机（不写系统壁纸）');
  await ev('window.wp.setConfig(' + JSON.stringify({
    folder: SRC,
    recursive: false,
    perMonitor: false,      // 统一模式：顶层 folder 才作数（每屏独立会被 monitors 覆盖）
    interval: 3600,         // 让定时器走不到，只靠手动推进
    autoPlay: false,
    applyToSystem: false,
    shuffle: true,
    filmstrip: true,
    skipSizeTwin: false,
  }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1500);

  const ch0 = (await ev('window.wp.listChannels()')).channels[0];
  if (!ch0) throw new Error('没有频道');
  const id = ch0.id;
  const J = JSON.stringify(id);
  const names = await ev(`window.wp.channelFiles(${J}).then((r) => r.files.map((f) => f.name))`);
  const nameSorted = names.slice().sort();

  section('1. 列表被打乱了（但没丢也没多）');
  check('载入 40 张', names.length === N, `实际 ${names.length}`);
  check('列表不等于文件名顺序（确实洗过）',
    names.join(',') !== nameSorted.join(','), `前 4 个：${names.slice(0, 4).join(' ')}`);
  check('还是同一批文件', names.slice().sort().join(',') === nameSorted.join(','));
  check('频道标记为已洗牌', ch0.shuffled === true, String(ch0.shuffled));

  const advance = async () => {
    const r = await ev(`window.wp.channelCommand(${J}, 'next').then((x) => x.channels.find((c) => c.id === ${J}))`);
    return r;
  };

  section('2. 播放顺着列表一格一格走（不是乱跳）');
  const startIdx = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === id).index;
  const seq = [startIdx];
  for (let k = 0; k < 9; k += 1) {
    const st = await advance();
    seq.push(st.index);
  }
  check('连续 9 次「下一张」的序号是连续递增的',
    seq.every((v, i) => i === 0 || v === (seq[i - 1] + 1) % N),
    seq.join(' → '));
  check('每次都换了一张图（不是原地不动）',
    new Set(seq).size === seq.length, `${new Set(seq).size} 个不同`);

  const beforePrev = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === id).index;
  await ev(`window.wp.channelCommand(${J}, 'prev')`);
  const afterPrev = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === id).index;
  check('「上一张」正好退回一格（回到刚才那张）',
    afterPrev === (beforePrev - 1 + N) % N, `${beforePrev} → ${afterPrev}`);

  section('3. 胶片条上的顺序 == 列表顺序（能当历史读）');
  const film = await ev(`(() => {
    const items = [...document.querySelectorAll('#film-track .film-item')];
    return {
      idx: items.map((e) => Number(e.dataset.index)),
      current: items.filter((e) => e.classList.contains('current')).map((e) => Number(e.dataset.index)),
    };
  })()`);
  check('胶片条节点按序号升序排列（左边就是前面那张）',
    film.idx.every((v, i) => i === 0 || v > film.idx[i - 1]), `前 6 个：${film.idx.slice(0, 6).join(',')}`);
  check('胶片条上是连续的一段（没有空洞）',
    film.idx.every((v, i) => i === 0 || v === film.idx[i - 1] + 1));
  check('高亮的「当前」与频道索引一致',
    film.current.length === 1 && film.current[0] === afterPrev,
    `胶片条 ${film.current[0]} / 频道 ${afterPrev}`);

  const curName = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === id).name;
  check('胶片条当前格对应的图 == 正在显示的那张',
    names[afterPrev] === curName, `${names[afterPrev]} vs ${curName}`);

  // 再走几步，确认「上一张」永远在左边一格
  const walk = [];
  for (let k = 0; k < 4; k += 1) {
    const st = await advance();
    walk.push(st.index);
  }
  check('继续走 4 步，序号同样连续（胶片条向右一格一格挪）',
    walk.every((v, i) => i === 0 || v === walk[i - 1] + 1), walk.join(' → '));
  check('刚看过的那张就在左边一格',
    names[walk[0] - 1] === names[afterPrev - 1] || walk[0] - 1 === afterPrev, 
    `上一张 #${walk[0] - 1}，之前看的 #${afterPrev}`);

  section('4. 点胶片条上的缩略图能直接跳过去');
  const targetIndex = walk[walk.length - 1] + 3;
  await ev(`document.querySelector('#film-track .film-item[data-index="${targetIndex}"]').click()`);
  await sleep(900);
  const jumped = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === id);
  check('跳到目标序号', jumped.index === targetIndex, `→ ${jumped.index}`);
  check('显示的就是那一格对应的图', jumped.name === names[targetIndex],
    `${names[targetIndex]}`);
  await advance();
  check('跳过去之后「下一张」从那一格继续往后走（顺序不乱）',
    (await ev('window.wp.listChannels()')).channels.find((c) => c.id === id).index === targetIndex + 1);

  section('5. 设置面板显示「第 X / Y 张」');
  /*
   * 卡片只在「每屏独立」模式下渲染，所以切回去看一眼 ——
   * 此时频道指向的是用户自己的图库，只读状态、不推进、不写桌面。
   */
  await ev('window.wp.setConfig(' + JSON.stringify({ perMonitor: true }) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1800);

  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(600);
  const panel = await ev(`(() => {
    const cards = [...document.querySelectorAll('.monitor-card')].map((c) => ({
      id: c.dataset.id,
      status: (c.querySelector('.mc-status') || {}).textContent || '',
      segs: [...c.querySelectorAll('.seg[data-seg="shuffle"] .seg-item')].map((b) => b.textContent.trim()),
    }));
    return { open: document.querySelector('#settings').classList.contains('open'), cards };
  })()`);
  const nowChs = (await ev('window.wp.listChannels()')).channels;
  const parsed = panel.cards.map((c) => {
    const m = c.status.match(/第\s*(\d+)\s*\/\s*(\d+)\s*张/);
    return m ? { id: c.id, at: Number(m[1]), total: Number(m[2]) } : null;
  });

  check('设置面板已打开', panel.open === true);
  check('每张卡片都渲染了', panel.cards.length === nowChs.length,
    `卡片 ${panel.cards.length} / 频道 ${nowChs.length}`);
  check('卡片上显示「第 X / Y 张」', parsed.every(Boolean),
    panel.cards.map((c) => (c.status.replace(/\s+/g, ' ').match(/第[^扫]*/) || [''])[0].trim()).join(' ｜ '));
  check('卡片上的 Y 与频道实际张数一致',
    parsed.every((p) => { const ch = nowChs.find((c) => c.id === p.id); return ch && ch.count === p.total; }),
    parsed.map((p) => (p ? p.total : '?')).join(' / '));
  check('卡片上的 X 就是当前索引 + 1',
    parsed.every((p) => { const ch = nowChs.find((c) => c.id === p.id); return ch && p.at === ch.index + 1; }),
    parsed.map((p) => (p ? `${p.at}/${p.total}` : '?')).join(' '));
  check('播放顺序选项写的是「随机不重复」',
    panel.cards.every((c) => c.segs.join('/') === '按名称/随机不重复'),
    panel.cards[0] ? panel.cards[0].segs.join('/') : '(无卡片)');

  section('6. 还原配置');
  await ev(`document.querySelector('#btn-settings-close').click()`);
  const restored = await testConfig.restore(ev);
  await sleep(600);
  check('已从基线快照还原配置', restored.ok, restored.ok ? restored.actual.folder : restored.error);
  check('还原后的目录不是测试素材',
    !testConfig.looksLikeTestData(restored.actual.folder), String(restored.actual.folder));
  check('还原后与还原点逐键一致（脏值不会被下一轮继承）',
    (restored.diff || []).length === 0,
    (restored.diff || []).slice(0, 4).join('；') || '完全一致');


  cdp.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 沙箱可能拦删除 */ }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n脚本异常：', err.message);
  process.exit(2);
});
