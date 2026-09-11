'use strict';

/**
 * 测试期间的配置还原点管理。
 *
 * 为什么需要：验证脚本要临时把频道切到测试素材，跑完再还原。但如果脚本中途崩了，
 * 「还原」那一步不会执行 —— 下一轮脚本抓到的「这一轮开始的配置」其实就是上一轮的
 * 测试残留，于是错误被一路继承下去（实测发生过，用户的正式配置被覆盖了好几轮）。
 *
 * 做法（v2，修掉了一版的两个坑）：
 *   1. `begin()` 在**每一轮开始时**记一份还原点，跑完就删 —— 而不是只记一次、永远复用。
 *      只记一次的话，还原会退回到很久以前的配置，把用户后来的修改抹掉。
 *   2. 采还原点前先判断「当前配置是不是已经是测试残留」。是的话**绝不采它**，
 *      改从 `config.user-backup.json` 兜底 —— 这才是根治污染的那一步。
 *   3. 顺手把干净的当前配置写进 `config.user-backup.json`，让兜底永远是最新的。
 *
 * 用法：
 *   const testConfig = require('./testConfig');
 *   const base = testConfig.begin();          // 脚本开头
 *   …跑测试…
 *   await testConfig.restore(ev);             // 结尾：还原到这一轮开始时的配置
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { DEFAULTS, deepMerge } = require('../src/store');

function userDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'electron-wallpaper');
}

function configPath() {
  return path.join(userDataDir(), 'config.json');
}

/** 这一轮的还原点（每轮覆盖，跑完删除） */
function restorePath() {
  return path.join(userDataDir(), 'config.test-original.json');
}

/**
 * 「测试正在进行」标记：`begin()` 写下，`restore()` 成功后删掉。
 *
 * 留着它 = 上一轮没跑到还原那一步（崩了 / 被 Ctrl-C 掐了）。
 * 这时磁盘上的配置**可能是测试改脏的一半**，绝不能再拿它当「用户配置」去刷新兜底快照 ——
 * 否则脏值会被镀金成还原基准，从此每一轮都老老实实还原成那个脏值，再也回不去。
 *
 * 实际踩到过：`verify:tray` 里那条「确认框勾了不再询问」的测试把 `confirmDelete`
 * 写成 false，那一轮中途崩了；下一轮 begin() 看目录是用户的真实目录就认定「这是干净配置」，
 * 顺手把它写进了 config.user-backup.json。之后无论跑多少次测试，删除确认都再也回不来了。
 */
function markerPath() {
  return path.join(userDataDir(), 'test-in-progress.json');
}

/** 最终兜底：一份「确定是用户配置」的快照 */
function backupPath() {
  return path.join(userDataDir(), 'config.user-backup.json');
}

/**
 * 开机自启的还原点。
 *
 * 为什么不能只靠 config.json：自启的**真实状态在系统启动项（注册表 Run 项）里**，
 * config.json 只是应用自己记的一份。验证脚本为了测「开关能不能写系统」必须真的开一次、
 * 再关一次 —— 如果不管还原，用户的启动项就被测试清掉了（实测发生过：
 * 用户开了自启，跑完 verify:features 之后系统里那项没了）。
 */
function loginPath() {
  return path.join(userDataDir(), 'login.test-original.json');
}

/** 测试素材目录的特征（用来判断一份配置是不是测试残留） */
const TEST_DATA_RE = /[\\/]tools[\\/]tmp[\\/]|[\\/]tools[\\/]fixtures[\\/]/i;

function looksLikeTestData(folder) {
  return TEST_DATA_RE.test(String(folder || ''));
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 把磁盘上的配置补全成**应用实际看到的那份**（缺少的键回落默认值）。
 *
 * 为什么要补：`config.json` 里只有「被改过的键」是常态 —— 新加的配置项在用户没动过之前
 * 根本不落盘。还原点如果原样采它，就会出现「测试把新项改脏了、还原时因为没有这个键
 * 而改不回来」的情况（`confirmDelete` 就这么丢过一次）。
 */
function complete(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const merged = deepMerge(DEFAULTS, raw);
  if (!merged.monitors || typeof merged.monitors !== 'object') merged.monitors = {};
  return merged;
}

/**
 * 脚本开头调用。
 * @returns {{recovered:boolean, crashed:boolean, path:string, baseline:object, testDataBefore:boolean}}
 *   recovered=true 表示当前配置不可信，还原点改从备份取了（目录是测试素材，或上一轮崩过）
 *   crashed=true   表示发现上一轮没跑完留下的标记
 */
function begin() {
  const stale = readJson(markerPath());
  const current = complete(readJson(configPath()));
  const testFolder = looksLikeTestData(current.folder);
  const dirty = testFolder || Boolean(stale);

  let baseline = current;
  let recovered = false;
  if (dirty) {
    const backup = readJson(backupPath());
    if (backup && !looksLikeTestData(backup.folder)) {
      baseline = complete(backup);
      recovered = true;
    }
  }

  const target = restorePath();
  fs.writeFileSync(target, JSON.stringify(baseline, null, 2) + '\n');

  // 只有「确定干净」的那一轮才允许刷新兜底快照
  if (!dirty) {
    try { fs.writeFileSync(backupPath(), JSON.stringify(baseline, null, 2) + '\n'); } catch { /* 写不了就算了 */ }
  }

  try {
    fs.writeFileSync(markerPath(), JSON.stringify({
      at: new Date().toISOString(),
      note: '写完这个标记就说明测试开始了；看到它还在 = 上一轮没跑到还原',
    }, null, 2) + '\n');
  } catch { /* 写不了就算了 */ }

  return {
    recovered,
    crashed: Boolean(stale),
    staleAt: stale ? stale.at : null,
    path: target,
    baseline,
    testDataBefore: testFolder,
  };
}

/**
 * 比对还原后的配置与还原点，找出对不上的键。
 * 用来兜住「还原了但没完全还原」——这种问题不报错、只会一路静默继承下去。
 */
function mismatches(actual, baseline) {
  const out = [];
  const walk = (a, b, prefix) => {
    for (const [key, want] of Object.entries(b || {})) {
      const got = a ? a[key] : undefined;
      const isObj = want && typeof want === 'object' && !Array.isArray(want);
      if (isObj) { walk(got, want, `${prefix}${key}.`); continue; }
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        out.push(`${prefix}${key}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
      }
    }
  };
  walk(actual, baseline, '');
  return out;
}

/**
 * 脚本结尾调用：把这一轮开始时记下的一切都还原，然后清掉标记。
 *
 * 不只是配置 —— 自启（注册表）快照如果还在，也一并还原。这样「中途崩了」的下一轮
 * 只要正常跑到结尾，就能顺手把上一轮没做完的还原补上。
 *
 * @param {(expr:string)=>Promise<unknown>} ev 渲染进程求值函数
 */
async function restore(ev) {
  const target = restorePath();

  if (!fs.existsSync(target)) {
    // 还原点没了，但上一轮崩掉留下的自启改动可能还挂着 —— 尽力收一下
    const loginOnly = await restoreLogin(ev).catch(() => ({ ok: false, error: '自启还原异常' }));
    if (!fs.existsSync(loginPath())) {
      try { fs.unlinkSync(markerPath()); } catch { /* 已经没了 */ }
    }
    return {
      ok: false,
      error: '没有还原点，无法还原配置',
      login: loginOnly.ok ? loginOnly : null,
    };
  }

  const baseline = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (looksLikeTestData(baseline.folder)) {
    // 标记故意不清：让下一轮继续把磁盘配置当可疑处理
    return { ok: false, error: `还原点本身指向测试目录，拒绝还原：${baseline.folder}`, login: null };
  }

  await ev('window.wp.setConfig(' + JSON.stringify(baseline) + ')');
  await ev('window.wp.rebuildChannels(true)');
  const back = await ev('window.wp.getConfig()');
  fs.unlinkSync(target);

  const login = await restoreLogin(ev).catch(() => ({ ok: false, error: '自启还原异常' }));

  /*
   * 标记的清除条件：没有「还没处理的自启快照」了。
   * 失败时留着它 —— 下一轮会因此把磁盘配置当成可疑、改用兜底快照做还原点，
   * 宁可多还原一次，也不要让脏值被镀金成基准。
   */
  if (!fs.existsSync(loginPath())) {
    try { fs.unlinkSync(markerPath()); } catch { /* 已经没了 */ }
  }

  return {
    ok: true,
    baseline,
    actual: back,
    diff: mismatches(back, baseline),
    login: login.ok ? login : null,
    loginError: login.ok ? null : login.error,
  };
}

/**
 * 在动开机自启之前调用：把系统里**当时的**自启状态记下来。
 *
 * 注意记的是系统侧的真状态（trayState 走 getLoginItemSettings），不是 config.json ——
 * 两者可能不一致（用户在别处改过），而测试要还原的是系统那一份。
 *
 * @param {(expr:string)=>Promise<unknown>} ev 渲染进程求值函数
 */
async function snapshotLogin(ev) {
  const state = await ev('window.wp.trayState()');
  const launchAtLogin = Boolean(state && state.launchAtLogin);
  const target = loginPath();
  fs.writeFileSync(target, JSON.stringify({ launchAtLogin, at: new Date().toISOString() }, null, 2) + '\n');
  return { ok: true, launchAtLogin, path: target };
}

/**
 * 脚本结尾调用：把自启恢复到 snapshotLogin 记下的状态，然后删掉还原点。
 * 已经是目标状态就什么都不做（避免无谓地写一次注册表）。
 */
async function restoreLogin(ev) {
  const target = loginPath();
  if (!fs.existsSync(target)) return { ok: false, error: '没有自启还原点，跳过还原' };

  const { launchAtLogin } = JSON.parse(fs.readFileSync(target, 'utf8'));
  const was = Boolean((await ev('window.wp.trayState()')).launchAtLogin);
  if (was !== launchAtLogin) await ev(`window.wp.setLaunchAtLogin(${launchAtLogin})`);
  const actual = Boolean((await ev('window.wp.trayState()')).launchAtLogin);

  fs.unlinkSync(target);
  return { ok: actual === launchAtLogin, launchAtLogin, was, actual, changed: was !== launchAtLogin };
}

/**
 * 把 begin() 的结果整理成一行提示（没异常就返回 null），各脚本统一打印。
 * 别让「基准可能不干净」这件事被静默吞掉 —— 它一红，后面所有断言都要打问号。
 */
function describeBaseline(base) {
  const notes = [];
  if (base.crashed) {
    notes.push(`上一轮测试没跑到还原就结束了（标记时间 ${base.staleAt || '未知'}），磁盘配置可能被改脏`);
  }
  if (base.testDataBefore) notes.push('测试开始前的配置就指向测试素材');
  if (!notes.length) return null;
  return `⚠ ${notes.join('；')} → 还原点改从兜底快照取（recovered=${base.recovered}）`;
}

module.exports = {
  begin, restore, snapshotLogin, restoreLogin, describeBaseline,
  configPath, restorePath, backupPath, loginPath, markerPath, looksLikeTestData, mismatches,
};
