'use strict';

/**
 * 「重启后接着上次那张播」的验证（不需要启动 Electron，也不会真的改桌面）。
 *
 * 关键手法：同一个测试里**先后建两个 scheduler 实例**，每个实例配一个
 * 从磁盘重新读出来的 Store —— 这就是「关掉程序再开机」的最小模型。
 * 写入函数是假的，所以能完整走调度逻辑而不碰用户的桌面。
 *
 * 为什么单独测这一条：随机模式下列表每次启动都会重洗，
 * 序号存下来**必然指到另一张图上**。这条测试就是用来钉住「按路径找回」的。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store');
const { MonitorScheduler, UNIFIED_ID } = require('../src/scheduler');
const { PlaybackState, MAX_AGE_MS } = require('../src/playbackState');

const RED = path.resolve(__dirname, 'fixtures/monitor-A-red.bmp');

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

/** 造一个目录，每张图字节数都不同（免得孪生整理再搅一遍顺序） */
function makeDir(root, name, count) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const base = fs.readFileSync(RED);
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(
      path.join(dir, `${name}-${String(i).padStart(2, '0')}.bmp`),
      Buffer.concat([base, Buffer.alloc(i + 1)]),
    );
  }
  return dir;
}

const base = (p) => path.basename(p);

function makeScheduler(store, cacheDir, playback, writes) {
  return new MonitorScheduler({
    store,
    cacheDir,
    playback,
    enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
    resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
    writeWallpaper: async (imagePath, _cacheDir, options) => {
      writes.push({ file: path.basename(imagePath), monitorId: options.monitorId });
      return { ok: true, method: 'test' };
    },
    onEvent: () => {},
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-resume-'));
  const configPath = path.join(tmp, 'config.json');
  const statePath = path.join(tmp, 'playback.json');
  const dirA = makeDir(tmp, 'A', 12);
  const dirB = makeDir(tmp, 'B', 9);
  const dirC = makeDir(tmp, 'C', 6);

  /* ============ 1. 第一个进程：播到几张，然后「关机」 ============ */
  console.log('\n===== 1. 第一个进程：播几张后退出 =====');
  const store = new Store(configPath);
  store.set({
    perMonitor: true,
    folder: dirA,
    interval: 3600,
    autoPlay: false,
    applyOnStart: false,     // 先不开接管，写入次数才可数
    shuffle: true,           // 复现用户的配置：随机模式
    skipSizeTwin: false,
    recursive: false,
    monitors: { 'MON-B': { folder: dirB } },
  });

  const pb1 = new PlaybackState(statePath);
  const s1 = makeScheduler(store, tmp, pb1, []);
  await s1.rebuild('startup');

  // 模拟「播了一阵子」：两路各自停在不同位置
  await s1.goTo('MON-A', 7, 1, 'test');
  await s1.goTo('MON-B', 4, 1, 'test');

  const chA1 = s1.channels.get('MON-A');
  const chB1 = s1.channels.get('MON-B');
  const wantA = chA1.files[chA1.index].path;
  const wantB = chB1.files[chB1.index].path;
  const orderA1 = chA1.files.map((f) => f.name).join(',');

  check('两路停在不同位置', wantA !== wantB, `A#${chA1.index}=${base(wantA)}  B#${chB1.index}=${base(wantB)}`);

  s1.stop();                 // 退出程序（内部会 flush）

  check('退出后落下了存档文件', fs.existsSync(statePath), statePath.replace(tmp, '<tmp>'));

  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  check('存档带版本号与 channels 段', raw.version === 1 && !!raw.channels);
  check('存的是**路径**（不是只有序号）',
    raw.channels['MON-A'] && raw.channels['MON-A'].path === wantA,
    base(raw.channels['MON-A'] ? raw.channels['MON-A'].path : ''));
  check('两路各记各的，互不覆盖',
    raw.channels['MON-A'].index === 7 && raw.channels['MON-B'].index === 4
      && raw.channels['MON-B'].path === wantB,
    `A=${raw.channels['MON-A'].index} B=${raw.channels['MON-B'].index}`);

  /* ============ 2. 第二个进程：重新启动 = 开机自启 ============ */
  console.log('\n===== 2. 第二个进程：重启后接着上次那张播 =====');
  const store2 = new Store(configPath);         // 重新读盘 —— 相当于新进程
  const pb2 = new PlaybackState(statePath);
  store2.set({ applyOnStart: true });           // 用户开着「启动时立即接管」

  const writes2 = [];
  const s2 = makeScheduler(store2, tmp, pb2, writes2);
  await s2.rebuild('startup');

  const chA2 = s2.channels.get('MON-A');
  const chB2 = s2.channels.get('MON-B');
  const orderA2 = chA2.files.map((f) => f.name).join(',');

  check('MON-A 回到上次那张（靠路径找回）',
    chA2.files[chA2.index].path === wantA,
    `${base(chA2.files[chA2.index].path)}（期望 ${base(wantA)}）`);
  check('MON-B 同样回到上次那张',
    chB2.files[chB2.index].path === wantB,
    `${base(chB2.files[chB2.index].path)}（期望 ${base(wantB)}）`);
  check('恢复后索引指向的就是那张图（不是「序号恰好撞上」）',
    chA2.index === chA2.files.findIndex((f) => f.path === wantA),
    `index=${chA2.index}`);
  check('列表顺序已经重洗过（与上次进程不同）',
    orderA2 !== orderA1,
    orderA2 !== orderA1 ? '→ 正因如此，只存序号必然指错图' : '（本轮恰好洗出同序，重跑即可）');
  check('两路位置没有串台',
    chA2.files[chA2.index].path !== chB2.files[chB2.index].path);

  const takeoverA = writes2.filter((w) => w.monitorId === 'MON-A');
  check('开机接管时写上去的就是上次那张',
    takeoverA.length > 0 && takeoverA[0].file === base(wantA),
    takeoverA.length ? base(takeoverA[0].file) : '（没有写入）');

  /* ============ 3. 起点的优先级：内存进度 > 磁盘存档 ============ */
  console.log('\n===== 3. 同一次会话内改配置，不该被磁盘存档顶回旧位置 =====');
  await s2.goTo('MON-A', 2, 1, 'test');          // 用户在本次会话里切到第 3 张
  const nowA = s2.channels.get('MON-A').files[2].path;
  store2.set({ interval: 999 });                 // 改个间隔 → 触发重建
  await s2.rebuild('profile');
  const chA3 = s2.channels.get('MON-A');
  check('重建后停在本会话刚看的那张（没被存档顶回去）',
    chA3.files[chA3.index].path === nowA,
    `${base(chA3.files[chA3.index].path)}（期望 ${base(nowA)}）`);

  /* ============ 4. 关掉开关 → 回到第一张 ============ */
  console.log('\n===== 4. 关掉「记住上次播放位置」→ 老行为（从第一张开始） =====');
  store2.set({ resumeLast: false, interval: 3600 });
  const pb4 = new PlaybackState(statePath);
  const s4 = makeScheduler(store2, tmp, pb4, []);
  await s4.rebuild('startup');
  check('关闭后从第一张开始', s4.channels.get('MON-A').index === 0, `index=${s4.channels.get('MON-A').index}`);

  const before = pb4.get('MON-A') ? pb4.get('MON-A').index : null;
  await s4.goTo('MON-A', 9, 1, 'test');
  const after = pb4.get('MON-A') ? pb4.get('MON-A').index : null;
  check('关闭后不再更新存档（不留下跨会话痕迹）', before === after, `存档 index ${before} → ${after}`);
  s4.stop();

  /* ============ 5. 换了目录 → 老记录不认 ============ */
  console.log('\n===== 5. 换了目录：上一次的位置不再适用 =====');
  store2.set({ resumeLast: true, monitors: { 'MON-A': { folder: dirC } } });
  const pb5 = new PlaybackState(statePath);
  const s5 = makeScheduler(store2, tmp, pb5, []);
  await s5.rebuild('startup');
  check('换目录后从新目录第一张开始', s5.channels.get('MON-A').index === 0,
    `index=${s5.channels.get('MON-A').index}`);
  check('换目录后不会把别的目录的图拿来播',
    s5.channels.get('MON-A').files.every((f) => f.name.startsWith('C-')),
    s5.channels.get('MON-A').files[0].name);
  s5.stop();

  /* ============ 6. 那张图被删了 → 退回序号，别甩回第一张 ============ */
  console.log('\n===== 6. 上次那张图被删了：退回序号附近，不回第一张 =====');
  const pb6 = new PlaybackState(statePath);
  pb6.set('MON-A', { index: 7, path: wantA, folder: dirA, playing: false });   // 指向一张即将消失的图
  pb6.flush();
  fs.rmSync(wantA);                                                            // 图没了

  store2.set({ monitors: { 'MON-A': { folder: dirA } } });
  const pb6b = new PlaybackState(statePath);
  const s6 = makeScheduler(store2, tmp, pb6b, []);
  await s6.rebuild('startup');
  const chA6 = s6.channels.get('MON-A');
  check('路径找不到时退回序号（没有甩回第一张）', chA6.index === 7, `index=${chA6.index}`);
  check('退回后不会指向一个不存在的文件',
    fs.existsSync(chA6.files[chA6.index].path),
    base(chA6.files[chA6.index].path));
  s6.stop();

  /* ============ 7. 统一模式同样生效 ============ */
  console.log('\n===== 7. 统一模式（单频道）也记得住 =====');
  store2.set({ perMonitor: false, folder: dirA, applyOnStart: false, interval: 3600 });
  await s6.rebuild('u-setup');   // s6 还在用，先让它按统一模式重建
  const chU = s6.channels.get(UNIFIED_ID);
  check('统一模式只有一个频道', s6.channels.size === 1 && !!chU);
  await s6.goTo(UNIFIED_ID, 5, 1, 'test');
  const wantU = chU.files[chU.index].path;
  check('统一频道的存档写进同一个存储（key = __unified__）',
    !!s6.playback.get(UNIFIED_ID), s6.playback.get(UNIFIED_ID) ? base(s6.playback.get(UNIFIED_ID).path) : '');
  s6.stop();

  const storeU = new Store(configPath);
  const sU = makeScheduler(storeU, tmp, new PlaybackState(path.join(tmp, 'playback.json')), []);
  await sU.rebuild('startup');
  const chU2 = sU.channels.get(UNIFIED_ID);
  check('统一模式重启后同样回到上次那张',
    chU2.files[chU2.index].path === wantU,
    `${base(chU2.files[chU2.index].path)}（期望 ${base(wantU)}）`);
  sU.stop();

  /* ============ 8. 坏档案 / 过期档案不能把程序搞崩 ============ */
  console.log('\n===== 8. 存档异常时的兜底 =====');
  const badPath = path.join(tmp, 'playback-bad.json');
  fs.writeFileSync(badPath, '{ 这不是 JSON', 'utf8');
  let threw = null;
  let pbBad = null;
  try { pbBad = new PlaybackState(badPath); } catch (err) { threw = err; }
  check('存档内容损坏时不抛异常', !threw, threw ? threw.message : '');
  check('损坏存档被当作「没有记录」', pbBad && pbBad.get('MON-A') === null);

  const stalePath = path.join(tmp, 'playback-stale.json');
  fs.writeFileSync(stalePath, JSON.stringify({
    version: 1,
    channels: { 'MON-A': { index: 3, path: 'X:\\gone.bmp', folder: 'X:\\', playing: true, at: 1000 } },
  }), 'utf8');
  const pbStale = new PlaybackState(stalePath, { now: () => 1000 + MAX_AGE_MS + 1 });
  check('超过保留期的记录被丢弃（显示器换了也不留垃圾）', pbStale.get('MON-A') === null);

  const freshPath = path.join(tmp, 'playback-fresh.json');
  const nowMs = Date.now();
  fs.writeFileSync(freshPath, JSON.stringify({
    version: 1,
    channels: { 'MON-A': { index: 3, path: 'X:\\a.bmp', folder: 'X:\\', playing: false, at: nowMs } },
  }), 'utf8');
  const pbFresh = new PlaybackState(freshPath, { now: () => nowMs });
  check('保留期内的记录会被读出来', !!pbFresh.get('MON-A') && pbFresh.get('MON-A').index === 3);
  check('暂停状态也会被记住（playing=false 原样带回来）',
    pbFresh.get('MON-A').playing === false);

  /* ============ 9. 写的节奏：合并短时间内多次改动 ============ */
  console.log('\n===== 9. 写盘节奏：连点「下一张」只落一次盘 =====');
  const throttlePath = path.join(tmp, 'playback-throttle.json');
  const pbT = new PlaybackState(throttlePath, { debounceMs: 40 });
  for (let i = 0; i < 20; i += 1) pbT.set('MON-A', { index: i, path: null, folder: '', playing: true });
  check('20 次改动后还没落盘（攒着）', !fs.existsSync(throttlePath));
  await new Promise((r) => setTimeout(r, 120));
  const flushed = JSON.parse(fs.readFileSync(throttlePath, 'utf8'));
  check('到点后一次落盘，值是最后一次',
    flushed.channels['MON-A'].index === 19, `index=${flushed.channels['MON-A'].index}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('测试崩溃:', err);
  process.exit(2);
});
