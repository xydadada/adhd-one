# Awesome DeepSeek Harness Desktop（ADHD）

一个非官方、开箱即用的 Electron 桌面端，封装 DeepSeek 官方开源的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

> [!IMPORTANT]
> 这是社区项目，与 DeepSeek 无隶属、背书或维护关系。

## 为什么叫 ADHD？

`DeepSeek Harness Desktop` 缩写是 **DHD**，再加上开源社区传统艺能 `awesome-` 前缀，就自然变成了 **ADHD**。梗可以不当真，桌面端是真的。

## 功能

- 内置官方 `@deepseek-ai/dsh` 和经过 SHA-256 校验的 Node.js 运行时，无需用户单独安装。DSH 运行时首次启动时解压到应用数据目录，之后直接复用。
- 在随机的 `127.0.0.1` 端口启动 `dsh web`，并嵌入安全配置的 Electron 窗口。
- 可以选择 DSH 默认使用的工作区目录。
- 外部链接交给系统浏览器打开。
- 提供启动诊断、重启、单实例和子进程清理。
- 构建 Windows 安装版。

## 下载

前往 [Releases](https://github.com/xydadada/awesome-deepseek-harness-desktop/releases) 下载最新版 Windows 安装包。

首次使用 DSH 时可能需要配置模型服务商或 API Key。ADHD 本身不会读取或保存服务商密钥，相关设置由内置的官方 DSH 运行时管理。

## 本地开发

需要 Node.js 22+ 和 npm：

```powershell
npm install
npm start
```

检查并构建 Windows 安装包：

```powershell
npm run check
npm run build:win
```

构建脚本会从 `nodejs.org` 下载官方 Windows x64 Node.js 运行时；只有压缩包与固定的 SHA-256 校验值一致时才会继续。

## 安全说明

- DSH 服务只绑定 `127.0.0.1`。
- Electron 渲染进程启用上下文隔离、关闭 Node 集成并启用沙箱。
- 非本地页面交给系统浏览器打开。
- 官方 DSH 会把启动目录作为默认工作区，因此运行时能够访问你选择的目录。

DeepSeek Harness 是具备文件和工具操作能力的 Agent 软件。向敏感项目授权前，请先检查它的审批与沙箱配置。

## 许可与声明

- 本桌面壳：MIT，Copyright (c) 2026 xydadada。
- DeepSeek Harness：MIT，Copyright (c) 2026 DeepSeek。本项目通过 npm 依赖使用官方包，并保留其上游许可元数据。
- Node.js：构建时从 nodejs.org 下载，并使用官方公布的 SHA-256 校验值验证。
- “DeepSeek”等名称与标识归其权利人所有。本项目名称仅用于描述兼容性，不代表官方赞助或背书。
