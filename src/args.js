const booleans = new Set(['json', 'hidden', 'long', 'yes', 'allow-delete', 'write', 'overwrite', 'list', 'help', 'version', 'strict', 'strict-naming', 'split-project-dirs', 'read-tags']);
const aliases = { a: 'hidden', l: 'long', y: 'yes', d: 'depth', n: 'name', h: 'help', v: 'version' };
const values = new Set(['config-dir', 'base-url', 'root', 'local-root', 'depth', 'name', 'only', 'limit', 'output', 'max-depth', 'stale-days', 'layout', 'naming', 'dest', 'capacity-gb', 'keep', 'keep-dir', 'top', 'max-issues', 'max-files', 'sample', 'min-size', 'tag-limit', 'archive-years', 'large-gb', 'only-cat', 'project-min-files', 'parent-id', 'page', 'cursor', 'file-ids', 'folder-ids', 'type', 'status', 'start']);
export function parseArgs(argv) {
  const options = {}; const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!item.startsWith('-')) { positionals.push(item); continue; }
    const [raw, ...parts] = item.replace(/^--?/, '').split('='); const key = aliases[raw] ?? raw;
    if (booleans.has(key)) { if (parts.length) throw new Error(`--${key} does not take a value`); options[key] = true; }
    else if (values.has(key)) {
      const value = parts.length ? parts.join('=') : argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      options[key] = value;
    } else throw new Error(`Unknown option: ${item}`);
  }
  return { options, positionals };
}
export function integer(value, fallback, name = 'number') {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${name}`);
  return n;
}
