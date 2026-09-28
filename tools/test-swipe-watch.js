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
    check('hasTouchHardware 返回布尔（本机无触摸 = false 也不炸）', typeof sw.hasTouchHardware() === 'boolean');
  }

  console.log('\n§5 触摸横扫 flick（55 轮追记，纯轨迹判定）');
  {
    const W = sw.CONST.FLICK_WINDOW_MS;
    const MINSPAN = sw.CONST.FLICK_MIN_SPAN_MS;
    const now = 10_000;
    const mk = (dx, dt, dy = 0) => samples.push({ x: dx, y: dy, t: now + dt });

    // 快速左扫（x 递减）= next：120px+ 在窗口内匀速扫过
    let samples = [];
    mk(300, 0); mk(250, 50); mk(180, 110); mk(120, 170);
    check(`窗口内 180px/170ms 左扫 ⇒ next`, sw.evaluateFlick(samples, now + 170) === 'next');

    // 快速右扫（x 递增）= prev
    samples = [];
    mk(500, 0); mk(570, 60); mk(640, 130); mk(720, 190);
    check(`窗口内 220px/190ms 右扫 ⇒ prev`, sw.evaluateFlick(samples, now + 190) === 'prev');

    // 慢拖：总时长超出窗口 ⇒ 不触发（留给按住拖动的鼠标路径，也防慢移误触）
    samples = [];
    mk(0, 0); mk(80, 200); mk(160, 400); mk(240, 600);
    check('600ms 慢拖 ⇒ null（超出窗口）', sw.evaluateFlick(samples, now + 600) === null);

    // 瞬移：跨度 < MIN_SPAN ⇒ 不触发（防 SetCursorPos 式跳变）
    samples = [];
    mk(0, 0); mk(400, MINSPAN - 10);
    check(`${MINSPAN - 10}ms 瞬移 400px ⇒ null`, sw.evaluateFlick(samples, now + MINSPAN - 10) === null);

    // 起点太老（窗口外）：取窗口内最早样本为起点，位移不够 ⇒ null
    samples = [];
    mk(0, -1000); mk(60, 10); mk(100, 60);
    check('起点在窗外、窗口内只挪 100px ⇒ null', sw.evaluateFlick(samples, now + 60) === null);

    // 起点窗外但窗口内位移达标 ⇒ 触发（x 递增 = prev）
    samples = [];
    mk(0, -1000); mk(60, 10); mk(220, 200);
    check('起点窗外、窗口内 160px/190ms ⇒ prev', sw.evaluateFlick(samples, now + 200) === 'prev');

    // 斜扫：横向不够主导 ⇒ null
    samples = [];
    mk(0, 0); mk(70, 90); mk(150, 180, 80);
    check('横扫但 dy 过大 ⇒ null', sw.evaluateFlick(samples, now + 180) === null);

    // 样本不足 / 脏输入
    check('空轨迹 ⇒ null', sw.evaluateFlick([], now) === null);
    check('单点 ⇒ null', sw.evaluateFlick([{ x: 0, y: 0, t: now }], now) === null);
    check('非数组 ⇒ null', sw.evaluateFlick(null, now) === null);
  }

  console.log(`\n===== 单测结果: ${pass}/${pass + fail} =====`);
  process.exit(fail ? 1 : 0);
}

main();
