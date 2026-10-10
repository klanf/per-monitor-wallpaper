'use strict';

/**
 * Gitee Release 分片更新器。
 *
 * 这里刻意不依赖 Electron：网络、版本选择、断点续传、校验和合并都可以在普通
 * Node 进程里单测；主进程只负责 IPC、通知以及最终退出应用。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const DEFAULT_API = 'https://gitee.com/api/v5/repos/klanf/per-monitor-wallpaper/releases?per_page=20';
const MANIFEST_NAME = 'update-manifest.json';
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const MAX_PART_BYTES = 100 * 1024 * 1024;
const MAX_PARTS = 20;
const HTTP_TIMEOUT_MS = 15_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_NAME_RE = /^[^<>:"/\\|?*\x00-\x1f]+$/;

function parseVersion(value) {
  const text = String(value || '').trim();
  const match = text.match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:$|[^0-9])/);
  if (!match) return null;
  const nums = match.slice(1, 4).map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], text: nums.join('.') };
}

function compareVersions(a, b) {
  const av = typeof a === 'string' ? parseVersion(a) : a;
  const bv = typeof b === 'string' ? parseVersion(b) : b;
  if (!av || !bv) throw new Error('版本号必须是 X.Y.Z');
  for (const key of ['major', 'minor', 'patch']) {
    if (av[key] !== bv[key]) return av[key] > bv[key] ? 1 : -1;
  }
  return 0;
}

function selectHighestStableRelease(releases) {
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.prerelease === true) continue;
    const version = parseVersion(release.tag_name);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { release, version };
  }
  return best;
}

function isSafeFileName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 180
    && name !== '.'
    && name !== '..'
    && path.basename(name) === name
    && SAFE_NAME_RE.test(name);
}

function normalizeAsset(asset) {
  if (!asset || typeof asset.name !== 'string' || typeof asset.browser_download_url !== 'string') return null;
  return { name: asset.name, url: asset.browser_download_url };
}

function validateManifest(raw, releaseVersion, assets) {
  const fail = (message) => { throw new Error(`更新清单无效：${message}`); };
  if (!raw || raw.schemaVersion !== 1) fail('不支持的 schemaVersion');
  const version = parseVersion(raw.version);
  if (!version || version.text !== releaseVersion.text) fail('版本号与 Release 标签不一致');

  const installer = raw.installer;
  if (!installer || typeof installer !== 'object') fail('缺少 installer');
  if (!isSafeFileName(installer.name) || !installer.name.toLowerCase().endsWith('.exe')) fail('安装包文件名不合法');
  if (!Number.isSafeInteger(installer.size) || installer.size <= 0 || installer.size > MAX_INSTALLER_BYTES) fail('安装包大小不合法');
  if (!SHA256_RE.test(installer.sha256 || '')) fail('安装包 SHA-256 不合法');
  if (!Array.isArray(installer.parts) || installer.parts.length < 1 || installer.parts.length > MAX_PARTS) fail('分片数量不合法');

  const assetMap = new Map();
  for (const item of Array.isArray(assets) ? assets : []) {
    const asset = normalizeAsset(item);
    if (asset) assetMap.set(asset.name, asset.url);
  }

  const names = new Set();
  let total = 0;
  const parts = installer.parts.map((part, index) => {
    if (!part || !isSafeFileName(part.name)) fail(`第 ${index + 1} 个分片文件名不合法`);
    if (!part.name.startsWith(`${installer.name}.part`) || !/\.part\d{3}$/.test(part.name)) fail(`第 ${index + 1} 个分片命名不符合约定`);
    if (names.has(part.name)) fail(`分片名重复：${part.name}`);
    names.add(part.name);
    if (!Number.isSafeInteger(part.size) || part.size <= 0 || part.size > MAX_PART_BYTES) fail(`分片大小不合法：${part.name}`);
    if (!SHA256_RE.test(part.sha256 || '')) fail(`分片 SHA-256 不合法：${part.name}`);
    const url = assetMap.get(part.name);
    if (!url) fail(`Release 缺少分片：${part.name}`);
    total += part.size;
    return { name: part.name, size: part.size, sha256: part.sha256, url };
  });
  if (total !== installer.size) fail('分片大小合计与安装包大小不一致');

  return {
    schemaVersion: 1,
    version: version.text,
    installer: {
      name: installer.name,
      size: installer.size,
      sha256: installer.sha256,
      parts,
    },
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function defaultAllowedUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.hostname === 'gitee.com') {
    return url.pathname.startsWith('/api/v5/repos/klanf/per-monitor-wallpaper/')
      || url.pathname.startsWith('/klanf/per-monitor-wallpaper/');
  }
  // Release 附件的第二跳是 Gitee 自己签名的 CDN URL（当前为 foruda.gitee.com）。
  // 客户端清单不能直接给 URL，只有从上面仓库路径重定向过来才会走到这里。
  return url.hostname.endsWith('.gitee.com');
}

function requestStream(rawUrl, options = {}, redirects = 0) {
  const allowedUrl = options.allowedUrl || defaultAllowedUrl;
  if (!allowedUrl(rawUrl)) return Promise.reject(new Error('更新地址不在允许的 Gitee 仓库范围内'));
  if (redirects > 5) return Promise.reject(new Error('更新下载重定向次数过多'));

  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.get(url, {
      headers: {
        'User-Agent': 'per-monitor-wallpaper-updater',
        Accept: '*/*',
        ...(options.headers || {}),
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        requestStream(next, options, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`更新服务器返回 HTTP ${status}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(options.timeoutMs || HTTP_TIMEOUT_MS, () => req.destroy(new Error('连接更新服务器超时')));
    req.on('error', reject);
  });
}

async function requestBuffer(rawUrl, options = {}) {
  const res = await requestStream(rawUrl, options);
  const maxBytes = options.maxBytes || MAX_MANIFEST_BYTES;
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > maxBytes) {
      res.destroy();
      throw new Error('更新服务器响应超过允许大小');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function downloadToFile(rawUrl, filePath, expectedSize, options = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  let existing = 0;
  try { existing = (await fsp.stat(filePath)).size; } catch { existing = 0; }
  if (existing > expectedSize) {
    await fsp.truncate(filePath, 0);
    existing = 0;
  }

  const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
  const res = await requestStream(rawUrl, { ...options, headers: { ...(options.headers || {}), ...headers } });
  let append = existing > 0 && res.statusCode === 206;
  if (append) {
    const range = String(res.headers['content-range'] || '');
    if (!range.startsWith(`bytes ${existing}-`)) {
      res.destroy();
      throw new Error('更新服务器返回了错误的断点范围');
    }
  } else if (existing > 0) {
    existing = 0; // 服务器不支持 Range，安全地从头覆盖
  }

  const output = await fsp.open(filePath, append ? 'a' : 'w');
  let received = existing;
  try {
    for await (const chunk of res) {
      received += chunk.length;
      if (received > expectedSize) throw new Error('下载内容超过清单声明大小');
      await output.write(chunk);
      if (options.onProgress) options.onProgress(received);
    }
  } finally {
    await output.close().catch(() => {});
  }
  if (received !== expectedSize) throw new Error(`下载不完整（${received}/${expectedSize} 字节）`);
  return received;
}

async function mergeParts(parts, targetTmp) {
  await fsp.mkdir(path.dirname(targetTmp), { recursive: true });
  const output = await fsp.open(targetTmp, 'w');
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for (const partPath of parts) {
      const input = fs.createReadStream(partPath);
      for await (const chunk of input) {
        size += chunk.length;
        hash.update(chunk);
        await output.write(chunk);
      }
    }
  } finally {
    await output.close().catch(() => {});
  }
  return { size, sha256: hash.digest('hex') };
}

class UpdateService {
  constructor(options) {
    this.currentVersion = parseVersion(options.currentVersion);
    if (!this.currentVersion) throw new Error('当前应用版本号无效');
    this.updatesDir = options.updatesDir;
    this.apiUrl = options.apiUrl || DEFAULT_API;
    this.allowedUrl = options.allowedUrl || defaultAllowedUrl;
    this.supported = options.supported !== false;
    this.unsupportedReason = options.unsupportedReason || '';
    this.spawnInstaller = options.spawnInstaller;
    this.onState = options.onState || (() => {});
    this.logger = options.logger || console;
    this._selected = null;
    this._checkPromise = null;
    this._downloadPromise = null;
    this.state = {
      status: 'idle',
      currentVersion: this.currentVersion.text,
      latestVersion: null,
      releaseName: '',
      releaseNotes: '',
      supported: this.supported,
      unsupportedReason: this.unsupportedReason,
      downloadedBytes: 0,
      totalBytes: 0,
      percent: 0,
      currentPart: '',
      error: '',
    };
  }

  snapshot() { return { ...this.state }; }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.snapshot());
    return this.snapshot();
  }

  async cleanupOld() {
    await fsp.mkdir(this.updatesDir, { recursive: true });
    const entries = await fsp.readdir(this.updatesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const version = parseVersion(entry.name);
      if (version && compareVersions(version, this.currentVersion) <= 0) {
        await fsp.rm(path.join(this.updatesDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  check(options = {}) {
    if (this._checkPromise) return this._checkPromise;
    this._checkPromise = this._check(options).finally(() => { this._checkPromise = null; });
    return this._checkPromise;
  }

  async _check(options) {
    this._set({ status: 'checking', error: '', currentPart: '' });
    try {
      const body = await requestBuffer(this.apiUrl, {
        allowedUrl: this.allowedUrl,
        maxBytes: 2 * 1024 * 1024,
      });
      const releases = JSON.parse(body.toString('utf8'));
      if (!Array.isArray(releases)) throw new Error('Gitee Release 接口返回格式不正确');
      const selected = selectHighestStableRelease(releases);
      if (!selected || compareVersions(selected.version, this.currentVersion) <= 0) {
        this._selected = null;
        return this._set({
          status: 'up-to-date',
          latestVersion: selected && compareVersions(selected.version, this.currentVersion) === 0
            ? selected.version.text
            : this.currentVersion.text,
          releaseName: selected ? String(selected.release.name || selected.release.tag_name || '') : '',
          releaseNotes: '',
          downloadedBytes: 0,
          totalBytes: 0,
          percent: 0,
        });
      }

      const assets = Array.isArray(selected.release.assets) ? selected.release.assets : [];
      const manifestAsset = assets.map(normalizeAsset).find((a) => a && a.name === MANIFEST_NAME);
      if (!manifestAsset) throw new Error(`v${selected.version.text} 缺少 ${MANIFEST_NAME}`);
      const manifestBody = await requestBuffer(manifestAsset.url, {
        allowedUrl: this.allowedUrl,
        maxBytes: MAX_MANIFEST_BYTES,
      });
      const manifest = validateManifest(JSON.parse(manifestBody.toString('utf8')), selected.version, assets);
      this._selected = { release: selected.release, manifest };
      return this._set({
        status: 'available',
        latestVersion: manifest.version,
        releaseName: String(selected.release.name || selected.release.tag_name || ''),
        releaseNotes: String(selected.release.body || '').slice(0, 4000),
        downloadedBytes: 0,
        totalBytes: manifest.installer.size,
        percent: 0,
        error: '',
      });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (!options.manual) this.logger.warn('[updater] 启动检查失败:', message);
      return this._set({ status: 'error', error: message });
    }
  }

  download() {
    if (this._downloadPromise) return this._downloadPromise;
    this._downloadPromise = this._download().finally(() => { this._downloadPromise = null; });
    return this._downloadPromise;
  }

  async _download() {
    if (!this._selected) return this._set({ status: 'error', error: '请先检查更新' });
    const { manifest } = this._selected;
    const versionDir = path.join(this.updatesDir, manifest.version);
    const installerPath = path.join(versionDir, manifest.installer.name);
    const installerTmp = `${installerPath}.tmp`;
    await fsp.mkdir(versionDir, { recursive: true });

    try {
      try {
        const stat = await fsp.stat(installerPath);
        if (stat.size === manifest.installer.size && await sha256File(installerPath) === manifest.installer.sha256) {
          this._selected.installerPath = installerPath;
          return this._set({
            status: 'ready', downloadedBytes: stat.size, totalBytes: stat.size, percent: 100, currentPart: '', error: '',
          });
        }
        await fsp.rm(installerPath, { force: true });
      } catch { /* 尚未合并 */ }

      const partPaths = [];
      const partReceived = new Map();
      for (const part of manifest.installer.parts) {
        const partPath = path.join(versionDir, part.name);
        partPaths.push(partPath);
        let size = 0;
        try { size = Math.min((await fsp.stat(partPath)).size, part.size); } catch { size = 0; }
        partReceived.set(part.name, size);
      }
      let lastProgressAt = 0;
      const publishProgress = (partName, bytes) => {
        partReceived.set(partName, bytes);
        const downloadedBytes = [...partReceived.values()].reduce((sum, n) => sum + n, 0);
        const percent = Math.min(100, Math.floor(downloadedBytes * 100 / manifest.installer.size));
        const now = Date.now();
        if (bytes < (manifest.installer.parts.find((p) => p.name === partName) || {}).size
          && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        this._set({ status: 'downloading', downloadedBytes, totalBytes: manifest.installer.size, percent, currentPart: partName, error: '' });
      };
      {
        const downloadedBytes = [...partReceived.values()].reduce((sum, n) => sum + n, 0);
        this._set({
          status: 'downloading',
          downloadedBytes,
          totalBytes: manifest.installer.size,
          percent: Math.min(100, Math.floor(downloadedBytes * 100 / manifest.installer.size)),
          currentPart: '',
          error: '',
        });
      }

      for (let index = 0; index < manifest.installer.parts.length; index += 1) {
        const part = manifest.installer.parts[index];
        const partPath = partPaths[index];
        let valid = false;
        try {
          const stat = await fsp.stat(partPath);
          valid = stat.size === part.size && await sha256File(partPath) === part.sha256;
          if (!valid && stat.size >= part.size) {
            await fsp.rm(partPath, { force: true });
            partReceived.set(part.name, 0);
          }
        } catch { valid = false; }
        if (valid) { publishProgress(part.name, part.size); continue; }

        let lastError = null;
        for (let attempt = 1; attempt <= 3 && !valid; attempt += 1) {
          try {
            await downloadToFile(part.url, partPath, part.size, {
              allowedUrl: this.allowedUrl,
              timeoutMs: 30_000,
              onProgress: (bytes) => publishProgress(part.name, bytes),
            });
            const hash = await sha256File(partPath);
            if (hash !== part.sha256) {
              await fsp.rm(partPath, { force: true });
              partReceived.set(part.name, 0);
              throw new Error(`分片校验失败：${part.name}`);
            }
            valid = true;
          } catch (err) {
            lastError = err;
            this.logger.warn(`[updater] ${part.name} 第 ${attempt}/3 次下载失败:`, err.message);
          }
        }
        if (!valid) throw lastError || new Error(`分片下载失败：${part.name}`);
      }

      await fsp.rm(installerTmp, { force: true });
      const merged = await mergeParts(partPaths, installerTmp);
      if (merged.size !== manifest.installer.size) throw new Error('合并后的安装包大小不一致');
      if (merged.sha256 !== manifest.installer.sha256) throw new Error('合并后的安装包 SHA-256 校验失败');
      await fsp.rename(installerTmp, installerPath);
      this._selected.installerPath = installerPath;
      return this._set({
        status: 'ready', downloadedBytes: merged.size, totalBytes: merged.size, percent: 100, currentPart: '', error: '',
      });
    } catch (err) {
      await fsp.rm(installerTmp, { force: true }).catch(() => {});
      return this._set({ status: 'error', error: err && err.message ? err.message : String(err), currentPart: '' });
    }
  }

  async install() {
    if (!this.supported) return this._set({ status: 'error', error: this.unsupportedReason || '当前运行方式不支持自动安装' });
    if (!this._selected || !this._selected.installerPath || this.state.status !== 'ready') {
      return this._set({ status: 'error', error: '更新包尚未下载完成' });
    }
    try {
      const installer = this._selected.installerPath;
      const stat = await fsp.stat(installer);
      if (stat.size !== this._selected.manifest.installer.size
        || await sha256File(installer) !== this._selected.manifest.installer.sha256) {
        throw new Error('安装前最终校验失败，请重新下载');
      }
      if (typeof this.spawnInstaller !== 'function') throw new Error('没有可用的安装启动器');
      await this.spawnInstaller(installer, ['/S', '--updated', '--force-run']);
      return this._set({ status: 'installing', error: '' });
    } catch (err) {
      return this._set({ status: 'error', error: err && err.message ? err.message : String(err) });
    }
  }
}

module.exports = {
  DEFAULT_API,
  MANIFEST_NAME,
  MAX_MANIFEST_BYTES,
  MAX_INSTALLER_BYTES,
  MAX_PART_BYTES,
  MAX_PARTS,
  UpdateService,
  compareVersions,
  defaultAllowedUrl,
  downloadToFile,
  mergeParts,
  parseVersion,
  requestBuffer,
  selectHighestStableRelease,
  sha256File,
  validateManifest,
};
