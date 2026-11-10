import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const source = resolve('build/studio');
const target = resolve('static/studio');
async function copy(directory, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const src = join(directory, entry.name);
    const dst = join(destination, entry.name);
    if (entry.isDirectory()) await copy(src, dst);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) await copyFile(src, dst);
  }
}
await copy(source, target);
console.log('Studio built → static/studio (served by the existing Python app)');
