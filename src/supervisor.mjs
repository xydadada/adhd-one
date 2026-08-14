import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const required = ['ADHD_PIPE', 'ADHD_NONCE', 'ADHD_GENERATION', 'ADHD_DSH_ENTRY', 'ADHD_LOG'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);

const generation = Number(process.env.ADHD_GENERATION);
const nonce = process.env.ADHD_NONCE;
const log = fs.createWriteStream(process.env.ADHD_LOG, { flags: 'a' });
let socket;
let buffered = '';
log.write(`[${new Date().toISOString()}] supervisor boot pid=${process.pid}\n`);

function send(payload) {
  if (socket?.writable) socket.write(`${JSON.stringify({ v: 1, generation, ...payload })}\n`);
}

function writeLog(kind, chunk) {
  const text = String(chunk);
  log.write(`[${new Date().toISOString()}] ${kind} ${text}`);
  buffered += text;
  const lines = buffered.split(/\r?\n/u);
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    const match = /^dsh web:\s+(http:\/\/(?:127\.0\.0\.1|localhost):\d+)\s*$/u.exec(line.trim());
    if (match?.[1]) send({ type: 'ready', url: match[1] });
  }
  return true;
}

process.stdout.write = ((chunk) => writeLog('stdout', chunk));
process.stderr.write = ((chunk) => writeLog('stderr', chunk));

socket = net.createConnection(process.env.ADHD_PIPE);
socket.setEncoding('utf8');
socket.on('connect', () => {
  log.write(`[${new Date().toISOString()}] supervisor pipe-connected\n`);
  send({ type: 'hello', nonce, pid: process.pid });
  send({ type: 'starting' });
});
let inbound = '';
socket.on('data', chunk => {
  inbound += chunk;
  for (;;) {
    const newline = inbound.indexOf('\n');
    if (newline < 0) break;
    const raw = inbound.slice(0, newline); inbound = inbound.slice(newline + 1);
    if (raw.length > 65_536) continue;
    try {
      const message = JSON.parse(raw);
      if (message.nonce !== nonce || message.generation !== generation) continue;
      if (message.type === 'stop') {
        send({ type: 'stopping' });
        process.emit('SIGTERM', 'SIGTERM');
      }
    } catch {}
  }
});

process.on('uncaughtException', error => {
  send({ type: 'fatal', code: 'SUPERVISOR_UNCAUGHT', message: String(error?.message ?? error) });
  log.end();
  process.exit(1);
});
process.on('unhandledRejection', error => {
  send({ type: 'fatal', code: 'SUPERVISOR_REJECTION', message: String(error) });
  log.end();
  process.exit(1);
});

process.argv = [process.execPath, process.env.ADHD_DSH_ENTRY, 'web', '--host', '127.0.0.1', '--port', process.env.ADHD_PORT ?? '0'];
try {
  log.write(`[${new Date().toISOString()}] supervisor importing-dsh\n`);
  await import(pathToFileURL(process.env.ADHD_DSH_ENTRY).href);
} catch (error) {
  send({ type: 'fatal', code: 'DSH_BOOT_FAILED', message: String(error?.message ?? error) });
  throw error;
}
