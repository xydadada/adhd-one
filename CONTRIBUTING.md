# Contributing to ADHD One

Thank you for helping improve this unofficial community desktop client for DeepSeek Harness.

## Before opening work

- Use GitHub Discussions for questions and setup help.
- Search existing issues before reporting a bug or proposing a feature.
- Report security vulnerabilities privately through [GitHub Security Advisories](https://github.com/xydadada/adhd-one/security/advisories/new).
- Never post API keys, Authorization headers, full environment dumps, private workspace paths, session content, or unredacted logs.
- Report defects in the official Harness itself to [deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/DeepSeek-Harness/issues).

The scope and release boundary are defined only in [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md). ADHD One keeps the upstream DSH Web UI unchanged and does not accept changes that imply affiliation with or endorsement by DeepSeek.

## Development

Use Node.js 24+ and the committed lockfiles:

```powershell
npm ci
npm run check
```

Runtime dependencies are isolated under `runtime/`. If either dependency tree changes, update and review the corresponding lockfile. Do not casually update `@deepseek-ai/dsh`; upstream Runtime changes require protocol, packaging, license, and update-manifest review.

## Reuse and provenance

Before writing a new implementation, check this repository, DeepSeek Harness, official platform APIs, mature licensed packages, and compatible community projects—in that order. Record copied or adapted code, fixed versions/commits, licenses, and modifications in `THIRD_PARTY_NOTICES.md`.

Do not copy code without a clear compatible license, add an overlapping implementation, or introduce a large dependency for a small standard-library task.

## Pull requests

Keep each pull request focused. Explain:

- the user-visible problem and the chosen boundary;
- reused code or dependencies and their provenance;
- security, privacy, update, and process-lifecycle impact;
- tests run and tests intentionally not run;
- whether README, release notes, notices, or the master plan need an update.

At minimum, run `npm run check`. Packaging, Runtime, updater, supervisor, preload/IPC, workflow, and installer changes should also run the narrowest applicable packaged verification when that testing is in scope. Do not weaken production fuses or sandboxing to make a test easier.

