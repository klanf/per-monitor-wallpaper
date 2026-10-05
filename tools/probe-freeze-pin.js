'use strict';

/**
 * 冻结钉帧探针（2026-10-05）：验证「暂停打断过渡」不再留半截画面。
 *
 * 复现链：全屏窗口盖住主屏 → fullscreenWatch 判停 → setFrozen(true) 时过渡
 * 正跑到一半 → 画面永久钉在半截（旧图滑出 99.5% = 桌面黑屏只剩窄条）。
 *
 * 本探针手动走同一条链：
 *   1. 隔离实例 + 长过渡（slide 8s）+ 短间隔（3s）⇒ 任意时刻大概率在过渡中
 *   2. 直接调 liveStage.applyPauseState 模拟主屏全屏暂停
 *   3. PrintWindow 抓主屏 stage：修复后期望 = 新图完整可见（非黑 ≈100%）
 *      未修复时 = 半截过渡（大面积黑 / 窄条）
 *   4. 解冻再验一轮
 *
 * 用法：python tools/run-electron.py --keep-profile tools/probe-freeze-pin.js
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, screen } = require('electron');
const koffi = require('koffi');

const USER_SRC = 'C:/Users/MyPC/AppData/Roaming/electron-wallpaper';
const GALLERY = path.join(__dirname, 'fixtures', 'gallery');

const TMP_ROOT = path.join(__dirname, 'tmp', 'probe-freeze');
const USER_DATA = path.join(TMP_ROOT, `profile-${process.pid}`);
fs.mkdirSync(USER_DATA, { recursive: true });

const ALBUM_ID = 'alb_probe_freeze';
fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
  albums: [{ id: ALBUM_ID, name: 'freeze-probe', folders: [{ path: GALLERY, enabled: true }] }],
  albumId: ALBUM_ID,
  recursive: true,
  interval: 3,                 // 3s 一拍
  shuffle: true,
  autoPlay: true,
  applyToSystem: false,        // 绝不写系统壁纸
  liveWallpaper: true,
  liveStage: { fpsCap: 60, pauseOnFullscreen: false, pauseOnBattery: false,
    pauseOnLock: false, pauseOnIdle: false, idlePauseMinutes: 5,
    hideOnPaused: false, unifiedSplit: 'split' },
  hintParticlesPerMonitor: false,
  monitor: 'all',
  fit: 'cover',
  perMonitor: true,
  applyOnStart: false,
  resumeLast: false,
  autoMonitorSetup: false,
  tray: false,
  closeToTray: false,
  startHidden: true,
  launchAtLogin: false,
  // 关键：固定 slide + 超长过渡，让「暂停落在过渡中」变成大概率事件
  animation: 'slide',
  duration: 8000,
}, null, 2));

process.env.WP_USER_DATA = USER_DATA;
require('../src/main.js');
const liveStage = require('../src/liveStage');

// ---- PrintWindow 抓窗口内容 ----
const U = koffi.load('user32.dll');
const G = koffi.load('gdi32.dll');
const fnPrintWindow = U.func('bool PrintWindow(void *hwnd, void *hdc, uint32 flags)');
const GetDC = U.func('void *GetDC(void *hwnd)');
const ReleaseDC = U.func('int ReleaseDC(void *hwnd, void *hdc)');
const CreateCompatibleDC = G.func('void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = G.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)');
const SelectObject = G.func('void *SelectObject(void *hdc, void *obj)');
const GetDIBits = G.func('int GetDIBits(void *hdc, void *bmp, uint32 start, uint32 lines, _Out_ uint8 *bits, void *bi, uint32 usage)');
const DeleteObject = G.func('bool DeleteObject(void *obj)');
const DeleteDC = G.func('bool DeleteDC(void *hdc)');

/** hwnd 提取与 liveStage.hwndOf 同款：8 字节 Buffer readBigUInt64LE */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

function grabWindow(win) {
  const b = win.getBounds();
  const sf = screen.getDisplayMatching(b).scaleFactor || 1;
  const w = Math.max(1, Math.round(b.width * sf));
  const h = Math.max(1, Math.round(b.height * sf));
  const hwnd = hwndOf(win);
  const hdcWin = GetDC(null);
  const memDC = CreateCompatibleDC(hdcWin);
  const bmp = CreateCompatibleBitmap(hdcWin, w, h);
  const old = SelectObject(memDC, bmp);
  const bmi = Buffer.alloc(40);
  bmi.writeUInt32LE(40, 0);
  bmi.writeInt32LE(w, 4);
  bmi.writeInt32LE(-h, 8);
  bmi.writeUInt16LE(1, 12);
  bmi.writeUInt16LE(32, 14);
  const bits = Buffer.alloc(w * h * 4);
  let ok = false, step = 'init';
  try {
    step = 'PrintWindow';
    ok = fnPrintWindow(hwnd, memDC, 2);
    if (!ok) console.log(`  [grab] PrintWindow 失败 w=${w} h=${h} hwnd=${hwnd}`);
    if (ok) {
      step = 'GetDIBits';
      ok = Boolean(GetDIBits(memDC, bmp, 0, h, koffi.as(bits, 'uint8 *'), koffi.as(bmi, 'void *'), 0));
      if (!ok) console.log('  [grab] GetDIBits 失败');
    }
  } catch (e) {
    console.log(`  [grab] ${step} 异常: ${e.message}`);
    ok = false;
  } finally {
    SelectObject(memDC, old);
    DeleteObject(bmp);
    DeleteDC(memDC);
    ReleaseDC(null, hdcWin);
  }
  if (!ok) return null;
  let nonBlack = 0;
  const total = w * h;
  for (let i = 0; i < total; i += 11) {
    const o = i * 4;
    if (bits[o] > 20 || bits[o + 1] > 20 || bits[o + 2] > 20) nonBlack += 1;
  }
  return { w, h, ratio: nonBlack / Math.ceil(total / 11) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  console.log('===== probe-freeze-pin 开始 =====');
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const st = liveStage.stats();
    if (st.stages.length > 0 && st.stages.every((s) => s.mounted)) break;
    await sleep(300);
  }
  const st = liveStage.stats();
  if (!st.stages.length) { console.log('!! 舞台没挂起来'); app.exit(2); return; }
  const mainStage = st.stages.find((s) => s.bounds && s.bounds.x === 0 && s.bounds.y === 0) || st.stages[0];
  console.log('主屏舞台:', mainStage.channelId.slice(0, 40), JSON.stringify(mainStage.bounds));

  // 等 warm-up：至少经历过一次完整换图（interval 3s ⇒ 10s 足够）
  await sleep(10000);

  const stageWins = BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'stage');
  // 主屏 = 横屏的那块（本机副屏是竖屏）；按 DIP 宽高比挑，绕开坐标换算歧义
  const mainWin = stageWins.find((w) => {
    const b = w.getBounds();
    return b.width > b.height;
  }) || stageWins[0];
  console.log(`主屏 stage 窗口 DIP: ${JSON.stringify(mainWin.getBounds())}`);

  let pass = 0, fail = 0;
  const check = (label, ok, detail = '') => {
    if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
    else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
  };

  // 主屏对应的 Electron display id（applyPauseState 吃 display.id）
  const mainDisplay = screen.getAllDisplays().find((d) => d.bounds.x === 0 && d.bounds.y === 0)
    || screen.getPrimaryDisplay();

  for (let round = 1; round <= 3; round += 1) {
    // 暂停（大概率落在 8s 过渡的中段）—— 等价于全屏游戏盖住主屏
    liveStage.applyPauseState({ pausedIds: [mainDisplay.id], away: false, reasons: ['probe'] });
    await sleep(1200);   // 等 stage:pause 事件送达渲染端并生效
    const g1 = grabWindow(mainWin);
    check(`第${round}轮 暂停后主屏 stage 画面完整`,
      g1 && g1.ratio > 0.9,
      g1 ? `非黑占比 ${(g1.ratio * 100).toFixed(1)}%` : '抓取失败');

    // 解冻，回到正常轮播
    liveStage.applyPauseState({ pausedIds: [], away: false, reasons: [] });
    await sleep(9000);   // 等解冻 + 至少一次新过渡走完
    const g2 = grabWindow(mainWin);
    check(`第${round}轮 解冻后恢复轮播`, g2 && g2.ratio > 0.5,
      g2 ? `非黑占比 ${(g2.ratio * 100).toFixed(1)}%` : '抓取失败');
  }

  console.log(`===== 结果: pass=${pass} fail=${fail} =====`);
  app.exit(fail > 0 ? 1 : 0);
}).catch((e) => { console.error('probe 失败:', e); app.exit(3); });
