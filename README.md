# ADHD One

**Desktop for DeepSeek Harness** — an unofficial, batteries-included Windows desktop for the official `@deepseek-ai/dsh` runtime.

> [!IMPORTANT]
> Unofficial community desktop client. ADHD One is not affiliated with, endorsed by, or maintained by DeepSeek.

| Compatibility | Status |
|---|---|
| Windows 11 x64 | Supported |
| DeepSeek Harness | `@deepseek-ai/dsh 0.1.0-rc.6` |
| Telemetry | Disabled by default |
| Code signing | Unsigned v0.2.0 build |

## Highlights

- Runs the unmodified official Harness Web UI in a sandboxed Electron window.
- Supervises Node, PowerShell, pnpm and tool processes with a Windows Job Object; closing the Job terminates the complete child tree.
- Uses a hidden real console for PowerShell compatibility, a nonce-authenticated named pipe for status, and loopback-only HTTP.
- Includes tray controls, native notifications, an isolated Control Window, Provider Doctor, atomic settings and Stable/Preview update channels.
- Bundles a pinned Node runtime and pnpm, so the packaged app does not depend on system Node, npm or pnpm.
- Does not collect telemetry or upload workspaces, sessions, logs or Provider settings.

## Install

Download `ADHD-One-Setup-0.2.0-x64.exe` from [GitHub Releases](https://github.com/xydadada/adhd-one/releases). A pre-expanded portable ZIP is also provided.

The v0.2.0 Windows build is unsigned and SmartScreen may show “Unknown publisher”. Verify the SHA-256 file or the GitHub attestation before running it:

```powershell
Get-FileHash .\ADHD-One-Setup-0.2.0-x64.exe -Algorithm SHA256
gh attestation verify .\ADHD-One-Setup-0.2.0-x64.exe --repo xydadada/adhd-one
```

On first launch, select a workspace. ADHD One never defaults to granting the whole Documents folder.

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
