# 在飞书里使用 Token 群排名

飞书版提供**机器人与网页应用**：把项目自带的机器人拉进飞书群，群成员在群里发命令看榜、上榜，在单聊里完成电脑接入；网页应用用于查看完整群榜、个人数据与分析。一个飞书群对应一张榜，微信版与 Node 版共用同一套业务代码。

## 两种服务端形态（先选一种）

| 形态 | 事件接收方式 | 前置条件 |
|---|---|---|
| **Node 单进程（推荐，国内可用）** | **飞书长连接**：服务用 `@larksuiteoapi/node-sdk` 的 WSClient 主动连出收事件 | 一台能访问 open.feishu.cn 的机器即可，**无需公网 IP、无需域名、无需备案** |
| Cloudflare Worker（原版） | 回调 URL：飞书向 `https://<域名>/feishu/event` 推事件 | 国内需自定义域名（`*.workers.dev` 被墙，飞书回调会超时） |

```
本机 AI 工具日志 → token-watcher → TokenRank 同步器（client/sync，每 5 分钟）
                                        ↓ 每日汇总
                 Node 单进程（server/node-service.mjs + SQLite）或 Cloudflare Worker + D1
                                        ↓
                    飞书机器人（长连接收事件 / 出站 API 回消息卡片）
```

### Node 单进程部署

```sh
cd server && npm install
# 初始化数据库（默认 ~/.tokenrank-server/tokenrank.db）
node -e "const{DatabaseSync}=require('node:sqlite');const{readFileSync}=require('fs');new DatabaseSync(process.env.USERPROFILE+'/.tokenrank-server/tokenrank.db').exec(readFileSync('schema.sql','utf8'))"
# 写配置 ~/.tokenrank-server/config.json：
# {"port":8790,"feishu_app_id":"cli_xxx","feishu_app_secret":"xxx"}
node node-service.mjs          # HTTP + 每 5 分钟定时任务 + 飞书长连接一次全起
```

电脑端接入：`node client/bin/tokenrank.js connect http://127.0.0.1:8790 <接入码>`（同机用 127.0.0.1 可走 http；跨机需自备 HTTPS）。Node 服务默认只监听 `127.0.0.1`，对外请用 HTTPS 反向代理。

## 使用方式

| 场景 | 命令 | 说明 |
|---|---|---|
| 单聊机器人 | `绑定` | 首次使用。创建账号并发送接入码和安装命令（接入码只发单聊） |
| 单聊机器人 | `我的` | 查看今日/本周/累计用量、主力工具与模型、广场排名 |
| 单聊机器人 | `榜单 [今日\|本周\|本月\|总榜]` | 查看广场（全站）排行 |
| 单聊机器人 | `帮助` | 命令列表 |
| 群内 @机器人 或直接发 | `加入` | 创建本群榜单（首个发出的人）并上榜 |
| 群内 | `榜单 [今日\|本周\|本月\|总榜]` | 本群排行，附自己的名次 |
| 群内 | `隐藏` / `显示` | 在本群隐藏/恢复自己的排名（不影响其他群和广场） |
| 群内 | `退出` | 退出本群榜单（用量数据保留） |

典型流程：群成员先**单聊机器人**发 `绑定`，按卡片在电脑上运行一条命令接入；回到群里发 `加入` 上榜；之后任何人发 `榜单` 都能看群排行。

## 一、创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn) → **开发者后台** → **创建企业自建应用**（名称如「Token 群排名」）。
2. **添加应用能力 → 机器人**。
3. **权限管理**，开通以下权限：
   - `im:message`（获取与发送单聊、群组消息）— 接收消息事件、发送卡片
   - `im:chat:readonly`（获取群组信息）— 建榜时读取群名称
   - `contact:user.base:readonly`（获取用户基本信息）— 建号时读取昵称和头像
4. **事件与回调 → 事件配置**：
   - 请求地址填 `https://<你的 Worker 域名>/feishu/event`（服务端部署完成后回来填，平台会发 url_verification 校验）
   - 订阅事件：**接收消息 im.message.receive_v1**
   - 记下 **Verification Token**（HTTP 回调必填）；如开启「加密策略」，记下 **Encrypt Key**（启用后改用签名校验，见下）
5. **版本管理与发布**：创建版本并发布，由企业管理员审核通过。
6. 群里使用：群设置 → 群机器人 → 添加本应用；单聊使用：在飞书搜索机器人名称直接发消息。

## 二、服务端配置

在微信版部署（见根 README）的基础上追加：

1. `cp wrangler.toml.example wrangler.toml` 后，取消注释并填入：

   ```toml
   FEISHU_APP_ID = "cli_xxxxxxxxxxxxxxxx"
   FEISHU_VERIFICATION_TOKEN = "事件配置页的 Verification Token"
   # 平台开启加密策略时才需要；启用后回调会校验 X-Lark-Signature：
   FEISHU_ENCRYPT_KEY = "xxxxxxxxxxxxxxxx"
   ```

   **HTTP 回调必须至少配置 `FEISHU_VERIFICATION_TOKEN` 或 `FEISHU_ENCRYPT_KEY` 之一**；
   两者都没有时 `/feishu/event` 会拒绝所有事件（fail closed）。使用 Node 单进程 + 长连接
   接收事件时，不经过 HTTP 回调，可以只配置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。

2. 密钥走 secret（不入库）：

   ```sh
   npx wrangler secret put FEISHU_APP_SECRET
   ```

3. 老库执行迁移（新库直接跑 `schema.sql` 即可）：

   ```sh
   npx wrangler d1 execute tokenrank --remote --file=migrations/0018_feishu.sql
   ```

4. `npx wrangler deploy` 后，回到飞书开放平台保存事件订阅地址（收到 challenge 校验即通）。

未配置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 时，`/feishu/event` 对所有事件静默返回，不影响原有微信功能。

## 三、身份与安全模型

- **账号**：`users.openid = 'feishu:<open_id>'`，昵称和头像取自飞书资料（API 不可用时用兜底昵称），无需注册表单。
- **一群一榜**：`rank_groups.group_openid_hash = sha256('feishu:chat:<chat_id>')`，与微信版共用同一列，同一语义。群名从飞书群信息接口读取。
- **接入码只走单聊**：在群里发 `绑定` 只会收到单聊引导，任何接入码不会出现在群消息里。
- **个人用量只走单聊**：群里发 `我的` 同样只回引导，避免用量数字被群成员看到。
- **事件幂等**：飞书回调失败会重试，`event_id` 落库去重（`feishu_event_log`，7 天自动清理），同一条消息只处理一次；超过 10 分钟的旧事件直接丢弃，防重放。
- **回调验签**：未启用加密时校验 Verification Token；启用加密时校验 `X-Lark-Signature`
  （`sha256(timestamp + nonce + encrypt_key + rawBody)`）并限制时间窗，二者都没有则拒绝所有事件。
  长连接模式由飞书 SDK 建连，不经过该回调。
- **上传内容不变**：仍只有按天汇总的 token 数、调用次数、工具/模型名和随机设备 ID，不含代码、对话、路径。

## 四、本地联调

```sh
cd server
npm install
cp wrangler.toml.example wrangler.toml   # 填 D1 与 FEISHU_* 配置
npm run init-db:local
npm run dev
```

用 `curl` 模拟飞书事件（未配置密钥时可先不加密）：

```sh
curl -X POST http://127.0.0.1:8788/feishu/event -H 'content-type: application/json' \
  -d '{"type":"url_verification","challenge":"hi","token":"..."}'
```

模块级测试：`node --test server/test/feishu.test.mjs`（命令解析、卡片渲染、加密事件、幂等、群绑定、凭证不落群等 24 项）。

## 飞书网页应用

Node 服务在 `/app/` 提供飞书网页应用；工作台入口可使用同域 `/app/`，飞书开放平台需配置对应的 OAuth 回跳地址。使用现有 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 与公开访问地址，不要将密钥写入网页。网页与机器人使用同一飞书账号，但不会自动与微信账号合并。

网页参考小程序的白底列表与页面层级：群榜首页集中展示群列表和同步状态，个人用量集中在「我的」；群详情支持 Token/Credits 榜单分页和群分析，个人页面提供日报、日历、周走势及只读成就图鉴。今日、近 7 天、近 30 天、上个月和累计按接口支持范围显示；上个月为北京时间完整自然月，费用缺失不显示为零。

- 入群仍须在真实飞书群里向机器人发送「加入」，不能通过修改网页 URL 加入任意群。
- 成就查看不会调用首次展示领取或确认接口，不消费小程序的首次解锁展示记录。
- 网页不提供尚未接入的图片导出或原生转发按钮；需要发送用量时在机器人单聊中发送「我的」，群榜在群内发送「榜单」。
- 本次网页对齐不涉及修改机器人消息卡片、生产迁移或自动发布。部署前旧库应包含 `0023_full_model_details.sql`、`0024_achievements.sql` 和 `0025_achievement_presentation.sql` 等所需迁移；新库直接使用完整 `schema.sql`。未升级时不要仅发布前端并声称新接口可用。
- 奖章 PNG 正式资源随网页一起分发。小程序素材更新后运行 `node scripts/sync-feishu-badges.mjs`，测试会校验两端文件逐字节一致。
- Node 静态服务支持网页及其受限奖章路径。Worker 模式还需配置同源静态托管，不能假定只部署 Worker 就会分发 `/app/`。

代码同步、服务部署、飞书客户端验收与正式发布分别汇报。本地合成数据测试不能替代飞书真实授权和客户端兼容验收。

## 常见问题

- **机器人不回消息**：确认应用已发布、事件订阅地址校验通过、`im.message.receive_v1` 已订阅、`FEISHU_APP_ID/APP_SECRET` 已配置；看 `wrangler tail` 里的 `feishu event:` 错误日志。
- **群名显示「本群 Token 排名」**：建榜时 `im:chat:readonly` 权限未开通或接口失败，用了默认名；拥有者可在微信小程序端改名，或退出榜单重建（发 `退出` 后重新 `加入`）。
- **换了一台电脑接入**：单聊再发一次 `绑定`，用新的安装命令即可；接入码不变时旧电脑凭证继续有效，重置码请在服务端调用现有 `/api/connect/token`（小程序流程）。
- **重建飞书应用**：open_id 会变化，原账号无法自动关联；重新 `绑定` 会创建新账号，旧账号需在微信小程序端注销或由管理员停用。
