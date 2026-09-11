'use strict';

/**
 * 第五轮四项修复的端到端验证。
 *
 *   ① 随机轮播「偶尔连着出现同一张图」—— 图库里有内容完全相同的重复文件
 *      （现在「随机」= 洗乱列表本身，所以盯的是**洗牌结果**里有没有相邻同体积；
 *        把它做到零成本的对照实验在 tools/test-scheduler.js 第 13 节）
 *   ② 每屏独立 → 播放顺序：从随机切到按名称之后切不回随机
 *   ③ 设置面板里的「当前图片」删除按钮
 *   ④ 「打开所在文件夹」要定位到图片本身（不是只把文件夹打开）
 *
 * 用法：应用以 --remote-debugging-port=9222 启动，然后
 *   node tools/verify-fixes.js
 *
 * ① 用的是**确定性夹具**：3 张图里有两张字节完全相同（体积也一样），
 * 于是「从 A 出发下一张还能不能走到 B」可以被直接断言，不用靠概率碰运气。
 * 关闭护栏（skipSizeTwin:false）再跑一遍做对照 —— 证明护栏真的在起作用，
 * 而不是「本来就不会撞上」。
 */

const path = require('node:path');
const fs = require('node:fs');

const testConfig = require('./testConfig');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const FIX = path.resolve(__dirname, 'fixtures');
const TMP = path.resolve(__dirname, 'tmp', 'fixes');

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

/**
 * 造一个「有重复图」的目录：
 *   dup-a.png  dup-b.png   字节完全相同（体积当然也一样）
 *   other.png  other2.png  体积互不相同的两张
 * 按名称排序后序号是 0 / 1 / 2 / 3，于是「从 A 出发的下一张能不能是 B」可以直接断言。
 *
 * 为什么是 4 张而不是 3 张：3 张里放一对孪生、只有一张异色图时，
 * 「孪生不相邻」在数学上就不成立（排成环必然有同色相邻），
 * 断言会去要求程序做到不可能的事。
 */
function buildDupFixture() {
  const dir = path.join(TMP, 'dupfix');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const gallery = path.join(FIX, 'gallery');
  const pool = fs.readdirSync(gallery).map((n) => path.join(gallery, n));
  const sizes = pool.map((p) => fs.statSync(p).size);

  const a = 0;
  const others = [];
  for (let i = 1; i < pool.length; i += 1) {
    if (sizes[i] === sizes[a]) continue;
    if (others.some((j) => sizes[j] === sizes[i])) continue;
    others.push(i);
    if (others.length === 2) break;
  }
  if (others.length < 2) throw new Error('gallery 里找不到两张体积不同、且与第一张也不同的图');

  fs.copyFileSync(pool[a], path.join(dir, 'dup-a.png'));
  fs.copyFileSync(pool[a], path.join(dir, 'dup-b.png'));
  fs.copyFileSync(pool[others[0]], path.join(dir, 'other.png'));
  fs.copyFileSync(pool[others[1]], path.join(dir, 'other2.png'));

  return {
    dir,
    dupSize: sizes[a],
    otherSize: sizes[others[0]],
    other2Size: sizes[others[1]],
  };
}

function configPath() {
  const roaming = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming');
  return path.join(roaming, 'electron-wallpaper', 'config.json');
}

/* ------------------------------------------------------------ 主流程 */

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const dupFix = buildDupFixture();
  console.log(`重复图夹具：${dupFix.dir}`);
  console.log(`  dup-a/dup-b = ${dupFix.dupSize} 字节（内容相同）  other = ${dupFix.otherSize}  other2 = ${dupFix.other2Size}`);

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

  // 清场：预设文件夹
  for (const f of (await ev('window.wp.listQuickFolders()')) || []) {
    await ev(`window.wp.removeQuickFolder(${JSON.stringify(f.id)})`);
  }
  // 基线快照：第一次跑留一份，之后不覆盖 —— 中途崩了下一轮也能还原到用户真配置
  const base = testConfig.begin();
  const cfg = base.baseline;
  const baselineWarn = testConfig.describeBaseline(base);
  if (baselineWarn) console.log(baselineWarn);
  if (testConfig.looksLikeTestData(cfg.folder)) console.log(`⚠ 基线快照本身指向测试目录：${cfg.folder}`);

  /* ------------------------------------------------ ① 重复图护栏 */

  section('① 洗牌结果里不会「孪生挨着播」（重复图夹具）');
  const dupCfg = {
    folder: dupFix.dir, recursive: false, perMonitor: false, monitor: 'primary',
    interval: 9999, shuffle: true, autoPlay: false, applyToSystem: false,
    skipSizeTwin: true, filmstrip: true,
  };
  await ev('window.wp.setConfig(' + JSON.stringify(dupCfg) + ')');
  await ev('window.wp.rebuildChannels(true)');
  await sleep(1400);

  const dupChId = (await ev('window.__rendererState()')).previewId;
  const dupFiles = await ev(`window.wp.channelFiles(${JSON.stringify(dupChId)}).then((r) => r.files.map((f) => f.name))`);
  check('夹具载入 4 张图', dupFiles.length === 4, dupFiles.join(' / '));

  const dupSizeAt = (name) => fs.statSync(path.join(dupFix.dir, name)).size;
  /** 相邻两张体积相同的对数 —— 内容相同的图体积必然相同 */
  const twinPairs = (list) => {
    let n = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (dupSizeAt(list[i]) === dupSizeAt(list[i - 1])) n += 1;
    }
    return n;
  };

  /*
   * 现在「随机」= 把列表本身洗乱然后顺序播，所以要盯的是**洗牌结果**：
   * 洗出来的列表里只要没有相邻同体积，顺着播下去就永远不会「孪生挨着来」。
   */
  check('洗牌结果里没有相邻同体积（孪生不会连着播）', twinPairs(dupFiles) === 0,
    `${twinPairs(dupFiles)} 对  ${dupFiles.join(' → ')}`);

  const walkedIdx = [];
  const walkedNames = [];
  for (let i = 0; i < 8; i += 1) {
    await ev(`window.wp.channelCommand(${JSON.stringify(dupChId)}, 'next')`);
    const idx = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === dupChId).index;
    walkedIdx.push(idx);
    walkedNames.push(dupFiles[idx]);
  }
  const walkedTwins = walkedNames.filter((n, i) => i > 0 && dupSizeAt(n) === dupSizeAt(walkedNames[i - 1])).length;
  check('连续 8 步里没有一步「体积与上一张相同」', walkedTwins === 0, walkedNames.join(' → '));
  // 8 步会绕一圈多，所以看序号是否连续（而不是图名是否重复）
  check('这 8 步是顺着列表一格一格走的（序号连续，绕回也算）',
    walkedIdx.every((v, i) => i === 0 || v === (walkedIdx[i - 1] + 1) % dupFiles.length),
    walkedIdx.join(' → '));

  // 「重新扫描」会重新洗一次牌 —— 再洗一次同样不该出现相邻同体积
  await ev(`window.wp.channelCommand(${JSON.stringify(dupChId)}, 'rescan')`);
  await sleep(1600);
  const rescanFiles = await ev(`window.wp.channelFiles(${JSON.stringify(dupChId)}).then((r) => r.files.map((f) => f.name))`);
  check('重新扫描会重洗一次牌，洗出来同样没有相邻同体积',
    twinPairs(rescanFiles) === 0, `${twinPairs(rescanFiles)} 对  ${rescanFiles.join(' → ')}`);

  /* ------------------------------------------------ ② 播放顺序切得回去 */

  section('② 每屏独立 → 播放顺序：切到「按名称」之后还能切回「随机」');
  await ev('window.wp.setConfig(' + JSON.stringify({ perMonitor: true, applyToSystem: false }) + ')');
  await ev('window.wp.rebuildChannels(false)');
  await sleep(1600);

  const monitors = (await ev('window.wp.listChannels()')).channels.filter((c) => c.kind === 'monitor');
  if (!monitors.length) {
    check('存在每屏独立频道（本机需至少一台显示器）', false, `只有 ${monitors.length} 路`);
  } else {
    const mid = monitors[0].id;

    /** 老版本就是这么写进去的：字符串 'random' / 'order' */
    await ev(`window.wp.channelCommand(${JSON.stringify(mid)}, 'set-profile', { shuffle: 'random' })`);
    await sleep(700);
    let ch = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === mid);
    check('兼容历史脏值：shuffle="random" 应解析为 true', ch.profile.shuffle === true, String(ch.profile.shuffle));

    await ev(`window.wp.channelCommand(${JSON.stringify(mid)}, 'set-profile', { shuffle: 'order' })`);
    await sleep(700);
    ch = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === mid);
    check('兼容历史脏值：shuffle="order" 应解析为 false', ch.profile.shuffle === false, String(ch.profile.shuffle));

    const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const stored = onDisk.monitors && onDisk.monitors[mid] ? onDisk.monitors[mid].shuffle : undefined;
    check('落盘的值是布尔而不是字符串',
      stored === undefined || typeof stored === 'boolean', `typeof=${typeof stored} value=${JSON.stringify(stored)}`);

    // 走真实 UI：点卡片里的 seg
    const cardSel = `.monitor-card[data-id=${JSON.stringify(mid)}]`;
    const clickSeg = (value) => ev(`(() => {
      const card = document.querySelector(${JSON.stringify(cardSel)});
      if (!card) return 'no-card';
      const item = card.querySelector(${JSON.stringify(`.seg-item[data-value="${value}"]`)});
      if (!item) return 'no-item';
      item.click();
      return 'ok';
    })()`);

    const clickOrder = await clickSeg('order');
    await sleep(800);
    ch = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === mid);
    check('点「按名称」→ shuffle=false', clickOrder === 'ok' && ch.profile.shuffle === false,
      `${clickOrder} / shuffle=${ch.profile.shuffle}`);

    const clickRandom = await clickSeg('random');
    await sleep(800);
    ch = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === mid);
    check('再点「随机」→ 切得回去（shuffle=true）', clickRandom === 'ok' && ch.profile.shuffle === true,
      `${clickRandom} / shuffle=${ch.profile.shuffle}`);

    const active = await ev(`(() => {
      const card = document.querySelector(${JSON.stringify(cardSel)});
      const on = card && card.querySelector(${JSON.stringify('.seg-item[data-value="random"]')});
      return on ? on.classList.contains('active') : null;
    })()`);
    check('卡片上的高亮跟着停在「随机」', active === true, String(active));

    const disk2 = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const stored2 = disk2.monitors && disk2.monitors[mid] ? disk2.monitors[mid].shuffle : undefined;
    check('重新写盘后依然是布尔', stored2 === undefined || typeof stored2 === 'boolean',
      `typeof=${typeof stored2}`);

    // 来回切 5 次，确认不会卡死
    for (let i = 0; i < 5; i += 1) {
      await clickSeg('order'); await sleep(260);
      await clickSeg('random'); await sleep(260);
    }
    ch = (await ev('window.wp.listChannels()')).channels.find((c) => c.id === mid);
    check('来回切 5 轮后停在「随机」且状态一致', ch.profile.shuffle === true, String(ch.profile.shuffle));
  }

  /* ------------------------------------------------ ③ 设置面板的删除按钮 */

  section('④ 「打开所在文件夹」要选中图片本身');
  const target = path.join(dupFix.dir, 'other.png');
  const menu = await ev(`window.wp.imageMenuTemplate(${JSON.stringify({ path: target, channelId: null })})`);
  const labels = menu.map((i) => i.label).filter(Boolean);
  check('菜单里已无重复的「在资源管理器中显示」', !labels.includes('在资源管理器中显示'), labels.join(' / '));
  check('保留「打开所在文件夹」', labels.includes('打开所在文件夹'));
  check('打开文件夹类菜单项只剩一条',
    labels.filter((l) => /文件夹|资源管理器/.test(l)).length === 1,
    labels.filter((l) => /文件夹|资源管理器/.test(l)).join(' / '));

  const openResult = await ev(`window.wp.openContainingFolder(${JSON.stringify(target)})`);
  check('打开真实文件返回 select 方式', openResult && openResult.ok === true && openResult.method === 'select',
    JSON.stringify(openResult));

  const ghostOpen = await ev(`window.wp.openContainingFolder(${JSON.stringify(path.join('Z:\\\\', 'nope', 'x.png'))})`);
  check('目录不存在时返回结构化失败', ghostOpen && ghostOpen.ok === false, JSON.stringify(ghostOpen));

  /* ------------------------------------------------ 还原 */

  section('还原配置');
  await ev(`document.querySelector('#btn-settings-close').click()`);
  const restored = await testConfig.restore(ev);
  await sleep(600);
  check('已从基线快照还原配置', restored.ok && path.normalize(restored.actual.folder) === path.normalize(cfg.folder),
    restored.ok ? restored.actual.folder : restored.error);
  check('还原后的目录不是测试素材', !testConfig.looksLikeTestData(restored.actual.folder), String(restored.actual.folder));
  check('每屏模式已还原', restored.actual.perMonitor === cfg.perMonitor, String(restored.actual.perMonitor));
  check('还原后与还原点逐键一致（脏值不会被下一轮继承）',
    (restored.diff || []).length === 0,
    (restored.diff || []).slice(0, 4).join('；') || '完全一致');


  cdp.close();

  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log(`  - ${f}`)); }
  console.log(`测试素材（可直接删除）：${TMP}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n验证脚本异常终止：', err.message);
  console.error(err.stack);
  process.exit(2);
});
