import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const required = ['ADHD_NONCE', 'ADHD_GENERATION', 'ADHD_DSH_ENTRY', 'ADHD_LOG'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);

const generation = Number(process.env.ADHD_GENERATION);
const nonce = process.env.ADHD_NONCE;
const log = fs.createWriteStream(process.env.ADHD_LOG, { flags: 'a' });
const writeStatus = process.stdout.write.bind(process.stdout);

const MAX_OUTPUT_BUFFER = 65_536;
const MAX_CONTROL_FRAME_BYTES = 65_536;
const READY_LINE = /^dsh web:\s+(http:\/\/(?:127\.0\.0\.1|localhost):\d+)\s*$/u;
const FATAL_CODES = new Set(['SUPERVISOR_UNCAUGHT', 'SUPERVISOR_REJECTION', 'DSH_BOOT_FAILED', 'PORT_IN_USE', 'CONTROL_FRAME_TOO_LARGE']);
const LOG_SCHEMA = Object.freeze({
  supervisor_boot: Object.freeze({ pid: value => Number.isInteger(value) }),
  dsh_import_started: Object.freeze({}),
  dsh_output_suppressed: Object.freeze({ stream: value => value === 'stdout' || value === 'stderr' }),
  dsh_ready: Object.freeze({ url: value => typeof value === 'string' && READY_LINE.test(value) }),
  supervisor_stopping: Object.freeze({}),
  supervisor_fatal: Object.freeze({ code: value => FATAL_CODES.has(value) })
});

function logEvent(event, details = {}) {
  const schema = LOG_SCHEMA[event];
  if (!schema) return;
  const record = { timestamp: new Date().toISOString(), event };
  for (const [field, isAllowed] of Object.entries(schema)) {
    const value = details[field];
    if (isAllowed(value)) record[field] = value;
  }
  log.write(`${JSON.stringify(record)}\n`);
}

logEvent('supervisor_boot', { pid: process.pid });

function send(payload) {
  writeStatus(`${JSON.stringify({ v: 1, generation, ...payload })}\n`);
}

const outputBuffers = new Map([
  ['stdout', ''],
  ['stderr', '']
]);
const suppressedStreams = new Set();
function captureDshOutput(kind, chunk) {
  if (!suppressedStreams.has(kind)) {
    suppressedStreams.add(kind);
    logEvent('dsh_output_suppressed', { stream: kind });
  }

  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  let buffered = `${outputBuffers.get(kind) ?? ''}${text}`;
  const lines = buffered.split(/\r?\n/u);
  buffered = lines.pop() ?? '';
  if (kind === 'stdout') {
    for (const line of lines) {
      const match = READY_LINE.exec(line.trim());
      if (!match?.[1]) continue;
      logEvent('dsh_ready', { url: match[1] });
      send({ type: 'ready', url: match[1] });
    }
  }
  if (buffered.length > MAX_OUTPUT_BUFFER) {
    // Force a compact copy: V8 substring views can otherwise retain the entire
    // multi-megabyte DSH output chunk behind this 64 KiB tail.
    buffered = Buffer.from(buffered.slice(-MAX_OUTPUT_BUFFER), 'utf8').toString('utf8');
  }
  outputBuffers.set(kind, buffered);
  return true;
}

process.stdout.write = ((chunk) => captureDshOutput('stdout', chunk));
process.stderr.write = ((chunk) => captureDshOutput('stderr', chunk));

let exitRequested = false;
let stoppingRequested = false;
function closeLogAndExit(code) {
  if (exitRequested) return;
  exitRequested = true;
  log.end(() => process.exit(code));
  setTimeout(() => process.exit(code), 1_000).unref();
}

function sendFatal(code) {
  if (exitRequested) return;
  logEvent('supervisor_fatal', { code });
  send({ type: 'fatal', code });
}

function errorChainHasCode(error, code) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (current.code === code) return true;
    current = current.cause;
  }
  return false;
}

let inbound = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  inbound += chunk;
  for (;;) {
    const newline = inbound.indexOf('\n');
    if (newline < 0) break;
    const raw = inbound.slice(0, newline); inbound = inbound.slice(newline + 1);
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_FRAME_BYTES) {
      inbound = '';
      sendFatal('CONTROL_FRAME_TOO_LARGE');
      closeLogAndExit(1);
      return;
    }
    try {
      const message = JSON.parse(raw);
      if (message.nonce !== nonce || message.generation !== generation) continue;
      if (message.type === 'stop') {
        if (stoppingRequested) continue;
        stoppingRequested = true;
        logEvent('supervisor_stopping');
        send({ type: 'stopping' });
        if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM');
        else closeLogAndExit(0);
        setTimeout(() => closeLogAndExit(0), 4_500).unref();
      }
    } catch {}
  }
  if (Buffer.byteLength(inbound, 'utf8') > MAX_CONTROL_FRAME_BYTES) {
    inbound = '';
    sendFatal('CONTROL_FRAME_TOO_LARGE');
    closeLogAndExit(1);
  }
});
process.stdin.resume();
send({ type: 'hello', nonce, pid: process.pid });
send({ type: 'starting' });
logEvent('dsh_import_started');

process.on('uncaughtException', () => {
  sendFatal('SUPERVISOR_UNCAUGHT');
  closeLogAndExit(1);
});
process.on('unhandledRejection', () => {
  sendFatal('SUPERVISOR_REJECTION');
  closeLogAndExit(1);
});

process.argv = [process.execPath, process.env.ADHD_DSH_ENTRY, 'web', '--host', '127.0.0.1', '--port', process.env.ADHD_PORT ?? '0'];
try {
  await import(pathToFileURL(process.env.ADHD_DSH_ENTRY).href);
} catch (error) {
  sendFatal(errorChainHasCode(error, 'EADDRINUSE') ? 'PORT_IN_USE' : 'DSH_BOOT_FAILED');
  throw error;
}
