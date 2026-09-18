'use strict';

/**
 * 「每台显示器现在显示的是哪张图」—— 直接问系统，不看应用自己的状态。
 *
 * 用途：验证「切换 / 删除 / 恢复播放位置」这类改动时，这是最硬的一条证据 ——
 * 应用里显示的和桌面实际挂着的可能是两回事（改配置后旧图才落盘、
 * 写入失败但界面照样翻页），只有问系统才知道真结果。
 *
 * 不依赖 CDP，也不需要应用带调试端口，纯 Node 里就能跑：
 * koffi 走 N-API，所以在 Node 和 Electron 下都能加载。
 *
 * 用法: npm run wallpaper:now
 */

const dw = require('../src/desktopWallpaper');

const info = dw.enumMonitors();
if (!info.ok) {
  console.error('枚举显示器失败:', info.error || '(未知原因)');
  process.exit(1);
}

console.log(`当前壁纸（共 ${info.monitors.length} 台显示器）：\n`);
for (const m of info.monitors) {
  const current = dw.getWallpaper(m.id);
  console.log(`${m.label}`);
  console.log(`  ${current || '(读不到，可能是纯色 / 幻灯片播放)'}`);
}

dw.release();
