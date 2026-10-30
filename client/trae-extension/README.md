# Trae Credits POC（扩展源码）

Trae CN 桌面版本身不含任何可本地读取的用量明细（会话库 `ModularData/ai-agent/database.db` 是
SQLCipher 加密的），因此补充采集**不改 Trae、不解密、不注入进程**，而是在 Trae 的扩展宿主里
调用它自己的会话令牌，查询官方用量接口，把**按天聚合**的结果写成本机快照，供同步器只读消费。

整条链路的口径、验证结论与排障见 [`../../docs/trae-collection.md`](../../docs/trae-collection.md)。

## 文件

| 文件 | 说明 |
|---|---|
| `extension.js` | 扩展源码（v0.0.7） |
| `package.json` | 扩展清单（`publisher: local-poc`，`activationEvents: onStartupFinished`） |
| `build.ps1` | 离线打包 VSIX，不依赖 npm / vsce，PowerShell 5.1 可用 |

## 工作方式

1. `vscode.commands.executeCommand('icube.common.getToken')` 取 Trae 自己的会话令牌（不落盘、不打印）。
2. `POST https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session`，
   头 `Authorization: Cloud-IDE-JWT <token>`，体 `{ start_time, end_time, page_size: 50, page_num, usage_type: [7] }`
   （时间为 **epoch 秒**，窗口 30 天，最多 3 页、页间隔 ≥2 秒）。
3. 逐行取 `credits_float` 与 `extra_info` 的 `input_token / output_token / cache_read_token / cache_write_token`，
   按 `usage_time`（UTC+8）归日后聚合。
4. 写快照 `~/.trae-cn/credits-usage.json`（schema 1）；同步器的 `client/sync/trae.js` 只读该文件。
5. 每次查询同时写详细报告 `%TEMP%\trae-credits-poc-report.json`（仅本机诊断用，上报链路不读它）。

刷新时机：命令面板「Trae Credits POC: 查询每会话 Credits」、`%TEMP%\trae-credits-poc.trigger`
文件出现、`%TEMP%\trae-credits-poc.autorun` 存在时启动后自动跑一次，以及运行期间每 6 小时一次。

## 快照字段（schema 1）

```json
{
  "schema": 1,
  "generated_at": "2026-10-30T04:00:00.000Z",
  "window_days": 30,
  "days": [{
    "day": "2026-10-30",
    "input_tokens": 0, "output_tokens": 0, "cache_read": 0, "cache_write": 0, "tokens": 0,
    "requests": 0,
    "credits": 0,
    "billed_sessions": 0, "custom_sessions": 0,
    "custom_input_tokens": 0, "custom_output_tokens": 0,
    "models": [["DeepSeek-V4.1-Flash", 6100]]
  }]
}
```

`requests` 是当日活跃会话行数，不是请求数；`models` 为 `[模型名, tokens]` 取前 8（Auto 模式行无
模型名，不贡献）；自定义模型（BYOK）不计 credits，其 token 已含在 `tokens` 四分量中，另用
`custom_*` 单列以便判定。

## 打包与安装

```powershell
# 打包（产物 trae-credits-poc-<version>.vsix，不入库）
powershell -NoProfile -ExecutionPolicy Bypass -File client/trae-extension/build.ps1

# 安装到 Trae CN（示例路径按本机为准）
& 'D:\Program Files (x86)\Trae CN\bin\trae-cn.cmd' --install-extension 'trae-credits-poc-0.0.7.vsix' --force
```

装完重启 Trae 窗口即生效；快照写入后，下一次同步（默认每 15 分钟）自动带上 Trae 的日用量。

## 边界（硬约束）

只读查询；不打印令牌；`session_id` 只保留 SHA-256 前 8 位；不采集、不输出 `user_input_preview`
与任何对话内容；不解析、不解密 Trae 的加密库，不做 key 提取、进程注入或钩挂；不绕过鉴权；
单接口 ≤3 页、请求间隔 ≥2 秒。快照仅含按天聚合数字。上传动作由 tokenrank 同步器独立完成，
本扩展不联网上报任何数据。
