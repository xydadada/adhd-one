import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { getDshArgs, getDshEntry, getFreePort, getNodeRuntime } from '../src/runtime.js';

test('builds the supported dsh web command', () => {
  assert.deepEqual(getDshArgs(31415), ['web', '--port', '31415']);
});

test('resolves the development dsh entry', () => {
  assert.equal(
    getDshEntry('C:\\runtime'),
    path.join('C:\\runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  );
});

test('allocates a valid local port', async () => {
  const port = await getFreePort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0 && port < 65536);
});

test('resolves the packaged Windows Node runtime', () => {
  assert.equal(
    getNodeRuntime({ appPath: 'C:\\app', resourcesPath: 'C:\\resources', isPackaged: true, platform: 'win32' }),
    path.join('C:\\resources', 'node-runtime', 'node.exe')
  );
});
