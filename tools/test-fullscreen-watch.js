'use strict';

/**
 * 全屏 / 挂机暂停判定单测（纯函数，不碰系统、不碰 koffi）。
 *
 * 判定矩阵全部固化成断言 —— 这是阶段 3 的核心逻辑，误判的方向有两个且都
 * **不报错**：该停没停（GPU 白烧、DoD 的「ELDEN RING 只停那屏」落空），
 * 不该停乱停（桌面被冻死在一张图上）。只能在真机上靠眼睛发现的错，
 * 单测里全部钉死。
 *
 * 用法：node tools/test-fullscreen-watch.js
 */

const fw = require('../src/fullscreenWatch');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

/** 主屏 2560×1440（任务栏 48px 在底部）+ 副屏 1600×2560 竖屏（无任务栏） */
const MONITORS = [
  { id: 1, work: { l: 0, t: 0, r: 2560, b: 1392 } },
  { id: 2, work: { l: -1600, t: 0, r: 0, b: 2560 } },
];

/** 造一个窗口；默认可见、无扩展样式、不 cloak、普通类、矩形给啥是啥 */
function win(over = {}) {
  return {
    visible: over.visible !== false,
    exStyle: over.exStyle || 0,
    cloaked: Boolean(over.cloaked),
    cls: over.cls || 'Chrome_WidgetWin_1',
    rect: over.rect,
    imageName: over.imageName,
  };
}

/** 全屏铺满主屏工作区（无边框全屏 / F11 的形状） */
const FULL_MAIN = { l: 0, t: 0, r: 2560, b: 1392 };
/** 最大化形状：四周外溢 8px（SM_CXFRAME×2），盖住整块屏含任务栏区 */
const MAXIMIZED_MAIN = { l: -8, t: -8, r: 2568, b: 1400 };
/** 全屏铺满副屏工作区 */
const FULL_SECOND = { l: -1600, t: 0, r: 0, b: 2560 };

function evaluate(over = {}) {
  return fw.evaluatePause({
    monitors: over.monitors || MONITORS,
    windows: over.windows || [],
    away: Boolean(over.away),
    pauseOnFullscreen: over.pauseOnFullscreen,
    pauseOnAway: over.pauseOnAway,
  });
}

function main() {
  console.log('全屏暂停判定单测\n');

  // -------------------------------------------------------------------------
  console.log('§1 空场景');
  // -------------------------------------------------------------------------
  {
    const r = evaluate({});
    check('没有窗口 ⇒ 不暂停', r.paused.size === 0);
  }

  // -------------------------------------------------------------------------
  console.log('\n§2 覆盖判定：该停的停');
  // -------------------------------------------------------------------------
  {
    let r = evaluate({ windows: [win({ rect: FULL_MAIN })] });
    check('无边框全屏铺满主屏 ⇒ 主屏暂停', r.paused.has(1) && r.paused.size === 1, `reasons=${JSON.stringify(r.reasons)}`);

    r = evaluate({ windows: [win({ rect: MAXIMIZED_MAIN })] });
    check('最大化窗口（外溢 8px）⇒ 主屏暂停', r.paused.has(1), '覆盖而非精确重合');

    r = evaluate({ windows: [win({ rect: FULL_SECOND })] });
    check('副屏全屏 ⇒ 只暂停副屏（DoD：ELDEN RING 占副屏不动主屏）', r.paused.has(2) && !r.paused.has(1));

    r = evaluate({ windows: [win({ rect: FULL_MAIN }), win({ rect: FULL_SECOND })] });
    check('两屏同时全屏 ⇒ 都暂停', r.paused.has(1) && r.paused.has(2));
  }

  // -------------------------------------------------------------------------
  console.log('\n§3 覆盖判定：不该停的不停');
  // -------------------------------------------------------------------------
  {
    let r = evaluate({ windows: [win({ rect: { l: 100, t: 100, r: 2000, b: 1000 } })] });
    check('普通窗口只占一角 ⇒ 不暂停', r.paused.size === 0);

    r = evaluate({ windows: [win({ rect: FULL_MAIN, visible: false })] });
    check('不可见窗口铺满 ⇒ 不暂停', r.paused.size === 0);

    r = evaluate({ windows: [win({ rect: FULL_MAIN, cloaked: true })] });
    check('cloaked 窗口铺满（UWP 挂起 / 锁屏宿主）⇒ 不暂停', r.paused.size === 0, 'DWMWA_CLOAKED');

    r = evaluate({ windows: [win({ rect: FULL_MAIN, exStyle: fw.CONST.WS_EX_TOOLWINDOW })] });
    check('工具窗铺满（浮层 / 悬浮窗）⇒ 不暂停', r.paused.size === 0);

    for (const cls of fw.SHELL_CLASSES) {
      r = evaluate({ windows: [win({ rect: FULL_MAIN, cls })] });
      check(`Shell 层 ${cls} 铺满 ⇒ 不暂停`, r.paused.size === 0);
    }

    r = evaluate({ windows: [win({ rect: { l: -1500, t: -100, r: 2400, b: 1500 } })] });
    check('大窗口横跨两屏但都没盖满 ⇒ 都不暂停', r.paused.size === 0, '工作区覆盖必须逐屏完整');
  }

  // -------------------------------------------------------------------------
  console.log('\n§4 挂机（QUNS_NOT_PRESENT）');
  // -------------------------------------------------------------------------
  {
    let r = evaluate({ away: true });
    check('锁屏 / 息屏 ⇒ 全部暂停', r.paused.has(1) && r.paused.has(2) && r.reasons[1] === 'away');

    r = evaluate({ away: true, windows: [win({ rect: FULL_MAIN })] });
    check('挂机优先于覆盖判定（锁屏层本身铺满屏幕，EnumWindows 不可信）', r.reasons[1] === 'away');

    r = evaluate({ away: true, pauseOnAway: false });
    check('pauseOnAway=false ⇒ 挂机不触发全停', r.paused.size === 0);

    r = evaluate({ away: true, pauseOnAway: false, windows: [win({ rect: FULL_SECOND })] });
    check('pauseOnAway=false 时覆盖判定照常生效', r.paused.has(2) && !r.paused.has(1));
  }

  // -------------------------------------------------------------------------
  console.log('\n§5 开关');
  // -------------------------------------------------------------------------
  {
    let r = evaluate({ windows: [win({ rect: FULL_MAIN })], pauseOnFullscreen: false });
    check('pauseOnFullscreen=false ⇒ 全屏不触发暂停', r.paused.size === 0);

    r = evaluate({ windows: [win({ rect: FULL_MAIN }), win({ rect: FULL_SECOND })] });
    check('一份窗口表 + 两块屏 = 每屏独立判定', r.paused.size === 2);
  }

  // -------------------------------------------------------------------------
  console.log('\n§6 脏输入防御');
  // -------------------------------------------------------------------------
  {
    let r = fw.evaluatePause({ monitors: [{ id: 1 }, { work: { l: 0, t: 0, r: 1, b: 1 } }, null], windows: [null] });
    check('畸形条目（缺 work / null）不炸、被跳过', r.paused.size === 0);

    r = fw.evaluatePause(null);
    check('整个入参为 null ⇒ 空结果', r.paused.size === 0);

    r = fw.evaluatePause({ monitors: MONITORS, windows: [win({ rect: FULL_MAIN, exStyle: 0x80000000 })] });
    check('扩展样式高位（WS_POPUP 痕迹）不影响判定', r.paused.has(1), '>>>0 转无符号');
  }

  // -------------------------------------------------------------------------
  console.log('\n§7 进程镜像名排除（54 轮追记四：QQ 截图/录屏遮罩误判全屏）');
  // -------------------------------------------------------------------------
  {
    let r = evaluate({ windows: [win({ rect: FULL_MAIN, imageName: 'QQ.exe' })] });
    check('QQ.exe 铺满主屏 ⇒ 不暂停（镜像名命中黑名单）', r.paused.size === 0);

    r = evaluate({ windows: [win({ rect: FULL_MAIN, imageName: 'qq.exe' })] });
    check('大小写变体 qq.exe 同样排除', r.paused.size === 0, '小写比较');

    r = evaluate({ windows: [win({ rect: FULL_MAIN, imageName: 'ELDEN RING.exe' })] });
    check('黑名单之外的 exe 照常触发暂停', r.paused.has(1));

    r = evaluate({ windows: [win({ rect: FULL_MAIN })] });
    check('imageName 缺失（exeOf 失败）⇒ 不排除，照常暂停', r.paused.has(1), '宁可误暂停不可漏暂停');

    r = evaluate({ windows: [win({ rect: FULL_MAIN, imageName: 'QQ.exe' }), win({ rect: FULL_MAIN, imageName: 'game.exe' })] });
    check('QQ + 真全屏应用并存 ⇒ 真应用仍触发', r.paused.has(1));
  }

  console.log(`\n===== 单测结果: ${pass}/${pass + fail} =====`);
  process.exit(fail ? 1 : 0);
}

main();
