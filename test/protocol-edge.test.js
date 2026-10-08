import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { ZSpaceClient } from '../src/client.js';
import { createMcpHandler, serveMcp } from '../src/mcp.js';
import { remotePath, basename, protectRoot, inside, exists, globRegex } from '../src/safety.js';
import { installSkills } from '../src/skills.js';
import { mockNas, credentials, nasRoot } from '../test-support/mock-nas.js';
const request = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('MCP calls every enabled tool with validated arguments against mock requests', async t => {
  const nas = await mockNas(t); const handler = createMcpHandler({ credentials, baseUrl: nas.baseUrl, root: nasRoot, localRoot: nas.directory, allowWrites: true, allowDelete: true });
  await handler(request('initialize', { protocolVersion: '2024-11-05' })); await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const call = async (name, args) => { const result = await handler(request('tools/call', { name: `zspace_${name}`, arguments: args })); assert.equal(result.result.isError, false, JSON.stringify(result)); return result.result.structuredContent.result; };
  await call('check', {}); await call('pool_info', {}); await call('disk_stats', {}); await call('ls', { path: nasRoot, show_hidden: true });
  await call('info', { path: `${nasRoot}/a.txt` }); await call('search', { keyword: 'a', path: nasRoot }); await call('tree', { path: nasRoot, depth: 1 });
  await call('mkdir', { parent: nasRoot, name: 'created' }); await call('rename', { path: `${nasRoot}/a.txt`, new_name: 'renamed.txt' });
  await call('copy', { paths: [`${nasRoot}/renamed.txt`], to: `${nasRoot}/folder` }); await call('move', { paths: `${nasRoot}/renamed.txt`, to: `${nasRoot}/created` });
  await call('remove', { paths: [`${nasRoot}/created/renamed.txt`] });
  const source = path.join(nas.directory, 'upload.txt'); await writeFile(source, 'transfer'); await call('upload', { local_path: source, remote_dir: nasRoot, new_name: 'uploaded.txt' });
  await call('download', { remote_path: `${nasRoot}/uploaded.txt`, local_dir: path.join(nas.directory, 'output') });
  assert.equal(await readFile(path.join(nas.directory, 'output', 'uploaded.txt'), 'utf8'), 'transfer');
  const invalid = [{ name: 'zspace_ls', arguments: { path: '' } }, { name: 'zspace_ls', arguments: { path: nasRoot, show_hidden: 'yes' } }, { name: 'zspace_move', arguments: { paths: [], to: nasRoot } }, { name: 'zspace_move', arguments: { paths: [1], to: nasRoot } }, { name: 'zspace_tree', arguments: { path: nasRoot, depth: 1.5 } }, { name: 'zspace_tree', arguments: { path: nasRoot, depth: -1 } }, { name: 'zspace_ls', arguments: [] }, { name: 'zspace_ls', arguments: null }, { name: 'zspace_ls', arguments: {} }, { name: 'zspace_ls' }];
  for (const params of invalid) assert.equal((await handler(request('tools/call', params))).error.code, -32602);
});

test('MCP malformed requests, lifecycle, fallback negotiation and framing limits', async () => {
  const h = createMcpHandler({ credentials });
  for (const m of [null, {}, { jsonrpc: '1.0', method: 'ping', id: 1 }, { jsonrpc: '2.0', method: 1, id: 1 }, { jsonrpc: '2.0', method: 'ping', id: {} }]) assert.equal((await h(m)).error.code, -32600);
  assert.deepEqual((await h(request('ping'))).result, {});
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await h(request('initialize', null))).error.code, -32602);
  assert.equal((await h(request('initialize', {}))).error.code, -32602);
  assert.equal((await h(request('initialize', { protocolVersion: 'unknown' }))).result.protocolVersion, '2025-11-25');
  assert.equal((await h(request('initialize', { protocolVersion: '2025-11-25' }))).error.code, -32600);
  await h({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await h(request('unknown'))).error.code, -32601);
  assert.equal((await h(request('tools/call', null))).error.code, -32602);
  const output = new Writable({ write(_, __, cb) { cb(); } });
  await serveMcp({ credentials, input: Readable.from(['\n  \n']), output });
  await assert.rejects(serveMcp({ credentials, input: Readable.from(['x'.repeat(1024 * 1024 + 1)]), output }), /exceeds/);
  await assert.rejects(serveMcp({ credentials, input: Readable.from(['{}']), output }), /newline/);
});

test('NAS JSON shape failures, redaction and parameter boundaries', async t => {
  const nas = await mockNas(t); const client = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, root: nasRoot });
  for (const options of [{ timeout: 0 }, { retries: -1 }, { sliceThreshold: 0 }, { sliceSize: 0 }]) assert.throws(() => new ZSpaceClient(options), /Invalid/);
  for (const pageSize of [0, 51, 1.5]) await assert.rejects(client.ls(nasRoot, { pageSize }), /pageSize/);
  for (const depth of [-1, 101, 1.5]) await assert.rejects(client.tree(nasRoot, { depth }), /depth/);
  assert.deepEqual(await client.tree(nasRoot, { depth: 0 }), []);
  for (const [keyword, limit] of [['', 1], ['x', 0], ['x', 1.5], [null, 1]]) await assert.rejects(client.search(keyword, nasRoot, { limit }), /Invalid/);
  const writer = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, allowWrites: true }); await assert.rejects(writer.copy([], '/sata1/my/data'), /At least/);
  await assert.rejects(writer.upload(nas.directory, '/sata1/my/data'), /regular file/);
  nas.override((_, res) => { res.end('not JSON'); return true; }); await assert.rejects(client.info(`${nasRoot}/a.txt`), /invalid JSON/);
  nas.override((_, res) => { res.end(JSON.stringify({ data: {} })); return true; }); await assert.rejects(client.info(`${nasRoot}/a.txt`), /unknown/);
  nas.override((_, res) => { res.end(JSON.stringify({ code: '200', data: {} })); return true; }); await assert.rejects(client.ls(nasRoot), /Invalid NAS/); assert.deepEqual(await client.search('x', nasRoot), []);
  assert.deepEqual((await client.check()).pools, []);
  nas.override((_, res) => { res.end(JSON.stringify({ code: '200', data: { list: [] } })); return true; }); assert.deepEqual(await client.ls(nasRoot), []);
  assert.deepEqual(await new ZSpaceClient({ credentials, baseUrl: nas.baseUrl }).glob('/*.txt'), []);
  nas.override((_, res) => { res.end(JSON.stringify({ code: '200', data: { list: [{ name: 'not-a', path: `${nasRoot}/a`, is_dir: 1, size: 0 }] } })); return true; }); await assert.rejects(client.ls(nasRoot), /unsafe/);
  nas.override((_, res) => { res.end(' '.repeat(16 * 1024 * 1024 + 1)); return true; }); await assert.rejects(client.info(`${nasRoot}/a.txt`), /too large/);
});

test('paths and glob matching cannot turn filenames into traversal', async t => {
  const nas = await mockNas(t); assert.equal(await exists(path.join(nas.directory, 'absent')), null);
  assert.equal(remotePath('/a//b/'), '/a/b'); assert.equal(remotePath('/'), '/'); assert.equal(inside('/a/b', '/a'), true); assert.equal(inside('/b', '/a'), false);
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => basename(name));
  for (const p of ['/', '/sata1', '/sata1/my', '/sata1/my/data']) assert.throws(() => protectRoot(p));
  assert.equal(globRegex('/a/**').test('/a/x/y'), true); assert.equal(globRegex('/a/?.[ab]').test('/a/x.a'), true);
  assert.equal(globRegex('/a/[!ab]').test('/a/c'), true); assert.equal(globRegex('/a/[!ab]').test('/a/a'), false);
  for (const pattern of ['/a/[', '/a/[]', '/a/[\\]', '/a/[/]']) assert.throws(() => globRegex(pattern));
  const client = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, root: nasRoot }); assert.deepEqual(await client.glob(`${nasRoot}/folder/*`), [`${nasRoot}/folder/nested.txt`]);
  await assert.rejects(installSkills()); await assert.rejects(installSkills(nas.directory, { only: '../wrong' }));
  const target = path.join(nas.directory, 'skills'); await installSkills(target); assert.equal((await installSkills(undefined, { list: true })).length, 10);
});
