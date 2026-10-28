# 在飞书里使用 Token 群排名

飞书版通过**机器人**使用：把项目自带的机器人拉进飞书群，群成员在群里发命令看榜、上榜，在单聊里完成电脑接入。一个飞书群对应一张榜，与微信版共用同一个服务端和数据库。

```
本机 AI 工具日志 → token-watcher → TokenRank 同步器（client/sync，每 5 分钟）
                                        ↓ 每日汇总
                          Cloudflare Worker + D1（server，不变）
                                        ↓
                    飞书机器人（server/src/feishu.js，/feishu/event 回调）
```

电脑端同步器与上报接口完全不变；已有的微信小程序流程不受影响，两端数据互通（同一个人在微信和飞书是两个独立账号）。

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
   - 记下 **Verification Token**；如开启「加密策略」，记下 **Encrypt Key**
5. **版本管理与发布**：创建版本并发布，由企业管理员审核通过。
6. 群里使用：群设置 → 群机器人 → 添加本应用；单聊使用：在飞书搜索机器人名称直接发消息。

## 二、服务端配置

在微信版部署（见根 README）的基础上追加：

1. `cp wrangler.toml.example wrangler.toml` 后，取消注释并填入：

   ```toml
   FEISHU_APP_ID = "cli_xxxxxxxxxxxxxxxx"
   FEISHU_VERIFICATION_TOKEN = "事件配置页的 Verification Token"
   # 平台开启加密策略时才需要：
   FEISHU_ENCRYPT_KEY = "xxxxxxxxxxxxxxxx"
   ```

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

## 常见问题

- **机器人不回消息**：确认应用已发布、事件订阅地址校验通过、`im.message.receive_v1` 已订阅、`FEISHU_APP_ID/APP_SECRET` 已配置；看 `wrangler tail` 里的 `feishu event:` 错误日志。
- **群名显示「本群 Token 排名」**：建榜时 `im:chat:readonly` 权限未开通或接口失败，用了默认名；拥有者可在微信小程序端改名，或退出榜单重建（发 `退出` 后重新 `加入`）。
- **换了一台电脑接入**：单聊再发一次 `绑定`，用新的安装命令即可；接入码不变时旧电脑凭证继续有效，重置码请在服务端调用现有 `/api/connect/token`（小程序流程）。
- **重建飞书应用**：open_id 会变化，原账号无法自动关联；重新 `绑定` 会创建新账号，旧账号需在微信小程序端注销或由管理员停用。
