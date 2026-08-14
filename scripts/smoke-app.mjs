import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const root = await mkdtemp(path.join(os.tmpdir(), 'adhd-one-smoke-'));
let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, ['.', '--smoke-test'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, ADHD_SMOKE_DATA_ROOT: root },
      stdio: 'inherit',
      windowsHide: true,
      shell: false
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch {
      if (attempt === 19) throw new Error('SMOKE_CLEANUP_FAILED');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
process.exitCode = exitCode;
