'use strict';

/**
 * relaunchHelper —— 重启拉起助手（node 模式运行，入口见 main.js spawnRelaunchHelper）。
 *
 * 背景（2026-10-10「点重启打不开」排查）：
 *   - r26 起主进程常驻 onnxruntime-node/sharp，退出卸载阶段在 Windows 上概率挂死，
 *     will-quit 末尾改为 process.kill(self) 硬退（TerminateProcess，绕开全部析构）；
 *   - 硬退会绕过 Electron 在正常退出流程里的 app.relaunch spawn —— 实测老实例退了
 *     新实例永远不来；
 *   - 所以拉起新实例改由本助手负责：监视老进程 PID，确认死亡后 spawn 新实例
 *     （最多等 15s，超时强杀兜底）——顺带根治「新旧实例抢单实例锁」。
 *
 * argv: [oldPid, cwd, exePath, ...appArgs]
 */
const { spawn } = require('child_process');

const [oldPid, cwd, exePath, ...appArgs] = process.argv.slice(2);
const t0 = Date.now();

const iv = setInterval(() => {
  let alive = false;
  try { process.kill(Number(oldPid), 0); alive = true; } catch (_) {}
  if (!alive || Date.now() - t0 > 15000) {
    clearInterval(iv);
    try { if (alive) process.kill(Number(oldPid)); } catch (_) {}
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // 剥掉全部测试钩子变量，否则新实例继承 WP_RESTART_AFTER_MS 会无限重启循环
    for (const k of Object.keys(env)) if (/^WP_(RESTART|QUIT|CANARY)/.test(k)) delete env[k];
    try {
      const c = spawn(exePath, appArgs, { cwd, env, detached: true, stdio: 'ignore' });
      c.unref();
    } catch (_) { /* 拉起失败就失败，用户还可手动双击 VBS */ }
    setTimeout(() => process.exit(0), 1500);
  }
}, 300);
