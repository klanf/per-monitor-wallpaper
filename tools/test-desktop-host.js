'use strict';

/**
 * 动态桌面「挂载点判定」单测（不需要 Electron、不碰系统、不碰任何窗口）。
 *
 * `src/desktopHost.js` 的判定层被刻意做成**纯函数**：只吃一个普通对象（窗口树快照），
 * 所以这里可以喂各种假窗口树，把「本机形态」「老式形态」「各种残破形态」全覆盖住 ——
 * 而真正的挂载动作（SetParent / SetWindowPos）留给 `tools/probe-attach.js` 在真机上验。
 *
 * 为什么必须把这些判据钉死在单测里：
 *   挂错窗口的失败是**静默**的（`SetParent` 依然返回成功，屏幕上什么都没有、也不报错），
 *   事后极难归因。所以宁可在这里把 16 种「不该挂」的情形全枚举一遍。
 *
 * 假数据按 **2026-09-24 真机快照**（`node tools/desktop-tree.js --json`）复刻。
 */

const path = require('node:path');

const desktopHost = require('../src/desktopHost');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

// ---------------------------------------------------------------------------
// 假窗口树
// ---------------------------------------------------------------------------

const VD = { x: -1600, y: 0, w: 5440, h: 2560 };
const EXPLORER_PID = 7440;

function node(cls, hwnd, opts = {}) {
  return {
    hwnd,
    cls,
    title: opts.title || '',
    rect: opts.rect || { x: VD.x, y: VD.y, w: VD.w, h: VD.h },
    visible: opts.visible !== false,
    pid: opts.pid === undefined ? EXPLORER_PID : opts.pid,
    parentHwnd: opts.parentHwnd || 0,
    children: opts.children || [],
  };
}

/** 本机真实形态：DefView 在 Progman 里；顶层另有 16 个 202×56 的隐形 WorkerW */
function realSnapshot(overrides = {}) {
  const defView = node('SHELLDLL_DefView', 0x1014e, {
    parentHwnd: 0x3013a,
    children: [node('SysListView32', 0x10150, { parentHwnd: 0x1014e, visible: false })],
  });
  const progman = node('Progman', 0x3013a, {
    title: 'Program Manager',
    parentHwnd: 0,
    children: [defView, node('WorkerW', 0xa112e, { parentHwnd: 0x3013a })],
  });
  const ghostWorkerWs = [];
  for (let i = 0; i < 16; i += 1) {
    ghostWorkerWs.push(node('WorkerW', 0x101cc + i * 4, {
      rect: { x: 0, y: 0, w: 202, h: 56 },
      visible: false,
      parentHwnd: 0,
    }));
  }
  return {
    ok: true,
    at: '2026-09-24T08:48:41.323Z',
    dpi: 'per-monitor-v2',
    virtualDesktop: { ...VD },
    monitors: [],
    explorerPid: EXPLORER_PID,
    progman,
    topLevel: [progman, ...ghostWorkerWs],
    ...overrides,
  };
}

function main() {
  /* ================= 1. 找图标层与持有者 ================= */
  console.log('\n===== 1. 找图标层与持有者（findDefView）=====');
  {
    const s = realSnapshot();
    const r = desktopHost.findDefView(s);
    check('在整棵树里找到 SHELLDLL_DefView', Boolean(r.defView), r.defView ? `hwnd=0x${r.defView.hwnd.toString(16)}` : '');
    check('持有者是 Progman', Boolean(r.holder) && r.holder.cls === 'Progman', r.holder ? r.holder.cls : 'null');
    check('没有报错', r.error === null, String(r.error));

    // 深度优先：DefView 在 Progman.children 里，不在顶层
    check('确实是从子树里找到的（顶层没有它）',
      !s.topLevel.some((n) => n.cls === 'SHELLDLL_DefView'));
  }

  {
    const r = desktopHost.findDefView(realSnapshot({ progman: null, topLevel: [] }));
    check('整棵树为空 ⇒ 报错且不给持有者', r.defView === null && r.holder === null && Boolean(r.error), String(r.error));
  }

  {
    // DefView 存在，但父窗口被裁掉了（快照没采到那层）
    const orphan = node('SHELLDLL_DefView', 0x777, { parentHwnd: 0x555 });
    const r = desktopHost.findDefView(realSnapshot({ topLevel: [orphan], progman: null }));
    check('找到 DefView 但父窗口不在快照里 ⇒ 报错', r.defView !== null && r.holder === null && /父窗口不在快照里/.test(String(r.error)), String(r.error));
  }

  /* ================= 2. 挂载决策 ================= */
  console.log('\n===== 2. 挂载决策（chooseMountParent）=====');
  {
    const d = desktopHost.chooseMountParent(realSnapshot());
    check('本机形态 ⇒ ok', d.ok === true);
    check('策略是 progman（首选路径）', d.strategy === 'progman', d.strategy);
    check('挂到 Progman 0x3013a', d.parentHwnd === 0x3013a, `0x${d.parentHwnd.toString(16)}`);
    check('插入锚点是 DefView 0x1014e', d.insertAfterHwnd === 0x1014e, `0x${d.insertAfterHwnd.toString(16)}`);
    check('全部判据通过', d.checks.every((c) => c.pass), `${d.checks.filter((c) => c.pass).length}/${d.checks.length}`);
  }

  {
    // 老式布局：DefView 挂在顶层 WorkerW 里
    const defView = node('SHELLDLL_DefView', 0x202, { parentHwnd: 0x201 });
    const holder = node('WorkerW', 0x201, { parentHwnd: 0, children: [defView] });
    const d = desktopHost.chooseMountParent(realSnapshot({ progman: null, topLevel: [holder] }));
    check('老式形态（DefView 在 WorkerW 里）⇒ ok', d.ok === true);
    check('策略是 workerw-holder', d.strategy === 'workerw-holder', d.strategy);
    check('挂到那个 WorkerW', d.parentHwnd === 0x201, `0x${d.parentHwnd.toString(16)}`);
  }

  {
    const defView = node('SHELLDLL_DefView', 0x202, { parentHwnd: 0x201 });
    const holder = node('WorkerW', 0x201, { parentHwnd: 0, children: [defView] });
    const d = desktopHost.chooseMountParent(realSnapshot({ progman: null, topLevel: [holder] }), { allowWorkerWHolder: false });
    check('禁用退路后 WorkerW 持有者 ⇒ 拒绝', d.ok === false && d.strategy === 'none', d.reason);
  }

  {
    // 父窗口类名不认识（比如某些壳层软件改名）⇒ 必须拒绝，绝不将就挂
    const defView = node('SHELLDLL_DefView', 0x202, { parentHwnd: 0x201 });
    const holder = node('SomeShellHost', 0x201, { parentHwnd: 0, children: [defView] });
    const d = desktopHost.chooseMountParent(realSnapshot({ progman: null, topLevel: [holder] }));
    check('父窗口类名不受支持 ⇒ 拒绝挂载', d.ok === false, d.reason);
    check('拒绝理由里说明「不在支持范围」', /不在支持范围内/.test(d.reason), d.reason);
  }

  {
    const d = desktopHost.chooseMountParent(realSnapshot({ progman: null, topLevel: [] }));
    check('没有图标层 ⇒ 拒绝（说明桌面没起来）', d.ok === false && /找不到 SHELLDLL_DefView/.test(d.reason), d.reason);
  }

  {
    // 图标层被隐藏（用户关掉了"显示桌面图标"）—— 仍然可以挂，只是 checks 里那一条为 false
    const defView = node('SHELLDLL_DefView', 0x1014e, { parentHwnd: 0x3013a, visible: false });
    const progman = node('Progman', 0x3013a, { parentHwnd: 0, children: [defView] });
    const d = desktopHost.chooseMountParent(realSnapshot({ topLevel: [progman], progman }));
    const visCheck = d.checks.find((c) => c.name === '图标层可见');
    check('图标层隐藏时不拦截（仍可挂）', d.ok === true, d.strategy);
    check('但判定表里如实标出「不可见」', Boolean(visCheck) && visCheck.pass === false);
  }

  /* ================= 3. 退路：WorkerW 四条判定 ================= */
  console.log('\n===== 3. 退路候选判定（judgeWorkerWCandidates）=====');
  {
    const v = desktopHost.judgeWorkerWCandidates(realSnapshot(), null);
    check('本机上顶层 WorkerW 有 16 个', v.length === 16, `实际 ${v.length}`);
    check('全部落选（这就是网上那套写法会挑错的证据）', v.every((x) => !x.pass),
      `通过 ${v.filter((x) => x.pass).length} 个`);
    check('落选原因是尺寸（202×56 ≠ 虚拟桌面）',
      v.every((x) => x.checks.sizeOk.pass === false || !x.checks.isNew.pass));
    check('不传发消息前的快照 ⇒ ① 记为未知而不是通过',
      v.every((x) => x.checks.isNew.pass === false && /未知/.test(x.checks.isNew.detail)));
  }

  {
    const before = realSnapshot();
    const preHandles = desktopHost.snapshotWorkerWHandles(before);
    check('能取到发消息前的句柄集合', preHandles.length === 16, `${preHandles.length} 个`);

    // 发消息后：Explorer 造出一个尺寸正确、可见、属于 explorer 的新 WorkerW
    const born = node('WorkerW', 0xdeadbeef, { parentHwnd: 0 });
    const after = realSnapshot({ topLevel: [...before.topLevel, born] });
    const v = desktopHost.judgeWorkerWCandidates(after, preHandles);
    check('新造出的那个通过四条判定', v.some((x) => x.hwnd === 0xdeadbeef && x.pass === true),
      JSON.stringify(v.find((x) => x.hwnd === 0xdeadbeef).checks));
    check('原来那 16 个仍全部落选', v.filter((x) => preHandles.includes(x.hwnd)).every((x) => !x.pass));
  }

  {
    // 反例：尺寸对、可见、属于 explorer，但**发消息前就存在** ⇒ 不能选（这正是那 14 个隐形小窗的升级版陷阱）
    const existing = node('WorkerW', 0xcafe, { parentHwnd: 0 });
    const s = realSnapshot({ topLevel: [...realSnapshot().topLevel, existing] });
    const pre = desktopHost.snapshotWorkerWHandles(s);
    const v = desktopHost.judgeWorkerWCandidates(s, pre);
    check('尺寸/可见/进程都对但发消息前就在 ⇒ 仍落选（① 不成立）',
      v.find((x) => x.hwnd === 0xcafe).pass === false);
  }

  /* ================= 4. 常量与规模 ================= */
  console.log('\n===== 4. 常量（防回归）=====');
  {
    const C = desktopHost.CONST;
    check('WS_CHILD = 0x40000000（挂载必须补这个样式）', C.WS_CHILD === 0x40000000);
    check('WS_POPUP = 0x80000000', C.WS_POPUP === 0x80000000);
    check('WS_EX_NOACTIVATE = 0x08000000', C.WS_EX_NOACTIVATE === 0x08000000);
    check('WS_EX_TOOLWINDOW = 0x00000080', C.WS_EX_TOOLWINDOW === 0x00000080);
    check('GWL_STYLE = -16 / GWL_EXSTYLE = -20', C.GWL_STYLE === -16 && C.GWL_EXSTYLE === -20);
    check('0x052C 没写错', C.WM_SPAWN_WORKERW === 0x052C);
    check('图标层类名没写错', C.DEFVIEW_CLASS === 'SHELLDLL_DefView');
    check('尺寸容差是 8px（不是 0，也不是几千）', C.SIZE_TOLERANCE === 8);
  }

  {
    // flatten 要能穿透多层
    const deep = node('A', 1, { children: [node('B', 2, { children: [node('C', 3)] })] });
    check('flatten 深度优先穿透 3 层', desktopHost.flatten([deep]).length === 3);
    check('flatten 容忍空输入', desktopHost.flatten(null).length === 0);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main();
