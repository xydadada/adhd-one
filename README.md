# ADHD One

**Desktop for DeepSeek Harness** — an unofficial, batteries-included Windows desktop for the official `@deepseek-ai/dsh` runtime.

> [!IMPORTANT]
> Unofficial community desktop client. ADHD One is not affiliated with, endorsed by, or maintained by DeepSeek.

| Compatibility | Status |
|---|---|
| Windows 11 x64 | Target platform; source/static qualification completed, clean Windows 11 behavior not tested |
| Windows Server 2025 CI | Historical packaged evidence exists for an older commit; it does not validate the current source or Windows 11 |
| DeepSeek Harness | `@deepseek-ai/dsh 0.1.0-rc.6` |
| Telemetry | Disabled by default |
| Release status | [`v0.2.0-beta.2`](https://github.com/xydadada/adhd-one/releases/tag/v0.2.0-beta.2) prerelease published |
| Code signing | Unsigned artifacts; SmartScreen warning applies |

The single source of truth for implementation scope, progress and release gates is the [ADHD One v0.2.0 master plan](docs/MASTER_PLAN.md).

## Highlights

- Runs the unmodified official Harness Web UI in a sandboxed Electron window.
- Creates the supervisor atomically inside a kill-on-close Windows Job with `STARTUPINFOEX`, and restricts inheritance to the two anonymous pipe handles.
- Uses a hidden real console for PowerShell compatibility, nonce-authenticated inherited anonymous pipes for status, and loopback-only HTTP.
- Includes tray controls, native notifications, an isolated Control Window, Provider Doctor, atomic settings and Stable/Preview update channels.
- Bundles a pinned Node runtime and pnpm, so the packaged app does not depend on system Node, npm or pnpm.
- Does not collect telemetry or upload workspaces, sessions, logs or Provider settings.

## Downloads

- Published prerelease `v0.2.0-beta.2` ([release page](https://github.com/xydadada/adhd-one/releases/tag/v0.2.0-beta.2)): [ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe), [ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip), and [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt).

The `beta.2` tag and full `0.2.0-beta.2` filenames identify the prerelease. The Windows artifacts are unsigned and SmartScreen may show “Unknown publisher”. Compare the downloaded file with `SHA256SUMS.txt` or verify the installer before running it:

```powershell
Get-FileHash .\ADHD-One-Setup-0.2.0-beta.2-x64.exe -Algorithm SHA256
gh attestation verify .\ADHD-One-Setup-0.2.0-beta.2-x64.exe --repo xydadada/adhd-one
```

On first launch, select a workspace. ADHD One never defaults to granting the whole Documents folder.

## Verification status and limits

- Current source/static qualification: `npm run check` passed 36 test files (448 passed, 1 Windows 8.3-alias regression skipped); JavaScript syntax covered 31 files, and TypeScript completed with no errors.
- Current empirical status: this hardening revision has not launched Electron/DSH, an installer, a VM, or a real provider. Windows 11 behavior, performance, SmartScreen, Chinese-user paths, long paths and upgrade behavior remain unverified.
- Historical evidence only: commit `a0e436d67805f921511d3b5ec5e4d1d075dadcbe` passed Windows Server 2025 Quality run `31870530352` and packaged run `31870530357`. Those older results do not establish behavior of the current revision.
- Published prerelease size: the existing beta.2 Setup asset is 151,012,608 bytes (144.02 MiB). This is not a measurement of a future build from the current source.

## Development

```powershell
npm ci
npm run check
npm run smoke
npm run build:win
```

Optional future empirical validation can use the retained self-contained runner. It was intentionally not run for the current static qualification:

```powershell
npm run prepare:win11-runner -- --output "C:\\adhd-one-win11-runner" --node "C:\\path\\to\\node.exe"
npm run e2e:win11 -- -SetupPath "C:\\path\\ADHD-One-Setup-0.2.0-beta.2-x64.exe" -EvidenceRoot "C:\\adhd-one-win11-runner\\evidence" -RepoRoot "C:\\adhd-one-win11-runner"
```

The matrix installs and uninstalls once in each of four isolated path cases (`ascii`, `中文`, `中文 空格`, and a 280-character path). Each row runs the bounded qualification scenario instead of repeating the full 14-cycle suite. The collector hashes the launched EXE before spawn and again after qualification, then emits a path-free `win11-evidence.json`; the evidence remains local and unauthenticated until the bundle is signed/attested.

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
