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

const { Store, resolveProfile, DEFAULTS, SETTINGS_TABS } = require('../src/store');
const { MonitorScheduler, UNIFIED_ID } = require('../src/scheduler');

const RED = path.resolve(__dirname, 'fixtures/monitor-A-red.bmp');
const GREEN = path.resolve(__dirname, 'fixtures/monitor-B-green.bmp');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

/** 造一个只含一个目录的相簿 —— 大部分测试用例需要的最小相簿 */
function singleFolderAlbum(name, folderPath) {
  return { id: `alb_test_${name}`, name, folders: [{ path: folderPath, enabled: true }] };
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
  const albumA = singleFolderAlbum('A', dirA);
  const albumB = singleFolderAlbum('B', dirB);
  store.set({
    albumId: albumA.id,
    albums: [albumA, albumB],
    perMonitor: true,
    interval: 1,
    applyToSystem: true,
    applyOnStart: false,
    recursive: false,
    monitors: { 'MON-B': { albumId: albumB.id, interval: 1 } },
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
  check('频道 0 用顶层相簿 A', list[0].profile.albumId === albumA.id);
  check('频道 1 用单独相簿 B', list[1].profile.albumId === albumB.id);
  check('频道 0 报出相簿名', list[0].albumName === 'A');
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
  const albumC = singleFolderAlbum('C', dirC);
  store.set({ albums: [...store.get().albums, albumC] });

  store.setMonitorProfile('MON-A', { albumId: albumC.id, interval: 5 });
  await scheduler.rebuild('profile');

  const after = scheduler.list();
  const chA = after.find((c) => c.id === 'MON-A');
  const chB = after.find((c) => c.id === 'MON-B');
  check('MON-A 相簿已换成 C', chA.profile.albumId === albumC.id);
  check('MON-A 新相簿 3 张图已载入', chA.count === 3, `实际 ${chA.count}`);
  check('MON-A 间隔已改为 5 秒', chA.profile.interval === 5);
  check('MON-B 相簿未被动过', chB.profile.albumId === albumB.id);
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
  check('MON-B 只存了与顶层不同的 albumId / interval',
    Object.keys(saved.monitors['MON-B']).sort().join(',') === 'albumId,interval',
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
    albumId: albumA.id,
    // 前面几节改过 MON-A 的覆盖项（含 enabled:false），这里显式给两台都重设一遍
    monitors: {
      'MON-A': { albumId: albumA.id, interval: 1, enabled: true, shuffle: false },
      'MON-B': { albumId: albumB.id, interval: 1, enabled: true, shuffle: false },
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
  const albumS = singleFolderAlbum('S', dirS);

  store.set({
    perMonitor: true,
    applyOnStart: false,
    albums: [...store.get().albums, albumS],
    monitors: { 'MON-B': { albumId: albumS.id, interval: 1, shuffle: true, skipSizeTwin: false } },
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
  const albumT = singleFolderAlbum('T', dirT);
  store.set({ albums: [...store.get().albums, albumT] });
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

  store.set({ monitors: { 'MON-B': { albumId: albumT.id, shuffle: true, skipSizeTwin: true } } });
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
  store.set({ monitors: { 'MON-B': { albumId: albumS.id, interval: 1, shuffle: false, skipSizeTwin: false } } });
  await scheduler.rebuild('played-a');
  scheduler.setPlaying('MON-B', false);
  for (let k = 0; k < 5; k += 1) await scheduler.step('MON-B', 1);
  const playedBefore = scheduler.playedIndices('MON-B').length;
  check('在 dirS 上攒下了播放记录', playedBefore >= 5, `played=${playedBefore}`);

  store.set({ monitors: { 'MON-B': { albumId: albumT.id, interval: 1, shuffle: false, skipSizeTwin: true } } });
  await scheduler.rebuild('played-b');
  const playedAfter = scheduler.playedIndices('MON-B').length;
  check('换目录后旧的「看过」已清空（只剩当前这张）', playedAfter <= 1, `played=${playedAfter}`);

  /* ================= 15. 走完一轮会重洗（每轮顺序不同） ================= */
  console.log('\n===== 15. 走完一轮会重洗：每轮顺序都不一样 =====');
  store.set({ monitors: { 'MON-B': { albumId: albumS.id, shuffle: true, skipSizeTwin: false, interval: 1 } } });
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
  const albumG = singleFolderAlbum('G', dirG);

  store.set({ perMonitor: true, autoPlay: false, albumId: albumG.id, albums: [...store.get().albums, albumG], monitors: { 'MON-B': { albumId: albumG.id, interval: 3600, shuffle: false } } });
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
  const albumH = singleFolderAlbum('H', dirH);

  store.set({ perMonitor: true, autoPlay: false, albumId: albumH.id, albums: [...store.get().albums, albumH], monitors: { 'MON-B': { albumId: albumH.id, interval: 3600, shuffle: false } } });
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

  /* ================= 18. 每屏独立：没单独配的屏回落顶层相簿 ================= */

  console.log('\n===== 18. 每屏独立：没单独配的屏回落到顶层相簿 =====');
  {
    /*
     * 这条撑着「开箱即用」：全新安装时 monitors 是空的，程序自动打开每屏独立之后，
     * 每块屏必须都回落到顶层相簿才有东西可播 —— 否则用户会看到一堆空频道，
     * 还不如不自动开。端到端测不到这个状态（渲染层没有清掉单屏覆盖的接口），所以放这里。
     */
    const fresh = {
      ...DEFAULTS,
      albumId: 'alb_pics',
      albums: [{ id: 'alb_pics', name: 'pics', folders: [{ path: 'D:\\pics', enabled: true }] }],
      perMonitor: true,
      monitors: {},
    };
    check('全新安装：每块屏都回落顶层相簿',
      resolveProfile(fresh, 'MON-A').albumId === 'alb_pics'
      && resolveProfile(fresh, 'MON-B').albumId === 'alb_pics',
      resolveProfile(fresh, 'MON-A').albumId);

    const withOverride = { ...fresh, monitors: { 'MON-A': { albumId: 'alb_vertical' } } };
    check('单独配过的屏用自己的相簿',
      resolveProfile(withOverride, 'MON-A').albumId === 'alb_vertical',
      resolveProfile(withOverride, 'MON-A').albumId);
    check('没配的那块屏仍然回落顶层（两块屏可以一套配、一套不配）',
      resolveProfile(withOverride, 'MON-B').albumId === 'alb_pics',
      resolveProfile(withOverride, 'MON-B').albumId);

    check('顶层没绑相簿时不会瞎编一个',
      resolveProfile({ ...fresh, albumId: '' }, 'MON-A').albumId === '',
      JSON.stringify(resolveProfile({ ...fresh, albumId: '' }, 'MON-A').albumId));

    // 其它 profile 键也遵守同一套回落规则（间隔 / 动画 / 填充方式）
    const mixed = { ...fresh, interval: 60, fit: 'cover', monitors: { 'MON-A': { interval: 30 } } };
    check('间隔也按屏回落（配过的用 30，没配的用 60）',
      resolveProfile(mixed, 'MON-A').interval === 30 && resolveProfile(mixed, 'MON-B').interval === 60,
      `${resolveProfile(mixed, 'MON-A').interval} / ${resolveProfile(mixed, 'MON-B').interval}`);
    check('填充方式同样回落', resolveProfile(mixed, 'MON-B').fit === 'cover',
      resolveProfile(mixed, 'MON-B').fit);
  }

  /* ================= 19. 相簿 = 多目录的自由组合 ================= */
  console.log('\n===== 19. 相簿：多目录按序拼接、来源标注、路径去重 =====');
  {
    const dirP = path.join(tmpDir, 'dirP');
    const dirQ = path.join(tmpDir, 'dirQ');
    fs.mkdirSync(dirP);
    fs.mkdirSync(dirQ);
    fs.copyFileSync(RED, path.join(dirP, 'p-1.bmp'));
    fs.copyFileSync(GREEN, path.join(dirP, 'p-2.bmp'));
    fs.copyFileSync(RED, path.join(dirQ, 'q-1.bmp'));
    fs.copyFileSync(GREEN, path.join(dirQ, 'q-2.bmp'));

    // dirQ 里塞一个与 dirP 中完全相同的路径场景不好造 —— 用嵌套目录做去重：
    // 相簿同时包含 dirQ 和 dirQ/nested（recursive 时 nested 的图已在 dirQ 结果里）
    const dirNested = path.join(dirQ, 'nested');
    fs.mkdirSync(dirNested);
    fs.copyFileSync(RED, path.join(dirNested, 'n-1.bmp'));

    const albumMulti = {
      id: 'alb_multi',
      name: '组合相簿',
      folders: [
        { path: dirQ, enabled: true },      // 故意把 Q 排前面，验证「目录顺序即列表顺序」
        { path: dirNested, enabled: true }, // 与 dirQ 的递归扫描重叠 → 验证路径级去重
        { path: dirP, enabled: true },
      ],
    };
    store.set({
      perMonitor: true,
      autoPlay: false,
      applyOnStart: false,
      albumId: albumMulti.id,
      albums: [...store.get().albums, albumMulti],
      recursive: true,
      shuffle: false,
      monitors: { 'MON-B': { albumId: albumMulti.id, interval: 3600 } },
    });
    await scheduler.rebuild('album-multi');
    scheduler.setPlaying('MON-B', false);
    const chM = scheduler.channels.get('MON-B');

    check('三个目录拼出 5 张（nested 的 n-1 与 dirQ 递归结果重叠，只算一次）',
      chM.files.length === 5, `实际 ${chM.files.length}`);
    check('n-1 只出现一次（路径级去重生效）',
      chM.files.filter((f) => f.name === 'n-1.bmp').length === 1,
      chM.files.map((f) => f.name).join(' '));
    check('目录顺序即列表顺序：Q（含 nested）在前、P 在后',
      chM.files.slice(0, 3).every((f) => f.dir === dirQ)
      && chM.files.slice(3).every((f) => f.dir === dirP && f.name.startsWith('p-')),
      chM.files.map((f) => f.name).join(' '));
    check('每个条目都带 dir 来源标注',
      chM.files.every((f) => f.dir && [dirP, dirQ].includes(f.dir)),
      chM.files.map((f) => path.basename(f.dir)).join(','));
    check('list() 报出相簿名', scheduler.list().find((c) => c.id === 'MON-B').albumName === '组合相簿');

    /* 停用目录：enabled=false 的目录不参与扫描 */
    const albumPartial = {
      id: 'alb_partial',
      name: '部分停用',
      folders: [
        { path: dirP, enabled: false },     // 停用 P
        { path: dirQ, enabled: true },
      ],
    };
    store.set({
      albums: store.get().albums.map((a) => (a.id === albumMulti.id ? albumPartial : a)),
      monitors: { 'MON-B': { albumId: albumPartial.id } },
    });
    await scheduler.rebuild('album-partial');
    const chP = scheduler.channels.get('MON-B');
    check('停用的目录不参与轮播（只剩 Q 递归出的 3 张）', chP.files.length === 3, `实际 ${chP.files.length}`);
    check('停用的目录不出现在列表里', !chP.files.some((f) => f.dir === dirP));

    /* 缺失目录：不炸相簿，标注 missingDirs */
    const albumMissing = {
      id: 'alb_missing',
      name: '带失效目录',
      folders: [
        { path: path.join(tmpDir, 'no-such-dir'), enabled: true },
        { path: dirP, enabled: true },
      ],
    };
    store.set({
      albums: store.get().albums.map((a) => (a.id === 'alb_partial' ? albumMissing : a)),
      monitors: { 'MON-B': { albumId: albumMissing.id } },
    });
    await scheduler.rebuild('album-missing');
    const info = scheduler.list().find((c) => c.id === 'MON-B');
    check('失效目录被跳过，相簿仍有图可播', info.count === 2, `实际 ${info.count}`);
    check('失效目录被标注在 missingDirs 里',
      info.missingDirs.length === 1 && info.missingDirs[0].endsWith('no-such-dir'),
      JSON.stringify(info.missingDirs));
  }

  /* ================= 20. 往相簿加目录不打断播放 ================= */
  console.log('\n===== 20. 往相簿加目录：正在看的不跳、顺序保留、新图追加 =====');
  {
    const dirX1 = path.join(tmpDir, 'dirX1');
    const dirX2 = path.join(tmpDir, 'dirX2');
    fs.mkdirSync(dirX1);
    fs.mkdirSync(dirX2);
    for (let i = 0; i < 6; i += 1) {
      fs.copyFileSync(RED, path.join(dirX1, `x1-${i}.bmp`));
      fs.copyFileSync(GREEN, path.join(dirX2, `x2-${i}.bmp`));
    }
    const albumX = singleFolderAlbum('X1', dirX1);
    store.set({
      perMonitor: true,
      autoPlay: false,
      applyOnStart: false,
      albumId: albumX.id,
      albums: [...store.get().albums, albumX],
      shuffle: true,
      skipSizeTwin: false,
      monitors: { 'MON-B': { albumId: albumX.id, interval: 3600 } },
    });
    await scheduler.rebuild('album-grow-before');
    scheduler.setPlaying('MON-B', false);
    const chX = scheduler.channels.get('MON-B');
    const beforeOrder = chX.files.map((f) => f.name);
    const beforeCurrent = chX.files[chX.index] ? chX.files[chX.index].path : null;

    // 相簿加进第二个目录（模拟设置面板的「添加目录」：同一个相簿 id，folders 变了）
    const grown = {
      ...albumX,
      folders: [
        { path: dirX1, enabled: true },
        { path: dirX2, enabled: true },
      ],
    };
    store.set({ albums: store.get().albums.map((a) => (a.id === albumX.id ? grown : a)) });
    await scheduler.rebuild('album-grow-after');
    const chX2 = scheduler.channels.get('MON-B');   // rebuild 会重建频道对象，必须重新取

    const afterOrder = chX2.files.map((f) => f.name);
    check('加目录后张数 6 → 12', chX2.files.length === 12, `${beforeOrder.length} → ${afterOrder.length}`);
    check('原有 6 张的相对顺序原样保留（没有重洗）',
      afterOrder.slice(0, 6).join(',') === beforeOrder.join(','));
    check('新目录的图接在列表末尾',
      afterOrder.slice(6).every((n) => n.startsWith('x2-')),
      afterOrder.slice(6).join(' '));
    check('当前这张没有被顶走', chX2.files[chX2.index] && chX2.files[chX2.index].path === beforeCurrent,
      `${beforeCurrent} → ${chX2.files[chX2.index] && chX2.files[chX2.index].path}`);
  }

  /* ================= 21. 旧配置自动迁移 ================= */
  console.log('\n===== 21. 旧版 folder 配置读入时自动包装成相簿 =====');
  {
    const legacyPath = path.join(tmpDir, 'legacy-config.json');
    fs.writeFileSync(legacyPath, JSON.stringify({
      interval: 60,
      folder: dirA,
      monitors: { 'MON-B': { folder: dirB, interval: 1 } },
    }, null, 2), 'utf8');
    const legacyStore = new Store(legacyPath);
    const legacyCfg = legacyStore.get();

    check('旧顶层 folder 变成了相簿', Array.isArray(legacyCfg.albums) && legacyCfg.albums.length === 2,
      `${(legacyCfg.albums || []).length}`);
    check('相簿名取目录名', legacyCfg.albums.map((a) => a.name).sort().join(',') === 'dirA,dirB',
      legacyCfg.albums.map((a) => a.name).join(','));
    check('顶层频道绑到了自动生成的相簿',
      legacyCfg.albums.some((a) => a.id === legacyCfg.albumId && a.folders[0].path === dirA));
    check('MON-B 的覆盖也换成了相簿引用',
      legacyCfg.monitors['MON-B'].albumId
      && legacyCfg.albums.some((a) => a.id === legacyCfg.monitors['MON-B'].albumId
        && a.folders[0].path === dirB));
    check('旧 folder 字段已清掉', legacyCfg.folder === '' && !('folder' in legacyCfg.monitors['MON-B']));

    // 相簿内重复目录去重（大小写不敏感）
    const deduped = require('../src/store').normalizeAlbums([{
      id: 'alb_dup', name: 'dup',
      folders: [{ path: dirA }, { path: dirA.toUpperCase() }],
    }]);
    check('同一目录在相簿里只保留一份（大小写不敏感）', deduped[0].folders.length === 1,
      `${deduped[0].folders.length}`);
  }

  /* ================= 22. 旧播放记录（按目录路径存）也能找回进度 ================= */
  console.log('\n===== 22. 升级后旧进度记录兼容：按路径认亲 =====');
  {
    const legacyDirP = path.join(tmpDir, 'dirP');   // 19 节块作用域里的 dirP 已出栈，按路径重建
    const playbackPath = path.join(tmpDir, 'playback.json');
    // 把 MON-B 重新绑回「带失效目录」的相簿（含 dirP）：20 节把它绑去了 albumX
    store.set({ perMonitor: true, monitors: { 'MON-B': { albumId: 'alb_missing' } } });
    // 旧版记录：folder 是目录路径、没有 album 字段
    fs.writeFileSync(playbackPath, JSON.stringify({
      version: 1,
      channels: {
        'MON-B': { path: path.join(legacyDirP, 'p-2.bmp'), index: 1, folder: legacyDirP, playing: false, at: Date.now() },
      },
    }, null, 2), 'utf8');
    const { PlaybackState } = require('../src/playbackState');
    const pb = new PlaybackState(playbackPath);

    const s3 = new MonitorScheduler({
      store,
      cacheDir: tmpDir,
      playback: pb,
      enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
      resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
      writeWallpaper: async () => ({ ok: true, method: 'test' }),
      onEvent: () => {},
    });
    await s3.rebuild('legacy-progress');
    const chL = s3.channels.get('MON-B');
    const idx = chL ? chL.files.findIndex((f) => f.name === 'p-2.bmp') : -1;
    check('旧记录的路径命中：从那张图继续播', chL && chL.index === idx,
      `index=${chL && chL.index}，期望（p-2 在第 ${idx} 位）`);
    s3.stop();
  }

  /* ================= 23. 兼容层：相簿已存在时旧 folder 载荷仍可换算 ================= */
  console.log('\n===== 23. 兼容层：旧 folder 载荷在已有相簿时也能换算 =====');
  {
    const dirY = path.join(tmpDir, 'dirY');
    fs.mkdirSync(dirY);
    fs.copyFileSync(RED, path.join(dirY, 'y-1.bmp'));

    // 旧脚本 / 旧入口还在发 setConfig({ folder })——此刻相簿列表非空，也要能换算
    const albumsBefore = store.get().albums.length;
    store.set({ perMonitor: false, folder: dirY, applyOnStart: false });
    const cfgY = store.get();
    const albumY = cfgY.albums.find((a) => a.folders.length === 1
      && a.folders[0].path.toLowerCase() === dirY.toLowerCase());
    check('已有相簿时 set({ folder }) 也能换成相簿引用',
      Boolean(albumY) && cfgY.albumId === albumY.id && cfgY.folder === '',
      `albums ${albumsBefore} → ${cfgY.albums.length}`);

    // set-profile 的旧 { folder } 载荷落到单屏覆盖上
    store.setMonitorProfile('MON-B', { folder: dirY, interval: 5 });
    const ovY = store.get().monitors['MON-B'];
    check('set-profile 的旧 folder 载荷落到 albumId 上',
      Boolean(ovY.albumId) && ovY.albumId === albumY.id && !('folder' in ovY),
      JSON.stringify(ovY));

    const profY = resolveProfile(store.get(), 'MON-B');
    check('profile.folder 派生出目录路径（status.js / 旧断言兼容）',
      profY.folder.toLowerCase() === dirY.toLowerCase() && profY.albumId === albumY.id,
      profY.folder || '(空)');

    // 多目录相簿没有单一「目录」可言，派生 folder 留空
    const dirZ = path.join(tmpDir, 'dirZ');
    fs.mkdirSync(dirZ);
    store.set({
      albums: [...store.get().albums, {
        id: 'alb_multi23', name: '多目录',
        folders: [{ path: dirY, enabled: true }, { path: dirZ, enabled: true }],
      }],
      albumId: 'alb_multi23',
    });
    const profM = resolveProfile(store.get(), null);
    check('多目录相簿不派生 folder（留空）',
      profM.albumId === 'alb_multi23' && profM.folder === '', profM.folder);

    // 幂等：空 patch 再触发一遍兜底迁移，不应重复建相簿
    const n1 = store.get().albums.length;
    store.set({});
    check('换算是幂等的：空 patch 不会再建相簿',
      store.get().albums.length === n1, `${n1} → ${store.get().albums.length}`);
  }

  /* ================= 24. 已删除的图片：跳过 / 摘除 / 立即补一张 ================= */
  console.log('\n===== 24. 切到已删除的图片：静默跳过、就地摘除、立即补一张 =====');
  {
    const dirDel = path.join(tmpDir, 'dirDel');
    fs.mkdirSync(dirDel);
    for (const n of ['d-1.bmp', 'd-2.bmp', 'd-3.bmp']) fs.copyFileSync(RED, path.join(dirDel, n));

    const albumDel = { id: 'alb_del24', name: '删除测试', folders: [{ path: dirDel, enabled: true }] };
    store.set({
      perMonitor: true,
      autoPlay: false,
      applyToSystem: true,
      applyOnStart: false,
      albums: [...store.get().albums, albumDel],
      monitors: { 'MON-A': { albumId: albumDel.id, interval: 5 } },
    });

    const delWrites = [];
    const delEvents = [];
    const sDel = new MonitorScheduler({
      store,
      cacheDir: tmpDir,
      enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
      resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
      writeWallpaper: async (imagePath) => {
        delWrites.push(path.basename(imagePath));
        return { ok: true, method: 'test' };
      },
      onEvent: (type, payload) => delEvents.push({ type, payload }),
    });
    await sDel.rebuild('test-del');
    const chDel = sDel.channels.get('MON-A');
    const revBefore = chDel.rev;

    // 模拟外部删除（资源管理器 / Syncthing）：文件从磁盘上没了，但播放列表还不知道
    fs.unlinkSync(path.join(dirDel, 'd-2.bmp'));
    delWrites.length = 0;
    delEvents.length = 0;

    await sDel.goTo('MON-A', 1, 1, 'timer');   // 正好切到那张已被删掉的图

    check('不去写已删除的那张', !delWrites.includes('d-2.bmp'), `写入序列 ${delWrites.join(',') || '(无)'}`);
    check('同一拍内直接补上下一张', delWrites[0] === 'd-3.bmp', `实际 ${delWrites[0] || '(无)'}`);
    check('已删除的条目从列表里摘掉', !chDel.files.some((f) => f.name === 'd-2.bmp'));
    check('列表数量随之减一', chDel.files.length === 2, `实际 ${chDel.files.length}`);
    check('列表修订号自增（渲染层据此重取列表）', chDel.rev > revBefore, `${revBefore} → ${chDel.rev}`);

    const tickDel = delEvents.filter((e) => e.type === 'tick').pop();
    check('tick 广播的是真正写上去的那张图',
      Boolean(tickDel && tickDel.payload.entry)
        && path.basename(tickDel.payload.entry.path) === 'd-3.bmp',
      tickDel && tickDel.payload.entry ? path.basename(tickDel.payload.entry.path) : '(无)');
    check('tick 带上跳过统计（供聚合提示）',
      Boolean(tickDel && tickDel.payload.skipped) && tickDel.payload.skipped.dropped === 1,
      JSON.stringify(tickDel && tickDel.payload.skipped));
    check('频道状态里留下跳过记录（卡片显示「已跳过 N 张失效」）',
      Boolean(chDel.lastSkip) && chDel.lastSkip.total === 1, JSON.stringify(chDel.lastSkip));
    check('成功补写之后错误状态被清掉', chDel.lastError === null, String(chDel.lastError));
    sDel.stop();
  }

  /* ================= 25. 读不出来的图片：本轮跳过 / 不摘除 / 不反复重试 ================= */
  console.log('\n===== 25. 读不出来的图片：本轮跳过、不摘除、不再反复重试 =====');
  {
    const dirBad = path.join(tmpDir, 'dirBad');
    fs.mkdirSync(dirBad);
    for (const n of ['x-1.bmp', 'x-2.webp', 'x-3.bmp']) fs.copyFileSync(RED, path.join(dirBad, n));

    const albumBad = { id: 'alb_bad25', name: '坏图测试', folders: [{ path: dirBad, enabled: true }] };
    store.set({
      albums: [...store.get().albums, albumBad],
      monitors: { 'MON-A': { albumId: albumBad.id, interval: 5 }, 'MON-B': { albumId: albumB.id, interval: 5 } },
    });

    const attempts = [];
    const sBad = new MonitorScheduler({
      store,
      cacheDir: tmpDir,
      enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
      resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
      writeWallpaper: async (imagePath) => {
        const name = path.basename(imagePath);
        attempts.push(name);
        if (name === 'x-2.webp') {
          // 半同步 / 损坏文件的典型报错（不是「文件不存在」）
          return { ok: false, method: 'transcode', error: '无法解码图片（可能损坏或还没同步完成）：x-2.webp' };
        }
        return { ok: true, method: 'test' };
      },
      onEvent: () => {},
    });
    await sBad.rebuild('test-bad');
    const chBad = sBad.channels.get('MON-A');
    attempts.length = 0;

    await sBad.goTo('MON-A', 1, 1, 'timer');   // 切到读不出来的那张

    check('坏图不会留在桌面上（换下一张写）', attempts.includes('x-3.bmp'), `尝试序列 ${attempts.join(',') || '(无)'}`);
    check('坏图仍留在列表里（不摘除，稍后还能重试）', chBad.files.length === 3, `实际 ${chBad.files.length}`);
    check('坏图被标记，本次会话内不再尝试', chBad.badFiles.size === 1, `标记 ${chBad.badFiles.size} 个`);
    check('状态区分「读不出来」与「已删除」',
      Boolean(chBad.lastSkip) && chBad.lastSkip.bad === 1 && chBad.lastSkip.dropped === 0,
      JSON.stringify(chBad.lastSkip));

    const before = attempts.length;
    await sBad.goTo('MON-A', 1, 1, 'timer');   // 再切到它一次
    check('再次经过坏图不会再试写它', !attempts.slice(before).includes('x-2.webp'),
      `本轮尝试 ${attempts.slice(before).join(',') || '(无)'}`);
    sBad.stop();
  }

  /* ================= 26. 大面积失效：一次切换摘掉一批 → 触发重扫 ================= */
  console.log('\n===== 26. 大面积失效：整批摘掉后触发重扫（不逐张试错） =====');
  {
    const dirMass = path.join(tmpDir, 'dirMass');
    fs.mkdirSync(dirMass);
    const massNames = [];
    for (let i = 1; i <= 15; i += 1) {
      const n = `m-${String(i).padStart(2, '0')}.bmp`;
      massNames.push(n);
      fs.copyFileSync(RED, path.join(dirMass, n));
    }

    const albumMass = { id: 'alb_mass26', name: '大面积失效', folders: [{ path: dirMass, enabled: true }] };
    store.set({
      albums: [...store.get().albums, albumMass],
      monitors: { 'MON-A': { albumId: albumMass.id, interval: 5 }, 'MON-B': { albumId: albumB.id, interval: 5 } },
    });

    const massWrites = [];
    const sMass = new MonitorScheduler({
      store,
      cacheDir: tmpDir,
      enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
      resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
      writeWallpaper: async (imagePath) => {
        massWrites.push(path.basename(imagePath));
        return { ok: true, method: 'test' };
      },
      onEvent: () => {},
    });
    await sMass.rebuild('test-mass');

    const rescanned = [];
    sMass.rescan = async (id) => { rescanned.push(id); };   // 只验证「有触发」，不真去扫盘

    for (const n of massNames.slice(0, 13)) fs.unlinkSync(path.join(dirMass, n));

    await sMass.goTo('MON-A', 0, 1, 'timer');

    const chMass = sMass.channels.get('MON-A');
    check('一次切换把整批失效条目摘干净', chMass.files.length === 2, `实际 ${chMass.files.length}`);
    check('摘掉一批之后仍补上可用的一张', massWrites.length === 1, `写入 ${massWrites.join(',') || '(无)'}`);
    check('触发重扫拿真实列表', rescanned.includes('MON-A'), JSON.stringify(rescanned));
    sMass.stop();
  }

  /* ================= 27. 定时自动扫描 ================= */
  console.log('\n===== 27. 定时自动扫描相簿 =====');
  {
    const dirScan = path.join(tmpDir, 'dirScan');
    fs.mkdirSync(dirScan);
    for (const n of ['s-1.bmp', 's-2.bmp']) fs.copyFileSync(RED, path.join(dirScan, n));

    const albumScan = { id: 'alb_scan27', name: '自动扫描测试', folders: [{ path: dirScan, enabled: true }] };
    store.set({
      albums: [...store.get().albums, albumScan],
      monitors: { 'MON-A': { albumId: albumScan.id, interval: 5 } },
      autoScanMinutes: 0,
    });

    const scanEvents = [];
    const sScan = new MonitorScheduler({
      store,
      cacheDir: tmpDir,
      enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
      resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
      writeWallpaper: async () => ({ ok: true, method: 'test' }),
      onEvent: (type, payload) => scanEvents.push({ type, payload }),
    });
    await sScan.rebuild('test-scan');

    check('默认（0 分钟）不装定时器', sScan.scanTimer === null);
    check('默认配置就是关闭定时扫描', DEFAULTS.autoScanMinutes === 0, String(DEFAULTS.autoScanMinutes));

    // ---- 配置收紧：非法值与越界值都要落回可预期的值 ----
    store.set({ autoScanMinutes: 0.4 });
    check('不足 1 分钟被收紧为关闭', store.get().autoScanMinutes === 0, String(store.get().autoScanMinutes));
    store.set({ autoScanMinutes: 9999 });
    check('超过一天被收紧为 1440 分钟', store.get().autoScanMinutes === 1440, String(store.get().autoScanMinutes));
    store.set({ autoScanMinutes: 'abc' });
    check('非数字落回默认值 0', store.get().autoScanMinutes === 0, String(store.get().autoScanMinutes));

    // ---- 开启后定时器装上，改配置立即重新计时 ----
    store.set({ autoScanMinutes: 30 });
    await sScan.rebuild('config');
    check('开启后装上了定时器', sScan.scanTimer !== null);

    // ---- 核心行为：扫描到新图、清掉已删的图、当前这张不动 ----
    const chScan = sScan.channels.get('MON-A');
    await sScan.goTo('MON-A', 1, 1, 'goto');        // 停在第 2 张（s-2.bmp）
    const beforePaths = chScan.files.map((f) => f.name);
    const currentName = chScan.files[chScan.index].name;

    // 外部变动：删掉一张、新增一张（Syncthing / ComfyUI 的日常）
    fs.unlinkSync(path.join(dirScan, 's-1.bmp'));
    fs.copyFileSync(GREEN, path.join(dirScan, 's-3.bmp'));
    scanEvents.length = 0;

    await sScan.autoScan();

    const chAfter = sScan.channels.get('MON-A');
    const afterPaths = chAfter.files.map((f) => f.name);
    check('自动扫描发现了新加的图', afterPaths.includes('s-3.bmp'), afterPaths.join(','));
    check('已删的图从列表里消失', !afterPaths.includes('s-1.bmp'), afterPaths.join(','));
    check('当前正在显示的那张没变（画面不跳）',
      chAfter.files[chAfter.index] && chAfter.files[chAfter.index].name === currentName,
      `${currentName} → ${chAfter.files[chAfter.index] && chAfter.files[chAfter.index].name}`);
    check('留在列表里的旧图相对顺序不变（不洗牌）',
      beforePaths.filter((n) => afterPaths.includes(n)).join(',')
        === afterPaths.filter((n) => beforePaths.includes(n)).join(','),
      `${beforePaths.join(',')} → ${afterPaths.join(',')}`);
    check('新图接在列表末尾而不是插队', afterPaths[afterPaths.length - 1] === 's-3.bmp', afterPaths.join(','));
    check('记录了上次扫描的时刻', sScan.lastAutoScanAt > 0, String(sScan.lastAutoScanAt));
    check('扫描完会广播给渲染层（设置里显示「上次扫描 …」）',
      scanEvents.some((e) => e.type === 'channels' && e.payload.reason === 'auto-scan'));

    // ---- 定时器真的会开火（绕开 1 分钟下限，直接给个 1.2 秒的间隔）----
    store.data.autoScanMinutes = 0.02;
    sScan._armAutoScan();
    const firedBefore = sScan.lastAutoScanAt;
    await new Promise((r) => setTimeout(r, 1600));
    check('定时器到点自动触发扫描', sScan.lastAutoScanAt > firedBefore,
      `${firedBefore} → ${sScan.lastAutoScanAt}`);

    // ---- stop() 之后不再触发 ----
    sScan.stop();
    check('stop() 之后定时器被清掉', sScan.scanTimer === null);
  }

  // ============================================================ §28 =====
  console.log('\n§28 设置面板分类页 settingsTab');
  {
    const tabPath = path.join(tmpDir, 'cfg-tab.json');
    const mk = (raw) => {
      fs.writeFileSync(tabPath, JSON.stringify({ ...DEFAULTS, ...raw }));
      return new Store(tabPath).get().settingsTab;
    };

    check('默认停在第一页「轮播」', DEFAULTS.settingsTab === 'play', DEFAULTS.settingsTab);
    check('四个分类页的 id 与顺序固定', SETTINGS_TABS.join(',') === 'play,look,action,system', SETTINGS_TABS.join(','));
    check('合法值原样保留', mk({ settingsTab: 'system' }) === 'system');
    check('四个 id 都能存住',
      ['play', 'look', 'action', 'system'].every((t) => mk({ settingsTab: t }) === t));
    check('拼错的值退回第一页（面板不会变空白）', mk({ settingsTab: 'playback' }) === 'play');
    check('空字符串退回第一页', mk({ settingsTab: '' }) === 'play');
    check('null / 数字这类脏值也退回第一页',
      mk({ settingsTab: null }) === 'play' && mk({ settingsTab: 7 }) === 'play');
    check('不写这个键时取默认值', mk({}) === 'play');

    // 写盘 → 重读：真正落回磁盘的才是「记住上次那一页」
    fs.writeFileSync(tabPath, JSON.stringify({ ...DEFAULTS, settingsTab: 'action' }));
    const reread = new Store(tabPath);
    check('重新读盘后还是上次那一页', reread.get().settingsTab === 'action', reread.get().settingsTab);
    reread.set({ settingsTab: 'look' });
    check('改完再读一次也对得上', new Store(tabPath).get().settingsTab === 'look');
  }

  // ============================================================ §29 =====
  /* ================= 29. 动态桌面降频写：锚点才写系统壁纸 ================= */
  console.log('\n===== 29. 动态桌面降频写：锚点才写系统壁纸 =====');
  {
    // 先停掉 1 秒间隔的轮播定时器 —— 否则 degraded=true 期间 timer 触发的
    // goTo 会真写系统壁纸，把下面的写入计数搅乱（手动 step 不检查 playing，照常可用）
    scheduler.pauseAll();

    const ch = 'MON-A';
    const writesBefore = writes.length;

    store.set({ liveWallpaper: true });

    // 非锚点时机（command = 手动翻页）→ 不写
    await scheduler.step(ch, 1);
    check('动态开着：手动翻页不写系统壁纸', writes.length === writesBefore,
      `写入数 ${writesBefore} → ${writes.length}`);
    check('翻页结果以 live-skip 记账（UI 能显示原因）',
      scheduler.channels.get(ch).lastWrite.method === 'live-skip',
      `${scheduler.channels.get(ch).lastWrite.method} / why=${scheduler.channels.get(ch).lastWrite.why}`);

    // 锚点时机（stop）→ 两个频道各真写一次
    await scheduler.anchorSystem();
    check('动态开着：anchorSystem（reason=stop）每频道真写一次', writes.length === writesBefore + 2,
      `写入数 ${writesBefore} → ${writes.length}`);

    // 降级兜底：动态窗口失效 → 恢复每轮都写
    scheduler.isLiveDegraded = () => true;
    await scheduler.step(ch, 1);
    check('动态窗口失效（degraded）：翻页恢复写兜底', writes.length === writesBefore + 3,
      `写入数 → ${writes.length}`);
    check('degraded 的判定依据进了 lastWrite.why',
      scheduler.channels.get(ch).lastWrite.why === 'degraded-fallback' || writes.length > writesBefore + 3);
    scheduler.isLiveDegraded = () => false;

    // 动态关掉 → 立即回到原行为（live-off）
    store.set({ liveWallpaper: false });
    await scheduler.step(ch, 1);
    check('动态关掉：翻页照旧写（老行为不变）', writes.length === writesBefore + 4,
      `写入数 → ${writes.length}`);
  }

  /* ================= 30. 冻结停表：全屏/锁屏/电池时连调度都停（48 轮） ================= */
  console.log('\n===== 30. 冻结频道停表 =====');
  {
    const dirFrozen = path.join(tmpDir, 'dirFrozen');
    fs.mkdirSync(dirFrozen);
    for (const n of ['f-1.bmp', 'f-2.bmp']) fs.copyFileSync(RED, path.join(dirFrozen, n));
    const albumF = { id: 'alb_frozen30', name: '冻结', folders: [{ path: dirFrozen, enabled: true }] };
    store.set({
      albums: [...store.get().albums, albumF],
      liveWallpaper: false,
      perMonitor: true,
      monitors: {
        'MON-A': { albumId: albumF.id, interval: 1 },
        'MON-B': { albumId: albumB.id, interval: 1 },
      },
    });

    const frozenWrites = [];
    let frozen = true;
    const sFrozen = new MonitorScheduler({
      store,
      cacheDir: tmpDir,
      enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
      resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
      writeWallpaper: async (imagePath, cacheDir, options) => {
        frozenWrites.push({ img: path.basename(imagePath), monitorId: options.monitorId });
        return { ok: true, method: 'test' };
      },
      onEvent: () => {},
      isFrozen: (id) => (id === 'MON-A' ? frozen : false),   // 只有 MON-A 被冻结
    });
    await sFrozen.rebuild('test-frozen');
    sFrozen.setPlaying('MON-A', true);
    sFrozen.setPlaying('MON-B', true);
    const writesA = () => frozenWrites.filter((w) => w.monitorId === 'MON-A').length;
    const idxA = sFrozen.channels.get('MON-A').index;
    const idxB = sFrozen.channels.get('MON-B').index;

    await new Promise((r) => setTimeout(r, 1600));   // 冻结中：1s 间隔到点也不推进
    check('冻结中的频道不推进、不写壁纸',
      sFrozen.channels.get('MON-A').index === idxA && writesA() === 0,
      `index ${idxA} → ${sFrozen.channels.get('MON-A').index}，MON-A 写入 ${writesA()}`);
    check('冻结只影响自己：未冻结的 MON-B 照常推进',
      sFrozen.channels.get('MON-B').index !== idxB,
      `index ${idxB} → ${sFrozen.channels.get('MON-B').index}`);

    frozen = false;                                  // 解冻：最多 1 秒后恢复切换
    await new Promise((r) => setTimeout(r, 1600));
    check('解冻后恢复推进（≤1s 兜底重试生效）',
      sFrozen.channels.get('MON-A').index !== idxA,
      `index ${idxA} → ${sFrozen.channels.get('MON-A').index}`);
    sFrozen.stop();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试崩溃:', err);
  process.exit(2);
});
