# Token 群排名

一个微信小程序，看自己用 Claude Code、Codex、Cursor 这些 AI 编程工具烧了多少 token，也能在微信群里排个榜。一个微信群对应一张榜，不想上榜可以关掉排名，只自己看。

也支持**飞书**：自带机器人拉进飞书群，群里发「榜单」看排行、「加入」上榜，单聊发「绑定」接入电脑；一个飞书群同样对应一张榜，与微信版共用服务端。部署与用法见 [`docs/feishu.md`](docs/feishu.md)。

整个项目开源，包括电脑端同步器、服务端和小程序：https://github.com/xmasdong/tokenrank

## 服务端两种部署形态

| 形态 | 入口 | 适用场景 |
|---|---|---|
| Cloudflare Worker + D1（原版） | `server/src/worker.js`（`wrangler deploy`） | 海外网络 / 已有可达的 Cloudflare 域名 |
| **Node 单进程**（本仓库新增） | `server/node-service.mjs` | 国内服务器或本机：无公网 IP 也可用——飞书事件走**长连接**（服务主动连出收事件，不需要回调地址），数据存本地 SQLite |

Node 单进程部署（约 5 分钟）：

```sh
cd server
npm install                                  # 含 @larksuiteoapi/node-sdk
node -e "…用 schema.sql 初始化 ~/.tokenrank-server/tokenrank.db…"
# 写 ~/.tokenrank-server/config.json（port / feishu_app_id / feishu_app_secret）
node node-service.mjs
```

飞书侧（开放平台）：创建企业自建应用 → 添加机器人能力 → 开通权限 `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:chat:readonly`（**消息事件必须开细粒度权限，总括 `im:message` 不够，事件不会下发**）→ 事件与回调的订阅方式选「**使用长连接接收事件**」→ 订阅「接收消息 im.message.receive_v1」→ 创建版本发布。详见 [`docs/feishu.md`](docs/feishu.md)。

## 支持采集的终端

采集分两层：统计内核 [token-watcher](https://github.com/luwill/token-watcher)（1.9.x，13 种 AI 编程工具）+ 本仓库在同步器内的补充采集。补充采集包括 Oort 系（[`client/sync/oort.js`](client/sync/oort.js)，详见 [`docs/oort-collection.md`](docs/oort-collection.md)）、WorkBuddy 各版本与 DevEco Code（[`client/sync/extra.js`](client/sync/extra.js)），以及 Trae（[`client/sync/trae.js`](client/sync/trae.js)，详见 [`docs/trae-collection.md`](docs/trae-collection.md)）。0.2.21 起，WorkBuddy / DevEco Code 的数据目录在**全部本地磁盘**上发现，不只看系统盘；只读取目录名和统计库，跳过系统与缓存目录，并排除 token-watcher 已覆盖的位置，避免重复计数。0.2.22 起支持 Trae：由 Trae 本机扩展查询官方用量接口写出按天快照，同步器只读快照，不解密 Trae 的会话库。0.2.23 起 OortCloud AI Studio 内置助手（`oortcodex.oortcodex`）写在 `tasks/*/ui_messages.json` 的逐请求用量也会并入统计。一台电脑可同时安装任意多个，用量按天汇总、按工具分别展示。

**token-watcher 官方支持**

| 终端 | 说明 |
|---|---|
| Claude Code | 含订阅与 API 用量 |
| Codex CLI | OpenAI Codex |
| Cursor | 本机统计库 |
| Gemini CLI | Google |
| Grok CLI | xAI |
| Kimi For Coding | 月之暗面 |
| Qoder Agent | 阿里 |
| opencode | 开源终端 Agent |
| Antigravity | Google |
| DSH（DeepSeek Harness） | 基础版（`~/.dsh`） |
| ZCode | `~/.zcode`，桌面/CLI 一体 |
| WorkBuddy | 官方覆盖 `~/.WorkBuddy/projects`；其他版本与安装位置由同步器补充采集 |
| Lines | |

**Oort 系补充采集（本仓库新增，只读各产品自己的本机状态目录）**

| 终端 | 数据源 | 状态 |
|---|---|---|
| OortCloud AI Studio | 内置助手 `oortcodex.oortcodex` 的任务请求记录（`tasks/*/ui_messages.json`）与 Claude agent 转录；装了 Cline/Roo 的安装也一并计入 | ✅ |
| DSH For OortCloud Work | 会话日志 `sessions/*/session.v*.jsonl.zst[d]` 的逐请求用量（精确到天、带模型）；日志不可读的会话退回 `session_projcache` 的会话累计值 | ✅ |
| OortCodex Desktop | `%USERPROFILE%\OortCodexWork\cli\db\db.sqlite` 的 `model_usage`（ZCode 内核同构，逐请求） | ✅ |
| OortOffice | 自带 ZCode 内核，用过后 `%LOCALAPPDATA%\OortOffice\zcode-home\.zcode\cli\db\db.sqlite` 的 `model_usage`；没打开过对话就没有这个库 | ✅ |
| Genspark Super App | 本地无用量数据（薄壳客户端，用量在 genspark.ai 云端）；结论与可行路径见采集文档 | ❌ |

**WorkBuddy 与 DevEco Code 补充采集（本仓库新增，0.2.21 起全盘只读扫描）**

| 终端 | 数据源 | 状态 |
|---|---|---|
| WorkBuddy（国内版、国际版、便携安装） | 各产品目录下的 `projects/*.jsonl` 转录；只采集 token-watcher 未覆盖的目录，按消息 ID 去重 | ✅ |
| DevEco Code | OpenCode 同构的 `deveco.db`（`session` / `message.data.tokens`） | ✅ |

扫描范围是 Windows 的全部盘符、macOS 的 `/Volumes/*`、Linux 的 `/` 与 `/mnt/*`、`/media/*`；逐盘有界遍历并跳过系统、缓存和依赖目录，再补充检查 `APPDATA`、`LOCALAPPDATA`、`XDG_*` 和用户主目录等已知位置。单文件或单个统计库损坏只跳过该项并在同步日志中告警，不中断同步。

**Trae 补充采集（本仓库新增，0.2.22）**

| 终端 | 数据源 | 状态 |
|---|---|---|
| Trae CN | Trae 本机无明文用量明细（会话库 SQLCipher 加密）。由本机扩展复用登录态查询 Trae 官方用量接口，写出按天快照 `~/.trae-cn/credits-usage.json`，同步器只读该快照——不解密会话库、不读令牌文件、不注入进程 | ✅ 需自行安装扩展；token 与 credits 均有，接口、口径与排障见 [`docs/trae-collection.md`](docs/trae-collection.md) |

同一个接入码可以同时接入多台电脑：服务端按设备分别保存日桶，同一天相加后进入榜单，单台设备重新上报只替换它自己的数据。

<p align="center">
  <img src="miniprogram/assets/mini-program-code.jpg" width="220" alt="Token 群排名小程序码">
  <br>
  <b>微信扫码，看看你一天用了多少 token</b>
</p>

## 小程序内可查看

- 自己的用量、工具／模型分析、用量日报、使用日历和个人周报；日历区分未同步与真实零用量。
- 群排名、同期 PK 和公开工具／模型趋势榜；趋势可按使用人数或 Token 排序。
- 用量、日报、周报、工具偏好等分享图，携带固定小程序码；个人卡片打开作者分享时的摘要。日报详情可直接转发所选日期或分享图片。

周报按北京时间周一至周日统计，默认上一个完整周。趋势比较截至昨日的相邻 7／30 天，并展示两期公开样本数；仅代表已上报数据。详见 [`miniprogram/README.md`](miniprogram/README.md)。

## 隐私

电脑端只读本机统计库，上传按天汇总的数字，并定期报告同步程序是否正常运行。

**会上传的**：每天的 token 数（总量、输入、输出、缓存读取、缓存写入）、调用次数、工具和模型名称、随机设备 ID，以及系统类型、程序版本、同步状态、检查时间、固定错误码和本机最新统计日期。心跳不上传原始错误信息或日志。

**可选邮箱**：在小程序「我的 → 消息提醒 → 完整邮箱日报」主动填写并同意后，登记邮箱及同意时间。邮箱不公开，可修改、撤销，注销账号时删除。目前只登记，不验证、不发信；开放后先验证邮箱，再主动开启接收。详见 [邮箱日报登记](docs/email-registration.md)。

**不会上传的**：代码、对话内容、提示词、项目名、仓库名、文件路径、电脑名、用户名。

接入后在电脑上运行下面这条命令，可以预览用量报文，不上传。心跳字段可在 [`client/sync/health.js`](client/sync/health.js) 核对：

```sh
tokenrank rank push --full --dry-run
```

同步器的全部代码在 [`client/sync`](client/sync)，没有第三方运行依赖，读取统计库时是只读模式。服务端存了什么可以看 [`server/schema.sql`](server/schema.sql)。

不想被排名，可以在小程序「我的」里关掉“参与排名”。关掉后自己的用量照常能看，广场和所有群榜都不显示你，随时可以再打开。只想在某个群里不显示，就在那个群的榜单页关掉“在本群显示我的排名”，其他群和广场不受影响。

彻底停止使用，可以进入「我的 → 注销账号」。确认后删除云端账号、头像昵称、所有日期和设备的用量、分享快照、同步及重建记录、群成员关系、消息提醒预约、登记邮箱及全部登录/接入凭证，并清空小程序本地缓存。多人群榜保留，发起权限转交给最早加入的其他成员（同一时间加入时按用户 ID 排序）；只有本人的群榜删除。旧电脑凭证无法继续回传。电脑原始日志和统计库不会被删除，已经保存或转发的图片无法撤回。

注销完成后不会自动登录；用户主动重新登录才可再次使用。网络中断导致结果不确定时，小程序会暂停自动登录并提供重试；必要时通过微信只查询现有账号确认结果，避免误创建新账号。

重新登录会创建空账号，需要重新填写头像昵称、加入群榜。重新接入原电脑后，会将电脑仍保留的全部历史用量上传到新账号；未重新接入前不会恢复任何用量，旧分享链接始终失效。

## 部署安全要求（本 fork 加固）

- **服务端域名**：`miniprogram/utils/env.js` 默认是 `https://tokenrank.example.com` 占位，未改会直接拒绝请求；部署前必须改成自己的 HTTPS 域名，并在微信后台配置 request / uploadFile 合法域名。
- **更新地址**：`update.sh` / `update.ps1` 不再写死域名，必须显式传入服务地址（`sh -s <服务器>` / PowerShell 参数），并从同一服务器下载安装包；安装包需通过 SHA-256 校验。
- **飞书 HTTP 回调**：必须配置 `FEISHU_VERIFICATION_TOKEN`，或启用加密并配置 `FEISHU_ENCRYPT_KEY`（校验 `X-Lark-Signature`）。两者都没有时事件一律拒绝。Node 长连接模式不经过 HTTP 回调，不受影响。
- **Node 单进程**：默认只监听 `127.0.0.1`，对外请用 nginx / caddy 终止 TLS；非回环明文监听会拒绝启动（确需时设 `TOKENRANK_ALLOW_INSECURE_HTTP=1`）。配置目录和数据库仅当前用户可读。
- **CORS**：默认不发送 `Access-Control-Allow-Origin`。需要浏览器直连时用 `CORS_ORIGIN` 显式列出允许的来源，不要使用 `*`。

## 怎么工作的

```
本机 AI 工具日志 → token-watcher（开源采集器，负责读日志）→ 本机统计库
                                                      ↓ 只读
                                        TokenRank 同步器（client/sync，每 5 分钟）
                                                      ↓ 每日汇总
                                        Cloudflare Worker + D1（server）
                                                      ↓
                                        微信小程序（miniprogram）
```

读日志、识别 13 种 AI 编程工具的工作由 [luwill/token-watcher](https://github.com/luwill/token-watcher)（MIT）完成，这个项目不改它的代码，也不写它的数据库。安装和更新脚本都会查询官方最新稳定版（最低 1.8.3，包含采集卡住后的自恢复）。本机缺失时安装，有新版本时升级并重新计算，不降级较新版本。低于 1.8.2 的版本会重复统计 Codex 和 DSH，升级前暂停上传；1.8.2 的统计数据仍可正常上报。

总用量用 token-watcher 的 `total_tokens`，含缓存，按北京时间自然日统计。这是各人电脑自报的数字，只能当交流参考，不等于厂商账单。

## 目录

| 目录 | 内容 |
|---|---|
| `client/sync` | 电脑端同步器（当前 0.2.23）：接入、只读同步、心跳、超时恢复、更新重算、备份清理；含 Oort 系工具补充采集（`client/sync/oort.js`，见 [`docs/oort-collection.md`](docs/oort-collection.md)）、WorkBuddy / DevEco Code 全盘补充采集（`client/sync/extra.js`）与 Trae 快照采集（`client/sync/trae.js`，扩展源码在 `client/trae-extension`，见 [`docs/trae-collection.md`](docs/trae-collection.md)） |
| `client/bin/tokenrank.js` | 同步器命令行入口 |
| `server` | Cloudflare Worker、D1 表结构与迁移、安装和更新脚本；含飞书机器人（`server/src/feishu.js`）与 Node 单进程部署入口（`server/node-service.mjs` + `server/src/d1-node.mjs`） |
| `miniprogram` | 原生微信小程序 |
| `scripts` | 生成分享封面、用量卡预览等辅助脚本 |

## 本地开发

需要 Node.js 22.13+。

```sh
cd server
npm install
cp wrangler.toml.example wrangler.toml   # 填入自己的 D1 数据库和域名
npm run init-db:local
npm run dev
```

开发时可以设置 `ALLOW_DEV_LOGIN=1` 模拟微信登录；正式环境要去掉它，并用 `wrangler secret put` 配置 `WX_APPSECRET`，`WX_APPID` 写在 `wrangler.toml`。

用开发登录拿到的接入码连本地服务：

```sh
node client/bin/tokenrank.js connect http://127.0.0.1:8799 <接入码>
node client/bin/tokenrank.js rank push --full --dry-run
```

小程序用微信开发者工具导入 `miniprogram/`，本地联调时把 `utils/env.js` 里的 `BASE_URL` 改成本地地址。

## 测试与打包

```sh
(cd client && npm run pack:dist)   # 生成 server/public/dl 下的同步器安装包
node --test client/test-sync/*.test.mjs server/test/*.test.mjs miniprogram/test/*.test.cjs
```

安装脚本的测试会用到打包出来的安装包，所以先打包再跑测试。测试全部使用临时目录、合成数据和模拟的微信接口，不碰真实服务和线上数据。

## 部署

1. 新建数据库用 `server/schema.sql`；已有数据库只执行尚未执行过的迁移，当前最新 `0021_multi_device.sql`。`0009` 是注销并发保护，`0010` 新增心跳表，`0011` 为工具下的模型分布增加可选 JSON 列，`0012` 增加提醒预约和首次接入询问状态，`0013` 将常规提醒调整为昨日用量日报（不改用量），`0014` 仅增加私有邮箱登记表（不启用发信），`0015` 增加私有订阅记录表，`0016` 重建该表以支持六种币种，`0017` 增加按量充值记录表和订阅的 API Key 标记，`0018` / `0019` 增加飞书接入与头像缓存，`0020` 增加积分记录，`0021` 让一个接入码按设备分别保存状态并在同一天相加；必须先执行 `0021` 再部署多设备 Worker。当前正式库此前通过 SQL 文件逐项迁移，不要依赖 Wrangler 的迁移追踪表重跑全部迁移。
2. `cd client && npm run pack:dist`，然后在 `server` 目录 `npx wrangler deploy`，安装包和脚本作为静态资源一起发布。
3. 在 `miniprogram/utils/env.js` 填服务端 HTTPS 域名；微信后台配置 request、uploadFile 合法域名（与之一致）；在「用户隐私保护指引」里声明“收集你的昵称、头像”和“选中的照片或视频信息”（头像选择的兜底）；启用邮箱登记时同时说明邮箱的收集用途、可选性与删除方式。
4. 上传小程序，真机验收后提交审核。

## 查看同步是否正常

同步器 0.2.10 起每 5 分钟发送独立心跳，启动和检查结束也报告状态。用量未变时仍有心跳，不再用最后上传时间推断程序是否运行。小程序接入页分别显示最近联系、最近检查、最近上传时间。

| 状态 | 依据 |
|---|---|
| 在线／无新增用量 | 已收到心跳，最近一次检查完成，无需再次上传相同用量 |
| 检查中 | 同步子进程正在读取或上传 |
| 检查失败 | 收到固定错误码，可区分读取失败、上传失败、版本过旧和超时 |
| 已主动关闭／服务已停止 | 电脑执行停用命令并成功通知服务器 |
| 暂时联系不到电脑 | 超过 15 分钟无心跳；不能进一步断定是关机、休眠、断网还是进程故障 |
| 旧版／状态未知 | 没有心跳记录；历史上传时间仍保留，不能据此判定用户关闭同步 |

在已配置 Wrangler 的项目目录查询正式环境：

```sh
node scripts/sync-status.mjs
node scripts/sync-status.mjs --json   # 含每台设备的版本、状态、检查时间与错误码
```

查询只读，使用操作者自己的 Cloudflare 权限，没有公开管理接口。列表包含曾完成同步或已有心跳的账号，版本和状态按最近联系的电脑展示，并列出参与榜单汇总的设备数；`--json` 可查看每台。账号注销时同时删除心跳记录；重置接入码时清理旧状态。

后台进程由系统托管，异常退出后重启。读取和上传在独立子进程中执行，单次超过 15 分钟终止并在后续周期重试，心跳继续运行。电脑休眠时不会被唤醒。此状态监测的是 TokenRank 同步程序，不保证原版采集器持续采集；没有新增日志与原版停止采集仍需结合电脑状态检查。

旧用户需升级一次电脑端同步器才能上报心跳；服务端升级无法让旧脚本自动具备该能力。可重新复制新版小程序里的接入命令，只升级同步器时不会强制重算已达修复版本的原版统计；已有通用更新命令也会升级同步器，但会同时执行备份重算流程。

已接入的用户升级同步器（下面是示例，请换成你自己的服务地址）（会备份后从本机日志重算，并整体替换本账号的云端数据）：

```sh
curl -fsSL https://<你的域名>/update.sh | sh -s https://<你的域名>
```

Windows PowerShell：

```powershell
& ([scriptblock]::Create((irm 'https://<你的域名>/update.ps1'))) 'https://<你的域名>'
```

## 后台管理

发现明显伪造的数据，可以在 D1 里停用账号。停用后不出现在任何榜单，上传会被拒绝，数据保留，可以恢复：

```sh
npx wrangler d1 execute <数据库名> --remote --command "UPDATE users SET disabled_at = CAST(strftime('%s','now') AS INTEGER)*1000, disabled_reason = '原因' WHERE id = <用户ID>"
```

## 致谢

采集能力来自 [luwill/token-watcher](https://github.com/luwill/token-watcher)（MIT）。`client/` 最初从它 fork 而来，保留了原 LICENSE。

## 协议

[MIT](LICENSE)

## 金额账单分享

同步器 0.2.12 起复用本机 token-watcher 的 `aggregateCosts`、价格解析和汇率缓存，将每天、每个模型的 API 等值估算以 USD 微元整数上报。计算在离线隔离进程中进行，原版统计库只读，价格文件复制到临时目录后使用，不上传价格文件、汇率缓存、代码或原始会话。云端不能根据旧的前 8 模型 Token 摘要准确补算费用，老用户需要升级一次电脑同步器，历史金额随后自动回填。

“用量账单”海报显示前五个模型金额、其他模型合计、缓存用量、活跃天数及固定小程序码；转发小程序卡片打开同一份作者账单。金额是按本机当前价格与缓存汇率计算的 API 等值估算，非实际扣费。缺少价格或金额未同步会明确标注；原来的 Token 卡片及历史分享不追加公开金额。

生产升级需先执行 `server/migrations/0011_usage_costs.sql`，再部署 Worker 和 0.2.12 分发包，最后上传新版小程序。

### 小程序消息提醒

「我的 → 消息提醒」、日报、个人周报和电脑同步页提供入口。常规提醒是北京时间每天 09:00 的前一日用量日报：通知展示日期、含缓存 Token 总量与调用次数，点开查看当天工具／模型及缓存明细。首次收到电脑用量上报后可主动询问一次；用户进入设置页并点击按钮后，才调起微信原生订阅授权。每项预约只发送一次，不是永久订阅。

微信已有公共模板可通过 API 查询类目、关键词并选用，无需一律手动申请新模板。服务端需配置本小程序专属模板 ID 和真实关键词，再开启 `WX_REMINDERS_ENABLED=1`；未配置时显示“暂未开放”。按 [消息提醒配置与验收](docs/reminders.md) 完成配置和手机验证。已有用量与群榜数据不受影响，不需要更新电脑同步程序。

完整邮箱日报现阶段仅开放自愿登记，可在「消息提醒」或日报详情进入，不接入发信服务、不自动创建投递任务。邮箱验证和持续投递在后续版本接入；不会把未验证的登记直接转成推送。见 [邮箱日报登记](docs/email-registration.md)。
