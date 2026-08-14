import fs from 'node:fs/promises';
import path from 'node:path';

export async function pruneRuntime(runtimeRoot) {
  const modules = path.join(runtimeRoot, 'node_modules');
  const remove = [
    ['node-pty', 'prebuilds', 'darwin-arm64'], ['node-pty', 'prebuilds', 'darwin-x64'], ['node-pty', 'prebuilds', 'win32-arm64'],
    ['pnpm', 'dist', 'node_modules', '@reflink', 'reflink-darwin-arm64'], ['pnpm', 'dist', 'node_modules', '@reflink', 'reflink-darwin-x64'],
    ['pnpm', 'dist', 'node_modules', '@reflink', 'reflink-win32-arm64-msvc'], ['pnpm', 'artifacts'],
    ['node-pty', 'build'], ['node-pty', 'deps'], ['node-pty', 'scripts'], ['node-pty', 'src'], ['node-pty', 'third_party'], ['node-pty', 'typings'],
    ['@mixmark-io', 'domino', 'test'], ['zod', 'src'], ['@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'examples'],
    ['@modelcontextprotocol', 'sdk', 'dist', 'esm', 'examples'], ['qs', 'test'], ['gaxios', 'build', 'cjs', 'test'],
    ['gaxios', 'build', 'esm', 'test'], ['fast-uri', 'test']
  ];
  await Promise.all(remove.map(parts => fs.rm(path.join(modules, ...parts), { recursive: true, force: true })));
  await Promise.all([
    fs.rm(path.join(modules, 'pnpm', 'dist', 'vendor', 'fastlist-0.3.0-x86.exe'), { force: true }),
    fs.rm(path.join(modules, 'pnpm', 'artifacts', 'exe', 'dist', 'vendor', 'fastlist-0.3.0-x86.exe'), { force: true })
  ]);
  await removeDevelopmentFiles(modules);
}

async function removeDevelopmentFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const removableDirectories = new Set(['.github', '.yarn', '__tests__', 'bench', 'benchmark', 'coverage', 'docs', 'examples', 'test', 'tests']);
  const dependencyBoundary = path.basename(root) === 'node_modules';
  await Promise.all(entries.map(entry => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!dependencyBoundary && removableDirectories.has(entry.name)) return fs.rm(target, { recursive: true, force: true });
      return removeDevelopmentFiles(target);
    }
    if (entry.isFile() && (entry.name.endsWith('.map') || entry.name.endsWith('.pdb') || /\.d\.(?:ts|mts|cts)$/u.test(entry.name))) return fs.rm(target, { force: true });
    return undefined;
  }));
}
