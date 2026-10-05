'use strict';

/**
 * 黑屏复现探针（2026-10-05）：主屏 stage 图像层卡在「滑出 99.5%」只剩窄条。
 *
 * 复刻用户真实配置起一个隔离实例（WP_USER_DATA 独立、applyToSystem=false
 * 绝不碰系统壁纸），持续用 PrintWindow 抓两个舞台窗口的内容：
 *   - 非黑占比 < 3% 判定「黑屏态」，记录当时刻 + 渲染端 stage-dbg 日志对照
 *   - 每 2s 抓一帧，连续 4 分钟，覆盖多次随机换图
 *
 * 判定数据只信 PrintWindow（窗口自身内容，不吃顶层窗口遮挡的亏）。
 * 用法：WP_STAGE_DEBUG=1 python tools/run-electron.py --keep-profile tools/probe-black-main.js
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, screen } = require('electron');
const koffi = require('koffi');

const USER_SRC = 'C:/Users/MyPC/AppData/Roaming/electron-wallpaper';

// ---- 隔离 userData（必须在 require main.js 之前）----
const TMP_ROOT = path.join(__dirname, 'tmp', 'probe-black');
const USER_DATA = path.join(TMP_ROOT, `profile-${process.pid}`);
fs.mkdirSync(USER_DATA, { recursive: true });

// 复刻用户 config 的「影响渲染路径」的字段，但绝不写系统壁纸
const srcCfg = JSON.parse(fs.readFileSync(path.join(USER_SRC, 'config.json'), 'utf8'));
const seedCfg = {
  albums: srcCfg.albums,             // 用户真实相簿（只读不改）
  albumId: srcCfg.albumId,
  recursive: true,
  interval: 15,                      // 15s 一拍，4 分钟能跑 ~16 次换图
  shuffle: true,
  autoPlay: true,
  applyToSystem: false,              // 铁律：测试实例一张系统壁纸都不写
  liveWallpaper: true,
  liveStage: { fpsCap: 30, pauseOnFullscreen: false, pauseOnBattery: false,
    pauseOnLock: false, pauseOnIdle: false, idlePauseMinutes: 5,
    hideOnPaused: false, unifiedSplit: srcCfg.liveStage.unifiedSplit },
  hintParticlesPerMonitor: true,
  monitor: srcCfg.monitor,
  fit: srcCfg.fit,
  skipSizeTwin: srcCfg.skipSizeTwin,
  perMonitor: true,
  applyOnStart: false,               // 不写系统壁纸，启动别碰
  monitors: srcCfg.monitors,         // 用户真实每屏配置（随机动画/时长1500）
  resumeLast: true,
  autoMonitorSetup: false,
  tray: false,
  closeToTray: false,
  startHidden: true,
  launchAtLogin: false,
  autoHideDelay: 5000,
  animation: srcCfg.animation,
  duration: 1500,
  breath: srcCfg.breath,
  particles: srcCfg.particles,
  particleCount: srcCfg.particleCount,
  breathAmplitude: srcCfg.breathAmplitude,
};
fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify(seedCfg, null, 2));

// 复刻用户的续播存档：主屏从「奇诺777」那张恢复（与用户此刻状态一致）
try {
  const pb = JSON.parse(fs.readFileSync(path.join(USER_SRC, 'playback.json'), 'utf8'));
  if (pb.channels) {
    for (const k of Object.keys(pb.channels)) pb.channels[k].at = Date.now();
  }
  fs.writeFileSync(path.join(USER_DATA, 'playback.json'), JSON.stringify(pb, null, 2));
} catch (e) { console.log(' playback 种子失败(忽略):', e.message); }

process.env.WP_USER_DATA = USER_DATA;
require('../src/main.js');
const liveStage = require('../src/liveStage');

// ---- PrintWindow 抓窗口内容（koffi） ----
const U = koffi.load('user32.dll');
const G = koffi.load('gdi32.dll');
const fnPrintWindow = U.func('bool PrintWindow(void *hwnd, void *hdc, uint32 flags)');
const GetDC = U.func('void *GetDC(void *hwnd)');
const ReleaseDC = U.func('int ReleaseDC(void *hwnd, void *hdc)');
const CreateCompatibleDC = G.func('void *CreateCompatibleDC(void *hdc)');
const CreateCompatibleBitmap = G.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)');
const SelectObject = G.func('void *SelectObject(void *hdc, void *obj)');
const BitBlt = G.func('bool BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32 rop)');
const GetDIBits = G.func('int GetDIBits(void *hdc, void *bmp, uint32 start, uint32 lines, _Out_ uint8 *bits, void *bi, uint32 usage)');
const DeleteObject = G.func('bool DeleteObject(void *obj)');
const DeleteDC = G.func('bool DeleteDC(void *hdc)');

const SRCCOPY = 0x00CC0020;

/** 抓指定 hwnd 的内容 → { w, h, ratio, maxCol }；用窗口尺寸 + GetWindowRect 等价信息 */
function grabWindow(win) {
  const b = win.getBounds();          // DIP
  const sf = screen.getDisplayMatching(b).scaleFactor || 1;
  const w = Math.max(1, Math.round(b.width * sf));
  const h = Math.max(1, Math.round(b.height * sf));
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
  let ok = false;
  try {
    // 先 PrintWindow 把窗口自身内容（含 GPU 加速层）画进 memDC，再 GetDIBits 读回
    ok = fnPrintWindow(hwndOf(win), memDC, 2 /* PW_RENDERFULLCONTENT */);
    if (ok) ok = Boolean(GetDIBits(memDC, bmp, 0, h, koffi.as(bits, 'uint8 *'), koffi.as(bmi, 'void *'), 0));
  } finally {
    SelectObject(memDC, old);
    DeleteObject(bmp);
    DeleteDC(memDC);
    ReleaseDC(null, hdcWin);
  }
  if (!ok) return null;
  // 统计非黑比例 + 非黑像素的最大列号（识别「只有边缘窄条」形态）
  let nonBlack = 0, maxCol = -1;
  const total = w * h;
  for (let i = 0; i < total; i += 7) {          // 步进采样省时
    const o = i * 4;
    if (bits[o] > 20 || bits[o + 1] > 20 || bits[o + 2] > 20) {
      nonBlack += 1;
      const col = i % w;
      if (col > maxCol) maxCol = col;
    }
  }
  return { w, h, ratio: nonBlack / Math.ceil(total / 7), maxCol };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  console.log('===== probe-black-main 开始（测试画面会短暂出现在桌面上，不碰系统壁纸）=====');
  // 等舞台挂载
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const st = liveStage.stats();
    if (st.stages.length > 0 && st.stages.every((s) => s.mounted)) break;
    await sleep(300);
  }
  const st = liveStage.stats();
  console.log('舞台:', JSON.stringify(st.stages.map((s) => ({ id: s.channelId, mounted: s.mounted, bounds: s.bounds }))));
  if (!st.stages.length) { console.log('!! 舞台没挂起来，退出'); app.exit(2); return; }

  // 找 stage 窗口对象（直接留 BrowserWindow 引用，抓取时取原生句柄）
  const stageWins = BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'stage');
  console.log(`stage 窗口: ${stageWins.length} 个`);

  // 监视循环：4 分钟，每 2s 抓两块 stage
  const T_END = Date.now() + 4 * 60 * 1000;
  let stuckHits = 0;
  let lastReport = 0;
  while (Date.now() < T_END) {
    for (let i = 0; i < stageWins.length; i += 1) {
      let g = null;
      try { g = grabWindow(stageWins[i]); } catch (e) { console.log(`[watch] stage#${i} 抓取异常: ${e.message}`); }
      if (!g) { console.log(`[watch] stage#${i} 抓取失败`); continue; }
      const black = g.ratio < 0.03;
      if (black) {
        stuckHits += 1;
        // 黑屏形态取证：非黑列是否集中在边缘（窄条特征）
        console.log(`[watch] !! stage#${i} BLACK ratio=${(g.ratio * 100).toFixed(2)}% ` +
          `size=${g.w}x${g.h} maxNonBlackCol=${g.maxCol} hits=${stuckHits} t=+${Math.round((Date.now() - t0) / 1000)}s`);
      } else if (Date.now() - lastReport > 20000) {
        lastReport = Date.now();
        console.log(`[watch] stage#${i} ok ratio=${(g.ratio * 100).toFixed(1)}% size=${g.w}x${g.h} t=+${Math.round((Date.now() - t0) / 1000)}s`);
      }
    }
    await sleep(2000);
  }
  console.log(`===== 监视结束：黑屏命中 ${stuckHits} 次 =====`);
  app.exit(stuckHits > 0 ? 1 : 0);
}).catch((e) => { console.error('probe 失败:', e); app.exit(3); });
