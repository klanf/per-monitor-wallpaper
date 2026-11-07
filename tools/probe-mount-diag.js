#!/usr/bin/env node
/* probe-mount-diag.js —— 复刻 createStage 的挂载链路，逐步报错（2026-11-02 排查冷开机舞台没挂载） */
'use strict';
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const desktopHost = require(path.join(__dirname, '..', 'src', 'desktopHost.js'));

app.whenReady().then(async () => {
  const out = (tag, obj) => console.log(`[${tag}] ${JSON.stringify(obj)}`);
  try {
    const snap = desktopHost.snapshot({});
    out('snapshot', {
      explorerPid: snap.explorerPid,
      virtualDesktop: snap.virtualDesktop,
      defViewHwnd: (snap && JSON.stringify(snap).match(/SHELLDLL_DefView/g) || []).length + ' 处 DefView',
    });
    const choice = desktopHost.chooseMountParent(snap);
    out('choose', choice);

    if (!choice.ok) {
      console.log('[retry] chooseMountParent 失败 → raiseDesktop 后重试');
      const raised = desktopHost.raiseDesktop();
      out('raise', raised);
      const snap2 = desktopHost.snapshot({});
      const choice2 = desktopHost.chooseMountParent(snap2);
      out('choose2', choice2);
      if (!choice2.ok) { console.log('[结论] 两次判定都失败'); app.exit(0); return; }
      choice.ok = choice2.ok; choice.parentHwnd = choice2.parentHwnd;
      choice.insertAfterHwnd = choice2.insertAfterHwnd; choice.strategy = choice2.strategy;
      choice.zOrderManaged = choice2.zOrderManaged;
    }

    // 用真实窗口走完整 mount
    const { screen } = require('electron');
    const d = screen.getAllDisplays()[0];
    const win = new BrowserWindow({
      x: d.workArea.x, y: d.workArea.y, width: 400, height: 300,
      show: false, frame: false, skipTaskbar: true,
    });
    await win.loadURL('data:text/html,<body style="background:%23228">probe</body>');
    const hwnd = win.getNativeWindowHandle();
    const h = hwnd.length === 8 ? Number(hwnd.readBigUInt64LE(0)) : hwnd.readUInt32LE(0);
    const phys = { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height };
    const m = desktopHost.mount(h, choice.parentHwnd, choice.insertAfterHwnd, phys);
    out('mount', m);
    win.destroy();
    console.log('[结论] 探针跑完');
  } catch (err) {
    console.error('[异常]', err.message, err.stack);
  }
  app.exit(0);
});
