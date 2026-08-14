/** Win32 process/job launcher adapted from DeepSeek Harness sandbox-windows-acl (MIT), commit 47f943859b. */
import koffi from 'koffi';
import { lstatSync } from 'node:fs';
import path from 'node:path';

const CREATE_SUSPENDED = 0x00000004;
const CREATE_NEW_CONSOLE = 0x00000010;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESHOWWINDOW = 0x00000001;
const STARTF_USESTDHANDLES = 0x00000100;
const SW_HIDE = 0;
const HANDLE_FLAG_INHERIT = 0x00000001;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;

export function quoteWindowsArg(argument: string): string {
  if (argument === '') return '""';
  if (!/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  for (let index = 0; index < argument.length; index++) {
    let backslashes = 0;
    while (index < argument.length && argument.charAt(index) === '\\') { backslashes++; index++; }
    if (index === argument.length) quoted += '\\'.repeat(backslashes * 2);
    else if (argument.charAt(index) === '"') quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
    else quoted += '\\'.repeat(backslashes) + argument.charAt(index);
  }
  return `${quoted}"`;
}

export function buildWindowsCommandLine(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteWindowsArg).join(' ');
}

export function buildUnicodeEnvironment(environment: NodeJS.ProcessEnv): Buffer {
  const entries = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && (!entry[0].includes('=') || /^=[a-z]:$/iu.test(entry[0])));
  for (const [key, value] of entries) if (key.includes('\0') || value.includes('\0')) throw new Error('ENVIRONMENT_CONTAINS_NUL');
  entries.sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return Buffer.from(`${entries.map(([key, value]) => `${key}=${value}`).join('\0')}\0\0`, 'utf16le');
}

interface NativeBindings {
  createJobObjectW: (attributes: null, name: null) => bigint | null;
  setInformationJobObject: (job: bigint, infoClass: number, data: Buffer, length: number) => number;
  queryInformationJobObject: (job: bigint, infoClass: number, data: Buffer, length: number, returnedLength: Buffer) => number;
  createProcessW: (...args: unknown[]) => number;
  assignProcessToJobObject: (job: bigint, process: bigint) => number;
  resumeThread: (thread: bigint) => number;
  terminateProcess: (process: bigint, code: number) => number;
  terminateJobObject: (job: bigint, code: number) => number;
  closeHandle: (handle: bigint) => number;
  waitForSingleObject: (handle: bigint, timeout: number) => number;
  getExitCodeProcess: (handle: bigint, code: Buffer) => number;
  createPipe: (read: bigint, write: bigint, attributes: null, size: number) => number;
  setHandleInformation: (handle: bigint, mask: number, flags: number) => number;
  peekNamedPipe: (pipe: bigint, buffer: null, size: number, bytesRead: Buffer, available: Buffer, left: Buffer) => number;
  readFile: (file: bigint, buffer: Buffer, size: number, bytesRead: Buffer, overlapped: null) => number;
  writeFile: (file: bigint, buffer: Buffer, size: number, bytesWritten: Buffer, overlapped: null) => number;
  getLastError: () => number;
  getFileAttributesW: (name: string) => number;
}

let cachedBindings: NativeBindings | undefined;
function bindings(): NativeBindings {
  if (cachedBindings) return cachedBindings;
  if (process.platform !== 'win32') throw new Error('WINDOWS_PLATFORM_REQUIRED');
  const kernel = koffi.load('kernel32.dll');
  const pointer = koffi.pointer('void');
  const pointerPointer = koffi.pointer(pointer);
  cachedBindings = {
    createJobObjectW: kernel.func('void * __stdcall CreateJobObjectW(void *, str16)') as NativeBindings['createJobObjectW'],
    setInformationJobObject: kernel.func('int __stdcall SetInformationJobObject(void *, int, void *, uint32)') as NativeBindings['setInformationJobObject'],
    queryInformationJobObject: kernel.func('int __stdcall QueryInformationJobObject(void *, int, void *, uint32, uint32 *)') as NativeBindings['queryInformationJobObject'],
    createProcessW: kernel.func('int __stdcall CreateProcessW(str16, void *, void *, void *, int, uint32, void *, str16, void *, void *)') as NativeBindings['createProcessW'],
    assignProcessToJobObject: kernel.func('int __stdcall AssignProcessToJobObject(void *, void *)') as NativeBindings['assignProcessToJobObject'],
    resumeThread: kernel.func('uint32 __stdcall ResumeThread(void *)') as NativeBindings['resumeThread'],
    terminateProcess: kernel.func('int __stdcall TerminateProcess(void *, uint32)') as NativeBindings['terminateProcess'],
    terminateJobObject: kernel.func('int __stdcall TerminateJobObject(void *, uint32)') as NativeBindings['terminateJobObject'],
    closeHandle: kernel.func('int __stdcall CloseHandle(void *)') as NativeBindings['closeHandle'],
    waitForSingleObject: kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)') as NativeBindings['waitForSingleObject'],
    getExitCodeProcess: kernel.func('int __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)') as NativeBindings['getExitCodeProcess'],
    createPipe: kernel.func('__stdcall', 'CreatePipe', 'int', [pointerPointer, pointerPointer, pointer, 'uint32']) as NativeBindings['createPipe'],
    setHandleInformation: kernel.func('__stdcall', 'SetHandleInformation', 'int', [pointer, 'uint32', 'uint32']) as NativeBindings['setHandleInformation'],
    peekNamedPipe: kernel.func('__stdcall', 'PeekNamedPipe', 'int', [pointer, pointer, 'uint32', koffi.pointer('uint32'), koffi.pointer('uint32'), koffi.pointer('uint32')]) as NativeBindings['peekNamedPipe'],
    readFile: kernel.func('__stdcall', 'ReadFile', 'int', [pointer, pointer, 'uint32', koffi.pointer('uint32'), pointer]) as NativeBindings['readFile'],
    writeFile: kernel.func('__stdcall', 'WriteFile', 'int', [pointer, pointer, 'uint32', koffi.pointer('uint32'), pointer]) as NativeBindings['writeFile'],
    getLastError: kernel.func('uint32 __stdcall GetLastError()') as NativeBindings['getLastError'],
    getFileAttributesW: kernel.func('uint32 __stdcall GetFileAttributesW(str16)') as NativeBindings['getFileAttributesW']
  };
  return cachedBindings;
}

function win32ApiPath(value: string): string {
  const absolute = path.resolve(value);
  if (absolute.startsWith('\\\\?\\')) return absolute;
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`;
  return `\\\\?\\${absolute}`;
}

/** Fail-closed check for symlinks, junctions and all other existing reparse components. */
export function assertNoWindowsReparseComponents(target: string): void {
  if (process.platform !== 'win32') return;
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const components = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index <= components.length; index++) {
    if (index > 0) current = path.join(current, components[index - 1]!);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) break;
    if (info.isSymbolicLink() || (index < components.length && !info.isDirectory())) throw new Error('WINDOWS_REPARSE_COMPONENT_REFUSED');
    const attributes = bindings().getFileAttributesW(win32ApiPath(current));
    if (attributes === INVALID_FILE_ATTRIBUTES) throw new Error('WINDOWS_FILE_ATTRIBUTE_CHECK_FAILED');
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) throw new Error('WINDOWS_REPARSE_COMPONENT_REFUSED');
  }
}

function pointerFrom(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

function createPipe(api: NativeBindings): { read: bigint; write: bigint } {
  const pointer = koffi.pointer('void');
  const readSlot = koffi.alloc(pointer, 1) as unknown as bigint;
  const writeSlot = koffi.alloc(pointer, 1) as unknown as bigint;
  if (!api.createPipe(readSlot, writeSlot, null, 0)) throw new Error(`CreatePipe failed: ${api.getLastError()}`);
  const read = koffi.decode(readSlot, pointer) as bigint | null;
  const write = koffi.decode(writeSlot, pointer) as bigint | null;
  if (!read || !write) throw new Error('CreatePipe returned invalid handles');
  return { read, write };
}

export interface ManagedProcess {
  pid: number;
  wait(): Promise<number>;
  write(value: string): void;
  readAvailable(): Buffer;
  terminate(exitCode?: number): void;
  activeProcessCount(): number;
  waitForTreeExit(timeoutMs: number): Promise<boolean>;
  close(): void;
}

export function createManagedProcess(options: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ManagedProcess {
  const api = bindings();
  const command = Buffer.from(`${buildWindowsCommandLine(options.executable, options.args)}\0`, 'utf16le');
  const environment = buildUnicodeEnvironment(options.env);
  const flags = CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT;
  const job = api.createJobObjectW(null, null);
  if (!job || job === 0n) throw new Error(`CreateJobObjectW failed: ${api.getLastError()}`);
  const jobInfo = Buffer.alloc(144);
  jobInfo.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (!api.setInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, jobInfo, jobInfo.length)) {
    const code = api.getLastError(); api.closeHandle(job); throw new Error(`SetInformationJobObject failed: ${code}`);
  }

  let input: { read: bigint; write: bigint } | undefined;
  let output: { read: bigint; write: bigint } | undefined;
  try {
    input = createPipe(api);
    output = createPipe(api);
  } catch (error) {
    if (input) { api.closeHandle(input.read); api.closeHandle(input.write); }
    if (output) { api.closeHandle(output.read); api.closeHandle(output.write); }
    api.closeHandle(job);
    throw error;
  }
  const closePipes = (): void => {
    api.closeHandle(input.read); api.closeHandle(input.write);
    api.closeHandle(output.read); api.closeHandle(output.write);
  };
  if (!api.setHandleInformation(input.read, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
    || !api.setHandleInformation(output.write, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
    const code = api.getLastError(); closePipes(); api.closeHandle(job); throw new Error(`SetHandleInformation failed: ${code}`);
  }

  const startup = Buffer.alloc(104);
  startup.writeUInt32LE(104, 0);
  startup.writeUInt32LE(STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES, 60);
  startup.writeUInt16LE(SW_HIDE, 64);
  startup.writeBigUInt64LE(input.read, 80);
  startup.writeBigUInt64LE(output.write, 88);
  startup.writeBigUInt64LE(output.write, 96);
  const info = Buffer.alloc(24);
  let created: number;
  try {
    created = api.createProcessW(options.executable, command, null, null, 1, flags, environment, options.cwd, startup, info);
  } catch (error) {
    closePipes(); api.closeHandle(job); throw error;
  }
  api.setHandleInformation(input.read, HANDLE_FLAG_INHERIT, 0);
  api.setHandleInformation(output.write, HANDLE_FLAG_INHERIT, 0);
  if (!created) {
    const code = api.getLastError(); closePipes(); api.closeHandle(job); throw new Error(`CreateProcessW failed: ${code}`);
  }
  api.closeHandle(input.read);
  api.closeHandle(output.write);
  const processHandle = pointerFrom(info, 0);
  const threadHandle = pointerFrom(info, 8);
  const pid = info.readUInt32LE(16);
  if (!processHandle || !threadHandle) {
    if (processHandle) { api.terminateProcess(processHandle, 1); api.waitForSingleObject(processHandle, 5_000); }
    if (threadHandle) api.closeHandle(threadHandle);
    if (processHandle) api.closeHandle(processHandle);
    api.closeHandle(input.write); api.closeHandle(output.read); api.closeHandle(job); throw new Error('CreateProcessW returned invalid handles');
  }
  if (!api.assignProcessToJobObject(job, processHandle)) {
    const code = api.getLastError();
    api.terminateProcess(processHandle, 1);
    api.waitForSingleObject(processHandle, 5_000);
    api.closeHandle(input.write); api.closeHandle(output.read); api.closeHandle(threadHandle); api.closeHandle(processHandle); api.closeHandle(job);
    throw new Error(`AssignProcessToJobObject failed: ${code}`);
  }
  if (api.resumeThread(threadHandle) === 0xFFFFFFFF) {
    const code = api.getLastError();
    api.terminateProcess(processHandle, 1);
    api.waitForSingleObject(processHandle, 5_000);
    api.closeHandle(input.write); api.closeHandle(output.read); api.closeHandle(threadHandle); api.closeHandle(processHandle); api.closeHandle(job);
    throw new Error(`ResumeThread failed: ${code}`);
  }
  api.closeHandle(threadHandle);
  let closed = false;
  let processHandleClosed = false;
  const closeProcessHandle = (): void => {
    if (processHandleClosed) return;
    processHandleClosed = true;
    api.closeHandle(processHandle);
  };
  const exitPromise = (async (): Promise<number> => {
    for (;;) {
      const result = api.waitForSingleObject(processHandle, 0);
      if (result === WAIT_OBJECT_0) break;
      if (result !== WAIT_TIMEOUT) throw new Error(`WaitForSingleObject failed: ${api.getLastError()}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const code = Buffer.alloc(4);
    if (!api.getExitCodeProcess(processHandle, code)) throw new Error(`GetExitCodeProcess failed: ${api.getLastError()}`);
    return code.readUInt32LE(0);
  })();
  void exitPromise.catch(() => undefined);
  return {
    pid,
    wait() { return exitPromise; },
    write(value: string) {
      if (closed) throw new Error('PROCESS_PIPE_CLOSED');
      const data = Buffer.from(value, 'utf8');
      if (data.length > 65_536) throw new Error('PROCESS_PIPE_FRAME_TOO_LARGE');
      const written = Buffer.alloc(4);
      if (!api.writeFile(input.write, data, data.length, written, null) || written.readUInt32LE(0) !== data.length) {
        throw new Error(`WriteFile failed: ${api.getLastError()}`);
      }
    },
    readAvailable() {
      if (closed) return Buffer.alloc(0);
      const chunks: Buffer[] = [];
      for (;;) {
        const bytesRead = Buffer.alloc(4); const available = Buffer.alloc(4); const left = Buffer.alloc(4);
        if (!api.peekNamedPipe(output.read, null, 0, bytesRead, available, left)) {
          const code = api.getLastError();
          if (code === 109 || code === 232) break;
          throw new Error(`PeekNamedPipe failed: ${code}`);
        }
        const size = available.readUInt32LE(0);
        if (size === 0) break;
        const chunk = Buffer.alloc(Math.min(size, 65_536)); const count = Buffer.alloc(4);
        if (!api.readFile(output.read, chunk, chunk.length, count, null)) throw new Error(`ReadFile failed: ${api.getLastError()}`);
        chunks.push(chunk.subarray(0, count.readUInt32LE(0)));
      }
      return Buffer.concat(chunks);
    },
    terminate(exitCode = 1) { api.terminateJobObject(job, exitCode); },
    activeProcessCount() {
      if (closed) throw new Error('PROCESS_JOB_CLOSED');
      const accounting = Buffer.alloc(48);
      const returnedLength = Buffer.alloc(4);
      if (!api.queryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, accounting, accounting.length, returnedLength)) {
        throw new Error(`QueryInformationJobObject failed: ${api.getLastError()}`);
      }
      return accounting.readUInt32LE(40);
    },
    async waitForTreeExit(timeoutMs: number) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        if (this.activeProcessCount() === 0) return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
      }
    },
    close() {
      if (closed) return;
      closed = true;
      api.closeHandle(input.write);
      api.closeHandle(output.read);
      api.closeHandle(job);
      void exitPromise.then(closeProcessHandle, closeProcessHandle);
    }
  };
}
