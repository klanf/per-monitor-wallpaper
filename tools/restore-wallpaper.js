'use strict';
/**
 * 壁纸还原工具。
 *
 * 直接跑（不需要 Electron，desktopWallpaper 只依赖 koffi）：
 *   node tools/restore-wallpaper.js                 # 用 tools/wallpaper-backup.json 里记录的原始路径逐屏还原
 *   node tools/restore-wallpaper.js "<图片路径>"     # 把所有显示器设成这一张
 */

const path = require('node:path');
const fs = require('node:fs');
const desktopWallpaper = require('../src/desktopWallpaper');

const BACKUP = path.join(__dirname, 'wallpaper-backup.json');

function restoreFromBackup() {
  if (!fs.existsSync(BACKUP)) return { ok: false, error: `找不到存档 ${BACKUP}` };
  const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  const results = [];
  for (const entry of backup.perMonitor || []) {
    if (!entry.wallpaper || !fs.existsSync(entry.wallpaper)) {
      results.push({ index: entry.index, ok: false, error: `原图已不存在: ${entry.wallpaper}` });
      continue;
    }
    const r = desktopWallpaper.setWallpaper(entry.device, entry.wallpaper);
    results.push({ index: entry.index, wallpaper: entry.wallpaper, ...r });
  }
  return { ok: results.length > 0 && results.every((r) => r.ok), results };
}

function setAll(imagePath) {
  if (!fs.existsSync(imagePath)) return { ok: false, error: `文件不存在: ${imagePath}` };
  return { ok: true, results: [{ wallpaper: imagePath, ...desktopWallpaper.setWallpaper(null, imagePath) }] };
}

if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    const result = arg ? setAll(arg) : restoreFromBackup();

    console.log('还原方式:', arg ? `全部显示器 -> ${arg}` : '按存档逐屏还原');
    for (const r of result.results || []) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.wallpaper || ''}  ${r.ok ? '' : r.error || ''}`);
    }
    if (result.error) console.log('  错误:', result.error);

    // Windows 的每屏壁纸是异步落盘的，立刻回读会拿到旧值
    await new Promise((r) => setTimeout(r, 1800));

    const after = desktopWallpaper.enumMonitors();
    console.log('\n回读结果:');
    for (const m of after.monitors || []) console.log(`  [${m.index}] ${m.label}  ->  ${m.current}`);

    desktopWallpaper.release();
    process.exitCode = result.ok ? 0 : 1;
  })();
}

module.exports = { setAll, restoreFromBackup, BACKUP };
