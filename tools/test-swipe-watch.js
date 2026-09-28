'use strict';

/**
 * 桌面手势切壁纸单测（纯函数层，不碰系统、不碰 koffi）。
 *
 * 用法：node tools/test-swipe-watch.js
 */

const sw = require('../src/swipeWatch');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

const MIN = sw.CONST.MIN_DX;
const RATIO = sw.CONST.DX_DY_RATIO;

function main() {
  console.log('桌面手势判定单测\n');

  console.log('§1 阈值与方向');
  {
    check('右横扫 ≥ MIN_DX ⇒ prev', sw.evaluateSwipe({ x: 1000, y: 500 }, { x: 1000 + MIN, y: 500 }) === 'prev');
    check('左横扫 ≥ MIN_DX ⇒ next', sw.evaluateSwipe({ x: 1000, y: 500 }, { x: 1000 - MIN, y: 500 }) === 'next');
    check(`位移 ${MIN - 1} ⇒ 不触发（阈值下留误触余地）`, sw.evaluateSwipe({ x: 0, y: 0 }, { x: MIN - 1, y: 0 }) === null);
    check('右扫越界方向不反（dx 为正恒 prev）', sw.evaluateSwipe({ x: 0, y: 0 }, { x: 800, y: 10 }) === 'prev');
  }

  console.log('\n§2 横向主导');
  {
    check('dx 够长但 dy = dx/3 ⇒ 不触发（斜拖）', sw.evaluateSwipe({ x: 0, y: 0 }, { x: 300, y: 100 }) === null);
    check(`dy = dx/${RATIO} 恰好达标 ⇒ 触发`, sw.evaluateSwipe({ x: 0, y: 0 }, { x: 400, y: 100 }) === 'prev');
    check('纯竖扫 ⇒ 不触发', sw.evaluateSwipe({ x: 0, y: 0 }, { x: 0, y: -300 }) === null);
    check('对角斜扫 dy 过大 ⇒ 不触发', sw.evaluateSwipe({ x: 0, y: 0 }, { x: 500, y: -200 }) === null);
  }

  console.log('\n§3 脏输入');
  {
    check('start 为 null ⇒ null', sw.evaluateSwipe(null, { x: 200, y: 0 }) === null);
    check('end 为 null ⇒ null', sw.evaluateSwipe({ x: 0, y: 0 }, null) === null);
    check('坐标不是数字 ⇒ null', sw.evaluateSwipe({ x: 'a', y: 0 }, { x: 200, y: 0 }) === null);
    check('两端相同 ⇒ null', sw.evaluateSwipe({ x: 5, y: 5 }, { x: 5, y: 5 }) === null);
  }

  console.log('\n§4 常量与模块形状');
  {
    check('MIN_DX ≥ 100（太短会和普通点击漂移撞车）', MIN >= 100, `MIN_DX=${MIN}`);
    check('DX_DY_RATIO ≥ 3（太松会误伤斜拖）', RATIO >= 3, `RATIO=${RATIO}`);
    check('桌面根类 = Progman/WorkerW', sw.DESKTOP_ROOT_CLASSES.has('Progman') && sw.DESKTOP_ROOT_CLASSES.has('WorkerW'));
    check('桌面根类不含任务栏', !sw.DESKTOP_ROOT_CLASSES.has('Shell_TrayWnd'));
    check('轮询间隔 ≤ 20ms（拖动采样要跟手）', sw.CONST.POLL_MS <= 20, `POLL_MS=${sw.CONST.POLL_MS}`);
  }

  console.log(`\n===== 单测结果: ${pass}/${pass + fail} =====`);
  process.exit(fail ? 1 : 0);
}

main();
