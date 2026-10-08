import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import report from '../scripts/coverage-report.mjs';

test('coverage gate rejects missing files and exact counts below 100%', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zspace-gate-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true }); await mkdir(path.join(root, 'bin'));
  const files = ['src/a.js', 'src/nested/b.js', 'bin/main.js']; for (const f of files) await writeFile(path.join(root, f), 'fixture');
  const summary = { workingDirectory: root, files: files.map(f => ({ path: path.join(root, f), coveredLineCount: 1, totalLineCount: 1, coveredBranchCount: 1, totalBranchCount: 1, coveredFunctionCount: 1, totalFunctionCount: 1 })) };
  const run = async value => { for await (const _ of report([{ type: 'test:pass' }, { type: 'test:coverage', data: { summary: value } }])) {} };
  await run(summary);
  await assert.rejects(run({ ...summary, files: summary.files.slice(0, 2) }), /Unmeasured/);
  for (const kind of ['Line', 'Branch', 'Function']) {
    const incomplete = structuredClone(summary); incomplete.files[0][`covered${kind}Count`] = 0;
    await assert.rejects(run(incomplete), /exactly 100%/);
  }
});
