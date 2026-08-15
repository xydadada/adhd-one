# ADHD One v0.2.0-beta.2 (Prerelease / 预发布)

## 中文

本文档是 `v0.2.0-beta.2` 的预发布说明。

`v0.2.0-beta.2` 是非官方社区 Windows x64 预发布版，内置官方 `@deepseek-ai/dsh 0.1.0-rc.6`，包含 Windows Job Object 进程托管、托盘、系统通知、安全 Control Window、Provider Doctor、双通道更新、原子设置和安装阶段运行时展开。

下载：

- [ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe)
- [ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip)
- [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt)

以上资产已随公开的 `v0.2.0-beta.2` Release 发布。

**未签名 Windows 构建：** SmartScreen 可能显示“未知发布者”。运行前请对照 `SHA256SUMS.txt`，或执行：

```powershell
gh attestation verify ADHD-One-Setup-0.2.0-beta.2-x64.exe --repo xydadada/adhd-one --predicate-type https://in-toto.io/attestation/release/v0.1 --signer-workflow xydadada/adhd-one/.github/workflows/release.yml --source-ref refs/tags/v0.2.0-beta.2
```

兼容性：Windows 11 x64 是目标平台，但尚未在干净 Windows 11 环境验证。tag `v0.2.0-beta.2` 指向 commit `0b47082933c7c8165f45b1a8e9ba4ce677a8a720`；release run `31859638726` 完成构建、打包检查、SBOM、摘要和 attestation，但最终 job 因当时错误回读不可见 draft 而标红，资产随后经 release ID 核对后发布。这些历史结果不能证明当前 main、Windows 11 兼容性或性能合格。本版本是 prerelease，不能按 `v0.2.0` Stable 说明。此项目与 DeepSeek 无隶属或背书关系。

## English

These are the prerelease notes for `v0.2.0-beta.2`.

`v0.2.0-beta.2` is an unofficial community Windows x64 prerelease bundling the official `@deepseek-ai/dsh 0.1.0-rc.6`. It includes Windows Job Object supervision, tray controls, native notifications, a secure Control Window, Provider Doctor, two independent update channels, atomic settings, and install-time runtime expansion.

Downloads:

- [ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe)
- [ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip)
- [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt)

These assets are available from the published `v0.2.0-beta.2` Release.

**Unsigned Windows build:** SmartScreen may display “Unknown publisher”. Compare the download with `SHA256SUMS.txt` or verify the GitHub Artifact Attestation before running the installer.

Compatibility: Windows 11 x64 is the target platform, but it has not been verified in a clean Windows 11 environment. Tag `v0.2.0-beta.2` points to commit `0b47082933c7c8165f45b1a8e9ba4ce677a8a720`; release run `31859638726` completed build/package checks, SBOM, checksums and attestation, but its final job failed while reading a then-invisible draft. The assets were subsequently published after release-ID verification. This historical evidence does not establish current-main behavior, Windows 11 compatibility or performance qualification. This is a prerelease and must not be described as `v0.2.0` Stable. This project is not affiliated with or endorsed by DeepSeek.
