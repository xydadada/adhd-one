# ADHD One

**Desktop for DeepSeek Harness**：一个非官方、开箱即用的 Windows Electron 桌面端，适配 DeepSeek 官方开源的 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)。

> [!IMPORTANT]
> 这是社区项目，与 DeepSeek 无隶属、背书或维护关系。

| 兼容性 | 状态 |
|---|---|
| Windows 11 x64 | 目标平台；干净 Windows 11 验证尚未完成 |
| Windows Server 2025 CI | hardened 验证等待下一次完整运行；不能作为 Windows 11 证据 |
| DeepSeek Harness | `@deepseek-ai/dsh 0.1.0-rc.6` |
| 发布状态 | 正在准备 `v0.2.0-beta.2` 预发布 |
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

- 已准备的预发布版 `v0.2.0-beta.2`（[发布页](https://github.com/xydadada/adhd-one/releases/tag/v0.2.0-beta.2)）：[ADHD-One-Setup-0.2.0-beta.2-x64.exe](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Setup-0.2.0-beta.2-x64.exe)、[ADHD-One-Portable-0.2.0-beta.2-win-x64.zip](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/ADHD-One-Portable-0.2.0-beta.2-win-x64.zip) 和 [SHA256SUMS.txt](https://github.com/xydadada/adhd-one/releases/download/v0.2.0-beta.2/SHA256SUMS.txt)。这些链接将在 tag/Release 发布后生效。

`beta.2` 由 Release tag 和完整的 `0.2.0-beta.2` 文件名标识。本版本是 prerelease，不能按 `v0.2.0` Stable 说明。

Windows 产物未签名，SmartScreen 可能显示“未知发布者”。运行安装包前请对照 `SHA256SUMS.txt`，或验证 GitHub Artifact Attestation：

```powershell
Get-FileHash .\ADHD-One-Setup-0.2.0-beta.2-x64.exe -Algorithm SHA256
gh attestation verify .\ADHD-One-Setup-0.2.0-beta.2-x64.exe --repo xydadada/adhd-one
```

首次使用 DSH 时可能需要配置模型服务商或 API Key。密钥由内置的官方 DSH 运行时管理；ADHD One 的诊断只读取“是否已配置”和来源类型，不读取、显示或写入完整密钥。

## 当前验证状态

- Windows Server 2025 CI：run `31828488370` 的 build 和 Portable E2E 通过，但安装版 launch 发现 1 个延迟收敛进程，随后 NSIS 注册表 key 删除竞态覆盖了 summary。hardened 验证等待新的完整运行；Server 2025 结果不能作为 Windows 11 证据。
- Windows 11 x64：尚未完成干净 Windows 11 环境验证；Server 2025 CI 结果不能证明 Windows 11 兼容性。
- 性能：尚未形成性能合格证据；包体大小检查不等于性能验证。
- Packaged E2E：本地启动、强杀、workspace-write 和 Portable 检查已通过，并确认进程树清空；这些本地检查不是最终 hardened CI 证据。
- 当前本地证据：`npm run check` 通过 26 个 test files（279 个通过，1 个 Windows 8.3 alias 回归因本卷没有独立短路径而跳过），JavaScript 语法门通过 21 个文件，`npm run test:doctor` 通过（20/20），真实 `npm run smoke:runtime-staging` 输出 `RUNTIME_STAGING_OK slot=A version=0.1.0-rc.6`。Setup 为 144.04 MiB；打包后二进制正常退出 3/3、force-kill 1/1、workspace-write 1/1、真实 Portable 模式 1/1 均通过且无残留 PID。workspace 证据确认使用包内 ASAR RPC、两轮 Provider、PowerShell 执行和 Session 归档。这些结果仍不代表 Windows 11、Stable、性能或完整安装后 Release E2E 已完成。

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
