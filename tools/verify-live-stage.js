'use strict';

/**
 * 动态桌面渲染链路验证（无头，不挂载、不碰用户桌面）。
 *
 * 覆盖「stage 窗口能不能独立跑起来」的三段：
 *   ① stage.html 加载无 JS 错误（stage.js 的 init 要能跑通 —— 它会调
 *      wp.listChannels()，这里没有调度器，返回空列表是合法分支：黑屏待命）；
 *   ② wpimg:// 协议：编码回路（encode→decode 原样）、字节完整（与源文件等长）、
 *      mime 正确、Cache-Control 是 no-store（绝不进 C 盘缓存，§2.5）；
 *   ③ preload 的 stageUrl 与主进程 decodePath 是同一套编码（utf16le→base64url）。
 *
 * 挂载本身由 probe:attach 验证过（24 项断言），这里不重复 —— 那一步会碰桌面。
 * 用 run-electron.py 跑：`npm run verify:stage`
 */

const path = require('node:path');
const fs = require('node:fs');

// 必须在 app ready 之前注册特权协议
const stageProtocol = require('../src/stageProtocol');
stageProtocol.registerScheme();

const { app, BrowserWindow, ipcMain } = require('electron');

// stage.js 的 init 会调 wp.listChannels() —— 独立验证环境里没有调度器，
// 这里注册一个假 handler（空频道 = 合法分支：黑屏待命）
ipcMain.handle('channels:list', () => ({ channels: [], perMonitor: false }));

const FIXTURE = path.resolve(__dirname, 'fixtures', 'monitor-A-red.bmp');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

/** 只收真正的错误：滤掉 Electron 开发环境的固有噪音（CSP 提示 / API deprecation） */
function isNoise(message) {
  return message.includes('Electron Security Warning')
    || message.includes('deprecated and will be removed');
}

async function main() {
  console.log('动态桌面渲染链路验证（无头）\n');

  // ---- ① 编码回路（主进程侧） ----
  {
    const p = 'D:\\图库\\测试 目录\\壁纸 (1).png';
    const round = stageProtocol.decodePath(stageProtocol.encodePath(p));
    check('encodePath → decodePath 回路原样（含中文/空格/括号）', round === p, round);
    check('stageUrl 形如 wpimg://img/<token>', stageProtocol.stageUrl(p).startsWith('wpimg://img/'));
  }

  stageProtocol.handleProtocol();

  // ---- ② stage.html 独立加载 ----
  const errors = [];
  const win = new BrowserWindow({
    show: false,
    width: 800, height: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !isNoise(message)) errors.push(message);   // warn 及以上都算可疑
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'stage.html'));
  await new Promise((r) => setTimeout(r, 800));   // 给 stage.js 的 init 留时间

  check('stage.html 加载无 warn/error', errors.length === 0, errors.join(' | ') || '控制台干净');

  // ---- ③ 页面内：preload 暴露与协议行为 ----
  {
    const src = fs.readFileSync(FIXTURE);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const p = ${JSON.stringify(FIXTURE)};
      const url = window.wp.stageUrl(p);
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return {
        urlPrefix: url.slice(0, 12),
        status: res.status,
        bytes: buf.byteLength,
        mime: res.headers.get('content-type'),
        cacheControl: res.headers.get('cache-control'),
      };
    })()`);
    check('preload 暴露了 stageUrl', result.urlPrefix === 'wpimg://img/', result.urlPrefix);
    check('wpimg 返回 200', result.status === 200, `status=${result.status}`);
    check('字节与源文件一致（原图无损）', result.bytes === src.length,
      `协议 ${result.bytes} vs 文件 ${src.length}`);
    check('mime 是 image/bmp（按扩展名）', result.mime === 'image/bmp', result.mime);
    check('Cache-Control 是 no-store（不进 C 盘缓存）', result.cacheControl === 'no-store',
      result.cacheControl);
  }

  // ---- ④ 坏路径的失败语义 ----
  {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const bad = window.wp.stageUrl('D:\\\\不存在\\\\x.bmp');
      const res = await fetch(bad);
      return { status: res.status };
    })()`);
    check('不存在的文件返回 404（不是 500/挂死）', result.status === 404, `status=${result.status}`);
  }

  win.destroy();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch((err) => {
  console.error('验证崩溃:', err);
  app.exit(2);
});
