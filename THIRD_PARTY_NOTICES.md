# Third-party notices

ADHD One is MIT licensed. The following upstream materials are bundled, directly depended on, or minimally adapted.

| Project | Version / commit | License | Use and modifications |
|---|---|---|---|
| DeepSeek Harness | `47f943859bef60e4160492346772ded9b24f765a`; npm `@deepseek-ai/dsh 0.1.0-rc.6` | MIT | Runtime; minimal Windows launch, atomic-write and RPC carrier patterns adapted with attribution in source. |
| Node.js | `24.18.0` Windows x64 | MIT and bundled third-party notices | Isolated runtime executable. |
| Electron | `43.4.0` | MIT and Chromium notices | Desktop host, Tray and Notification APIs. |
| electron-builder / electron-updater | `26.15.3` / `6.8.9` | MIT | Packaging and confirmed application updates. |
| Koffi | `3.1.5` | MIT | Win32 Job Object and CreateProcessW calls. |
| Sigstore JavaScript | `5.0.0` / `@sigstore/verify 4.1.2` | Apache-2.0 | GitHub Artifact Attestation verification. |
| pnpm | `11.21.0` | MIT | Bundled plugin package manager; upgraded from planned 11.7.0 to address GHSA-qrv3-253h-g69c. |

Community repositories listed in the design research were used as behavioral references only unless a future file-level notice explicitly says code was copied. No code was copied from unlicensed repositories.

Complete transitive license metadata is retained in installed packages and the release SPDX SBOM.
