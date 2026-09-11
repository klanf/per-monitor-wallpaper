'use strict';

/**
 * 用 koffi 直接读 HKCU\...\Run —— 验证「开机自启」是不是真的落到了系统里。
 *
 * 不用 `reg.exe`：一来要 spawn 外部进程，二来沙箱环境会把它拦掉。
 * advapi32 的 RegOpenKeyExW / RegQueryValueExW 就够了，只读不写。
 */

const koffi = require('koffi');

const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HKEY_CURRENT_USER = 0x80000001;
const KEY_READ = 0x20019;
const REG_SZ = 1;

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  try {
    const advapi = koffi.load('advapi32.dll');
    api = {
      RegOpenKeyExW: advapi.func('long RegOpenKeyExW(void *hKey, str16 lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ void **phkResult)'),
      RegEnumValueW: advapi.func('long RegEnumValueW(void *hKey, uint32 dwIndex, _Out_ uint16 *lpValueName, _Inout_ uint32 *lpcchValueName, void *lpReserved, _Out_ uint32 *lpType, _Out_ uint8 *lpData, _Inout_ uint32 *lpcbData)'),
      RegCloseKey: advapi.func('long RegCloseKey(void *hKey)'),
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

/** @returns {Record<string,string>|null} 启动项名 → 命令行；读不到返回 null */
function readRunEntries() {
  const a = load();
  if (!a) return null;

  const hKeyBuf = koffi.alloc('void *', 1);
  const hr = a.RegOpenKeyExW(koffi.as(HKEY_CURRENT_USER, 'void *'), RUN_KEY, 0, KEY_READ, hKeyBuf);
  if (hr !== 0) return null;

  const hKey = koffi.decode(hKeyBuf, 'void *');
  const out = {};
  try {
    for (let index = 0; index < 256; index += 1) {
      const nameBuf = Buffer.alloc(512 * 2);
      const nameLenBuf = koffi.alloc('uint32', 1);
      koffi.encode(nameLenBuf, 'uint32', 512);

      const typeBuf = koffi.alloc('uint32', 1);
      const dataBuf = Buffer.alloc(8192);
      const dataLenBuf = koffi.alloc('uint32', 1);
      koffi.encode(dataLenBuf, 'uint32', 8192);

      const r = a.RegEnumValueW(hKey, index, koffi.as(nameBuf, 'uint16 *'), nameLenBuf,
        null, typeBuf, koffi.as(dataBuf, 'uint8 *'), dataLenBuf);
      if (r === 259) break;              // ERROR_NO_MORE_ITEMS
      if (r !== 0) break;

      const nameChars = koffi.decode(nameLenBuf, 'uint32');
      const type = koffi.decode(typeBuf, 'uint32');
      const bytes = koffi.decode(dataLenBuf, 'uint32');
      const name = nameBuf.toString('utf16le', 0, nameChars * 2);
      if (type !== REG_SZ || bytes < 2) continue;
      out[name] = dataBuf.toString('utf16le', 0, bytes - 2);
    }
  } finally {
    a.RegCloseKey(hKey);
  }
  return out;
}

/** 任一自启项指向本项目的 electron.exe 就算命中 */
function findAppEntry(keyword = 'electron-wallpaper') {
  const entries = readRunEntries();
  if (!entries) return { ok: false, error: '读不到注册表', match: null, all: null };
  const hit = Object.entries(entries).find(([, v]) => v.includes(keyword));
  return { ok: true, match: hit ? { name: hit[0], command: hit[1] } : null, all: entries };
}

module.exports = { readRunEntries, findAppEntry };
