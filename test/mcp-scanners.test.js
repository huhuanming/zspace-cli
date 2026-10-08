import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, serveMcp } from '../src/mcp.js';
import { scan, scannerNames, backupCoverage, diffReports } from '../src/scanners.js';
import { installSkills } from '../src/skills.js';
import pkg from '../package.json' with { type: 'json' };

const credentials = { token: 'fake-test-token', nasId: 'fake-nas' };
const request = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
async function initialize(handler) {
  await handler(request('initialize', { protocolVersion: '2025-11-25' }));
  await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
async function folder(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zspace-scan-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('MCP handshake, schema validation and tool capability gates', async () => {
  const handler = createMcpHandler({ credentials });
  assert.equal((await handler(request('tools/list'))).error.code, -32000);
  await initialize(handler);
  const names = (await handler(request('tools/list'))).result.tools.map(t => t.name);
  assert.equal(names.length, 15); assert.ok(!names.includes('zspace_remove'));
  assert.equal((await handler(request('tools/call', { name: 'zspace_remove', arguments: { paths: '/sata1/my/data/a' } }))).error.code, -32602);
  assert.equal((await handler(request('tools/call', { name: 'zspace_tree', arguments: { path: '/', depth: 101 } }))).error.code, -32602);
  assert.equal((await handler(request('tools/call', { name: 'zspace_ls', arguments: { path: '/', arbitrary: 'value' } }))).error.code, -32602);
  assert.throws(() => createMcpHandler({ credentials, allowWrites: true }), /specific/);
  assert.throws(() => createMcpHandler({ credentials, allowWrites: true, root: '//' }), /specific/);
  assert.throws(() => createMcpHandler({ credentials, allowDelete: true }), /requires/);
  const full = createMcpHandler({ credentials, root: '/sata1/my/data/test', localRoot: os.tmpdir(), allowWrites: true, allowDelete: true });
  await initialize(full); assert.equal((await full(request('tools/list'))).result.tools.length, 25);
  assert.equal((await full(request('tools/call', { name: 'zspace_remove', arguments: { paths: '/sata1/my/data/other' } }))).result.isError, true);
});

test('MCP stdio stays newline JSON and returns parse errors', async () => {
  let output = '';
  const input = Readable.from([
    JSON.stringify(request('initialize', { protocolVersion: '2025-11-25' })) + '\n',
    '{bad}\n', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    JSON.stringify(request('tools/list', {}, 2)) + '\n',
  ]);
  await serveMcp({ input, output: new Writable({ write(chunk, _, cb) { output += chunk.toString(); cb(); } }), credentials });
  const messages = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 3); assert.equal(messages[1].error.code, -32700); assert.equal(messages[2].result.tools.length, 15);
});

test('all nine scanners report without changing source files', async t => {
  const root = await folder(t); await mkdir(path.join(root, 'project')); await mkdir(path.join(root, 'empty'));
  const files = { 'photo_20261008.jpg': 'image', 'report-final.docx': 'document', 'partial.part': 'partial', 'backup_2026-10-08.bak': '', 'song.mp3': 'untagged', 'project/source.psd': 'design', 'project/source.obj': 'model', 'same-a.txt': 'duplicate', 'same-b.txt': 'duplicate' };
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(root, name), data);
  await link(path.join(root, 'same-a.txt'), path.join(root, 'same-hardlink.txt'));
  await symlink(os.tmpdir(), path.join(root, 'outside'));
  const reports = {};
  for (const name of scannerNames) {
    reports[name] = await scan(name, root, { strictNaming: true });
    assert.equal(reports[name].readOnly, true); assert.equal(reports[name].stats.skippedSymlinks, 1);
    assert.equal(reports[name].stats.totalFiles, 10);
  }
  assert.equal(reports['dedup-finder'].groups.length, 1);
  assert.equal(reports['dedup-finder'].reclaimableBytes, Buffer.byteLength('duplicate'));
  assert.ok(reports['photo-organizer'].issues.some(i => i.date === '2026-10-08' && i.source === 'filename'));
  assert.ok(reports['work-organizer'].issues.some(i => i.kind === 'missing-date'));
  assert.ok(reports['music-organizer'].issues.some(i => i.kind === 'missing-tags'));
  assert.ok(reports['portfolio-organizer'].issues.some(i => i.kind === 'missing-readme'));
  assert.ok(reports['download-cleaner'].issues.some(i => i.kind === 'partial-download'));
  assert.ok(reports['backup-auditor'].issues.some(i => i.kind === 'empty-backup'));
  for (const [name, data] of Object.entries(files)) assert.equal(await readFile(path.join(root, name), 'utf8'), data);
});

test('file sorting preserves mixed projects and reports collision-free destinations', async t => {
  const root = await folder(t); await mkdir(path.join(root, 'project')); await mkdir(path.join(root, '文档'));
  for (const name of ['loose.docx', '文档/loose.docx', 'project/a.docx', 'project/b.jpg', 'project/c.mp3']) await writeFile(path.join(root, name), name);
  const report = await scan('file-sorter', root);
  assert.equal(report.issues.length, 1); assert.match(report.issues[0].target, /loose__2.docx$/);
  const filtered = await scan('file-sorter', root, { splitProjectDirs: true, onlyCategories: ['photo'] });
  assert.equal(filtered.issues.length, 1); assert.equal(filtered.issues[0].category, 'photo');
  const limited = await scan('nas-report', root, { maxFiles: 1 }); assert.equal(limited.stats.totalFiles, 1); assert.equal(limited.stats.truncated, true);
  await assert.rejects(scan('nas-report', root, { maxFiles: -1 }), /Invalid/);
  await assert.rejects(scan('nas-report', root, { largeGb: NaN }), /Invalid/);
});

test('ID3 tags produce artist/album/track targets', async t => {
  const root = await folder(t);
  const frame = (id, text) => { const body = Buffer.concat([Buffer.from([3]), Buffer.from(text)]); const header = Buffer.alloc(10); header.write(id); header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]); };
  const body = Buffer.concat([frame('TPE1', '歌手'), frame('TALB', '专辑'), frame('TIT2', '主题曲'), frame('TRCK', '2')]);
  const header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]); header[8] = (body.length >> 7) & 127; header[9] = body.length & 127;
  await writeFile(path.join(root, 'song.mp3'), Buffer.concat([header, body]));
  const report = await scan('music-organizer', root);
  assert.equal(report.issues[0].target, path.join(report.root, '歌手', '专辑', '02 - 主题曲.mp3'));
});

test('backup coverage exposes missing/changed metadata and snapshot growth', async t => {
  const root = await folder(t); const source = path.join(root, 'source'); const backup = path.join(root, 'backup');
  await mkdir(source); await mkdir(backup);
  await writeFile(path.join(source, 'a'), '123'); await writeFile(path.join(backup, 'a'), '1'); await writeFile(path.join(source, 'missing'), 'data');
  const coverage = await backupCoverage(source, backup);
  assert.deepEqual(coverage.missing, ['missing']); assert.deepEqual(coverage.changed, ['a']); assert.match(coverage.comparison, /does not verify/);
  const old = await scan('nas-report', source); old.generatedAt = '2026-10-01T00:00:00Z';
  await writeFile(path.join(source, 'new'), '1234'); const current = await scan('nas-report', source); current.generatedAt = '2026-10-03T00:00:00Z';
  const diff = diffReports(old, current, { capacityGb: 1 }); assert.equal(diff.bytesAdded, 4); assert.equal(diff.filesAdded, 1); assert.equal(diff.growthBytesPerDay, 2);
});

test('skills install selectively and never overwrite; CLI parses literal arguments', async t => {
  const root = await folder(t); const list = await installSkills(undefined, { list: true }); assert.equal(list.length, 10);
  await installSkills(root, { only: 'zspace-nas' }); assert.ok((await readFile(path.join(root, 'zspace-nas', 'SKILL.md'), 'utf8')).includes('zspace'));
  await assert.rejects(installSkills(root, { only: 'zspace-nas' }), /already exists/);
  const run = promisify(execFile);
  const bin = fileURLToPath(new URL('../bin/zspace.js', import.meta.url));
  assert.equal((await run(process.execPath, [bin, '--version'])).stdout.trim(), pkg.version);
  const report = JSON.parse((await run(process.execPath, [bin, 'scan', 'nas-report', root, '--json'])).stdout); assert.equal(report.readOnly, true);
  await assert.rejects(run(process.execPath, [bin, 'mkdir', '/sata1/my/data', 'a']), /Writes are disabled/);
});
