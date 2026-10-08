import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';

export function loopbackURL(value = 'http://127.0.0.1:13579') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Only an HTTP loopback origin (127.0.0.1 or [::1]) is allowed');
  }
  return url.origin;
}

export function remotePath(value, root = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(value)
      || value.split('/').some(p => p === '..' || p === '.')) throw new Error('Invalid absolute NAS path');
  const normalized = path.posix.normalize(value).replace(/\/$/, '') || '/';
  const base = root === '/' ? '/' : remotePath(root);
  if (base !== '/' && normalized !== base && !normalized.startsWith(`${base}/`)) {
    throw new Error('NAS path is outside the allowed root');
  }
  return normalized;
}

export function basename(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
      || /[/\\\x00-\x1f\x7f]/.test(value)) throw new Error('Expected a plain filename');
  return value;
}

export function protectRoot(value, root = '/') {
  const p = remotePath(value, root);
  if (p === root || p === '/' || /^\/sata\d+(?:\/my(?:\/data)?)?$/.test(p)) {
    throw new Error('Refusing to rename, move or delete a protected root');
  }
  return p;
}

export function inside(value, root) {
  const rel = path.relative(root, value);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export async function localPath(value, root) {
  const resolved = await realpath(path.resolve(value));
  if (root && !inside(resolved, await realpath(path.resolve(root)))) throw new Error('Local path is outside the allowed root');
  return resolved;
}

export async function exists(value) {
  try { return await lstat(value); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function globRegex(pattern) {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; result += '(?:[^/]+/)*'; } else result += '.*';
    } else if (c === '*') result += '[^/]*';
    else if (c === '?') result += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) throw new Error('Unclosed glob character class');
      let chars = pattern.slice(i + 1, end);
      const negated = chars.startsWith('!');
      if (negated) chars = chars.slice(1);
      if (!chars || /[/\\\[\^]/.test(chars)) throw new Error('Invalid glob character class');
      result += negated ? `(?!/)[^${chars}]` : `(?!/)[${chars}]`; i = end;
    } else result += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${result}$`, 'u');
}
