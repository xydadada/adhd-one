import net from 'node:net';
import path from 'node:path';

export const DSH_VERSION = '0.1.0-rc.6';

export function getDshEntry(runtimeRoot) {
  return path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

export function getNodeRuntime({ appPath, resourcesPath, isPackaged, platform = process.platform }) {
  const executable = platform === 'win32' ? 'node.exe' : 'bin/node';
  const root = isPackaged ? path.join(resourcesPath, 'node-runtime') : path.join(appPath, 'vendor', 'node');
  return path.join(root, executable);
}

export function getDshArgs(port) {
  return ['web', '--port', String(port)];
}

export async function getFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

export async function waitForServer(url, timeoutMs = 90_000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status >= 200 && response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`DeepSeek Harness did not become ready in time: ${lastError?.message ?? 'unknown error'}`);
}
