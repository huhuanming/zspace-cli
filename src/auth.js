import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exists } from './safety.js';

export async function loadCredentials(configDir = process.env.ZS_CONFIG_DIR) {
  const home = os.homedir();
  const candidates = configDir ? [configDir] : process.platform === 'darwin'
    ? [path.join(home, 'Library', 'Application Support', 'zspace')]
    : process.platform === 'win32'
      ? [...new Set([process.env.APPDATA, process.env.LOCALAPPDATA, home].filter(Boolean).map(p => path.join(p, 'zspace')))]
      : [path.join(home, '.zspace'), path.join(home, '.config', 'zspace'), path.join(home, 'zspace')];
  for (const dir of candidates) {
    const file = path.join(dir, 'vuex.json');
    if (!await exists(file)) continue;
    let state;
    try { const data = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); state = data.state ?? data; }
    catch { throw new Error('Cannot parse the ZSpace desktop login state'); }
    return validateCredentials({ token: state.user?.token, nasId: state.nas?.nasId,
      deviceId: state.app?.deviceId ?? '', device: state.app?.device ?? '', appVersion: state.app?.version ?? '1.0' });
  }
  throw new Error('ZSpace login state not found. Sign in to the desktop client or pass --config-dir.');
}

export function validateCredentials(input) {
  const output = {};
  for (const key of ['token', 'nasId', 'deviceId', 'device', 'appVersion']) {
    const value = String(input?.[key] ?? '');
    if (value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid ZSpace login state');
    output[key] = value;
  }
  if (!output.token || !output.nasId) throw new Error('ZSpace desktop client is not signed in');
  return Object.freeze(output);
}
