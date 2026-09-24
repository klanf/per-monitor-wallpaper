'use strict';

/**
 * 阶段 0 挂载 PoC —— 验证「把 Electron 窗口挂到 Progman 里、置于桌面图标之下」到底能不能用。
 *
 * 这是整个动态桌面方案**唯一的风险闸门**：Chromium 假设自己是顶层窗口，
 * `SetParent` 之后合成器还会不会继续出帧，读代码是判断不出来的，只能实测。
 *
 * ⚠️ 判据为什么不用 `capturePage` / `desktopCapturer`：
 *   `capturePage` 是**让渲染进程自己交一张图**，窗口在屏幕上没刷新也照样能取到画面 ⇒ **假绿**。
 *   唯一可信的是**对屏幕做 `BitBlt` 抓屏**：抓的是合成器最终送到显示器上的像素。
 *   两次采样之间画面要跨过一次动画，两帧像素不同才算「真的在刷」。
 *
 * 会做什么（大约 20 秒，期间桌面会被一块洋红画面覆盖）：
 *   1. 起一块无边框窗口（1×1，不抢焦点），加载一个逐帧变化的页面
 *   2. 采一次基线（确认采样区当前不是洋红）
 *   3. 挂到 Progman、插到 SHELLDLL_DefView 之后、铺满整个虚拟桌面
 *   4. BitBlt 判活：画面是我们的洋红 + 两帧像素不同
 *   5. **制造一次真实的系统壁纸写入**（写回原图，视觉不变），再判一次 ——
 *      这一步是因为实测发现「写壁纸会拆掉 WorkerW 挂载层」，要确认挂 Progman 能不能躲过去
 *   6. 检查是否进了 Alt+Tab、是否抢了焦点、图标层是不是仍在我们之上
 *   7. 卸载并退出
 *
 * 用法：
 *   python tools/run-electron.py tools/probe-attach.js          # 完整跑
 *   python tools/run-electron.py tools/probe-attach.js --no-write   # 跳过壁纸写入那一步
 *   python tools/run-electron.py tools/probe-attach.js --region=full  # 采样整个虚拟桌面
 */

const fs = require('fs');
const path = require('path');

const { app, BrowserWindow } = require('electron');
const koffi = require('koffi');

const desktopHost = require('../src/desktopHost');
const desktopWallpaper = require('../src/desktopWallpaper');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const ARGV = process.argv.slice(1);
const hasFlag = (f) => ARGV.includes(f);
const argValue = (name, dflt) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const SKIP_WRITE = hasFlag('--no-write');
const REGION = argValue('region', 'auto'); // auto | full | primary | secondary
const OUT_JSON = argValue('out', null);

// ⚠️ 这三条都必须在 ready 之前设。
//   最后一条尤其关键：Chromium 的「窗口遮挡检测」在 SetParent 之后极可能判定我们的窗口被挡住，
//   然后**停止出帧** —— 现象和「合成器不支持」完全一样，会得出错误结论。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// ---------------------------------------------------------------------------
// 抓屏（GDI BitBlt → DIB）
// ---------------------------------------------------------------------------

const GDI = (() => {
  const u = koffi.load('user32.dll');
  const g = koffi.load('gdi32.dll');
  return {
    GetDC: u.func('void *GetDC(void *hwnd)'),
    ReleaseDC: u.func('int ReleaseDC(void *hwnd, void *hdc)'),
    GetForegroundWindow: u.func('void *GetForegroundWindow()'),
    GetSystemMetrics: u.func('int GetSystemMetrics(int nIndex)'),
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

/** 抓屏幕上的一块区域，返回 BGRA 像素 Buffer（top-down） */
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
  bmi.writeUInt32LE(0, 16);  // BI_RGB

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

const MAGENTA = (r, g, b) => r > 200 && g < 80 && b > 200;

function analyze(buf, w, h) {
  const total = w * h;
  let magenta = 0;
  let sumR = 0; let sumG = 0; let sumB = 0;
  for (let i = 0; i < total; i += 1) {
    const b = buf[i * 4]; const g = buf[i * 4 + 1]; const r = buf[i * 4 + 2];
    sumR += r; sumG += g; sumB += b;
    if (MAGENTA(r, g, b)) magenta += 1;
  }
  return {
    magentaRatio: +(magenta / total).toFixed(4),
    mean: [Math.round(sumR / total), Math.round(sumG / total), Math.round(sumB / total)],
  };
}

/** 两帧像素差异比例（阈值 24 以忽略抖动/压缩噪声） */
function diffRatio(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 24) d += 1;
  return +(d / a.length).toFixed(4);
}

// ---------------------------------------------------------------------------
// PoC 页面：洋红底 + 移动的黑块 + 帧计数
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;overflow:hidden;background:#FF00FF}
  #blk{position:fixed;width:420px;height:420px;background:#000;will-change:transform}
  #n{position:fixed;right:24px;bottom:24px;font:700 64px monospace;color:#0f0;background:#000;padding:8px 20px}
</style></head><body>
<div id="blk"></div><div id="n">0</div>
<script>
  window.__frames = 0;
  const blk = document.getElementById('blk');
  const n = document.getElementById('n');
  function tick(ts) {
    window.__frames++;
    const t = (ts || 0) / 1000;
    blk.style.transform = 'translate(' + (Math.round(900 + 700 * Math.sin(t * 1.6))) + 'px,'
                                      + (Math.round(500 + 400 * Math.cos(t * 1.6))) + 'px)';
    if (window.__frames % 6 === 0) n.textContent = String(window.__frames);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
</script></body></html>`;

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const results = [];
const log = (s = '') => { process.stdout.write(s + '\n'); };

function record(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
  log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `   ${detail}` : ''}`);
  return Boolean(pass);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => '0x' + Number(n || 0).toString(16);

/** 打印 Progman 子窗口的 Z 序 —— 用来诊断「到底是谁压在我们上面」 */
function printProgmanChildren(label, ourHwnd) {
  const s = desktopHost.snapshot({ monitors: [] });
  const kids = s.progman ? s.progman.children : [];
  log(`     Progman 子窗口 Z 序（${label}，index 小的在上层）：`);
  if (!kids.length) log('       (空)');
  kids.forEach((n, i) => {
    log(`       [${i}] ${String(n.cls).padEnd(18)} ${hx(n.hwnd).padEnd(10)} ` +
      `${String(`${n.rect.w}×${n.rect.h}`).padEnd(12)} visible=${n.visible}${n.hwnd === ourHwnd ? '   ← 我们' : ''}`);
  });
}

/** 采样区：按虚拟桌面 + 显示器列表挑一块，返回 {x,y,w,h,label} */
function pickRegion(snap) {
  const vd = snap.virtualDesktop;
  const mon = snap.monitors;
  const SW = 640;
  const SH = 400;

  if (REGION === 'full') {
    return { x: vd.x + Math.round(vd.w / 2) - SW / 2, y: vd.y + Math.round(vd.h / 2) - SH / 2, w: SW, h: SH, label: '虚拟桌面中心' };
  }
  if (REGION === 'primary' || REGION === 'secondary' || REGION === 'auto') {
    const primary = mon.find((m) => m.primary) || mon[0];
    const secondary = mon.find((m) => !m.primary);
    let target = null;
    if (REGION === 'primary') target = primary;
    else if (REGION === 'secondary') target = secondary;
    else target = secondary || primary; // auto：优先副屏（用户的主屏通常有窗口挡着）
    if (target) {
      return {
        x: target.x + Math.round(target.width / 2) - SW / 2,
        y: target.y + Math.round(target.height / 2) - SH / 2,
        w: SW, h: SH,
        label: `${target.primary ? '主屏' : '副屏'} ${target.width}×${target.height} 中心`,
      };
    }
  }
  return { x: vd.x + 200, y: vd.y + 200, w: SW, h: SH, label: '虚拟桌面左上角（兜底）' };
}

/** 我们自己的窗口句柄（Electron 给的是 Buffer，x64 = 8 字节小端） */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

async function run() {
  log('='.repeat(84));
  log('阶段 0 挂载 PoC —— 把窗口挂到 Progman 下、桌面图标之上');
  log('='.repeat(84));

  // ---- 0. 环境 ----
  const dpi = desktopHost.ensureDpiAwareness();
  const monInfo = desktopWallpaper.enumMonitors();
  let snap = desktopHost.snapshot({ monitors: monInfo.ok ? monInfo.monitors : [] });

  log('\n----- 0. 环境 -----');
  record('拿到桌面窗口树快照', snap.ok, `DPI=${dpi}`);
  record('虚拟桌面坐标是物理像素（不是被缩放过的 DIP）',
    snap.virtualDesktop.w === 5440 && snap.virtualDesktop.h === 2560,
    `${snap.virtualDesktop.w}×${snap.virtualDesktop.h} @${snap.virtualDesktop.x},${snap.virtualDesktop.y}`);
  record('COM 每屏壁纸可用', monInfo.ok, monInfo.ok ? `${monInfo.monitors.length} 台显示器` : String(monInfo.error));

  const decision = desktopHost.chooseMountParent(snap);
  record('选出了挂载点', decision.ok, `${decision.strategy} → ${hx(decision.parentHwnd)} (${decision.parentCls})，插到 ${hx(decision.insertAfterHwnd)} 之后`);
  if (!decision.ok) {
    log('\n⇒ 挂载点判定没过（这是**设计好的拒绝**，不是异常）。按任务书纪律：退回静态壁纸，不将就挂。');
    return;
  }

  const parentHwnd = decision.parentHwnd;
  const anchorHwnd = decision.insertAfterHwnd;
  const region = pickRegion(snap);
  log(`  采样区：${region.label} ${region.w}×${region.h} @${region.x},${region.y}`);

  // ---- 1. 建窗口（1×1、隐藏位置、不抢焦点）----
  log('\n----- 1. 建窗口 -----');
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    x: 0,
    y: 0,
    frame: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    transparent: false,
    backgroundColor: '#FF00FF',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  const ourHwnd = hwndOf(win);
  record('窗口已创建并拿到原生句柄', ourHwnd > 0, hx(ourHwnd));

  const fgBefore = Number(koffi.address(GDI.GetForegroundWindow()));

  // 先显示成 1×1 让它开始出帧（隐藏窗口 Chromium 会暂停渲染），1 像素的洋红不影响统计
  win.showInactive();
  await sleep(600);

  // ---- 2. 基线采样 ----
  log('\n----- 2. 基线（挂载前）-----');
  const base = grabScreen(region.x, region.y, region.w, region.h);
  const baseStat = analyze(base, region.w, region.h);
  record('采样区当前基本没有洋红（说明这块没被我们的窗口盖住）',
    baseStat.magentaRatio < 0.2, `洋红占比=${baseStat.magentaRatio} 均值=${baseStat.mean}`);
  const baseFrames = await win.webContents.executeJavaScript('window.__frames').catch(() => -1);
  log(`  渲染进程帧计数=${baseFrames}（辅助证据：只说明渲染在跑，不说明屏幕上在刷）`);

  // ---- 3. 挂载 ----
  log('\n----- 3. 挂载到 Progman（铺满整个虚拟桌面）-----');
  const bounds = { x: 0, y: 0, w: snap.virtualDesktop.w, h: snap.virtualDesktop.h };
  const m = desktopHost.mount(ourHwnd, parentHwnd, anchorHwnd, bounds);
  record('SetParent + 补样式 + SetWindowPos 全部成功', m.ok, m.ok ? '' : `${m.step}: ${m.error}`);
  if (!m.ok) { log('  ⇒ 挂载动作本身失败，停止。'); return; }

  await sleep(1200);

  // ---- 4. BitBlt 判活 ----
  log('\n----- 4. 判活（BitBlt 抓屏，不是 capturePage）-----');
  const a = grabScreen(region.x, region.y, region.w, region.h);
  const sa = analyze(a, region.w, region.h);
  await sleep(1300);
  const b = grabScreen(region.x, region.y, region.w, region.h);
  const sb = analyze(b, region.w, region.h);

  record('屏幕上能看到我们的画面（洋红占比高）', sa.magentaRatio > 0.5, `占比=${sa.magentaRatio}`);
  const d1 = diffRatio(a, b);
  record('画面在刷新（两次采样像素不同）', d1 > 0.005, `差异=${(d1 * 100).toFixed(2)}%`);
  const framesNow = await win.webContents.executeJavaScript('window.__frames').catch(() => -1);
  log(`  渲染进程帧计数=${framesNow}（较基线 +${framesNow - baseFrames}）`);

  // ---- 5. 穿过一次真实的系统壁纸写入 ----
  let afterWrite = null;
  if (SKIP_WRITE) {
    log('\n----- 5. 壁纸写入穿透测试：已按 --no-write 跳过 -----');
  } else {
    log('\n----- 5. 壁纸写入穿透测试（写回原图，视觉不变）-----');
    const targets = monInfo.monitors.filter((x) => x.current && fs.existsSync(x.current));
    record('读到了各屏当前壁纸路径（可安全写回同一张）', targets.length === monInfo.monitors.length,
      targets.map((x) => `${x.primary ? '主屏' : '副屏'}=${path.basename(x.current || '')}`).join(' '));

    if (targets.length) {
      const wpFile = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
      const mtBefore = (() => { try { return fs.statSync(wpFile).mtimeMs; } catch { return 0; } })();
      for (const t of targets) desktopWallpaper.setWallpaper(t.id, t.current);
      await sleep(1500);
      const mtAfter = (() => { try { return fs.statSync(wpFile).mtimeMs; } catch { return 0; } })();
      record('系统确实发生了一次壁纸写入（TranscodedWallpaper mtime 变了）', mtAfter !== mtBefore,
        `mtime ${new Date(mtBefore).toLocaleTimeString('zh-CN')} → ${new Date(mtAfter).toLocaleTimeString('zh-CN')}`);
      log('  （注意：不能用 SPI_GETDESKWALLPAPER 判「壁纸变没变」—— 路径恒定，会得出假结论）');

      afterWrite = grabScreen(region.x, region.y, region.w, region.h);
      const sw = analyze(afterWrite, region.w, region.h);
      const covered = sw.magentaRatio <= 0.5;
      log(`  写入后画面洋红占比：${sw.magentaRatio}` +
        (covered ? '  ← 被盖住了（实测现象：Explorer 重建的 WorkerW 插到了我们上面）' : '  ← 仍可见'));

      {
        log('\n  ⇒ 画面没了。先分清是「挂载被拆」还是「被别的窗口盖住」：');
        const chk = desktopHost.assertMount(ourHwnd, parentHwnd, anchorHwnd);
        log(`     父子关系：alive=${chk.alive} parentAlive=${chk.parentAlive} attached=${chk.attached} actualParent=${hx(chk.actualParent)}`);
        const intact = desktopHost.isZOrderIntact(ourHwnd, anchorHwnd);
        log(`     Z 序自检：紧贴我上面的${intact ? '就是锚点（正常）' : '**不是锚点** ⇒ 有窗口压着我们'}`);
        printProgmanChildren('写入之后', ourHwnd);
      }

      // ---- 5b. 补救通道：看门狗式连续重申 Z 序 ----
      log('\n----- 5b. 补救：连续重申 Z 序（看门狗要用的那条路）-----');
      const intactBefore = desktopHost.isZOrderIntact(ourHwnd, anchorHwnd);
      record('Z 序自检与画面状态一致', covered ? intactBefore === false : intactBefore === true,
        `covered=${covered} intact=${intactBefore}`);

      let recoveredAt = -1;
      for (let i = 1; i <= 6; i += 1) {
        desktopHost.reaffirmZOrder(ourHwnd, anchorHwnd, bounds);
        await sleep(600);
        const st = analyze(grabScreen(region.x, region.y, region.w, region.h), region.w, region.h);
        const intact = desktopHost.isZOrderIntact(ourHwnd, anchorHwnd);
        log(`     第 ${i} 次重申后：洋红占比=${st.magentaRatio}  Z序检查=${intact ? '✓' : '✗'}`);
        if (st.magentaRatio > 0.5 && intact) { recoveredAt = i; break; }
      }
      record('连续重申能把画面救回来', recoveredAt > 0,
        recoveredAt > 0 ? `第 ${recoveredAt} 次（约 ${(recoveredAt * 0.6).toFixed(1)}s）` : '6 次都没救回来');

      const fixedBuf = grabScreen(region.x, region.y, region.w, region.h);
      await sleep(1300);
      const d2 = diffRatio(fixedBuf, grabScreen(region.x, region.y, region.w, region.h));
      record('恢复之后仍在刷新', d2 > 0.005, `差异=${(d2 * 100).toFixed(2)}%`);
      record('恢复之后 Z 序稳住了（1.3s 后没再被挤下去）', desktopHost.isZOrderIntact(ourHwnd, anchorHwnd));

      // ---- 5c. WorkerW 堆积观察：连写 5 次，看会不会越堆越多 ----
      log('\n----- 5c. WorkerW 堆积观察（连写 5 次系统壁纸）-----');
      const wwCount = () => {
        const s = desktopHost.snapshot({ monitors: [] });
        return (s.progman ? s.progman.children : []).filter((x) => x.cls === 'WorkerW').length;
      };
      const counts = [wwCount()];
      log(`  起始：${counts[0]} 个`);
      for (let i = 0; i < 5; i += 1) {
        for (const t of targets) desktopWallpaper.setWallpaper(t.id, t.current);
        await sleep(1200);
        counts.push(wwCount());
        log(`  第 ${i + 1} 次写入后：${counts[counts.length - 1]} 个`);
      }
      record('WorkerW 没有无限堆积（连写 5 次后增量 ≤ 3）',
        counts[counts.length - 1] - counts[0] <= 3,
        `序列 ${counts.join(' → ')}`);

      desktopHost.reaffirmZOrder(ourHwnd, anchorHwnd, bounds);
      await sleep(800);
      record('连写 5 次之后重申一次仍能恢复',
        analyze(grabScreen(region.x, region.y, region.w, region.h), region.w, region.h).magentaRatio > 0.5);
    } else {
      log('  ⇒ 读不到可信的壁纸路径，跳过这一步（不做有风险的写入）');
    }
  }

  // ---- 6. 行为检查 ----
  log('\n----- 6. 行为检查（Alt+Tab / 焦点 / 图标层）-----');
  const st = desktopHost.assertMount(ourHwnd, parentHwnd, anchorHwnd);
  record('挂载关系仍然成立（父窗口活着且自己还挂在它下面）', st.ok,
    `alive=${st.alive} parentAlive=${st.parentAlive} attached=${st.attached} actualParent=${hx(st.actualParent)}`);

  const snap2 = desktopHost.snapshot({ monitors: [] });
  const flat2 = desktopHost.flatten([snap2.progman]);
  const me = flat2.find((n) => n.hwnd === ourHwnd);
  const dv = flat2.find((n) => n.cls === desktopHost.CONST.DEFVIEW_CLASS);
  const sibs = snap2.progman ? snap2.progman.children.map((n) => n.hwnd) : [];
  const myIdx = sibs.indexOf(ourHwnd);
  const dvIdx = dv ? sibs.indexOf(dv.hwnd) : -1;
  record('我们的窗口确实挂在 Progman 下面', Boolean(me), me ? `尺寸 ${me.rect.w}×${me.rect.h} visible=${me.visible}` : '不在 Progman 子窗口列表里');
  record('图标层仍在我们之上（index 更靠前 = Z 序更高）', dvIdx >= 0 && myIdx > dvIdx,
    `DefView index=${dvIdx} / 我们 index=${myIdx}`);
  record('尺寸铺满了虚拟桌面', Boolean(me) && Math.abs(me.rect.w - bounds.w) <= 2 && Math.abs(me.rect.h - bounds.h) <= 2,
    me ? `${me.rect.w}×${me.rect.h} vs 期望 ${bounds.w}×${bounds.h}` : '');

  const fgAfter = Number(koffi.address(GDI.GetForegroundWindow()));
  record('没有抢走前台焦点', fgAfter === fgBefore, `之前=${hx(fgBefore)} 之后=${hx(fgAfter)}`);

  // ---- 7. 卸载 ----
  log('\n----- 7. 卸载并退出 -----');
  const um = desktopHost.unmount(ourHwnd);
  record('卸载成功（恢复成普通窗口）', um.ok, um.error || '');
  await sleep(200);
  const snap3 = desktopHost.snapshot({ monitors: [] });
  const stillChild = snap3.progman ? snap3.progman.children.some((n) => n.hwnd === ourHwnd) : false;
  record('卸载后已不在 Progman 的子窗口里', !stillChild);
  log('\n（窗口随进程退出销毁；桌面自动恢复）');

  // ---- 汇总 ----
  const failed = results.filter((r) => !r.pass);
  log('\n' + '='.repeat(84));
  log(`结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
  if (failed.length) {
    log('失败项：');
    for (const f of failed) log(`  ✗ ${f.name}  ${f.detail}`);
  } else {
    log('✅ 阶段 0 风险闸门通过：SetParent 到 Progman 之后，Chromium 仍在出帧，且能穿过一次壁纸写入。');
  }
  log('='.repeat(84));

  if (OUT_JSON) {
    fs.mkdirSync(path.dirname(path.resolve(OUT_JSON)), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify({
      at: new Date().toISOString(),
      dpi,
      virtualDesktop: snap.virtualDesktop,
      decision: { strategy: decision.strategy, parentHwnd: decision.parentHwnd, insertAfterHwnd: decision.insertAfterHwnd, checks: decision.checks },
      region,
      samples: { base: baseStat, afterMount: sa, afterWrite: afterWrite ? analyze(afterWrite, region.w, region.h) : null },
      results,
    }, null, 2), 'utf8');
    log(`JSON 已写入 ${OUT_JSON}`);
  }

  process.exitCode = failed.length ? 1 : 0;
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    log('\n[probe-attach] 未捕获异常: ' + (err && err.stack ? err.stack : err));
    process.exitCode = 2;
  } finally {
    try { desktopWallpaper.release(); } catch { /* ignore */ }
    app.exit(process.exitCode || 0);
  }
});

app.on('window-all-closed', () => { /* 由 app.exit 收尾 */ });
