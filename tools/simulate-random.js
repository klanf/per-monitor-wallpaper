'use strict';
/**
 * 两种「随机播放」策略的长期表现对比。
 *
 *   A = 换实现之前的样子：每轮摇个随机数跳过去（有放回抽样，只排除紧邻的那一张）
 *   B = 现在的实现、也是原版 Python 的做法：洗牌袋
 *       把整个列表打乱成一条序列，按序播完再重洗（一轮内每张恰好一次）
 *
 * 关心的不是「下一秒会不会重复」（两个策略都不会连播同一张），
 * 而是**跑长了以后，重复观看的密度**——这才是用户能感知到的「怎么又是这张」。
 *
 * 用法：
 *   node tools/simulate-random.js            # 三组规模，各跑一次
 *   node tools/simulate-random.js --runs 20  # 每组跑 20 次取平均
 */

const RUNS = (() => {
  const i = process.argv.indexOf('--runs');
  return i >= 0 ? Math.max(1, Number(process.argv[i + 1]) || 1) : 1;
})();

/** 固定种子的伪随机，保证每次跑出来的数字可比 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A：有放回随机 —— 等价于当前的 randomOther()。
 * 只保证「不等于上一张」，其余一概不管。
 */
function runWithReplacement(n, steps, rng) {
  const lastSeen = new Map();
  const gaps = [];
  const repeatAt = [];
  let cur = Math.floor(rng() * n);
  lastSeen.set(cur, 0);
  let distinct = 1;
  let repeats = 0;

  for (let step = 1; step < steps; step += 1) {
    let next = cur;
    while (next === cur) next = Math.floor(rng() * n);

    if (lastSeen.has(next)) {
      repeats += 1;
      gaps.push(step - lastSeen.get(next));
      if (step - lastSeen.get(next) <= 10) repeatAt.push(step);
    } else {
      distinct += 1;
    }
    lastSeen.set(next, step);
    cur = next;
  }
  return { distinct, repeats, gaps, repeatAt, n };
}

/**
 * B：洗牌袋 —— 一轮内每张恰好出现一次，走完重洗。
 * 重洗后如果第一张恰好是上一轮最后一张，和它后面那张换个位（避免跨轮连播）。
 */
function runShuffleBag(n, steps, rng) {
  const lastSeen = new Map();
  const gaps = [];
  const repeatAt = [];
  let bag = null;
  let at = 0;
  let cur = -1;
  let distinct = 0;
  let repeats = 0;

  for (let step = 0; step < steps; step += 1) {
    if (!bag || at >= bag.length) {
      bag = shuffled([...Array(n).keys()], rng);
      if (n > 1 && bag[0] === cur) [bag[0], bag[1]] = [bag[1], bag[0]];
      at = 0;
    }
    const next = bag[at];
    at += 1;

    if (lastSeen.has(next)) {
      repeats += 1;
      gaps.push(step - lastSeen.get(next));
      if (step - lastSeen.get(next) <= 10) repeatAt.push(step);
    } else {
      distinct += 1;
    }
    lastSeen.set(next, step);
    cur = next;
  }
  return { distinct, repeats, gaps, repeatAt, n };
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** 短间隔重复：隔不到 10 步又看到同一张 —— 用户最容易当场注意到的 */
function shortGaps(gaps, within) { return gaps.filter((g) => g <= within).length; }

const SCENARIOS = [
  {
    label: '副屏 5 秒',
    n: 638,
    steps: 17280,
    note: '638 张 / 5 秒 —— 全天 27 轮（这是最容易察觉重复的一屏）',
  },
  {
    label: '副屏 11 秒',
    n: 7610,
    steps: 7855,
    note: '7610 张 / 11 秒 —— 全天约 1 轮',
  },
  {
    label: '主屏 60 秒',
    n: 30346,
    steps: 1440,
    note: '30346 张 / 60 秒 —— 全天 0.05 轮（规模大到无感）',
  },
];

console.log(`每种策略每个规模各跑 ${RUNS} 次取平均\n`);

const rows = [];
for (const sc of SCENARIOS) {
  for (const [name, fn] of [['有放回随机（当前）', runWithReplacement], ['洗牌袋', runShuffleBag]]) {
    const acc = { distinct: 0, repeats: 0, gaps: [], short: 0 };
    for (let r = 0; r < RUNS; r += 1) {
      const out = fn(sc.n, sc.steps, mulberry32(20260910 + r * 7919 + sc.n));
      acc.distinct += out.distinct;
      acc.repeats += out.repeats;
      acc.gaps.push(...out.gaps);
      acc.short += shortGaps(out.gaps, 10);
    }
    rows.push({
      规模: sc.label,
      策略: name,
      覆盖: pct(acc.distinct / RUNS / sc.n),
      重复次数: +(acc.repeats / RUNS).toFixed(1),
      重复占比: pct(acc.repeats / RUNS / sc.steps),
      '10步内再现': +(acc.short / RUNS).toFixed(1),
      回看间距中位: median(acc.gaps) ?? '-',
    });
  }
}

console.table(rows);

// 小库那一组再把「回看间距」的分桶摊开，看得出有放回随机的短间隔有多密
const rng = mulberry32(20260910 + 638);
const A = runWithReplacement(638, 17280, rng);
const B = runShuffleBag(638, 17280, mulberry32(20260910 + 638));
const buckets = [[2, 3], [4, 6], [7, 12], [13, 24], [25, 48], [49, 96], [97, Infinity]];
console.log('\n638 张图 / 全天 17280 步：回看间距分布（同一张图两次出现之间隔了几步）');
console.log('间距'.padEnd(12), '有放回随机'.padEnd(14), '洗牌袋');
for (const [lo, hi] of buckets) {
  const tag = hi === Infinity ? `> ${lo - 1} 步` : `${lo}–${hi} 步`;
  const a = A.gaps.filter((g) => g >= lo && g <= hi).length;
  const b = B.gaps.filter((g) => g >= lo && g <= hi).length;
  console.log(tag.padEnd(12), String(a).padEnd(16), String(b));
}
console.log(`合计`.padEnd(12), String(A.gaps.length).padEnd(16), String(B.gaps.length));
console.log(`（5 秒一步：10 步 = 50 秒，60 步 = 5 分钟，720 步 = 1 小时）`);

// 按小时给出「50 秒内又看到同一张」的累计次数，给曲线图用（720 步 = 1 小时）
function hourlyCum(stepList, stepsPerHour = 720, hours = 24) {
  const out = [];
  let cum = 0;
  let i = 0;
  for (let h = 0; h <= hours; h += 1) {
    const limit = h * stepsPerHour;
    while (i < stepList.length && stepList[i] <= limit) { cum += 1; i += 1; }
    out.push(cum);
  }
  return out;
}
console.log('\n5 秒屏（638 张）：「50 秒内又看到同一张」的累计次数，按小时');
console.log('  当前随机 :', JSON.stringify(hourlyCum(A.repeatAt)));
console.log('  洗牌袋   :', JSON.stringify(hourlyCum(B.repeatAt)));
