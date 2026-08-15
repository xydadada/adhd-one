# ADHD One v0.2.0-beta.2 (Prerelease / 预发布)

## 中文

本文档是 `v0.2.0-beta.2` 的预发布说明。

`v0.2.0-beta.2` 是非官方社区 Windows x64 预发布版，内置官方 `@deepseek-ai/dsh 0.1.0-rc.6`，包含 Windows Job Object 进程托管、托盘、系统通知、安全 Control Window、Provider Doctor、双通道更新、原子设置和安装阶段运行时展开。

下载：

- [ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe)
- [ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip)
- [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt)

以上链接在 tag/Release 发布后提供对应资产。

**未签名 Windows 构建：** SmartScreen 可能显示“未知发布者”。运行前请对照 `SHA256SUMS.txt`，或执行：

```powershell
gh attestation verify ADHD-One-Setup-0.2.0-beta.2-x64.exe --repo xydadada/adhd-one
```

兼容性：Windows 11 x64 是目标平台，但尚未在干净 Windows 11 环境验证。commit `c6801bca6d18d7309861677de44d995e6d21102d` 的 Windows Server 2025 hardened Quality run `31857910832` 与 Windows run `31857910840` 已通过，包括安装版 13/13 循环和最终 Portable ZIP E2E；这些结果不能证明 Windows 11 兼容性或性能合格。本版本是 prerelease，不能按 `v0.2.0` Stable 说明。此项目与 DeepSeek 无隶属或背书关系。

## English

These are the prerelease notes for `v0.2.0-beta.2`.

`v0.2.0-beta.2` is an unofficial community Windows x64 prerelease bundling the official `@deepseek-ai/dsh 0.1.0-rc.6`. It includes Windows Job Object supervision, tray controls, native notifications, a secure Control Window, Provider Doctor, two independent update channels, atomic settings, and install-time runtime expansion.

Downloads:

- [ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe)
- [ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip)
- [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt)

These links provide the corresponding assets after the tag/Release is published.

**Unsigned Windows build:** SmartScreen may display “Unknown publisher”. Compare the download with `SHA256SUMS.txt` or verify the GitHub Artifact Attestation before running the installer.

Compatibility: Windows 11 x64 is the target platform, but it has not been verified in a clean Windows 11 environment. Windows Server 2025 hardened Quality run `31857910832` and Windows run `31857910840` passed for commit `c6801bca6d18d7309861677de44d995e6d21102d`, including all 13 installed cycles and the final Portable ZIP E2E. These results do not establish Windows 11 compatibility or performance qualification. This is a prerelease and must not be described as `v0.2.0` Stable. This project is not affiliated with or endorsed by DeepSeek.
