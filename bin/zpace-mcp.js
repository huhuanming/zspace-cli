#!/usr/bin/env node
import { parseArgs } from '../src/args.js';
import { serveMcp } from '../src/mcp.js';
try {
  const { options: o, positionals } = parseArgs(process.argv.slice(2));
  if (o.help) console.log('zpace-mcp [--root <NAS-root>] [--write] [--allow-delete] [--local-root <local-root>] [--config-dir <directory>]');
  else if (positionals.length) throw new Error('Unexpected positional arguments');
  else await serveMcp({ root: o.root, localRoot: o['local-root'], allowWrites: o.write, allowDelete: o['allow-delete'], configDir: o['config-dir'], baseUrl: o['base-url'] });
} catch (e) { console.error(e.message.replace(/[\x00-\x1f\x7f]/g, ' ')); process.exitCode = 1; }
