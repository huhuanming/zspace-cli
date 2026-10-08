import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as streams from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
let hooks = {};
const wrappers = {};
for (const key of ['open', 'realpath', 'readdir', 'lstat', 'unlink']) wrappers[key] = (...args) => hooks[key] ? hooks[key](...args) : fs[key](...args);
mock.module('node:fs/promises', { namedExports: { ...fs, ...wrappers } });
const constants = { ...streams.constants, O_NOFOLLOW: undefined };
mock.module('node:fs', { namedExports: { ...streams, constants, createReadStream: (...args) => hooks.stream ? hooks.stream(...args) : streams.createReadStream(...args) } });
const { scan, backupCoverage } = await import('../src/scanners.js');
const { ZSpaceClient } = await import('../src/client.js');
const { mockNas, nasRoot, credentials } = await import('../test-support/mock-nas.js');
async function folder(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zspace-fault-')); t.after(async () => { hooks = {}; await fs.rm(root, { recursive: true, force: true }); }); return await fs.realpath(root); }

test('scanner inventory records races, unreadable directories and escaped paths', async t => {
  const root = await folder(t); await fs.mkdir(path.join(root, 'child')); await fs.writeFile(path.join(root, 'lost'), 'lost');
  hooks = { realpath: p => p.endsWith('/child') ? '/outside' : fs.realpath(p), lstat: p => p.endsWith('/lost') ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })) : fs.lstat(p) };
  const report = await scan('nas-report', root); assert.deepEqual(report.errors.map(e => e.code).sort(), ['ENOENT', 'OUTSIDE_ROOT']);
  hooks = { readdir: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) }; assert.equal((await scan('nas-report', root)).errors[0].code, 'EACCES');
  hooks = {};
  for (const options of [{ depth: -1 }, { depth: 1.5 }]) await assert.rejects(backupCoverage(root, root, options), /Invalid/);
  hooks = { lstat: async p => { const s = await fs.lstat(p); return p.endsWith('/lost') ? { ...s, isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false } : s; } };
  assert.equal((await scan('nas-report', root)).stats.totalFiles, 0);
});

test('dedup detects file replacement, truncation and mutations before and after hashing', async t => {
  const root = await folder(t); const a = path.join(root, 'a.txt'); await fs.writeFile(a, Buffer.alloc(70000, 65)); await fs.writeFile(path.join(root, 'long-name.txt'), Buffer.alloc(70000, 65));
  for (const mode of ['outside', 'size', 'mtime', 'inode', 'read', 'after-size', 'after-mtime', 'full']) {
    let opens = 0;
    hooks = {
      realpath: p => mode === 'outside' && p === a ? '/outside' : fs.realpath(p),
      open: async (...args) => {
        const fh = await fs.open(...args); if (args[0] !== a) return fh;
        const count = ++opens; let stats = 0;
        return { close: () => fh.close(), read: (...r) => mode === 'read' ? { bytesRead: 0 } : fh.read(...r), stat: async () => {
          const s = await fh.stat(); stats++;
          if (mode === 'size' || (mode === 'after-size' && stats > 1) || (mode === 'full' && count > 1)) return { ...s, size: s.size + 1 };
          if (mode === 'mtime' || (mode === 'after-mtime' && stats > 1)) return { ...s, mtimeMs: s.mtimeMs + 1 };
          if (mode === 'inode') return { ...s, ino: s.ino + 1 };
          return s;
        } };
      },
    };
    const result = await scan('dedup-finder', root); assert.equal(result.groups.length, 0, mode); assert.ok(result.errors.some(e => /escaped|changed/.test(e.reason)), mode);
  }
  hooks = {}; assert.equal((await scan('dedup-finder', root)).groups[0].keep, a);
});

test('music tags reject escaped files and report read errors', async t => {
  const root = await folder(t); const file = path.join(root, 'song.mp3'); await fs.writeFile(file, 'not ID3');
  hooks = { realpath: p => p === file ? '/outside' : fs.realpath(p) }; assert.match((await scan('music-organizer', root)).errors[0].reason, /escaped/);
  hooks = { open: () => Promise.reject(new Error('read denied')) }; assert.equal((await scan('music-organizer', root)).errors[0].reason, 'read denied');
});

test('upload read errors and truncated slice sources reject without reporting success', async t => {
  const nas = await mockNas(t); t.after(() => { hooks = {}; }); const file = path.join(nas.directory, 'source'); await fs.writeFile(file, 'content');
  const client = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, allowWrites: true });
  hooks = { stream: () => { const stream = new PassThrough(); setImmediate(() => stream.destroy(new Error('failed read'))); return stream; } };
  await assert.rejects(client.upload(file, nasRoot), /Cannot reach/);
  hooks = { open: async (...args) => { const fh = await fs.open(...args); return { read: async () => ({ bytesRead: 0 }), close: () => fh.close() }; } };
  const sliced = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, allowWrites: true, sliceThreshold: 1 });
  await assert.rejects(sliced.upload(file, nasRoot), /source changed/);
});

test('network errors, timeouts and chunked downloads clean up temporary files', async t => {
  const nas = await mockNas(t); t.after(() => { hooks = {}; });
  nas.override((_, res) => { res.socket.destroy(); return true; });
  const client = new ZSpaceClient({ credentials, baseUrl: nas.baseUrl, retries: 0, timeout: 20 });
  await assert.rejects(client.info(`${nasRoot}/a.txt`), /Cannot reach/);
  nas.override(() => true); await assert.rejects(client.info(`${nasRoot}/a.txt`), /timed out/);
  nas.override((_, res) => { res.setHeader('Transfer-Encoding', 'chunked'); res.end('body'); return true; });
  const result = await client.download(`${nasRoot}/chunked`, nas.directory); assert.equal(result.size, 4);
  nas.override((_, res) => { res.statusCode = 404; res.end(); return true; });
  await assert.rejects(client.download(`${nasRoot}/notfound`, nas.directory), /404/);
  hooks = { open: () => Promise.reject(new Error('cannot create temporary file')) }; await assert.rejects(client.download(`${nasRoot}/open-failure`, nas.directory), /cannot create/);
  hooks = { unlink: p => Promise.reject(Object.assign(new Error('cleanup denied'), { code: 'EACCES' })) }; await assert.rejects(client.download(`${nasRoot}/cleanup`, nas.directory), /cleanup denied/);
  hooks = {};
});

test('download rejects a proxy stream with an inconsistent declared length', async t => {
  const root = await folder(t);
  t.mock.method(http, 'request', (_url, _options, callback) => {
    const req = new PassThrough(); req.setTimeout = () => req;
    req.on('finish', () => { const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-length': '10' }; callback(res); res.end('short'); });
    return req;
  });
  const client = new ZSpaceClient({ credentials }); await assert.rejects(client.download(`${nasRoot}/incomplete`, root), /Incomplete download/);
  assert.deepEqual(await fs.readdir(root), []);
});
