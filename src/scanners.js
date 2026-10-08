import path from 'node:path';
import { readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { inside } from './safety.js';

export const scannerNames = ['nas-report', 'file-sorter', 'photo-organizer', 'music-organizer', 'work-organizer', 'portfolio-organizer', 'download-cleaner', 'dedup-finder', 'backup-auditor'];
const skip = new Set(['.git', 'node_modules', '@eaDir', '#recycle', '#@__recycle_bin', '.Trashes', '.Spotlight-V100', '.fseventsd', '.snapshots', '.zspace_trash', '.trash', '.cache', 'lost+found', 'System Volume Information', '$RECYCLE.BIN']);
const categories = {
  cad: ['dwg', 'dxf', 'dwf', 'dgn', 'ifc', 'step', 'stp', 'iges', 'igs'],
  design: ['psd', 'psb', 'ai', 'sketch', 'fig', 'afdesign', 'afphoto', 'indd'],
  model: ['blend', 'fbx', 'obj', 'stl', '3ds', 'c4d', 'max'],
  doc: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'rtf', 'csv'],
  pdf: ['pdf', 'epub', 'mobi', 'azw3'],
  text: ['txt', 'md', 'rst', 'log'],
  data: ['json', 'yaml', 'yml', 'xml', 'sql', 'db', 'sqlite', 'parquet'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'kt', 'swift', 'rb', 'php', 'html', 'css', 'sh'],
  photo: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'svg'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'wmv', 'webm', 'm4v', 'mpg', 'mpeg', 'flv', 'mts', 'm2ts'],
  audio: ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'aiff', 'wma', 'alac'],
  archive: ['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz', 'zst'],
  installer: ['dmg', 'pkg', 'exe', 'msi', 'apk', 'deb', 'rpm'],
  font: ['ttf', 'otf', 'woff', 'woff2'],
  backup: ['bak', 'backup', 'tib', 'vhd', 'vhdx', 'vmdk', 'ova', 'iso', 'img', 'sparsebundle'],
};
const labels = { cad: '图纸', design: '设计源文件', model: '三维模型', doc: '文档', pdf: '书籍PDF', text: '文本', data: '数据', code: '代码', photo: '图片', video: '视频', audio: '音频', archive: '压缩包', installer: '安装包', font: '字体', backup: '备份', other: '其他' };
const extMap = new Map(Object.entries(categories).flatMap(([k, extensions]) => extensions.map(e => [e, k])));
const junkNames = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const partialExtensions = new Set(['part', 'crdownload', 'aria2', 'tmp', 'temp', 'swp', 'swo', 'download', 'td']);
const safeName = s => String(s).replace(/[/\\\x00-\x1f\x7f]/g, '_').trim() || 'Unknown';
export const categorize = name => extMap.get(path.extname(name).slice(1).toLowerCase()) ?? 'other';

async function inventory(root, { depth = 6, maxFiles = 100000, sample = 0 } = {}) {
  for (const [key, value] of Object.entries({ depth, maxFiles, sample })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${key}`);
  }
  const base = await realpath(path.resolve(root));
  if (!(await lstat(base)).isDirectory()) throw new Error('Scanner root must be a directory');
  const files = []; const dirs = []; const errors = []; let truncated = false; let symlinks = 0;
  const walk = async (folder, level) => {
    let entries;
    try {
      if (!inside(await realpath(folder), base)) throw Object.assign(new Error('Directory escaped scanner root'), { code: 'OUTSIDE_ROOT' });
      entries = await readdir(folder, { withFileTypes: true });
    }
    catch (e) { errors.push({ path: folder, code: e.code }); return; }
    dirs.push({ path: folder, empty: entries.length === 0 });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(entry.name)) continue;
      const full = path.join(folder, entry.name);
      let info;
      try { info = await lstat(full); } catch (e) { errors.push({ path: full, code: e.code }); continue; }
      if (info.isSymbolicLink()) { symlinks++; continue; }
      if (info.isDirectory()) { if (level < depth) await walk(full, level + 1); else truncated = true; }
      else if (info.isFile()) {
        if ((maxFiles && files.length >= maxFiles) || (sample && files.length >= sample)) { truncated = true; return; }
        files.push({ path: full, name: entry.name, relative: path.relative(base, full), size: info.size,
          mtimeMs: info.mtimeMs, modifiedAt: info.mtime.toISOString(), category: categorize(entry.name),
          ageDays: (Date.now() - info.mtimeMs) / 86400000, inode: `${info.dev}:${info.ino}` });
      }
    }
  };
  await walk(base, 0); return { root: base, files, dirs, errors, truncated, symlinks };
}

async function fingerprint(file, root, headOnly = false) {
  if (!inside(await realpath(file.path), root)) throw new Error('File escaped scanner root');
  const fh = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await fh.stat();
    if (before.size !== file.size || before.mtimeMs !== file.mtimeMs || `${before.dev}:${before.ino}` !== file.inode) throw new Error('File changed during scan');
    const hash = createHash('sha256'); const block = Buffer.alloc(1024 * 1024); let offset = 0;
    while (offset < Math.min(file.size, headOnly ? 65536 : Infinity)) {
      const length = Math.min(block.length, file.size - offset, headOnly ? 65536 - offset : Infinity);
      const { bytesRead } = await fh.read(block, 0, length, offset);
      if (!bytesRead) throw new Error('File changed during hashing');
      hash.update(block.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await fh.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('File changed during hashing');
    return hash.digest('hex');
  } finally { await fh.close(); }
}

function groupsBy(values, key) {
  const groups = new Map();
  for (const value of values) { const k = key(value); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(value); }
  return [...groups.values()];
}

async function duplicates(data, minSize = 1) {
  const candidates = groupsBy(data.files.filter(f => f.size >= minSize), f => f.size).filter(g => g.length > 1);
  const result = [];
  for (const group of candidates) {
    const uniqueInodes = new Set(); const heads = [];
    for (const file of group) {
      if (uniqueInodes.has(file.inode)) continue;
      uniqueInodes.add(file.inode);
      try { heads.push({ ...file, head: await fingerprint(file, data.root, true) }); }
      catch (e) { data.errors.push({ path: file.path, reason: e.message }); }
    }
    for (const headGroup of groupsBy(heads, f => f.head).filter(g => g.length > 1)) {
      const full = [];
      for (const file of headGroup) {
        try { full.push({ ...file, sha256: await fingerprint(file, data.root) }); }
        catch (e) { data.errors.push({ path: file.path, reason: e.message }); }
      }
      for (const match of groupsBy(full, f => f.sha256).filter(g => g.length > 1)) {
        match.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
        result.push({ sha256: match[0].sha256, size: match[0].size, keep: match[0].path, duplicates: match.slice(1).map(f => f.path), reclaimableBytes: (match.length - 1) * match[0].size });
      }
    }
  }
  return result;
}

async function musicTags(file, root) {
  if (!inside(await realpath(file), root)) throw new Error('File escaped scanner root');
  const fh = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const header = Buffer.alloc(10); await fh.read(header, 0, 10, 0);
    if (header.toString('ascii', 0, 3) !== 'ID3') return {};
    const version = header[3]; if (![3, 4].includes(version) || header[5] !== 0) return {};
    const synchsafe = b => b.reduce((n, v) => n * 128 + (v & 0x7f), 0);
    const size = synchsafe(header.subarray(6, 10)); if (size > 1024 * 1024) return {};
    const buffer = Buffer.alloc(size); const { bytesRead } = await fh.read(buffer, 0, size, 10);
    const mapping = { TPE1: 'artist', TALB: 'album', TIT2: 'title', TRCK: 'track', TYER: 'year', TDRC: 'year' }; const tags = {};
    for (let offset = 0; offset + 10 <= bytesRead;) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const length = version === 4 ? synchsafe(buffer.subarray(offset + 4, offset + 8)) : buffer.readUInt32BE(offset + 4);
      if (!/^[A-Z0-9]{4}$/.test(id) || !length || offset + 10 + length > bytesRead) break;
      if (mapping[id] && buffer[offset + 8] === 0 && buffer[offset + 9] === 0) {
        const frame = buffer.subarray(offset + 10, offset + 10 + length); const encoding = frame[0]; let value;
        if (encoding === 0) value = frame.subarray(1).toString('latin1');
        else if (encoding === 3) value = frame.subarray(1).toString('utf8');
        else if (encoding === 1 && frame[1] === 0xff && frame[2] === 0xfe) value = frame.subarray(3).toString('utf16le');
        else if (encoding === 1 || encoding === 2) {
          const start = encoding === 1 ? 3 : 1; const bytes = Buffer.from(frame.subarray(start));
          if (bytes.length % 2 === 0) value = bytes.swap16().toString('utf16le');
        }
        if (value) tags[mapping[id]] = value.replace(/\0/g, '').trim();
      }
      offset += 10 + length;
    }
    return tags;
  } finally { await fh.close(); }
}

function photoDate(file) {
  const match = file.name.match(/(?:19|20)\d{2}[-_]?\d{2}[-_]?\d{2}/);
  if (match) {
    const digits = match[0].replace(/[-_]/g, ''); const iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if (!Number.isNaN(Date.parse(iso)) && new Date(iso).toISOString().startsWith(iso)) return { date: iso, source: 'filename' };
  }
  return { date: file.modifiedAt.slice(0, 10), source: 'mtime', review: true };
}

export async function scan(skill, root, options = {}) {
  if (!scannerNames.includes(skill)) throw new Error('Unknown scanner');
  const o = { depth: 6, staleDays: skill === 'backup-auditor' ? 35 : skill === 'download-cleaner' ? 365 : 1095,
    top: 10, maxIssues: 500, keepVersions: 3, maxFiles: 100000, sample: 0, minSize: 1,
    tagLimit: 100, archiveYears: 0, largeGb: 1, projectMinFiles: 3, ...options };
  for (const key of ['depth', 'staleDays', 'top', 'maxIssues', 'keepVersions', 'maxFiles', 'sample', 'minSize', 'tagLimit', 'archiveYears', 'projectMinFiles']) {
    if (!Number.isSafeInteger(o[key]) || o[key] < 0) throw new Error(`Invalid ${key}`);
  }
  if (!Number.isFinite(o.largeGb) || o.largeGb < 0) throw new Error('Invalid largeGb');
  if (o.onlyCategories && (!Array.isArray(o.onlyCategories) || o.onlyCategories.some(c => ![...Object.keys(categories), 'other'].includes(c)))) throw new Error('Invalid onlyCategories');
  if (o.keep && (!Array.isArray(o.keep) || o.keep.some(v => typeof v !== 'string'))) throw new Error('Invalid keep');
  if (!['type', 'type-year', 'year-type'].includes(o.layout ?? 'type') || !['zh', 'en'].includes(o.naming ?? 'zh')) throw new Error('Invalid layout or naming');
  const data = await inventory(root, { depth: o.depth, maxFiles: o.maxFiles, sample: o.sample });
  const byCategory = {}; const byGrowth = {}; const byDirectory = {};
  for (const f of data.files) {
    byCategory[f.category] ??= { count: 0, size: 0 }; byCategory[f.category].count++; byCategory[f.category].size += f.size;
    const growth = f.ageDays < 30 ? 'hot_30d' : f.ageDays < 365 ? 'warm_1y' : f.ageDays < 1095 ? 'cold_3y' : 'cold_3y+';
    byGrowth[growth] ??= { count: 0, size: 0 }; byGrowth[growth].count++; byGrowth[growth].size += f.size;
    const dir = path.dirname(f.path); byDirectory[dir] = (byDirectory[dir] ?? 0) + f.size;
  }
  const report = { skill, root: data.root, generatedAt: new Date().toISOString(), readOnly: true,
    stats: { totalFiles: data.files.length, totalDirs: data.dirs.length, totalSizeBytes: data.files.reduce((n, f) => n + f.size, 0),
      byCategory, byGrowth, rootFiles: data.files.filter(f => path.dirname(f.path) === data.root).length,
      emptyDirs: data.dirs.filter(d => d.empty).length, skippedSymlinks: data.symlinks, truncated: data.truncated,
      largestFiles: [...data.files].sort((a, b) => b.size - a.size).slice(0, o.top).map(({ path, size, category }) => ({ path, size, category })),
      largestDirs: Object.entries(byDirectory).sort((a, b) => b[1] - a[1]).slice(0, o.top).map(([path, size]) => ({ path, size })) }, issues: [], errors: data.errors };
  const issue = (kind, file, extra = {}) => report.issues.push({ kind, path: file.path, ...extra });
  const occupied = new Set(data.files.map(f => f.path));
  const target = wanted => { let p = wanted; let count = 1; while (occupied.has(p)) { const ext = path.extname(wanted); p = `${wanted.slice(0, wanted.length - ext.length)}__${++count}${ext}`; } occupied.add(p); return p; };
  if (skill === 'nas-report') report.recommendations = Object.entries(byCategory).sort((a, b) => b[1].size - a[1].size).map(([category]) => ({ category, skill: ({ photo: 'photo-organizer', audio: 'music-organizer', doc: 'work-organizer', design: 'portfolio-organizer', backup: 'backup-auditor' })[category] ?? 'file-sorter' }));
  if (skill === 'dedup-finder') { report.groups = await duplicates(data, o.minSize); report.reclaimableBytes = report.groups.reduce((n, g) => n + g.reclaimableBytes, 0); }
  if (skill === 'file-sorter') {
    const existingCategories = new Set([...Object.keys(categories), ...Object.values(labels), ...(o.keep ?? [])]);
    const projects = new Set(groupsBy(data.files, f => f.relative.split(path.sep)[0]).filter(g => g.length >= o.projectMinFiles && new Set(g.map(f => f.category)).size >= 2).map(g => g[0].relative.split(path.sep)[0]));
    for (const f of data.files) {
      if (o.onlyCategories?.length && !o.onlyCategories.includes(f.category)) continue;
      const first = f.relative.split(path.sep)[0]; const rootFile = path.dirname(f.path) === data.root;
      if (!rootFile && ((existingCategories.has(first) && !o.strict) || (projects.has(first) && !o.splitProjectDirs))) continue;
      const category = (o.naming ?? 'zh') === 'zh' ? labels[f.category] : f.category;
      const year = f.modifiedAt.slice(0, 4); const folders = o.layout === 'year-type' ? [year, category] : o.layout === 'type-year' ? [category, year] : [category];
      const destination = path.resolve(o.dest ?? data.root, ...folders, f.name);
      if (destination !== f.path) issue('move', f, { target: target(destination), category: f.category });
    }
  }
  if (skill === 'photo-organizer') for (const f of data.files.filter(f => ['photo', 'video'].includes(f.category))) {
    const date = photoDate(f); const special = /screenshot|截屏|截图/i.test(f.name) ? 'Screenshots' : /^(wx|mmexport|wechat)|微信/i.test(f.name) ? 'WeChat' : 'Photos';
    const destination = path.join(data.root, special, date.date.slice(0, 4), date.date.slice(5, 7), f.name);
    if (destination !== f.path) issue('date-archive', f, { target: target(destination), ...date });
  }
  if (skill === 'music-organizer') {
    let tagReads = 0;
    for (const f of data.files.filter(f => f.category === 'audio')) {
      const tags = o.readTags === false || tagReads >= o.tagLimit ? {} : await musicTags(f.path, data.root).catch(e => { data.errors.push({ path: f.path, reason: e.message }); return {}; }); tagReads++;
      if (!tags.artist || !tags.album) issue('missing-tags', f, { tags, review: true });
      else {
        const track = /^\d+/.exec(tags.track ?? '')?.[0]; const name = `${track ? `${track.padStart(2, '0')} - ` : ''}${safeName(tags.title ?? path.basename(f.name, path.extname(f.name)))}${path.extname(f.name)}`;
        const destination = path.join(data.root, safeName(tags.artist), safeName(tags.album), name);
        if (destination !== f.path) issue('music-layout', f, { target: target(destination), tags });
      }
    }
    for (const album of groupsBy(data.files.filter(f => f.category === 'audio'), f => path.dirname(f.path))) {
      const dir = path.dirname(album[0].path);
      if (!data.files.some(f => path.dirname(f.path) === dir && /^(cover|folder|front)\.(jpg|jpeg|png|webp)$/i.test(f.name))) issue('missing-cover', { path: dir });
    }
  }
  if (skill === 'work-organizer') for (const f of data.files.filter(f => ['doc', 'pdf', 'text', 'data'].includes(f.category))) {
    if (o.strictNaming && ['doc', 'pdf'].includes(f.category) && !/(?:19|20)\d{2}[-_]?\d{2}[-_]?\d{2}/.test(f.name)) issue('missing-date', f, { review: true });
    if (/^~\$|^\.~/i.test(f.name)) issue('lock-file', f, { review: true });
    if (/最终|final|副本|copy|\(\d+\)/i.test(f.name)) issue('version-name', f, { review: true });
    if (f.ageDays > (o.archiveYears ? o.archiveYears * 365 : o.staleDays)) issue('archive', f, { target: path.join(data.root, '归档', f.modifiedAt.slice(0, 4), f.name), review: true });
    else if (path.dirname(f.path) === data.root) issue('loose-document', f, { review: true });
  }
  if (skill === 'portfolio-organizer') {
    for (const group of groupsBy(data.files.filter(f => ['design', 'model'].includes(f.category)), f => f.relative.split(path.sep)[0])) {
      const dir = path.dirname(group[0].path);
      if (dir === data.root) { for (const f of group) issue('loose-source', f, { review: true }); continue; }
      if (!data.files.some(f => path.dirname(f.path) === dir && /^readme\./i.test(f.name))) issue('missing-readme', { path: dir });
      if (!data.files.some(f => path.dirname(f.path) === dir && /cover|封面/i.test(f.name))) issue('missing-cover', { path: dir });
      if (!data.files.some(f => f.path.startsWith(`${dir}${path.sep}`) && /final|export|成品|交付/i.test(f.relative))) issue('missing-deliverables', { path: dir });
    }
    for (const f of data.files.filter(f => f.category === 'design' && f.size > o.largeGb * 1e9)) issue('large-source', f, { size: f.size });
  }
  if (skill === 'download-cleaner') for (const f of data.files) {
    const ext = path.extname(f.name).slice(1).toLowerCase();
    if (partialExtensions.has(ext)) issue('partial-download', f, { action: 'review', reason: 'Check the downloader before removing an active file' });
    else if (junkNames.has(f.name)) issue('system-junk', f, { action: 'quarantine' });
    else if (ext === 'torrent') issue('torrent', f, { action: 'review', reason: 'Check seeding status' });
    else if (f.category === 'installer' && f.ageDays > o.staleDays) issue('stale-installer', f, { action: 'review' });
    else if (f.category === 'archive') issue('archive', f, { action: 'extract-or-review' });
    else if (['video', 'audio', 'photo', 'doc', 'pdf'].includes(f.category)) issue('unfiled-media-document', f, { action: 'move-to-library' });
  }
  if (skill === 'backup-auditor') {
    const backups = data.files.filter(f => f.category === 'backup' || /backup|备份|\d{4}[-_]\d{2}[-_]\d{2}/i.test(f.relative));
    report.sets = groupsBy(backups, f => f.relative.replace(/(?:19|20)\d{2}[-_]?\d{2}[-_]?\d{2}(?:[-_]\d{2})*/g, '{date}').replace(/[_-]v\d+/gi, '{version}')).map(group => {
      group.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { name: group[0].relative, versions: group.length, newest: group[0].path, ageDays: group[0].ageDays,
        stale: group[0].ageDays > o.staleDays, rotationCandidates: group.slice(o.keepVersions).map(f => f.path) };
    });
    for (const set of report.sets) if (set.stale) issue('stale-backup', { path: set.newest }, { ageDays: set.ageDays, review: true });
    for (const f of backups) if (!f.size) issue('empty-backup', f, { review: true });
  }
  report.issueCount = report.issues.length; if (o.maxIssues) report.issues = report.issues.slice(0, o.maxIssues); report.issuesTruncated = report.issueCount > report.issues.length;
  return report;
}

export function diffReports(old, current, { capacityGb } = {}) {
  const elapsed = (Date.parse(current.generatedAt) - Date.parse(old.generatedAt)) / 86400000;
  if (!Number.isFinite(elapsed) || old.root !== current.root || old.skill !== 'nas-report' || current.skill !== 'nas-report') throw new Error('Reports must be nas-report snapshots of the same root with valid dates');
  if (capacityGb !== undefined && (!Number.isFinite(capacityGb) || capacityGb <= 0)) throw new Error('capacity-gb must be positive');
  const added = current.stats.totalSizeBytes - old.stats.totalSizeBytes;
  const growth = elapsed > 0 ? added / elapsed : null;
  return { root: current.root, intervalDays: elapsed, timeReversed: elapsed < 0, bytesAdded: added,
    filesAdded: current.stats.totalFiles - old.stats.totalFiles, growthBytesPerDay: growth,
    etaDays: capacityGb && growth > 0 ? Math.max(0, (capacityGb * 1e9 - current.stats.totalSizeBytes) / growth) : null,
    byCategory: Object.fromEntries([...new Set([...Object.keys(old.stats.byCategory), ...Object.keys(current.stats.byCategory)])].map(k => [k, {
      bytesAdded: (current.stats.byCategory[k]?.size ?? 0) - (old.stats.byCategory[k]?.size ?? 0),
      filesAdded: (current.stats.byCategory[k]?.count ?? 0) - (old.stats.byCategory[k]?.count ?? 0),
    }])) };
}

export async function backupCoverage(source, backup, options = {}) {
  const originals = await inventory(source, options); const copies = await inventory(backup, options);
  const byName = new Map(copies.files.map(f => [f.relative, f]));
  const missing = []; const changed = []; const stale = [];
  for (const f of originals.files) {
    const match = byName.get(f.relative);
    if (!match) missing.push(f.relative);
    else if (match.size !== f.size || match.mtimeMs + 2000 < f.mtimeMs) changed.push(f.relative);
    if (match && match.ageDays > (options.staleDays ?? 35)) stale.push(f.relative);
  }
  return { source: originals.root, backup: copies.root, readOnly: true, totalFiles: originals.files.length,
    missing, changed, stale, errors: [...originals.errors, ...copies.errors], truncated: originals.truncated || copies.truncated,
    comparison: 'Relative path, size and modification time; does not verify identical content' };
}
