# Oort 系工具用量采集

TokenRank 的采集内核 token-watcher 官方支持 13 种 AI 编程工具，不认识 Oort 系产品。本仓库在
**同步器内**（`client/sync/oort.js`）增加了 Oort 系补充采集：只读各产品自己的本机状态目录，
不修改 token-watcher 及其数据库，失败逐文件容错、不阻断同步。

## 采集范围

| 产品 | 展示名 | 数据源 | 状态 |
|---|---|---|---|
| OortCloud AI Studio（IDE，内置助手扩展 `oortcodex.oortcodex` 的 displayName 就是它） | `OortCloud AI Studio` | ① `%APPDATA%\OortCloud AI Studio\User\globalStorage\oortcodex.oortcodex\tasks\*\ui_messages.json` 中 `api_req_started` 消息尾带的 `{tokensIn, tokensOut, cacheReads, cacheWrites}`（内置助手实际落盘，逐请求、毫秒时间戳）；② 同目录 `claude-agent-acp\projects` 下的 Claude Code 格式转录（逐条 `message.usage`，用于 acp 后端的安装）；③ `{saoudrizwan.claude-dev, rooveterinaryinc.roo-cline}\tasks` 下同款任务记录（装了 Cline/Roo 的安装） | ✅ 已生效。三处是不同后端/插件，同一请求通常只落在其中一处，合并到同一个展示名 |
| DSH For OortCloud Work | `DSH For OortCloud Work` | ① `~/.dsh-oortcloud-work/sessions/<workspace>/<session>/session.v*.jsonl.zst[d]` 会话日志的逐请求用量（`assistant/message` 的 `data.usage`，或旧版 `assistant/chunk` 的 `chunk.usage`），带 `time` 与模型，按北京时间精确分日；② 日志解不开的会话退回 `~/.dsh-oortcloud-work/storages/session_projcache/sessions/*.json` 的 `tokenUsage.totals`（会话累计） | ✅ 已生效（0.2.26 起优先读日志） |
| OortCodex Desktop（独立程序，ZCode 内核） | `OortCodex Desktop` | `%USERPROFILE%\OortCodexWork\cli\db\db.sqlite` 的 `model_usage` 表（逐请求 input/output/cache_read/cache_creation 与 `started_at` 毫秒时间戳，与 ZCode 内核同构）；开发/预览版目录 `OortCodexWork Dev` / `OortCodexWork Preview`，按记录 id 去重。`%APPDATA%\OortCodexWork` 只是 Electron 界面缓存，不读 | ✅ 已生效（0.2.25 起） |
| OortOffice（OnlyOffice 外壳 + 内置 ZCode 内核） | `OortOffice` | `%LOCALAPPDATA%\OortOffice\zcode-home\.zcode\cli\db\db.sqlite` 的 `model_usage`（HOME 被指到 `zcode-home`，与 ZCode 内核同构）。没用过对话的安装没有该库，静默跳过 | ✅ 已生效（0.2.26 起） |
| Genspark Code（Genspark Super App 内的编码终端，由 [`client/sync/extra.js`](../client/sync/extra.js) 采集） | `Genspark Code` | `~/.local/share/gencode/opencode.db`（OpenCode 同构，逐请求 `message.data.tokens`）；Super App 壳与网页 agents 等其余空间无本地用量（见下节排查结论） | ✅ 已生效（0.2.27 起） |

刻意不读基础版 `~/.dsh`：token-watcher 官方支持该目录，读了会重复计数；只读 `-oortcloud-work` 变体。
ZCode（token-watcher 的 `zcode`，数据在 `~/.zcode`）与 OortCodex Desktop（`~/OortCodexWork/cli`）
是两套独立数据库，互不合并，也不会重复计数。

同一套补充合并流程还接入 WorkBuddy 各版本、DevEco Code 与 Genspark Code：由 [`client/sync/extra.js`](../client/sync/extra.js) 在全部本地磁盘上发现数据目录，排除 token-watcher 已覆盖的位置后并入日桶。详见 [`client/README.md`](../client/README.md) 的「全盘补充采集（0.2.21）」。

## 口径说明

- **总量含缓存**，与项目主口径一致：`tokens = input + output + cache_read + cache_write`。
- **ZCode 与 Oort 系严格分开**：ZCode（token-watcher 的 `zcode`，数据在 `~/.zcode`）保持原名
  不做任何改写；OortCloud AI Studio 的用量从它自己 `globalStorage` 下的任务/转录单独采集。
- **OortCodex Desktop 与 zcode 同口径**：`model_usage.input_tokens` 含 cache_read，入库时
  拆成新输入与缓存命中；`total = input + cache_write + output`（reasoning 已含在 output 内），
  按 `started_at` 的北京时间分日，并带出模型明细。
- **DSH 优先按请求分日**：会话日志里有逐请求的 `time` 与模型，跨零点的会话不会被整段记到同一天；
  分叉/种子会话（`isSeeded`）开头重放的父会话历史用 `time < createdAt` 排除，不会重复计入。
  日志是追加写、可能正被 dsh 占用：任一帧解不开就整份作废、退回 projcache 的会话累计值
  （按文件 mtime 归因，跨零点会话会整段记到后一天），两种来源对同一会话只取其一，不重复。
  Node 内置 zstd 解码器 22.15+ 才有；更早的 Node 一律走 projcache。
- **OortOffice 与 zcode 同口径**：`model_usage.input_tokens` 含 cache_read，入库时拆成新输入
  与缓存命中，按 `started_at` 的北京时间分日，并带出模型明细。它内置的 ZCode 内核只服务
  Office 面板，与 `~/.zcode`（token-watcher 的 `zcode`）是两个 home，不会重复计数。
- 金额估算（cost）仍只基于 token-watcher 的模型计价；Oort 增量暂不计价。
- 工具、模型与工具—模型明细按日全量上报（协议上限 models 1024 / tools 128 / tool_models 1024），不再按前 8 截断。

## OortOffice 的剩余限制

0.2.26 起 OortOffice 的用量从它内置 ZCode 内核的 `model_usage` 读取，因此只覆盖**本机这个
ZCode home 写过的请求**：只把 OortOffice 当文档编辑器用、从没打开过 AI 面板的安装没有这个库
（`zcode-home/.zcode/v2/tasks-index.sqlite` 里也只有空的任务表，没有任何 token 明细）。
要把这类安装也算进去，只能走平台侧：new-api（`workup.oortcloudsmart.com:2443/bus/apaas-newapi`）
有完整计量，`GET /api/dashboard/self/overview?days=N` 按天返回 tokens/calls/credits，各产品各持
一把令牌（OortCodex=43、OortOffice=90 等）。该接口需要有效的平台 `accesstoken` 请求头——本机
各应用落盘的令牌均已过期、主力应用的令牌为加密存储，无法长期稳定读取。可行方案（任选其一）：

1. 平台提供长效令牌或 sk 密钥可查的用量接口（`/v1/dashboard/billing/usage` 目前只返回
   全量 credits，无按日、无 token 数，不够用）；
2. 本地中转服务 `oortcloud-service.exe` 增加用量日志（它转发所有走它的请求）；
3. OortOffice 客户端把 token 用量写入可读的本地文件。

## 隐私

只读取上述目录中的用量数字与时间戳；不读取聊天内容、代码、文件路径，也不上传除聚合数字
之外的东西（与主项目一致）。

## 测试与维护

```sh
node --test client/test-sync/oort.test.mjs   # 采集与合并的单元测试
```

排障：同步日志中 `oort dsh 会话 … 解析失败，已跳过` / `oort <扩展目录> 任务 …` /
`oort <产品> 数据库读取失败，已跳过` 为单文件（单库）容错提示，不影响其余数据。
设置环境变量 `TOKENRANK_OORT_DISABLE=1` 可临时关闭补充采集（测试亦用此开关做隔离）。

## Genspark Super App / Genspark Code 排查结论（2026-10-31，0.2.27 修正）

Super App 本体仍是**薄壳 Electron 客户端**——下表对 `%APPDATA%\gensparkaio` 的排查结论
维持不变；但 0.2.27 的复查发现此前漏掉了 Genspark Code 空间自己的数据目录：
gencode（OpenCode 定制版）把逐请求用量写在 `~/.local/share/gencode/opencode.db`，
schema 与 OpenCode 完全同构，0.2.27 起由 `client/sync/extra.js` 以 DevEco Code 相同的
口径采集（展示名 `Genspark Code`）。

排查过的位置（`%APPDATA%\gensparkaio`）：

| 位置 | 结果 |
|---|---|
| `logs/app.log*.log` | 只有 HTTP 状态行（`/api/is_login`、升级检查），无任何请求体/用量 JSON |
| `logs/native.log.*` | 仅麦克风等设备事件 |
| `IndexedDB/`、`Local Storage/`、`WebStorage/` | 无 `tokensIn`、`total_tokens`、`used_credits`、`"usage":` 任何标记 |
| `Partitions/genspark-browser/`（内嵌浏览器分区） | 仅 132KB，无用量缓存 |
| `tracking-spool.json`、`user-config.json` | 空 / 配置项 |
| token-watcher 1.9.x `src/collectors/` | 无 genspark 采集器 |

**Genspark Code 的本地数据（0.2.27 新增采集）**：`~/.local/share/gencode/opencode.db`，
`message.data` 内 `tokens.input / output / reasoning / cache.read / cache.write`（reasoning
已含在 output 内）、`time.created`（毫秒）与 `modelID`，逐请求、带模型。本机实测：
4 个会话 287 次请求，与库内 `session` 表的 tokens 汇总列完全对账一致。发现规则只在名为
`gencode` 的目录（逐盘扫描 + `XDG_DATA_HOME` / `~/.local/share` 等已知位置）找
`opencode.db`；散落的 `opencode.db` 属于独立安装的 opencode（token-watcher 已覆盖），
不会重复采集。

仍无本地数据的部分：Super App 的网页 agents / genmail / speakly 等空间的聊天与 agent
用量在 genspark.ai 云端（`session.enc` 为加密会话，不破解）；credits 余额也以云端为准，
客户端库里的 `cost` 字段是按 Genspark 模型定价折算的积分值，采集只入库 token 数、不参与
金额估算。要覆盖云端部分仍需：① Genspark 官方用量/credits 导出或 API；
② 云端账目按用户汇总后由运维批量导入。
