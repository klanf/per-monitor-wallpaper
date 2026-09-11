'use strict';

/**
 * 调度器逻辑单测（不需要启动 Electron，也不会真的改桌面）。
 *
 * 通过注入一个假的 writeWallpaper 替身，可以完整验证：
 *   · 每台显示器是否生成了独立的频道
 *   · 各频道是否指向各自的目录、各自推进索引
 *   · 写入时是否只带了自己的 monitorId（不会串台）
 *   · 改一台的配置会不会影响另一台
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, resolveProfile, DEFAULTS } = require('../src/store');
const { MonitorScheduler, UNIFIED_ID } = require('../src/scheduler');

const RED = path.resolve(__dirname, 'fixtures/monitor-A-red.bmp');
const GREEN = path.resolve(__dirname, 'fixtures/monitor-B-green.bmp');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const FAKE_MONITORS = [
  { id: 'MON-A', index: 0, label: '3840×2160（主显示器）', width: 3840, height: 2160, x: 0, y: 0, primary: true },
  { id: 'MON-B', index: 1, label: '1600×2560', width: 1600, height: 2560, x: -1600, y: 0, primary: false },
];

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sched-'));
  const configPath = path.join(tmpDir, 'config.json');

  // ---- 准备：两屏各指一个只有一张图的目录（用 fixtures 目录本身）----
  const fixtures = path.resolve(__dirname, 'fixtures');
  const dirA = path.join(tmpDir, 'dirA');
  const dirB = path.join(tmpDir, 'dirB');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  fs.copyFileSync(RED, path.join(dirA, 'a-1.bmp'));
  fs.copyFileSync(GREEN, path.join(dirA, 'a-2.bmp'));
  fs.copyFileSync(RED, path.join(dirB, 'b-1.bmp'));
  fs.copyFileSync(GREEN, path.join(dirB, 'b-2.bmp'));

  const store = new Store(configPath);
  store.set({
    folder: dirA,
    perMonitor: true,
    interval: 1,
    applyToSystem: true,
    applyOnStart: false,
    recursive: false,
    monitors: { 'MON-B': { folder: dirB, interval: 1 } },
  });

  const writes = [];
  const events = [];
  const scheduler = new MonitorScheduler({
    store,
    cacheDir: tmpDir,
    enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
    resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
    writeWallpaper: async (imagePath, cacheDir, options) => {
      writes.push({ imagePath: path.basename(imagePath), monitorId: options.monitorId });
      return { ok: true, method: 'test' };
    },
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  /* ================= 1. 频道划分 ================= */
  console.log('\n===== 1. 每屏独立：频道划分 =====');
  await scheduler.rebuild('test');
  const list = scheduler.list();
  check('生成了 2 个频道（每台显示器一个）', list.length === 2, `实际 ${list.length}`);
  check('没有出现统一频道', !list.some((c) => c.id === UNIFIED_ID));
  check('频道 0 绑定 MON-A', list[0] && list[0].monitorId === 'MON-A');
  check('频道 1 绑定 MON-B', list[1] && list[1].monitorId === 'MON-B');
  check('频道 0 用全局目录 dirA', list[0].profile.folder === dirA);
  check('频道 1 用单独目录 dirB', list[1].profile.folder === dirB);
  check('频道 0 有 2 张图', list[0].count === 2, `实际 ${list[0].count}`);
  check('频道 1 有 2 张图', list[1].count === 2, `实际 ${list[1].count}`);

  /* ================= 2. 独立推进 ================= */
  console.log('\n===== 2. 各自推进互不干扰 =====');
  scheduler.setPlaying('MON-A', true);
  scheduler.setPlaying('MON-B', true);

  const startA = scheduler.channels.get('MON-A').index;
  // 等一个 A 的间隔（1 秒）再观察
  await new Promise((r) => setTimeout(r, 1300));

  const afterA = scheduler.channels.get('MON-A').index;
  check('MON-A 自己往前走了', afterA !== startA, `${startA} → ${afterA}`);

  const writesA = writes.filter((w) => w.monitorId === 'MON-A');
  const writesB = writes.filter((w) => w.monitorId === 'MON-B');
  check('写入记录里 MON-A 与 MON-B 分开计数', writesA.length > 0 && writesB.length > 0,
    `A=${writesA.length} B=${writesB.length}`);
  check('每次写入只带自己的 monitorId（没有串台）',
    writes.every((w) => w.monitorId === 'MON-A' || w.monitorId === 'MON-B'));
  check('MON-A 只写 dirA 里的图', writesA.every((w) => w.imagePath.startsWith('a-')));
  check('MON-B 只写 dirB 里的图', writesB.every((w) => w.imagePath.startsWith('b-')));

  /* ================= 3. 暂停隔离 ================= */
  console.log('\n===== 3. 暂停只影响自己 =====');
  scheduler.setPlaying('MON-A', false);
  const frozenA = scheduler.channels.get('MON-A').index;
  const beforeB = scheduler.channels.get('MON-B').index;
  await new Promise((r) => setTimeout(r, 1300));
  check('已被暂停的 MON-A 不再推进', scheduler.channels.get('MON-A').index === frozenA,
    `仍是 ${frozenA}`);
  check('MON-B 仍在推进', scheduler.channels.get('MON-B').index !== beforeB || writesB.length > 2,
    `B: ${beforeB} → ${scheduler.channels.get('MON-B').index}`);
  check('暂停的频道没有产生新的写入',
    writes.filter((w) => w.monitorId === 'MON-A').length === writesA.length);

  /* ================= 4. 改配置只影响目标频道 ================= */
  console.log('\n===== 4. 改一台的配置不影响另一台 =====');
  const dirC = path.join(tmpDir, 'dirC');
  fs.mkdirSync(dirC);
  fs.copyFileSync(RED, path.join(dirC, 'c-1.bmp'));
  fs.copyFileSync(GREEN, path.join(dirC, 'c-2.bmp'));
  fs.copyFileSync(RED, path.join(dirC, 'c-3.bmp'));

  store.setMonitorProfile('MON-A', { folder: dirC, interval: 5 });
  await scheduler.rebuild('profile');

  const after = scheduler.list();
  const chA = after.find((c) => c.id === 'MON-A');
  const chB = after.find((c) => c.id === 'MON-B');
  check('MON-A 目录已换成 dirC', chA.profile.folder === dirC);
  check('MON-A 新目录 3 张图已载入', chA.count === 3, `实际 ${chA.count}`);
  check('MON-A 间隔已改为 5 秒', chA.profile.interval === 5);
  check('MON-B 目录未被动过', chB.profile.folder === dirB);
  check('MON-B 间隔未被动过', chB.profile.interval === 1, `实际 ${chB.profile.interval}`);

  /* ================= 5. 配置继承 ================= */
  console.log('\n===== 5. 单屏覆盖 / 继承顶层默认值 =====');
  check('MON-B 未设的字段继承顶层 duration',
    chB.profile.duration === store.get().duration, `${chB.profile.duration}`);
  check('MON-A 未设的字段同样继承 animation',
    chA.profile.animation === store.get().animation);

  store.set({ duration: 777 });
  check('改顶层默认值会带动没覆盖该项的单屏',
    resolveProfile(store.get(), 'MON-B').duration === 777,
    `实际 ${resolveProfile(store.get(), 'MON-B').duration}`);
  check('但已单独设过间隔的 MON-B 不受默认值影响',
    resolveProfile(store.get(), 'MON-B').interval === 1,
    `实际 ${resolveProfile(store.get(), 'MON-B').interval}`);
  check('MON-A 单独设过的间隔同样不受影响',
    resolveProfile(store.get(), 'MON-A').interval === 5);

  /* ================= 6. 接管开关 ================= */
  console.log('\n===== 6. 单屏接管开关 =====');
  store.setMonitorProfile('MON-A', { enabled: false });
  await scheduler.rebuild('disable');
  const disabled = scheduler.list().find((c) => c.id === 'MON-A');
  check('MON-A 已标记为不接管', disabled.enabled === false);
  await scheduler.goTo('MON-A', 0, 1, 'test');
  const lastWrite = disabled.lastWrite || scheduler.channels.get('MON-A').lastWrite;
  check('未接管的频道不会写壁纸', lastWrite && lastWrite.skipped === true,
    `method=${lastWrite && lastWrite.method}`);

  /* ================= 7. 配置落盘格式 ================= */
  console.log('\n===== 7. 配置文件只留差异 =====');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  check('monitors 里只存了 MON-A / MON-B',
    Object.keys(saved.monitors || {}).sort().join(',') === 'MON-A,MON-B',
    JSON.stringify(Object.keys(saved.monitors || {})));
  check('MON-B 只存了与顶层不同的 folder / interval',
    Object.keys(saved.monitors['MON-B']).sort().join(',') === 'folder,interval',
    JSON.stringify(Object.keys(saved.monitors['MON-B'])));

  scheduler.stop();

  /* ================= 8. 统一模式回退 ================= */
  console.log('\n===== 8. 关掉每屏模式 → 回到单频道 =====');
  store.set({ perMonitor: false });
  const s2 = new MonitorScheduler({
    store,
    cacheDir: tmpDir,
    enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
    resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
    writeWallpaper: async () => ({ ok: true, method: 'test' }),
  });
  await s2.rebuild('unified');
  const u = s2.list();
  check('只剩 1 个频道', u.length === 1, `实际 ${u.length}`);
  check('它就是统一频道', u[0].id === UNIFIED_ID);
  check('统一模式目标为「全部显示器」', u[0].label === '全部显示器');
  s2.stop();

  /* ================= 9. 重建后已丢弃的频道不许再写桌面 ================= */
  /*
   * 场景：某路频道的定时器刚响、_advance 正卡在「写壁纸」那一步时发生重建。
   *
   * 拦截这件事其实有两道防线：
   *   ① goTo 是按 id 回查 this.channels 的 —— 已丢弃的频道查不到，直接返回，
   *      不会继续往后走 _emit('tick') / _schedule()；
   *   ② 频道上的 retired 标记（_rebuild 里打的）+ 各处 if (ch.retired) return ——
   *      让已经越过第 ① 道检查、还在途中的那一轮也停手。
   * 这条测试锁的是**可观测契约**：重建之后，被丢弃的频道一次都不许再写桌面。
   * 用「可以卡住的写入函数」把这个时序做成确定性的，不靠碰运气。
   */
  console.log('\n===== 9. 重建期间在途的一轮：不能复活已丢弃的频道 =====');

  let gated = false;
  const releases = [];
  const gatedWrites = [];

  store.set({
    perMonitor: true,
    interval: 1,
    autoPlay: true,
    applyOnStart: false,      // 不要开场接管，写入次数才可数
    folder: dirA,
    // 前面几节改过 MON-A 的覆盖项（含 enabled:false），这里显式给两台都重设一遍
    monitors: {
      'MON-A': { folder: dirA, interval: 1, enabled: true, shuffle: false },
      'MON-B': { folder: dirB, interval: 1, enabled: true, shuffle: false },
    },
  });

  const g2 = new MonitorScheduler({
    store,
    cacheDir: tmpDir,
    enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
    resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
    writeWallpaper: async (imagePath, cacheDir, options) => {
      gatedWrites.push({ file: path.basename(imagePath), monitorId: options.monitorId });
      if (gated) await new Promise((r) => releases.push(r));
      return { ok: true, method: 'test' };
    },
    onEvent: () => {},
  });
  await g2.rebuild('setup');
  check('两路频道就绪（间隔 1 秒）', g2.list().length === 2, `实际 ${g2.list().length}`);

  gated = true;
  await new Promise((r) => setTimeout(r, 1300));      // 让两路的定时器各响一次
  check('两路都卡在「写壁纸」这一步上', releases.length === 2, `stalled=${releases.length}`);
  const frozen = gatedWrites.length;

  // 切到统一模式，并且让新频道既不接管也不自动轮播 —— 这样它自己一次都不会写
  store.set({ perMonitor: false, autoPlay: false, applyOnStart: false });
  const rebuilding = g2.rebuild('switch-to-unified');  // 故意不 await

  await new Promise((r) => setTimeout(r, 400));
  check('重建会先等在途的写入收尾（此刻还没建出新频道）',
    g2.list().length === 0, `list=${g2.list().length}`);
  check('等待期间一次都没有新的写入', gatedWrites.length === frozen, `写入 ${gatedWrites.length}`);

  gated = false;
  releases.splice(0).forEach((r) => r());             // 放行在途的那两轮
  await rebuilding;

  const afterSwitch = g2.list();
  check('放行后重建完成，只剩统一频道', afterSwitch.length === 1 && afterSwitch[0].id === UNIFIED_ID,
    afterSwitch.map((c) => c.id).join(', '));

  await new Promise((r) => setTimeout(r, 2600));      // 够野定时器再响一声（间隔 1 秒）

  check('已丢弃的频道没有重新武装自己（重建后一次都没再写）',
    gatedWrites.length === frozen, `写入次数 ${frozen} → ${gatedWrites.length}`);
  check('写入全都发生在重建之前',
    gatedWrites.every((w) => ['MON-A', 'MON-B'].includes(w.monitorId)),
    gatedWrites.map((w) => w.monitorId).join(', '));

  /* ================= 10. 随机 = 把列表本身洗乱，不是「随机跳索引」 ================= */
  /*
   * 用户的诉求（原话）：「打开程序的时候先做乱序排序，然后就按乱序的顺序切换壁纸」。
   * 这样列表顺序 = 播放顺序，胶片条上左边是刚看过的、右边是将要看的，
   * 「上一张看的是哪张」一眼就能找回来。
   * 随机跳索引的写法位置会乱飞（下一步可能从第 1 格跳到第 100 格），历史无从追踪。
   */
  console.log('\n===== 10. 随机 = 把列表本身洗乱 =====');
  const dirS = path.join(tmpDir, 'dirS');
  fs.mkdirSync(dirS, { recursive: true });
  const N = 12;
  for (let i = 0; i < N; i += 1) {
    // 每张字节数都不同，免得孪生整理把顺序又搅一遍
    fs.writeFileSync(path.join(dirS, `s-${String(i).padStart(2, '0')}.bmp`),
      Buffer.concat([fs.readFileSync(RED), Buffer.alloc(i + 1)]));
  }
  const nameOrder = Array.from({ length: N }, (_, i) => `s-${String(i).padStart(2, '0')}.bmp`);

  store.set({
    perMonitor: true,
    applyOnStart: false,
    monitors: { 'MON-B': { folder: dirS, interval: 1, shuffle: true, skipSizeTwin: false } },
  });
  await scheduler.rebuild('shuffle-test');
  scheduler.setPlaying('MON-B', false);            // 不让定时器掺进来
  const shuffledNames = scheduler.channels.get('MON-B').files.map((f) => f.name);

  check('载入 12 张', shuffledNames.length === N, `实际 ${shuffledNames.length}`);
  check('列表被打乱了（不等于文件名顺序）',
    shuffledNames.join(',') !== nameOrder.join(','), `前 4 个：${shuffledNames.slice(0, 4).join(' ')}`);
  check('乱序后还是同一批文件（没丢也没多）',
    shuffledNames.slice().sort().join(',') === nameOrder.join(','));

  store.set({ monitors: { 'MON-B': { interval: 3 } } });
  await scheduler.rebuild('interval-change');
  check('改个间隔不会把胶片条的顺序打乱（洗牌结果跟着扫描缓存走）',
    scheduler.channels.get('MON-B').files.map((f) => f.name).join(',') === shuffledNames.join(','));

  store.set({ monitors: { 'MON-B': { shuffle: false } } });
  await scheduler.rebuild('order-mode');
  check('切到「按名称」恢复文件名顺序',
    scheduler.channels.get('MON-B').files.map((f) => f.name).join(',') === nameOrder.join(','));

  store.set({ monitors: { 'MON-B': { shuffle: true } } });
  await scheduler.rebuild('back-to-shuffle');
  const backNames = scheduler.channels.get('MON-B').files.map((f) => f.name);
  check('切回「随机」会重新洗一次（不是把上次的顺序搬回来）',
    backNames.join(',') !== nameOrder.join(',')
      && backNames.slice().sort().join(',') === nameOrder.join(','),
    `前 4 个：${backNames.slice(0, 4).join(' ')}`);

  /* ================= 11. 播放顺着列表一格一格走 ================= */
  console.log('\n===== 11. 播放顺着列表走：上一张就在左边一格 =====');
  const startIdx = scheduler.channels.get('MON-B').index;
  const walked = [startIdx];
  for (let k = 0; k < N; k += 1) {
    await scheduler.step('MON-B', 1);
    walked.push(scheduler.channels.get('MON-B').index);
  }
  check('连续 N 次「下一张」的序号是连续递增的（一格一格挪，不会跳到第 100 页）',
    walked.every((v, i) => i === 0 || v === (walked[i - 1] + 1) % N),
    walked.slice(0, 8).join(' → ') + ' → …');
  check('一圈走完回到起点', scheduler.channels.get('MON-B').index === startIdx);
  check('这 N 步每格都不同（一轮内没有重复）', new Set(walked.slice(0, N)).size === N);

  const atIdx = scheduler.channels.get('MON-B').index;
  await scheduler.step('MON-B', -1);
  check('「上一张」正好退回一格',
    scheduler.channels.get('MON-B').index === (atIdx - 1 + N) % N,
    `${atIdx} → ${scheduler.channels.get('MON-B').index}`);

  /* ================= 12. 删掉一张：剩余顺序不变、当前帧不跳 ================= */
  console.log('\n===== 12. 删掉一张：剩下的顺序不变、当前帧不跳 =====');
  const chSel = scheduler.channels.get('MON-B');
  const beforeNames = chSel.files.map((f) => f.name);
  const beforeIndex = chSel.index;
  const beforeCurrent = beforeNames[beforeIndex];
  // 挑一张在当前帧**之后**的（绕圈了就往前挑），这样索引本来就不该动
  const victimPos = beforeIndex + 2 < beforeNames.length ? beforeIndex + 2 : beforeIndex - 2;
  const victimEntry = chSel.files[victimPos];

  scheduler.applyFileMutation(victimEntry.path, null);

  const afterNames = chSel.files.map((f) => f.name);
  check('张数 -1', afterNames.length === N - 1, `${beforeNames.length} → ${afterNames.length}`);
  check('剩下文件的相对顺序一点没变（不是重新洗了一遍）',
    afterNames.join(',') === beforeNames.filter((n) => n !== victimEntry.name).join(','),
    afterNames.slice(0, 4).join(' '));
  // 索引按位移规则对齐：删的在当前之前 → 整体前移一格；之后 → 不动
  const expectIndex = victimPos < beforeIndex ? beforeIndex - 1 : beforeIndex;
  check('索引按位移规则对齐（删的位置在不在当前之前）',
    chSel.index === expectIndex,
    `${beforeIndex} → ${chSel.index}（删的是 #${victimPos}，期望 ${expectIndex}）`);
  check('画面还是同一张图', chSel.files[chSel.index].name === beforeCurrent,
    `${beforeCurrent} → ${chSel.files[chSel.index].name}`);

  /* ================= 13. 洗牌结果里没有相邻的两张体积相同 ================= */
  console.log('\n===== 13. 洗牌结果里没有相邻的两张体积相同 =====');
  /*
   * 一对内容完全相同的图（同一张存了日文名、罗马音两份，图库里实测有 70 组）
   * 挨着播，看起来就是同一张连着来了两次。
   *
   * 夹具用 4 张：一对孪生 + 两张体积互不相同的。
   * 不用 3 张是因为那种配置下「孪生不相邻」在数学上不成立
   * （排成环必然有同色相邻），断言会去要求程序做不到的事。
   */
  const dirT = path.join(tmpDir, 'dirT');
  fs.mkdirSync(dirT, { recursive: true });
  fs.copyFileSync(RED, path.join(dirT, 't-0.bmp'));
  fs.copyFileSync(RED, path.join(dirT, 't-1.bmp'));   // 与 t-0 字节完全相同 → 体积相同

  const redSize = fs.statSync(RED).size;
  const pool = fs.readdirSync(path.resolve(__dirname, 'fixtures', 'gallery'))
    .filter((f) => /\.(png|jpe?g|bmp|webp)$/i.test(f))
    .map((f) => {
      const p = path.resolve(__dirname, 'fixtures', 'gallery', f);
      return { p, size: fs.statSync(p).size };
    });
  const uniq = [];
  for (const x of pool) {
    if (x.size === redSize) continue;
    if (uniq.some((u) => u.size === x.size)) continue;
    uniq.push(x);
    if (uniq.length === 2) break;
  }
  if (uniq.length < 2) throw new Error('gallery 里找不到两张体积不同、且与 RED 也不同的图');
  fs.copyFileSync(uniq[0].p, path.join(dirT, 't-2.png'));
  fs.copyFileSync(uniq[1].p, path.join(dirT, 't-3.png'));

  /** 相邻两张体积相同的对数。列表是循环播的，所以首尾相接那一步也算 */
  const twinsIn = (list, circular = true) => {
    let n = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (fs.statSync(list[i].path).size === fs.statSync(list[i - 1].path).size) n += 1;
    }
    if (circular && list.length > 1
      && fs.statSync(list[0].path).size === fs.statSync(list[list.length - 1].path).size) n += 1;
    return n;
  };

  store.set({ monitors: { 'MON-B': { folder: dirT, shuffle: true, skipSizeTwin: true } } });
  await scheduler.rebuild('twin-on');
  const chTwin = scheduler.channels.get('MON-B');
  check('孪生夹具是 4 张（其中两张字节相同）', chTwin.files.length === 4, `实际 ${chTwin.files.length}`);
  check('开启护栏：洗牌结果里没有相邻同体积', twinsIn(chTwin.files) === 0,
    `${twinsIn(chTwin.files)} 对`);

  // 对照：关掉护栏，拿同一份夹具反复洗，总该撞上
  store.set({ monitors: { 'MON-B': { skipSizeTwin: false } } });
  await scheduler.rebuild('twin-off');
  const loose = scheduler.channels.get('MON-B').files.slice();
  let looseTwins = 0;
  for (let round = 0; round < 20; round += 1) {
    await scheduler._shuffleFiles(loose, false);      // 显式不整理
    looseTwins += twinsIn(loose);
  }
  check('关闭护栏做对照：20 次洗牌里出现了相邻同体积', looseTwins > 0,
    `${looseTwins} 对 / 20 次`);

  /* ================= 14. 换目录后旧的「看过」不该跟着搬 ================= */
  console.log('\n===== 14. 换目录后旧的「看过」标记不残留 =====');
  /*
   * played 是跨 rebuild 复用的（为了让胶片条的「看过」不因为改个间隔就清空），
   * 但换目录时必须清 —— 序号是下标，新目录的第 3 张和旧目录的第 3 张毫无关系，
   * 留着就会把新目录里没看过的图标成「看过」。
   */
  store.set({ monitors: { 'MON-B': { folder: dirS, interval: 1, shuffle: false, skipSizeTwin: false } } });
  await scheduler.rebuild('played-a');
  scheduler.setPlaying('MON-B', false);
  for (let k = 0; k < 5; k += 1) await scheduler.step('MON-B', 1);
  const playedBefore = scheduler.playedIndices('MON-B').length;
  check('在 dirS 上攒下了播放记录', playedBefore >= 5, `played=${playedBefore}`);

  store.set({ monitors: { 'MON-B': { folder: dirT, interval: 1, shuffle: false, skipSizeTwin: true } } });
  await scheduler.rebuild('played-b');
  const playedAfter = scheduler.playedIndices('MON-B').length;
  check('换目录后旧的「看过」已清空（只剩当前这张）', playedAfter <= 1, `played=${playedAfter}`);

  /* ================= 15. 走完一轮会重洗（每轮顺序不同） ================= */
  console.log('\n===== 15. 走完一轮会重洗：每轮顺序都不一样 =====');
  store.set({ monitors: { 'MON-B': { folder: dirS, shuffle: true, skipSizeTwin: false, interval: 1 } } });
  await scheduler.rebuild('round-reshuffle');
  scheduler.setPlaying('MON-B', false);
  const chR = scheduler.channels.get('MON-B');

  const order1 = chR.files.map((f) => f.name);
  const rounds0 = chR.rounds;

  let guard1 = 0;
  while (chR.index !== chR.files.length - 1 && guard1 < 60) {
    await scheduler.step('MON-B', 1);
    guard1 += 1;
  }
  const lastOfRound = chR.files[chR.index].name;
  check('走到了本轮最后一张', chR.index === chR.files.length - 1, `index=${chR.index}`);

  await scheduler.step('MON-B', 1);          // 正向绕回开头 → 触发重洗

  const order2 = chR.files.map((f) => f.name);
  check('轮次 +1', chR.rounds === rounds0 + 1, `${rounds0} → ${chR.rounds}`);
  check('新一轮的顺序和上一轮不同', order2.join(',') !== order1.join(','),
    `第 1 轮前 4 个：${order1.slice(0, 4).join(' ')} ／ 第 2 轮：${order2.slice(0, 4).join(' ')}`);
  check('重洗后还是同一批文件（没丢没多）',
    order2.slice().sort().join(',') === order1.slice().sort().join(','));
  check('重洗后从新一轮的第一张开始', chR.index === 0, `index=${chR.index}`);
  check('刚刚那张被挪到末尾，画面不跳',
    chR.files[chR.files.length - 1].name === lastOfRound,
    `末尾=${chR.files[chR.files.length - 1].name}  刚播=${lastOfRound}`);
  check('新一轮的「看过」标记清空了（只剩当前这张）', chR.played.size <= 1,
    `played=${chR.played.size}`);

  // 再走完一轮 → 又该重洗
  let guard2 = 0;
  while (chR.index !== chR.files.length - 1 && guard2 < 60) {
    await scheduler.step('MON-B', 1);
    guard2 += 1;
  }
  await scheduler.step('MON-B', 1);
  check('第二轮走完再次重洗', chR.rounds === rounds0 + 2, `rounds=${chR.rounds}`);
  check('第三轮的顺序又不同了',
    chR.files.map((f) => f.name).join(',') !== order2.join(','));

  // 「上一张」绕回去不该触发重洗
  const beforePrev = chR.rounds;
  chR.index = 0;
  await scheduler.step('MON-B', -1);
  check('「上一张」绕回末尾不触发重洗', chR.rounds === beforePrev, `rounds=${chR.rounds}`);

  /* ================= 16. 删掉的文件不能从扫描缓存里复活 ================= */
  /*
   * 场景：删掉一张 → 之后发生一次频道重建（改间隔、切每屏独立、插拔显示器都算）。
   *
   * 频道手里的列表是扫描结果**排序/洗牌后的副本**，删掉的那张只从副本里消失，
   * 扫描缓存里还留着 —— 不主动作废缓存的话，重建时它会被重新捞回来，
   * 于是列表里出现一个磁盘上已经不存在的路径，轮到它就会黑洞一下。
   */
  console.log('\n===== 16. 删除后重建：被删的图不会复活 =====');
  const dirG = path.join(tmpDir, 'dirG');
  fs.mkdirSync(dirG, { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    fs.copyFileSync(RED, path.join(dirG, `g-${i}.bmp`));
  }

  store.set({ perMonitor: true, autoPlay: false, folder: dirG, monitors: { 'MON-B': { folder: dirG, interval: 3600, shuffle: false } } });
  await scheduler.rebuild('g-setup');
  scheduler.setPlaying('MON-B', false);

  const chG = scheduler.channels.get('MON-B');
  check('夹具 5 张', chG.files.length === 5, `实际 ${chG.files.length}`);

  const victimG = chG.files[2].path;
  scheduler.applyFileMutation(victimG, null);
  fs.rmSync(victimG);                                   // 磁盘上也删掉，模拟进回收站
  check('就地更新后剩 4 张', chG.files.length === 4, `${chG.files.length}`);
  check('列表里已经没有那个路径', !chG.files.some((f) => f.path === victimG));

  await scheduler.rebuild('g-rebuild');
  const chG2 = scheduler.channels.get('MON-B');
  check('重建后仍然是 4 张（没有从缓存里复活）', chG2.files.length === 4, `${chG2.files.length}`);
  check('重建后列表里每个路径都真实存在',
    chG2.files.every((f) => fs.existsSync(f.path)),
    chG2.files.filter((f) => !fs.existsSync(f.path)).map((f) => f.name).join(', ') || '全部存在');

  /* ================= 17. 删除后重建，正在看的那张不能被顶走 ================= */
  /*
   * rebuild 时索引是从 progress（播放进度）里取的，而 progress 只有 goTo 会写。
   * applyFileMutation 只改 ch.index 不同步 progress 的话，删掉一张之后
   * 只要发生一次重建，索引就会被那份过期进度顶回原位 —— 画面莫名跳走。
   */
  console.log('\n===== 17. 删除后重建：正在看的那张不能被顶走 =====');
  const dirH = path.join(tmpDir, 'dirH');
  fs.mkdirSync(dirH, { recursive: true });
  for (let i = 0; i < 6; i += 1) fs.copyFileSync(RED, path.join(dirH, `h-${i}.bmp`));

  store.set({ perMonitor: true, autoPlay: false, folder: dirH, monitors: { 'MON-B': { folder: dirH, interval: 3600, shuffle: false } } });
  await scheduler.rebuild('h-setup');
  scheduler.setPlaying('MON-B', false);
  await scheduler.goTo('MON-B', 3, 1, 'test');          // 走到第 4 张，进度写进 progress
  const chH = scheduler.channels.get('MON-B');
  const watching = chH.files[chH.index].name;
  check('先停在第 4 张上', chH.index === 3, `index=${chH.index} 当前=${watching}`);

  const victimH = chH.files[1].path;                    // 删掉当前帧**之前**的那张
  scheduler.applyFileMutation(victimH, null);
  fs.rmSync(victimH);
  check('删掉前面那张后索引跟着前移一格', chH.index === 2, `${chH.index}`);
  check('画面还是同一张', chH.files[chH.index].name === watching,
    `${chH.files[chH.index].name} vs ${watching}`);

  await scheduler.rebuild('h-rebuild');
  const chH2 = scheduler.channels.get('MON-B');
  check('重建后索引没有被过期进度顶回原位', chH2.index === 2, `index=${chH2.index}`);
  check('重建后画面仍然是同一张', chH2.files[chH2.index].name === watching,
    `${chH2.files[chH2.index].name} vs ${watching}`);

  /* ================= 18. 每屏独立：没单独配的屏回落顶层目录 ================= */

  console.log('\n===== 18. 每屏独立：没单独配的屏回落到顶层目录 =====');
  {
    /*
     * 这条撑着「开箱即用」：全新安装时 monitors 是空的，程序自动打开每屏独立之后，
     * 每块屏必须都回落到顶层 folder 才有东西可播 —— 否则用户会看到一堆空频道，
     * 还不如不自动开。端到端测不到这个状态（渲染层没有清掉单屏覆盖的接口），所以放这里。
     */
    const fresh = {
      ...DEFAULTS,
      folder: 'D:\\pics',
      perMonitor: true,
      monitors: {},
    };
    check('全新安装：每块屏都回落顶层 folder',
      resolveProfile(fresh, 'MON-A').folder === 'D:\\pics'
      && resolveProfile(fresh, 'MON-B').folder === 'D:\\pics',
      resolveProfile(fresh, 'MON-A').folder);

    const withOverride = { ...fresh, monitors: { 'MON-A': { folder: 'D:\\vertical' } } };
    check('单独配过的屏用自己的目录',
      resolveProfile(withOverride, 'MON-A').folder === 'D:\\vertical',
      resolveProfile(withOverride, 'MON-A').folder);
    check('没配的那块屏仍然回落顶层（两块屏可以一套配、一套不配）',
      resolveProfile(withOverride, 'MON-B').folder === 'D:\\pics',
      resolveProfile(withOverride, 'MON-B').folder);

    check('顶层 folder 为空时不会瞎编一个目录',
      resolveProfile({ ...fresh, folder: '' }, 'MON-A').folder === '',
      JSON.stringify(resolveProfile({ ...fresh, folder: '' }, 'MON-A').folder));

    // 其它 profile 键也遵守同一套回落规则（间隔 / 动画 / 填充方式）
    const mixed = { ...fresh, interval: 60, fit: 'cover', monitors: { 'MON-A': { interval: 30 } } };
    check('间隔也按屏回落（配过的用 30，没配的用 60）',
      resolveProfile(mixed, 'MON-A').interval === 30 && resolveProfile(mixed, 'MON-B').interval === 60,
      `${resolveProfile(mixed, 'MON-A').interval} / ${resolveProfile(mixed, 'MON-B').interval}`);
    check('填充方式同样回落', resolveProfile(mixed, 'MON-B').fit === 'cover',
      resolveProfile(mixed, 'MON-B').fit);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试崩溃:', err);
  process.exit(2);
});
