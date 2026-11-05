# 单租户部署 + 企业 SSO + H5 迁移提示词

> 用途：可直接交给 AI 编程助手执行的迁移方案提示词。执行前请把第 11 节的未决项逐条落实为配置值。
> 事实基线基于 2026-11-05 的 `main`（`259910c`）只读调研，所有路径与行号均可在当前仓库核对。

---

## 0. 你的角色与任务

你是一名熟悉 Cloudflare Workers、Node.js（`node:sqlite`）与无框架前端（原生 JS）的后端工程师。请在 `d:\data\build_GO\tokenrank` 仓库内，把当前依赖飞书（Lark）机器人 + 微信群的多租户产品，改造成：

1. **单租户部署**：一套部署只服务一个组织；
2. **企业自有 SSO 登录**：以标准 OIDC/OAuth2 为主（issuer / client_id / client_secret / redirect_uri / scope / claim 映射全部配置注入），兼容私有协议网关；
3. **H5 前端**：浏览器端完成登录、绑定引导、命令生成与复制、绑定状态轮询、个人设备与用量概览；
4. **明确的用户 ↔ 安装命令绑定机制**：解决"服务器如何知道这条安装命令属于哪个员工"。

按要求分阶段提交 PR，每阶段可独立回滚。

---

## 1. 事实基线（先读这里，不要重新发明）

### 1.1 技术栈与部署形态

| 项 | 现状 |
|---|---|
| 后端 | 单一 Worker 入口 [worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js)，Cloudflare Workers + D1，同时支持 Node 单进程 [node-service.mjs](file:///d:/data/build_GO/tokenrank/server/node-service.mjs)（SQLite，`openD1` 适配在 [d1-node.mjs](file:///d:/data/build_GO/tokenrank/server/src/d1-node.mjs)） |
| 路由 | 手写 `if (method && path)` 匹配，集中在 [worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L109-L352)；**无路由框架、无中间件链** |
| 静态资源 | Node 版由 `STATIC_ALLOW` 白名单直出（[node-service.mjs](file:///d:/data/build_GO/tokenrank/server/node-service.mjs#L96-L123)），Worker 版走 D1/`public` 目录下发 |
| 数据 | `schema.sql` 全量 + `migrations/0001..0022` 增量，无 ORM，全部裸 SQL |
| 部署 | `deploy/k8s`（Node 单进程 + PVC SQLite + Ingress TLS），镜像内同时分发 `install*.sh/.ps1` 与客户端包 |
| 测试 | `node --test server/test/*.test.mjs`（17 个模块级用例文件，纯函数与假 D1） |

### 1.2 现有身份与会话

- 用户唯一锚点是 `users.openid`（`TEXT NOT NULL UNIQUE`，[schema.sql](file:///d:/data/build_GO/tokenrank/server/schema.sql#L5-L17)）。飞书账号写 `feishu:<open_id>`（[feishu-web.js](file:///d:/data/build_GO/tokenrank/server/src/feishu-web.js#L1-L9)），小程序写微信 openid。**表里没有 email、工号、部门、tenant_id 任何字段。**
- 登录态是 `mp_sessions`（`token` 主键 + `user_id` + `expires_at`，30 天，[schema.sql](file:///d:/data/build_GO/tokenrank/server/schema.sql#L27-L32)，TTL 常量 `MP_SESSION_TTL_MS` 在 [worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L41)）。
- 会话校验只有一个函数 `sessionUser()`：读 `Authorization: Bearer`，查 `mp_sessions`（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L407-L414)）。**没有 Cookie 读取分支、没有中间件、没有角色/权限模型。** 每个路由自行调用 `sessionUser` 并判 401（约 20 处）。
- 飞书网页登录链路：前端 `GET /api/feishu/session` 拿授权地址 → 跳转 `open.feishu.cn` → 带 `code` 回跳 `/app/` → `POST /api/feishu/session {code}` 换 `user_access_token` → 拉 `open_id/name/avatar` → `bindAccount` 建号 → 插 `mp_sessions` → 返回 `{token, user}`（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L121-L146)，[feishu-web.js](file:///d:/data/build_GO/tokenrank/server/src/feishu-web.js#L13-L71)）。
- 飞书机器人链路：事件（HTTP 回调 `/feishu/event` 或 Node 长连接）→ `dispatch()` → 命令词（`绑定`/`加入`/`榜单`/`我的`）→ `bindAccount(openId)` 建号 + 发接入码卡片（[feishu.js](file:///d:/data/build_GO/tokenrank/server/src/feishu.js#L479-L495)、[feishu.js](file:///d:/data/build_GO/tokenrank/server/src/feishu.js#L729-L897)）。

### 1.3 现有"用户 ↔ 安装命令"绑定（这就是要解决的问题）

**没有任何绑定码/激活码/一次性码。** 现状是：

1. 服务端登录后调用 `ensureConnectToken(env, userId)`，为**每个用户生成一个长期有效的 32 位 hex 接入码**，写入 `connect_tokens`（每用户一码，无过期时间，[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L481-L488)、[schema.sql](file:///d:/data/build_GO/tokenrank/server/schema.sql#L35-L42)）。
2. 安装命令把该接入码**明文拼进命令行**：
   ```
   curl -fsSL {base}/install.sh | sh -s {base} {token}
   & ([scriptblock]::Create((irm '{base}/install.ps1'))) '{base}' '{token}'
   ```
   生成逻辑 `installCommands()` 在 [worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L59-L66)，飞书卡片版本 `connectCard()` 在 [feishu.js](file:///d:/data/build_GO/tokenrank/server/src/feishu.js#L298-L337)。
3. 安装脚本以**位置参数**接收 `Server` 与 `Token`，只做格式校验（`^[0-9a-f]{32}$`），随后 `tokenrank connect <server> <token>` 写入 `~/.tokenrank/config.json`（`mode 0600`）：[install.sh](file:///d:/data/build_GO/tokenrank/server/public/install.sh#L4-L9)、[install.ps1](file:///d:/data/build_GO/tokenrank/server/public/install.ps1#L1-L10)、[config.js](file:///d:/data/build_GO/tokenrank/client/sync/config.js#L14-L35)。
4. 上报接口用该接入码当 Bearer：`POST /report` 直接 `SELECT * FROM connect_tokens WHERE token=?1`，由此得到 `user_id`（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L524-L547)）。同一用户的多台电脑共用同一个接入码，按 `device_id` 区分（`usage_device_state`）。
5. 重置：`POST /api/connect/token` 删除旧码并插入新码（旧码立即失效，[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L507-L521)）。

**结论（必须在方案里正面回答）**：当前"绑定"= 登录后拿到长期明文接入码 + 手工粘贴命令。风险是接入码进入 shell history / 进程列表 / 聊天记录，且永不过期、无法按设备吊销。

### 1.4 Trae 扩展的凭证来源

Trae 采集扩展**不使用 TokenRank 任何凭证**：它在 Trae 扩展宿主里调 `icube.common.getToken` 拿 Trae 自己的 JWT，查询 `api.trae.cn` 官方用量接口，只写本地快照 `~/.trae-cn/credits-usage.json`，不联网上报（[README.md](file:///d:/data/build_GO/tokenrank/client/trae-extension/README.md#L18-L32)）。上传由同步器 `client/sync/report.js` 独立完成。**因此 SSO 改造不需要动 Trae 扩展**，只需同步器凭证机制（`install-trae.*` 命令本身不带 token，也不应该带）。

### 1.5 前端现状

- 已有 H5，但是**飞书网页应用专用**：`server/public/app/index.html` + `app.css` + `app.js`（原生 JS，无构建、无框架），四个 tab（群榜/广场/我的/说明）。
- 登录没有独立页面，是登录遮罩：`login()` 读 `?code`，`POST /api/feishu/session`，会话 token 存 `localStorage('tr_token')`，`api()` 统一加 `Authorization: Bearer`（[app.js](file:///d:/data/build_GO/tokenrank/server/public/app/app.js#L6-L68)）。
- 另有一套微信小程序 `miniprogram/`（20 个页面，含 `pages/connect`）。
- **没有 SSO 登录页、没有绑定引导页、没有设备管理页。**

### 1.6 配置管理

- Worker：`wrangler.toml` 的 `[vars]` + secrets（模板见 [wrangler.toml.example](file:///d:/data/build_GO/tokenrank/server/wrangler.toml.example)）。
- Node：`~/.tokenrank-server/config.json` **优先**，环境变量兜底，字段映射在 [node-service.mjs](file:///d:/data/build_GO/tokenrank/server/node-service.mjs#L27-L69)（`port/host/db_path/public_origin/feishu_*`）。
- URL 生成只信 `PUBLIC_BASE_URL` 或 `public_origin`（`userOrigin()`，[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L55-L57)）。
- CORS 默认关闭，只有 `CORS_ORIGIN` 白名单内的 `Origin` 才回 `access-control-allow-origin`，允许头仅 `authorization,content-type`（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L75-L89)）。

### 1.7 多租户现状

**没有租户概念。** 只有"群"：`rank_groups.group_openid_hash = sha256('feishu:chat:<chat_id>')`（[schema.sql](file:///d:/data/build_GO/tokenrank/server/schema.sql#L45-L53)），一个群一张榜，成员关系在 `rank_group_members`。所有榜单查询都跨全库（"广场"=`/api/leaderboard` 全站），没有任何 tenant 过滤。所以"单租户"改造的主体工作不是加租户字段，而是**移除/降级飞书群身份这一层**。

---

## 2. 硬约束与禁止事项

**必须遵守：**

1. 不破坏现有采集上报契约：`POST /report`、`POST /agent/heartbeat`、`GET /report/capabilities` 的请求体与鉴权语义保持不变（`connect_tokens` 仍是 Bearer）。存量同步器（`client/`）必须不改代码也能继续上报。
2. 所有新增行为由配置开关控制，默认值保持现状（`AUTH_MODE=feishu`）。SSO 只能显式开启。
3. 单租户 = 一套部署一个组织。**不要引入 `tenant_id` 维度到 SQL 查询**，也不要搞 RLS；用部署级配置表达组织边界（组织名、IdP、允许域）。
4. 会话与凭证走 HTTPS；Cookie 必须 `HttpOnly` + `Secure` + `SameSite=Lax`；不得把长期接入码写进日志、URL query、HTML 明文（除"一次性短期绑定码"页面展示）。
5. Node 与 Worker 两种运行时都必须能跑：新增代码不得只用 Cloudflare 专有 API（KV、DO、Queues）。`crypto.subtle` / `fetch` / D1 接口可用。
6. 所有 DDL 必须同时进 `server/schema.sql`（新库）与 `server/migrations/00xx_*.sql`（老库），命名递增，不许改历史迁移。
7. 新增测试放 `server/test/`，用 `node --test`，与现有假 D1 风格一致；`npm test`（`server/package.json`）必须全绿。

**禁止：**

- 禁止把 OIDC `id_token` 原样下发给浏览器后由前端自行校验；校验只在服务端。
- 禁止在安装脚本里内联长期凭证（即：不要保留"命令里塞 32 位长期接入码"这条路径作为默认路径）。
- 禁止直接删除飞书相关表/字段；只做兼容降级（详见第 9 节）。
- 禁止改动 `client/sync` 上报协议、`trae-extension`、`miniprogram`（除非本提示词明确要求）。
- 禁止为了"未来多 IdP"设计插件注册中心；一个 `env` 驱动的 provider 工厂即可。

---

## 3. 单租户模式界定与配置项

### 3.1 界定

- 一次部署只服务一个组织、一个 IdP、一组允许邮箱域（`AUTH_ALLOWED_DOMAINS`，逗号分隔）。
- 组织边界即部署边界：跨组织隔离由"另一套部署"保证，应用内不做租户过滤。
- 原"群榜"降级为**可选功能**：保留 `rank_groups` 表与接口（存量数据不删），但默认隐藏入口；SSO 模式下的默认榜单是"组织总榜"（等价现有 `/api/leaderboard` 全站榜，在单租户部署里天然就是组织榜）。
- 原"广场/全站"文案改为组织名（配置项 `ORG_NAME`）。

### 3.2 新增配置项（`env` 命名，Worker `[vars]` 与 Node config 都要映射）

| 键 | 说明 | 默认 |
|---|---|---|
| `AUTH_MODE` | `feishu` \| `sso` \| `both` | `feishu` |
| `ORG_NAME` | 组织显示名，替换"广场"文案 | `TokenRank` |
| `SSO_PROVIDER` | `oidc` \| `gateway` | `oidc` |
| `SSO_ISSUER` | OIDC issuer（用于 discovery 或显式端点） | 空 |
| `SSO_CLIENT_ID` / `SSO_CLIENT_SECRET` | 客户端凭证；secret 只走 secret/config，不入库 | 空 |
| `SSO_REDIRECT_URI` | 必须与 IdP 登记一致，默认 `${PUBLIC_BASE_URL}/api/auth/callback` | 空 |
| `SSO_SCOPE` | 空格分隔，默认 `openid profile email` | `openid profile email` |
| `SSO_CLAIM_SUB` / `_EMAIL` / `_NAME` / `_DEPT` / `_EMPLOYEE_NO` | claim 名映射，如 `sub` / `email` / `name` / `department` / `employee_no` | 见左 |
| `SSO_AUTHORIZE_URL` / `_TOKEN_URL` / `_USERINFO_URL` / `_JWKS_URL` | 关闭 discovery 或私有网关时显式指定 | 空 |
| `SSO_DISCOVERY` | `1` 表示用 `{issuer}/.well-known/openid-configuration` | `1` |
| `SSO_EMAIL_CLAIM_REQUIRED` | `1` 时无 email claim 直接拒绝登录 | `0` |
| `AUTH_ALLOWED_DOMAINS` | 允许登录的邮箱域，空=不限制 | 空 |
| `SESSION_TTL_DAYS` | 会话有效期，默认沿用 30 天 | `30` |
| `SESSION_COOKIE_NAME` | 默认 `tr_session` | `tr_session` |
| `BIND_CODE_TTL_SECONDS` | 一次性绑定码有效期，建议 600 | `600` |
| `FEISHU_COMPAT` | `1` 保留飞书机器人处理器与 `/api/feishu/session`（`AUTH_MODE=both` 时自动为 1） | `0` |

### 3.3 需要降级而非删除的部分

| 现有实现 | 处理 |
|---|---|
| `POST /feishu/event`、飞书长连接（[node-service.mjs](file:///d:/data/build_GO/tokenrank/server/node-service.mjs#L201-L225)） | 保留代码；`AUTH_MODE!=feishu && FEISHU_COMPAT!=1` 时不注册长连接、接口返回 404 |
| `GET/POST /api/feishu/session` | 保留；`AUTH_MODE!=feishu` 时 `GET` 返回 `{sso:true, ...}` 或 404，由前端按 `/api/auth/config` 判断 |
| `users.openid = 'feishu:<open_id>'` | 保留列；SSO 用户 `openid` 写 `sso:<provider>:<sub>`（`OPENID_PREFIX` 已有前缀约定，见 [feishu.js](file:///d:/data/build_GO/tokenrank/server/src/feishu.js#L1-L9)） |
| `rank_groups` / `rank_group_members` | 保留表与接口；`AUTH_MODE=sso` 时前端不展示"群榜"tab，接口仍可用 |
| `feishu_event_log`、`feishu_avatar_cache` | 保留，不再写入 |

---

## 4. SSO 对接方案

### 4.1 适配层抽象（先抽象，再实现）

新建 `server/src/auth/provider.js`，只暴露三个方法，签名固定：

```js
// 返回 { url, state, codeVerifier? }  —— 前端 302 到这里
buildAuthorizeUrl(env, { redirectTo })
// 入参为回调参数，返回 { subject, email, name, department, employeeNo, avatarUrl, raw }
exchangeCallback(env, { code, state, codeVerifier, query })
// 返回 { subject, email, name, department, employeeNo, avatarUrl }
userInfo(env, { accessToken })   // gateway 模式才用；oidc 用 id_token 校验后的 claim
```

- `oidc.js`（默认）：授权码 + PKCE(S256) + `state`，服务端校验 `id_token` 的 `iss/aud/exp/nonce/signature`（JWKS 校验，`crypto.subtle.importKey` + `verify`；RS256 为主，`SSO_ALG` 可配 `HS256` 供私有网关）。
- `gateway.js`：当对方是自研 SSO 网关、不做标准 OIDC 时使用。它只要求网关提供两个端点（由 `SSO_AUTHORIZE_URL`/`SSO_TOKEN_URL`/`SSO_USERINFO_URL` 注入）：授权跳转返回 `code`、换 token 返回 `access_token`、userinfo 返回 JSON。**claim 映射全部走 `SSO_CLAIM_*`，代码里不准硬编码字段名。**
- 私有协议额外形态（XMLE 断言、SAML、签名参数）一律在 `gateway.js` 内做转换，不让上层感知。**SAML 不在本次范围**，如确需，只要求把断言转成上述 `raw` 结构。

配置注入示例（不考虑 discovery 的私有网关）：

```ini
SSO_PROVIDER=gateway
SSO_AUTHORIZE_URL=https://idp.example.com/oauth2/authorize
SSO_TOKEN_URL=https://idp.example.com/oauth2/token
SSO_USERINFO_URL=https://idp.example.com/oauth2/userinfo
SSO_CLIENT_ID=tokenrank
SSO_CLIENT_SECRET=<secret>
SSO_REDIRECT_URI=https://rank.example.com/api/auth/callback
SSO_CLAIM_SUB=user_id
SSO_CLAIM_EMAIL=mail
SSO_CLAIM_NAME=display_name
SSO_CLAIM_DEPT=dept_path
```

### 4.2 登录流程（服务端主导）

1. `GET /api/auth/config` → `{ sso:true, provider, org_name, login_url:'/api/auth/login' }`（未配置 SSO 时 `sso:false`，前端回落到飞书遮罩或"未配置"提示）。
2. `GET /api/auth/login?redirect=/bind` → 服务端生成 `state` + `code_verifier`，写 `oidc_states`（TTL 10 分钟），`302` 到 IdP。
3. `GET /api/auth/callback?code&state` → 校验 `state`（一次性删除），换 token，校验 `id_token`，映射 claim → `upsertUserFromIdentity()` → 签发会话 → `Set-Cookie` → `302` 回 `redirect`（只允许站内相对路径，防开放重定向）。
4. `POST /api/auth/logout` → 删 `mp_sessions` 行 + 清 Cookie；`redirect` 可选到 IdP 的 `end_session_endpoint`（配置项 `SSO_LOGOUT_URL`，缺省不回跳）。
5. `GET /api/auth/me` → 与现有 `/api/me` 同结构，附加 `{email, department, employee_no, auth_mode}`。

**账号锚点规则（写进代码注释与测试）：**

```
openid = 'sso:' + SSO_PROVIDER + ':' + subject
查找顺序：
  1) identities(provider, subject) 命中 → 该 user_id
  2) users.email 命中（且未 disabled）→ 绑定 identities 到该 user
  3) users.employee_no 命中 → 同上
  4) 新建 users + identities
冲突（同一 email 已被其它 subject 绑定且两者 subject 不同）：拒绝登录，返回 409 `IDENTITY_CONFLICT`，写审计，不自动合并。
```

### 4.3 登录态载体：**选 HttpOnly Cookie 为主，Bearer 为兼容**

| 方案 | 判断 |
|---|---|
| 仅 Bearer + localStorage（现状 [app.js](file:///d:/data/build_GO/tokenrank/server/public/app/app.js#L34-L38)） | XSS 可直接窃取 30 天会话；H5 场景不可接受 |
| **HttpOnly Cookie 为主 + 保留 Bearer** | 推荐。`sessionUser()` 增加 Cookie 兜底分支，所有既有路由零改动即可支持浏览器；小程序/同步器/脚本继续用 Bearer 不受影响 |

实现要点：

- `sessionUser(request, env)` 改为：先读 `Authorization: Bearer`；无则读 `Cookie: ${SESSION_COOKIE_NAME}`（自写 cookie 解析，不引依赖）。
- 会话有效期：绝对过期沿用 `SESSION_TTL_DAYS`（默认 30 天），另加**滑动续期**：剩余 < 7 天时 `Set-Cookie` 新过期时间（写接口响应统一追加）。
- 刷新：不做 refresh token。IdP 会话过期后由前端在 401 时跳 `/api/auth/login?redirect=<当前路径>`。
- CSRF：Cookie 模式下写接口（非 GET）校验 `Origin`/`Sec-Fetch-Site` 必须与 `PUBLIC_BASE_URL` 同源；不满足返回 403 `CSRF_ORIGIN`。再加 `tr_csrf` 非 HttpOnly cookie（双提交），前端 `X-CSRF-Token` 头回带。**仅对 Cookie 会话生效，Bearer 会话跳过**。
- 不要把会话 token 写进 URL；回调只带 `code`/`state`。

---

## 5. 用户 ↔ 安装命令绑定：三种方案对比与推荐

### 5.1 方案定义

**A. H5 生成一次性短期绑定码，安装命令带 `--bind-code`（推荐）**

- H5 登录后 `POST /api/bind-codes` → 返回 8 位易读码（如 `K7M2-9QXF`）+ 10 分钟 TTL + 安装命令模板。
- 安装命令：`curl -fsSL {base}/install.sh | sh -s {base} --bind-code K7M2-9QXF`（PowerShell 同理）。
- 脚本第一步 `POST /api/install/claim {bind_code, device_hint}` → 服务端原子消费（`UPDATE ... WHERE used_at IS NULL AND expires_at > now`），幂等返回该用户的长期接入码 `connect_tokens.token`（不存在则创建）→ 脚本再用它走原流程。

**B. 命令行设备码 / 配对流程（RFC 8628 风格）**

- 命令只带 `{base}`，脚本 `POST /api/device/code` 拿 `user_code + device_code`，终端打印"请在浏览器打开 {base}/pair 输入 ABCD-1234"并轮询 `POST /api/device/token`；H5 登录后输入配对码确认。

**C. 服务端签发短期签名安装令牌，直接嵌入命令**

- 命令带 `?t=<HMAC 签名的一次性令牌>`；脚本拿它换接入码。本质与 A 相同，差别是令牌自校验（省一次 DB 查询）而非 DB 存状态。

### 5.2 对比

| 维度 | A 一次性绑定码 | B 设备码配对 | C 签名安装令牌 |
|---|---|---|---|
| 凭证暴露面 | 短码只证明"此人已登录"，10 分钟后失效、单次消费；泄露也换不到已绑定账号的长期码（可再加"仅限新设备"限制） | 命令不含任何秘密，最干净 | 签名令牌同样短期，但泄露后在本机可重复兑换（需 nonce 表，退化为 A） |
| 用户体验 | 一次登录 + 复制一条命令，无额外交互 | 需在两处操作：终端看码 → 浏览器输入码；内网 SSH 无浏览器时最合适 | 与 A 相同 |
| 实现成本 | 低：新增 2 个接口 + 1 张表；复用现有 `installCommands()` 与 `install.sh` 的参数解析 | 高：新增 3 个接口 + 轮询 + 终端等待循环 + 超时/取消 | 中：HMAC 密钥管理 + 时钟偏差 + 一次性 nonce 表 |
| 离线/内网 | 好：命令可先复制到离线机器执行，只要机器能访问服务端（内网可达即可） | 差：要求终端与浏览器同时在线轮询 | 好 |
| 换机/解绑 | H5 设备列表 + 重置接入码即可 | 天然一设备一码，管理更清晰 | 同 A |
| 与现网兼容 | 最好：`connect_tokens` 语义不变，脚本只多一个入参 | 需新增 `device_codes` 表与轮询 | 需新增签名体系 |

### 5.3 **推荐：A**，理由

1. 代码路径最短：现有"登录 → 生成安装命令"已经有 `getConnectToken`/`installCommands`（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L491-L505)），只需把"长期码直接进命令"换成"短期码换长期码"，`connect_tokens` 与上报链路零改动。
2. 安全收益最大的一步就是**让命令行不再出现永不过期的明文凭证**，A 直接达成；B 额外收益（一设备一码）可以后续在 `connect_tokens` 上加 `device_label/revoked_at` 补上，不必现在引入轮询协议。
3. 目标人群是"装了桌面 AI 工具的开发者"，本机一定有浏览器，B 的终端等待体验是净负担。
4. C 在安全性上不优于 A，只省一次 DB 查询，但引入密钥轮换与时钟偏差问题，不划算。**若后续确有"离线签名"需求，把 A 的码改由 HMAC 派生即可，接口不变。**

**落地形态（A + 轻量 C 思路）：**

- `bind_codes.code`：明文短码（`A-Z2-9` 去易混字符，8 位，形如 `XXXX-XXXX`），DB 存 `sha256(code)` 而非明文，防止库泄露直接可用。
- 兑换后返回该用户**现有** `connect_tokens.token`（幂等）；若无则新建。**不为每台设备换新码**——多设备共用一码是现有设计（`usage_device_state` 按 `device_id` 计数），保持。
- 想要"一设备一吊销"，在 `connect_tokens` 加 `device_label`/`revoked_at` 并在 H5 提供"重置全部接入码"（复用现有 `createConnectToken`），不新增设备级码。

### 5.4 失败与边界（必须实现并测试）

| 场景 | 期望 |
|---|---|
| 未登录调用 `POST /api/bind-codes` | 401 |
| 绑定码过期 | 脚本收到 410 `BIND_CODE_EXPIRED`，提示回浏览器重新生成 |
| 绑定码已被使用（并发双击） | 第一个成功，其余 409 `BIND_CODE_USED` |
| 绑定码格式错误 / 查不到 | 400 `BIND_CODE_INVALID`，**不区分"不存在"与"已用"** 对外文案 |
| 用户已被停用（`users.disabled_at`） | 403 `ACCOUNT_DISABLED` |
| 同一用户重复安装 | 幂等返回同一 token，脚本正常继续 |
| 用户点"重置接入码"后再用旧码 | 旧 token 401，脚本提示改用新命令（错误文案必须指向 H5 页面） |
| 脚本离线/服务端不可达 | 明确提示"无法连接到 {{base}}，请检查内网代理"，非 0 退出 |
| HTTP 明文（非回环） | 保持现有拒绝逻辑（[install.sh](file:///d:/data/build_GO/tokenrank/server/public/install.sh#L9)） |

---

## 6. 安装脚本与命令改造

### 6.1 命令格式

```
# bash
curl -fsSL {base}/install.sh | sh -s {base} --bind-code {CODE}
# PowerShell
& ([scriptblock]::Create((irm '{base}/install.ps1'))) -Server '{base}' -BindCode '{CODE}'
```

- **兼容**：保留 `sh -s {base} {token}` 与 `install.ps1 -Server {base} -Token {token}` 位置参数形式（存量卡片/存量文档仍在用），但帮助文本不再宣传。
- `--bind-code` 与旧 token 二选一；两者都缺失 → 打印用法并退出 1。

### 6.2 校验时机（严格按序）

1. 参数解析与基础校验（server 必须 HTTPS 或回环；code 形如 `^[A-Z2-9]{4}-[A-Z2-9]{4}$`）。
2. `POST {base}/api/install/claim`（`content-type: application/json`，`{bind_code, os, device_hint}`，`device_hint` 只放 `process.platform`/`os.release()` 级别的非个人化信息，禁止宿主名/用户名/路径）。
3. 响应 `{token}` 必须过 `^[0-9a-f]{32}$` 校验（复用 [config.js](file:///d:/data/build_GO/tokenrank/client/sync/config.js#L14-L18) 的 `normalizeToken` 语义）。
4. 之后的下载/校验/安装流程**完全不变**（sha256 → 版本断言 → `prepare-upstream` → `connect` → `install-agent` → `update-if-outdated` → `install-trae`）。

### 6.3 实现落点

- `server/public/install.sh`：新增第 3 个位置参数或解析 `--bind-code`；在 `VERSION` 之后、`APP=` 之前插入 claim 逻辑；claim 失败统一 `exit 1` 且不创建 `~/.tokenrank`。
- `server/public/install.ps1`：参数改为 `param([Parameter(Mandatory)][string]$Server, [string]$Token, [string]$BindCode)` 并做互斥校验；用 `Invoke-RestMethod` 调 claim，`catch` 里打印服务端 `error` 字段。
- 同步修改 `server/public/releases/<新版本>/` 快照与 `VERSION` 常量（两处：`install.sh`、`install.ps1`），并按仓库惯例新增版本目录。
- **Trae 扩展脚本不动**（不带 token）。

### 6.4 换机 / 重复绑定 / 解绑

- 重复运行同一绑定码：正常（幂等返回同 token）。
- 换机：直接在新机用**新生成的**绑定码（旧码已消费）。
- 主动解绑：H5 `POST /api/me/connect-token/reset`（复用 `createConnectToken`）→ 旧机下一次上报 401，`client/sync/health.js` 已有失败通知路径，不必新增。
- 账号停用：`/report` 已返回 403（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L529-L532)），保持。

---

## 7. H5 前端改造

复用现有 `server/public/app/` 的原生 JS 单页（无构建步骤），**不要引入 React/Vue**（与现有 `app.js` 风格、Node 静态白名单 `STATIC_ALLOW` 的 `/app/*.js.*` 正则配套，引入框架会额外产生构建与路径白名单问题）。

### 7.1 页面清单（可在同一 SPA 内用路由 hash 或新增 HTML 入口）

| 页面 | 路由 | 要点 |
|---|---|---|
| 登录页 | `/app/#/login` | 展示 `ORG_NAME` + "使用企业账号登录"按钮 → `/api/auth/login?redirect=/app/`；出错展示 IdP 返回错误码（不透传原始报文） |
| 绑定引导 | `/app/#/bind` | 三步式：① 说明（只上传按天聚合数字）② 生成绑定码与命令 ③ 等待设备接入 |
| 命令生成与复制 | `/app/#/bind` | 自动识别 `navigator.userAgent` 预选 Windows/macOS，可切 tab；一键复制按钮（`navigator.clipboard.writeText`，失败降级 `document.execCommand('copy')`）；显示倒计时"剩余 X 分 Y 秒" |
| 绑定状态轮询 | `/app/#/bind` | 每 3 秒 `GET /api/me`，`connected===true && last_report_at!==null` 即成功态；40 次后停止并提示"可稍后在'我的'查看"；页面隐藏时用 `visibilitychange` 暂停轮询 |
| 个人概览 | `/app/#/me` | 复用现有"我的"渲染（`/api/my/usage`、`/api/my/rankings`） |
| 设备/接入管理 | `/app/#/devices` | `GET /api/me/devices` 列表（device_id、platform、last_report_at、client_version、state）；"重置接入码"二次确认 |
| 说明 | `/app/#/help` | 数据口径 + 隐私声明，替换飞书相关表述 |

### 7.2 交互要点

- 首屏不 flash 未登录内容：先 `GET /api/auth/config` 决定渲染登录页还是内容页。
- 所有 `fetch` 默认 `credentials:'same-origin'`；保留 `api()` 的 Bearer 兼容分支（用于飞书模式并存期）。401 统一跳登录，不弹 toast。
- 错误码到文案的映射集中在 `app.js` 顶部一个表（`BIND_CODE_EXPIRED`/`BIND_CODE_USED`/`ACCOUNT_DISABLED`/`CSRF_ORIGIN`）。
- 复制命令时必须保留用户已选的 OS 分支，避免 mac 用户粘到 PowerShell。
- 绑定码展示区不可被 `esc` 之外的变量插入（现有 `esc()` 已可用）。

### 7.3 移动端适配

- 复用现有 `.tabbar` 与 `viewport-fit=cover` 设置；绑定码用 `font-variant-numeric: tabular-nums` + 单行大字号，避免折行导致复制错误。
- 命令块 `overflow-x:auto; white-space:pre`，横向滚动而不是换行（换行会破坏 shell 命令）。
- 触控目标 ≥ 44px；`safe-area-inset-bottom` 已由现有 CSS 处理，新增底部"生成/复制"按钮需沿用。

### 7.4 跨域与回调地址

- 后端与 H5 **同源部署**（`/api/*` 与 `/app/*` 同一 origin），不依赖 CORS；`CORS_ORIGIN` 保持默认空。
- IdP 侧登记的回调：`${PUBLIC_BASE_URL}/api/auth/callback`，必须与 `SSO_REDIRECT_URI` 完全一致（含协议与尾斜杠差异，**不要自动补斜杠**）。
- 若 H5 需独立域名，必须显式配置 `CORS_ORIGIN` 且 Cookie 需 `SameSite=None; Secure`，并在方案评审中说明——默认方案不建议。

---

## 8. 后端改造

### 8.1 新增 API 契约

| 方法 | 路径 | 鉴权 | 入参 | 出参 |
|---|---|---|---|---|
| GET | `/api/auth/config` | 无 | – | `{sso, provider, org_name, login_url, feishu}` |
| GET | `/api/auth/login` | 无 | `redirect`(可选, 站内相对) | 302 → IdP |
| GET | `/api/auth/callback` | 无 | `code,state` | 302 → `/app/...` + `Set-Cookie` |
| POST | `/api/auth/logout` | 会话 | – | `{ok:true}` + 清 Cookie |
| GET | `/api/auth/me` | 会话 | – | `publicUser()` + `{email,department,employee_no,auth_mode}` |
| POST | `/api/bind-codes` | 会话 | – | `{code:'XXXX-XXXX', expires_at, install_command, install_command_windows}` |
| GET | `/api/bind-codes/{code}` | 会话(仅本人) | – | `{used, expires_at, claimed_at}`（供轮询） |
| POST | `/api/install/claim` | 无（凭 bind_code） | `{bind_code, os, device_hint}` | `{token}`；错误码见 5.4 |
| GET | `/api/me/devices` | 会话 | – | `{devices:[{device_id,platform,client_version,last_report_at,state}]}` |
| POST | `/api/me/connect-token/reset` | 会话 | – | 复用 `createConnectToken` 返回 `{token, install_command...}` |

- 全部错误响应沿用 `jsonError(status, message, code)`（[lib.js](file:///d:/data/build_GO/tokenrank/server/src/lib.js#L81-L83)），`code` 供前端映射文案。
- 路由插入位置：`/api/auth/*` 放在 `/feishu/event` 之后、`/api/feishu/session` 之前；`/api/bind-codes`、`/api/install/claim` 放在"采集接入"区块之前（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L118-L133)、[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L330-L336)）。
- `POST /api/install/claim` 必须限流且**不返回任何用户信息**（只有 token），避免绑定码被撞库后用于枚举。

### 8.2 数据模型变更（同时改 `schema.sql` 与新增 `migrations/0023_sso.sql`）

```sql
-- 身份映射：一个 user 可绑多个身份（飞书 + SSO 并存期）
CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,           -- 'oidc' | 'gateway' | 'feishu'
  subject TEXT NOT NULL,
  email TEXT,
  name TEXT,
  department TEXT,
  employee_no TEXT,
  raw_json TEXT,                    -- 脱敏后的 claim 快照，禁止存 id_token/access_token
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_identities_provider_subject ON identities(provider, subject);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
CREATE INDEX IF NOT EXISTS idx_identities_email ON identities(email);

-- 一次性绑定码：只存哈希
CREATE TABLE IF NOT EXISTS bind_codes (
  code_hash TEXT PRIMARY KEY,       -- sha256(规范化后的 code)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_ip_hash TEXT,
  device_hint TEXT
);
CREATE INDEX IF NOT EXISTS idx_bind_codes_user ON bind_codes(user_id);

-- OIDC state/nonce/PKCE 暂存
CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nonce TEXT,
  code_verifier TEXT,
  redirect_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- 审计（只保留哈希，不保留原始 IP/UA）
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  actor TEXT NOT NULL,              -- 'sso' | 'feishu' | 'install' | 'user'
  action TEXT NOT NULL,             -- 'login' | 'login_denied' | 'bind_code_created' | 'bind_claim' | 'token_reset' | 'identity_conflict'
  target TEXT,
  code TEXT,
  ip_hash TEXT,
  ua_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
```

`users` 表新增列（`ALTER TABLE users ADD COLUMN ...`，全部可空，老库兼容）：

```sql
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN employee_no TEXT;
ALTER TABLE users ADD COLUMN department TEXT;
ALTER TABLE users ADD COLUMN auth_provider TEXT;   -- 'feishu' | 'oidc' | 'gateway'
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

`connect_tokens` 建议追加（可选，用于设备管理展示）：

```sql
ALTER TABLE connect_tokens ADD COLUMN revoked_at INTEGER;
ALTER TABLE connect_tokens ADD COLUMN last_ip_hash TEXT;
```

- 注意：D1/SQLite 的 `ALTER TABLE` 不支持 `IF NOT EXISTS` 列语法，迁移脚本里用 `PRAGMA table_info(users)` 判断后再执行，避免重复跑失败（Node 版 init 脚本会重复执行 schema）。
- `deleteAccount()`（[account.js](file:///d:/data/build_GO/tokenrank/server/src/account.js#L1-L18)）必须补删 `identities`、`bind_codes`、`audit_log`（audit 可保留但需把 `user_id` 置空，按你的隐私策略二选一，写进注释）。

### 8.3 鉴权中间件

现有代码是"每路由自取 `sessionUser`"，**不要重构为全局中间件**（改动面大、易漏）。做法：

1. 保持 `sessionUser()` 签名，内部新增 Cookie 兜底 + 滑动续期标记（返回对象上加 `_renew` 非持久字段）。
2. 新增 `requireSession(request, env, {csrf=true})` 帮助函数，返回 `{user}` 或 `Response`；新路由（auth/bind/devices）统一用它，老路由维持现状。
3. 新增 `requireAdmin(request, env)`：单租户模式下管理员由配置 `ADMIN_EMAILS`（或 `ADMIN_EMPLOYEE_NOS`）判定；仅用于后续管理接口，若本次不做管理台，则**不实现**。

### 8.4 审计与限流

- 审计写入点：登录成功/失败、绑定码生成、claim 成功/失败、token 重置、身份冲突。写 `audit_log`，异步（`ctx.waitUntil` 在 Worker；Node 版同步写）。
- 限流（DB 计数即可，不引 KV）：
  - `POST /api/bind-codes`：每用户 10 分钟内 ≤ 5 次。
  - `POST /api/install/claim`：每 `ip_hash` 10 分钟内 ≤ 10 次失败；每 `code_hash` 最多 3 次尝试（超额即作废该码）。
  - `GET /api/auth/callback`：每 `state` 一次性；`state` 不存在直接 400。
- 已有上报限流按设备保持（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L537-L545)），不动。

### 8.5 CORS / Origin

- 新增 Cookie 会话后，写接口需校验 `Origin`：`PUBLIC_BASE_URL` 优先级同 `userOrigin()`；缺失 `Origin` 且带 Cookie 的写请求视为 CSRF，返回 403。
- 保持 `corsHeaders()`（[worker.js](file:///d:/data/build_GO/tokenrank/server/src/worker.js#L73-L89)）不变，仅把 `credentials` 需求忽略（同源不需要 `allow-credentials`）。

### 8.6 明确不动的部分

- `POST /report`、`/agent/heartbeat`、`/report/capabilities`、`client/sync/*`、`trae-extension/*`、`miniprogram/*`。
- 榜单/分析/历史/分享/订阅/充值/提醒等业务模块：仅在其路由的 `sessionUser` 已能识别 Cookie 后自然生效，不改 SQL。

---

## 9. 数据迁移与兼容

### 9.1 存量飞书用户 → SSO 身份

问题：`users` 表当前**没有 email/工号**，只有 `openid='feishu:<open_id>'` 与昵称。因此必须先补映射数据，再切 SSO。

按优先级实现（任选其一，建议 1+3 组合）：

1. **导出映射（主路径）**：写一次性脚本 `server/scripts/backfill-feishu-email.mjs`（放 `server/scripts/`，不进运行时）：读 `users WHERE openid LIKE 'feishu:%'`，用飞书 `contact/v3/users/:open_id?user_id_type=open_id` 拉 `email`/`employee_no`/`department_ids`，写回 `users.email/employee_no/department` 并插 `identities(provider='feishu', subject=<open_id>)`。需要应用权限 `contact:user.email:readonly`（若企业不给权限，走方案 3）。
2. **管理员 CSV（备选）**：接受 `openid,email,employee_no` 三列 CSV，脚本导入，缺失行输出待人工处理清单。
3. **首登兜底 + 人工合并**：SSO 首登时按 `users.email` 匹配；未匹配则新建账号，管理员用 `server/scripts/merge-users.mjs <from_id> <to_id>` 合并（把 `daily_stats`/`daily_totals`/`usage_*`/`connect_tokens`/`rank_group_members` 的 `user_id` 改写，删空账号），并写别名表 `user_aliases(alias, user_id)` 防止下次登录又新建。

**验收必须给出**：迁移前后用户数、绑定成功数、未匹配清单、榜单总量误差（`SUM(tokens)` 变化必须为 0）。

### 9.2 双模式并行

- `AUTH_MODE=both`：`/api/auth/*` 与 `/api/feishu/session` 同时可用；`GET /api/auth/config` 返回 `{sso:true, feishu:true}`，前端优先 SSO，提供"仍用飞书登录"次级入口。
- 并行期写同一 `users` 表：同一个人两种登录方式应命中同一 `user_id`——靠 `identities`（`provider='feishu'` 与 `provider='oidc'` 两行都指向同一 user）。`/api/feishu/session` 的 `bindAccount` 需改为"先查 `identities(provider='feishu', subject=open_id)`，命中则复用，未命中再建号并写入 identities"，保持与 SSO 收敛。
- 榜单口径不变：两种登录都落 `daily_stats`，无需分表。

### 9.3 回滚

| 层 | 手段 |
|---|---|
| 应用 | `AUTH_MODE` 切回 `feishu`；`FEISHU_COMPAT=1`；长连接凭 `FEISHU_APP_ID/SECRET` 恢复 |
| 数据 | 只新增表/列，无删除；回滚不需要 SQL 回退。`users.email` 等新列留空不影响老逻辑 |
| 脚本 | `install.sh` 保留旧位置参数；老命令继续可用。如有问题，`server/public/releases/<旧版本>/` 已在库里可回滚分发 |

---

## 10. 验收标准（可直接执行）

### 10.1 单元/模块测试（`node --test server/test/*.test.mjs`）

新增 `server/test/auth.test.mjs`、`server/test/bind.test.mjs`，至少覆盖：

1. `buildAuthorizeUrl` 生成的 URL 含 `state`、`code_challenge`、`redirect_uri`，且 `redirect_uri` 与配置逐字节一致。
2. `exchangeCallback` 对 `state` 不存在 / 已过期 / 已使用 三种情况分别 400，且 `oidc_states` 行被删除。
3. `id_token` 校验：`aud` 不符 → 拒绝；`iss` 不符 → 拒绝；`exp` 过期 → 拒绝；签名错误 → 拒绝。
4. claim 映射：`SSO_CLAIM_EMAIL=mail` 时能从 `{mail:'a@b'}` 取到 email；`SSO_CLAIM_*` 缺失字段时不崩。
5. 账号锚点：`identities` 命中 → 同 user；email 命中 → 绑定并复用；email 已被其他 subject 绑定 → 409 `IDENTITY_CONFLICT`。
6. `AUTH_ALLOWED_DOMAINS=b.com` 时 `a@a.com` 登录被拒（403）。
7. 绑定码：生成后 `sha256` 入库、明文不落库；兑换后 `used_at` 非空；二次兑换 409；过期 410；并发两次兑换只有一次成功（用假 DB 模拟顺序）。
8. `POST /api/install/claim` 只返回 `{token}`，响应体不含 `user_id/nickname/email`。
9. Cookie 会话：`sessionUser` 能从 Cookie 头解析；Bearer 与 Cookie 同时存在时 Bearer 优先。
10. CSRF：Cookie 会话 + 跨站 `Origin` 的 `POST` → 403；同源 → 通过；Bearer 会话 → 不校验 Origin。

### 10.2 端到端手工验收（内网/预发）

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 访问 `/app/` 未登录 | 显示登录页，不出现任何用量数字 |
| 2 | 点登录 → IdP 授权 → 回调 | 302 回 `/app/`，`Set-Cookie` 为 HttpOnly+Secure；`document.cookie` 读不到会话 |
| 3 | 打开 DevTools → Application → Cookie | `tr_session` 有 HttpOnly/Secure/SameSite=Lax，无 Bearer 落在 localStorage |
| 4 | `/app/#/bind` 生成码 | 返回 8 位码 + 剩余时间；复制命令与码一致 |
| 5 | 在干净机器执行 bash 命令 | 安装成功，`~/.tokenrank/config.json` 中为 32 hex；`tokenrank rank status` connected=true |
| 6 | 同一码再执行一次 | 幂等成功（同 token），不报错 |
| 7 | 等待 11 分钟后用旧码 | 脚本 `BIND_CODE_EXPIRED`，退出码 1，且未创建 `~/.tokenrank` |
| 8 | H5 刷新 `/app/#/bind` | 3 秒内 `connected` 变 true，展示"已接入"与设备信息 |
| 9 | 关闭浏览器标签页 20 分钟再回来 | 会话仍有效（<7 天续期前）或不失效提示重新登录 |
| 10 | H5 点"重置接入码" | 旧机下一次上报 401；`rank status` 显示 last_error 指向重新接入 |
| 11 | 用 `curl` 伪造 `Origin: https://evil.com` 带 Cookie 调 `POST /api/bind-codes` | 403 `CSRF_ORIGIN` |
| 12 | 用已停用账号（`users.disabled_at`）登录 | 403 `ACCOUNT_DISABLED`，不签发会话 |
| 13 | `AUTH_MODE=both` 用飞书登录同一人 | 命中同一 user（`/api/me` 的 `user_id` 不变），用量不分裂 |
| 14 | 跨组织误访（用另一个部署的域名+本部署 Cookie） | Cookie 域不同 → 未登录，不会带凭据 |
| 15 | 绑定码爆破：连续 4 次错误 claim | 第 3 次后该码作废；`audit_log` 记录并触发限流 |

### 10.3 回归必须全绿

- `npm test`（server）、`node client/test-sync/sync.test.mjs`。
- `install.sh` / `install.ps1` 用旧参数在本地回环跑通（老命令不回归）。
- Node 版 (8790) 与 Worker 版（`wrangler dev`）各跑一次 10.1 的关键路径。

---

## 11. 风险与未决项（需业务方确认后填配置，不要自己猜）

1. **具体 IdP**：是标准 OIDC（Keycloak/Azure AD/企业自研）、还是私有签名网关？提供 issuer、三个端点、支持的签名算法、是否返回 `email`/`department`。
2. **是否内网部署**：服务端与 IdP 是否在内网可达？若服务端需访问公网 IdP，需确认出网策略与代理（现有 `deploy/k8s` 的 egress 策略需同步改）。
3. **是否保留飞书模式**：`AUTH_MODE=both` 还是直接 `sso`？若直接切换，需确认存量飞书用户 email 映射的数据来源（飞书权限 `contact:user.email:readonly` 是否可批）。
4. **身份唯一键**：以 `email` 还是 `employee_no` 作为主匹配键？是否存在一人多邮箱/多工号。
5. **域名与回调**：正式域名、是否 HTTPS 强制、IdP 登记的回调地址是否允许 `/api/auth/callback`（有些企业只允许根路径）。
6. **会话时长与合规**：30 天是否可接受；是否需要"退出登录同时踢 IdP 会话"。
7. **绑定码有效期**：10 分钟是否够（弱网/远程办公场景）；是否需要管理员可调。
8. **未匹配存量用户的处置**：允许新建空账号（数据从零开始）还是必须人工合并（有数据丢失风险）。
9. **群榜去留**：单租户下是否保留 `rank_groups` 入口（保留代码但隐藏 UI 是默认决定，需确认）。
10. **管理需求**：是否需要管理员停用账号/查看审计/强制解绑（现有代码只有 `users.disabled_at` 字段，没有管理接口；本次默认不做，仅预留 `ADMIN_EMAILS`）。

---

## 12. 交付顺序（每个阶段一个可回滚 PR）

| 阶段 | 内容 | 主要文件 | 完成判据 |
|---|---|---|---|
| P0 | 配置与开关：`AUTH_MODE` 等 env 映射（Worker vars + Node config） | `wrangler.toml.example`、`node-service.mjs` | 默认 `feishu` 时行为与当前完全一致 |
| P1 | 数据模型：`identities`/`bind_codes`/`oidc_states`/`audit_log` + `users` 新列 | `schema.sql`、`migrations/0023_sso.sql` | 迁移幂等；`npm test` 全绿 |
| P2 | SSO 适配层 + `/api/auth/*` + Cookie 会话（`sessionUser` 兜底） | `src/auth/provider.js`、`src/auth/oidc.js`、`src/auth/gateway.js`、`worker.js` | 第 10.1 的 1–6、9–10 用例通过 |
| P3 | 绑定码与 claim + 安装脚本改造 + releases 快照 | `worker.js`、`public/install.sh`、`public/install.ps1`、`public/releases/<ver>/` | 第 10.1 的 7–8、10.2 的 4–7 通过 |
| P4 | H5：登录/绑定/设备/概览页 | `public/app/index.html`、`app.js`、`app.css` | 第 10.2 的 1–3、8–9、11 通过 |
| P5 | 存量迁移脚本 + 双模式收敛 + 文档 | `server/scripts/*`、`docs/`、`README.md` | 第 9.1 的对账数字给出；第 10.2 的 13 通过 |

每阶段结束跑：`npm test`（`server/`）→ `install.sh`/`install.ps1` 本地演练 → 提交信息写清"阶段 + 行为变化 + 回滚方式"。
