# Third-party notices

ADHD One is MIT licensed. The provenance records below deliberately distinguish adapted source code from the npm package that is shipped at runtime.

## DeepSeek provenance

| Material | Version / immutable metadata | License | Role and boundary |
|---|---|---|---|
| DeepSeek Harness adapted source | `deepseek-ai/DeepSeek-Harness@47f943859bef60e4160492346772ded9b24f765a`; corresponds to upstream `0.1.0-rc.5` | MIT | Source for the small RPC, launch and atomic-write adaptations. This commit is code provenance only; it is not an npm provenance record. |
| `@deepseek-ai/dsh` npm runtime | npm version `0.1.0-rc.6`; integrity `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==`; published `2026-08-13T12:35:03.812Z` | MIT | Shipped runtime package. Its provenance is represented by the npm version, integrity and published metadata above, not by the adapted-source commit. |

## Direct production dependencies

The following are direct package metadata records from `package-lock.json`; the complete transitive list is generated from physical package directories in [`build/licenses/license-closure.json`](build/licenses/license-closure.json).

| Package | Version | License | Shipped role |
|---|---:|---|---|
| `@deepseek-ai/dsh-llm-mock-server` | `0.1.0-rc.6` | MIT | Provider Doctor fixtures |
| `@electron/fuses` | `2.1.3` | MIT | Electron hardening |
| `electron-updater` | `6.8.9` | MIT | Application updates |
| `koffi` | `3.1.5` | MIT | Win32 Job Object, pipes and process creation |
| `pe-library` | `2.0.1` | MIT | Runtime Node x64 validation |
| `semver` | `7.8.5` | ISC | Stable/preview and downgrade policy |
| `sigstore` | `5.0.0` | Apache-2.0 | Artifact attestation verification |
| `ws` | `8.21.3` | MIT | WebSocket transport |
| `zod` | `4.4.3` | MIT | Runtime and RPC validation |

## Runtime key packages

These are selected direct or runtime-critical records, not a manually maintained substitute for the generated closure.

| Package | Version | License | Shipped role |
|---|---:|---|---|
| `@deepseek-ai/cordis-plugin-group` | `1.0.1` | MIT | DSH runtime plugin |
| `@deepseek-ai/dsh` | `0.1.0-rc.6` | MIT | Runtime CLI and application harness |
| `@deepseek-ai/dsh-fs-local` | `0.1.0-rc.6` | MIT | Local filesystem runtime capability |
| `@deepseek-ai/dsh-subprocess-local` | `0.1.0-rc.6` | MIT | Local subprocess runtime capability |
| `node-pty` / `@koromix/koffi-win32-x64` | `1.1.0` / `3.1.5` | MIT | Terminal and native Windows bindings |
| `pnpm` | `11.21.0` | MIT | Bundled runtime package manager |
| `sharp` / `@img/sharp-win32-x64` | `0.35.3` / `0.35.3` | Apache-2.0 / Apache-2.0 AND LGPL-3.0-or-later | Image support and Windows native image runtime |

Node.js `24.18.0` Windows x64 is shipped as an isolated runtime executable under the Node.js MIT license and its bundled third-party notices. Electron `43.4.0` is the desktop host under its MIT license and Chromium notices. `electron-builder 26.15.3` and the packaging-only `7zip-bin 5.2.0` are build dependencies; only the 7-Zip executable described below is shipped.

## Physical license closure

`node scripts/generate-license-closure.mjs` generates the tracked JSON report and the merged [`build/licenses/THIRD_PARTY_LICENSES.txt`](build/licenses/THIRD_PARTY_LICENSES.txt). The report records the package name, version, normalized license declaration, physical path, lock integrity when available, package license/notice resources, and a stable text-section ID. Every report entry has a corresponding license-text section; packages with only SPDX metadata receive a canonical fallback section. The app scope follows only the root production dependency graph. The runtime scope walks every physical package below `runtime/node_modules`, including nested `pnpm/dist/node_modules`, and applies the same explicit pruning used by the release runtime. Symlinks and Windows reparse points fail closed. The complete physical closure is checked against the explicit app/runtime allowlists, including `BlueOak-1.0.0`.

The quality, Windows, and tagged release workflows generate the closure and then run `--check` from a clean checkout. `package:setup` and `package:portable` run the same pre-package gate and, after packaging, verify that `resources/licenses/license-closure.json` and `resources/licenses/THIRD_PARTY_LICENSES.txt` are present and byte-for-byte identical to the current physical closure carrier. The setup and portable build configurations copy `build/licenses` into that resource directory, so the merged text and the report travel with both packages.

The current Windows closure contains 78 app-production package directories and 552 runtime package directories. Platform-specific physical counts may differ; the validation still requires every directory actually present in the closure to have a known license declaration. `BlueOak-1.0.0` entries are included in the generated report rather than omitted from the notices.

## Exact shipped artifact provenance

- `7zip-bin@5.2.0` is resolved from `https://registry.npmjs.org/7zip-bin/-/7zip-bin-5.2.0.tgz` with npm integrity `sha512-ukTPVhqG4jNzMro2qA9HSCSSVJN3aN7tlb+hfqYCt3ER0yWroeA2VR38MNrOHLQ/cVj+DaIMad0kFCtWWowh/A==`. Its `win/x64/7za.exe` reports `7-Zip (a) 21.07 (x64)`, has SHA-256 `b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95`, and is copied to `tools/7za.exe`; the wrapper's `LICENSE.txt` is not copied into either target.
- The shipped 7-Zip binary is covered by the upstream `21.07` `DOC/License.txt`: `https://github.com/ip7z/7zip/blob/21.07/DOC/License.txt`. That notice identifies LGPL-2.1-or-later code, the BSD-3-Clause LZFSE decoder, marked public-domain files, and the unRAR restriction. Verbatim copies of `License.txt`, `copying.txt`, and `unRarLicense.txt` are tracked under `build/licenses/` and shipped under `resources/licenses`; the complete corresponding source remains available at `https://github.com/ip7z/7zip/tree/21.07`.
- The runtime image entries are pinned to `sharp@0.35.3` (`https://registry.npmjs.org/sharp/-/sharp-0.35.3.tgz`, integrity `sha512-ej0zVHuZGHCiABXcNxeYhpRnPNPAcvbG8RMdBAhDAxLKkCRVSpK3Iyu7qbqw3JMzoj0REeM6f3tJLtVwl0023Q==`) and `@img/sharp-win32-x64@0.35.3` (`https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-0.35.3.tgz`, integrity `sha512-D4y1vNeZrIIJCN+uHaWVtH86B+aCrdMYYjicy9pXHvbGZeGYLLSd3wdVuC37FxVXlU1ARsk84eKWfWMXGYEqvA==`). The retained package README is the upstream third-party notice for the bundled libraries and records the LGPLv3/any-later-version relationship.
- The native package's `versions.json` records libvips `8.18.3`; no separate `@img/sharp-libvips-win32-x64` package is shipped. The libvips payload is `dsh-runtime/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll` plus `libvips-cpp-8.18.3.dll`. The corresponding source and LGPL-2.1-or-later text are available at `https://github.com/libvips/libvips/tree/v8.18.3` and `https://github.com/libvips/libvips/blob/v8.18.3/LICENSE`; the prebuilt dependency source is maintained at `https://github.com/lovell/sharp-libvips`.
- `build/licenses/7zip-21.07-copying.txt` is the complete verbatim GNU LGPL version 2.1 text. The same shipped copy supplies the LGPL-2.1-or-later license text for both the 7-Zip components identified above and the bundled libvips 8.18.3 components; it is not duplicated under a second filename.

Community behavior and test patterns were adapted from `ningbainb/deepseek-harness-desktop@3adc77a` (BSD-3-Clause), `bruc3van/dsh-desktop@d6180e6` (MIT), `dataelement/dsh-desktop@cbcb931` (MIT), and `baiyuscc13724-max/deepseek-harness-desktop@f49e2da` (MIT). No code was copied from unlicensed repositories.
