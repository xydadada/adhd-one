# ADHD One

**Desktop for DeepSeek Harness** — an unofficial, batteries-included Windows desktop for the official `@deepseek-ai/dsh` runtime.

> [!IMPORTANT]
> Unofficial community desktop client. ADHD One is not affiliated with, endorsed by, or maintained by DeepSeek.

| Compatibility | Status |
|---|---|
| Windows 11 x64 | Not yet verified; Windows Server 2025 CI is not Windows 11 evidence |
| DeepSeek Harness | `@deepseek-ai/dsh 0.1.0-rc.6` |
| Telemetry | Disabled by default |
| Release status | Stable `v0.1.0`; preview `v0.2.0-beta.1` (prerelease) |
| Code signing | Unsigned artifacts; SmartScreen warning applies |

The single source of truth for implementation scope, progress and release gates is the [ADHD One v0.2.0 master plan](docs/MASTER_PLAN.md).

## Highlights

- Runs the unmodified official Harness Web UI in a sandboxed Electron window.
- Supervises Node, PowerShell, pnpm and tool processes with a Windows Job Object; closing the Job terminates the complete child tree.
- Uses a hidden real console for PowerShell compatibility, nonce-authenticated inherited anonymous pipes for status, and loopback-only HTTP.
- Includes tray controls, native notifications, an isolated Control Window, Provider Doctor, atomic settings and Stable/Preview update channels.
- Bundles a pinned Node runtime and pnpm, so the packaged app does not depend on system Node, npm or pnpm.
- Does not collect telemetry or upload workspaces, sessions, logs or Provider settings.

## Downloads

- Stable `v0.1.0`: [ADHD-Setup-0.1.0-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.1.0/ADHD-Setup-0.1.0-x64.exe) ([release page](https://github.com/xydadada/adhd-one/releases/tag/v0.1.0)).
- Preview `v0.2.0-beta.1` ([prerelease page](https://github.com/xydadada/adhd-one/releases/tag/v0.2.0-beta.1)): [installer](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.1/ADHD-One-Setup-0.2.0-x64.exe) or [portable ZIP](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.1/ADHD-One-Portable-0.2.0-win-x64.zip).

`v0.2.0-beta.1` is a prerelease; `v0.2.0` Stable has not been released. Its Windows artifacts are unsigned and SmartScreen may show “Unknown publisher”. Verify the SHA-256 file or the GitHub attestation before running the preview installer:

```powershell
Get-FileHash .\ADHD-One-Setup-0.2.0-x64.exe -Algorithm SHA256
gh attestation verify .\ADHD-One-Setup-0.2.0-x64.exe --repo xydadada/adhd-one
```

On first launch, select a workspace. ADHD One never defaults to granting the whole Documents folder.

## Verification status

- Windows 11 x64: not yet verified in a clean Windows 11 environment. Windows Server 2025 CI results are not Windows 11 results.
- Performance: no performance qualification has been recorded; package-size checks must not be read as performance evidence.
- Packaged E2E: partially verified locally. The final Portable EXE has passed independent launch, force-kill, and official mock Provider/PowerShell tool-call scenarios with process-tree cleanup. The ten-cycle suite and isolated NSIS install/uninstall gate must still pass after push.
- Current local evidence: `npm run check` passed 20 test files/201 tests, the JavaScript syntax gate passed 20 files, `npm run test:doctor` passed 20/20, and `npm run smoke:runtime-staging` passed with `RUNTIME_STAGING_OK slot=A version=0.1.0-rc.6`. Setup is 144.04 MiB; packaged launch 3/3, force-kill 1/1, workspace-write 1/1, and real Portable mode 1/1 passed with no remaining child PID. The workspace evidence confirms packaged-ASAR RPC, two Provider turns, PowerShell execution, and session archival. This does not establish Windows 11, Stable, performance, or the complete installed release E2E.

## Development

```powershell
npm ci
npm run check
npm run smoke
npm run build:win
```

The runtime is isolated under `runtime/`. Node downloads are checksum-verified. Exact dependency versions are recorded in both lockfiles.

## Security model

- `contextIsolation`, renderer sandboxing, no Node integration, a custom Control Window protocol, strict navigation/permission policy and Electron fuses.
- Harness navigation is limited to its exact `127.0.0.1` origin. New windows and downloads are denied; allowlisted HTTPS links open externally.
- Control IPC exposes only typed product operations; it does not expose arbitrary files, processes, shell commands, URLs or IPC channels.
- Provider Doctor reports are redacted and never include API keys, Authorization headers, environment variables, full responses or session content.
- Runtime updates fail closed on manifest, size, digest or GitHub Sigstore attestation errors.

See [SECURITY.md](SECURITY.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Name and trademarks

“DeepSeek” and related marks belong to their owners. “Desktop for DeepSeek Harness” describes compatibility and does not imply sponsorship. ADHD One uses an original icon.
