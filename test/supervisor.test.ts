import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

type SupervisorMessage = {
  v?: number;
  generation?: number;
  type?: string;
  nonce?: string;
  pid?: number;
  url?: string;
  code?: string;
  message?: string;
};

type SupervisorRun = {
  messages: SupervisorMessage[];
  log: string;
  stderr: string;
  exitCode: number | null;
  memory?: { before: number; after: number };
};

const supervisorPath = path.resolve('src/supervisor.mjs');

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), 5_000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function runSupervisor(dshSource: string, stopAfterReady: boolean, stopAfterDelayMs?: number, controlFrame?: string): Promise<SupervisorRun> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adhd-supervisor-test-'));
  const dshEntry = path.join(directory, 'dsh.mjs');
  const logPath = path.join(directory, 'runtime.log');
  const memoryPath = path.join(directory, 'memory-report.json');
  await writeFile(dshEntry, dshSource, 'utf8');

  const nonce = 'test-supervisor-nonce';
  const generation = 17;
  const child = spawn(process.execPath, ['--expose-gc', supervisorPath], {
    env: {
      ...process.env,
      ADHD_NONCE: nonce,
      ADHD_GENERATION: String(generation),
      ADHD_DSH_ENTRY: dshEntry,
      ADHD_LOG: logPath,
      ADHD_MEMORY_REPORT: memoryPath,
      ADHD_PORT: '43123'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const messages: SupervisorMessage[] = [];
  let protocolBuffer = '';
  let stderr = '';
  let readySeen = false;
  let protocolError: Error | undefined;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    protocolBuffer += String(chunk);
    for (;;) {
      const newline = protocolBuffer.indexOf('\n');
      if (newline < 0) break;
      const raw = protocolBuffer.slice(0, newline);
      protocolBuffer = protocolBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(raw) as SupervisorMessage;
        messages.push(message);
        if (message.type === 'ready') readySeen = true;
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  const exited = new Promise<{ code: number | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code }));
  });

  try {
    if (stopAfterReady) {
      await withTimeout(new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          if (readySeen) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
        child.once('error', reject);
        child.once('close', () => {
          clearInterval(timer);
          if (!readySeen) reject(new Error('supervisor exited before ready'));
        });
      }), 'supervisor ready timeout');
      child.stdin.write(controlFrame ?? `${JSON.stringify({ v: 1, nonce, generation, type: 'stop' })}\n`);
    } else if (stopAfterDelayMs !== undefined) {
      await withTimeout(new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, stopAfterDelayMs);
        child.once('error', reject);
        child.once('close', () => {
          clearTimeout(timer);
          reject(new Error('supervisor exited before delayed stop'));
        });
      }), 'supervisor delayed stop timeout');
      child.stdin.write(controlFrame ?? `${JSON.stringify({ v: 1, nonce, generation, type: 'stop' })}\n`);
    }
    const exit = await withTimeout(exited, 'supervisor exit timeout');
    if (protocolError) throw protocolError;
    const log = await readFile(logPath, 'utf8');
    let memory: SupervisorRun['memory'];
    try {
      memory = JSON.parse(await readFile(memoryPath, 'utf8')) as SupervisorRun['memory'];
    } catch {}
    return { messages, log, stderr, exitCode: exit.code, memory };
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
}

describe('supervisor runtime logging', () => {
  it('suppresses child output while preserving JSONL ready and stop control', async () => {
    const secret = 'api-key-value-should-not-be-logged';
    const rawStdout = 'RAW_STDOUT_SHOULD_NOT_BE_LOGGED';
    const rawStderr = 'RAW_STDERR_SHOULD_NOT_BE_LOGGED';
    const source = [
      `process.stdout.write(${JSON.stringify(`${rawStdout} Authorization: Bearer ${secret} C:\\Users\\Alice\\AppData\\Local\\dsh\\config.json\n`)});`,
      `process.stderr.write(${JSON.stringify(`${rawStderr} DEEPSEEK_API_KEY=${secret}\n`)});`,
      "process.stdout.write('dsh web: http://127.0.0.1:43123\\n');"
    ].join('\n');

    const result = await runSupervisor(source, true);
    const records = result.log.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const events = records.map(record => record.event);

    expect(result.messages.map(message => message.type)).toEqual(expect.arrayContaining(['hello', 'starting', 'ready', 'stopping']));
    expect(result.messages.find(message => message.type === 'ready')?.url).toBe('http://127.0.0.1:43123');
    expect(result.stderr).toBe('');
    expect(events).toEqual(expect.arrayContaining(['supervisor_boot', 'dsh_import_started', 'dsh_output_suppressed', 'dsh_ready', 'supervisor_stopping']));
    expect(records.every(record => Object.keys(record).every(key => ['timestamp', 'event', 'pid', 'stream', 'url', 'code'].includes(key)))).toBe(true);
    expect(result.log).not.toContain(rawStdout);
    expect(result.log).not.toContain(rawStderr);
    expect(result.log).not.toContain(secret);
    expect(result.log).not.toContain('Authorization');
    expect(result.log).not.toContain('DEEPSEEK_API_KEY');
    expect(result.log).not.toContain('C:\\Users\\Alice\\AppData\\Local\\dsh\\config.json');
  });

  it('does not compose split, interleaved stdout and stderr chunks into a false ready', async () => {
    const source = [
      "process.stdout.write('dsh web: http://127.');",
      "process.stderr.write('0.0.1:');",
      "process.stdout.write('431');",
      "process.stderr.write('23');",
      "process.stdout.write('\\n');"
    ].join('\n');

    const result = await runSupervisor(source, false, 200);
    const records = result.log.trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);

    expect(result.exitCode).toBe(0);
    expect(result.messages.some(message => message.type === 'ready')).toBe(false);
    expect(records.filter(record => record.event === 'dsh_output_suppressed').map(record => record.stream)).toEqual(expect.arrayContaining(['stdout', 'stderr']));
    expect(result.log).not.toContain('"event":"dsh_ready"');
  });

  it('bounds a single oversized no-newline output without logging its original text', async () => {
    const sentinel = 'OVERSIZED_OUTPUT_SENTINEL_SHOULD_NOT_BE_LOGGED';
    const source = [
      "const fs = await import('node:fs');",
      'if (typeof globalThis.gc === \'function\') globalThis.gc();',
      'const before = process.memoryUsage().heapUsed;',
      'function emitOversizedOutput() {',
      `  let payload = ${JSON.stringify(sentinel)} + 'x'.repeat(8 * 1024 * 1024);`,
      '  process.stdout.write(payload);',
      "  payload = '';",
      '}',
      'emitOversizedOutput();',
      'if (typeof globalThis.gc === \'function\') globalThis.gc();',
      'const after = process.memoryUsage().heapUsed;',
      "fs.writeFileSync(process.env.ADHD_MEMORY_REPORT, JSON.stringify({ before, after }));"
    ].join('\n');

    const result = await runSupervisor(source, false, 200);

    expect(result.exitCode).toBe(0);
    expect(result.messages.some(message => message.type === 'ready')).toBe(false);
    expect(result.memory).toBeDefined();
    expect((result.memory?.after ?? Number.POSITIVE_INFINITY) - (result.memory?.before ?? 0)).toBeLessThan(2 * 1024 * 1024);
    expect(result.log).not.toContain(sentinel);
    expect(result.log).not.toContain('x'.repeat(1024));
  });

  it('keeps fixed fatal codes without copying an import error into protocol or logs', async () => {
    const secret = 'fatal-api-key-value';
    const source = `throw new Error(${JSON.stringify(`Authorization: Bearer ${secret} C:\\Users\\Alice\\secret.txt`)});`;
    const result = await runSupervisor(source, false);
    const fatalCodes = result.messages.filter(message => message.type === 'fatal').map(message => message.code);

    expect(fatalCodes).toContain('DSH_BOOT_FAILED');
    expect(result.messages.some(message => message.message)).toBe(false);
    expect(result.log).not.toContain(secret);
    expect(result.log).not.toContain('Authorization');
    expect(result.log).not.toContain('C:\\Users\\Alice\\secret.txt');
    expect(result.log).toContain('"event":"supervisor_fatal"');
  });

  it('fails closed on an oversized complete control frame', async () => {
    const result = await runSupervisor('await new Promise(() => {});', false, 20, `${'x'.repeat(65_537)}\n`);

    expect(result.exitCode).toBe(1);
    expect(result.messages.filter(message => message.type === 'fatal').map(message => message.code)).toContain('CONTROL_FRAME_TOO_LARGE');
    expect(result.log).toContain('"event":"supervisor_fatal"');
  });

  it('classifies nested EADDRINUSE without copying the raw error', async () => {
    const source = [
      "const cause = Object.assign(new Error('secret address details'), { code: 'EADDRINUSE' });",
      "throw new Error('outer secret', { cause });"
    ].join('\n');
    const result = await runSupervisor(source, false);
    const fatalCodes = result.messages.filter(message => message.type === 'fatal').map(message => message.code);

    expect(fatalCodes).toContain('PORT_IN_USE');
    expect(result.messages.some(message => message.message)).toBe(false);
    expect(result.log).not.toContain('secret address details');
    expect(result.log).not.toContain('outer secret');
  });

  it('lets the imported DSH surface handle SIGTERM before the force-exit fallback', async () => {
    const source = [
      "process.on('SIGTERM', () => process.exit(23));",
      "process.stdout.write('dsh web: http://127.0.0.1:43123\\n');"
    ].join('\n');

    const result = await runSupervisor(source, true);

    expect(result.exitCode).toBe(23);
    expect(result.messages.map(message => message.type)).toEqual(expect.arrayContaining(['ready', 'stopping']));
  });
});
