import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { ZSpaceClient } from '../src/client.js';
import { loadCredentials } from '../src/auth.js';
import { loopbackURL, globRegex } from '../src/safety.js';
import { createHash } from 'node:crypto';

const credentials = { token: 'test-secret-token', nasId: 'test-nas', deviceId: 'test-device', device: 'Test', appVersion: '1.0' };
const root = '/sata1/my/data/test';
const json = (res, data = {}, code = '200', msg) => res.end(JSON.stringify({ code, data, msg }));
const entry = (name, parent = root, isDir = false) => ({ name, path: `${parent}/${name}`, is_dir: isDir ? '1' : '0', size: '12' });
async function fixture(t, handler, options = {}) {
  const local = await mkdtemp(path.join(os.tmpdir(), 'zspace-test-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = { url: new URL(req.url, 'http://127.0.0.1'), headers: req.headers, body: Buffer.concat(chunks), method: req.method };
      request.form = new URLSearchParams(request.body.toString()); requests.push(request);
      await handler(request, res, requests);
    } catch (e) { res.destroy(e); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(local, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { client: new ZSpaceClient({ baseUrl, credentials, root, localRoot: local, ...options }), local, requests, baseUrl };
}

test('only loopback origins; no alternate token destinations', () => {
  for (const url of ['https://127.0.0.1', 'http://example.com', 'http://127.0.0.1.evil.test', 'http://localhost', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1/?x=1']) assert.throws(() => loopbackURL(url));
  assert.equal(loopbackURL('http://[::1]:1234'), 'http://[::1]:1234');
});

test('credentials parse BOM and stay out of errors', async t => {
  const { local, client } = await fixture(t, (_, res) => json(res, {}, credentials.token, `bad ${credentials.token} ${encodeURIComponent(credentials.token)}`));
  await writeFile(path.join(local, 'vuex.json'), '\ufeff' + JSON.stringify({ state: { user: { token: 'fake' }, nas: { nasId: 'nas' }, app: { deviceId: 'device' } } }));
  assert.equal((await loadCredentials(local)).token, 'fake');
  await assert.rejects(client.info(`${root}/a`), e => !e.message.includes(credentials.token) && e.message.includes('[redacted]'));
});

test('permission gates and root boundaries reject before any request', async t => {
  const { client, requests, baseUrl } = await fixture(t, (_, res) => json(res));
  for (const call of [() => client.mkdir(root, 'new'), () => client.rename(`${root}/a`, 'b'), () => client.copy(`${root}/a`, root), () => client.move(`${root}/a`, root), () => client.remove(`${root}/a`), () => client.upload('/missing', root)]) await assert.rejects(call(), /Writes are disabled/);
  for (const p of ['/sata1/my/data/test2/a', `${root}/../a`, `${root}/a\nb`, `${root}/a\\b`]) await assert.rejects(client.info(p));
  const writable = new ZSpaceClient({ baseUrl, credentials, root, allowWrites: true });
  await assert.rejects(writable.remove(`${root}/a`), /Deletion is disabled/);
  await assert.rejects(writable.rename(root, 'other'), /protected root/);
  await assert.rejects(writable.move(root, root), /protected root/);
  await assert.rejects(writable.mkdir(root, '../escape'), /plain filename/);
  assert.equal(requests.length, 0);
});

test('list pagination, safe entry validation, tree and glob traversal', async t => {
  const rows = Array.from({ length: 57 }, (_, i) => entry(`file${i}.txt`)); rows.push(entry('child', root, true));
  const { client, requests } = await fixture(t, (q, res) => {
    const all = q.form.get('path') === root ? rows : [entry('中文.txt', `${root}/child`)];
    json(res, { list: all.slice(Number(q.form.get('start')), Number(q.form.get('start')) + Number(q.form.get('limit'))) });
  });
  assert.equal((await client.ls(root)).length, 58);
  assert.deepEqual(requests.slice(0, 2).map(q => q.form.get('start')), ['0', '50']);
  assert.equal((await client.tree(root, { depth: 1 })).length, 58);
  assert.equal((await client.tree(root, { depth: 2 })).length, 59);
  assert.equal((await client.glob(`${root}/**/*.txt`)).length, 58);
  assert.deepEqual(await client.glob(`${root}/child/中*.txt`), [`${root}/child/中文.txt`]);
  assert.equal(globRegex('/a/[!-0]').test('/a//'), false);
});

test('repeated pages and foreign entries fail closed', async t => {
  const { client, baseUrl } = await fixture(t, (_, res) => json(res, { list: [entry('one')] }));
  await assert.rejects(client.ls(root, { pageSize: 1 }), /repeated/);
  const other = await fixture(t, (_, res) => json(res, { list: [entry('one', '/outside')] }));
  await assert.rejects(other.client.ls(root), /outside/);
  assert.ok(baseUrl);
});

test('mutation arrays and special filenames are form data, never source', async t => {
  const { client, requests } = await fixture(t, (_, res) => json(res, { accepted: true }), { allowWrites: true, allowDelete: true });
  const first = `${root}/中文 '$(touch nope)'.txt`; const second = `${root}/b.txt`;
  await client.mkdir(root, '新文件夹'); await client.rename(first, 'new.txt');
  await client.move([first, second], root); await client.copy([first, second], root); await client.remove([first, second]);
  assert.deepEqual(requests.slice(2).map(q => q.form.getAll('paths[]')), [[first, second], [first, second], [first, second]]);
  assert.equal(requests[0].form.get('token'), credentials.token);
  assert.match(requests[0].headers.cookie, /zenithtoken=test-secret-token/);
});

test('reads retry transport failures; writes do not retry; redirects are not followed', async t => {
  const counts = {};
  const { client, requests } = await fixture(t, (q, res) => {
    const p = q.url.pathname; counts[p] = (counts[p] ?? 0) + 1;
    if (p === '/v2/file/info' && counts[p] === 1 || p === '/v2/file/newdir') { res.statusCode = 503; res.end(); }
    else if (p === '/disk/statics') { res.statusCode = 302; res.setHeader('Location', 'https://example.com/token'); res.end(); }
    else json(res, { pool_list: [] });
  }, { allowWrites: true });
  await client.info(`${root}/a`); assert.equal(counts['/v2/file/info'], 2);
  await assert.rejects(client.mkdir(root, 'new')); assert.equal(counts['/v2/file/newdir'], 1);
  await assert.rejects(client.diskStats(), /302/); assert.equal(counts['/disk/statics'], 1);
  assert.equal(requests.length, 4);
});

test('search results are limited to the allowed root', async t => {
  const { client } = await fixture(t, (_, res) => json(res, { list: [entry('a'), entry('b'), entry('outside', `${root}2`)] }));
  assert.deepEqual((await client.search('a', root, { limit: 1 })).map(f => f.name), ['a']);
});

test('small and sliced uploads preserve binary bytes and Unicode path headers', async t => {
  const payload = Buffer.from('中文\0binary-data'); const assembled = Buffer.alloc(payload.length);
  const { client, requests, local } = await fixture(t, (q, res) => {
    if (q.url.pathname === '/v2/file/upload') q.body.copy(assembled, Number(q.headers.seek));
    json(res, { uploaded: true });
  }, { allowWrites: true, sliceThreshold: 100, sliceSize: 4 });
  const file = path.join(local, '中文.txt'); await writeFile(file, payload);
  await client.upload(file, root);
  assert.deepEqual(requests[0].body, payload);
  assert.equal(requests[0].url.searchParams.get('remote_port'), '8050');
  assert.equal(Buffer.from(requests[0].headers.path, 'latin1').toString('utf8'), `${root}/中文.txt`);
  // Reuse the same proxy while forcing the slice protocol.
  const proxy = requests[0].headers.host;
  const c = new ZSpaceClient({ baseUrl: `http://${proxy}`, credentials, root, localRoot: local, allowWrites: true, sliceThreshold: 1, sliceSize: 4 });
  await c.upload(file, root);
  assert.deepEqual(assembled, payload);
  const parts = requests.slice(1); assert.deepEqual(parts.map(q => Number(q.headers.seek)), [0, 4, 8, 12, 16]);
  const details = await stat(file);
  assert.equal(parts[0].headers.uuid, createHash('md5').update(`${Math.ceil(details.mtimeMs) + payload.length}${root}/中文.txt`).digest('hex'));
  assert.equal(decodeURIComponent(parts[0].headers.path), `${root}/中文.txt`);
  assert.match(parts[0].headers.cookie, /nas_id=test-nas/);
});

test('413 create response falls back to slices', async t => {
  const { client, local, requests } = await fixture(t, (q, res) => {
    if (q.url.pathname.endsWith('/create')) { res.statusCode = 413; res.end(); } else json(res);
  }, { allowWrites: true, sliceSize: 4 });
  const file = path.join(local, 'small'); await writeFile(file, 'abcdef');
  await client.upload(file, root);
  assert.deepEqual(requests.map(q => q.url.pathname), ['/v2/file/create', '/v2/file/upload', '/v2/file/upload']);
});

test('upload waits for desktop credentials before streaming file bytes', async t => {
  const payload = Buffer.alloc(1024 * 1024, 83);
  const { local, baseUrl, requests } = await fixture(t, (_, res) => json(res));
  await writeFile(path.join(local, 'vuex.json'), JSON.stringify({ state: { user: { token: credentials.token }, nas: { nasId: credentials.nasId }, app: { deviceId: credentials.deviceId } } }));
  const file = path.join(local, 'source'); await writeFile(file, payload);
  const client = new ZSpaceClient({ baseUrl, configDir: local, root, localRoot: local, allowWrites: true, timeout: 1000 });
  await client.upload(file, root);
  assert.deepEqual(requests[0].body, payload);
});

test('downloads stream multiple chunks; prevent overwrites and escaping symlinks', async t => {
  const payload = Buffer.alloc(200000, 123);
  const { client, local } = await fixture(t, (_, res) => {
    res.setHeader('Content-Length', payload.length); res.write(payload.subarray(0, 70000)); setImmediate(() => res.end(payload.subarray(70000)));
  });
  const result = await client.download(`${root}/中文.bin`, local);
  assert.deepEqual(await readFile(result.path), payload);
  await assert.rejects(client.download(`${root}/中文.bin`, local), /Destination exists/);
  await client.download(`${root}/中文.bin`, local, { overwrite: true });
  await symlink(os.tmpdir(), path.join(local, 'escape'));
  await assert.rejects(client.download(`${root}/x`, path.join(local, 'escape')), /outside/);
  await symlink(result.path, path.join(local, 'link'));
  await assert.rejects(client.download(`${root}/link`, local, { overwrite: true }), /Destination exists/);
  await assert.rejects(client.download(`${root}/x`, local, { name: '../escape' }), /plain filename/);
  assert.equal((await readdir(local)).filter(n => n.endsWith('.part')).length, 0);
});

test('interrupted downloads never expose a final or partial file', async t => {
  const { client, local } = await fixture(t, (_, res) => {
    res.setHeader('Content-Length', 100); res.write('partial'); setImmediate(() => res.destroy());
  });
  await assert.rejects(client.download(`${root}/broken`, local));
  assert.deepEqual(await readdir(local), []);
});
