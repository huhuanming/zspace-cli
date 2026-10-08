#!/usr/bin/env node
import { ZSpaceClient } from '../src/client.js';
import { parseArgs, integer } from '../src/args.js';
import { installSkills } from '../src/skills.js';
import { scan, diffReports, backupCoverage } from '../src/scanners.js';
import { readFile, writeFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const help = `zspace-cli ${pkg.version} — ZSpace NAS CLI (Node.js, no dependencies)

Usage: zspace <command> [arguments] [options]
  check                            Check connection and storage pools
  pools | disks                    Storage pool info / disk statistics
  ls [path]                        List directory (--hidden, --long)
  info <path>                      File or directory metadata
  find <keyword> [path]            Search NAS full-text index
  tree [path]                      Directory tree (--depth 2)
  rename <path> <new-name>          Rename (--yes)
  mkdir <parent> <name>            Create directory (--yes)
  mv <path-or-glob> <to>           Move (--yes)
  cp <path-or-glob> <to>           Copy (--yes)
  rm <path-or-glob>                Delete (--yes --allow-delete)
  up <local-file> <remote-dir>     Upload (--yes, --name)
  down <remote-path-or-glob> [dir] Download (--overwrite to replace files)
  cloud-status <baidu|quark>      Check the connected cloud account
  cloud-ls <baidu|quark> [path]   List cloud files (--parent-id for Quark)
  cloud-down <provider> <dir>     Download cloud files to NAS (--file-ids, --folder-ids, --yes)
  cloud-tasks <provider>          Cloud transfer task status
  download-add <link> <NAS-dir>   Add a NAS download task (--yes)
  downloads                      List NAS download tasks (--type, --status)
  photo-status                   Gallery AI/OCR settings and indexing progress
  photo-search <text-or-path>     Search image content (--mode ai|ocr|similar, --limit)
  photo-pick-types                Native picking categories
  photo-picks                     Existing AI picking results (--type 9|1|10|11)
  photo-thumb <NAS-path> [dir]    Save a thumbnail (--size small|large, --name)
  skill [dir]                     Install bundled skills (--list, --only a,b)
  scan <skill> <mounted-directory> Read-only local/NAS-share scanner
  diff <old-report> <new-report>   Compare nas-report snapshots
  coverage <source> <backup>       Backup coverage check (metadata only)

Options: --json, --root <NAS-root>, --local-root <local-root>,
         --config-dir <desktop-config-dir>, --base-url <loopback-origin>
Writes need --yes. Deletion also needs --allow-delete.
Default directory: /sata1/my/data; specify the actual path for another pool.
Scanners: nas-report, file-sorter, photo-organizer, music-organizer,
          work-organizer, portfolio-organizer, download-cleaner,
          dedup-finder, backup-auditor
MCP: zspace-mcp (read-only); enable writes with --write --root <path>.
`;

async function main(argv) {
  const { options: o, positionals: p } = parseArgs(argv);
  if (o.version) { console.log(pkg.version); return; }
  if (o.help || !p.length) { console.log(help); return; }
  const command = p.shift();
  const arities = { check: [0, 0], pools: [0, 0], disks: [0, 0], ls: [0, 1], info: [1, 1], find: [1, 2], tree: [0, 1],
    rename: [2, 2], mkdir: [2, 2], mv: [2, 2], cp: [2, 2], rm: [1, 1], up: [2, 2], down: [1, 2], skill: [0, 1], scan: [2, 2], diff: [2, 2], coverage: [2, 2],
    'cloud-status': [1, 1], 'cloud-ls': [1, 2], 'cloud-down': [2, 2], 'cloud-tasks': [1, 1], 'download-add': [2, 2], downloads: [0, 0],
    'photo-status': [0, 0], 'photo-search': [1, 1], 'photo-pick-types': [0, 0], 'photo-picks': [0, 0], 'photo-thumb': [1, 2] };
  const arity = arities[command];
  if (!arity) throw new Error(`Unknown command: ${command}`);
  if (p.length < arity[0] || p.length > arity[1]) throw new Error(`Invalid arguments for ${command}; see zspace --help`);
  let data;
  if (command === 'skill') data = await installSkills(p[0], { list: o.list, only: o.only });
  else if (command === 'scan') data = await scan(p[0], p[1], { depth: integer(o['max-depth'], 6, 'max-depth'), staleDays: integer(o['stale-days'], p[0] === 'backup-auditor' ? 35 : p[0] === 'download-cleaner' ? 365 : 1095, 'stale-days'),
    layout: o.layout ?? 'type', naming: o.naming ?? 'zh', dest: o.dest, strict: o.strict, splitProjectDirs: o['split-project-dirs'],
    keep: o['keep-dir']?.split(','), keepVersions: integer(o.keep, 3, 'keep'), maxIssues: integer(o['max-issues'], 500, 'max-issues'), top: integer(o.top, 10, 'top'),
    maxFiles: integer(o['max-files'], 100000, 'max-files'), sample: integer(o.sample, 0, 'sample'), minSize: integer(o['min-size'], 1, 'min-size'),
    readTags: o['read-tags'] ?? true, tagLimit: integer(o['tag-limit'], 100, 'tag-limit'), archiveYears: integer(o['archive-years'], 0, 'archive-years'),
    strictNaming: o['strict-naming'], largeGb: o['large-gb'] === undefined ? 1 : Number(o['large-gb']),
    onlyCategories: o['only-cat']?.split(',').map(v => v.trim()), projectMinFiles: integer(o['project-min-files'], 3, 'project-min-files') });
  else if (command === 'diff') data = diffReports(JSON.parse(await readFile(p[0], 'utf8')), JSON.parse(await readFile(p[1], 'utf8')), { capacityGb: o['capacity-gb'] === undefined ? undefined : Number(o['capacity-gb']) });
  else if (command === 'coverage') data = await backupCoverage(p[0], p[1], { depth: integer(o['max-depth'], 6, 'max-depth'), staleDays: integer(o['stale-days'], 35, 'stale-days') });
  else {
    const client = new ZSpaceClient({ configDir: o['config-dir'], baseUrl: o['base-url'], root: o.root, localRoot: o['local-root'], allowWrites: o.yes, allowDelete: o['allow-delete'] });
    switch (command) {
      case 'check': data = await client.check(); if (!data.connected) process.exitCode = 1; break;
      case 'pools': data = await client.poolInfo(); break;
      case 'disks': data = await client.diskStats(); break;
      case 'cloud-status': data = await client.cloudStatus(p[0]); break;
      case 'cloud-ls': data = await client.cloudList(p[0], { path: p[1], parentId: o['parent-id'], page: integer(o.page, 1, 'page'), limit: integer(o.limit, 100, 'limit'), cursor: o.cursor === undefined ? undefined : JSON.parse(o.cursor) }); break;
      case 'cloud-down': data = await client.cloudDownload(p[0], p[1], { fileIds: o['file-ids']?.split(','), folderIds: o['folder-ids']?.split(',') }); break;
      case 'cloud-tasks': data = await client.cloudTasks(p[0]); break;
      case 'download-add': data = await client.addDownload(p[0], p[1]); break;
      case 'downloads': data = await client.listDownloads({ type: o.type, status: o.status, start: integer(o.start, 0, 'start'), limit: integer(o.limit, 50, 'limit') }); break;
      case 'photo-status': data = await client.photoStatus(); break;
      case 'photo-search': data = await client.photoSearch(p[0], { mode: o.mode, start: integer(o.start, 0, 'start'), limit: integer(o.limit, 100, 'limit') }); break;
      case 'photo-pick-types': data = await client.photoPickTypes(); break;
      case 'photo-picks': data = await client.photoPicks({ type: integer(o.type, 9, 'type'), start: integer(o.start, 0, 'start'), limit: integer(o.limit, 100, 'limit'), order: o.order }); break;
      case 'photo-thumb': data = await client.photoThumbnail(p[0], p[1], { name: o.name, size: o.size }); break;
      case 'ls': data = await client.ls(p[0], { hidden: o.hidden }); break;
      case 'info': data = await client.info(p[0]); break;
      case 'find': data = await client.search(p[0], p[1], { limit: integer(o.limit, 100, 'limit') }); break;
      case 'tree': data = await client.tree(p[0], { depth: integer(o.depth, 2, 'depth'), hidden: o.hidden }); break;
      case 'rename': data = await client.rename(p[0], p[1]); break;
      case 'mkdir': data = await client.mkdir(p[0], p[1]); break;
      case 'mv': data = await client.move(await client.glob(p[0]), p[1]); break;
      case 'cp': data = await client.copy(await client.glob(p[0]), p[1]); break;
      case 'rm': data = await client.remove(await client.glob(p[0])); break;
      case 'up': data = await client.upload(p[0], p[1], { name: o.name }); break;
      case 'down': data = []; for (const file of await client.glob(p[0])) data.push(await client.download(file, p[1], { overwrite: o.overwrite })); break;
    }
  }
  if (o.output) await writeFile(o.output, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (o.json || !Array.isArray(data) || command === 'photo-pick-types') console.log(JSON.stringify(data, null, 2));
  else for (const row of data) console.log(typeof row === 'string' ? row : command === 'tree'
    ? `${'  '.repeat(row.depth)}${row.isDir ? '📁' : '📄'} ${row.name}`
    : `${row.isDir ? 'DIR ' : 'FILE'} ${String(row.size).padStart(12)} ${o.long ? row.path : row.name}`);
}

// User-controlled names are printed as data; no shell or source-code interpolation.
main(process.argv.slice(2)).catch(e => { console.error(e.message.replace(/[\x00-\x1f\x7f]/g, ' ')); process.exitCode = 1; });
