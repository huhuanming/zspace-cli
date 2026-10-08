# zspace-cli

用 Node.js 管理极空间 NAS：命令行、SDK、MCP，以及 9 个只读整理扫描器。

参考 [skyzhao1223/zspace-cli](https://github.com/skyzhao1223/zspace-cli) v0.1.9 的桌面代理协议和功能，自行用 Node.js 实现。没有第三方依赖、安装脚本或 Python/shell 执行器。MIT，来源说明见 [NOTICE](NOTICE)。

## 安装与连接

需要 Node.js 22 或更新版本；极空间桌面客户端必须启动、登录并连接 NAS。

```sh
npm install -g zspace-cli@0.2.0
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

默认提供 11 个只读工具，包括连接、容量、磁盘、列表、信息、搜索、树，以及网盘账号、目录、任务和 NAS 下载任务。传入 `--local-root` 后增加下载到本地的工具；`--write --root <具体目录>` 开启创建、重命名、移动、复制、网盘下载和链接下载；同时指定本地范围才有上传。删除还需要 `--allow-delete`。这些开关授权整个 MCP 会话，调用时没有额外确认框。

20 个工具保留 `zspace_` 名称前缀：`check`、`pool_info`、`disk_stats`、`ls`、`info`、`search`、`tree`、`rename`、`mkdir`、`move`、`copy`、`remove`、`upload`、`download`、`cloud_status`、`cloud_ls`、`cloud_tasks`、`cloud_download`、`download_add`、`downloads`。

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

照片不读取 EXIF；修改时间回退会标记人工复核。音乐支持 ID3v2.3/v2.4 的常见文本标签，其他格式/不支持的标记会报告待复核。备份覆盖检查比较相对路径、大小和修改时间，不能证明内容相同。整理规则是独立 Node 实现，报告字段和启发式结果不保证与 Python 版本完全相同。

技能安装不会覆盖已有目录。包含 `zspace-nas` 和上面 9 个扫描器的调用说明，不安装或运行原项目的 shell/Python 脚本。

## 开发

```sh
npm ci --ignore-scripts
npm test
npm run test:coverage
npm run check
npm pack --dry-run
```

测试使用假登录信息、本地模拟 HTTP 服务器和 Node.js 模块 mock，覆盖权限范围、分页、Unicode 路径、重试、超时、断流、文件变更、分片传输、下载完整性、网盘协议、CLI、MCP 和只读扫描。测试不会读取真实账号或连接真实 NAS。`test:coverage` 要求全部 `src/*.js`、`bin/*.js` 的行、分支、函数覆盖率均为 100%，低于阈值或漏测生产文件会失败；无需添加测试依赖。建议使用 Node.js 24 运行覆盖率检查，模块 mock 属于 Node 实验性接口。安全边界及剩余风险见 [SECURITY.md](SECURITY.md)。

0.1.0 在 macOS / Node.js 24 上通过 20 项测试和 10 份 skill 格式校验。另在真实桌面代理上验证了目录读取、创建、重命名、复制、移动、删除，小文件/空文件/强制分片上传，以及下载 SHA-256 一致性；测试目录已清理。Windows/Linux、超大文件和不同客户端版本尚未做实机验证。

0.2.0 的生产代码行、分支、函数覆盖率均为 100%。实机验证了百度、夸克的账号/目录/任务查询、网盘下载任务创建、夸克文件落盘，以及 HTTP 链接下载到指定目录并与源文件逐字节一致。百度测试任务排在已有任务之后，仅验证创建和排队，随后取消；不把排队当作下载完成。
