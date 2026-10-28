# TokenRank 客户端对接文档（ai-pj 集群版）

面向：需要在 Windows / Linux / macOS 电脑上安装**只读同步器**、把本机 token 用量上报到本服务的人。

服务端地址（生产入口，HTTPS）：

```
https://tokenrank.oortcloudsmart.com:30443
```

- 域名由公网 DNS 解析到局域网节点 `192.168.88.118`；Service 是 NodePort，集群**任意节点**都能接（Pod 实际跑在 `192.168.88.115`），换节点不用改客户端配置。
- 服务部署在单租户集群（API `192.168.88.112`）的 `ai-pj` 命名空间。
- 链路：`域名:30443` → nginx（TLS 终止 + 静态分发）→ Node 服务 `127.0.0.1:8790` → SQLite（PVC `tokenrank-data`）。
- Service 另有一个明文端口（NodePort 由集群分配，当前 `30685`），**只用于排障**：客户端与安装脚本都强制 HTTPS（私网明文等于把接入码和用量裸奔）。
- 当前证书由**内网自签 CA** 签发，SAN 覆盖 `tokenrank.oortcloudsmart.com` 与 `192.168.88.118`、`192.168.88.112`、`127.0.0.1`。**客户端必须信任这个 CA**，否则 TLS 校验失败。

> 想让客户端「开箱即用、不用装 CA」，把证书换成公信证书即可，见第 7 节。

---

## 0. 先明确一件事：`npx tokenrank-client` 为什么必然失败

```
npm error 404 Not Found - GET https://registry.npmjs.org/tokenrank-client
```

`tokenrank-client` **没有发布到 npm**（安全加固后已改为「安装包由本服务分发」）。因此：

- ❌ `npx tokenrank-client@latest connect ...`
- ✅ 用本服务提供的 `install.sh` / `install.ps1`

安装包地址（由本服务托管，带 SHA-256 校验）：

```
https://tokenrank.oortcloudsmart.com:30443/dl/tokenrank-client-0.2.16.tar.gz
https://tokenrank.oortcloudsmart.com:30443/dl/tokenrank-client-0.2.16.tar.gz.sha256
```

---

## 1. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22.13**（客户端用到 `node:sqlite`） |
| 网络 | 能访问 `tokenrank.oortcloudsmart.com:30443`（域名需能解析；纯离线环境把域名写进 hosts 指向任一节点） |
| 证书 | 已信任内网 CA（第 2 步）；换成公信证书后此步可省 |
| 接入码 | 32 位十六进制，获取方式见 1.1 |

先自检网络与证书（在客户端机器上执行）：

```bash
# Linux/macOS
curl --cacert ./ca.crt -sS https://tokenrank.oortcloudsmart.com:30443/healthz
# 期望：{"ok":true,"day":"2026-10-28"}
```

```powershell
# Windows PowerShell（需先完成第 2 步 CA 导入，否则 irm 报证书错误）
Invoke-RestMethod https://tokenrank.oortcloudsmart.com:30443/healthz
```

## 1.1 接入码怎么来（重要）

接入码 = `connect_tokens.token`，32 位十六进制，标识「哪个用户、哪台设备在合法上报」。本部署有两条合法路径：

| 路径 | 是否可用 | 说明 |
|---|---|---|
| 小程序「接入电脑」页 | ❌ 当前不可用 | `server/node-service.mjs:61` 把 `WX_APPID` 置空，`/api/wx/session` 返回 503，微信登录在本部署被有意关闭；该文件写死了此值，配环境变量也不生效 |
| 飞书机器人 | ✅ 需配置 | 配好 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 后，飞书长连接按 open_id 绑定用户并下发/复用其接入码（`server/src/feishu.js:328`） |
| 运维手工签发 | ✅ 立即可用 | 试点期最快；重新签发会使该用户旧码失效 |

手工签发（服务端执行，`<用户标识>` 仅用于在库里区分人）：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj exec deploy/tokenrank -c tokenrank -- node -e "
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

## 2. 信任内网 CA

拿到的文件：`ca.crt`（管理员保管 `ca.key`，**不要外发 CA 私钥**）。

### Windows（PowerShell，当前用户，无需管理员）

```powershell
# 1) 让 PowerShell(irm) 信任：导入到「当前用户 → 受信任的根证书颁发机构」
certutil -addstore -user Root C:\TokenRank\ca.crt

# 2) 让 Node 也信任：Node 不读 Windows 证书存储，必须显式指定
$env:NODE_EXTRA_CA_CERTS = "C:\TokenRank\ca.crt"     # 当前会话生效
setx NODE_EXTRA_CA_CERTS "C:\TokenRank\ca.crt"       # 以后每个会话生效（需重开终端）
```

卸载：`certutil -delstore -user Root "TokenRank Internal CA"`。

### Linux

```bash
sudo cp ca.crt /usr/local/share/ca-certificates/tokenrank-internal-ca.crt
sudo update-ca-certificates
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/tokenrank-internal-ca.crt   # 建议写进 ~/.profile
```

### macOS

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt
export NODE_EXTRA_CA_CERTS=$PWD/ca.crt
```

> **关键点**：`NODE_EXTRA_CA_CERTS` 一定要设。`curl`/`irm` 走系统信任库，Node 的 `fetch` 走自带根证书库——只导入系统信任库，安装脚本能下包，但 `connect` 第一次上报会报 `fetch failed`。
> 不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过，那等于对所有站点关闭 TLS 校验。

---

## 3. 安装：一条命令

`<接入码>` 替换成 1.1 拿到的 32 位码。

### Windows（PowerShell）

```powershell
& ([scriptblock]::Create((irm 'https://tokenrank.oortcloudsmart.com:30443/install.ps1'))) 'https://tokenrank.oortcloudsmart.com:30443' '<接入码>'
```

### Linux / macOS

```bash
curl -fsSL https://tokenrank.oortcloudsmart.com:30443/install.sh | sh -s https://tokenrank.oortcloudsmart.com:30443 '<接入码>'
```

安装脚本会依次：下载分发包 → 校验 SHA-256 → 检测/安装原版采集器 token-watcher（`prepare-upstream`）→ 首次同步 → 注册后台同步服务。

脚本对参数的校验（不满足会直接报错退出）：

- 服务器必须是 `https://`（或 `http://localhost|127.0.0.1`）
- 接入码必须是 `^[0-9a-f]{32}$`
- 地址里不能带账号密码、查询串、片段

---

## 4. 验证

```bash
tokenrank rank status      # connected=true、server=https://tokenrank.oortcloudsmart.com:30443、last_error=null
tokenrank rank push        # 手动同步一次（幂等：无变化时 accepted=0）
tokenrank doctor           # 只读检查统计库结构
```

服务端侧核对（运维执行）：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj exec deploy/tokenrank -c tokenrank -- \
  node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.TOKENRANK_DB);console.log(d.prepare('SELECT user_id,day,tokens FROM daily_totals ORDER BY day DESC LIMIT 5').all())"
```

排障用的服务端检查：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj exec deploy/tokenrank -c tokenrank -- \
  node -e "fetch('http://127.0.0.1:8790/healthz').then(r=>r.text()).then(console.log)"
kubectl --kubeconfig=<kubeconfig> -n ai-pj logs deploy/tokenrank -c tokenrank --tail=50
kubectl --kubeconfig=<kubeconfig> -n ai-pj logs deploy/tokenrank -c web --tail=50
```

---

## 5. 排障对照表

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm error 404 ... tokenrank-client` | 用了 `npx`，npm 上没有这个包 | 改用第 3 步的 `install.sh` / `install.ps1` |
| `服务器需使用 HTTPS` / `服务器地址或接入码无效` | 传了 `http://...`（明文端口） | 用 `https://tokenrank.oortcloudsmart.com:30443` |
| `curl: (60) SSL certificate problem` | 客户端没信任 CA | 第 2 步（Linux 可临时 `--cacert ./ca.crt`） |
| `curl: (6) Could not resolve host` | DNS 未生效/无外网 DNS | 在 hosts 里加 `<节点IP> tokenrank.oortcloudsmart.com` |
| `connect` 报 `fetch failed`，但 `/healthz` 能通 | Node 未设置 `NODE_EXTRA_CA_CERTS` | 设置环境变量并**重开终端**/重启后台服务 |
| `404` 访问 `/install.sh`、`/dl/*` | nginx 静态目录没铺好 | `kubectl logs <pod> -c fill-webroot` |
| `401 invalid connect token` | 接入码被重新签发或已失效 | 重新签发（1.1） |
| `429 上报过于频繁` | 短时间重复推送 | 等 `retry-after` 秒数后再试 |
| 提示 `token-watcher x.x.x 低于 1.8.2` | 采集内核太旧会重复计算 | 按提示运行更新命令（小程序「说明」页） |
| 后台不自动同步 | `install-agent` 服务未继承环境变量 | 服务定义里加 `NODE_EXTRA_CA_CERTS`，或改用公信证书（第 7 节） |

---

## 6. 安全须知

1. **接入码 = 上报凭证**，泄露即可伪造用量；泄露后重新签发即作废旧码。
2. **CA 私钥只在服务端管理员手里**（`tokenrank-certs/ca.key`，未入库）。客户端只需要 `ca.crt`。
3. 客户端**只读**本机统计库，不改写原版 token-watcher 数据；上报内容为日桶用量（模型/工具/token 数），不含提示词与代码内容。
4. 域名解析到内网 IP 只影响「从哪进」，不改变安全边界：**Service 的明文端口（非 30443）应只在内网开放**。

---

## 7. 换成公信证书（可选，推荐）

当前内网 CA 的代价是每台客户端都要装 CA + 设 `NODE_EXTRA_CA_CERTS`。换成 Let's Encrypt 证书后，客户端零配置。

集群里已装 cert-manager（`cert-manager.io/v1` 的 `Certificate`/`Issuer`/`ClusterIssuer` 均存在）。两条路：

**A. 用集群现有 ClusterIssuer 自动签发**（推荐，需要 DNS-01，因为域名指向私网 IP，HTTP-01 无法校验）

```bash
# 先确认可用的 ClusterIssuer 名称（由集群管理员提供，本命名空间 RBAC 无权列举）
kubectl --kubeconfig=<管理员 kubeconfig> get clusterissuer

# 然后在 ai-pj 里建 Certificate，产出 secret/tokenrank-le-cert
cat <<'YAML' | kubectl --kubeconfig=<kubeconfig> apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: tokenrank-le
  namespace: ai-pj
spec:
  secretName: tokenrank-le-cert
  dnsNames: ["tokenrank.oortcloudsmart.com"]
  issuerRef:
    name: <ClusterIssuer 名称>
    kind: ClusterIssuer
YAML
```

签发成功后把 Deployment 的 `volumes.tls.secretName` 从 `tokenrank-tls` 改成 `tokenrank-le-cert`，nginx 配置不变。**切换后客户端不再需要安装 CA。**

**B. 直接提供证书文件**：把 `fullchain.pem` / `privkey.pem` 交给运维，替换 Secret：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj create secret tls tokenrank-tls \
  --cert=fullchain.pem --key=privkey.pem --dry-run=client -o yaml | kubectl apply -f -
kubectl --kubeconfig=<kubeconfig> -n ai-pj rollout restart deploy/tokenrank
```

> 注意：换成公信证书后，原先通过 IP 直连（如 `https://192.168.88.118:30443`）访问会出现证书与主机名不匹配，客户端应统一改用域名。
