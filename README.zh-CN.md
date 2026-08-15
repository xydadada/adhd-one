# ADHD One

**Desktop for DeepSeek Harness**：一个非官方、开箱即用的 Windows Electron 桌面端，适配 DeepSeek 官方开源的 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)。

> [!IMPORTANT]
> 这是社区项目，与 DeepSeek 无隶属、背书或维护关系。

| 兼容性 | 状态 |
|---|---|
| Windows 11 x64 | 目标平台；源码/静态资格已完成，未测试干净 Windows 11 实际行为 |
| Windows Server 2025 CI | 旧提交有历史打包证据；不能证明当前源码或 Windows 11 |
| DeepSeek Harness | `@deepseek-ai/dsh 0.1.0-rc.6` |
| 发布状态 | 已发布 [`v0.2.0-beta.2`](https://github.com/xydadada/adhd-one/releases/tag/v0.2.0-beta.2) 预发布版 |
| 代码签名 | Windows 产物未签名；会触发 SmartScreen 提示 |

统一的实现范围、进度和发布门槛见 [ADHD One v0.2.0 统一主计划](docs/MASTER_PLAN.md)。

## 为什么叫 ADHD？

`DeepSeek Harness Desktop` 缩写是 **DHD**，再加上开源社区传统艺能 `awesome-` 前缀，就自然变成了 **ADHD**。现在产品名统一为 **ADHD One**；梗可以不当真，桌面端是真的。

## 功能

- 内置官方 `@deepseek-ai/dsh` 和经过 SHA-256 校验的 Node.js 运行时，无需用户单独安装。
- 在保存的 `127.0.0.1` loopback origin 启动 `dsh web`；只有明确端口冲突时才回退到系统分配端口，并保存新的首选端口。
- 可以选择 DSH 默认使用的工作区目录。
- 外部链接交给系统浏览器打开。
- 提供启动诊断、重启、托盘、通知、单实例和 Job Object 子进程清理。
- 提供 Stable/Preview 双通道更新、Provider Doctor、Windows 安装版和预展开 Portable ZIP。

## 下载

- 已发布的预发布版 `v0.2.0-beta.2`（[发布页](https://github.com/xydadada/adhd-one/releases/tag/v0.2.0-beta.2)）：[ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe)、[ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip) 和 [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt)。

`beta.2` 由 Release tag 和完整的 `0.2.0-beta.2` 文件名标识。本版本是 prerelease，不能按 `v0.2.0` Stable 说明。

Windows 产物未签名，SmartScreen 可能显示“未知发布者”。运行安装包前请对照 `SHA256SUMS.txt`，或验证 GitHub Artifact Attestation：

```powershell
Get-FileHash .\ADHD-One-Setup-0.2.0-beta.2-x64.exe -Algorithm SHA256
gh attestation verify .\ADHD-One-Setup-0.2.0-beta.2-x64.exe --repo xydadada/adhd-one
```

首次使用 DSH 时可能需要配置模型服务商或 API Key。密钥由内置的官方 DSH 运行时管理；ADHD One 的诊断只读取“是否已配置”和来源类型，不读取、显示或写入完整密钥。

## 当前验证状态与限制

- 当前源码/静态资格：`npm run check` 通过 36 个 test files（448 个通过、1 个 Windows 8.3 alias 回归因测试卷没有独立短路径而跳过）；JavaScript syntax 覆盖 31 个文件，TypeScript 无错误。
- 当前经验验证：本轮没有启动 Electron/DSH、安装包、VM 或真实 Provider。Windows 11 实际行为、性能、SmartScreen、中文用户名、长路径和升级体验均未验证。
- 仅作历史记录：commit `a0e436d67805f921511d3b5ec5e4d1d075dadcbe` 曾通过 Windows Server 2025 Quality run `31870530352` 和打包 run `31870530357`；旧结果不能证明当前修订。
- 已发布 beta.2 Setup 资产为 151,012,608 bytes（144.02 MiB）；这不是当前源码未来构建的体积测量。

## 本地开发

需要 Node.js 24+ 和 npm：

```powershell
npm install
npm start
```

检查并构建 Windows 安装包：

```powershell
npm run check
npm run build:win
```

构建脚本会从 `nodejs.org` 下载官方 Windows x64 Node.js 运行时；只有压缩包与固定的 SHA-256 校验值一致时才会继续。生产包内不依赖系统 Node、npm 或 pnpm。

## 安全说明

- DSH 服务只绑定 `127.0.0.1`。
- Electron 渲染进程启用上下文隔离、关闭 Node 集成并启用沙箱。
- 非本地页面交给系统浏览器打开。
- DSH 只使用你选择的工作区；首次发现旧的 `~/.dsh` 时，ADHD One 提供复制导入，原目录保持不变。

DeepSeek Harness 是具备文件和工具操作能力的 Agent 软件。向敏感项目授权前，请先检查它的审批与沙箱配置。

## 许可与声明

- 本桌面壳：MIT，Copyright (c) 2026 xydadada。
- DeepSeek Harness：MIT，Copyright (c) 2026 DeepSeek。本项目通过 npm 依赖使用官方包，并保留其上游许可元数据。
- Node.js：构建时从 nodejs.org 下载，并使用官方公布的 SHA-256 校验值验证。
- “DeepSeek”等名称与标识归其权利人所有。本项目名称仅用于描述兼容性，不代表官方赞助或背书。
