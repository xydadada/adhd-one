# ADHD One v0.2.0

## 中文

ADHD One 是非官方社区桌面客户端，内置官方 `@deepseek-ai/dsh 0.1.0-rc.6`。本版加入 Windows Job Object 进程托管、托盘、系统通知、安全 Control Window、Provider Doctor、双通道更新、原子设置和安装阶段运行时展开。

**Unsigned Windows build：** Windows SmartScreen 可能显示“未知发布者”。运行前请核验 `SHA256SUMS.txt`，或执行：

```powershell
gh attestation verify ADHD-One-Setup-0.2.0-x64.exe --repo xydadada/adhd-one
```

目标平台为 Windows 11 x64；在干净 Windows 11 VM 的 RC 验证完成前，本版本仅作为预发布构建。此项目与 DeepSeek 无隶属或背书关系。

## English

ADHD One is an unofficial community desktop client bundling the official `@deepseek-ai/dsh 0.1.0-rc.6`. This release adds Windows Job Object supervision, tray controls, native notifications, a secure Control Window, Provider Doctor, two independent update channels, atomic settings, and install-time runtime expansion.

**Unsigned Windows build:** SmartScreen may display “Unknown publisher”. Verify `SHA256SUMS.txt` or the GitHub Artifact Attestation before running the installer.

Windows 11 x64 is the target platform. Until the RC passes validation in a clean Windows 11 VM, this build remains a prerelease. This project is not affiliated with or endorsed by DeepSeek.
