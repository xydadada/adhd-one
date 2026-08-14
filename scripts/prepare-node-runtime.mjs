import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '24.18.0';
const archiveName = `node-v${version}-win-x64.zip`;
const expectedSha256 = '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821';
const vendor = path.join(root, 'vendor');
const runtime = path.join(vendor, 'node');
const executable = path.join(runtime, 'node.exe');
const archive = path.join(vendor, archiveName);

try {
  await fs.access(executable);
  console.log(`Using cached official Node.js ${version} runtime.`);
  process.exit(0);
} catch {}

await fs.mkdir(vendor, { recursive: true });
const url = `https://nodejs.org/dist/v${version}/${archiveName}`;
console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`Node.js download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const actualSha256 = createHash('sha256').update(bytes).digest('hex');
if (actualSha256 !== expectedSha256) {
  throw new Error(`Node.js SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
}
await fs.writeFile(archive, bytes);

const extracted = path.join(vendor, `node-v${version}-win-x64`);
await fs.rm(extracted, { recursive: true, force: true });
await fs.rm(runtime, { recursive: true, force: true });
await execFileAsync('tar.exe', ['-xf', archive, '-C', vendor]);
await fs.rename(extracted, runtime);
await fs.rm(archive, { force: true });
console.log(`Prepared official Node.js ${version}; SHA-256 verified.`);
