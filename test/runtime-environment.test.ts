import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeController, type RuntimeEnvironmentOptions, type RuntimePaths } from '../src/runtime-controller.js';

type RuntimeEnvironmentInput = RuntimeEnvironmentOptions | NodeJS.ProcessEnv;

type RuntimeControllerInternals = {
  runtimeEnvironment(input: {
    runtimeRoot: string;
    binPath: string;
    nonce: string;
    generation: number;
    dshEntry: string;
    logPath: string;
    port: number;
    node: string;
  }): NodeJS.ProcessEnv;
};

const runtimeInput = {
  runtimeRoot: 'C:\\runtime',
  binPath: 'C:\\runtime\\bin',
  nonce: 'test-nonce',
  generation: 7,
  dshEntry: 'C:\\runtime\\entry.mjs',
  logPath: 'C:\\logs\\runtime.log',
  port: 43123,
  node: 'C:\\runtime-node\\node.exe'
};

function createController(environment?: RuntimeEnvironmentInput): RuntimeController {
  const settings = {
    get: () => ({ workspace: 'C:\\workspace', preferredPort: 43123 }),
    update: async () => undefined
  };
  const paths: RuntimePaths = {
    appPath: 'C:\\app',
    resourcesPath: 'C:\\resources',
    packaged: false,
    dshHome: 'C:\\data\\dsh',
    logs: 'C:\\data\\logs',
    runtimes: 'C:\\data\\runtimes'
  };
  return environment === undefined
    ? new RuntimeController(settings as never, paths)
    : new RuntimeController(settings as never, paths, environment);
}

function runtimeEnvironment(controller: RuntimeController): NodeJS.ProcessEnv {
  return (controller as unknown as RuntimeControllerInternals).runtimeEnvironment(runtimeInput);
}

function withProcessEnvironment<T>(values: NodeJS.ProcessEnv, operation: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return operation();
  } finally {
    for (const key of Object.keys(values)) {
      delete process.env[key];
      const value = previous.get(key);
      if (value !== undefined) process.env[key] = value;
    }
  }
}

describe('RuntimeController environment construction', () => {
  it('inherits process.env in production and keeps the legacy third argument working', () => {
    withProcessEnvironment({ RUNTIME_CONTROLLER_INHERITED: 'from-process' }, () => {
      const environment = runtimeEnvironment(createController({
        overrides: { RUNTIME_CONTROLLER_OPTIONS: 'from-options' }
      }));
      const legacyEnvironment = runtimeEnvironment(createController({ RUNTIME_CONTROLLER_LEGACY: 'from-legacy-call' }));

      expect(environment.RUNTIME_CONTROLLER_INHERITED).toBe('from-process');
      expect(environment.RUNTIME_CONTROLLER_OPTIONS).toBe('from-options');
      expect(legacyEnvironment.RUNTIME_CONTROLLER_LEGACY).toBe('from-legacy-call');
    });
  });

  it('builds isolated runtime env from the Windows allowlist and keeps fixed vars last', () => {
    withProcessEnvironment({
      HOME: 'C:\\secret\\home',
      APPDATA: 'C:\\secret\\appdata',
      LOCALAPPDATA: 'C:\\secret\\localappdata',
      HTTP_PROXY: 'http://proxy.invalid:8080',
      HTTPS_PROXY: 'https://proxy.invalid:8443',
      ALL_PROXY: 'socks5://proxy.invalid:1080',
      NO_PROXY: 'proxy.invalid',
      DSH_INHERITED: 'must-not-inherit',
      NODE_OPTIONS: '--require C:\\secret\\hook.js',
      NODE_PATH: 'C:\\secret\\node_modules',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      NPM_CONFIG_USERCONFIG: 'C:\\secret\\npmrc',
      PNPM_HOME: 'C:\\secret\\pnpm',
      GIT_CONFIG_GLOBAL: 'C:\\secret\\gitconfig',
      ADHD_SMOKE_DATA_ROOT: 'C:\\secret\\smoke-root',
      DEEPSEEK_API_KEY: 'provider-secret',
      OPENAI_API_KEY: 'provider-secret'
    }, () => {
      const environment = runtimeEnvironment(createController({
        isolatedEnv: true,
        overrides: {
          adhd_node_exe: 'C:\\attacker\\node.exe',
          dsh_home: 'C:\\attacker\\dsh',
          ADHD_PORT: '9999'
        }
      }));
      const inheritedSystemRoot = process.env.SystemRoot ?? process.env.windir;
      const systemRoot = inheritedSystemRoot ?? 'C:\\Windows';

      for (const key of [
        'HOME', 'APPDATA', 'LOCALAPPDATA', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
        'DSH_INHERITED', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
        'NPM_CONFIG_USERCONFIG', 'PNPM_HOME', 'GIT_CONFIG_GLOBAL', 'ADHD_SMOKE_DATA_ROOT',
        'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'
      ]) expect(environment[key]).toBeUndefined();

      if (inheritedSystemRoot === undefined) {
        expect(environment.SystemRoot).toBeUndefined();
        expect(environment.windir).toBeUndefined();
      } else {
        expect(environment.SystemRoot ?? environment.windir).toBe(inheritedSystemRoot);
      }
      expect(environment.PATH).toBe([
        runtimeInput.binPath,
        path.win32.dirname(runtimeInput.node),
        path.win32.join(systemRoot, 'System32')
      ].join(';'));
      expect(environment.ADHD_NODE_EXE).toBe(runtimeInput.node);
      expect(environment.DSH_HOME).toBe('C:\\data\\dsh');
      expect(environment.ADHD_PORT).toBe(String(runtimeInput.port));
    });
  });

  it('deletes overrides case-insensitively when their value is undefined', () => {
    withProcessEnvironment({ RuntimeControllerCaseDelete: 'present' }, () => {
      const environment = runtimeEnvironment(createController({
        overrides: { RUNTIMECONTROLLERCASEDELETE: undefined }
      }));

      expect(Object.keys(environment).some(key => key.toLowerCase() === 'runtimecontrollercasedelete')).toBe(false);
    });
  });
});
