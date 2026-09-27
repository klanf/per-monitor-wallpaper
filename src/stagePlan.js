'use strict';

/**
 * 动态桌面的纯决策层（不依赖 Electron / koffi，可进纯 node 单测）：
 *   1. 虚拟桌面几何 —— 统一频道的舞台窗口要盖住所有显示器的并集（52 轮）；
 *   2. 舞台 ↔ 暂停集合的映射 —— 每屏舞台按自身 displayId 对号，
 *      统一舞台（跨屏）任一覆盖屏被暂停就跟着暂停；
 *   3. 暂停时窗口要不要藏 —— 独占全屏游戏做模式切换时，桌面下挂着一个
 *      持有活动交换链的窗口会触发驱动层挂死（2026-09-27 艾尔登法环实锤，
 *      6 次黑屏无信号），藏掉 = 把交换链从显示路径里摘掉。
 */

/**
 * 所有显示器的包围盒（输入是 Electron screen.getAllDisplays() 的裁剪版）。
 *
 * 返回两套坐标：
 *   - dip：BrowserWindow.setBounds 用（Electron 显示器 bounds 就是 DIP）；
 *   - phys：虚拟桌面物理像素，mount/SetWindowPos 用（每屏 DIP×scaleFactor 取整）。
 * 混合缩放下并集边缘可能有 ±1px 接缝（任务书 §2.4 同源已知，可接受）。
 *
 * @param {Array<{id:number|string, x:number, y:number, width:number, height:number, scaleFactor:number}>} displays
 * @returns {{ dip:{x,y,width,height}, phys:{x,y,w,h}, displayIds:Array }} 空输入返回 null
 */
function virtualBounds(displays) {
  const list = (Array.isArray(displays) ? displays : []).filter((d) => d
    && Number.isFinite(Number(d.width)) && Number.isFinite(Number(d.height))
    && Number(d.width) > 0 && Number(d.height) > 0);
  if (!list.length) return null;

  const dip = {
    x: Math.min(...list.map((d) => Number(d.x))),
    y: Math.min(...list.map((d) => Number(d.y))),
  };
  dip.width = Math.max(...list.map((d) => Number(d.x) + Number(d.width))) - dip.x;
  dip.height = Math.max(...list.map((d) => Number(d.y) + Number(d.height))) - dip.y;

  const physRects = list.map((d) => {
    const sf = Number(d.scaleFactor) || 1;
    return {
      x: Math.round(Number(d.x) * sf),
      y: Math.round(Number(d.y) * sf),
      r: Math.round((Number(d.x) + Number(d.width)) * sf),
      b: Math.round((Number(d.y) + Number(d.height)) * sf),
    };
  });
  const px = Math.min(...physRects.map((r) => r.x));
  const py = Math.min(...physRects.map((r) => r.y));
  const phys = {
    x: px,
    y: py,
    w: Math.max(...physRects.map((r) => r.r)) - px,
    h: Math.max(...physRects.map((r) => r.b)) - py,
  };

  return { dip, phys, displayIds: list.map((d) => d.id) };
}

/**
 * 一块舞台是否该暂停。
 *   - 每屏舞台（displayIds 为空）：按 rec.displayId 对号入座；
 *   - 统一舞台（displayIds 非空）：覆盖的**任一**屏被暂停就暂停 ——
 *     跨屏大窗在游戏屏被独占时没有「半暂停」可言，全停最稳。
 * away（锁屏 / 息屏 / 屏保）对一切舞台成立。
 *
 * @param {{displayId?:number|string|null, displayIds?:Array|null}} stage 舞台记录的显示器归属
 * @param {Set<number|string>|Array} pausedIds fullscreenWatch 算出的暂停显示器集合
 * @param {boolean} away QUNS_NOT_PRESENT
 */
function isStagePaused(stage, pausedIds, away) {
  if (away) return true;
  if (!stage) return false;
  const set = pausedIds instanceof Set ? pausedIds : new Set(Array.isArray(pausedIds) ? pausedIds : []);
  if (Array.isArray(stage.displayIds) && stage.displayIds.length) {
    return stage.displayIds.some((id) => set.has(id));
  }
  return set.has(stage.displayId);
}

/**
 * 统一频道的舞台展开（53 轮）：
 *   - 'span'（默认）：一块跨屏窗口盖虚拟桌面并集（52 轮行为，原样返回）；
 *   - 'per-display'：每块显示器一个舞台窗口，各自渲染同一频道当前帧
 *     （= 用户最初预期的「两块屏显示同一壁纸（分开显示）」）。
 * 展开产物是伪频道：id 加后缀避免 stages Map 撞 key，_displayId 供
 * stageBounds 直达对应 Display（displayForMonitor 按尺寸匹配，两块同尺寸屏
 * 会撞车）；channelId 保持原值，stage 渲染端按它过滤 tick —— 同一频道的
 * 每块舞台都吃同一拍。
 *
 * @param {object} ch 调度器频道（kind='unified' / monitor=null 判定为统一频道）
 * @param {Array<{id,x,y,width,height,scaleFactor}>} displays Electron Display 拍平版
 * @param {'span'|'per-display'} split
 * @returns {Array<object>} 0/1/N 个频道
 */
function expandUnifiedChannel(ch, displays, split) {
  if (!ch || ch.kind !== 'unified' || ch.monitor) return ch ? [ch] : [];
  const list = (Array.isArray(displays) ? displays : [])
    .filter((d) => d && d.id !== undefined && Number(d.width) > 0 && Number(d.height) > 0);
  if (!list.length) return [ch];          // 枚举不到显示器：交回原频道走旧路径报错
  if (split !== 'per-display') return [ch];
  return list.map((d) => ({
    ...ch,
    id: `${ch.id}::d${d.id}`,
    channelId: ch.id,                     // stage:bind 仍绑原频道，tick 过滤用它
    _displayId: d.id,
    monitor: {                            // 兼容旧结构（displayForMonitor / 频道名展示）
      width: Math.round(Number(d.width) * (Number(d.scaleFactor) || 1)),
      height: Math.round(Number(d.height) * (Number(d.scaleFactor) || 1)),
    },
  }));
}

/**
 * 首帧/兜底显示决策（53 轮防启动黑屏）：舞台窗口当前是否允许亮出来。
 * 窗口在挂载后先保持隐藏，等渲染端首帧画上屏（stage:first-frame）再由本函数
 * 判定能不能 show —— 暂停被藏的（hiddenForPause）和处于自动暂停的都不亮，
 * 免得「先 show 后画」把纯黑底色露给桌面。
 */
function canShowStage(stage, pausedIds, away) {
  if (!stage || stage.hiddenForPause) return false;
  return !isStagePaused(stage, pausedIds, away);
}

module.exports = { virtualBounds, isStagePaused, canShowStage, expandUnifiedChannel };
