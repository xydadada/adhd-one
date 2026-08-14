/** Win32 process/job launcher adapted from DeepSeek Harness sandbox-windows-acl (MIT), commit 47f943859b. */
import koffi from 'koffi';

const CREATE_SUSPENDED = 0x00000004;
const CREATE_NEW_CONSOLE = 0x00000010;
const CREATE_NEW_PROCESS_GROUP = 0x00000200;
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESHOWWINDOW = 0x00000001;
const SW_HIDE = 0;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;

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
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].includes('='))
    .sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  return Buffer.from(`${entries.map(([key, value]) => `${key}=${value}`).join('\0')}\0\0`, 'utf16le');
}

interface NativeBindings {
  createJobObjectW: (attributes: null, name: null) => bigint | null;
  setInformationJobObject: (job: bigint, infoClass: number, data: Buffer, length: number) => number;
  createProcessW: (...args: unknown[]) => number;
  assignProcessToJobObject: (job: bigint, process: bigint) => number;
  resumeThread: (thread: bigint) => number;
  terminateProcess: (process: bigint, code: number) => number;
  terminateJobObject: (job: bigint, code: number) => number;
  closeHandle: (handle: bigint) => number;
  waitForSingleObject: (handle: bigint, timeout: number) => number;
  getExitCodeProcess: (handle: bigint, code: Buffer) => number;
  getLastError: () => number;
}

let cachedBindings: NativeBindings | undefined;
function bindings(): NativeBindings {
  if (cachedBindings) return cachedBindings;
  if (process.platform !== 'win32') throw new Error('WINDOWS_PLATFORM_REQUIRED');
  const kernel = koffi.load('kernel32.dll');
  cachedBindings = {
    createJobObjectW: kernel.func('void * __stdcall CreateJobObjectW(void *, str16)') as NativeBindings['createJobObjectW'],
    setInformationJobObject: kernel.func('int __stdcall SetInformationJobObject(void *, int, void *, uint32)') as NativeBindings['setInformationJobObject'],
    createProcessW: kernel.func('int __stdcall CreateProcessW(str16, void *, void *, void *, int, uint32, void *, str16, void *, void *)') as NativeBindings['createProcessW'],
    assignProcessToJobObject: kernel.func('int __stdcall AssignProcessToJobObject(void *, void *)') as NativeBindings['assignProcessToJobObject'],
    resumeThread: kernel.func('uint32 __stdcall ResumeThread(void *)') as NativeBindings['resumeThread'],
    terminateProcess: kernel.func('int __stdcall TerminateProcess(void *, uint32)') as NativeBindings['terminateProcess'],
    terminateJobObject: kernel.func('int __stdcall TerminateJobObject(void *, uint32)') as NativeBindings['terminateJobObject'],
    closeHandle: kernel.func('int __stdcall CloseHandle(void *)') as NativeBindings['closeHandle'],
    waitForSingleObject: kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)') as NativeBindings['waitForSingleObject'],
    getExitCodeProcess: kernel.func('int __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)') as NativeBindings['getExitCodeProcess'],
    getLastError: kernel.func('uint32 __stdcall GetLastError()') as NativeBindings['getLastError']
  };
  return cachedBindings;
}

function pointerFrom(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

export interface ManagedProcess {
  pid: number;
  wait(): Promise<number>;
  terminate(exitCode?: number): void;
  close(): void;
}

export function createManagedProcess(options: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ManagedProcess {
  const api = bindings();
  const job = api.createJobObjectW(null, null);
  if (!job || job === 0n) throw new Error(`CreateJobObjectW failed: ${api.getLastError()}`);
  const jobInfo = Buffer.alloc(144);
  jobInfo.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (!api.setInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, jobInfo, jobInfo.length)) {
    const code = api.getLastError(); api.closeHandle(job); throw new Error(`SetInformationJobObject failed: ${code}`);
  }

  const startup = Buffer.alloc(104);
  startup.writeUInt32LE(104, 0);
  startup.writeUInt32LE(STARTF_USESHOWWINDOW, 60);
  startup.writeUInt16LE(SW_HIDE, 64);
  const info = Buffer.alloc(24);
  const command = Buffer.from(`${buildWindowsCommandLine(options.executable, options.args)}\0`, 'utf16le');
  const environment = buildUnicodeEnvironment(options.env);
  const flags = CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT;
  const created = api.createProcessW(
    options.executable, command, null, null, 0, flags, environment, options.cwd, startup, info
  );
  if (!created) {
    const code = api.getLastError(); api.closeHandle(job); throw new Error(`CreateProcessW failed: ${code}`);
  }
  const processHandle = pointerFrom(info, 0);
  const threadHandle = pointerFrom(info, 8);
  const pid = info.readUInt32LE(16);
  if (!processHandle || !threadHandle) {
    api.closeHandle(job); throw new Error('CreateProcessW returned invalid handles');
  }
  if (!api.assignProcessToJobObject(job, processHandle)) {
    const code = api.getLastError();
    api.terminateProcess(processHandle, 1);
    api.closeHandle(threadHandle); api.closeHandle(processHandle); api.closeHandle(job);
    throw new Error(`AssignProcessToJobObject failed: ${code}`);
  }
  if (api.resumeThread(threadHandle) === 0xFFFFFFFF) {
    const code = api.getLastError();
    api.closeHandle(threadHandle); api.closeHandle(processHandle); api.closeHandle(job);
    throw new Error(`ResumeThread failed: ${code}`);
  }
  api.closeHandle(threadHandle);
  let closed = false;
  return {
    pid,
    async wait() {
      for (;;) {
        const result = api.waitForSingleObject(processHandle, 0);
        if (result === WAIT_OBJECT_0) break;
        if (result !== WAIT_TIMEOUT) throw new Error(`WaitForSingleObject failed: ${api.getLastError()}`);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const code = Buffer.alloc(4);
      if (!api.getExitCodeProcess(processHandle, code)) throw new Error(`GetExitCodeProcess failed: ${api.getLastError()}`);
      return code.readUInt32LE(0);
    },
    terminate(exitCode = 1) { api.terminateJobObject(job, exitCode); },
    close() {
      if (closed) return;
      closed = true;
      api.closeHandle(processHandle);
      api.closeHandle(job);
    }
  };
}
