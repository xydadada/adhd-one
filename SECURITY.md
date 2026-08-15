# Security

ADHD One supports Windows 11 x64. Please report vulnerabilities privately through GitHub Security Advisories instead of a public issue.

The application does not collect telemetry. Provider credentials remain owned by DeepSeek Harness and must not be included in bug reports. Provider Doctor output is designed to be shareable, but users should still review it before posting.

Unsigned releases must be verified against `SHA256SUMS.txt` or with GitHub Artifact Attestations. Runtime and application updates fail closed when verification is unavailable.

Release and Runtime archives are authenticated before extraction, and candidates are checked in staging before an atomic slot switch. The extracted A/B slots and `runtime-state.json` live under the signed-in user's writable profile. A same-user or administrator compromise is outside this trust boundary: startup registration checks detect metadata/closure damage but are not a tamper-proof signature over every extracted file. Reinstall from a verified release to re-establish trust.

The current hardening revision has source/static qualification only. Clean Windows 11 behavior, installer/upgrade behavior, SmartScreen, path compatibility and performance are explicitly unverified.

DeepSeek Harness can execute tools and modify workspace files. Select the narrowest workspace needed and review every request to expand access.
