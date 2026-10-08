import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { loadCredentials, validateCredentials } from '../src/auth.js';

test('desktop credential discovery across platforms and invalid login states', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zspace-auth-'));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const saved = Object.fromEntries(['APPDATA', 'LOCALAPPDATA', 'ZS_CONFIG_DIR'].map(k => [k, process.env[k]]));
  t.after(async () => {
    Object.defineProperty(process, 'platform', platform);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(os, 'homedir', () => root);
  delete process.env.ZS_CONFIG_DIR;
  const setPlatform = value => Object.defineProperty(process, 'platform', { value });
  const save = async dir => { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'vuex.json'), JSON.stringify({ user: { token: 'mock-token' }, nas: { nasId: 'mock-nas' } })); };
  setPlatform('darwin');
  await save(path.join(root, 'Library', 'Application Support', 'zspace'));
  assert.equal((await loadCredentials()).appVersion, '1.0');
  setPlatform('win32');
  process.env.APPDATA = path.join(root, 'missing'); process.env.LOCALAPPDATA = path.join(root, 'local');
  await save(path.join(root, 'local', 'zspace')); assert.equal((await loadCredentials()).token, 'mock-token');
  delete process.env.APPDATA; delete process.env.LOCALAPPDATA;
  await save(path.join(root, 'zspace')); assert.equal((await loadCredentials()).nasId, 'mock-nas');
  setPlatform('linux'); await save(path.join(root, '.config', 'zspace'));
  assert.equal((await loadCredentials()).device, '');
  await assert.rejects(loadCredentials(path.join(root, 'absent')), /not found/);
  const bad = path.join(root, 'bad'); await mkdir(bad);
  await writeFile(path.join(bad, 'vuex.json'), '{bad'); await assert.rejects(loadCredentials(bad), /Cannot parse/);
  await writeFile(path.join(bad, 'vuex.json'), '{}'); await assert.rejects(loadCredentials(bad), /not signed in/);
  process.env.ZS_CONFIG_DIR = path.join(root, 'zspace'); assert.equal((await loadCredentials()).nasId, 'mock-nas');
  for (const input of [undefined, {}, { token: 'x' }, { nasId: 'x' }]) assert.throws(() => validateCredentials(input), /not signed in/);
  for (const token of ['x'.repeat(8193), 'x\r\ny']) assert.throws(() => validateCredentials({ token, nasId: 'x' }), /Invalid/);
  assert.equal(validateCredentials({ token: 'x', nasId: 'y', deviceId: 123 }).deviceId, '123');
});
