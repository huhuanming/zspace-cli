import path from 'node:path';
import { readdir, cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exists } from './safety.js';

export async function installSkills(directory, { list = false, only } = {}) {
  const source = fileURLToPath(new URL('../skills/', import.meta.url));
  const names = (await readdir(source, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  if (list) return names;
  if (!directory) throw new Error('Specify a skill directory or use --list');
  const wanted = only ? only.split(',').map(s => s.trim()) : names;
  if (wanted.some(n => !names.includes(n))) throw new Error('Unknown skill name');
  const target = path.resolve(directory);
  for (const name of wanted) if (await exists(path.join(target, name))) throw new Error(`Skill already exists: ${name}`);
  await mkdir(target, { recursive: true });
  for (const name of wanted) await cp(path.join(source, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
  return { directory: target, installed: wanted };
}
