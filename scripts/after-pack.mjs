import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pruneRuntime } from './prune-runtime.mjs';

export default async function afterPack(context) {
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  });

  const locales = path.join(context.appOutDir, 'locales');
  const keep = new Set(['zh-CN.pak', 'en-US.pak']);
  for (const entry of await fs.readdir(locales)) {
    if (!keep.has(entry)) await fs.rm(path.join(locales, entry), { force: true });
  }

  const runtime = path.join(context.appOutDir, 'resources', 'dsh-runtime');
  if (await fs.stat(runtime).then(value => value.isDirectory()).catch(() => false)) await pruneRuntime(runtime);
}
