import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { ZSpaceClient } from '../src/client.js';
import { createMcpHandler } from '../src/mcp.js';
import { mockNas, credentials, nasRoot } from '../test-support/mock-nas.js';

const photo = { id: 1, name: '海边.jpg', path: `${nasRoot}/海边.jpg`, size: 5 };

test('gallery searches use native transient queries, OCR pagination and bounded metadata', async t => {
  const nas = await mockNas(t); const c = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, root: nasRoot, timeout: 20 });
  assert.deepEqual(await c.photoStatus(), { aiEnabled: 1, searchEnabled: 1, ocrEnabled: 1, indexed: 8, total: 10, runningStatus: 0 });
  assert.equal((await c.photoSearch('海边')).entries[0].name, 'photo.jpg');
  const query = nas.requests.at(-1).form; assert.equal(query.get('input_modal'), '1'); assert.equal(query.get('query_content'), '海边'); assert.equal(query.get('top_limit'), '100');
  await c.photoSearch(photo.path, { mode: 'similar', limit: 2 }); assert.equal(nas.requests.at(-1).form.get('input_modal'), '0');
  const before = nas.requests.length;
  const ocr = await c.photoSearch('发票', { mode: 'ocr', start: 2, limit: 1 }); assert.equal(ocr.pageFull, true); assert.equal(nas.requests.length, before + 1);
  assert.equal(nas.requests.at(-1).form.get('start'), '2'); assert.equal(nas.requests.at(-1).form.get('num'), '1');
  assert.deepEqual(await c.photoPickTypes(), [{ type: 9, name: 'Overall score' }]);
  await c.photoPicks(); await c.photoPicks({ type: 10, start: 1, limit: 1, order: 'asc' });
  assert.equal(nas.requests.at(-1).form.get('selection_type'), '10'); assert.equal(nas.requests.at(-1).form.get('threshold_score'), '0');
  let polls = 0;
  nas.override((q, res) => {
    if (q.url.pathname.endsWith('/create')) { res.end('{"code":200}'); return true; }
    const data = q.url.pathname.endsWith('/query') && polls++ === 0 ? { status: 1 } : { status: 2, list: [photo, { ...photo, size: undefined, path: nasRoot }, { ...photo, path: '/outside/photo.jpg' }, { ...photo, path: `${nasRoot}2/photo.jpg` }, { ...photo, path: 'E.encrypted' }] };
    res.end(JSON.stringify({ code: 200, data })); return true;
  });
  const scoped = await c.photoSearch('海边'); assert.equal(polls, 2); assert.equal(scoped.entries.length, 2); assert.equal(scoped.entries[1].size, 0); assert.equal(scoped.pageFull, false);
  assert.equal('faces' in scoped.entries[0], false);
  const all = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl }); assert.equal((await all.photoSearch('海边')).entries.length, 4);
  assert.equal((await all.photoSearch('海边', { limit: 1 })).entries.length, 1, 'Native over-limit results must remain bounded');
});

test('gallery query validation, failure and pending timeout are explicit', async t => {
  const nas = await mockNas(t); const c = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, root: nasRoot, timeout: 15, retries: 0 });
  const before = nas.requests.length;
  for (const options of [{ start: -1 }, { start: 0.5 }, { limit: 0 }, { limit: 0.5 }, { limit: 1001 }]) {
    await assert.rejects(c.photoSearch('text', options), /pagination/); await assert.rejects(c.photoPicks(options), /pagination/);
  }
  for (const query of [null, '', ' ', 'bad\n', 'a'.repeat(4097)]) await assert.rejects(c.photoSearch(query), /query/);
  await assert.rejects(c.photoSearch('text', { mode: 'unknown' }), /query/);
  await assert.rejects(c.photoSearch('text', { start: 1 }), /start/);
  await assert.rejects(c.photoSearch('/outside/p.jpg', { mode: 'similar' }), /outside/);
  for (const options of [{ type: 3 }, { order: 'bad' }]) await assert.rejects(c.photoPicks(options), /query/);
  assert.equal(nas.requests.length, before);
  let data;
  nas.override((_, res) => { res.end(JSON.stringify({ code: 200, data })); return true; });
  for (const value of [{ list: null }, { list: [{}] }, { list: [{ ...photo, path: '/a/../b' }] }, { list: [{ ...photo, name: '../bad' }] }]) { data = value; await assert.rejects(c.photoSearch('text', { mode: 'ocr' })); }
  data = {}; await assert.rejects(c.photoPickTypes(), /categories/);
  data = { status: 3 }; await assert.rejects(c.photoSearch('text'), /failed/);
  data = { status: 1 }; await assert.rejects(c.photoSearch('text'), /timed out/);
  data = { list: [], status: 2 }; assert.deepEqual(await c.photoPicks(), { entries: [], pageFull: false });
  nas.override((_, res) => { res.end('{"code":"N003598","msg":"Engine unavailable"}'); return true; });
  await assert.rejects(c.photoSearch('text'), /Engine unavailable/);
});

test('thumbnail downloads use a fixed authenticated endpoint with private atomic output', async t => {
  const nas = await mockNas(t); const c = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, root: nasRoot, localRoot: nas.directory });
  const result = await c.photoThumbnail(photo.path, nas.directory);
  assert.equal(result.path, path.join(await realpath(nas.directory), '海边.jpg.thumb.jpg')); assert.deepEqual(await readFile(result.path), Buffer.from([255, 216, 255, 217]));
  const q = nas.requests.at(-1); assert.equal(q.url.pathname, '/transcode/thumb'); assert.equal(q.method, 'GET'); assert.equal(q.url.searchParams.get('file_path'), photo.path); assert.equal(q.url.searchParams.get('request_purpose'), '5');
  await c.photoThumbnail(photo.path, nas.directory, { name: 'large.jpg', size: 'large' }); assert.equal(nas.requests.at(-1).url.searchParams.get('dest_fmt'), 'large');
  await assert.rejects(c.photoThumbnail(photo.path, nas.directory), /exists/);
  await assert.rejects(c.photoThumbnail(photo.path, nas.directory, { size: 'bad' }), /size/);
  await assert.rejects(c.photoThumbnail('/outside/p.jpg', nas.directory), /outside/);
  await assert.rejects(c.photoThumbnail(photo.path, '/tmp'), /outside/);
  nas.override((_, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<script>bad</script>'); return true; });
  await assert.rejects(c.photoThumbnail(photo.path, nas.directory, { name: 'bad.jpg' }), /supported thumbnail/);
  assert.equal((await readdir(nas.directory)).some(n => n.endsWith('.part') || n === 'bad.jpg'), false);
  nas.override((_, res) => { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.alloc(16 * 1024 * 1024 + 1)); return true; });
  await assert.rejects(c.photoThumbnail(photo.path, nas.directory, { name: 'huge.jpg' }), /too large/);
  assert.equal((await readdir(nas.directory)).some(n => n.endsWith('.part') || n === 'huge.jpg'), false);
  await c.photoThumbnail(photo.path, undefined, { name: `zspace-should-not-write.jpg` }).then(() => assert.fail('outside local root'), e => assert.match(e.message, /outside/));
});

test('gallery MCP tools are discoverable, scoped and thumbnail download requires a local root', async t => {
  const nas = await mockNas(t); const h = createMcpHandler({ credentials, baseUrl: nas.baseUrl, root: nasRoot, localRoot: nas.directory });
  const req = (method, params = {}) => h({ jsonrpc: '2.0', id: 1, method, params });
  await req('initialize', { protocolVersion: '2025-11-25' }); await h({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const [name, args] of [['photo_status', {}], ['photo_pick_types', {}], ['photo_search', { query: '海边' }], ['photo_search', { query: '发票', mode: 'ocr', start: 1, limit: 2 }], ['photo_picks', {}], ['photo_thumbnail', { remote_path: photo.path, local_dir: nas.directory }], ['photo_thumbnail', { remote_path: photo.path, local_dir: nas.directory, name: 'custom.jpg', size: 'large' }]]) {
    const result = await req('tools/call', { name: `zspace_${name}`, arguments: args }); assert.equal(result.result.isError, false, JSON.stringify(result));
  }
  assert.equal((await req('tools/list')).result.tools.find(t => t.name === 'zspace_photo_thumbnail').annotations.readOnlyHint, false);
});
