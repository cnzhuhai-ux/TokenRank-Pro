# Oort 系工具用量采集

TokenRank 的采集内核 token-watcher 官方支持 13 种 AI 编程工具，不认识 Oort 系产品。本仓库在
**同步器内**（`client/sync/oort.js`）增加了 Oort 系补充采集：只读各产品自己的本机状态目录，
不修改 token-watcher 及其数据库，失败逐文件容错、不阻断同步。

## 采集范围

| 产品 | 展示名 | 数据源 | 状态 |
|---|---|---|---|
| OortCodex（桌面 / CLI / Agents） | `OortCodex` | token-watcher 已按 `zcode` 采集（CLI 与 Agents 会话同在 `~/.zcode`），合并时统一改展示名 | ✅ 已生效（三者合并计数，无法细分） |
| DSH For OortCloud Work | `DSH For OortCloud Work` | `~/.dsh-oortcloud-work/storages/session_projcache/sessions/*.json` 的 `tokenUsage.totals`（会话累计：uncachedInput / output / cacheRead / cacheWrite） | ✅ 已生效 |
| OortCloud AI Studio | `OortCloud AI Studio` | `%APPDATA%\OortCloud AI Studio\User\globalStorage\{saoudrizwan.claude-dev, rooveterinaryinc.roo-cline}\tasks\...\ui_messages.json` 中 `api_req_started` 消息尾带的 `{tokensIn, tokensOut, cacheReads, cacheWrites}`（逐请求、带毫秒时间戳） | ✅ 已生效（覆盖 Cline/Roo 插件用量；原生 oortcodex 扩展只有上下文快照、无计费 token） |
| OortOffice | — | 本地聊天存于浏览器 Local Storage（LevelDB），无 token 明细 | ❌ 暂无法本地采集，见下 |

刻意不读基础版 `~/.dsh`：token-watcher 官方支持该目录，读了会重复计数；只读 `-oortcloud-work` 变体。

## 口径说明

- **总量含缓存**，与项目主口径一致：`tokens = input + output + cache_read + cache_write`。
- **DSH 按会话最后活跃日归因**（projcache 文件 mtime，北京时间）。会话累计值随使用单调变大，
  配合服务端按天整行替换语义收敛；跨零点的长会话总量会记到后一天，前一天的已上报值保持不变，
  两日合计可能略高于真实总量——只影响跨天长会话，榜单用途可接受。
- 重命名 `zcode → OortCodex` 会改变日指纹，相关历史日会在下一次同步时整行重传一次（一次性）。
- 金额估算（cost）仍只基于 token-watcher 的模型计价；Oort 增量暂不计价。
- 工具明细每天最多 8 条（协议上限），超出按量截断。

## OortOffice 的可行路径（待办）

平台侧 new-api（`workup.oortcloudsmart.com:2443/bus/apaas-newapi`）有完整计量：
`GET /api/dashboard/self/overview?days=N` 按天返回 tokens/calls/credits，且各产品各持一把
new-api 令牌（OortCodex=43、OortOffice=90 等），按令牌即可区分产品。该接口需要有效的平台
`accesstoken` 请求头——本机各应用落盘的令牌均已过期、主力应用的令牌为加密存储，无法长期稳定
读取。可行方案（任选其一即可补上 OortOffice 与 AI Studio 原生 agent 的精确计量）：

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

排障：同步日志中 `oort dsh 会话 … 解析失败，已跳过` / `oort ai-studio 任务 …` 为单文件容错
提示，不影响其余数据。设置环境变量 `TOKENRANK_OORT_DISABLE=1` 可临时关闭补充采集（测试亦用
此开关做隔离）。
