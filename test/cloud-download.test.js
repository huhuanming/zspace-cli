import test from 'node:test';
import assert from 'node:assert/strict';
import { ZSpaceClient } from '../src/client.js';
import { createMcpHandler } from '../src/mcp.js';
import { mockNas, credentials, nasRoot } from '../test-support/mock-nas.js';

test('Baidu and Quark listing, cursors and NAS transfers use the desktop protocol', async t => {
  const nas = await mockNas(t); const c = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, root: nasRoot, allowWrites: true });
  for (const provider of ['baidu', 'quark']) {
    assert.equal((await c.cloudStatus(provider)).isLogin, true);
    assert.equal(nas.requests.at(-1).form.get('rd'), `${nas.baseUrl}/home/newNetdisk`);
    assert.match(nas.requests.at(-1).headers.cookie, /plat=pc/); assert.match(nas.requests.at(-1).headers.cookie, /app=file/);
    const list = await c.cloudList(provider); assert.equal(list.entries[0].name, 'cloud.txt'); assert.equal(list.hasMore, false);
    const task = await c.cloudDownload(provider, nasRoot, { fileIds: [list.entries[0].id], folderIds: ['folder-id'] }); assert.equal(task.data.task_id, 'mock-transfer'); assert.equal(task.accepted, true);
    const q = nas.requests.at(-1); assert.equal(q.form.get('save_path'), nasRoot); assert.equal(q.url.pathname, provider === 'baidu' ? '/znetdisk/file/download' : '/zdrive/kuake/task/download');
    assert.equal(q.form.get('file_ids'), provider === 'baidu' ? '123,folder-id' : 'quark-file');
    if (provider === 'quark') assert.equal(q.form.get('folder_ids'), 'folder-id');
    await c.cloudTasks(provider);
  }
  await c.cloudDownload('quark', nasRoot, { folderIds: ['folder-id'] });
  await c.cloudDownload('baidu', nasRoot, { fileIds: ['123'] });
  const cursor = { version: '1', token: 'next' }; await c.cloudList('quark', { parentId: 'folder-id', cursor });
  assert.equal(nas.requests.at(-1).form.get('cursor_token'), 'next');
  nas.override((q, res) => {
    const data = q.url.pathname.includes('auth') ? { is_login: q.form.get('plat') === 'web' ? 1 : false }
      : q.url.pathname.startsWith('/znetdisk') ? { list: [{ fs_id: 42, server_filename: 'folder', isdir: '1' }] }
        : { file_list: [{ file_id: 'folder', name: 'Folder', type: 'folder' }], last_page: false, next_query_cursor: cursor };
    res.end(JSON.stringify({ code: 200, data })); return true;
  });
  assert.equal((await c.cloudStatus('baidu')).isLogin, true);
  assert.equal((await c.cloudList('baidu', { path: '/folder', page: 2, limit: 1 })).hasMore, true);
  const next = await c.cloudList('quark'); assert.equal(next.entries[0].isDir, true); assert.equal(next.hasMore, true); assert.deepEqual(next.cursor, cursor);
  nas.override((_, res) => { res.end(JSON.stringify({ code: 200, data: { is_login: false } })); return true; });
  assert.equal((await c.cloudStatus('quark')).isLogin, false); await assert.rejects(c.cloudList('quark'), /Invalid cloud directory/);
});

test('download links are handed to NAS and requests reject invalid inputs before writing', async t => {
  const nas = await mockNas(t); const c = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, root: nasRoot, allowWrites: true });
  for (const link of ['https://example.com/file?a=1&b=2', 'ftp://example.com/file', 'magnet:?xt=urn:btih:0123', 'thunder://mock']) {
    assert.equal((await c.addDownload(link, nasRoot)).data.id, 'mock-download'); assert.equal(nas.requests.at(-1).form.get('uri'), link); assert.equal(nas.requests.at(-1).form.get('dir'), nasRoot);
  }
  assert.equal((await c.listDownloads()).total, 0); await c.listDownloads({ type: 'complete', status: 'seeding', start: 1, limit: 1 });
  const readonly = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl });
  await assert.rejects(readonly.addDownload('https://example.com', nasRoot), /Writes/); await assert.rejects(readonly.cloudDownload('baidu', nasRoot, { fileIds: ['1'] }), /Writes/);
  const before = nas.requests.length;
  for (const provider of ['bad', '__proto__']) await assert.rejects(c.cloudStatus(provider), /provider/);
  for (const options of [{ page: 0 }, { page: 1.5 }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }]) await assert.rejects(c.cloudList('baidu', options), /pagination/);
  for (const options of [{ parentId: '' }, { cursor: {} }, { cursor: { version: '1', token: 1 } }, { cursor: { version: '\n', token: 't' } }]) await assert.rejects(c.cloudList('quark', options));
  for (const options of [{}, { fileIds: '1' }, { fileIds: [1] }, { fileIds: ['bad,id'] }]) await assert.rejects(c.cloudDownload('baidu', nasRoot, options));
  for (const link of [null, '', 'javascript:alert(1)', 'https://example.com/\n', 'sftp:/path', 'http://']) await assert.rejects(c.addDownload(link, nasRoot));
  for (const options of [{ type: 'bad' }, { status: 'bad' }, { start: -1 }, { start: 1.5 }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }]) await assert.rejects(c.listDownloads(options), /query/);
  await assert.rejects(c.addDownload('https://example.com', '/outside'), /outside/); await assert.rejects(c.cloudDownload('quark', '/outside', { fileIds: ['1'] }), /outside/);
  assert.equal(nas.requests.length, before);
  nas.override((_, res) => { res.end(JSON.stringify({ code: 200 })); return true; });
  assert.equal((await c.addDownload('https://example.com', nasRoot)).accepted, true);
});

test('MCP cloud and download tools use mock requests with write capability gates', async t => {
  const nas = await mockNas(t); const h = createMcpHandler({ credentials, baseUrl: nas.baseUrl, root: nasRoot, allowWrites: true });
  const req = (method, params = {}) => h({ jsonrpc: '2.0', id: 1, method, params });
  await req('initialize', { protocolVersion: '2025-11-25' }); await h({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const [name, args] of [['cloud_status', { provider: 'baidu' }], ['cloud_ls', { provider: 'baidu' }], ['cloud_ls', { provider: 'quark', parent_id: '0', cursor: '{"version":"1","token":"next"}' }], ['cloud_tasks', { provider: 'quark' }], ['cloud_download', { provider: 'baidu', remote_dir: nasRoot, file_ids: ['123'] }], ['download_add', { link: 'https://example.com/file', remote_dir: nasRoot }], ['downloads', {}]]) {
    const result = await req('tools/call', { name: `zspace_${name}`, arguments: args }); assert.equal(result.result.isError, false, JSON.stringify(result));
  }
});
