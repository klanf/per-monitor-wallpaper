'use strict';

/**
 * 往系统里注入按键 —— 用来验证**全局热键真的被系统级注册了**。
 *
 * 为什么不能只调 IPC：`globalShortcut.register()` 返回 true 只说明注册成功，
 * 说明不了「按下这个键真的会触发」。只有从系统侧注入一次按键、
 * 再回头看应用状态变了没有，才算证明了整条链路。
 *
 * 注入的目标是当前前台窗口所在的输入队列 —— 全局热键由系统分发，
 * 所以窗口在前台还是藏在托盘里都能收到（这也正是要验证的点）。
 *
 *   const kb = require('./keyboardDriver');
 *   kb.combo([kb.VK.CONTROL, kb.VK.ALT, kb.VK.F9]);
 */

const koffi = require('koffi');

/** 常用虚拟键码 */
const VK = {
  BACKSPACE: 0x08, TAB: 0x09, RETURN: 0x0d, SHIFT: 0x10,
  CONTROL: 0x11, ALT: 0x12, PAUSE: 0x13, CAPSLOCK: 0x14, ESCAPE: 0x1b,
  SPACE: 0x20, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  LWIN: 0x5b, A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46,
  G: 0x47, H: 0x48, I: 0x49, J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d,
  N: 0x4e, O: 0x4f, P: 0x50, Q: 0x51, R: 0x52, S: 0x53, T: 0x54,
  U: 0x55, V: 0x56, W: 0x57, X: 0x58, Y: 0x59, Z: 0x5a,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
};

const KEYEVENTF_KEYUP = 0x0002;

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  try {
    const user32 = koffi.load('user32.dll');
    api = { keybd_event: user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)') };
    return api;
  } catch (err) {
    loadError = err.message;
    return null;
  }
}

function available() { return Boolean(load()); }
function diagnose() { return { available: available(), error: loadError || null }; }

/** 按下一组键再逆序抬起 —— 组合键必须这样抬手，否则会卡住修饰键 */
function combo(keys) {
  const a = load();
  if (!a) return false;
  for (const vk of keys) a.keybd_event(vk, 0, 0, 0);
  for (const vk of [...keys].reverse()) a.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
  return true;
}

/** 单键点一下 */
function tap(vk) { return combo([vk]); }

module.exports = { VK, available, diagnose, combo, tap };
