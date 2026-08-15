# Packaged Windows E2E

`packaged.mjs` is an independent black-box smoke test for a packaged ADHD One executable. It does not change the application, lower Electron Fuses, use Computer Use, or use Playwright's Electron launcher.

The script:

- starts the final executable with `child_process.spawn()`;
- gives every cycle isolated temporary `APPDATA`, `LOCALAPPDATA`, `--user-data-dir`, profile, TEMP, and workspace directories;
- restricts the child `PATH` to the Windows `System32` directory and removes Node/pnpm override variables;
- allocates a fresh `127.0.0.1` remote-debugging port;
- parses `/json/version`, requires its `webSocketDebuggerUrl` to use `ws:`/`wss:`, point to a loopback host, and carry the exact allocated port, then connects with `chromium.connectOverCDP()`;
- finds the `adhd-one://app/` ControlWindow, verifies `#state`, and waits for `Harness：ready`;
- uses the `launch` scenario by default: requests a normal application shutdown through the CDP browser connection and keeps the existing force-exit fallback;
- uses the `force-kill` scenario only when requested: hard-kills the launched Electron root PID with `taskkill.exe /PID <pid> /T /F`, never by a global image name;
- uses `workspace-write` only when requested: starts the official `@deepseek-ai/dsh-llm-mock-server`, injects only fake `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` before spawn, loads the packaged `app.asar/out` (or local `out`) `DshRpcClient`, and exercises a real workspace `pwsh` sentinel/tool-result/provider-second-turn/final-nonce flow without an approval UI;
- uses `runtime-rollback` only for an installed build: seeds an isolated, present but version-mismatched slot B as the active candidate, starts the final EXE, and requires both the live Runtime snapshot and post-exit persisted state to prove rollback to the bundled Runtime;
- records per-cycle startup, ControlWindow, ready, exit, and cleanup results in JSON;
- reuses the process-tree, CDP-port, and temporary-directory cleanup verification for every scenario.

## Usage

Run from the repository root. `--exe` must point to the installed application executable or the executable extracted from the portable ZIP; it is not the NSIS installer.

## Fixed packaged suite

`run-packaged-suite.mjs` is a bounded orchestration wrapper for an already-built executable. It accepts only `--exe` and `--evidence-dir`, invokes `packaged.mjs` directly with `process.execPath`, and never builds, installs, packages, or retries a step.

```powershell
node scripts/e2e/run-packaged-suite.mjs `
  --exe 'C:\Program Files\ADHD One\ADHD One.exe' `
  --evidence-dir .\evidence\packaged-suite
```

The calls are always sequential and fixed: `launch` × 1, `force-kill` × 1, `workspace-write` × 1, `runtime-rollback` × 1, then `launch` × 10. The five independent JSON files are `launch-1.json`, `force-kill-1.json`, `workspace-write-1.json`, `runtime-rollback-1.json`, and `launch-10.json` under the supplied evidence directory. Child stdout/stderr is inherited for live diagnostics; a non-zero child exit, missing evidence file, or invalid evidence stops the suite immediately with a stable failure code and no later scenario is started.

```powershell
node scripts/e2e/packaged.mjs `
  --exe 'C:\Program Files\ADHD One\ADHD One.exe' `
  --output .\evidence\packaged.json `
  --cycles 1 `
  --scenario launch
```

`--scenario` accepts `launch`, `force-kill`, `workspace-write`, or `runtime-rollback` and defaults to `launch`. `runtime-rollback` deliberately rejects Portable mode because its contract targets `%LOCALAPPDATA%` A/B state. `--cycles` defaults to `1` and is capped at `100`. Cycles are deliberately sequential so that each process has an independent temporary environment and its own port. The output path may be a `.json` file or a directory; a directory receives `packaged-evidence.json`.

Force-kill example:

```powershell
node scripts/e2e/packaged.mjs `
  --exe 'C:\Program Files\ADHD One\ADHD One.exe' `
  --output .\evidence\packaged-force-kill.json `
  --scenario force-kill
```

Workspace-write integration example:

```powershell
node scripts/e2e/packaged.mjs `
  --exe 'C:\Program Files\ADHD One\ADHD One.exe' `
  --output .\evidence\packaged-workspace-write.json `
  --scenario workspace-write
```

This scenario uses the runtime's default `workspace-write` permission mode. It creates a temporary session in the isolated workspace, drives a `pwsh` tool call from the mock provider, verifies the sentinel on disk and the non-error tool result through both mux and `session.history`, then requires the mock sequence `tool_call_success` → `success`. Approval requests are not rendered or approved; an unexpected request is recorded as a failed scenario.

Runtime rollback integration example:

```powershell
node scripts/e2e/packaged.mjs `
  --exe 'C:\Program Files\ADHD One\ADHD One.exe' `
  --output .\evidence\packaged-runtime-rollback.json `
  --scenario runtime-rollback
```

The scenario writes only to its temporary `LOCALAPPDATA`. It verifies bundled activation, the previous B marker, healthy state, candidate clearing, `rolledBackFrom`, retention of the now-inactive candidate slot, and the same state after clean process exit. Evidence retains only those booleans.

Example ten-cycle run:

```powershell
node scripts/e2e/packaged.mjs `
  --exe 'C:\Program Files\ADHD One\ADHD One.exe' `
  --output .\evidence\win-server\ `
  --cycles 10
```

Exit code `0` means every cycle reached the ControlWindow and the literal runtime status `Harness：ready`, completed its selected scenario, passed process/CDP cleanup verification, and removed its temporary directory. In `force-kill`, an intentional hard kill is a passing outcome only when the exact process tree is gone. In `workspace-write`, a missing packaged/local RPC client, non-routable mock route, unexpected approval, missing PowerShell call/result, failed sentinel, incomplete history, or mismatched second provider turn is a failure—not a synthetic pass. In `runtime-rollback`, any disagreement between the live snapshot, persisted state, and the retained version-mismatched candidate slot is a failure. Exit code `1` means evidence was written but at least one cycle failed. Invalid arguments, a missing executable, a non-Windows host, or a missing Playwright installation use exit code `2`.

## Electron updater feed integration

`npm run e2e:updater-feed` launches Electron against a bounded, loopback-only GitHub-compatible feed fixture. It uses electron-updater's real GitHub provider to verify Stable selection, Preview `beta.yml` to `latest.yml` fallback, a successful SHA-512 download, and fail-closed checksum rejection. Ambient proxy and GitHub token variables are removed from the child environment, installation methods are replaced with hard failures, and the harness has a 120-second deadline. This proves the updater consumer path without contacting GitHub or installing an artifact; published-asset attestation and restart/install remain separate release gates.

## Evidence

The JSON has schema version `1`, the executable basename, the selected `scenario`, stable top-level booleans, requested/completed cycle counts, an overall `passed` field, and one record per cycle. Each `workspace-write` record contains only booleans and allowlisted enums for RPC-client source, permission mode, approval state, provider sequence, session lifecycle, PowerShell/tool result, sentinel, history, second provider turn, and final nonce. Each Runtime rollback record contains only allowlisted booleans. Raw output, URLs, API keys, error text, environment variables, session IDs, nonces, Runtime versions, raw state, and temporary paths are never retained in evidence.

CDP connection failures use the stable `CDP_CONNECT_TIMEOUT` code. Runtime discovery, snapshot evaluation, host description, and workspace RPC stages likewise use stage-specific stable codes; raw Playwright, fetch, or provider error messages are not printed or written to evidence. The existing CDP, control-window, graceful-exit, force-exit, and workspace timeouts are unchanged.

`launch` and `force-kill` intentionally perform no provider request or workspace tool-call. Provider and workspace coverage is opt-in through `workspace-write`; it remains black-box and uses no approval UI.

## Windows 11 qualification evidence

`npm run verify:win11-evidence -- <file.json>` validates the standalone RC qualification record. The schema is strict and path-free: Windows 11 x64 with build number 22000 or newer, an allowlisted executable name and lowercase SHA-256, first interaction at or below 15 seconds, hot ready at or below 8 seconds, one-minute idle CPU below 1%, exit at or below 5 seconds, and zero residual processes. The verifier is deliberately offline and does not collect or trust host state by itself; a separate Windows 11 runner/collector must generate the record and prove the digest and measurements before this gate can count toward release progress.
