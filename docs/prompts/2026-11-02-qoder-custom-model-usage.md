# 2026-11-02 Qoder（桌面版）自定义模型使用率排查报告

> 结论先行：**Qoder 企业网关只在 `usage.credits` 落真实消耗，token 四项恒为 0，且 `message.model`
> 是网关别名而非用户可见模型名**——本地链路上不存在自定义模型的真实使用率数据，模型维度对 Qoder
> 无可归因。这不是 tokenrank 采集/上报链路的故障；credits 总量与工具维度一直正常采集上报。
> 真实按模型用量只在 Qoder 网关/云端，需平台侧提供用量接口后方可接入（同 OortOffice 的"待平台配合"结论）。

## 1. 环境与版本（本机，2026-11-02）

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Qoder CN（桌面版） | **0.4.11**（0.4.9 保留） | 数据目录 `~/.qoder-cn/`，转录在 `~/.qoder-cn/projects/<编码目录>/<session>.jsonl` |
| token-watcher（采集内核） | **1.9.6**（github.com/luwill/token-watcher） | Qoder 采集器 `src/collectors/qoder.js`；安装于 `%LOCALAPPDATA%\TokenWatcher\node_modules` |
| TokenRank 同步器（客户端） | **0.2.32** | 适配器只读 token-watcher 统计库 + 补充采集；本仓库 `client/sync` |
| TokenRank 服务端 | 镜像 `983f931-b11021450`（client 0.2.32） | k8s 单副本，`tokenrank.oortcloudsmart.com:2443` |
| Trae 采集扩展 | 0.1.1 | 对照组：Trae 的模型维度 credits 已可采（走官方接口），Qoder 无对等接口 |

## 2. 数据链路与模块定位

```
Qoder CN 转录 ~/.qoder-cn/projects/**/*.jsonl（Anthropic Messages 同构）
  → token-watcher src/collectors/qoder.js
      usage.credits>0 → credit_usage(ts, tool, amount, dedup_key)   ← 无 model 列
      token 四项>0    → events(ts, tool, model, …)                  ← 本机恒不触发
  → client/sync/source.js readDays()/readCreditsMap()（日桶 credits{total,tools}，与 events 并集）
  → client/sync/report.js 上报 → server report.js/credits.js 校验 → daily_totals.credits_json
  → server/src/analytics.js 聚合（工具维度 $.tools，模型维度 $.models）→ 网页/小程序/飞书
```

## 3. 本机取证（2026-10-14 ～ 11-02，81 个会话文件全量扫描）

方法：逐行解析 `~/.qoder-cn/projects` 下全部 JSONL 的 assistant 行，统计 usage 四项、credits、
`message.model`（含 `qoder-custom-<uuid>/` 前缀识别）。扫描脚本要点存档于本仓库外
`e2e/credits-ui/scan-qoder-cn.cjs`（含别名×月份分布 `scan-qoder-alias.cjs`）。

| 指标 | 实测 |
| --- | --- |
| assistant 行（带 usage） | **14,457** |
| token 四项 > 0 的行 | **0**（全部为 0） |
| credits > 0 的行 | **14,457**（100%） |
| `message.model` 取值 | 网关别名三种：`qfmodel`（7,977）、`dfmodel`（6,469）、`qmodel_38max`（11） |
| `qoder-custom-*` 用户模型标记 | **0 行** |
| 别名时间分布 | `qfmodel` 2026-10～11 持续出现；`dfmodel` 仅 2026-10；`qmodel_38max` 零星 |
| 本地"别名→用户模型"映射 | 不存在（`state.vscdb` 60 个键无 model、`~/.qoder-cn/settings.json`/`state.json` 均无） |

辅助字段：`usage.billable`（本机样本为 false）、`original_credits`（折前）、`request_id`、
`service_tier`/`speed`/`inference_geo` 等——均不含用户可见模型名。

## 4. 排查点逐项结论

| 排查点 | 结论 |
| --- | --- |
| 上报接口触发 | ✅ 正常：credits 全量入 `credit_usage` 并上报（服务端该设备日行 qoder credits 数百/天） |
| 自定义模型参数传递 | ❌ 源头缺失：网关把模型名替换为别名，token 计数不下发；采集器拿不到真实模型名，token 事件也因全零不产生 |
| 埋点兼容 | 上游已做 `qoder-custom-*` 前缀剥离（供其他部署），本部署无用武之地；`credit_usage` 表无 model 列（上游表结构，项目约定不改上游） |
| 后端链路 | ✅ 无异常：credits 链路端到端验证通过；模型维度空是"源头无数据"而非链路坏 |
| 权限/限制 | 本地文件可读（明文 JSONL）；限制在网关侧（脱 token、别名替换模型名），不在本地权限 |

## 5. 已落地的处置

| 版本 | 改动 |
| --- | --- |
| 0.2.31 | `client/sync/source.js`：读到「tokens=0 且无模型明细的纯 credits 日」时，同步日志输出一行**口径提示**（每次同步最多一条，防刷屏），便于问询快速定位 |
| 0.2.32 | `client/sync/costs.js`：修复 cost-worker 子进程 stderr 被父进程丢弃的问题——此前口径提示与「超出上报协议范围」警告用户永远看不到；现逐行中继（`[tokenrank]` 前缀剥除） |
| 文档 | `client/README.md` 新增「Qoder 网关口径提示」「子进程日志中继」章节；本报告 |

验证：`rank push --dry-run`（0.2.32）首行输出 `[tokenrank] 口径提示：17 天只有 credits（tokens=0 且无模型明细…）`；
client 用例 25/25（含"纯 credits 日提示一行、混合日与无积分库不提示"）。

## 6. 刻意不做的事

- **不把网关别名当模型上报**：`qfmodel`/`dfmodel` 是网关槽位不是用户模型，上榜会误导用户、污染模型榜。
- **不改上游 token-watcher**：credits 不折算 token（无官方兑换率，编造即失真）、不往 `credit_usage` 塞模型列。
- **不给模型维度编造 Qoder credits**：服务端 0.2.24+ 支持 `credits_json.models`，但 Qoder 源头给不出分项，保持"无数据"而非补 0。

## 7. 后续官方变更的再评估触发条件与处理路径

| 触发条件 | 检测方法 | 届时处理 |
| --- | --- | --- |
| Qoder 转录恢复真实 token（usage 四项 > 0） | 重跑第 3 节扫描脚本，观察 `tokensPositive` | 上游 `events` 路径自动生效（token/模型/逐请求明细零改动上报），无需改 tokenrank |
| 转录出现 `qoder-custom-*` 或真实模型名 | 同上，观察模型取值分布 | 上游 `qoderModelOf` 已剥离前缀并归一，events 自动带模型；credits 仍无模型列（受表结构限制） |
| 本地出现别名→用户模型映射（配置落盘） | 复查 `~/.qoder-cn/settings.json`、`%APPDATA%\Qoder\User\globalStorage` | 可在适配器层做只读映射，把 credits 按"计费事实"归到模型维度（沿用 Trae 的"credits>0 即预置计费"消歧思路） |
| Qoder 平台提供用量查询接口（按模型/按用户） | 关注 Qoder 企业管理后台/官方 API 公告 | 仿照 Trae 采集扩展模式：扩展宿主内取会话令牌查询官方接口 → 本地按天快照 → `client/sync` 只读并入（接口、口径与安全边界见 `docs/trae-collection.md` 的同构做法） |

复测命令（任一新版本发布后 5 分钟内可完成）：

```sh
node --input-type=module -e "import(pathToFileURL('…/scan-qoder-cn.cjs'))"   # 或直接 node scan-qoder-cn.cjs
# 期望字段：tokensPositive / creditsPositive / models 分布；任一 token>0 或出现真实模型名即触发上表处理
```

## 8. 与其他终端口径的关系

- **QoderWork**（`~/.qoderwork/projects`，独立产品）由 `client/sync/extra.js` 采集：转录带真实模型名，
  但同一网关不下发真实 token 时全为零值、自动跳过——与本文结论同源（网关口径）。
- **Qoder（非 Work）** 由上游 token-watcher 覆盖，补充采集刻意不碰，避免重复计数。
- 对照组 Trae：credits 与模型维度均已可采（官方接口 + schema 2 快照），说明本报告的结论是
  Qoder 网关的部署口径，而非 tokenrank 采集能力上限。
