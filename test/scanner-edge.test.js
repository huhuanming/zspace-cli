import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { scan, diffReports, backupCoverage } from '../src/scanners.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zspace-scan-edge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, content = name, days = 0) => {
    const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
    if (days) { const date = new Date(Date.now() - days * 86400000); await utimes(file, date, date); }
    return file;
  };
  return { root, put };
}
const syncsafe = n => Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
function id3(frames, version = 3, flags = 0) {
  const body = Buffer.concat(frames.map(([id, payload, frameFlags = 0]) => {
    const h = Buffer.alloc(10); h.write(id); (version === 4 ? syncsafe(payload.length) : Buffer.from([0, 0, 0, payload.length])).copy(h, 4); h[9] = frameFlags;
    return Buffer.concat([h, payload]);
  }));
  return Buffer.concat([Buffer.from([73, 68, 51, version, 0, flags]), syncsafe(body.length), body]);
}
const utf8 = s => Buffer.concat([Buffer.from([3]), Buffer.from(s)]);

test('scanner limits, categories, dates, layouts and issue selection', async t => {
  const { root, put } = await fixture(t);
  await put('.git/ignored', 'ignored'); await put('text.txt', 'x', 40); await put('old.pdf', 'x', 400); await put('ancient.docx', 'x', 1200);
  await put('photo_20260230.jpg'); await put('photo_20269999.jpg'); await put('screenshot.png'); await put('wx20261008.jpg');
  await put('.DS_Store'); await put('a.torrent'); await put('old.dmg', 'x', 400); await put('a.zip'); await put('~$lock.docx');
  await put('project/a.psd'); await put('project/README.md'); await put('project/cover.png'); await put('project/final.txt');
  await put('loose.psd'); await put('keep/inside.txt'); await put('unrelated/inside.docx'); await put('文档/already.docx');
  await put('dated_20261008.pdf');
  for (const [key, value] of [['depth', -1], ['top', 1.5], ['largeGb', -1], ['onlyCategories', 'doc'], ['onlyCategories', ['no']], ['keep', 'dir'], ['keep', [1]], ['layout', 'bad'], ['naming', 'bad']]) await assert.rejects(scan('nas-report', root, { [key]: value }), /Invalid/);
  await assert.rejects(scan('bad', root), /Unknown/); await assert.rejects(scan('nas-report', path.join(root, 'text.txt')), /directory/);
  for (const opts of [{ depth: 0 }, { sample: 1 }, { maxFiles: 0, sample: 1 }]) assert.equal((await scan('nas-report', root, opts)).stats.truncated, true);
  const report = await scan('nas-report', root, { maxFiles: 0 });
  assert.deepEqual(Object.keys(report.stats.byGrowth).sort(), ['cold_3y', 'cold_3y+', 'hot_30d', 'warm_1y']);
  assert.equal(report.stats.totalFiles, 21);
  for (const layout of ['type-year', 'year-type', 'type']) {
    const result = await scan('file-sorter', root, { layout, naming: 'en', dest: path.join(root, 'dest'), keep: ['keep'], onlyCategories: [] });
    assert.ok(result.issues.some(i => i.path.endsWith('text.txt'))); assert.ok(!result.issues.some(i => i.path.includes('/keep/')));
  }
  const sorted = await scan('file-sorter', root, { strict: true, splitProjectDirs: true, naming: 'zh' });
  assert.ok(!sorted.issues.some(i => i.path.endsWith('文档/already.docx')));
  const photo = await scan('photo-organizer', root); assert.ok(photo.issues.some(i => i.source === 'mtime')); assert.ok(photo.issues.some(i => i.target.includes('Screenshots'))); assert.ok(photo.issues.some(i => i.target.includes('WeChat')));
  const work = await scan('work-organizer', root, { archiveYears: 1, strictNaming: true }); assert.ok(work.issues.some(i => i.kind === 'lock-file')); assert.ok(work.issues.some(i => i.kind === 'archive')); assert.ok(!work.issues.some(i => i.path.endsWith('unrelated/inside.docx') && i.kind === 'loose-document'));
  const portfolio = await scan('portfolio-organizer', root, { largeGb: 0 }); assert.ok(portfolio.issues.some(i => i.kind === 'large-source')); assert.ok(portfolio.issues.some(i => i.kind === 'loose-source')); assert.ok(!portfolio.issues.some(i => i.path.endsWith('/project') && i.kind.startsWith('missing-')));
  const cleaner = await scan('download-cleaner', root, { maxIssues: 1 }); assert.equal(cleaner.issuesTruncated, true);
  const all = await scan('download-cleaner', root, { maxIssues: 0 }); for (const kind of ['system-junk', 'torrent', 'stale-installer', 'archive', 'unfiled-media-document']) assert.ok(all.issues.some(i => i.kind === kind));
});

test('ID3 v3/v4 text encodings, malformed frames and bounded tag reads', async t => {
  const { root, put } = await fixture(t);
  const be = s => Buffer.from(s, 'utf16le').swap16();
  const frames = [['TPE1', Buffer.concat([Buffer.from([1, 255, 254]), Buffer.from(' Artist ', 'utf16le')])], ['TALB', Buffer.concat([Buffer.from([2]), be('Album')])], ['TIT2', Buffer.concat([Buffer.from([1, 254, 255]), be('Title')])], ['TRCK', Buffer.from([0, 120])], ['TYER', Buffer.from([9, 1])], ['TDRC', Buffer.from([2, 1])], ['ZZZZ', utf8('ignored')], ['TPE1', utf8('ignored'), 1]];
  await put('encodings.mp3', id3(frames, 4)); await put('cover.jpg');
  await put('blank.mp3', id3([['TPE1', utf8('A')], ['TALB', utf8('B')], ['TIT2', utf8('   ')]]));
  await put('no-title.mp3', id3([['TPE1', utf8('A')], ['TALB', utf8('B')]]));
  await put('invalid-version.mp3', id3([], 2)); await put('flags.mp3', id3([], 3, 1));
  await put('oversize.mp3', Buffer.concat([Buffer.from([73, 68, 51, 3, 0, 0]), syncsafe(1024 * 1024 + 1)]));
  await put('zero-frame.mp3', id3([['TPE1', Buffer.alloc(0)]]));
  await put('invalid-id.mp3', id3([['!!!!', utf8('bad')]]));
  const truncated = id3([['TPE1', utf8('bad')]]); truncated[17] = 127; await put('truncated.mp3', truncated);
  const result = await scan('music-organizer', root);
  assert.ok(result.issues.some(i => i.target?.endsWith('Artist/Album/Title.mp3'))); assert.ok(result.issues.some(i => i.target?.endsWith('A/B/Unknown.mp3'))); assert.ok(result.issues.some(i => i.target?.endsWith('A/B/no-title.mp3')));
  assert.ok(!result.issues.some(i => i.kind === 'missing-cover'));
  for (const options of [{ readTags: false }, { tagLimit: 0 }]) assert.ok((await scan('music-organizer', root, options)).issues.every(i => i.kind === 'missing-tags'));
});

test('backup rotation, stale copies, report validation and reversed intervals', async t => {
  const { root, put } = await fixture(t);
  await put('backup_2026-01-01.bak', 'same', 50); await put('backup_2026-01-02.bak', 'same', 40);
  const report = await scan('backup-auditor', root, { keepVersions: 1 }); assert.equal(report.sets[0].versions, 2); assert.equal(report.sets[0].rotationCandidates.length, 1); assert.ok(report.issues.some(i => i.kind === 'stale-backup'));
  await put('source/a', 'same'); await put('backup/a', 'same', 40); await put('source/b', 'unchanged'); await put('backup/b', 'unchanged');
  const coverage = await backupCoverage(path.join(root, 'source'), path.join(root, 'backup'), { staleDays: 1 }); assert.deepEqual(coverage.changed, ['a']); assert.deepEqual(coverage.stale, ['a']);
  const empty = { root, skill: 'nas-report', generatedAt: '2026-01-01', stats: { totalSizeBytes: 0, totalFiles: 0, byCategory: { old: { size: 3, count: 1 } } } };
  const current = { ...empty, generatedAt: '2026-01-02', stats: { totalSizeBytes: 4, totalFiles: 2, byCategory: { new: { size: 4, count: 2 } } } };
  assert.equal(diffReports(empty, current).etaDays, null); assert.deepEqual(diffReports(empty, current).byCategory.old, { bytesAdded: -3, filesAdded: -1 });
  assert.equal(diffReports(empty, empty, { capacityGb: 1 }).growthBytesPerDay, null); assert.equal(diffReports(current, empty).timeReversed, true);
  for (const invalid of [{ generatedAt: 'bad' }, { root: '/other' }, { skill: 'bad' }]) assert.throws(() => diffReports(empty, { ...current, ...invalid }), /Reports/);
  assert.throws(() => diffReports({ ...empty, skill: 'bad' }, current), /Reports/);
  for (const capacityGb of [NaN, 0]) assert.throws(() => diffReports(empty, current, { capacityGb }), /positive/);
});
