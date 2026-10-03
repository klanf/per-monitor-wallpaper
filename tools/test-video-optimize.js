'use strict';

/**
 * 视频省电优化 · 帧率策略单测（57 轮，plain node 不碰 Electron）。
 * 覆盖：copyMatchesFps 命中校验（目标帧率改成用户可调后的关键防线）
 *      + store 侧 optimizeTargetFps 钳位语义（直接对 normalizeConfig 黑盒）。
 */

const assert = require('node:assert');
const videoOptimize = require('../src/videoOptimize');
const { normalizeConfig } = require('../src/store');

let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) { pass += 1; console.log(`  ✓ ${label}`); }
  else { fail += 1; console.log(`  ✗ ${label}`); }
}

console.log('§1 copyMatchesFps：副本帧率与当前策略的一致性判定');
{
  const m = videoOptimize.copyMatchesFps;
  check('条目记 30、策略 30 ⇒ 一致', m({ targetFps: 30 }, 30) === true);
  check('条目记 30、策略 48 ⇒ 不一致（必须重转）', m({ targetFps: 30 }, 48) === false);
  check('条目记 48、策略 30 ⇒ 不一致', m({ targetFps: 48 }, 30) === false);
  check('条目记 48、策略 48 ⇒ 一致', m({ targetFps: 48 }, 48) === true);
  check('老条目没记 targetFps（升级兼容）⇒ 视为一致', m({ srcPath: 'x' }, 48) === true);
  check('条目缺失（索引被手删）⇒ 视为一致，不拦正常播放', m(null, 30) === true);
  check('条目不是对象（脏数据）⇒ 视为一致', m('garbage', 30) === true);
  check('字符串数字也能比（JSON 手改场景）', m({ targetFps: '48' }, 48) === true);
}

console.log('§2 store.normalizeConfig：optimizeTargetFps 钳位');
{
  check('写入 30 保留 30', normalizeConfig({ optimizeTargetFps: 30 }).optimizeTargetFps === 30);
  check('写入 48 保留 48', normalizeConfig({ optimizeTargetFps: 48 }).optimizeTargetFps === 48);
  check('写入 60（脏值）回落 30', normalizeConfig({ optimizeTargetFps: 60 }).optimizeTargetFps === 30);
  check('写入字符串 "48" 照样认', normalizeConfig({ optimizeTargetFps: '48' }).optimizeTargetFps === 48);
  check('写入 undefined 不产生该键', !('optimizeTargetFps' in normalizeConfig({ optimizeTargetFps: undefined })));
  check('videoOptimize 仍是布尔白名单成员（写 true 落 true）',
    normalizeConfig({ videoOptimize: '1' }).videoOptimize === true);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
