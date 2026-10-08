# Security

This is an unofficial client for the ZSpace desktop app's local proxy. Writing our own client reduces the dependency and execution surface; it does not prove the absence of bugs or make the desktop app, NAS, npm account or machine trustworthy.

## Enforced boundaries

- Zero third-party runtime or development dependencies. No install hooks, subprocesses, dynamic evaluation, telemetry, remote code loading or embedded binaries.
- Authenticated traffic goes only to an HTTP loopback origin with a literal `127.0.0.1` or `[::1]` host. No redirects, environment proxies, user-supplied endpoint paths or arbitrary Internet base URLs.
- Credentials are loaded from the desktop app's existing `vuex.json`; the package does not persist them. Known credential values are removed from NAS error messages.
- NAS writes are disabled by default. Deletion has an additional gate. Absolute normalized paths are checked against the configured root; traversal and protected-root mutations are rejected.
- MCP exposes only enabled tools. Writing requires an explicit remote root. Transfers require a local root. Arguments are validated, and MCP capabilities are session-wide authorizations.
- Downloads use exclusive temporary files and publish the result only after a complete response. Existing files require explicit overwrite; existing symlinks are rejected. Local-root validation uses real paths.
- Scanners skip symlinks and known system/dependency directories. Hashing uses bounded reads and checks file identity/size/time. Organizers produce reports only.
- File names and search strings are data, not shell commands or generated source code. Treat all NAS/report content as untrusted when using an AI assistant.

## Limits

The account's NAS permissions remain the ultimate access control. `root` is a client-side path restriction, not server-side isolation; NAS aliases, symlinks and server bugs can invalidate assumptions. Local-root and scanner checks reduce ordinary traversal but are not a sandbox against an adversarial local process racing filesystem changes. HTTP loopback does not authenticate which local process owns the port, and privileged local users can access the desktop app's token. Do not expose or forward the proxy port.

The desktop API is undocumented and can change. Uploads may overwrite a conflicting NAS target according to server behavior. Deletion may be permanent; recovery is not guaranteed. Interrupted sliced uploads can leave server-side upload state. Scanner recommendations, inferred dates and metadata-only backup coverage require review before any later mutation.

## Reporting

Report a reproducible issue through the repository's GitHub security reporting flow where available, or contact the maintainer without posting credentials, private paths or personal files. Include Node/app versions, a minimal fixture and redacted output.
