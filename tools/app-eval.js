'use strict';

/**
 * 在**正在运行**的应用里求值一段 JS —— 走 CDP，不改代码、不重启。
 *
 * 用途：验证运行中的状态（频道停在第几张、配置项当前值、某个 DOM 节点在不在、
 * 某个交互的副作用），比截图肉眼比对可靠，也比「再写一个 Electron 测试」轻。
 *
 * 前置：应用必须以调试端口启动。开发时用 `npm run start:debug`；
 *       在 agent 环境里由 Bash 直接起 electron 时记得先剔掉 ELECTRON_RUN_AS_NODE
 *       （外层执行器会注入它，留着 Electron 会退化成纯 Node 并崩掉），
 *       并让进程脱离父进程组（DETACHED_PROCESS），否则跑完就被回收。
 *
 * 用法:
 *   node tools/app-eval.js "return (await window.wp.listChannels()).channels.map(c => ({ i: c.index, n: c.name }))"
 *   node tools/app-eval.js "return document.getElementById('cfg-resume-last').checked"
 *
 * 表达式会被包进 `(async () => { ... })()`，所以里面可以直接 await，用 return 交出结果。
 * 走 Node 22 自带的全局 WebSocket，不需要额外依赖。
 */

const EXPR = process.argv[2];
const PORT = process.env.WP_CDP_PORT || 9222;

async function main() {
  if (!EXPR) {
    console.error('用法: node tools/app-eval.js "<JS 表达式（可直接 await / return）>"');
    process.exit(2);
  }

  const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    throw new Error(`端口 ${PORT} 上没有 page 目标（应用没在跑？）: ${JSON.stringify(targets.map((t) => t.type))}`);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 CDP 回复超时')), 30000);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(async () => { ${EXPR} })()`,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
  });

  ws.close();

  const inner = reply.result || {};
  if (inner.exceptionDetails) {
    console.error('页面里抛异常:', JSON.stringify(inner.exceptionDetails.exception, null, 2));
    process.exit(1);
  }
  const value = inner.result ? inner.result.value : undefined;
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

main().catch((err) => {
  console.error('CDP 失败:', err.message);
  process.exit(2);
});
