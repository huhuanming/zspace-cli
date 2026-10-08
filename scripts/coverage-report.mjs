import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export default async function* report(events) {
  for await (const event of events) {
    if (event.type !== 'test:coverage') continue;
    const summary = event.data.summary;
    const directory = path.join(summary.workingDirectory, 'coverage');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    const expected = (await Promise.all(['src', 'bin'].map(async folder =>
      (await readdir(path.join(summary.workingDirectory, folder), { recursive: true })).filter(name => name.endsWith('.js')).map(name => path.join(summary.workingDirectory, folder, name))))).flat();
    const missing = expected.filter(file => !summary.files.some(row => row.path === file));
    if (missing.length) throw new Error(`Unmeasured production files: ${missing.join(', ')}`);
    const incomplete = summary.files.filter(file => ['Line', 'Branch', 'Function'].some(kind => file[`covered${kind}Count`] !== file[`total${kind}Count`]));
    if (incomplete.length) throw new Error(`Production coverage must be exactly 100%: ${incomplete.map(file => file.path).join(', ')}`);
  }
}
