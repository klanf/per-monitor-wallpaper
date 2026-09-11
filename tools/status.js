'use strict';

/**
 * 状态速览：每台显示器现在挂着什么壁纸，应用认为每路频道在干什么。
 *
 *   node tools/status.js              只看操作系统侧（无需应用在跑）
 *   node tools/status.js --app        额外通过 CDP 读应用内部的频道状态
 *
 * 两条信息来自完全独立的路径（一个问 Windows，一个问应用自己），
 * 对不上就说明有 bug —— 排查问题先看这个。
 */

const path = require('node:path');
const desktopWallpaper = require('../src/desktopWallpaper');

const CDP_LIST = 'http://127.0.0.1:9222/json';
const wantApp = process.argv.includes('--app');

function osMonitors() {
  const result = desktopWallpaper.enumMonitors();
  if (!result.ok) return { ok: false, error: result.error, monitors: [] };
  return { ok: true, monitors: result.monitors };
}

const base = (p) => (p ? path.basename(p) : '(未设置)');
const dir = (p) => (p ? path.basename(path.dirname(p)) : '—');

async function appChannels() {
  let targets;
  try {
    targets = await (await fetch(CDP_LIST)).json();
  } catch {
    return { ok: false, error: '应用未启动或没有开远程调试端口' };
  }
  const page = targets.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
  if (!page) return { ok: false, error: '没找到渲染进程' };

  return new Promise((resolve) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve({ ok: false, error: '超时' }); }, 8000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: 'window.wp.listChannels()', awaitPromise: true, returnByValue: true },
    })));
    ws.addEventListener('error', () => { clearTimeout(timer); resolve({ ok: false, error: 'WebSocket 失败' }); });
    ws.addEventListener('message', (ev) => {
      clearTimeout(timer);
      const msg = JSON.parse(ev.data);
      try { ws.close(); } catch { /* ignore */ }
      resolve({ ok: true, data: msg.result?.result?.value });
    });
  });
}

(async () => {
  console.log('══════ 操作系统侧（IDesktopWallpaper 回读）══════');
  const os = osMonitors();
  if (!os.ok) {
    console.log('  每屏接口不可用:', os.error);
  } else {
    for (const m of os.monitors) {
      console.log(`  [${m.index}] ${m.label}`);
      console.log(`      当前壁纸: ${base(m.current)}`);
      console.log(`      所在目录: ${dir(m.current)}`);
      console.log(`      完整路径: ${m.current || '—'}`);
    }
  }

  if (!wantApp) {
    console.log('\n（加 --app 可同时打印应用内部的频道状态）');
    desktopWallpaper.release();
    return;
  }

  console.log('\n══════ 应用侧（CDP 读渲染进程）══════');
  const app = await appChannels();
  if (!app.ok) {
    console.log('  读取失败:', app.error);
  } else {
    const info = app.data;
    console.log(`  模式: ${info.perMonitor ? '每屏独立' : '统一配置'}   壁纸通道: ${info.backend}`);
    for (const ch of info.channels || []) {
      console.log(`  ${ch.kind === 'monitor' ? `显示器 ${(ch.monitorIndex || 0) + 1}` : '统一频道'} · ${ch.width}×${ch.height}`);
      console.log(`      目录    : ${ch.profile.folder}`);
      console.log(`      图数    : ${ch.count} 张（第 ${ch.count ? ch.index + 1 : 0} 张）`);
      console.log(`      间隔    : ${ch.profile.interval} 秒   ${ch.playing ? '播放中' : '已暂停'}`);
      console.log(`      接管    : ${ch.profile.enabled ? '是' : '否'}`);
      console.log(`      已推进  : ${ch.ticks} 次   已写入: ${ch.writes} 次`);
      if (ch.lastError) console.log(`      最近错误: ${ch.lastError}`);
    }
  }

  desktopWallpaper.release();
})().catch((err) => {
  console.error('status 失败:', err.message);
  try { desktopWallpaper.release(); } catch { /* ignore */ }
  process.exit(1);
});
