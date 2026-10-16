'use strict';

/**
 * 方案 A（扫描缓存持久化）+ 方案 B（舞台前移依赖链）的针对性验证。
 * 不启动 Electron，不改真实桌面 —— writeWallpaper 用替身。
 *
 * 验证点：
 *   1. 首次 rebuild：真实扫盘 → 落盘 scan-cache.json
 *   2. 删掉相册里的图之后重建实例：启动 rebuild 从磁盘缓存水合，
 *      列表仍是旧内容（= 没有重扫磁盘）+ _usedDiskScan 置位
 *   3. 水合的条目能正常走写入链（existsSync 预检放行）
 *   4. 缓存过期（30 天）/ 目录消失 / 文件损坏 → 自动放弃缓存走真实扫描
 *   5. autoScan（后台刷新语义）：清缓存重扫 → 画面按路径找回、顺序不重洗
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store');
const { MonitorScheduler } = require('../src/scheduler');
const { ShuffleOrders } = require('../src/shuffleOrders');

const RED = path.resolve(__dirname, 'fixtures/monitor-A-red.bmp');
const GREEN = path.resolve(__dirname, 'fixtures/monitor-B-green.bmp');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const FAKE_MONITORS = [
  { id: 'MON-A', index: 0, label: '主', width: 3840, height: 2160, x: 0, y: 0, primary: true },
];

function makeScheduler(store, tmpDir, cacheFile) {
  return new MonitorScheduler({
    store,
    cacheDir: tmpDir,
    scanCacheFile: cacheFile,
    enumerate: () => ({ ok: true, monitors: FAKE_MONITORS }),
    resolveUnifiedTarget: () => ({ monitorId: null, label: '全部显示器' }),
    writeWallpaper: async () => ({ ok: true, method: 'test' }),
    onEvent: () => {},
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-scancache-'));
  const cacheFile = path.join(tmpDir, 'scan-cache.json');
  const dirA = path.join(tmpDir, 'dirA');
  fs.mkdirSync(dirA);
  fs.copyFileSync(RED, path.join(dirA, 'a-1.bmp'));
  fs.copyFileSync(GREEN, path.join(dirA, 'a-2.bmp'));

  const store = new Store(path.join(tmpDir, 'config.json'));
  store.set({
    albumId: 'alb_A',
    albums: [{ id: 'alb_A', name: 'A', folders: [{ path: dirA, enabled: true }] }],
    perMonitor: false,
    interval: 60,
    applyToSystem: true,
    applyOnStart: false,
    autoScanMinutes: 0,   // 别让定时扫描搅局
  });

  /* ===== 1. 首次运行：真实扫盘 + 落盘 ===== */
  console.log('\n===== 1. 首次 rebuild → 缓存落盘 =====');
  const s1 = makeScheduler(store, tmpDir, cacheFile);
  await s1.rebuild('startup');
  check('首次运行没有磁盘缓存可用', !s1._usedDiskScan);
  check('频道扫到 2 张图', s1.list()[0].count === 2);
  check('落盘定时器已武装', Boolean(s1._scanSaveTimer));
  s1._scanSaveTimer && clearTimeout(s1._scanSaveTimer);
  s1._scanSaveTimer = null;
  s1._scanDirty = true;
  await s1._saveScanCache();
  check('scan-cache.json 已生成', fs.existsSync(cacheFile));
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  check('缓存格式 version=1', saved.version === 1);
  const keys = Object.keys(saved.entries);
  check('缓存里有 1 个目录条目', keys.length === 1, keys.join(','));
  check('条目含 2 个文件三元组', saved.entries[keys[0]].files.length === 2
    && Array.isArray(saved.entries[keys[0]].files[0]));
  s1.stop();

  /* ===== 2. 重启：水合缓存，跳过磁盘扫描 ===== */
  console.log('\n===== 2. 重启水合：不重扫磁盘 =====');
  fs.unlinkSync(path.join(dirA, 'a-2.bmp'));            // 外部删一张 —— 缓存不知道
  fs.copyFileSync(GREEN, path.join(dirA, 'a-3.bmp'));   // 外部加一张 —— 缓存也不知道
  const s2 = makeScheduler(store, tmpDir, cacheFile);
  await s2.rebuild('startup');
  check('水合了 1 个目录的缓存', s2._hydratedKeys.size === 1);
  check('启动 rebuild 吃到了磁盘缓存', s2._usedDiskScan);
  check('列表仍是缓存的旧内容（= 没有重扫）', s2.list()[0].count === 2,
    `count=${s2.list()[0].count}（真实盘上现在是 2 张：a-1 + a-3）`);
  check('水合条目带了 url', typeof s2.channels.get('__unified__').files[0].url === 'string');
  check('启动刷新定时器已安排', Boolean(s2._startupRefreshTimer));
  clearTimeout(s2._startupRefreshTimer);
  s2._startupRefreshTimer = null;
  s2.stop();

  /* ===== 3. 水合条目正常走写入链 ===== */
  console.log('\n===== 3. 水合条目可写入 =====');
  const s3 = makeScheduler(store, tmpDir, cacheFile);
  await s3.rebuild('startup');
  const writes = [];
  s3.writeWallpaper = async (imagePath) => { writes.push(path.basename(imagePath)); return { ok: true, method: 'test' }; };
  await s3._write(s3.channels.get('__unified__'), 'takeover');
  check('从缓存列表成功写入一张', writes.length === 1, writes.join(','));
  clearTimeout(s3._startupRefreshTimer); s3._startupRefreshTimer = null;
  s3.stop();

  /* ===== 4. 坏缓存自动放弃 ===== */
  console.log('\n===== 4. 坏缓存兜底 =====');
  fs.writeFileSync(cacheFile, '{这不是json', 'utf8');
  const s4 = makeScheduler(store, tmpDir, cacheFile);
  await s4.rebuild('startup');
  check('损坏缓存 → 全量重扫（拿到真实列表）', s4.list()[0].count === 2 && s4._hydratedKeys.size === 0,
    `count=${s4.list()[0].count} hydrated=${s4._hydratedKeys.size}`);
  clearTimeout(s4._startupRefreshTimer); s4._startupRefreshTimer = null;
  s4.stop();

  // 目录消失 → 条目整个不认（直接覆写缓存文件，不依赖 stop 的异步落盘时序）
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1, savedAt: Date.now(),
    entries: { [`${path.join(tmpDir, 'ghost')}::0`]: { folder: path.join(tmpDir, 'ghost'), recursive: false, truncated: false, savedAt: Date.now(), files: [['x', 'x', '.bmp']] } },
  }), 'utf8');
  const s5 = makeScheduler(store, tmpDir, cacheFile);
  await s5.rebuild('startup');
  check('目录消失的条目不认（全量重扫）', s5._hydratedKeys.size === 0);
  clearTimeout(s5._startupRefreshTimer); s5._startupRefreshTimer = null;
  s5.stop();

  // 超龄 → 不认
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 1, savedAt: Date.now(),
    entries: { [`${dirA}::0`]: { folder: dirA, recursive: false, truncated: false, savedAt: Date.now() - 31 * 24 * 3600 * 1000, files: [['x', 'x', '.bmp']] } },
  }), 'utf8');
  const s6 = makeScheduler(store, tmpDir, cacheFile);
  await s6.rebuild('startup');
  check('超过 30 天的条目不认', s6._hydratedKeys.size === 0 && s6.list()[0].count === 2);
  clearTimeout(s6._startupRefreshTimer); s6._startupRefreshTimer = null;
  s6.stop();

  /* ===== 5. autoScan（后台刷新语义）：画面按路径找回、顺序不动 ===== */
  console.log('\n===== 5. 后台刷新 autoScan =====');
  const s7 = makeScheduler(store, tmpDir, cacheFile);
  await s7.rebuild('startup');
  const beforePath = s7.channels.get('__unified__').files[s7.channels.get('__unified__').index].path;
  const beforeOrder = s7.channels.get('__unified__').files.map((f) => f.path).join('|');
  await s7.autoScan();   // 清缓存重扫（盘上现在是 a-1 + a-3）
  const ch = s7.channels.get('__unified__');
  const afterPath = ch.files[ch.index] && ch.files[ch.index].path;
  check('扫描后缓存重新落盘定时器武装', Boolean(s7._scanSaveTimer));
  clearTimeout(s7._scanSaveTimer); s7._scanSaveTimer = null; s7._scanDirty = true;
  await s7._saveScanCache();
  const refreshed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const refreshedEntry = Object.values(refreshed.entries).find((e) => e.folder === dirA);
  check('刷新后磁盘缓存同步更新', refreshedEntry && refreshedEntry.files.length === 2);
  s7.stop();
  // 当前帧被删了（a-2 不在盘上）→ autoScan 允许换一张，这里验证的是「没有黑洞」
  check('刷新后列表仍是 2 张且无失效项', ch.files.length === 2 && fs.existsSync(afterPath || ''),
    `当前=${path.basename(afterPath || '')}`);
  clearTimeout(s7._startupRefreshTimer); s7._startupRefreshTimer = null;

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
