'use strict';

/**
 * 动态桌面策略层单测（不需要 Electron、不碰系统、不碰窗口）。
 *
 * 为什么把这个判定单独钉死：
 *   这是「方案 A 降频写」的核心决定 —— 写多了桌面每 30 秒闪一下（§2.16），
 *   写少了动态窗口一失效桌面就停在死图上。两个方向都会退化，而且都**不会报错**，
 *   只能在真机上靠眼睛发现，代价很高。所以把边界全部固化成断言。
 */

const liveDesktop = require('../src/liveDesktop');
const stagePlan = require('../src/stagePlan');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${label}${detail ? '   ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${label}${detail ? '   ' + detail : ''}`); }
}

/** 默认环境：动态桌面开着 + 总开关开着，只改需要的那一项 */
function decide(over = {}) {
  return liveDesktop.shouldWriteSystem({
    live: true,
    applyToSystem: true,
    reason: 'timer',
    degraded: false,
    ...over,
  });
}

/** 断言「写 / 不写」以及判定依据 */
function expect(label, ctx, write, why) {
  const r = decide(ctx);
  const ok = r.write === write && (!why || r.why === why);
  check(label, ok, `→ write=${r.write} why=${r.why}${ok ? '' : `（期望 write=${write}${why ? ' why=' + why : ''}）`}`);
}

function main() {
  console.log('动态桌面策略层单测\n');

  // -------------------------------------------------------------------------
  console.log('§1 总开关优先于一切');
  // -------------------------------------------------------------------------
  {
    expect('applyToSystem=false + 动态开着 + takeover ⇒ 不写', { applyToSystem: false, reason: 'takeover' }, false, 'system-off');
    expect('applyToSystem=false + 动态关着 ⇒ 不写（现状语义不变）', { applyToSystem: false, live: false, reason: 'timer' }, false, 'system-off');
    expect('applyToSystem=false + 降级 ⇒ 依然不写（用户明确不碰系统壁纸）', { applyToSystem: false, degraded: true, reason: 'timer' }, false, 'system-off');
  }

  // -------------------------------------------------------------------------
  console.log('\n§2 动态桌面没开 = 一行都不改现状');
  // -------------------------------------------------------------------------
  {
    for (const reason of liveDesktop.KNOWN_WRITE_REASONS) {
      expect(`live=false + ${reason} ⇒ 写（老行为）`, { live: false, reason }, true, 'live-off');
    }
    // 这两条必须直接调实现 —— decide() 会强制塞 live:true，测不到「缺省」这条路
    const noLive = liveDesktop.shouldWriteSystem({ reason: 'timer' });
    const undefLive = liveDesktop.shouldWriteSystem({ live: undefined, reason: 'timer' });
    check('不传 live ⇒ 按关闭处理（老行为，照写）',
      noLive.write === true && noLive.why === 'live-off', `write=${noLive.write} why=${noLive.why}`);
    check('live 显式 undefined ⇒ 同上',
      undefLive.write === true && undefLive.why === 'live-off', `write=${undefLive.write} why=${undefLive.why}`);
  }

  // -------------------------------------------------------------------------
  console.log('\n§3 锚点时机：动态开着也照写');
  // -------------------------------------------------------------------------
  {
    expect('takeover（启动接管 / 重建 / 换相簿）⇒ 写', { reason: 'takeover' }, true, 'live-anchor');
    expect('stop（停止动态桌面前补一帧）⇒ 写', { reason: 'stop' }, true, 'live-anchor');
    check('锚点白名单恰好是 {takeover, stop}（防手滑改动）',
      liveDesktop.LIVE_ANCHOR_REASONS.size === 2
      && liveDesktop.LIVE_ANCHOR_REASONS.has('takeover')
      && liveDesktop.LIVE_ANCHOR_REASONS.has('stop'));
    check('isAnchorReason(takeover) = true', liveDesktop.isAnchorReason('takeover') === true);
    check('isAnchorReason(timer) = false', liveDesktop.isAnchorReason('timer') === false);
  }

  // -------------------------------------------------------------------------
  console.log('\n§4 非锚点：动态开着就不写系统壁纸（这是不闪的关键）');
  // -------------------------------------------------------------------------
  {
    const throttled = ['timer', 'command', 'goto', 'manual', 'file-mutation'];
    for (const reason of throttled) {
      expect(`${reason} ⇒ 不写`, { reason }, false, 'live-throttled');
    }
    check('新增写入原因若不慎漏进白名单，会被这组断言看出来',
      throttled.every((r) => !liveDesktop.LIVE_ANCHOR_REASONS.has(r)));
  }

  // -------------------------------------------------------------------------
  console.log('\n§5 降级兜底：动态窗口失效就恢复「每轮都写」');
  // -------------------------------------------------------------------------
  {
    for (const reason of liveDesktop.KNOWN_WRITE_REASONS) {
      expect(`degraded + ${reason} ⇒ 写（显示职责交回系统壁纸）`, { degraded: true, reason }, true, 'degraded-fallback');
    }
    // degraded 只在 live=true 时有意义；live=false 时不该改判定依据
    expect('live=false + degraded ⇒ 仍是 live-off（不冒充降级）', { live: false, degraded: true, reason: 'timer' }, true, 'live-off');
  }

  // -------------------------------------------------------------------------
  console.log('\n§6 安全默认与健壮性');
  // -------------------------------------------------------------------------
  {
    expect('未知 reason ⇒ 不写（宁可少写，动态窗口会显示）', { reason: 'something-new' }, false, 'live-throttled');
    expect('reason 缺省（undefined）⇒ 不写', { reason: undefined }, false, 'live-throttled');
    expect('reason 为 null ⇒ 不写', { reason: null }, false, 'live-throttled');

    let threw = null;
    let r = null;
    try { r = liveDesktop.shouldWriteSystem(); } catch (e) { threw = e; }
    check('无参调用不抛异常', threw === null, threw ? threw.message : '');
    check('无参调用按老行为走（live 缺省 false ⇒ 照写系统壁纸）',
      r && r.write === true && r.why === 'live-off', r ? `write=${r.write} why=${r.why}` : '');

    threw = null;
    try { liveDesktop.shouldWriteSystem(null); } catch (e) { threw = e; }
    check('传 null 不抛异常（解构默认值生效）', threw === null, threw ? threw.message : '');

    // 返回值形状稳定，调用方不必做防御性判断
    const shape = decide({ reason: 'timer' });
    check('返回值恰好两个键（write / why）',
      Object.keys(shape).sort().join(',') === 'why,write', Object.keys(shape).join(','));
    check('why 恒为非空字符串', typeof shape.why === 'string' && shape.why.length > 0, shape.why);
    check('write 恒为布尔（不是 0/1）', typeof shape.write === 'boolean');
  }

  // -------------------------------------------------------------------------
  console.log('\n§7 遍历：所有 reason × 四种状态，判定依据必须自洽');
  // -------------------------------------------------------------------------
  {
    const states = [
      { name: '总开关关', ctx: { applyToSystem: false }, why: 'system-off', write: false },
      { name: '静态模式', ctx: { live: false }, why: 'live-off', write: true },
      { name: '动态降级', ctx: { live: true, degraded: true }, why: 'degraded-fallback', write: true },
    ];
    let bad = [];
    for (const s of states) {
      for (const reason of liveDesktop.KNOWN_WRITE_REASONS) {
        const r = decide({ reason, ...s.ctx });
        if (r.write !== s.write || r.why !== s.why) bad.push(`${s.name}/${reason} → write=${r.write} why=${r.why}`);
      }
    }
    check(`${states.length} 种状态 × ${liveDesktop.KNOWN_WRITE_REASONS.size} 个 reason 判定与依据全部正确`,
      bad.length === 0, bad.join('; ') || `${states.length * liveDesktop.KNOWN_WRITE_REASONS.size} 组合`);

    // 动态且未降级时：只有锚点写，其余不写
    const wrong = [];
    for (const reason of liveDesktop.KNOWN_WRITE_REASONS) {
      const want = liveDesktop.LIVE_ANCHOR_REASONS.has(reason);
      const r = decide({ reason });
      if (r.write !== want) wrong.push(`${reason} → ${r.write}`);
    }
    check('动态正常态：写与不写恰好等于锚点集合', wrong.length === 0, wrong.join('; ') || '吻合');
  }

  // -------------------------------------------------------------------------
  console.log('\n§8 统一频道几何（52 轮：虚拟桌面并集）');
  // -------------------------------------------------------------------------
  {
    // 本机实况：主 3840×2160@150%（DIP 2560×1440）+ 左竖屏 1600×2560@100%（DIP 1600×2560 @x=-1600）
    const displays = [
      { id: 1, x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1.5 },
      { id: 2, x: -1600, y: 0, width: 1600, height: 2560, scaleFactor: 1.0 },
    ];
    const v = stagePlan.virtualBounds(displays);
    check('DIP 并集：x 取最小（负坐标竖屏）', v.dip.x === -1600 && v.dip.y === 0, JSON.stringify(v.dip));
    check('DIP 并集：宽 = 右边缘 − 左边缘', v.dip.width === 2560 - (-1600) && v.dip.height === 2560);
    check('物理并集：150% 屏按 3840 实宽算', v.phys.x === -1600 && v.phys.w === 3840 + 1600 && v.phys.h === 2560,
      JSON.stringify(v.phys));
    check('displayIds 保序全收', JSON.stringify(v.displayIds) === '[1,2]');

    const single = stagePlan.virtualBounds([{ id: 9, x: 100, y: 50, width: 800, height: 600, scaleFactor: 2 }]);
    check('单屏退化：并集 = 自身', single.dip.x === 100 && single.dip.width === 800 && single.phys.w === 1600);

    check('空 / 脏输入返回 null（不抛）',
      stagePlan.virtualBounds([]) === null && stagePlan.virtualBounds(null) === null
      && stagePlan.virtualBounds([{ width: 0, height: 0 }]) === null);

    check('负半像素缩放不越界（x*sf 向外取整）',
      stagePlan.virtualBounds([{ id: 3, x: -1, y: -1, width: 10, height: 10, scaleFactor: 1.25 }]).phys.x === Math.round(-1 * 1.25));
  }

  // -------------------------------------------------------------------------
  console.log('\n§9 舞台 ↔ 暂停映射（52 轮：含统一跨屏舞台）');
  // -------------------------------------------------------------------------
  {
    const paused = new Set(['disp-1']);
    check('每屏舞台：displayId 命中 → 暂停',
      stagePlan.isStagePaused({ displayId: 'disp-1', displayIds: null }, paused, false) === true);
    check('每屏舞台：displayId 未命中 → 不暂停',
      stagePlan.isStagePaused({ displayId: 'disp-2', displayIds: null }, paused, false) === false);
    check('统一舞台：任一覆盖屏命中即暂停',
      stagePlan.isStagePaused({ displayIds: ['disp-2', 'disp-1'] }, paused, false) === true);
    check('统一舞台：覆盖屏全没命中 → 不暂停',
      stagePlan.isStagePaused({ displayIds: ['disp-3', 'disp-4'] }, paused, false) === false);
    check('away 优先：任何舞台都暂停',
      stagePlan.isStagePaused({ displayId: 'disp-9' }, new Set(), true) === true
      && stagePlan.isStagePaused({ displayIds: ['disp-3'] }, new Set(), true) === true);
    check('数组入参兼容（不要求 Set）',
      stagePlan.isStagePaused({ displayId: 'disp-1' }, ['disp-1'], false) === true);
    check('空记录 / 无归属 → 不暂停（防御）',
      stagePlan.isStagePaused(null, paused, false) === false
      && stagePlan.isStagePaused({}, paused, false) === false);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main();
