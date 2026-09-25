'use strict';

/**
 * 动态桌面端到端验证（真机，会短暂覆盖桌面约 25 秒）。
 *
 * 和 probe-attach.js 的区别：那个验证的是「挂载机制能不能用」（自造窗口），
 * 这个验证的是**生产链路**——require 真正的 src/main.js，配置、调度器、
 * liveStage、wpimg:// 协议全部按用户实际跑的路径走，舞台里显示的是
 * 真实的频道图片（fixtures/gallery 渐变图），不是探针自己的洋红页。
 *
 * 隔离：WP_USER_DATA 环境变量把 userData 换到 tools/tmp 下 ⇒
 *   配置、单实例锁、播放存档全部独立，用户正在跑的实例完全不受影响；
 *   applyToSystem=false ⇒ 一张系统壁纸都不写，测试结束后用户桌面原样。
 *
 * 会做什么：
 *   1. 预写种子配置（gallery 相簿 + 每屏频道 + liveWallpaper 开 + 不写系统壁纸）
 *   2. 等舞台窗口挂载完成（stats.mounted）
 *   3. 连拍判活：换图过渡每 2s 一次，8 连拍必跨过一次 ⇒ 像素差 > 0.4% = 真的在刷
 *   4. **模拟 Explorer 插 WorkerW**：造一块黑窗口挂到 Progman、插到图标层之后
 *      （和系统写入壁纸后的行为完全一致）⇒ 舞台被盖住（区域变黑）
 *   5. 等看门狗（2s 一轮）重申 Z 序 ⇒ 区域恢复成舞台内容
 *   6. 卸载假窗口，liveStage.stop()，退出
 *
 * 判据全部用 BitBlt 抓屏像素，不用 capturePage（假绿，见 probe-attach 头注）。
 *
 * 用法：python tools/run-electron.py tools/verify-live-e2e.js
 */

const path = require('node:path');
const fs = require('node:fs');

const { app, BrowserWindow, screen } = require('electron');
const koffi = require('koffi');

// ---- 隔离 userData：必须在 require main.js 之前（锁在模块求值时就拿了）----
// 按 PID 建新目录，不整目录 rmSync（沙箱的批量删除护栏会拦 >50 文件的整删，
// 第一跑就是在这里炸的）。残留的旧 profile 留在 tools/tmp（已 gitignore）。
const TMP_ROOT = path.join(__dirname, 'tmp', 'live-e2e');
const USER_DATA = path.join(TMP_ROOT, `profile-${process.pid}`);
const GALLERY = path.join(__dirname, 'fixtures', 'gallery');

fs.mkdirSync(USER_DATA, { recursive: true });

const ALBUM_ID = 'alb_live_e2e';
fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
  albums: [{
    id: ALBUM_ID,
    name: 'live-e2e',
    folders: [{ path: GALLERY, enabled: true }],
  }],
  albumId: ALBUM_ID,
  perMonitor: true,          // 每屏一路频道（width=0 的 unified 频道阶段 1 不支持）
  monitor: 'all',
  liveWallpaper: true,       // 开动态桌面
  applyToSystem: false,      // 绝不写用户真实系统壁纸
  autoPlay: true,
  interval: 2,               // 短间隔 ⇒ 连拍必然跨过一次换图过渡
  fit: 'cover',
  animation: 'fade',
  startHidden: true,         // 主窗口别弹出来
  tray: false,
  closeToTray: false,
  launchAtLogin: false,
  autoMonitorSetup: true,    // 别让启动自动配置动我们的种子
}, null, 2));

process.env.WP_USER_DATA = USER_DATA;
require('../src/main.js');   // 生产入口：调度器 / liveStage / 协议全按真实路径启动

const liveStage = require('../src/liveStage');
const desktopHost = require('../src/desktopHost');

// ---------------------------------------------------------------------------
// BitBlt 抓屏（从 probe-attach.js 原样抄，判据唯一可信来源）
// ---------------------------------------------------------------------------

const GDI = (() => {
  const u = koffi.load('user32.dll');
  const g = koffi.load('gdi32.dll');
  return {
    GetDC: u.func('void *GetDC(void *hwnd)'),
    ReleaseDC: u.func('int ReleaseDC(void *hwnd, void *hdc)'),
    GetForegroundWindow: u.func('void *GetForegroundWindow()'),
    CreateCompatibleDC: g.func('void *CreateCompatibleDC(void *hdc)'),
    CreateCompatibleBitmap: g.func('void *CreateCompatibleBitmap(void *hdc, int w, int h)'),
    SelectObject: g.func('void *SelectObject(void *hdc, void *obj)'),
    BitBlt: g.func('bool BitBlt(void *dst, int x, int y, int w, int h, void *src, int sx, int sy, uint32 rop)'),
    GetDIBits: g.func('int GetDIBits(void *hdc, void *bmp, uint32 start, uint32 lines, _Out_ uint8 *bits, void *bi, uint32 usage)'),
    DeleteObject: g.func('bool DeleteObject(void *obj)'),
    DeleteDC: g.func('bool DeleteDC(void *hdc)'),
  };
})();

const SRCCOPY = 0x00CC0020;
const DIB_RGB_COLORS = 0;

function grabScreen(x, y, w, h) {
  const screenDC = GDI.GetDC(null);
  if (!screenDC || Number(koffi.address(screenDC)) === 0) throw new Error('GetDC(NULL) 失败');
  const memDC = GDI.CreateCompatibleDC(screenDC);
  const bmp = GDI.CreateCompatibleBitmap(screenDC, w, h);
  const old = GDI.SelectObject(memDC, bmp);

  const bmi = Buffer.alloc(44);
  bmi.writeUInt32LE(40, 0);
  bmi.writeInt32LE(w, 4);
  bmi.writeInt32LE(-h, 8);   // 负高度 = top-down
  bmi.writeUInt16LE(1, 12);
  bmi.writeUInt16LE(32, 14);
  bmi.writeUInt32LE(0, 16);

  const bits = Buffer.alloc(w * h * 4);
  try {
    if (!GDI.BitBlt(memDC, 0, 0, w, h, screenDC, x, y, SRCCOPY)) throw new Error('BitBlt 失败');
    if (!GDI.GetDIBits(memDC, bmp, 0, h, koffi.as(bits, 'uint8 *'), koffi.as(bmi, 'uint8 *'), DIB_RGB_COLORS)) {
      throw new Error('GetDIBits 失败');
    }
  } finally {
    GDI.SelectObject(memDC, old);
    GDI.DeleteObject(bmp);
    GDI.DeleteDC(memDC);
    GDI.ReleaseDC(null, screenDC);
  }
  return bits;
}

// ---------------------------------------------------------------------------
// 断言与度量
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    let err = null;
    try { v = fn(); } catch (e) { err = e; }
    if (v) return v;
    if (Date.now() - t0 > ms) {
      throw new Error(`等待超时（${Math.round(ms / 1000)}s）：${what}${err ? ' — ' + err.message : ''}`);
    }
    await sleep(300);
  }
}

/** 有任一通道差值 > 12 的像素占比 */
function diffRatio(a, b) {
  if (a.length !== b.length) return 1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 12 || Math.abs(a[i + 1] - b[i + 1]) > 12 || Math.abs(a[i + 2] - b[i + 2]) > 12) n += 1;
  }
  return n / (a.length / 4);
}

/** 接近纯黑的像素占比 */
function blackRatio(buf) {
  let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] < 24 && buf[i + 1] < 24 && buf[i + 2] < 24) n += 1;
  }
  return n / (buf.length / 4);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  console.log('===== verify-live-e2e 开始（桌面将被测试画面覆盖约 25 秒）=====');
  const t0 = Date.now();
  let fake = null;
  try {
    // ---- 1. 等舞台挂载 ----
    console.log('\n----- 1. 等待舞台窗口挂载 -----');
    await waitUntil(() => liveStage.stats().stages.length > 0, 30000, '舞台窗口创建');
    const displays = screen.getAllDisplays();
    await waitUntil(() => liveStage.stats().stages.every((s) => s.mounted), 15000, '全部舞台挂载完成');
    const stats = liveStage.stats();
    check('动态桌面在跑', stats.running === true);
    check(`舞台数量 = 显示器数量（${stats.stages.length} / ${displays.length}）`,
      stats.stages.length === displays.length);
    check('全部挂载成功', stats.stages.every((s) => s.mounted));
    check('无降级', stats.stages.every((s) => !s.degraded));
    for (const s of stats.stages) {
      console.log(`  · 频道 ${s.id}  bounds=${JSON.stringify(s.bounds)}`);
    }

    // ---- 2. 选采样区（物理像素）----
    // ⚠️ 必须避开用户的顶层窗口：主屏常被应用窗口盖住（diag 实测：洋红只在
    // 用户窗口缝隙里露出 10%）。用桌面树快照做遮挡规避，主屏找不到去副屏。
    const primary = screen.getPrimaryDisplay();
    const st = stats.stages.find((s) => s.bounds && s.bounds.x === primary.bounds.x
      && s.bounds.y === primary.bounds.y) || stats.stages[0];
    const sf = primary.scaleFactor;
    const RW = Math.round(480 * sf);
    const RH = Math.round(360 * sf);
    const sPhys = {
      x: Math.round(st.bounds.x * sf), y: Math.round(st.bounds.y * sf),
      w: Math.round(st.bounds.width * sf), h: Math.round(st.bounds.height * sf),
    };
    const snapOcc = desktopHost.snapshot({});
    const occluders = (snapOcc.topLevel || []).filter((n) => {
      if (!n.visible || n.cloaked || !n.rect) return false;
      if (n.rect.w < 8 || n.rect.h < 8) return false;
      // 桌面系统窗口不是遮挡（我们的窗口就挂在 Progman 里）
      if (n.cls === 'Progman' || n.cls === 'WorkerW' || n.cls === 'SHELLDLL_DefView') return false;
      return true;
    }).map((n) => n.rect);
    const overlaps = (r, x, y, w, h) => x < r.x + r.w && r.x < x + w && y < r.y + r.h && r.y < y + h;
    let RX = null; let RY = null;
    const scan = (phys) => {
      for (let gy = 0; gy + RH <= phys.h; gy += Math.round(RH / 2)) {
        for (let gx = 0; gx + RW <= phys.w; gx += Math.round(RW / 2)) {
          const x = phys.x + gx;
          const y = phys.y + gy;
          if (!occluders.some((r) => overlaps(r, x, y, RW, RH))) { RX = x; RY = y; return true; }
        }
      }
      return false;
    };
    let clean = scan(sPhys);
    if (!clean) {
      // 主屏被用户窗口占满 → 试副屏舞台
      const other = stats.stages.find((s) => s !== st);
      if (other && other.bounds) {
        clean = scan({
          x: Math.round(other.bounds.x * sf), y: Math.round(other.bounds.y * sf),
          w: Math.round(other.bounds.width * sf), h: Math.round(other.bounds.height * sf),
        });
      }
    }
    if (!clean) {
      console.log('  ⚠ 两块屏都没有不被用户窗口遮挡的 480×360 区域 —— 跳过像素断言（不伪装通过）');
      console.log(`\n===== e2e 结果: ${pass}/${pass + fail}（像素断言跳过）=====`);
      liveStage.stop();
      app.exit(0);
      return;
    }
    console.log(`  采样区：${RW}×${RH} @ (${RX},${RY})，scaleFactor=${sf}，避开 ${occluders.length} 个用户窗口`);

    // ---- 3. 连拍判活：换图过渡每 2s 一次（520ms），12 连拍（≈3.6s）必跨一次 ----
    console.log('\n----- 2. 连拍判活（等一次换图过渡）-----');
    const frames = [];
    for (let i = 0; i < 12; i += 1) {
      frames.push(grabScreen(RX, RY, RW, RH));
      await sleep(300);
    }
    let maxDiff = 0;
    for (let i = 1; i < frames.length; i += 1) {
      maxDiff = Math.max(maxDiff, diffRatio(frames[i - 1], frames[i]));
    }
    check('画面在刷新（连拍跨过换图过渡）', maxDiff > 0.004, `最大帧差=${(maxDiff * 100).toFixed(2)}%`);
    const baseBlack = blackRatio(frames[frames.length - 1]);
    check('舞台内容可见（非黑屏）', baseBlack < 0.5, `黑占比=${(baseBlack * 100).toFixed(1)}%`);

    /*
     * 遮挡窗口期间冻结舞台（stage:pause 语义：冻结 = 停 rAF，画面钉在当前帧）。
     * 不冻结的话，「遮挡前快照 → 看门狗恢复」之间必然跨过 0~5 次换图
     * （interval=2s，恢复要 0.5~10s），「恢复后与遮挡前一致」这个断言就
     * 变成抛硬币 —— 2026-09-26 连续两轮都栽在这（帧差 99.9%，其实是换了图）。
     * 冻结后内容静止，断言才真正测的是「看门狗恢复的是**同一块**舞台内容」。
     */
    liveStage.applyPauseState({ away: true });
    await sleep(600);   // 等 stage:pause 落地（渲染端停表）
    const still = grabScreen(RX, RY, RW, RH);   // 冻结后重取遮挡前基准
    /*
     * 外部动态内容自检：桌面上可能还挂着**另一个实例**的动态舞台
     * （两套看门狗互相挤 Z 序，采样区看到的是别人家的内容，画面一直在动）。
     * 冻结状态下自己不该动 —— 还在动就说明采样区被外部实例占着，
     * 「内容一致性」断言测的不是我们，跳过（不伪装通过）。
     */
    await sleep(900);
    const externalDrift = diffRatio(still, grabScreen(RX, RY, RW, RH));
    const foreignContent = externalDrift > 0.3;
    if (foreignContent) {
      console.log(`  ⚠ 采样区存在外部动态内容（冻结自检帧差=${(externalDrift * 100).toFixed(1)}%）`
        + ' —— 桌面上大概率还挂着另一个实例的舞台，内容一致性断言跳过');
    }

    // ---- 4. 模拟 Explorer 插 WorkerW：黑窗口挂到 Progman、插到图标层之后 ----
    console.log('\n----- 3. 模拟 Explorer 插入 WorkerW（遮挡）-----');
    const snap = desktopHost.snapshot({});
    const choice = desktopHost.chooseMountParent(snap);
    check('挂载点判定成功', choice.ok, choice.ok ? `strategy=${choice.strategy}` : choice.reason || '');

    const FW = Math.round(480 * sf);
    const FH = Math.round(360 * sf);
    const FX = RX;
    const FY = RY;
    fake = new BrowserWindow({
      x: Math.round(FX / sf), y: Math.round(FY / sf),
      width: Math.round(FW / sf), height: Math.round(FH / sf),
      show: false, frame: false, backgroundColor: '#000000',
      skipTaskbar: true, focusable: false, resizable: false,
    });
    await fake.loadURL('data:text/html,<body style="margin:0;background:#000"></body>');
    const fakeBuf = fake.getNativeWindowHandle();
    const fakeHwnd = fakeBuf.length === 8 ? Number(fakeBuf.readBigUInt64LE(0)) : fakeBuf.readUInt32LE(0);
    const m = desktopHost.mount(fakeHwnd, choice.parentHwnd, choice.insertAfterHwnd,
      { x: FX, y: FY, w: FW, h: FH });
    check('假 WorkerW 挂载成功（和系统行为一致）', m.ok, m.ok ? '' : `@${m.step}: ${m.error}`);
    fake.showInactive();
    /*
     * 快速多重采样：看门狗每 2s 就会把舞台重申回假窗口之上，
     * 采样必须赶在下一轮看门狗之前完成。3 连拍（≈0.3s）内只要有一帧黑
     * 就算遮挡生效（SetWindowPos 是同步的，像素落地很快）。
     */
    let coveredBlack = 0;
    for (let i = 0; i < 3; i += 1) {
      coveredBlack = Math.max(coveredBlack, blackRatio(grabScreen(RX, RY, RW, RH)));
      if (coveredBlack > 0.85) break;
      await sleep(100);
    }
    check('舞台被盖住（区域变黑，复现 §2.14）', coveredBlack > 0.85,
      `黑占比=${(coveredBlack * 100).toFixed(1)}%`);

    // ---- 5. 等看门狗重申 Z 序 ----
    console.log('\n----- 4. 等看门狗自愈（2s 一轮，最多 10s）-----');
    const healT0 = Date.now();
    let healed = null;
    while (Date.now() - healT0 < 10000) {
      await sleep(500);
      const cur = grabScreen(RX, RY, RW, RH);
      if (blackRatio(cur) < 0.15) { healed = cur; break; }
    }
    check('看门狗重申 Z 序，画面恢复', healed !== null,
      healed ? `耗时 ${((Date.now() - healT0) / 1000).toFixed(1)}s` : '10s 内未恢复');
    if (healed && !foreignContent) {
      const drift = diffRatio(still, healed);
      check('恢复后仍是舞台内容（与遮挡前一致）', drift < 0.4,
        `帧差=${(drift * 100).toFixed(2)}%（遮挡窗口已冻结舞台，应为 0）`);
    }
    liveStage.applyPauseState({ away: false });   // 解冻，后续段落照常换图
    await sleep(300);
    const after = liveStage.stats();
    check('看门狗没有误报降级', after.stages.every((s) => !s.degraded));

    // ---- 6. 焦点礼貌性检查 ----
    const fgBefore = Number(koffi.address(GDI.GetForegroundWindow()));
    await sleep(200);
    const fgAfter = Number(koffi.address(GDI.GetForegroundWindow()));
    if (fgBefore !== fgAfter) {
      console.log(`  ⚠ 前台窗口变了（fg ${fgBefore.toString(16)} → ${fgAfter.toString(16)}）——` +
        '可能是用户自己在操作，不判失败，只提示');
    } else {
      check('前台焦点未被抢走', true);
    }

    // ---- 7. 收尾 ----
    desktopHost.unmount(fakeHwnd);
    await sleep(200);
    fake.destroy();
    fake = null;
    liveStage.stop();
    check('stop 后舞台清空', liveStage.stats().stages.length === 0);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ FATAL: ${err.message}`);
    if (liveStage) console.log('  stats =', JSON.stringify(liveStage.stats()));
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'config.json'), 'utf8'));
      console.log('  种子配置 albumId =', cfg.albumId, ' liveWallpaper =', cfg.liveWallpaper);
    } catch { /* 忽略 */ }
  } finally {
    if (fake) { try { fake.destroy(); } catch { /* 忽略 */ } }
    try { liveStage.stop(); } catch { /* 忽略 */ }
  }

  console.log(`\n===== e2e 结果: ${pass}/${pass + fail} =====`);
  console.log(`总耗时 ${(Date.now() - t0) / 1000}s`);
  app.exit(fail === 0 ? 0 : 1);
});
