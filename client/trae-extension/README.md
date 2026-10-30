# Trae Credits 采集扩展（源码）

Trae CN 桌面版本身不含任何可本地读取的用量明细（会话库 `ModularData/ai-agent/database.db` 是
SQLCipher 加密的），因此补充采集**不改 Trae、不解密、不注入进程**，而是在 Trae 的扩展宿主里
调用它自己的会话令牌，查询官方用量接口，把**按天聚合**的结果写成本机快照，供同步器只读消费。

整条链路的口径、验证结论与排障见 [`../../docs/trae-collection.md`](../../docs/trae-collection.md)。

## 文件

| 文件 | 说明 |
|---|---|
| `extension.js` | 扩展入口（v0.1.1）：取令牌、查询、写快照与诊断报告 |
| `model-resolve.cjs` | 纯函数：模型归因（Auto / 内置 / 自定义前缀）与按天聚合（schema 2），可脱离 Trae 单测 |
| `package.json` | 扩展清单（`publisher: local-poc`，`activationEvents: onStartupFinished`） |
| `build.ps1` | 离线打包 VSIX，不依赖 npm / vsce，PowerShell 5.1 可用 |

## 工作方式

1. `vscode.commands.executeCommand('icube.common.getToken')` 取 Trae 自己的会话令牌（不落盘、不打印）。
2. `POST https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session`，
   头 `Authorization: Cloud-IDE-JWT <token>`，体 `{ start_time, end_time, page_size: 50, page_num, usage_type: [7] }`
   （时间为 **epoch 秒**，窗口 30 天，最多 3 页、页间隔 ≥2 秒）。
3. 逐行取 `credits_float` 与 `extra_info` 的 `input_token / output_token / cache_read_token / cache_write_token`，
   按 `usage_time`（UTC+8）归日；模型名按归因规则聚合。
4. 写快照 `~/.trae-cn/credits-usage.json`（schema 2）；同步器的 `client/sync/trae.js` 只读该文件。
5. 诊断报告 `%TEMP%\trae-credits-poc-report.json`（本机排障用，上报链路不读它）。

刷新时机：命令面板「Trae Credits: 查询每会话 Credits」、`%TEMP%\trae-credits-poc.trigger`
文件出现、`%TEMP%\trae-credits-poc.autorun` 存在时启动后自动跑一次，以及运行期间**每 30 分钟**自动刷新
（活跃会话的累计值最多半小时后即进入下一次上报）。

## 快照字段（schema 2，v0.1.0 起；v0.1.1 起每 30 分钟刷新）

```json
{
  "schema": 2,
  "generated_at": "2026-10-30T06:00:00.000Z",
  "window_days": 30,
  "days": [{
    "day": "2026-10-30",
    "input_tokens": 0, "output_tokens": 0, "cache_read": 0, "cache_write": 0, "tokens": 0,
    "requests": 0,
    "credits": 0,
    "billed_sessions": 0, "custom_sessions": 0,
    "custom_input_tokens": 0, "custom_output_tokens": 0,
    "models": [["GLM-5.3", 6000]],
    "models_full": [["GLM-5.3", 6000], ["auto", 4000], ["[bigmodel-plan] GLM-5.3", 1200]],
    "credits_tools": [["Trae", 123.456789]],
    "credits_models": [["GLM-5.3", 80.1]],
    "credits_models_full": [["GLM-5.3", 80.1], ["auto", 43.356789]],
    "credits_tool_models": [["Trae", "GLM-5.3", 80.1], ["Trae", "auto", 43.356789]],
    "modes": [["Max", 69], ["Auto", 16]],
    "truncated": { "models": false, "credits_models": false, "credits_tool_models": false }
  }]
}
```

模型归因规则（`model-resolve.cjs`，配套 `client/test-sync/extension-model.test.mjs`）：

- 接口行有 `model_name` → 以模型名为准；名字形如 `provider//模型` 判为自定义（BYOK），上报名
  `[provider] 模型名`；其余按内置（预置）模型上报原值，保留大小写；
- 无 `model_name` 且 `mode` 判定为 Auto（归一匹配 `^auto(\s*mode)?$`，或显式 `use_max_mode === false`
  兜底）→ 固定上报 `auto`，不再落入“未关联模型”；
- 其余无模型名的行不产出模型分项，只进总额，服务端按残差处理；
- 同名跨类（预置与自定义显示名相同）按计费事实裁决：产生 credits 视为预置。

`requests` 是当日活跃会话行数，不是请求数；上报分项按协议上限截断（模型 8 / 组合 128），全量
明细写 `*_full` 并置 `truncated` 标记；`modes` 为当日各模式的会话行数（审计用）。自定义模型
（BYOK）不计 credits，其 token 已含在 `tokens` 四分量中，另用 `custom_*` 单列以便判定。

## 打包与分发

- 跨平台打包：`node client/scripts/pack-vsix.mjs`（纯 Node zip 写入，无 npm 依赖；产物逐字节可复现），
  输出 `server/public/dl/trae-extension/<版本>/trae-credits-poc-<版本>.vsix` + `.sha256`，并在上级写 `latest.json` 指针。
  `build.ps1` 是它在 Windows 的薄封装；镜像构建（Dockerfile dist 阶段）同样执行该脚本，服务端始终分发源码对应版本的安装包。
- 一键安装（推荐）：服务端提供 `install-trae.ps1` / `install-trae.sh`（下载 → sha256 校验 → Trae CLI 安装，
  无 CLI 时降级解压到 `~/.trae-cn/extensions/`；已装同版本幂等跳过）。飞书单聊发「绑定」即可拿到对应命令：

```powershell
& ([scriptblock]::Create((irm '<BASE>/install-trae.ps1'))) '<BASE>'
```

```sh
curl -fsSL <BASE>/install-trae.sh | sh -s <BASE>
```

- 手动安装：`node client/scripts/pack-vsix.mjs` 后
  `& '<Trae CN>\bin\trae-cn.cmd' --install-extension '<产物>.vsix' --force`。

装完重启 Trae 窗口即生效；快照写入后，TokenRank 同步器每 15 分钟的上报自动带上 Trae 的日用量。
同步器 0.2.24 起兼容快照 schema 1 与 2；旧同步器读到 schema 2 会跳过并告警，不产生脏数据。

## 边界（硬约束）

只读查询；不打印令牌；`session_id` 只保留 SHA-256 前 8 位；不采集、不输出 `user_input_preview`
与任何对话内容；不解析、不解密 Trae 的加密库，不做 key 提取、进程注入或钩挂；不绕过鉴权；
单接口 ≤3 页、请求间隔 ≥2 秒。快照仅含按天聚合数字。上传动作由 tokenrank 同步器独立完成，
本扩展不联网上报任何数据。
