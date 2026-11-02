# 2026-11-02 第二批终端用量采集（0.2.30）

原始提示词（一字未改存档）：

> 同步仓库端最新的代码到本机，再添加独立的Cline用量采集，Kiro用量采集，CodeBuddy用量采集，OpenCode用量采集，QoderWork用量采集，Zed用量采集，豆包以及豆包工作用量采集，TeleAgent用量采集，OortCodex XP Edition用量采集，kimi用量采集，JoyCode用量采集，CodeArts Agent以及CodeArtsSpace用量采集，Comfy用量采集。改好后更新一下Readme，以及升级一下install.sh / update.sh 里的VERSION记得修改，再更新Readme，以及把提示词也存档，再推送回仓库

说明：同步仓库时发现 CodeBuddy 已由协作者在 0.2.29 实现（`2fd5b06`），本次版本号顺延为 0.2.30。

## 本机逐一排查结论（4 个并行探查，只读打开所有 sqlite）

### 已实现（extra.js，0.2.30）

| 终端 | 展示名 | 数据源与口径 | 真机对账 |
|---|---|---|---|
| 独立 Cline | Cline | VS Code 变体（Code / Code - Insiders / Code - OSS / Cursor / Windsurf / VSCodium）`globalStorage/saoudrizwan.claude-dev/tasks` 的 Cline 系 `ui_messages.json`；装在 OortCloud AI Studio 里的归 oort.js，不重复计 | 本机独立变体无数据（Cline 装在 AI Studio，已被 Oort 系采集） |
| Roo Code | Roo Code | 同上，`rooveterinaryinc.roo-cline` | 本机空壳无数据 |
| JoyCode | JoyCode | `%APPDATA%\JoyCode\...\globalStorage/joycode.joycoder-editor/tasks`，Cline 系格式，无模型名 | ✅ 47,254 = task_history 的 46,871+383 |
| QoderWork | QoderWork | `~/.qoderwork/projects` Claude Code 风格转录，`message.usage` Anthropic 四分量 + 模型名，按 uuid 去重 | 本机 token 全零（Qoder 网关不下发真实计数），零值自动跳过 |
| Kiro | Kiro | `~/.kiro/sessions` 逐会话 `messages.jsonl` 的 `usage_summary.promptTurnSummaries`（credit 点数），并入日行 credits | ✅ 0.320918 = 3 条手工累加一致 |
| TeleAgent | TeleAgent | OpenCode 分支，`~/.local/share/TeleAgent/teleagent.db`（data 列 BLOB → CAST 后解析） | 本机库表全空（装了未用），无数据 |
| CodeArts Agent | CodeArts Agent | 华为 OpenCode 分支，`~/.codeartsdoer/*/opencode.db` 同构解析，带模型名 | ✅ 14,226 = 14,189+37 与 message.data 一致 |

### 排查后明确不采（用量不在本地或结构不符）

- **OpenCode 本体**：上游 token-watcher 已覆盖（`~/.local/share/opencode/opencode.db`），不重复采。
- **Zed**：`threads.db`（zstd JSON）有 `cumulative_token_usage` 字段但本机真实样本全为空（zed.dev 云端计费），字段结构无法验证，暂不实现；待有非零落盘后再评估。
- **豆包 / 豆包工作**：聊天与用量在云端；本地 `User Data/coding/snapshot` 只有编码 agent 的文件改动审计（无 model、无 token），不适合按 token 口径采集。
- **Kimi**：桌面端聊天在服务端，本地只有模型目录缓存与生命周期日志；CLI 未安装（上游 Kimi For Coding 覆盖 CLI 场景）。
- **OortCodex XP Edition**：XP 会话 JSON（`AppData/Roaming/OortCodexXP/sessions/s_*.json`）只有 role/content/时间，无 token 字段；同机主产品 `~/OortCodexWork/cli/db/db.sqlite` 的 model_usage 已由 oort.js 的 OortCodex Desktop 采集，不重复。
- **CodeArts Space**：内核同为 OpenCode server，但本机会话存储 `~/.codeartswork/kernel/sessions` 已被删除，仅 `renderer.log` 有一次性残留；待目录重建后按 OpenCode 口径评估。
- **Comfy（ComfyUI Desktop）**：本地扩散模型推理无 token 概念；本机实际使用 Comfy Cloud，用量在云端账号侧，本地无明细。

## 版本例行动作（0.2.30）

- `client/package.json` + `package-lock.json`、`server/public/install.sh` / `update.sh`（含 `.ps1`）升至 0.2.30，新增 `server/public/releases/0.2.30/` 快照
- 小程序接入命令（`connect.js`）与「说明」页审计提示词（`about.js`）同步更新
- README / client/README / miniprogram/README 补充新终端的数据源、口径与"明确不采"清单
