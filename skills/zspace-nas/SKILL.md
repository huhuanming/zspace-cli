---
name: zspace-nas
description: Manage files on an explicitly authorized ZSpace NAS through zspace-cli.
---

Use the installed `zspace` CLI or SDK. `zspace check --json` verifies the desktop client connection. Pass the actual NAS path; pools may use /sata1 or /sata11. Browse with `ls`, `info`, `find`, and `tree`. Mutations require the user-authorized scope and `--yes`; deletion also requires `--allow-delete`. A token inherits the desktop account permissions. Do not print the login state. Download defaults to no overwrite. MCP defaults to read-only; enable only the tools and NAS/local roots needed for the task.

For cloud transfers, use `cloud-status baidu|quark` and `cloud-ls` to inspect the accounts already connected in the desktop client. Use `cloud-down <provider> <NAS-directory> --file-ids <IDs> --folder-ids <IDs> --yes` only within the authorized destination. Baidu lists use paths/pages; Quark uses parent IDs and returned cursor JSON. Third-party share links are not supported. `download-add '<link>' <NAS-directory> --yes` delegates a download to the NAS without changing its settings. Check `cloud-tasks`, `downloads`, and destination file metadata: `accepted: true` means task creation, not transfer completion. Do not bind accounts or modify download engines as an implicit step.
