'use strict';

/**
 * 移植冒烟（2026-10-10）：在真 Electron 运行时里把本轮改动的模块全部 require 一遍，
 * 确认没有运行时加载错误（koffi 结构体重名、循环依赖、electron API 误用等）。
 * 走 run-electron.py 的一次性隔离 user-data-dir，不碰用户正在跑的实例与真实配置。
 */

const out = [];
function step(name, fn) {
  try {
    const r = fn();
    out.push(`  ✓ ${name}${r ? '   ' + r : ''}`);
  } catch (err) {
    out.push(`  ✗ ${name}   ${err.message}`);
    process.exitCode = 1;
  }
}

step('require win32（含 slideshowGuard + 写前快照接线）', () => {
  const w = require('../src/win32.js');
  if (typeof w.configureSlideshowGuard !== 'function') throw new Error('configureSlideshowGuard 未导出');
  w.configureSlideshowGuard(null); // 不注入路径 = 守卫静默跳过，确认调用链可走
  return 'guard hook ok';
});

step('require desktopWallpaper（COM 加载 + vtable 校验）', () => {
  const dw = require('../src/desktopWallpaper.js');
  if (typeof dw.setSlideshow !== 'function') throw new Error('setSlideshow 未导出');
  if (!dw.available()) throw new Error('COM 不可用: ' + dw.backendName());
  return dw.backendName();
});

step('require tray / store / slideshowGuard', () => {
  require('../src/tray.js');
  require('../src/store.js');
  const g = require('../src/slideshowGuard.js');
  // Store 默认值自洽：三键已登记（源码静态核对，不实例化以免碰用户配置）
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'store.js'), 'utf8');
  for (const key of ['expandedMonitors', 'hintParticlesPerMonitor', 'swipeSwitch']) {
    if (!new RegExp(`^\\s*${key}:`, 'm').test(src)) throw new Error(`DEFAULTS 缺 ${key}`);
  }
  if (typeof g.snapshotIfGood !== 'function' || typeof g.restoreIfEmpty !== 'function') {
    throw new Error('guard 接口不全');
  }
  return 'defaults + guard ok';
});

console.log('\n[smoke] 移植模块加载冒烟');
for (const line of out) console.log(line);
console.log(`[smoke] 完成：${process.exitCode === 1 ? '有失败' : '全部通过'}`);
// 必须显式退出 —— 不退的话 Electron 常驻到 run-electron.py 超时（exit=124 假失败）
process.exit(process.exitCode === 1 ? 1 : 0);
