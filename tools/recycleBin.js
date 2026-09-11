'use strict';

/**
 * 查询某个盘符回收站的条目数 / 占用大小（测试用）。
 *
 * 为什么需要它：`shell.trashItem` 只告诉我们「文件不见了」——
 * 文件既可能进了回收站（可还原），也可能被永久删掉。用户要的是前者，
 * 所以删除类操作必须由这里证明「回收站里真的多了一件」。
 *
 * PowerShell 的 COM 被安全策略禁掉了，所以走 shell32 的 SHQueryRecycleBinW。
 */

const koffi = require('koffi');

const SHQUERYRBINFO = koffi.struct('SHQUERYRBINFO', {
  cbSize: 'uint32',
  i64Size: 'int64',
  i64NumItems: 'int64',
});

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  try {
    const shell32 = koffi.load('shell32.dll');
    api = {
      SHQueryRecycleBinW: shell32.func('long SHQueryRecycleBinW(str16 pszRootPath, _Inout_ void *pSHQueryRBInfo)'),
      sizeof: koffi.sizeof(SHQUERYRBINFO),
    };
  } catch (err) {
    loadError = err;
  }
  return api;
}

/**
 * @param {string} driveRoot 例如 'D:\\'
 * @returns {{ok:boolean, items?:number, bytes?:number, error?:string}}
 */
function query(driveRoot) {
  const a = load();
  if (!a) return { ok: false, error: `回收站查询不可用：${loadError && loadError.message}` };

  const buf = koffi.alloc(SHQUERYRBINFO, 1);
  koffi.encode(buf, SHQUERYRBINFO, { cbSize: a.sizeof, i64Size: 0, i64NumItems: 0 });

  const hr = a.SHQueryRecycleBinW(driveRoot, buf);
  if (hr !== 0) return { ok: false, error: `SHQueryRecycleBin 失败 (0x${(hr >>> 0).toString(16)})` };

  const info = koffi.decode(buf, SHQUERYRBINFO);
  return { ok: true, items: Number(info.i64NumItems), bytes: Number(info.i64Size) };
}

/** 取包含该路径的盘符根，如 'D:\\' */
function rootOf(filePath) {
  return `${filePath.slice(0, 2)}\\`;
}

module.exports = { query, rootOf };
