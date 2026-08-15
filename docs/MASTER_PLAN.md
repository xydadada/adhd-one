# ADHD One v0.2.0 统一主计划与执行规范

本文档是 ADHD One v0.2.0 的唯一实施依据，完整替代此前所有 v0.2.0 草案。README、GitHub Milestones、Issues 和 Release Notes 只能引用本文档，不得分别维护相互冲突的路线、进度或发布口径。

## 1. 总目标与锁定边界

- 仓库：`xydadada/adhd-one`
- 产品：`ADHD One`
- 副标题：`Desktop for DeepSeek Harness`
- 定位：非官方社区 Windows 桌面客户端
- appId：`io.github.xydadada.adhd`
- 目标平台：Windows 11 x64。按项目所有者 2026-08-15 的决定，v0.2.0 以源码审计、类型检查、单元/集成测试和发布元数据静态校验为放行口径；干净 Windows 11、性能、SmartScreen 与真实安装体验明确标为“未验证”，不再作为本版本阻断门槛。
- Runtime：未修改的 `@deepseek-ai/dsh@0.1.0-rc.6`
- 默认关闭 DSH 遥测；ADHD One 不收集遥测，不上传工作区、会话、日志或 Provider 配置。
- Stable 可以无代码签名，但必须提供 SHA-256、SPDX SBOM、GitHub Artifact Attestation、可离线证明和醒目的 SmartScreen 警告。
- 不开发插件市场、局域网访问、远程连接、会话重写或完整 DSH fork。
- 保留官方 DSH Web UI，不复制、不修改其业务界面。
- 保留 `io.github.xydadada.adhd`，确保 v0.1.0 可以原位升级。

## 2. 进度口径与当前基线

进度采用固定 90 分的静态实施口径。只有源码、类型、单元/集成测试、工作流和发布元数据可以计分；真实安装、干净 Windows 11、性能、SmartScreen、中文用户名和长路径属于独立的“经验验证”栏，不计入 90 分，也不能被描述成已经通过。每次合并后记录 commit、静态命令和可用 CI 证据。

发布门槛：Stable 要求静态实施项达到 90/90，或对未完成项给出醒目的已知限制；不得用“理论正确”替代真实兼容性或性能声明。

当前发布状态：最新 Stable 是 `v0.1.0`；`v0.2.0-beta.1` 和 `v0.2.0-beta.2` 均为 prerelease；`v0.2.0-beta.2` 已于 2026-08-15 发布，11 个 Release API 上传资产可公开下载（GitHub 另提供自动生成的源码归档）；`v0.2.0` Stable 尚未发布。

当前静态实施进度：**90/90（100%）**。本轮已补齐 STARTUPINFOEX 原子 Job/受限句柄继承、Runtime 异常收敛与 intent 竞态、严格 supervisor 首帧与字节级帧上限、Doctor 工具/结果/角色/审批验证、应用更新候选 generation 绑定与确认期串行化、attestation predicate、A/B 自回滚拒绝、损坏设置/失效工作区恢复、可重试 `.dsh` 导入、Portable 显式数据目录选择，以及最终闭包 SBOM 路径。静态实施口径已经完成；真实机器、安装器、SmartScreen、性能和真实 Provider 仍明确未验证。

本轮只允许运行 `npm run check`、定向 Vitest、TypeScript、JavaScript syntax、workflow 静态审计和 `git diff --check`；不运行 Electron、DSH、安装包、VM、性能或网络 Provider 实测。历史 Windows Server 2025 证据保留作为旧提交记录，但不证明本轮代码或 Windows 11 行为。

### 历史经验验证记录（不计入当前 90 分）

2026-08-15 GitHub Windows Server 2025 run `31823906216`（commit `e0a0a28`）的 build 与真实 Portable E2E 通过，Setup 为 151,024,728 bytes（144.03 MiB）；NSIS 安装版的 launch、force-kill、workspace-write 和十次启动共 13 个循环中 12 个通过。唯一失败是十次启动的第一个循环：Runtime PID、应用范围进程树和最终审计均已清空，但 Electron 在接受退出后未结束并被 E2E 强制终止。该 run 总结论为 failure。该 Server 结果不得作为本轮、Windows 11 或性能证据。

同日 run `31827138503`（commit `8927f7a`）的 Quality 通过，但 Windows verification 在 `npm run check` 阶段失败：15 个 evidence verifier 用例都把 runner 临时目录判为 `EVIDENCE_DIRECTORY_INVALID`，因此 build、installed 和 Portable job 未执行。该结果只证明当时 Windows runner 路径规范化存在兼容性缺口。

随后 run `31828488370`（commit `03d5d2b`）通过 Quality、build、Fuse、精确 Windows 资产校验和 Portable E2E。安装版首个 launch 达到 ready、退出码为 0，Runtime 与已知进程树均清空，但五秒最终路径审计仍发现 1 个新进程；清理阶段又遇到 NSIS key 在枚举后被删除的注册表竞态，导致 summary 未落盘。该 run 仍为 failure；当时的修复把 Electron hard-exit 后备从 250ms 调整为 1 秒，并只忽略已经实际消失的 registry key。

2026-08-15 commit `c6801bca6d18d7309861677de44d995e6d21102d`（attempt 1）的 Quality run `31857910832` 与 Windows Server 2025 run `31857910840` 全绿。`quality`、`codeql`、`build-windows`、`portable-e2e`、`installed-e2e` 与 `test-and-package` 均为 success；安装版 launch、force-kill、workspace-write 和十次启动共 13/13 循环通过，卸载后安装目录、应用范围进程、注册表和快捷方式均清理。Setup 为 151,012,081 bytes（144.02 MiB），低于 145 MiB 门槛。该旧提交的 Server 套件通过，但不计入当前静态分数，也不得作为当前源码、Windows 11 或性能证据。

`v0.2.0-beta.2` tag 的 release run `31859638726` 已完成构建、E2E、SBOM、摘要和 attestation，但原 workflow 在 draft 阶段错误地通过 tag endpoint 回读不可见的草稿，导致最终 job 标红；资产经 release ID 严格核对后发布。main commit `0e85253da21067e680ef6178f735d5736e2fcdaa` 已改为按 release ID 回读，Quality run `31860658337` 与 Windows verification run `31860658340` 全绿；该 Release workflow 修复仍须由下一次 tag 完成端到端验证后才能记为发布门禁证据。

| 编号 | 工作项 | 总分 | 已得 |
|---|---|---:|---:|
| R1 | Windows launcher、Job、隐藏控制台 | 8 | 8 |
| R2 | 生命周期、退出、崩溃恢复 | 6 | 6 |
| R3 | Supervisor 双向控制通道 | 5 | 5 |
| R4 | readiness、端口、Runtime 隔离 | 6 | 6 |
| D1 | ControlWindow、托盘、通知 | 5 | 5 |
| D2 | Quick Provider Doctor | 4 | 4 |
| D3 | Deep Provider Doctor | 7 | 7 |
| D4 | 首次启动、迁移、错误 UX | 4 | 4 |
| U1 | 应用更新 | 5 | 5 |
| U2 | Runtime 下载与验证 | 6 | 6 |
| U3 | Runtime A/B 与回滚 | 6 | 6 |
| U4 | 供应链与 Release 证明 | 3 | 3 |
| S1 | 原子设置与恢复 | 4 | 4 |
| S2 | AppData、Portable、旧数据迁移 | 4 | 4 |
| S3 | 安装、升级、快捷方式 | 2 | 2 |
| Q1 | 单元测试 | 5 | 5 |
| Q2 | 集成和故障 fixture | 5 | 5 |
| P1 | 品牌、仓库、Beta 发布基础 | 3 | 3 |
| P2 | 准确文档、兼容矩阵、推广 | 2 | 2 |
| **静态实施总计** |  | **90** | **90** |

经验验证（不计分）：历史 Windows Server 2025 打包测试曾通过；当前源码未在干净 Windows 11、真实安装/升级、中文用户名、长路径、SmartScreen 或性能条件下重新验证。

## 3. Reuse Gate：不重复造轮子

每个功能开始实施前必须按以下顺序完成 Reuse Gate：

1. 搜索当前仓库是否已有实现。
2. 搜索 DeepSeek Harness 官方仓库、npm 包和官方测试 fixture。
3. 搜索 Electron、Node.js、Microsoft、GitHub 等官方工具或示例。
4. 搜索 npm 上维护活跃且许可证兼容的包。
5. 搜索已有 DeepSeek Harness Desktop 社区项目。
6. 只有确认没有合适实现时，才允许自行开发。

采用优先级：

```text
直接调用现有依赖
> 安装成熟开源依赖
> 改编官方 MIT/BSD/Apache 源码
> 改编许可证兼容的社区源码
> 最后才自行实现
```

每项复用必须记录来源仓库、固定版本或 commit、许可证、复用文件或 API、本项目修改内容、未选择其他候选的原因，以及对体积和攻击面的影响。搜索结果必须转化为 `USE`、`ADAPT` 或 `REJECT` 结论。

搜索停止条件：已找到一个官方方案；或已找到两个许可证兼容的成熟方案并完成比较；或已确认现有工具不能满足安全、体积或兼容性要求。达到停止条件后立即实施，不进行无目标搜索。

禁止复制无许可证代码、为少量标准库代码引入庞大依赖、已有官方 API 时重新实现协议、仅因 Star 数量迁移架构、并存两套同类实现，或提前引入“以后可能需要”的依赖。

### 3.1 直接使用的依赖

| 工具 | 固定版本 | 用途 | 决定 |
|---|---:|---|---|
| Electron | `43.4.0` | Tray、Notification、窗口、安全沙箱 | USE |
| electron-builder | `26.15.3` | NSIS、ZIP、打包 | USE |
| electron-updater | `6.8.9` | Setup 应用更新 | USE |
| `@electron/fuses` | `2.1.3` | 生产 Fuse | USE |
| Koffi | `3.1.5` | Win32 API、Job、匿名管道 | USE |
| Zod | `4.4.3` | IPC、设置、manifest schema | USE |
| semver | `7.8.5` | Stable/Preview、升级和降级判断 | ADD |
| pe-library | `2.0.1` | 验证 Runtime 中 node.exe 的 PE 类型和 x64 架构 | ADD |
| sigstore | `5.0.0` | 应用内 GitHub attestation 验证 | USE |
| 7zip-bin | `5.2.0` | Runtime archive 列表和解压 | USE |
| ws | `8.21.3` | DSH mux WebSocket | UPDATE |
| Vitest | `4.1.10` | 单元和集成测试 | USE |
| Playwright | `1.62.1` | 通过 CDP 测试最终 EXE | USE |
| `@deepseek-ai/dsh-llm-mock-server` | `0.1.0-rc.6` | Provider 故障和 tool-call fixture | ADD |
| license-checker-rseidelsohn | `5.0.1` | 许可证闭包 | USE |
| Anchore SBOM Action | `v0.24.0` 固定 SHA | SPDX SBOM | USE |

删除未使用的 `electron-log`、`@sigstore/verify` 和 `electron-vite`。不引入 `got`、`axios`、`node-7z`、XState、native addon、Tauri、SEA、utilityProcess、WinAppDriver、Spectron 或自制 LLM mock server。Node 原生 `fetch`、`stream.pipeline`、`crypto` 和已有 7za 足够完成下载和解压。

### 3.2 DeepSeek 官方源码

固定上游：`deepseek-ai/DeepSeek-Harness@47f943859bef60e4160492346772ded9b24f765a`。

最小改编范围：Windows 参数转义、Win32 ABI 常量和结构、`CreatePipe`/`SetHandleInformation`/`PeekNamedPipe`/`ReadFile`、失败路径终止和 handle cleanup、atomic write、writer lock、RPC envelope、mux event 类型和 approval response schema。进程创建不再复用“先创建 suspended 再分配 Job”的竞态方案，而按 Microsoft Win32 指引使用 `STARTUPINFOEX` 的 Job/handle attribute list。官方 `@deepseek-ai/dsh-llm-mock-server@0.1.0-rc.6` 直接作为测试依赖使用。

### 3.3 社区项目

| 来源 | 许可证 | 复用内容 |
|---|---|---|
| `ningbainb/deepseek-harness-desktop@3adc77a` | BSD-3 | 严格 ready URL、退避测试、bind race 测试 |
| `bruc3van/dsh-desktop@d6180e6` | MIT | 空 PATH packaged smoke、bundled runtime 断言、runtime closure prune 方法 |
| `dataelement/dsh-desktop@cbcb931` | MIT | TypeScript 契约、导航和窗口测试行为 |
| `baiyuscc13724-max/deepseek-harness-desktop@f49e2da` | MIT | Release 列表筛选、Stable/Preview、checksum 和资产审计 |
| electron-builder 官方仓库 | MIT | NSIS `/S` 安装和卸载、安装后 EXE 黑盒测试 |

无许可证项目只参考产品行为，不复制代码。所有复用写入 `THIRD_PARTY_NOTICES.md`。

## 4. 执行与并行规范

### 4.1 主 agent 与 subagent

主 agent 负责架构和产品决策、接口冻结、安全边界、跨模块依赖、合并、验证和最终发布判断。Subagent 只负责独立许可证审计、单一模块只读审计、单一 GitHub 项目研究、明确接口对比、写入范围完全独立的小补丁或机械测试补充。

- 同时最多开启 8 个 subagent，每个只接收一个明确、低冲突的问题；主 agent 仍负责关键决策和集成。
- 不把关键路径的下一步交给 subagent；输出只能作为证据，关键决策由主 agent 作出。
- Luna Max subagent 返回慢是可预期的；主线程不能停下来等待，应继续做不重叠的命令、代码审计和计划工作。
- 不反复 wait；到集成点最多集中等待一次。
- 小任务允许约 10–15 分钟墙钟时间；超时先要求立即摘要，再给 3 分钟收尾窗口，仍无结果就关闭。
- 不允许主线程重复做已委托的同一研究。

### 4.2 命令批量并行

一次性并行执行多个独立的 `rg`、`git status/log`、`gh api`、`npm view`、社区仓库只读检查、文件清单和不写相同目录的测试。不得并行写同一 `node_modules`、`dist`、DSH_HOME、端口或更新槽；不得并行运行构建与 prune、安装与卸载，或多个 agent 修改同一文件。

最优构建顺序：

```text
prepare Electron
+ prepare Runtime
+ prepare Runtime archive
+ generate icons
+ compile TypeScript
只执行一次

然后复用已校验中间产物，依次构建 Setup 和 Portable
```

不为并行而重复下载、解压或生成 Runtime。

### 4.3 慢命令规则

| 类型 | 正常时间 | 超时或异常处理 |
|---|---:|---|
| `rg`、`git status`、本地文件检查 | 1–5 秒 | 超过 15 秒检查是否误扫 node_modules/runtime/dist |
| `npm view`、单个 `gh api` | 2–15 秒 | 超过 30 秒取消，改用 API/CLI |
| 批量 GitHub metadata | 5–30 秒 | 拆成有限并行请求，不抓完整巨大 tree |
| 网页搜索 | 10–30 秒 | 超过 60 秒改用 GitHub API 或官方 URL |
| TypeScript/Vitest | 10–60 秒 | 超过 2 分钟检查是否加载 runtime/node_modules |
| `npm ci` | 1–4 分钟 | 检查网络、缓存和 install scripts |
| Runtime 准备 | 1–4 分钟 | 检查是否重复下载或解压 |
| Windows 完整打包 | 5–8 分钟 | 超过 12 分钟检查压缩或签名步骤 |
| 安装后 E2E | 3–10 分钟 | 每个子步骤独立超时并留存日志 |
| Luna Max subagent | 可明显更慢 | 主线程继续，不空等 |

遇到异常慢命令，依次检查是否误扫大目录、重复下载/解压、误用网页搜索、把可并行查询串行化、等待无输出子进程、存在锁或遗留进程、使用错误 shell、未复用已校验中间产物，或当前方案本身过度复杂。长命令运行时主 agent 必须继续处理不冲突的工作。

## 5. 技术实现方案

### 5.1 Runtime、进程和退出

模块职责：`RuntimeController` 管理状态机、generation、队列和崩溃恢复；`WindowsPlatformAdapter` 管理 Win32 进程、Job、匿名管道和路径；`UpdateManager` 管理双通道更新；`ProviderDoctor` 管理诊断；`SecureBridge` 管理最小 IPC；`WindowManager` 管理 HarnessWindow、ControlWindow、托盘和通知；`SettingsStore` 管理原子设置、备份和迁移。

Runtime 状态保持：`idle → preparing → starting → ready → stopping`，另有 `updating` 和 `failed`。所有 start、stop、restart、update 进入一个串行队列；每次启动递增 generation，旧进程、旧 timer、旧管道事件不能污染新实例。

崩溃重启为 `0.5s → 1.5s → 4.5s`，十分钟内最多三次，稳定运行十分钟后清零。停止、退出或更新时取消 restart timer。

### 5.2 Windows supervisor 与匿名管道

不再开发命名管道 DACL 或 native addon。使用 Koffi 创建 parent→supervisor 和 supervisor→parent 两组匿名管道；只让 supervisor 端 handle 继承，supervisor stdin 接收命令，stdout 输出状态 JSON Lines，日志直接写脱敏文件。

启动顺序固定：创建 Job Object 并启用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；构造 `STARTUPINFOEX`，用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 `CreateProcessW` 成功时原子加入 Job，并用 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 只允许继承 supervisor stdin/stdout 两个 handle；创建 flags 保留 `CREATE_NEW_PROCESS_GROUP | CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT`，配合 `STARTF_USESHOWWINDOW + SW_HIDE`。属性、创建、终止、等待或句柄关闭失败均显式报错，禁止降级为未托管运行。

管道帧为 UTF-8 JSON Lines，单帧上限 64 KiB；消息携带并校验版本、nonce、generation 和 PID。读取端复用官方 `PeekNamedPipe`/`ReadFile` 模式，低频轮询并在有消息时排空，停止后取消 timer。匿名管道不开放网络控制接口。

正常退出发送 stop，等待 5 秒，超时终止 Job；Electron 异常退出时 Job handle 关闭并清理完整子进程树。所有退出来源由 `QuitCoordinator` 统一处理。

### 5.3 Port、readiness、数据隔离

DSH 绑定 `127.0.0.1`，优先使用保存的首选端口；明确 `EADDRINUSE` 时只重试一次 `--port 0` 并保存新 origin。拒绝 `0.0.0.0`、非回环 IPv6、混淆主机名、userinfo URL 和非 HTTP loopback URL。ready 必须同时满足精确 URL、POST `/api/host.describe` 成功且业务结果 `ok: true`；技术启动超时 45 秒。

安装版数据布局：

```text
%APPDATA%\ADHD One\
  settings.json
  settings.json.bak
  dsh-home\

%LOCALAPPDATA%\ADHD One\
  runtimes\
    bundled\
    slot-A\
    slot-B\
    runtime-state.json
  cache\
  staging\
  logs\
```

配置写入采用同目录临时文件、独占创建、flush、rename 和 `.bak`；主文件损坏时读备份，两份都损坏进入修复页，不覆盖原文件。检测旧 `~/.dsh` 时使用 staging 复制导入，源目录不变；新目录已存在则不重复迁移。Portable 数据目录不可写时要求用户选择可写目录或退出，不静默回退到 AppData。

### 5.4 窗口、托盘和安全

HarnessWindow 只加载精确的 DSH loopback origin，无 preload、无 IPC、无 Node integration，开启 sandbox/context isolation。ControlWindow 使用自定义 `adhd-one://app/*` 协议，只能通过 SecureBridge 调用产品级操作。

保持 Electron 安全基线：禁止任意导航、新窗口、下载和权限；外链仅允许明确 HTTPS 白名单；IPC 验证精确 origin、ControlWindow `webContents.id`、main frame、参数 schema、路径归属和当前状态；生产 Fuse 保持 `RunAsNode=false`、Cookie encryption、禁用 Node Options/CLI inspect、ASAR integrity 和 OnlyLoadAppFromAsar。

托盘必须支持显示/隐藏、状态和版本、重启 Harness、打开工作区/数据/日志目录、Provider Doctor、应用/Runtime 更新检查和完整退出。首次关闭窗口只解释一次缩到托盘。通知仅用于启动、异常退出、更新、回滚和可信本地 UI 通知。

### 5.5 Provider Doctor

Quick Doctor 使用官方 RPC 和 schema 检查 `host.describe`、`agentPreset.list`、`llm.providers`、`llm.models`、`settings.describe`、`credentials.describe`、OpenAI-compatible model discovery、endpoint、HTTPS、DNS、TLS 和超时。密钥只报告是否配置及来源，不读取或显示完整值。

Deep Doctor 必须先显示 Provider、模型、reasoning 设置、可能费用和最长等待时间，并要求用户单独确认。使用随机临时 workspace 和 nonce，通过官方 mux 事件严格验证：

```text
assistant → write tool/call → write tool/result → read tool/call → read tool/result → assistant/message → completed turn/end
```

必须确认 tool arguments 是合法 JSON、sentinel 文件内容正确、工具结果被第二轮模型消费、最终回答包含 nonce；任何一步缺失都不能报告成功。AbortSignal 贯穿 fetch、WebSocket、等待和清理；workspace 外审批自动拒绝并报告 `TOOL_ESCALATION_REQUIRED`。Doctor 失败不触发 Runtime 回滚，完成后归档诊断 Session 并清理临时 workspace。

直接使用官方 mock server，覆盖认证、429、500/503、连接重置、流断开、stall、malformed JSON/SSE、reasoning、tool-call、空响应和 max tokens 等 fixture。报告只含版本、OS、Provider/model、检查项、耗时、稳定错误码、脱敏 endpoint 和 request ID。

## 6. 双通道更新

### 6.1 应用更新

使用 `electron-updater` GitHub provider。Stable 排除 prerelease，Preview 允许 beta/rc；检查、下载和安装均需用户确认，不静默安装。使用 semver，不用字符串比较。下载完成后验证 SHA-512、额外 SHA-256 及 GitHub Sigstore issuer、repository、固定 workflow、tag ref 和 subject digest；验证完成后才允许 `QuitCoordinator` 停止 DSH 并 `quitAndInstall()`。Portable 只提示下载新 ZIP，不原地覆盖。

### 6.2 Runtime 更新

不使用 `releases/latest/download`。通过 GitHub Releases API 获取候选：Stable 只选正式 Release，Preview 允许 prerelease，按 semver 选最高兼容版本，并要求 manifest 和资产存在。manifest 最大 1 MiB，校验 schema、平台、架构、channel、`minAppVersion`、协议兼容性、版本和 attestation 字段。

下载流程固定为：

```text
fetch redirect:manual
→ 验证每次 URL 和最终 GitHub 下载域
→ Readable.fromWeb
→ byte-limit/hash Transform
→ createWriteStream(.part, wx)
→ flush
→ rename
```

拒绝任意重定向、伪造或缺失大小、SHA-256 不符、attestation 不符、Stable 降级和不支持的协议。下载失败删除 `.part`，保持当前 Runtime。

Archive 流程固定为：

```text
7za l -slt
→ 拒绝绝对路径、..、ADS、link、junction、reparse
→ 7za x 到同卷 staging
→ pe-library 验证 node.exe x64
→ package/version/integrity/pnpm 验证
→ dsh --version、web readiness、host.describe、agentPreset.list、Session 和 mock tool-call smoke
→ 移动至非活动 A/B 槽
→ 原子更新 runtime-state
→ 实际 ready 后标记 healthy
```

候选失败、协议不兼容或连续崩溃回滚到 previous healthy；认证、限流、网络和 Provider 错误不触发 Runtime 回滚。bundled Runtime 永久只读保留。

## 7. 公共接口与持久化契约

- `RuntimeSnapshotV2`：state、generation、runtimeVersion、slot、health、pid、url、restartAttempt、error。
- `RuntimeStateFileV1`：bundled、slotA、slotB、active、previousHealthy、candidate、installedAt、healthyAt。
- `UpdateSnapshotV2`：target、channel、phase、currentVersion、candidateVersion、receivedBytes、totalBytes、canConfirm、canInstall、rollback、error。
- `DoctorReportV2`：检查项、耗时、稳定错误码、provider/model、脱敏 endpoint、request ID，以及 tool-call/result、参数解析、文件验证、二轮消费和最终 nonce 的布尔证据。
- `AppSettingsV3`：locale、workspace、preferredPort、app/runtime channel、closeToTrayExplained、portableDataPath、migration。
- Supervisor JSONL：版本 1、64 KiB 上限、nonce、generation、PID；仅通过匿名继承管道传输。
- SecureBridge：只暴露产品级操作，不增加任意文件、shell、进程、URL、原始 IPC 或原始事件接口。

契约语义固定如下，实施者不得自行创建第二套解释：

- Runtime `health`：`ready` 为 `healthy`，`failed` 为 `unhealthy`，其余状态为 `unknown`；`restartAttempt` 只统计当前十分钟崩溃窗口内已调度的自动重启，手动 start/stop/restart 不增加，稳定十分钟清零。
- Update `canConfirm` 只在 `available` 为真；安装版 App 在 `verified` 时 `canInstall=true`，Portable 始终为假；Runtime 的 confirm 已包含校验与槽位提交，因此 Runtime `canInstall` 始终为假。`rollback` 仅表示已提交的未健康 Runtime 候选仍有 previous healthy/bundled 可回退。
- Doctor 顶层 provider/model/endpoint 指当前默认路由；Quick 检查多个 Provider 时，其他结果只进入 checks。`requestId` 是本次 Doctor run 的随机 ID，不复用或暴露底层 RPC ID。Quick evidence 全为 false；Deep 的 `secondTurnConsumed` 表示模型消费 write 结果后继续发起 read，并消费 read 结果后给出最终 nonce。
- `runtime-state.json` 继续兼容当前 schema v1 输入；只有实现完整的原子迁移和回滚测试后才可切换到扩展的 `RuntimeStateFileV1` 字段，不因 TypeScript V2 快照而提前改写用户状态文件。

## 8. 分阶段实施与门槛

### 阶段 A：Runtime 和接口冻结，36% → 50%

冻结 Runtime、Update、Doctor、Settings 类型；匿名双管道替换命名管道；实现 QuitCoordinator；修复 restart timer、generation 和十分钟稳定窗口；补 Job 失败清理和 SecureBridge sender 校验；补 Runtime/IPC 测试。

```powershell
npm run test:runtime
npm run test
npm run smoke:runtime
npm run smoke:runtime-staging
```

以上均为当前 `package.json` 中可执行的脚本；专用 IPC 拆分脚本尚未注册，暂由全量 `npm run test` 覆盖。

`npm run smoke:runtime-staging` 已通过并验证候选 `slot-A` 的 Runtime readiness、host/tool round-trip、session archive 和退出清理；输出为 `RUNTIME_STAGING_OK slot=A version=0.1.0-rc.6`，且未留下 staging 临时目录或候选进程。

完成标准：所有退出来源走同一逻辑；停止或退出不再延迟重启；旧 generation 不改变新实例；五秒内 Job 子进程为零。

### 阶段 B：双通道更新，50% → 67%

实现 App Stable/Preview、Runtime Release 筛选、manifest/资产流式校验、redirect 白名单、digest/attestation、archive 安全检查、Runtime smoke、A/B 激活、healthy/rollback 和确认 UI；Portable 只提示下载。

```powershell
npm run test:update
npm run smoke:runtime-archive
npm run smoke:runtime-update
npm run audit:signatures
```

`smoke:runtime-update` 直接消费发布用 `vendor/dsh-runtime.7z`，经过真实列表、解压树、PE/依赖闭包、Runtime staging Session/tool-call smoke 和 A/B journal 提交；Windows 与 Release workflow 都在共享构建完成后执行该门禁。

更新服务故障由现有 Vitest fixture 覆盖；Release attestation 由固定 SHA 的 `release.yml` 和 `gh attestation verify` 路径验证，不再维护一套重复的本地包装命令。

完成标准：Stable 不安装 prerelease；Preview 能看到 beta/rc；坏 manifest、摘要、证明或 archive 全部 fail closed；RuntimeController 实际从 healthy A/B 槽启动；Provider 错误不触发 Runtime 回滚。

### 阶段 C：Provider Doctor 和桌面 UX，67% → 78%

补 Quick Doctor、Deep Doctor 费用确认和取消、mux 严格事件证据、官方 mock fixture、托盘路径和更新入口、首次缩托盘说明、`.dsh` staging 迁移、Portable 不可写处理和 renderer 错误处理。

```powershell
npm run test:doctor
npm run check
```

当前静态核验结果：`npm run check` 为 36 个 test files（448 个通过、1 个 Windows 8.3 alias 回归跳过），JavaScript syntax 覆盖 31 个文件，TypeScript 无错误。旧 Portable EXE 的 mock PowerShell 结果仅作历史记录。

后续阶段待新增（当前不可执行）：

| npm 命令 | 用途 |
|---|---|
| `npm run test:renderer` | renderer 专项测试 |
| `npm run smoke:doctor` | Doctor 真实 smoke |

上述门槛已经满足，`v0.2.0-beta.2` 已发布；后续 RC/Stable 不得回退这些验证门槛。

### 阶段 D：历史打包后自动 E2E（当前修订不重复运行）

GitHub `windows-2025` 构建一次并复用产物。workflow 对最终 Portable ZIP 执行真实启动/退出/隔离检查，并对 Setup `/S` 隔离安装后的 EXE 固定执行 launch、force-kill、workspace-write、Runtime 坏候选回滚和十次启动，共 14 个循环；随后静默卸载并检查安装目录、应用范围进程、注册表和快捷方式残留。commit `a0e436d67805f921511d3b5ec5e4d1d075dadcbe` 的 run `31870530357` 已通过完整 14 循环、严格 evidence verifier、Portable 和总门禁。这不包含阶段 E 的 Windows 11 与性能资格。

```powershell
npm run build:ci
npm run e2e:packaged -- --exe ".\dist\win-unpacked\ADHD One.exe" --output ".\evidence\packaged.json" --cycles 1
npm run e2e:packaged -- --exe ".\dist\win-unpacked\ADHD One.exe" --output ".\evidence\packaged-10-cycles.json" --cycles 10
```

安装版与 Portable 专项 E2E 已由 `.github/workflows/windows.yml` 和 `.github/workflows/release.yml` 直接调用 `scripts/e2e/installed.ps1`、`scripts/e2e/packaged.mjs` 与 `scripts/verify-evidence.mjs`。本阶段不再维护一套功能重复的包装脚本；本地复现应使用 workflow 中记录的同一参数。

失败时保留脱敏日志、Playwright trace、Runtime snapshot、进程树、安装路径清单、性能和包体报告。

### 阶段 E：可选的真实 Windows 11 经验验证（不阻断 v0.2.0）

这些脚本保留给后续自愿验证，但项目所有者已决定本版本不实际执行。任何未来结果都必须绑定准确 commit/EXE digest；不得把 Server 结果描述成 Windows 11 结果，也不得在未运行时写成通过。

当前可执行：

| npm 命令 | 用途 |
|---|---|
| `npm run prepare:win11-runner -- --output "C:\adhd-one-win11-runner" --node "C:\path\to\node.exe"` | 从固定脚本清单和 lockfile 闭包生成自包含 runner |
| `npm run e2e:qualification -- --exe ".\dist\win-unpacked\ADHD One.exe" --output ".\evidence\qualification.json"` | 单实例验证首次交互、热重启、一分钟整进程树 CPU、五秒退出和零残留 |
| `npm run e2e:win11 -- -SetupPath "C:\path\ADHD-One-Setup-0.2.0-beta.2-x64.exe" -EvidenceRoot "C:\adhd-one-win11-runner\evidence" -RepoRoot "C:\adhd-one-win11-runner"` | 干净 Win11 四行路径矩阵；每行安装/卸载并跑一次 qualification，不重复完整 14-cycle 套件 |
| `npm run verify:win11-evidence -- .\evidence\win11-evidence.json` | 离线校验严格、无路径的 Windows 11 x64/build、EXE SHA-256、性能和零残留进程证据 |

已实现本地汇总闭环：qualification 在启动前哈希实际 EXE，安装脚本在 qualification 结束且卸载前再次哈希并要求 digest 一致，再把严格校验后的性能/零残留、host proof 和 EXE proof 汇总为路径无关的 `win11-evidence.json`。仍未闭环的是把完整安装套件、四行路径矩阵及这些证据绑定到签名/attestation；本地 JSON 不能单独作为 Stable 证明。

目标指标仍保留为未来经验验证标准：Setup ≤145 MiB、首次可交互 ≤15 秒、热启动 ready ≤8 秒、空闲 CPU <1%、退出五秒内 Job 活动进程为零，以及中文用户名/干净 VM 兼容；当前全部标记“未验证”。

### 阶段 F：静态放行与 Stable，90/90（源码门槛已完成）

修正中英文 README，清理未使用依赖，生成 notices、最终 unpacked closure 的 SBOM、摘要、attestation bundle 和 trusted root snapshot；检查 tag、package version、资产名和 manifest 一致；发布 unsigned 与“未做真实 Windows 11/性能验证”警告。Windows 11 evidence 不再是硬门槛；没有证据时不得生成或上传伪 evidence。Stable 后再提交 Showcase、awesome PR、WinGet/Scoop。

`v0.2.0` Stable 的目标资产（不是当前 Stable `v0.1.0` 的下载清单）：

- `ADHD-One-Setup-0.2.0-x64.exe`
- `ADHD-One-Portable-0.2.0-win-x64.zip`
- Runtime archive
- `SHA256SUMS.txt`
- `runtime-manifest.json`
- SPDX SBOM
- `THIRD_PARTY_NOTICES.md`
- attestation bundle
- 可选的 Windows 11 evidence（仅在真实执行并通过时提供）
- 中英文 Release Notes

## 9. 打包、CI 与发布

`quality.yml` 执行 TypeScript、Vitest、actionlint、CodeQL、npm audit、npm audit signatures 和许可证闭包；dependency review 仅在 Pull Request 事件执行。`windows.yml` 配置了 Runtime 准备、一次性构建、真实 electron-updater loopback feed、Setup/Portable、安装版固定 14 循环、Portable ZIP 专项 E2E、证据上传和包体大小检查；commit `a0e436d67805f921511d3b5ec5e4d1d075dadcbe` 的 Quality run `31870530352` 与 Windows run `31870530357` 均全绿。仍没有 Windows 11 或性能合格证据；`release.yml` 从 tag 对应 commit 在同一可信 workflow 重新构建，再完成安装版/Portable E2E、SBOM、attestation 和 Release。

所有 GitHub Actions 固定完整 commit SHA；Release workflow 增加 `concurrency` 和 `timeout-minutes`；不发布普通 CI 中未经当前 Release workflow 证明的二进制。缓存只包含 npm cache 和 SHA-256 已验证的 Node 官方压缩包，不缓存最终 Runtime closure、SBOM、证明或 Release 资产。

Release workflow 为发布资产生成 SHA-256 与 SPDX SBOM；npm signatures 校验锁定依赖；许可证扫描覆盖实际闭包；GitHub attestation 与离线 bundle 只覆盖 workflow 明确列出的 primary subjects。生产 Fuse、sandbox、context isolation 和导航限制不能因测试方便而降低。

## 10. 测试与验收

单元测试覆盖状态机、generation、Windows 参数、URL/path、manifest、archive entry、settings recovery 和报告脱敏；集成测试覆盖匿名双管道、Job 调用顺序、退出协调、restart cancellation、流式下载、A/B 回滚、Doctor mux 状态机和官方 mock server 故障类型。

历史自动化打包测试曾覆盖 Setup、Portable、空 PATH、PowerShell、workspace-write、tool-call、十次启停、显式强杀和应用范围内无残留进程；它不证明当前未运行的新代码。当前放行仅要求 SHA-256、npm signatures、最终 unpacked closure 的 SPDX SBOM、licenses、GitHub attestation、offline bundle、中英文说明和静态检查；Windows 11 evidence 与性能证据可选，缺失时必须醒目标注“未验证”。

## 11. 最终统一规则

- 不因赶 Beta 跳过 Runtime、更新或 Doctor 闭环。
- 不因测试方便降低生产安全。
- 不因追求并行而重复构建相同产物。
- 不因 subagent 慢而让主线程空等。
- 不因一个命令异常慢而无限等待，先判断路径是否错误。
- 已有官方工具、库或许可证兼容实现时不得重复开发。
- 只能存在本文档这一套计划、进度表和发布口径。
