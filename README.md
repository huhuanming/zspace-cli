# zspace-cli

[中文](README.md) | [English](README.en.md)

用 Node.js 管理极空间 NAS：文件传输、百度/夸克网盘、下载任务、图库搜索与精选，以及 SDK、MCP 和 9 个只读整理扫描器。

零第三方依赖，无安装脚本，不执行 shell。采用 MIT 许可证；必要的版权与来源声明保留在 [NOTICE](NOTICE)。

## 安装与连接

需要 Node.js 22 或更新版本；极空间桌面客户端必须启动、登录并连接 NAS。

```sh
npm install -g zspace-cli@0.3.0
zspace --version
zspace check
zspace pools
```

命令叫 **`zspace`**，npm 包叫 **`zspace-cli`**。自动读取桌面客户端的 `vuex.json` 登录状态；不会复制或打印 token。macOS 默认目录是 `~/Library/Application Support/zspace`，Windows/Linux 也提供目录探测。其他安装位置可用 `--config-dir <目录>` 或 `ZS_CONFIG_DIR` 指定。

默认只访问 `http://127.0.0.1:13579`。`--base-url` / `ZS_BASE_URL` 只能指定 HTTP 回环地址 `127.0.0.1` 或 `[::1]`，不会跟随重定向，也不会使用环境代理。

先用 `pools` 确认实际存储池；下方 `/sata1/my/data` 是示例路径。

## 文件操作

```sh
zspace ls /sata1/my/data --hidden --long
zspace info '/sata1/my/data/文件.txt' --json
zspace find '课程' /sata1/my/data --limit 100
zspace tree /sata1/my/data --depth 3
zspace disks

zspace mkdir /sata1/my/data '测试目录' --yes
zspace rename '/sata1/my/data/测试目录/a.txt' 'b.txt' --yes
zspace cp '/sata1/my/data/测试目录/*.txt' /sata1/my/data/副本 --yes
zspace mv '/sata1/my/data/测试目录/b.txt' /sata1/my/data/副本 --yes
zspace up ./example.txt /sata1/my/data/测试目录 --yes
zspace down '/sata1/my/data/测试目录/*.txt' ./downloads
zspace rm '/sata1/my/data/测试目录/*.txt' --yes --allow-delete
```

所有 NAS 写操作需要 `--yes`，删除额外需要 `--allow-delete`。用 `--root /sata1/my/data/测试目录` 限制远程访问范围，用 `--local-root /absolute/local/dir` 限制上传来源和下载目录。程序拒绝路径穿越以及重命名、移动或删除存储池/允许范围的根目录。

支持 `*`、`?`、字符组和 `**` 通配符；请在 shell 中给通配符加引号。目录自动分页。搜索使用 NAS 索引，再按目标目录筛选，结果取决于 NAS 索引状态。

上传按流读取；超过 64 MiB 使用 2 MiB 分片，小文件遇到代理的 HTTP 413 也会切换分片。下载先写入权限为 `0600` 的随机临时文件，完整后才生成目标文件；默认拒绝覆盖，显式 `--overwrite` 仅允许替换普通文件。下载失败会清理临时文件。上传目标冲突行为由 NAS 接口决定，建议先用 `ls`/`info` 检查。

`--json` 输出 JSON；`--output <新文件.json>` 保存结果且拒绝覆盖。`--` 后的参数按原样读取。

## 网盘与 NAS 下载任务

百度、夸克使用极空间桌面客户端中已经连接的账号；先在客户端完成网盘登录。CLI 不读取网盘密码，也不安装额外下载器。

```sh
zspace cloud-status baidu
zspace cloud-status quark
zspace cloud-ls baidu / --page 1 --limit 100
zspace cloud-ls quark --parent-id 0 --limit 100
zspace cloud-down baidu /sata1/my/data/下载 --file-ids 123,456 --yes
zspace cloud-down quark /sata1/my/data/下载 --file-ids file-id --folder-ids folder-id --yes
zspace cloud-tasks baidu
zspace cloud-tasks quark

zspace download-add 'https://example.com/file.zip' /sata1/my/data/下载 --yes
zspace download-add 'magnet:?xt=urn:btih:...' /sata1/my/data/下载 --yes
zspace downloads --type loading --status all
zspace downloads --type complete --status all
```

目标目录须已存在；仍受 `--root` 和 `--yes` 约束。`cloud-ls` 返回一页的 `entries`、`hasMore`、`cursor`。百度用 `--page` 翻页；夸克把返回的游标原样传入 `--cursor '{"version":"...","token":"..."}'`，文件夹用列表中的 ID 作为 `--parent-id`。

`cloud-down` 下载已经保存在本人网盘中的文件和文件夹，不处理第三方分享链接、提取码或转存。百度文件夹 ID 可放在 `--folder-ids`，也可放在 `--file-ids`；夸克需区分两类 ID。

`download-add` 将链接交给 NAS 内置下载服务，支持 HTTP、HTTPS、FTP、FTPS、SFTP、magnet、thunder 协议。实际支持取决于 NAS 当前下载内核、协议和会员权限；Transmission 内核对普通 HTTP 文件可能有限制，CLI 会保留服务端错误。返回成功只代表任务创建成功，应通过任务列表和目标目录核验下载完成，不会自动切换内核或修改下载设置。

## 图库搜索与精选

```sh
zspace photo-status
zspace photo-search '海边玩耍的小朋友' --mode ai --limit 30
zspace photo-search '发票' --mode ocr --start 0 --limit 30
zspace photo-search '/sata1/my/data/照片/reference.jpg' --mode similar --limit 30
zspace photo-pick-types
zspace photo-picks --type 9 --start 0 --limit 30 --order desc
zspace photo-thumb '/sata1/my/data/照片/candidate.jpg' ./previews --size large
```

`ai`（默认）按自然语言搜索内容，`ocr` 搜索图片中的文字，`similar` 用 NAS 中现有图片进行以图搜图。需要客户端相应功能已启用、模型可用且索引已建立；CLI 不修改 AI 配置、下载模型或重建索引。AI 搜索沿用原生临时查询并轮询，单次请求和轮询等待使用 SDK `timeout`，默认 60 秒；原生查询没有独立任务 ID，同一账号请串行搜索，避免与桌面搜索互相影响。

`photo-search` / `photo-picks` 返回 `{ entries, pageFull }`。`entries` 只包含 ID、文件名、路径、大小、尺寸、类型和更新时间，不输出人脸或地理位置字段。`pageFull` 表示原始候选页达到数量上限，不保证还有下一页。OCR 和精选可用 `--start` 翻页；AI/以图搜图只返回 `--limit` 个候选，`--start` 必须为 0。数量范围 1–1000。

搜索和精选使用账号级索引，返回结果再按 `--root` 筛选；筛选后可能少于请求数量。`photo-status` 的索引计数也是账号级。加密/共享相册的 `E.` 路径不能验证文件系统范围，因此不返回这些条目。

精选查询读取**已有的原生 AI 挑选结果**：`9` 整体评分、`1` 人像、`10` 景物、`11` 疑似瑕疵；先用 `photo-pick-types` 查看当前客户端分类。没有已有结果时返回空列表，不自动创建挑选任务，也不创建相册或标记喜欢。精选结果来自 NAS，最终视觉匹配和审美筛选需要查看缩略图。

`photo-thumb` 将认证缩略图保存到本地，支持 `small` / `large`，默认文件名为 `<原文件名>.thumb.jpg`，可用 `--name` 自定义。沿用下载的临时文件、完整性检查、权限 `0600` 和远程/本地范围限制；最多 16 MiB，只接收 JPEG/PNG/WebP/GIF 响应，不返回含 token 的 URL，不覆盖已有文件。缩略图实际格式由 NAS 决定；原图请使用 `down`。

## SDK

```js
import { ZSpaceClient } from 'zspace-cli';

const client = new ZSpaceClient({ root: '/sata1/my/data/课程' });
console.log(await client.ls('/sata1/my/data/课程'));

// 只有明确启用后才允许写入。删除还需要 allowDelete: true。
const writer = new ZSpaceClient({
  root: '/sata1/my/data/测试目录',
  localRoot: '/absolute/local/dir',
  allowWrites: true,
});
await writer.upload('/absolute/local/dir/example.txt', '/sata1/my/data/测试目录');
```

方法：`check`、`poolInfo`、`diskStats`、`ls`、`info`、`search`、`tree`、`glob`、`rename`、`mkdir`、`move`、`copy`、`remove`、`upload`、`download`。网盘方法：`cloudStatus(provider)`、`cloudList(provider, options)`、`cloudDownload(provider, directory, { fileIds, folderIds })`、`cloudTasks(provider)`。NAS 下载方法：`addDownload(link, directory)`、`listDownloads(options)`。配置还包括 `credentials`、`configDir`、`baseUrl`、`timeout`、`retries`、`sliceThreshold` 和 `sliceSize`。传输方法支持 `onProgress(done, total)` 回调。

图库方法：`photoStatus()`、`photoSearch(query, { mode, start, limit })`、`photoPickTypes()`、`photoPicks({ type, start, limit, order })`、`photoThumbnail(remote, directory, { name, size })`。

只读查询会有限重试网络/HTTP 429/5xx 错误。分片上传可按相同偏移重试，其他写操作不会自动重放。SDK 不需要 `close()`。

## MCP

安装后在 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "zspace": {
      "command": "zspace-mcp",
      "args": ["--root", "/sata1/my/data/课程"]
    }
  }
}
```

默认提供 15 个只读工具，包括连接、容量、磁盘、列表、信息、搜索、树，以及网盘账号、目录、任务、NAS 下载任务和图库状态、搜索、分类、精选。传入 `--local-root` 后增加文件与缩略图下载到本地的工具；`--write --root <具体目录>` 开启创建、重命名、移动、复制、网盘下载和链接下载；同时指定本地范围才有上传。删除还需要 `--allow-delete`。这些开关授权整个 MCP 会话，调用时没有额外确认框。

25 个工具保留 `zspace_` 名称前缀：`check`、`pool_info`、`disk_stats`、`ls`、`info`、`search`、`tree`、`rename`、`mkdir`、`move`、`copy`、`remove`、`upload`、`download`、`cloud_status`、`cloud_ls`、`cloud_tasks`、`cloud_download`、`download_add`、`downloads`、`photo_status`、`photo_search`、`photo_pick_types`、`photo_picks`、`photo_thumbnail`。

stdio 使用换行分隔的 JSON-RPC，不向 stdout 输出日志。支持 MCP 2025-11-25、2025-06-18、2025-03-26、2024-11-05 的工具生命周期。

## 整理扫描器与技能

扫描器读取**本地目录或已经挂载的 NAS 共享目录**。远程 `/sata1/...` API 路径不能直接交给本地扫描器。所有扫描器只生成统计、问题和建议，不执行移动或删除。

```sh
zspace scan nas-report /Volumes/MyNAS --json --output ./snapshot.json
zspace scan file-sorter /Volumes/MyNAS/Downloads --layout type-year --naming zh
zspace scan dedup-finder /Volumes/MyNAS --min-size 1048576
zspace diff ./old.json ./snapshot.json --capacity-gb 8000
zspace coverage /Volumes/MyNAS/工作 /Volumes/Backup/工作
zspace skill --list
zspace skill ~/.codex/skills --only zspace-nas,nas-report
```

| 扫描器 | 功能 |
| --- | --- |
| `nas-report` | 类别、冷热数据、最大文件/目录、空目录、增长快照 |
| `file-sorter` | 按类型/年份生成归档计划，保留类别目录和混合项目，避免目标重名 |
| `photo-organizer` | 从文件名日期或修改时间生成年月归档建议，区分截图/微信文件 |
| `music-organizer` | 读取有界 ID3 标签，生成歌手/专辑/曲目布局，检查标签/封面 |
| `work-organizer` | 文档版本命名、锁文件、散落文档、日期命名和长期归档检查 |
| `portfolio-organizer` | 设计/模型项目的说明、封面、交付物与大源文件检查 |
| `download-cleaner` | 未完成下载、种子、系统碎片、旧安装包、待整理媒体 |
| `dedup-finder` | 大小 → 前 64 KiB → 完整 SHA-256，排除重复硬链接 |
| `backup-auditor` | 备份版本、陈旧/空备份与保留数量建议 |

通用参数：`--max-depth 6`、`--max-files 100000`、`--sample 0`、`--top 10`、`--max-issues 500`、`--stale-days <天数>`。`max-files`/`sample`/`max-issues` 的 `0` 表示不限。报告包含 `truncated` 和 `errors`，不完整扫描不能当成完整清理依据。

分类参数：`--layout type|type-year|year-type`、`--naming zh|en`、`--dest <目录>`、`--keep-dir a,b`、`--strict`、`--split-project-dirs`、`--project-min-files 3`、`--only-cat photo,video`。其他参数：`--min-size <字节>`、`--tag-limit 100`、`--strict-naming`、`--archive-years 3`、`--large-gb 1`、`--keep 3`。

照片不读取 EXIF；修改时间回退会标记人工复核。音乐支持 ID3v2.3/v2.4 的常见文本标签，其他格式/不支持的标记会报告待复核。备份覆盖检查比较相对路径、大小和修改时间，不能证明内容相同。整理结果基于文件元数据和启发式规则，需要人工复核。

技能安装不会覆盖已有目录。包含 `zspace-nas` 和上面 9 个扫描器的调用说明，只安装调用说明，不执行附带脚本。

## 开发

```sh
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run check
npm pack --dry-run
```

测试使用假登录信息、本地模拟 HTTP 服务器和 Node.js 模块 mock，覆盖权限范围、分页、Unicode 路径、重试、超时、断流、文件变更、分片传输、下载完整性、网盘协议、图库搜索/精选/缩略图、CLI、MCP 和只读扫描。测试不会读取真实账号或连接真实 NAS。`test:coverage` 要求全部 `src/*.js`、`bin/*.js` 的行、分支、函数覆盖率均为 100%，低于阈值或漏测生产文件会失败；无需添加测试依赖。建议使用 Node.js 24 运行覆盖率检查，模块 mock 属于 Node 实验性接口。安全边界及剩余风险见 [SECURITY.md](SECURITY.md)。

已在 macOS / Node.js 24 上实机验证文件读写与传输、百度/夸克查询、夸克文件落盘和 HTTP 下载完整性。百度任务曾验证创建及排队，未验证完整下载。图库已验证状态、OCR、AI 文本搜索、以图搜图、精选查询和缩略图下载；当前精选结果为空。Windows/Linux、超大文件和不同客户端版本尚未做实机验证。
