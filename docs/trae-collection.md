# Trae 用量采集（credits + token）

token-watcher 不认识 Trae，Trae 本机也没有任何可直接读取的用量明细。本仓库的 Trae 采集走的是
**Trae 自己的官方用量接口 + 本机按天快照**：扩展在 Trae 进程内取用户已登录的会话令牌查询用量，
把按天聚合结果写进 `~/.trae-cn/credits-usage.json`；同步器只读这个文件。全链路**不改 Trae、不解密
任何数据库、不注入进程**。

状态：✅ 已生效（客户端 `client/sync/trae.js`，扩展源码 [`../client/trae-extension`](../client/trae-extension/README.md)）。

## 一、可行性与加密评估结论

| 对象 | 实测 | 结论 |
|---|---|---|
| 会话/用量库 `~/.trae-cn/ModularData/ai-agent/database.db` | 页头 magic `377f0682`，SQLCipher 加密，WAL 同密钥；库内无明文行可读 | 本地明细不可直接读取，也没有可长期稳定落盘的明文用量 |
| 传输 | `https://api.trae.cn/...`，TLS | 内容层另有一层：用量数字只在响应 JSON 里，需带会话令牌才返回 |
| 会话凭据 `~/.trae-cn/trae-jwt-token` | 明文 RS256 JWT，扩展也可用 `icube.common.getToken` 命令取 | 这是"谁在用 Trae"的凭据，**不是加密障碍**；本方案不读该文件，只用扩展宿主内的命令 |
| 硬啃 SQLCipher | 需要逆向 asar 找到口令派生路径并在运行时取 key | 技术上并非不可破解（口令必须进入进程内存），但成本随每次版本升级重付、结果不稳定，且属于对第三方闭源客户端的逆向；**本项目不采用、不封装**。产品口径的 credits 已经能从官方接口完整拿到，没有解密必要 |

补充：**"装个 Trae 插件授权就能读每会话 credits/token"是可行的**，已验证——扩展通过
`icube.common.getToken` 复用当前登录态，官方接口按会话返回 `credits_float` 与 `extra_info`
里的 token 四分量。因此本采集器不需要任何解密环节。

## 二、链路

```
Trae 扩展 trae-credits-poc (extension.js)
  icube.common.getToken → POST query_user_usage_group_by_session (usage_type [7], 30 天, ≤3 页)
  → 按天聚合 → ~/.trae-cn/credits-usage.json (schema 2)  ← 每 30 分钟自动刷新（v0.1.1 起），也可命令面板/触发文件即时刷新
        ↓ 只读
client/sync/trae.js  collectTraeDays()  → 日桶（与上报协议同构）
        ↓ mergeOortDays()（同日 token 相加、credits 按工具合并）
client/sync/report.js → 服务端 daily_totals（按设备按天整行替换）→ 榜单/分析/趋势
```

接口字段（实测）：

```http
POST https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session
Authorization: Cloud-IDE-JWT <icube.common.getToken 返回的会话令牌>
{ "start_time": <epoch 秒>, "end_time": <epoch 秒>, "page_size": 50, "page_num": 1, "usage_type": [7] }
```

| 字段 | 用途 |
|---|---|
| `credits_float` | **credits 取这个**（不是 `credits_amount`）；与 `amount_float` 逐行相等 |
| `extra_info.input_token / output_token / cache_read_token / cache_write_token` | token 四分量，全量行都有 |
| `model_name` | 模型名；Auto 模式行可能缺失 |
| `usage_time` | epoch 秒，按 UTC+8 归日 |
| `session_id` | 仅本机 SHA-256 前 8 位，用于判定活跃会话行数 |
| `user_input_preview` | 提示词预览 —— **不采集、不写快照、不输出** |

## 三、口径

- **token**：`input + output + cache_read + cache_write`，与项目主口径一致（含缓存）。接口返回的是
  **会话累计值**，活跃会话随使用变大；配合服务端"按设备按天整行替换"的语义收敛，与 DSH 采集同一口径。
- **requests**：当日活跃会话行数，**不是请求数**。
- **credits**：`credits_float` 按天合计（round6）。只有预置模型计费会产生 credits；自定义模型（BYOK）
  不计 credits，其 token 已含在 token 四分量中（快照以 `custom_*` 单列，采集器不重复拆分，避免与合计冲突）。
  展示名相同（如 `GLM-5.3` 预置与自定义同名）时按"credits>0 即预置计费"消歧。
- **模型明细**：快照 `models` 为 `[模型名, tokens]` 前 8 条、`models_full` 为全量（采集器优先），并入日桶的 `tool_models`（工具名固定 `Trae`）；0.2.34 起 token 维度明细按日全量上报（上限 1024/128/1024）。
  扩展 v0.1.2 起（2026-11-03 修复）：无 `model_name` 的行按计费事实归桶——已计费的 Auto 行报 `auto`；
  **未计费行（BYOK 自定义会话，API 不回传模型名）报「自定义模型」**，不再混入 `auto`（此前自定义模型
  token 污染 auto 归因、平台模型维度看不到自定义模型用量）。该桶 token 与 `custom_*` 聚合列同源一致。
- 金额估算（cost）仍只基于 token-watcher 的模型计价，Trae 增量不计价。

## 四、验证结果（2026-10-30 本机）

| 环节 | 实测 |
|---|---|
| 扩展查询 | HTTP 200，30 天窗口 96 会话，credits 合计 7181.00，0 条 credits=0 行，`credits == amount` 逐行成立 |
| 本机快照 | schema 1、15 个日行（2026-10-09～10-30）、tokens 1,809,134,961、credits 7182.87、会话行 96 |
| 同步器 | `rank push` 1/1 日被接受；10-30 行 34,156,207 tokens 全部归属工具 `Trae` |
| 服务端合并 | 同设备同日 `credits_json` = `{total: 457.125351, tools: [[qoder, 422.714951], [Trae, 34.4104]]}` —— Qoder（credits-only）与 Trae 的 credits 按工具正确并列，未互相覆盖 |

## 五、限制

- **滚动 30 天窗口**：扩展只回填最近 30 天。安装扩展之前的 Trae 用量采不到，早于窗口的日行不再更新（服务端已有历史保持不变）。
- 内部接口无稳定性承诺，字段可能随 Trae 版本变化；快照 `schema` 不匹配时采集器告警并跳过，不影响其余数据。
- 会话累计值 + 归日按 `usage_time`（会话最后使用时间）：跨零点的长会话总量记到后一天，两日合计可能略高于真实总量，榜单用途可接受。
- 未安装扩展 = 静默无数据（属正常形态，不是错误）。

## 六、开关与排障

```sh
node --test client/test-sync/trae.test.mjs        # 快照解析、容错、credits 合并
TOKENRANK_TRAE_DISABLE=1 node bin/tokenrank.js rank push   # 临时关闭 Trae 补充采集（测试也用此开关隔离）
```

日志中的 Trae 相关提示均为**跳过并告警**，不阻断同步：

- `trae 快照不可用，已跳过：…` —— 文件损坏或 schema 不识别（扩展版本与采集器不匹配，需同步更新两侧）；
- `trae 快照日 YYYY-MM-DD 晚于当前时间，已跳过该行`；
- `trae 快照日 … 的 credits=… 超出范围，已按 0 处理`。

Windows 上采集由计划任务 `TokenRankSync` 以 wscript 启动，**不重定向 stdout**，`~/.tokenrank/logs`
通常为空；要看告警请手动跑一次 `node ~/.tokenrank/app/bin/tokenrank.js rank push --dry-run`。
快照没更新时先在 Trae 命令面板跑「Trae Credits POC: 查询每会话 Credits」，看
`%TEMP%\trae-credits-poc-report.json` 的 `result`/`blocker`（`blocked + auth` 表示登录态失效，
在 Trae 里重新登录即可）。

## 七、隐私

扩展侧：不打印令牌，`session_id` 只留 SHA-256 前 8 位，不读取也不输出提示词与对话内容，只读查询
（≤3 页、间隔 ≥2 秒），不上传任何数据。采集器侧：只读 `~/.trae-cn/credits-usage.json` 里的按天聚合
数字与模型名，不打开 Trae 的加密库、不读 `trae-jwt-token`。上报内容与项目隐私声明一致：只有按天的
token 四分量、会话行数、credits、工具与模型名。

## 八、安装与分发

服务端自己分发扩展安装包（不走第三方市场）：镜像构建时由 [`client/scripts/pack-vsix.mjs`](../client/scripts/pack-vsix.mjs)
从源码打包 VSIX（纯 Node zip 写入、逐字节可复现），落到 `/dl/trae-extension/<版本>/…​.vsix(+.sha256)` 并更新
`/dl/trae-extension/latest.json` 指针。一键安装脚本从服务端下载并做 sha256 校验，优先用 `trae-cn --install-extension`
安装，找不到 CLI 时降级解压到 `~/.trae-cn/extensions/`（不写 extensions.json），已装同版本幂等跳过：

```powershell
& ([scriptblock]::Create((irm '<BASE>/install-trae.ps1'))) '<BASE>'          # Windows
```

```sh
curl -fsSL <BASE>/install-trae.sh | sh -s <BASE>                              # macOS（Linux 未真机验证）
```

飞书单聊发「**绑定**」返回 ① Trae 采集扩展与 ② TokenRank 同步器两段安装命令；「绑定 windows」「绑定 mac」
只返回对应系统的一段。扩展与同步器相互独立：没装同步器时扩展只写本地快照，不上传。
