# Awesome DeepSeek Harness Desktop (ADHD)

An unofficial, batteries-included Electron desktop shell for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> [!IMPORTANT]
> This is a community project. It is not affiliated with, endorsed by, or maintained by DeepSeek.

## Why ADHD?

Because `DeepSeek Harness Desktop` naturally becomes **DHD**, and adding the traditional open-source `awesome-` prefix makes the acronym impossible to ignore. The joke is optional; the desktop app is real.

## What it does

- Bundles the official `@deepseek-ai/dsh` runtime and a checksum-verified Node.js runtime—no separate installs required. The DSH runtime is expanded once into the app data directory and reused.
- Starts `dsh web` on a random `127.0.0.1` port and embeds it in a hardened Electron window.
- Lets you choose the workspace that DSH uses as its default workspace root.
- Keeps external links in your normal browser.
- Includes startup diagnostics, restart controls, single-instance handling, and clean child-process shutdown.
- Produces a Windows installer.

## Download

Grab the newest Windows installer from [Releases](https://github.com/xydadada/awesome-deepseek-harness-desktop/releases).

The first DSH session may ask you to configure a model provider or API key. ADHD never reads or stores provider credentials itself; those settings are owned by the bundled DSH runtime.

## Development

Requirements: Node.js 22+ and npm.

```powershell
npm install
npm start
```

Run checks and create Windows artifacts:

```powershell
npm run check
npm run build:win
```

The build downloads the official Windows x64 Node.js runtime from `nodejs.org` and rejects it unless the archive matches the pinned SHA-256 checksum.

## Security model

- The DSH server binds to `127.0.0.1` only.
- Electron renderer access uses `contextIsolation`, no Node integration, and a sandboxed renderer.
- Non-local navigation opens in the system browser.
- The runtime receives your selected workspace because that is how official DSH defines its workspace root.

DeepSeek Harness is powerful agent software that can operate on files and run tools. Review its approval and sandbox settings before granting access to sensitive projects.

## Upstream and licenses

- Desktop shell: MIT, Copyright (c) 2026 xydadada.
- DeepSeek Harness: MIT, Copyright (c) 2026 DeepSeek. The official package is consumed as an npm dependency and keeps its upstream license metadata.
- Node.js: downloaded from nodejs.org during the build and verified against its published SHA-256 checksum.
- Electron and transitive dependencies retain their own licenses.

## Name and trademarks

“DeepSeek” and related marks belong to their respective owners. The project name describes compatibility with DeepSeek Harness and does not imply sponsorship.
