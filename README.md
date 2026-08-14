# ADHD One

**Desktop for DeepSeek Harness** — an unofficial, batteries-included Windows desktop for the official `@deepseek-ai/dsh` runtime.

> [!IMPORTANT]
> Unofficial community desktop client. ADHD One is not affiliated with, endorsed by, or maintained by DeepSeek.

| Compatibility | Status |
|---|---|
| Windows 11 x64 | Target platform; clean Windows 11 verification is pending |
| Windows Server 2025 CI | Hardened verification is pending the next full run; this is not Windows 11 evidence |
| DeepSeek Harness | `@deepseek-ai/dsh 0.1.0-rc.6` |
| Telemetry | Disabled by default |
| Release status | `v0.2.0-beta.2` prerelease is being prepared |
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

- Prepared prerelease `v0.2.0-beta.2` ([release page](https://github.com/xydadada/adhd-one/releases/tag/v0.2.0-beta.2)): [ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe), [ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip), and [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt). These links become active after the tag/Release is published.

The `beta.2` tag and full `0.2.0-beta.2` filenames identify the prerelease. The Windows artifacts are unsigned and SmartScreen may show “Unknown publisher”. Compare the downloaded file with `SHA256SUMS.txt` or verify the installer before running it:

```powershell
Get-FileHash .\ADHD-One-Setup-0.2.0-beta.2-x64.exe -Algorithm SHA256
gh attestation verify .\ADHD-One-Setup-0.2.0-beta.2-x64.exe --repo xydadada/adhd-one
```

On first launch, select a workspace. ADHD One never defaults to granting the whole Documents folder.

## Verification status

- Windows Server 2025 CI: hardened verification is pending the next full run; no final hardened pass is claimed here. Any Server 2025 result is not Windows 11 evidence.
- Windows 11 x64: not yet verified in a clean Windows 11 environment; Server 2025 CI does not establish Windows 11 compatibility.
- Performance: no performance qualification has been recorded; package-size checks must not be read as performance evidence.
- Packaged E2E: local launch, force-kill, workspace-write, and Portable checks passed with process-tree cleanup; these local checks are not final hardened CI evidence.
- Current local evidence: `npm run check` passed 25 test files/267 tests, the JavaScript syntax gate passed 21 files, `npm run test:doctor` passed 20/20, and `npm run smoke:runtime-staging` passed with `RUNTIME_STAGING_OK slot=A version=0.1.0-rc.6`. Setup is 144.04 MiB; packaged launch 3/3, force-kill 1/1, workspace-write 1/1, and real Portable mode 1/1 passed with no remaining child PID. The workspace evidence confirms packaged-ASAR RPC, two Provider turns, PowerShell execution, and session archival. This does not establish Windows 11, Stable, performance, or the complete installed release E2E.

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
