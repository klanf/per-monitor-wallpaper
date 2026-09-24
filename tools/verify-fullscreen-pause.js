'use strict';

/**
 * 全屏 / 挂机暂停真机验证（阶段 3）。
 *
 * 会做什么：在**一块屏**上短暂弹出一个无边框窗口盖满该屏工作区（约 3 秒，
 * 默认选副屏、不抢焦点、会在任务栏闪一下）⇒ 断言暂停判定选中它且不误伤
 * 其他屏 ⇒ 关掉 ⇒ 断言恢复。不挂载、不写系统壁纸、不碰用户桌面内容。
 *
 * 判定用 fullscreenWatch.tickNow()（真实 Win32 采样：EnumWindows + cloak 查询 +
 * SHQueryUserNotificationState），不是喂假数据 —— 单测（verify:live 之外的新
 * verify:fullscreen-pause-unit）已经钉死纯逻辑，这里验的是「真窗口被真枚举到」。
 *
 * 用法：python tools/run-electron.py tools/verify-fullscreen-pause.js
 */

const { app, BrowserWindow, screen } = require('electron');
const fw = require('../src/fullscreenWatch');

// 全屏窗口销毁后还要跑「恢复」断言：必须拦掉 Electron 默认的
// 「所有窗口关闭 → 自动退出」，否则进程死在半路，后半段静默不执行
app.on('window-all-closed', () => {});

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('全屏 / 挂机暂停真机验证\n');

  // ---- ① 环境自检：Win32 采样层可用 ----
  {
    const areas = fw.workAreas();
    check(`枚举到 ${areas.length} 块显示器（Electron screen）`, areas.length >= 1,
      JSON.stringify(areas.map((a) => a.work)));

    const s = fw.sample();
    check('Win32 采样成功（EnumWindows + shell32 + dwmapi）', s.ok, s.ok ? `windows=${s.windows.length}` : s.error);
    if (s.ok) {
      check('窗口表非空', s.windows.length > 10, `n=${s.windows.length}`);
      check('当前不在锁屏 / 屏保（away=false）', s.away === false,
        s.away ? 'QUNS_NOT_PRESENT —— 你正好锁屏了？解锁后重跑' : '');
      const progman = s.windows.find((w) => w.cls === 'Progman');
      check('采样里有 Progman 且 rect 是物理像素', Boolean(progman), progman && JSON.stringify(progman.rect));
    }
  }

  // ---- ② 选一块屏：优先副屏（不打扰主屏），单屏则用主屏 ----
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => !d.primary) || displays[0];
  const others = displays.filter((d) => d.id !== target.id).map((d) => d.id);

  // ---- ③ 造全屏窗口：盖满 target 的工作区（外扩 2px 防止 DIP 取整欠 1px）----
  const wa = target.workArea;
  const fw2 = fw;
  let full = null;
  {
    full = new BrowserWindow({
      x: wa.x - 2, y: wa.y - 2,
      width: wa.width + 4, height: wa.height + 4,
      show: false,
      frame: false,
      backgroundColor: '#202020',
      // 注意：不能 skipTaskbar —— 那会带上 WS_EX_TOOLWINDOW，被判定层合法排除
      skipTaskbar: false,
      focusable: false,
    });
    full.showInactive();   // 不抢焦点
    await sleep(400);      // 等 OS 完成映射，GetWindowRect 才是终值
  }

  // ---- ④ 真机判定：全屏 ⇒ 该屏暂停，其他屏不误伤 ----
  {
    const r = fw2.tickNow();
    check('tickNow 采样成功', r.ok, r.ok ? '' : r.error);
    if (r.ok) {
      check(`全屏窗口被判定：display ${target.id} 暂停`, r.pausedIds.includes(target.id),
        `paused=[${r.pausedIds}] reasons=${JSON.stringify(r.reasons)}`);
      check('暂停原因是 fullscreen', r.reasons[target.id] === 'fullscreen');
      const hitOther = others.filter((id) => r.pausedIds.includes(id));
      check(`其他屏不误伤（${others.length ? others.join(',') : '单屏无其他'}）`, hitOther.length === 0,
        hitOther.length ? `误伤=${hitOther}` : '');
      check('changed=true（状态确实变化了）', r.changed === true);
    }

    // 开关：pauseOnFullscreen=false ⇒ 同一个窗口不再触发
    const rOff = fw2.tickNow({ pauseOnFullscreen: false });
    check('pauseOnFullscreen=false ⇒ 不暂停（开关实时生效）',
      rOff.ok && !rOff.pausedIds.includes(target.id), `paused=[${rOff.pausedIds}]`);
  }

  // ---- ⑤ 拆掉全屏窗口 ⇒ 恢复 ----
  full.destroy();
  await sleep(500);
  {
    const r = fw2.tickNow();
    check('撤掉全屏 ⇒ 暂停集合为空（自动恢复）', r.ok && r.pausedIds.length === 0,
      `paused=[${r.pausedIds}]`);
  }

  console.log(`\n===== fullscreen-pause 结果: ${pass}/${pass + fail} =====`);
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch((err) => {
  console.error('验证崩溃:', err);
  app.exit(2);
});
