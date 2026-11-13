# 2026-11-14 Devin 用量采集（0.2.33）

原始提示词（一字未改存档）：

> 拉取 http://192.168.88.125/zhangxuelian/tokenrank 代码，增加Devin Desktop与Devin CLI的用量采集，合并上报为Devin，更新Readme文件，再推送回仓库

## 本机排查结论

排查环境装有 Devin Desktop（`%LOCALAPPDATA%\Programs\Devin`，Devin.exe，原 Windsurf 更名）与 Devin CLI（`%LOCALAPPDATA%\Devin\cli\bin\devin.exe`）。

### 数据源：两者共用一份会话库

Desktop 里发起的本地 agent 会话由 CLI 内核承载（`sessions` 表 `backend_type = 'windsurf'`，
系统提示里写明 "You are running as a coding agent inside Devin Desktop"），CLI 直连会话
写同一份库。因此一个采集器覆盖两个入口，天然合并为展示名 `Devin`，无需再对账。

库位置（官方文档 docs.devin.ai 的 on-disk formats 页 + 本机实测）：

- Windows：`%APPDATA%\Devin\cli\sessions.db`（官方文档说明 Windows 下 CLI 忽略 `XDG_*`）
- macOS / Linux：`~/.local/share/devin/cli/sessions.db`（遵循 `XDG_DATA_HOME`），macOS 另补查
  `~/Library/Application Support/{Devin,devin}`
- 政府隔离版：目录名 `cli-federal`，布局相同

### 库结构与口径（真机对账）

- `message_nodes`（消息森林，schema v5 起）每行的 `chat_message` 是 JSON 文本，
  assistant 消息的 `metadata.metrics` 为逐请求四分量：
  `input_tokens`（不含缓存）/ `output_tokens` / `cache_read_tokens` / `cache_creation_tokens`。
  库内 `context_input_tokens = input + cache_read + cache_creation`，与 Anthropic 口径一致，
  已实测对齐（样本请求 2 + 19523 + 1219 = 20744）。
- 模型：逐消息 `metadata.generation_model`（本机 342 条 assistant 全量非空），缺失退回
  `sessions.model`（如 `claude-opus-5-5-medium`）。
- 时间戳：`message_nodes.created_at` 为 Unix 秒，按北京时间分日。
- **必须按 `message_id` 去重**：消息森林把同一消息写到多个节点（本机 578 行仅 392 个
  message_id，342 条 assistant 去重后 171 个请求），重复节点 metrics 完全一致。
  真机对账：去重后 input 696 / output 96,523 / cache_read 28,596,765 / cache_write 266,671，
  采集器输出与手工累加逐位一致。
- `json_valid` 过滤后再 `json_extract`，坏行直接过滤；非 assistant 行（user/tool/system）
  由 role 条件排除。

### 排查后明确不采

- **Desktop 云端会话**：Agent Client Protocol 转录在 `%APPDATA%\Devin\User\acp-messages\*.db`
  （`meta` + `messages` 两表），只有 UI 侧消息（agent_message/agent_thought/tool_call）没有
  token 字段；云端按 ACU 计费，用量不出本地。
- **`User/globalStorage/state.vscdb`**：只有账号级配额缓存（计划窗口、ACU 已用/上限，
  protobuf 形态），无逐日明细。
- **`sessions.metadata` 的 `total_acu_cost` / `total_credit_cost`**：会话级累计值，
  无逐日拆分依据（混日会话只能整段归到最后活跃日，不符合本项目日桶口径），不并入 credits。
- 旧版 Windsurf（更名前）的数据目录本机不存在，未纳入发现路径；如后续确认 `%APPDATA%\Windsurf\cli\sessions.db`
  有同构数据再评估。

## 版本例行动作（0.2.33）

- `client/package.json` + `package-lock.json`、`server/public/install.sh` / `update.sh`（含 `.ps1`）升至 0.2.33，新增 `server/public/releases/0.2.33/` 快照
- 小程序接入命令（`connect.js`）与「说明」页审计提示词（`about.js`）同步更新
- README / client/README / miniprogram/README 补充 Devin 的数据源、口径与关闭开关
  （`TOKENRANK_DEVIN_DISABLE=1`），deploy/k8s/CLIENT-CONNECT.md 分发包地址同步
- 测试：`client/test-sync/devin.test.mjs` 8 个用例（四分量与去重、北京时区跨日、
  generation_model 覆盖、零值/坏行跳过、跨库去重、容错、批次合并、三平台发现路径）；
  运行真实同步链路的 5 个测试文件补 `TOKENRANK_DEVIN_DISABLE=1`，防止宿主机真实
  Devin 数据混入夹具
