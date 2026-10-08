import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { open, stat, mkdir, link, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { loadCredentials, validateCredentials } from './auth.js';
import { loopbackURL, remotePath, basename, protectRoot, localPath, exists, globRegex } from './safety.js';

export { loadCredentials } from './auth.js';
export class ZSpaceError extends Error {
  constructor(code, message) { super(`[${code}] ${message}`); this.name = 'ZSpaceError'; this.code = String(code); }
}

const cloudEndpoints = { baidu: '/znetdisk', quark: '/zdrive/kuake' };
function cloudEndpoint(provider) {
  if (!Object.hasOwn(cloudEndpoints, provider)) throw new Error('Cloud provider must be baidu or quark');
  return cloudEndpoints[provider];
}
function cloudIds(values) {
  if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(v))) throw new Error('Invalid cloud file IDs');
  return values.join(',');
}

export class ZSpaceClient {
  #base; #creds; #configDir; #root; #localRoot; #writes; #deletes; #timeout; #retries; #version; #threshold; #slice;
  constructor({ baseUrl = process.env.ZS_BASE_URL, credentials, configDir, root = '/', localRoot,
    allowWrites = false, allowDelete = false, timeout = 60000, retries = 2,
    apiVersion = '2.3.2026042401', sliceThreshold = 64 * 1024 * 1024, sliceSize = 2 * 1024 * 1024 } = {}) {
    this.#base = loopbackURL(baseUrl);
    this.#creds = credentials ? validateCredentials(credentials) : null;
    this.#configDir = configDir; this.#root = remotePath(root); this.#localRoot = localRoot;
    this.#writes = allowWrites === true; this.#deletes = allowDelete === true;
    for (const [key, value] of Object.entries({ timeout, retries, sliceThreshold, sliceSize })) {
      if (!Number.isSafeInteger(value) || value < (key === 'retries' ? 0 : 1)) throw new Error(`Invalid ${key}`);
    }
    this.#timeout = timeout; this.#retries = retries; this.#version = String(apiVersion);
    this.#threshold = sliceThreshold; this.#slice = sliceSize;
  }
  async #credentials() { return this.#creds ?? await loadCredentials(this.#configDir); }
  #write(deletion = false) {
    if (!this.#writes) throw new Error('Writes are disabled; explicitly enable allowWrites');
    if (deletion && !this.#deletes) throw new Error('Deletion is disabled; explicitly enable allowDelete');
  }
  #path(value) { return remotePath(value, this.#root); }
  #redact(message, credentials) {
    let text = String(message).slice(0, 2000);
    for (const value of Object.values(credentials)) {
      if (value && value.length > 3) { text = text.split(value).join('[redacted]').split(encodeURIComponent(value)).join('[redacted]'); }
    }
    return text.replace(/[\x00-\x1f\x7f]/g, ' ');
  }
  async #request(endpoint, { method = 'POST', body, headers = {}, query = {}, credentials } = {}) {
    const creds = credentials ?? await this.#credentials();
    const url = new URL(endpoint, this.#base);
    url.search = new URLSearchParams({ rnd: `${Date.now()}_${randomUUID()}`, webagent: 'v2', ...query }).toString();
    headers = { Cookie: Object.entries({ app: 'file', token: creds.token, zenithtoken: creds.token,
      nas_id: creds.nasId, nasid: creds.nasId, device_id: creds.deviceId, plat: 'pc',
      version: creds.appVersion, device: creds.device, _l: 'zh_cn' }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '), ...headers };
    return await new Promise((resolve, reject) => {
      // Native http bypasses environment proxies. There is no redirect following.
      const req = http.request(url, { method, headers }, res => {
        res.on('error', () => res.destroy());
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res);
        else { res.resume(); reject(new ZSpaceError(String(res.statusCode), 'Local proxy request failed')); }
      });
      req.setTimeout(this.#timeout, () => req.destroy(new Error('Request timed out')));
      req.on('error', error => reject(new Error(error.message === 'Request timed out' ? error.message : 'Cannot reach the local ZSpace proxy')));
      if (body && typeof body.pipe === 'function') {
        body.on('error', () => req.destroy(new Error('Cannot read upload file')));
        req.on('close', () => body.destroy()); body.pipe(req);
      } else req.end(body);
    }).catch(e => { throw new ZSpaceError(e.code ?? 'network', this.#redact(e.message, creds)); });
  }
  async #json(endpoint, extra = {}, { retry = false, body, headers, query, credentials } = {}) {
    const creds = credentials ?? await this.#credentials();
    const params = new URLSearchParams({ token: creds.token, nasid: creds.nasId, plat: 'web', version: this.#version, device_id: creds.deviceId, _l: 'zh_cn' });
    for (const [key, value] of Object.entries(extra)) {
      if (Array.isArray(value)) for (const item of value) params.append(key, item);
      else params.set(key, value);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.#request(endpoint, { body: body ?? params.toString(),
          headers: headers ?? { 'Content-Type': 'application/x-www-form-urlencoded' }, query, credentials: creds });
        const chunks = []; let size = 0;
        for await (const chunk of res) { size += chunk.length; if (size > 16 * 1024 * 1024) { res.destroy(); throw new Error('Proxy response is too large'); } chunks.push(chunk); }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Proxy returned invalid JSON'); }
        if (String(data.code) !== '200') throw new ZSpaceError(this.#redact(data.code ?? 'unknown', creds), this.#redact(data.msg ?? 'NAS operation failed', creds));
        return data;
      } catch (e) {
        if (retry && attempt < this.#retries && (e.code === 'network' || e.code === '429' || /^5\d\d$/.test(e.code))) {
          await new Promise(r => setTimeout(r, 100 * 2 ** attempt)); continue;
        }
        throw e;
      }
    }
  }
  async check() {
    try { const pools = await this.poolInfo(); return { connected: true, pools: pools.pool_list ?? [] }; }
    catch (e) { return { connected: false, reason: e.message }; }
  }
  async poolInfo() { return (await this.#json('/zspool/info', {}, { retry: true })).data; }
  async diskStats() { return (await this.#json('/disk/statics', {}, { retry: true })).data; }
  async cloudStatus(provider) {
    const data = (await this.#json(`${cloudEndpoint(provider)}/auth/check`, { rd: `${this.#base}/home/newNetdisk` }, { retry: true })).data;
    return { provider, isLogin: data.is_login === true || data.is_login === 1 };
  }
  async cloudList(provider, { path: cloudPath = '/', parentId = '0', page = 1, limit = 100, cursor } = {}) {
    const base = cloudEndpoint(provider);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid cloud pagination');
    let params;
    if (provider === 'baidu') params = { path: remotePath(cloudPath), page, limit };
    else {
      cloudIds([parentId]);
      params = { parent_file_id: parentId, show_dir: 1, limit, sort: '' };
      if (cursor) {
        if (typeof cursor.version !== 'string' || typeof cursor.token !== 'string' || /[\x00-\x1f]/.test(cursor.version + cursor.token)) throw new Error('Invalid cloud cursor');
        params.cursor_version = cursor.version; params.cursor_token = cursor.token;
      }
    }
    const data = (await this.#json(`${base}/file/${provider === 'baidu' ? 'list' : 'filelist'}`, params, { retry: true })).data;
    const list = provider === 'baidu' ? data.list : data.file_list;
    if (!Array.isArray(list)) throw new Error('Invalid cloud directory response');
    return { provider, entries: list.map(row => provider === 'baidu'
      ? { id: String(row.fs_id), name: row.server_filename, path: row.path, isDir: String(row.isdir) === '1', size: Number(row.size) || 0 }
      : { id: String(row.file_id), name: row.name, path: row.path, isDir: row.type !== 'file', size: Number(row.size) || 0 }),
      hasMore: provider === 'baidu' ? list.length >= limit : !data.last_page, cursor: data.next_query_cursor ?? null };
  }
  async cloudDownload(provider, directory, { fileIds = [], folderIds = [] } = {}) {
    this.#write(); const base = cloudEndpoint(provider); const save_path = this.#path(directory);
    const files = cloudIds(fileIds); const folders = cloudIds(folderIds);
    if (!files && !folders) throw new Error('Select at least one cloud file or folder ID');
    const params = provider === 'baidu' ? { file_ids: cloudIds([...fileIds, ...folderIds]), save_path }
      : { file_ids: files, folder_ids: folders, save_path };
    return { accepted: true, provider, directory: save_path, data: (await this.#json(`${base}/${provider === 'baidu' ? 'file' : 'task'}/download`, params)).data };
  }
  async cloudTasks(provider) { return (await this.#json(`${cloudEndpoint(provider)}/task/list`, {}, { retry: true })).data; }
  async addDownload(uri, directory) {
    this.#write(); const dir = this.#path(directory);
    if (typeof uri !== 'string' || /[\x00-\x20\x7f]/.test(uri) || !/^(https?|ftps?|sftp|magnet|thunder):/i.test(uri)) throw new Error('Invalid download link');
    const url = new URL(uri);
    if (!['magnet:', 'thunder:'].includes(url.protocol) && !url.hostname) throw new Error('Download link needs a hostname');
    return { accepted: true, directory: dir, data: (await this.#json('/downloader/add/link', { uri, dir })).data };
  }
  async listDownloads({ type = 'loading', status = 'all', start = 0, limit = 50 } = {}) {
    if (!['loading', 'complete'].includes(type) || !['all', 'loading', 'stopped', 'checking', 'error', 'seeding', 'stop-seeding'].includes(status)
      || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid download task query');
    return (await this.#json('/downloader/list', { type, status, start, size: limit }, { retry: true })).data;
  }
  async photoStatus() {
    const config = (await this.#json('/v2/album/conf/load', {}, { retry: true })).data;
    const state = (await this.#json('/v2/album/feed/search/ai_state', {}, { retry: true })).data;
    return { aiEnabled: config.aiMainOpen, searchEnabled: config.aiSearchOpen, ocrEnabled: config.aiOcrOpen,
      indexed: state.processedCount, total: state.feedCount, runningStatus: state.runngingStatus };
  }
  #photoPagination(start, limit) {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid photo pagination');
  }
  #photoPage(data, limit) {
    if (!Array.isArray(data.list)) throw new Error('Invalid photo response');
    const entries = data.list.slice(0, limit).filter(row => {
      if (typeof row.path !== 'string') throw new Error('Invalid photo path');
      // Encrypted/shared paths cannot be bounded by a NAS filesystem root.
      return !row.path.startsWith('E.');
    }).map(row => ({ id: String(row.id), name: basename(row.name), path: remotePath(row.path), size: Number(row.size) || 0,
      width: row.width, height: row.height, type: row.ftype, updatedAt: row.updated_at }))
      .filter(row => this.#root === '/' || row.path === this.#root || row.path.startsWith(`${this.#root}/`));
    return { entries, pageFull: data.list.length >= limit };
  }
  async photoSearch(query, { mode = 'ai', start = 0, limit = 100 } = {}) {
    this.#photoPagination(start, limit);
    if (!['ai', 'ocr', 'similar'].includes(mode) || typeof query !== 'string' || !query.trim() || query.length > 4096 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('Invalid photo search query');
    if (mode !== 'ocr' && start !== 0) throw new Error('AI search returns top candidates; start must be zero');
    const params = { input_modal: mode === 'similar' ? 0 : 1, query_content: mode === 'similar' ? this.#path(query) : query, top_limit: limit };
    if (mode === 'ocr') return this.#photoPage((await this.#json('/v2/album/ai/ocr/search', { ...params, start, num: limit }, { retry: true })).data, limit);
    // The native protocol creates a transient query, not an album or indexing task.
    await this.#json('/v2/album/feed/search/create', params);
    const deadline = Date.now() + this.#timeout;
    for (;;) {
      const data = (await this.#json('/v2/album/feed/search/query', params, { retry: true })).data;
      if (data.status !== 1) {
        if (data.status === 3) throw new Error('NAS photo search failed');
        return this.#photoPage(data, limit);
      }
      if (Date.now() >= deadline) throw new Error('NAS photo search timed out');
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, this.#timeout)));
    }
  }
  async photoPickTypes() {
    const data = (await this.#json('/v2/album/ai/picking/menu_bar', {}, { retry: true })).data;
    if (!Array.isArray(data)) throw new Error('Invalid photo picking categories');
    return data.map(row => ({ type: row.type, name: row.name }));
  }
  async photoPicks({ type = 9, start = 0, limit = 100, order = 'desc' } = {}) {
    this.#photoPagination(start, limit);
    if (![9, 1, 10, 11].includes(type) || !['asc', 'desc'].includes(order)) throw new Error('Invalid photo picking query');
    return this.#photoPage((await this.#json('/v2/album/ai/picking/result', { selection_type: type, threshold_score: 0, start, num: limit, order }, { retry: true })).data, limit);
  }
  async ls(value = '/sata1/my/data', { hidden = false, pageSize = 50 } = {}) {
    const directory = this.#path(value);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error('pageSize must be 1..50');
    const result = []; const seen = new Set();
    let pageLength = pageSize;
    for (let start = 0; pageLength >= pageSize; start += pageSize) {
      const data = await this.#json('/v2/file/list', { path: directory, show_hidden: hidden ? '1' : '0', start, limit: pageSize }, { retry: true });
      const list = data.data?.list;
      if (!Array.isArray(list)) throw new Error('Invalid NAS directory response');
      for (const row of list) {
        const p = this.#path(row.path);
        if (path.posix.dirname(p) !== directory || basename(row.name) !== path.posix.basename(p)) throw new Error('NAS returned an unsafe directory entry');
        if (seen.has(p)) throw new Error('NAS pagination repeated a file');
        seen.add(p); result.push({ name: row.name, path: p, isDir: String(row.is_dir) === '1', size: Number(row.size) || 0,
          modifyTime: row.modify_time ?? '', createTime: row.create_time ?? '', ext: row.ext ?? '' });
      }
      pageLength = list.length;
    }
    return result;
  }
  async info(value) { return (await this.#json('/v2/file/info', { path: this.#path(value) }, { retry: true })).data; }
  async rename(value, name) { this.#write(); return (await this.#json('/v2/file/modify', { path: protectRoot(value, this.#root), newname: basename(name) })).data; }
  async mkdir(parent, name) { this.#write(); return (await this.#json('/v2/file/newdir', { parent: this.#path(parent), name: basename(name), rename: '0' })).data; }
  async move(values, to) { this.#write(); return (await this.#json('/v2/file/move', { 'paths[]': this.#paths(values, true), to: this.#path(to) })).data; }
  async copy(values, to) { this.#write(); return (await this.#json('/v2/file/copy', { 'paths[]': this.#paths(values), to: this.#path(to) })).data; }
  async remove(values) { this.#write(true); return (await this.#json('/v2/file/remove', { 'paths[]': this.#paths(values, true) })).data; }
  #paths(values, protect = false) {
    const list = Array.isArray(values) ? values : [values];
    if (!list.length) throw new Error('At least one NAS path is required');
    return list.map(p => protect ? protectRoot(p, this.#root) : this.#path(p));
  }
  async search(keyword, value = '/sata1/my/data', { limit = 100 } = {}) {
    const base = this.#path(value);
    if (typeof keyword !== 'string' || !keyword || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid search query');
    const data = await this.#json('/file_search/file_search', { keyword }, { retry: true });
    return (data.data?.list ?? []).filter(row => typeof row.path === 'string' && (base === '/' || row.path === base || row.path.startsWith(`${base}/`)))
      .map(row => ({ name: basename(row.name), path: this.#path(row.path), isDir: String(row.is_dir) === '1', size: Number(row.size) || 0 })).slice(0, limit);
  }
  async tree(value = '/sata1/my/data', { depth = 2, hidden = false } = {}) {
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 100) throw new Error('depth must be 0..100');
    const result = []; const seen = new Set();
    const walk = async (p, level) => {
      if (level >= depth || seen.has(p)) return;
      seen.add(p);
      for (const row of await this.ls(p, { hidden })) { result.push({ ...row, depth: level }); if (row.isDir) await walk(row.path, level + 1); }
    };
    await walk(this.#path(value), 0); return result;
  }
  async glob(pattern) {
    this.#path(pattern);
    const index = pattern.search(/[\*?\[]/);
    if (index < 0) return [this.#path(pattern)];
    const prefix = pattern.slice(0, index);
    const root = prefix.endsWith('/') ? prefix.slice(0, -1) || '/' : path.posix.dirname(prefix);
    const matcher = globRegex(pattern);
    return (await this.tree(root, { depth: 100 })).filter(row => matcher.test(row.path)).map(row => row.path);
  }
  async upload(local, directory, { name, onProgress = () => {} } = {}) {
    this.#write();
    const file = await localPath(local, this.#localRoot); const details = await stat(file);
    if (!details.isFile()) throw new Error('Upload source must be a regular file');
    const target = this.#path(`${this.#path(directory)}/${basename(name ?? path.basename(file))}`);
    const total = details.size;
    const creds = await this.#credentials();
    if (total <= this.#threshold) {
      try {
        const body = createReadStream(file); let sent = 0;
        body.on('data', b => { sent += b.length; onProgress(sent, total); });
        // A data listener starts flowing immediately; wait until authentication and the request are ready.
        body.pause();
        return (await this.#json('/v2/file/create', {}, { body, credentials: creds, headers: { 'Content-Type': 'application/octet-stream',
          'Content-Length': total, path: Buffer.from(target, 'utf8').toString('latin1') }, query: { remote_port: '8050' } })).data;
      } catch (e) { if (e.code !== '413') throw e; }
    }
    const mtimeMs = Math.ceil(details.mtimeMs);
    const uuid = createHash('md5').update(`${mtimeMs + total}${target}`).digest('hex');
    const fileHandle = await open(file, 'r');
    try {
      for (let sent = 0; sent < total;) {
        const length = Math.min(this.#slice, total - sent); const buffer = Buffer.alloc(length);
        const { bytesRead } = await fileHandle.read(buffer, 0, length, sent);
        if (bytesRead !== length) throw new Error('Upload source changed during reading');
        const params = { app: 'file', path: encodeURIComponent(target), size: total, uuid, seek: sent, crtime: '', modify_time: Math.ceil(mtimeMs / 1000),
          rename: 0, token: encodeURIComponent(creds.token), plat: 'pc', nasid: creds.nasId, version: creds.appVersion,
          device_id: creds.deviceId, device: encodeURIComponent(creds.device), 'Content-Length': length,
          'request-purpose': 4, 'remote-port': 8050, split: 1 };
        const headers = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
        headers.Cookie = Object.entries(params).map(([k, v]) => `${k === 'nasid' ? 'nas_id' : k}=${encodeURIComponent(v)}`).join('; ');
        headers['Content-Type'] = 'application/octet-stream';
        await this.#json('/v2/file/upload', {}, { body: buffer, headers, query: { remote_port: '8050', drnd: Date.now(), uuid }, retry: true });
        sent += length; onProgress(sent, total);
      }
    } finally { await fileHandle.close(); }
    return { path: target, name: path.posix.basename(target), size: total };
  }
  async download(remote, directory = '.', { name, overwrite = false, onProgress = () => {} } = {}) {
    return this.#download(remote, directory, { name, overwrite, onProgress, thumbnail: false });
  }
  async photoThumbnail(remote, directory = '.', { name, size = 'small' } = {}) {
    if (!['small', 'large'].includes(size)) throw new Error('Thumbnail size must be small or large');
    return this.#download(remote, directory, { name: name ?? `${path.posix.basename(remote)}.thumb.jpg`, overwrite: false, onProgress: () => {}, thumbnail: true, size });
  }
  async #download(remote, directory, { name, overwrite, onProgress, thumbnail, size }) {
    const source = this.#path(remote);
    // Validate the existing parent before creating an explicit output directory.
    const requested = path.resolve(directory);
    if (!await exists(requested)) {
      await localPath(path.dirname(requested), this.#localRoot); await mkdir(requested);
    }
    const dest = await localPath(requested, this.#localRoot);
    const out = path.join(dest, basename(name ?? path.posix.basename(source)));
    const previous = await exists(out);
    if (previous && (!overwrite || previous.isSymbolicLink() || !previous.isFile())) throw new Error('Destination exists; use overwrite only for a regular file');
    const temp = path.join(dest, `.zspace-${randomUUID()}.part`);
    let fh; let response;
    try {
      fh = await open(temp, 'wx', 0o600);
      response = await this.#request(thumbnail ? '/transcode/thumb' : '/v2/file/download', { method: 'GET', query: thumbnail
        ? { file_path: source, dest_fmt: size, request_purpose: '5' } : { path: source, remote_port: '8050' } });
      if (thumbnail && !/^image\/(jpeg|png|webp|gif)(?:;|$)/i.test(response.headers['content-type'])) throw new Error('Proxy did not return a supported thumbnail image');
      const total = Number(response.headers['content-length'] ?? 0); let received = 0;
      for await (const chunk of response) {
        received += chunk.length;
        if (thumbnail && received > 16 * 1024 * 1024) { response.destroy(); throw new Error('Thumbnail is too large'); }
        await fh.writeFile(chunk); onProgress(received, total);
      }
      if (total && received !== total) throw new Error('Incomplete download');
      await fh.close(); fh = null;
      if (overwrite) await rename(temp, out); else { await link(temp, out); await unlink(temp); }
      return { path: out, size: received };
    } finally { response?.destroy(); if (fh) await fh.close(); await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
}
