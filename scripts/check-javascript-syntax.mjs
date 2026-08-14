#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const extensions = new Set(['.js', '.mjs', '.cjs']);

async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collect(candidate));
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) output.push(candidate);
  }
  return output;
}

const files = (await Promise.all(['src', 'scripts'].map(collect))).flat().sort((a, b) => a.localeCompare(b, 'en'));
const results = await Promise.allSettled(files.map(file => execFileAsync(process.execPath, ['--check', file], {
  windowsHide: true,
  timeout: 15_000,
  maxBuffer: 1 * 1024 * 1024
})));
const failures = results.flatMap((result, index) => result.status === 'rejected' ? [files[index]] : []);
if (failures.length > 0) {
  console.error(`JAVASCRIPT_SYNTAX_FAILED ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`JAVASCRIPT_SYNTAX_OK files=${files.length}`);
}
