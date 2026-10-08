import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
export const nasRoot = '/sata1/my/data/test';
export const credentials = { token: 'mock-token-only', nasId: 'mock-nas', deviceId: 'mock-device', device: 'Mock', appVersion: '1.0' };

export async function mockNas(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zspace-mock-'));
  await writeFile(path.join(directory, 'vuex.json'), JSON.stringify({ state: { user: { token: credentials.token }, nas: { nasId: credentials.nasId }, app: { deviceId: credentials.deviceId, device: credentials.device, version: credentials.appVersion } } }));
  const files = new Map([[nasRoot, null], [`${nasRoot}/folder`, null], [`${nasRoot}/a.txt`, Buffer.from('hello')], [`${nasRoot}/folder/nested.txt`, Buffer.from('nested')]]);
  const requests = [];
  const row = (name, body) => ({ path: name, name: path.posix.basename(name), is_dir: body === null ? '1' : '0', size: body?.length ?? 0 });
  let override;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const b of req) chunks.push(b);
      const url = new URL(req.url, 'http://127.0.0.1'); const body = Buffer.concat(chunks); const form = new URLSearchParams(body.toString());
      const query = { url, method: req.method, headers: req.headers, body, form }; requests.push(query);
      if (override && await override(query, res)) return;
      const target = form.get('path'); let data = {};
      const list = dir => [...files].filter(([p]) => path.posix.dirname(p) === dir && p !== dir).map(([p, b]) => row(p, b));
      switch (url.pathname) {
        case '/zspool/info': data = { pool_list: [{ name: 'sata1' }] }; break;
        case '/disk/statics': data = { disks: [] }; break;
        case '/znetdisk/auth/check': case '/zdrive/kuake/auth/check': data = { is_login: true }; break;
        case '/znetdisk/file/list': data = { list: [{ fs_id: '123', server_filename: 'cloud.txt', path: '/cloud.txt', isdir: 0, size: 5 }] }; break;
        case '/zdrive/kuake/file/filelist': data = { file_list: [{ file_id: 'quark-file', name: 'cloud.txt', path: '/cloud.txt', type: 'file', size: 5 }], last_page: true }; break;
        case '/znetdisk/file/download': case '/zdrive/kuake/task/download': data = { task_id: 'mock-transfer' }; break;
        case '/znetdisk/task/list': case '/zdrive/kuake/task/list': data = { list: [] }; break;
        case '/downloader/add/link': data = { id: 'mock-download' }; break;
        case '/downloader/list': data = { list: [], total: 0 }; break;
        case '/v2/file/list': data = { list: list(target).slice(Number(form.get('start')), Number(form.get('start')) + Number(form.get('limit'))) }; break;
        case '/v2/file/info': data = row(target, files.get(target)); break;
        case '/file_search/file_search': data = { list: [...files].filter(([p]) => p.includes(form.get('keyword'))).map(([p, b]) => row(p, b)) }; break;
        case '/v2/file/newdir': { const p = `${form.get('parent')}/${form.get('name')}`; files.set(p, null); data = row(p, null); break; }
        case '/v2/file/modify': { const p = `${path.posix.dirname(target)}/${form.get('newname')}`; const b = files.get(target); files.delete(target); files.set(p, b); data = row(p, b); break; }
        case '/v2/file/copy': case '/v2/file/move':
          for (const p of form.getAll('paths[]')) { files.set(`${form.get('to')}/${path.posix.basename(p)}`, files.get(p)); if (url.pathname.endsWith('move')) files.delete(p); } break;
        case '/v2/file/remove': for (const p of form.getAll('paths[]')) files.delete(p); break;
        case '/v2/file/create': { const p = Buffer.from(req.headers.path, 'latin1').toString('utf8'); files.set(p, body); data = row(p, body); break; }
        case '/v2/file/upload': { const p = decodeURIComponent(req.headers.path); const b = files.get(p) ?? Buffer.alloc(Number(req.headers.size)); body.copy(b, Number(req.headers.seek)); files.set(p, b); data = row(p, b); break; }
        case '/v2/file/download': { const b = files.get(url.searchParams.get('path')); res.setHeader('Content-Length', b.length); res.end(b); return; }
        default: res.statusCode = 404; res.end(); return;
      }
      res.end(JSON.stringify({ code: '200', data }));
    } catch (e) { res.destroy(e); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, files, requests, row, baseUrl: `http://127.0.0.1:${server.address().port}`, override(fn) { override = fn; } };
}
