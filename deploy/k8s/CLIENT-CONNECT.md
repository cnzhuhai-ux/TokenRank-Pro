# TokenRank 客户端对接文档

面向：需要在 Windows / Linux / macOS 电脑上安装**只读同步器**、把本机 token 用量上报到本服务的人。

服务端地址（对外入口，HTTPS，公网可信证书）：

```
https://tokenrank.oortcloudsmart.com:2443
```

- 链路：`2443`（外网映射）→ 集群 Ingress（TLS 终止，Let's Encrypt 证书自动续期）→ Service → Node 服务。
- **证书由 cert-manager 自动签发，客户端无需安装任何 CA**，也不需要设置 `NODE_EXTRA_CA_CERTS`。
- 集群内另有直连控制器的端口（32259），仅供运维排障，客户端统一用 `2443`。

---

## 0. 先明确：`npx tokenrank-client` 为什么必然失败

```
npm error 404 Not Found - GET https://registry.npmjs.org/tokenrank-client
```

`tokenrank-client` **没有发布到 npm**（安全加固后改为「安装包由本服务分发」）。因此：

- ❌ `npx tokenrank-client@latest connect ...`
- ✅ 用本服务提供的 `install.sh` / `install.ps1`

安装包地址（带 SHA-256 校验）：

```
https://tokenrank.oortcloudsmart.com:2443/dl/tokenrank-client-0.2.31.tar.gz
https://tokenrank.oortcloudsmart.com:2443/dl/tokenrank-client-0.2.31.tar.gz.sha256
```

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22.13**（客户端用到 `node:sqlite`） |
| 网络 | 能访问 `tokenrank.oortcloudsmart.com:2443`（域名需可解析） |
| 证书 | 无需配置（公信证书） |
| 接入码 | 32 位十六进制，获取方式见 1.1 |

自检（在客户端机器上执行）：

```bash
curl -sS https://tokenrank.oortcloudsmart.com:2443/healthz
# 期望：{"ok":true,"day":"2026-10-28"}
```

```powershell
Invoke-RestMethod https://tokenrank.oortcloudsmart.com:2443/healthz
```

## 1.1 接入码怎么来（重要）

接入码 = `connect_tokens.token`，32 位十六进制，标识「哪个用户、哪台设备在合法上报」。

| 路径 | 是否可用 | 说明 |
|---|---|---|
| 小程序「接入电脑」页 | ❌ 当前不可用 | `server/node-service.mjs:61` 把 `WX_APPID` 置空，`/api/wx/session` 返回 503，微信登录在本部署被有意关闭 |
| 飞书机器人 | ✅ 已启用 | 私聊机器人即可绑定账号并下发/复用接入码（`server/src/feishu.js:328`）；集群出网已放行，长连接由 pod 主动连出。也可以打开机器人卡片里的「网页版完整界面」入口（`/app/`） |
| 运维手工签发 | ✅ 立即可用 | 试点期最快；重新签发会使该用户旧码失效 |

手工签发（服务端执行，`<用户标识>` 仅用于在库里区分人）：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj exec deploy/tokenrank -- node -e "
const {DatabaseSync}=require('node:sqlite');
const crypto=require('node:crypto');
const d=new DatabaseSync(process.env.TOKENRANK_DB); const now=Date.now();
const openid='manual:'+process.argv[1];
d.prepare('INSERT INTO users(openid,nickname,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(openid) DO NOTHING').run(openid,process.argv[1],now,now);
const id=d.prepare('SELECT id FROM users WHERE openid=?').get(openid).id;
d.prepare('DELETE FROM connect_tokens WHERE user_id=?').run(id);
const token=crypto.randomBytes(16).toString('hex');
d.prepare('INSERT INTO connect_tokens(token,user_id,created_at) VALUES (?,?,?)').run(token,id,now);
console.log('user_id='+id+' token='+token);
" '<用户标识>'
```

把输出的 `token=` 值交给客户端使用。

---

## 2. 安装：一条命令

`<接入码>` 替换成 1.1 拿到的 32 位码。

### Windows（PowerShell）

```powershell
& ([scriptblock]::Create((irm 'https://tokenrank.oortcloudsmart.com:2443/install.ps1'))) 'https://tokenrank.oortcloudsmart.com:2443' '<接入码>'
```

### Linux / macOS

```bash
curl -fsSL https://tokenrank.oortcloudsmart.com:2443/install.sh | sh -s https://tokenrank.oortcloudsmart.com:2443 '<接入码>'
```

安装脚本会依次：下载分发包 → 校验 SHA-256 → 检测/安装原版采集器 token-watcher（`prepare-upstream`）→ 首次同步 → 注册后台同步服务。

脚本对参数的校验（不满足会直接报错退出）：

- 服务器必须是 `https://`
- 接入码必须是 `^[0-9a-f]{32}$`
- 地址里不能带账号密码、查询串、片段

---

## 3. 验证

```bash
tokenrank rank status      # connected=true、server=https://tokenrank.oortcloudsmart.com:2443、last_error=null
tokenrank rank push        # 手动同步一次（幂等：无变化时 accepted=0）
tokenrank doctor           # 只读检查统计库结构
```

服务端侧核对（运维执行）：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj exec deploy/tokenrank -- \
  node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.TOKENRANK_DB);console.log(d.prepare('SELECT user_id,day,tokens FROM daily_totals ORDER BY day DESC LIMIT 5').all())"
```

排障常用：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj logs deploy/tokenrank --tail=50
kubectl --kubeconfig=<kubeconfig> -n ai-pj get certificate,challenge          # 证书状态
kubectl --kubeconfig=<kubeconfig> -n ai-pj get networkpolicy                   # 入站/出站策略
```

---

## 4. 排障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm error 404 ... tokenrank-client` | 用了 `npx`，npm 上没有这个包 | 改用第 2 步的 `install.sh` / `install.ps1` |
| `服务器需使用 HTTPS` / `服务器地址或接入码无效` | 传了 `http://...` 或用错端口 | 用 `https://tokenrank.oortcloudsmart.com:2443` |
| `curl: (6) Could not resolve host` | 域名 A 记录缺失/未生效 | 补 A 记录；或临时在 hosts 里写 `<节点IP> tokenrank.oortcloudsmart.com` |
| 连接一直转圈、无响应（TLS 已握手） | ai-pj 的 NetworkPolicy 没放行 ingress-nginx | 确认 `tokenrank-allow-ingress-nginx` 存在：`kubectl -n ai-pj get networkpolicy` |
| `404` 访问 `/install.sh`、`/dl/*` | 静态白名单只放行固定路径；路径拼错或镜像版本不含分发包 | 核对 URL；`kubectl -n ai-pj exec deploy/tokenrank -- ls /app/server/public/dl` |
| `401 invalid connect token` | 接入码被重新签发或已失效 | 重新签发（1.1） |
| `429 上报过于频繁` | 短时间重复推送 | 等 `retry-after` 秒数后再试 |
| 提示 `token-watcher x.x.x 低于 1.8.2` | 采集内核太旧会重复计算 | 按提示运行更新命令（小程序「说明」页） |
| 提示 `N 天的统计数字超出上报协议范围，已跳过不上传` | 上游采集库里有个别日期存在脏数据（负值/超大值/小数） | 正常现象：该日跳过、其余照常上报；如需修正该日请把日期与数值反馈给管理员 |
| `npm error ECONNREFUSED 127.0.0.1:<端口>`（安装原版时） | 本机 `~/.npmrc` 残留了已关闭的代理 | `npm config delete proxy && npm config delete https-proxy`；0.2.18+ 安装器已自动隔离该配置并回退国内镜像 |
| 证书过期告警 | cert-manager 续期失败 | 看 `kubectl -n ai-pj describe certificate` 与 challenge 事件 |

---

## 5. 安全须知

1. **接入码 = 上报凭证**，泄露即可伪造用量；泄露后重新签发即作废旧码。
2. 客户端**只读**本机统计库，不改写原版 token-watcher 数据；上报内容为日桶用量（模型/工具/token 数），不含提示词与代码内容。
3. 对外只有 Ingress 的 HTTPS 入口；集群内明文只到 pod，且受 NetworkPolicy 限制。
4. 不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 之类的开关绕过校验——本服务用公信证书，没有绕过的必要。
