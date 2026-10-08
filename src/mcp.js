import { ZSpaceClient } from './client.js';
import { remotePath } from './safety.js';
import pkg from '../package.json' with { type: 'json' };

const text = { type: 'string', minLength: 1 };
const paths = { anyOf: [text, { type: 'array', items: text, minItems: 1 }] };
const boolean = { type: 'boolean' };
const number = { type: 'integer', minimum: 0, maximum: 100 };
const definitions = [
  ['check', 'Check NAS connection', {}, [], 'read', c => c.check()],
  ['pool_info', 'Storage pool capacity', {}, [], 'read', c => c.poolInfo()],
  ['disk_stats', 'Disk diagnostics', {}, [], 'read', c => c.diskStats()],
  ['cloud_status', 'Cloud login status: baidu or quark', { provider: text }, ['provider'], 'read', (c, a) => c.cloudStatus(a.provider)],
  ['cloud_ls', 'One page of cloud files; pass Quark cursor JSON for the next page', { provider: text, path: text, parent_id: text, page: { type: 'integer', minimum: 1, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, cursor: text }, ['provider'], 'read', (c, a) => c.cloudList(a.provider, { path: a.path, parentId: a.parent_id, page: a.page, limit: a.limit, cursor: a.cursor === undefined ? undefined : JSON.parse(a.cursor) })],
  ['cloud_tasks', 'Cloud transfer task status', { provider: text }, ['provider'], 'read', (c, a) => c.cloudTasks(a.provider)],
  ['cloud_download', 'Download selected cloud IDs to an allowed NAS directory', { provider: text, remote_dir: text, file_ids: { type: 'array', items: text, minItems: 0 }, folder_ids: { type: 'array', items: text, minItems: 0 } }, ['provider', 'remote_dir'], 'write', (c, a) => c.cloudDownload(a.provider, a.remote_dir, { fileIds: a.file_ids, folderIds: a.folder_ids })],
  ['download_add', 'Add a link for the NAS to download to an allowed directory', { link: text, remote_dir: text }, ['link', 'remote_dir'], 'write', (c, a) => c.addDownload(a.link, a.remote_dir)],
  ['downloads', 'NAS download task status', { type: text, status: text, start: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, [], 'read', (c, a) => c.listDownloads(a)],
  ['ls', 'List a NAS directory', { path: text, show_hidden: boolean }, ['path'], 'read', (c, a) => c.ls(a.path, { hidden: a.show_hidden })],
  ['info', 'NAS file metadata', { path: text }, ['path'], 'read', (c, a) => c.info(a.path)],
  ['search', 'Search filenames', { keyword: text, path: text }, ['keyword', 'path'], 'read', (c, a) => c.search(a.keyword, a.path)],
  ['tree', 'Directory tree', { path: text, depth: number }, ['path'], 'read', (c, a) => c.tree(a.path, { depth: a.depth })],
  ['rename', 'Rename a NAS file', { path: text, new_name: text }, ['path', 'new_name'], 'write', (c, a) => c.rename(a.path, a.new_name)],
  ['mkdir', 'Create a directory', { parent: text, name: text }, ['parent', 'name'], 'write', (c, a) => c.mkdir(a.parent, a.name)],
  ['move', 'Move NAS files', { paths, to: text }, ['paths', 'to'], 'write', (c, a) => c.move(a.paths, a.to)],
  ['copy', 'Copy NAS files', { paths, to: text }, ['paths', 'to'], 'write', (c, a) => c.copy(a.paths, a.to)],
  ['remove', 'Delete NAS files; recovery is not guaranteed', { paths }, ['paths'], 'delete', (c, a) => c.remove(a.paths)],
  ['upload', 'Upload an allowed local file to NAS', { local_path: text, remote_dir: text, new_name: text }, ['local_path', 'remote_dir'], 'upload', (c, a) => c.upload(a.local_path, a.remote_dir, { name: a.new_name })],
  ['download', 'Download to the allowed local directory; never overwrite', { remote_path: text, local_dir: text }, ['remote_path', 'local_dir'], 'download', (c, a) => c.download(a.remote_path, a.local_dir)],
];

function matches(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(s => matches(value, s));
  if (schema.type === 'string') return typeof value === 'string' && value.length >= schema.minLength;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  return Array.isArray(value) && value.length >= schema.minItems && value.every(v => matches(v, schema.items));
}

export function createMcpHandler(options = {}) {
  if (options.allowWrites && (!options.root || remotePath(options.root) === '/')) throw new Error('MCP writes require a specific --root');
  if (options.allowDelete && !options.allowWrites) throw new Error('--allow-delete requires --write');
  const client = new ZSpaceClient(options);
  const available = definitions.filter(d => d[4] === 'read'
    || (d[4] === 'download' && options.localRoot)
    || (d[4] === 'upload' && options.localRoot && options.allowWrites)
    || (d[4] === 'write' && options.allowWrites)
    || (d[4] === 'delete' && options.allowWrites && options.allowDelete));
  let state = 'new';
  return async message => {
    const { id, method, params = {} } = message ?? {};
    const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!message || message.jsonrpc !== '2.0' || typeof method !== 'string' || (id !== undefined && typeof id !== 'string' && typeof id !== 'number')) return error(-32600, 'Invalid request');
    if (id === undefined) { if (method === 'notifications/initialized' && state === 'initializing') state = 'ready'; return null; }
    const result = value => ({ jsonrpc: '2.0', id, result: value });
    if (method === 'initialize') {
      if (state !== 'new') return error(-32600, 'Already initialized');
      if (!params || typeof params.protocolVersion !== 'string') return error(-32602, 'protocolVersion is required');
      state = 'initializing';
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return result({ protocolVersion: supported.includes(params.protocolVersion) ? params.protocolVersion : supported[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'zspace-cli', version: pkg.version } });
    }
    if (method === 'ping') return result({});
    if (state !== 'ready') return error(-32000, 'Initialize the MCP session first');
    if (method === 'tools/list') return result({ tools: available.map(([name, description, properties, required, mode]) => ({
      name: `zspace_${name}`, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
      annotations: { readOnlyHint: mode === 'read', destructiveHint: !['read', 'download'].includes(mode), openWorldHint: true },
    })) });
    if (method !== 'tools/call') return error(-32601, 'Method not found');
    const definition = available.find(d => `zspace_${d[0]}` === params?.name);
    if (!definition) return error(-32602, 'Unknown or disabled tool');
    const args = params.arguments ?? {}; const [, , properties, required, , call] = definition;
    if (!args || typeof args !== 'object' || Array.isArray(args) || required.some(k => !(k in args))
      || Object.entries(args).some(([k, v]) => !properties[k] || !matches(v, properties[k]))) return error(-32602, 'Invalid tool arguments');
    try {
      const value = { result: await call(client, args) };
      return result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
    } catch (e) { return result({ content: [{ type: 'text', text: e.message }], isError: true }); }
  };
}

export async function serveMcp({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const handler = createMcpHandler(options); let buffer = ''; let pending = Promise.resolve();
  input.setEncoding('utf8');
  const send = response => { if (response) output.write(`${JSON.stringify(response)}\n`); };
  for await (const chunk of input) {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error('MCP message exceeds 1 MiB');
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      pending = pending.then(async () => {
        let message;
        try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        send(await handler(message));
      });
      await pending;
    }
  }
  if (buffer.trim()) throw new Error('MCP messages must be newline-terminated');
  await pending;
}
