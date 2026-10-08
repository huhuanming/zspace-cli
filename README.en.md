# zspace-cli

[中文](README.md) | [English](README.en.md)

Manage a ZSpace NAS with Node.js: file transfers, Baidu/Quark cloud drives, download tasks, gallery search and picking results, an SDK, an MCP server, and nine read-only organization scanners.

Zero third-party dependencies, no install scripts, and no shell execution. MIT licensed; required copyright and source acknowledgments are preserved in [NOTICE](NOTICE).

## Installation and connection

Requires Node.js 22 or newer and a running ZSpace desktop client that is signed in and connected to your NAS.

```sh
npm install -g zspace-cli@0.3.0
zspace --version
zspace check
zspace pools
```

The npm package is **`zspace-cli`**; the executable is **`zspace`**. Credentials are read from the desktop client's `vuex.json` without copying or printing tokens. The default macOS configuration directory is `~/Library/Application Support/zspace`; Windows/Linux discovery is also supported. Use `--config-dir <directory>` or `ZS_CONFIG_DIR` for a custom location.

The default proxy is `http://127.0.0.1:13579`. `--base-url` / `ZS_BASE_URL` accepts only literal HTTP loopback origins (`127.0.0.1` or `[::1]`). Requests bypass environment proxies and never follow redirects.

Run `pools` to identify your storage pool. `/sata1/my/data` below is an example, not a universal path.

## Files

```sh
zspace ls /sata1/my/data --hidden --long
zspace info '/sata1/my/data/file.txt' --json
zspace find 'course' /sata1/my/data --limit 100
zspace tree /sata1/my/data --depth 3
zspace disks

zspace mkdir /sata1/my/data test --yes
zspace rename /sata1/my/data/test/a.txt b.txt --yes
zspace cp '/sata1/my/data/test/*.txt' /sata1/my/data/copies --yes
zspace mv /sata1/my/data/test/b.txt /sata1/my/data/copies --yes
zspace up ./example.txt /sata1/my/data/test --yes
zspace down '/sata1/my/data/test/*.txt' ./downloads
zspace rm '/sata1/my/data/test/*.txt' --yes --allow-delete
```

NAS writes require `--yes`; deletion also requires `--allow-delete`. Use `--root /sata1/my/data/test` to restrict remote paths and `--local-root /absolute/local/dir` to restrict upload sources and local download destinations. Path traversal and renaming, moving, or deleting a protected storage/allowed root are rejected.

Globs support `*`, `?`, character classes, and `**`; quote them in your shell. Directory listings paginate automatically. `find` searches the NAS filename index and filters by directory; results depend on the NAS index.

Uploads stream from disk. Files larger than 64 MiB use 2 MiB slices; HTTP 413 also triggers sliced upload. Downloads use a random `0600` temporary file and commit only after completion. Existing files are rejected unless `--overwrite` explicitly replaces a regular file. Failed downloads clean up temporary files. Upload name conflicts follow NAS behavior; check `ls` / `info` first.

`--json` outputs JSON. `--output <new-file.json>` saves the result without overwriting an existing file. Arguments after `--` are treated literally.

## Cloud drives and NAS downloads

Baidu and Quark use accounts already connected in the ZSpace desktop client. Sign in there first. The CLI does not read cloud-drive passwords or install another downloader.

```sh
zspace cloud-status baidu
zspace cloud-status quark
zspace cloud-ls baidu / --page 1 --limit 100
zspace cloud-ls quark --parent-id 0 --limit 100
zspace cloud-down baidu /sata1/my/data/downloads --file-ids 123,456 --yes
zspace cloud-down quark /sata1/my/data/downloads --file-ids file-id --folder-ids folder-id --yes
zspace cloud-tasks baidu
zspace cloud-tasks quark

zspace download-add 'https://example.com/file.zip' /sata1/my/data/downloads --yes
zspace download-add 'magnet:?xt=urn:btih:...' /sata1/my/data/downloads --yes
zspace downloads --type loading --status all
zspace downloads --type complete --status all
```

The NAS destination must already exist; writes remain subject to `--root` and `--yes`. `cloud-ls` returns one page with `entries`, `hasMore`, and `cursor`. Baidu uses `--page`; Quark uses folder IDs as `--parent-id` and the returned cursor as `--cursor '{"version":"...","token":"..."}'`.

`cloud-down` transfers files/folders already stored in your cloud account. Third-party share links, extraction codes, and saving shared files are not supported. Baidu folder IDs may appear in either ID option; Quark requires separate file and folder IDs.

`download-add` delegates HTTP, HTTPS, FTP, FTPS, SFTP, magnet, or thunder links to the NAS download service. Actual support depends on the configured engine, protocol, and account privileges. Transmission may reject ordinary HTTP files; service errors are preserved. Success means task acceptance, not completed transfer. Verify task status and destination files. The CLI does not switch download engines or change settings.

## Gallery search and picking results

```sh
zspace photo-status
zspace photo-search 'children playing on a beach' --mode ai --limit 30
zspace photo-search 'invoice' --mode ocr --start 0 --limit 30
zspace photo-search '/sata1/my/data/photos/reference.jpg' --mode similar --limit 30
zspace photo-pick-types
zspace photo-picks --type 9 --start 0 --limit 30 --order desc
zspace photo-thumb '/sata1/my/data/photos/candidate.jpg' ./previews --size large
```

`ai` (default) searches image content using natural language; `ocr` searches text in images; `similar` searches using an existing absolute NAS image path. The corresponding desktop features, models, and indexes must already be available. The CLI does not change AI settings, download models, or rebuild indexes. AI search creates and polls a native transient query, with the SDK `timeout` for requests and polling waits (60 seconds by default). The native query has no independent job ID: serialize searches on the same account to avoid interference with desktop searches.

`photo-search` / `photo-picks` returns `{ entries, pageFull }`. Entries expose only ID, name, path, size, dimensions, type, and update time; face/location fields are omitted. `pageFull` means the source candidate page reached its limit, not that another page definitely exists. OCR and picking results support `--start` pagination. AI/similar search returns top candidates and requires `--start 0`. Limits are 1–1000.

Gallery queries use the account-wide index, then filter returned paths to `--root`; fewer candidates may remain after filtering. `photo-status` index counts are also account-wide. Encrypted/shared `E.` paths are omitted because they cannot be checked against a filesystem root.

Picking reads **existing native AI picking results**: `9` overall score, `1` portraits, `10` scenery, `11` suspected defects. Check `photo-pick-types` for the current desktop categories. An empty result is returned when no results exist. No picking tasks, albums, or likes are created. The ranking comes from the NAS; inspect thumbnails before claiming visual relevance or aesthetic quality.

`photo-thumb` saves an authenticated `small` / `large` preview locally. The default name is `<original-name>.thumb.jpg`; override with `--name`. It uses private atomic download output, integrity checks, remote/local path restrictions, and never overwrites. Responses must be JPEG/PNG/WebP/GIF and at most 16 MiB. No token-bearing URLs are returned. Actual image format is determined by the NAS; use `down` for the original.

## SDK

```js
import { ZSpaceClient } from 'zspace-cli';

const client = new ZSpaceClient({ root: '/sata1/my/data/courses' });
console.log(await client.ls('/sata1/my/data/courses'));

// Writes require explicit opt-in; deletion also requires allowDelete: true.
const writer = new ZSpaceClient({
  root: '/sata1/my/data/test',
  localRoot: '/absolute/local/dir',
  allowWrites: true,
});
await writer.upload('/absolute/local/dir/example.txt', '/sata1/my/data/test');
```

File methods: `check`, `poolInfo`, `diskStats`, `ls`, `info`, `search`, `tree`, `glob`, `rename`, `mkdir`, `move`, `copy`, `remove`, `upload`, `download`.

Cloud methods: `cloudStatus(provider)`, `cloudList(provider, options)`, `cloudDownload(provider, directory, { fileIds, folderIds })`, `cloudTasks(provider)`. NAS downloads: `addDownload(link, directory)`, `listDownloads(options)`.

Gallery methods: `photoStatus()`, `photoSearch(query, { mode, start, limit })`, `photoPickTypes()`, `photoPicks({ type, start, limit, order })`, `photoThumbnail(remote, directory, { name, size })`.

Other client options include `credentials`, `configDir`, `baseUrl`, `timeout`, `retries`, `sliceThreshold`, and `sliceSize`. File transfers support `onProgress(done, total)`. Read queries retry network / HTTP 429 / 5xx failures a bounded number of times. Sliced uploads may retry the same offset; other writes are never automatically replayed. No `close()` is needed.

## MCP

Add this to your MCP client's configuration:

```json
{
  "mcpServers": {
    "zspace": {
      "command": "zspace-mcp",
      "args": ["--root", "/sata1/my/data/courses"]
    }
  }
}
```

By default, 15 read tools expose connection, capacity, disks, listing, metadata, filename search, trees, cloud status/list/tasks, NAS download tasks, and gallery status/search/categories/picks. `--local-root` adds file and thumbnail downloads. `--write --root <specific-directory>` enables NAS mutations, cloud transfers, and link downloads; uploads also require a local root. Deletion additionally requires `--allow-delete`. These flags authorize the entire MCP session; there is no per-call confirmation dialog.

All 25 tools use a `zspace_` prefix: `check`, `pool_info`, `disk_stats`, `ls`, `info`, `search`, `tree`, `rename`, `mkdir`, `move`, `copy`, `remove`, `upload`, `download`, `cloud_status`, `cloud_ls`, `cloud_tasks`, `cloud_download`, `download_add`, `downloads`, `photo_status`, `photo_search`, `photo_pick_types`, `photo_picks`, `photo_thumbnail`.

stdio uses newline-delimited JSON-RPC with no stdout logging. Tool lifecycle support includes MCP 2025-11-25, 2025-06-18, 2025-03-26, and 2024-11-05.

## Organization scanners and skills

Scanners read **local directories or mounted NAS shares**. Remote `/sata1/...` API paths are not local scanner paths. Scanners generate statistics, issues, and suggestions without moving or deleting files.

```sh
zspace scan nas-report /Volumes/MyNAS --json --output ./snapshot.json
zspace scan file-sorter /Volumes/MyNAS/Downloads --layout type-year --naming en
zspace scan dedup-finder /Volumes/MyNAS --min-size 1048576
zspace diff ./old.json ./snapshot.json --capacity-gb 8000
zspace coverage /Volumes/MyNAS/work /Volumes/Backup/work
zspace skill --list
zspace skill ~/.codex/skills --only zspace-nas,nas-report
```

| Scanner | Purpose |
| --- | --- |
| `nas-report` | Categories, hot/cold data, largest files/directories, empty directories, growth snapshots |
| `file-sorter` | Type/year organization plans, category/project preservation, target conflict detection |
| `photo-organizer` | Year/month suggestions from filename dates or modification time; screenshot/messenger classification |
| `music-organizer` | Bounded ID3 parsing, artist/album/track layouts, tag/cover checks |
| `work-organizer` | Version names, lock files, scattered documents, date naming, archive checks |
| `portfolio-organizer` | Design/model project readmes, covers, deliverables, large source files |
| `download-cleaner` | Incomplete downloads, torrents, system debris, old installers, unorganized media |
| `dedup-finder` | Size → first 64 KiB → full SHA-256; duplicate hard links excluded |
| `backup-auditor` | Backup versions, stale/empty backups, retention suggestions |

Common options: `--max-depth 6`, `--max-files 100000`, `--sample 0`, `--top 10`, `--max-issues 500`, `--stale-days <days>`. Zero means unlimited for `max-files`, `sample`, and `max-issues`. Reports include `truncated` and `errors`; incomplete scans are not a basis for claiming complete cleanup.

Organization options: `--layout type|type-year|year-type`, `--naming zh|en`, `--dest <directory>`, `--keep-dir a,b`, `--strict`, `--split-project-dirs`, `--project-min-files 3`, `--only-cat photo,video`. Other options: `--min-size <bytes>`, `--tag-limit 100`, `--strict-naming`, `--archive-years 3`, `--large-gb 1`, `--keep 3`.

Photo organization does not read EXIF; modification-time fallbacks require review. Music supports common ID3v2.3/v2.4 text tags; other formats/unsupported flags are reported for review. Backup coverage compares relative paths, sizes, and modification times, not file content. Organization rules use metadata and heuristics and require human review.

Skill installation never overwrites existing directories. Bundled skills include `zspace-nas` and the nine scanner guides. Only instructions are installed; no bundled scripts are executed.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run check
npm pack --dry-run
```

Tests use fake credentials, local mock HTTP servers, and Node module mocks. They cover permission boundaries, pagination, Unicode paths, retries, timeouts, interrupted streams, changing files, sliced transfers, download integrity, cloud protocols, gallery search/picks/thumbnails, CLI, MCP, and scanners. Tests do not read real accounts or contact a real NAS.

`test:coverage` requires exactly 100% line, branch, and function coverage for every production JavaScript file in `src` and `bin`. Missing files or any uncovered count fail the gate; no test dependencies are needed. Node.js 24 is recommended for coverage checks; module mocking uses an experimental Node interface. See [SECURITY.md](SECURITY.md) for security boundaries and remaining risks.

Live checks on macOS / Node.js 24 verified file operations/transfers, Baidu/Quark queries, completed Quark transfers, and HTTP download integrity. Baidu task creation/queueing was verified, but a complete transfer was not. Gallery status, OCR, AI text search, similar-image search, picking queries, and thumbnail downloads were verified; the current picking result is empty. Windows/Linux, very large files, and other client versions have not been tested on real devices.
