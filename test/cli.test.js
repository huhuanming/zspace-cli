import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mockNas, nasRoot } from '../test-support/mock-nas.js';

async function run(bin, args, input = '', env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../bin/${bin}.js`, import.meta.url)), ...args], { env: { ...process.env, ...env } });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b); child.stdin.end(input);
  const status = await new Promise(resolve => child.on('close', resolve)); return { status, stdout, stderr };
}

test('CLI routes every file operation through the mocked NAS', async t => {
  const mock = await mockNas(t);
  const base = ['--base-url', mock.baseUrl, '--config-dir', mock.directory, '--root', nasRoot];
  const cli = async (...args) => { const result = await run('zspace', [...args, ...base]); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  assert.equal(JSON.parse(await cli('check')).connected, true);
  await cli('pools'); await cli('disks'); await cli('info', `${nasRoot}/a.txt`);
  await cli('cloud-status', 'baidu'); await cli('cloud-ls', 'baidu'); await cli('cloud-ls', 'baidu', '/folder', '--page', '2', '--limit', '1');
  await cli('cloud-ls', 'quark', '--parent-id', 'folder', '--cursor', '{"version":"1","token":"next"}');
  await cli('cloud-down', 'baidu', nasRoot, '--file-ids', '123', '--yes'); await cli('cloud-down', 'quark', nasRoot, '--folder-ids', 'folder', '--yes');
  await cli('cloud-tasks', 'quark'); await cli('download-add', 'https://example.com/file', nasRoot, '--yes'); await cli('downloads'); await cli('downloads', '--type', 'complete', '--status', 'all', '--start', '1', '--limit', '1');
  assert.match(await cli('ls', nasRoot, '--long', '--hidden'), /folder/);
  assert.match(await cli('ls', nasRoot), /a.txt/);
  assert.match(await cli('tree', nasRoot, '--depth', '2'), /nested.txt/);
  assert.match(await cli('find', 'a.txt', nasRoot, '--limit', '1'), /a.txt/);
  await cli('ls', nasRoot, '--json'); await cli('tree', nasRoot, '--json'); await cli('find', 'a', nasRoot, '--json');
  await cli('mkdir', nasRoot, 'new', '--yes'); await cli('rename', `${nasRoot}/a.txt`, 'renamed.txt', '--yes');
  await cli('cp', `${nasRoot}/*.txt`, `${nasRoot}/folder`, '--yes');
  await cli('mv', `${nasRoot}/renamed.txt`, `${nasRoot}/new`, '--yes');
  const source = path.join(mock.directory, 'source'); await writeFile(source, 'upload');
  await cli('up', source, nasRoot, '--name', 'uploaded.txt', '--yes');
  const downloads = path.join(mock.directory, 'downloads');
  await cli('down', `${nasRoot}/uploaded.txt`, downloads);
  await cli('down', `${nasRoot}/uploaded.txt`, downloads, '--overwrite');
  assert.equal(await readFile(path.join(downloads, 'uploaded.txt'), 'utf8'), 'upload');
  await cli('rm', `${nasRoot}/uploaded.txt`, '--yes', '--allow-delete');
  const output = path.join(mock.directory, 'result.json'); await cli('pools', '--output', output); assert.ok(JSON.parse(await readFile(output, 'utf8')));
  mock.override((_, res) => { res.statusCode = 403; res.end(); return true; });
  const failed = await run('zspace', ['check', ...base]); assert.equal(failed.status, 1); assert.equal(JSON.parse(failed.stdout).connected, false);
});

test('CLI local reports, argument boundaries and MCP executable', async t => {
  const mock = await mockNas(t); const scanDir = path.join(mock.directory, 'scan'); await mkdir(scanDir); await writeFile(path.join(scanDir, 'a.txt'), 'fixture');
  const success = async args => { const result = await run('zspace', args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  await success([]); await success(['--help']); await success(['--version']);
  await success(['skill', '--list']); await success(['skill', path.join(mock.directory, 'skills'), '--only', 'nas-report']);
  const old = JSON.parse(await success(['scan', 'nas-report', scanDir, '--json'])); old.generatedAt = '2026-01-01T00:00:00Z';
  const current = structuredClone(old); current.generatedAt = '2026-01-03T00:00:00Z'; current.stats.totalSizeBytes += 2;
  const older = path.join(mock.directory, 'old.json'), newer = path.join(mock.directory, 'new.json'); await writeFile(older, JSON.stringify(old)); await writeFile(newer, JSON.stringify(current));
  await success(['diff', older, newer]); await success(['diff', older, newer, '--capacity-gb', '100']);
  await success(['coverage', scanDir, scanDir, '--stale-days', '10', '--max-depth', '0']);
  await success(['scan', 'file-sorter', scanDir, '--layout', 'year-type', '--naming', 'en', '--dest', scanDir, '--keep-dir', 'project', '--keep', '2', '--max-issues', '0', '--top', '1', '--max-files', '10', '--sample', '10', '--min-size', '0', '--tag-limit', '0', '--archive-years', '3', '--strict-naming', '--large-gb', '2', '--only-cat', 'text', '--project-min-files', '1', '--strict', '--split-project-dirs', '--read-tags']);
  await success(['scan', 'backup-auditor', scanDir]); await success(['scan', 'download-cleaner', scanDir]);
  for (const args of [['unknown'], ['info'], ['--bad'], ['ls', '--depth'], ['ls', '--json=false'], ['ls', '--depth', '--json'], ['tree', '--depth', '-1']]) assert.equal((await run('zspace', args)).status, 1);
  assert.equal((await run('zspace-mcp', ['--help'])).status, 0);
  assert.equal((await run('zspace-mcp', ['unexpected'])).status, 1);
  assert.equal((await run('zspace-mcp', ['--bad'])).status, 1);
  const messages = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }];
  const mcp = await run('zspace-mcp', [], messages.map(m => JSON.stringify(m)).join('\n') + '\n'); assert.equal(mcp.status, 0); assert.equal(JSON.parse(mcp.stdout.trim().split('\n')[1]).result.tools.length, 11);
});
