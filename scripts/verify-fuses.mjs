import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import path from 'node:path';

const executable = path.resolve(process.argv[2] ?? 'dist/win-unpacked/ADHD One.exe');
const actual = await getCurrentFuseWire(executable);
const expected = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE]
]);

if (actual.version !== FuseVersion.V1) throw new Error(`Unexpected Fuse version: ${actual.version}`);
const keys = Object.keys(actual).sort();
const expectedKeys = [...expected.keys()].map(String).concat('version').sort();
if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) throw new Error(`Unexpected Fuse keys: ${keys.join(',')}`);
for (const [key, value] of expected) {
  if (actual[key] !== value) throw new Error(`Fuse ${FuseV1Options[key]} expected ${value}, got ${actual[key]}`);
}
console.log(`FUSES_OK ${path.basename(executable)}`);
