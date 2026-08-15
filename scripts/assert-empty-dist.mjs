import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') throw new Error('DIST_PATH_INVALID');

try {
  const info = await stat(dist);
  if (!info.isDirectory()) throw new Error('DIST_NOT_DIRECTORY');
  const entries = await readdir(dist);
  if (entries.length > 0) throw new Error(`DIST_NOT_EMPTY:${entries.sort().join(',')}`);
} catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') process.exit(0);
  throw error;
}
