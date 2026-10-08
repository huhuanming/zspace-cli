---
name: zspace-nas
description: Manage files on an explicitly authorized ZSpace NAS through zpace-cli.
---

Use the installed `zpace` CLI or SDK. `zpace check --json` verifies the desktop client connection. Pass the actual NAS path; pools may use /sata1 or /sata11. Browse with `ls`, `info`, `find`, and `tree`. Mutations require the user-authorized scope and `--yes`; deletion also requires `--allow-delete`. A token inherits the desktop account permissions. Do not print the login state. Download defaults to no overwrite. MCP defaults to read-only; enable only the tools and NAS/local roots needed for the task.
