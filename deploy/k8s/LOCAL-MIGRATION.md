# 本机实例下线与迁移指南（给跑过本地部署的同事）

> 背景：TokenRank 已统一收敛到集群入口 `https://tokenrank.oortcloudsmart.com:2443`（Ingress + Let's Encrypt 证书，公网网关 113.98.254.150:2443 → 集群）。**飞书长连接已在集群内运行**（应用 `cli_aa6be61fddf85cf3`）。
>
> 关键约束：**同一飞书应用只允许一处长连接实例**。本地（Administrator 机器）的 tokenrank-server 实例必须下线，否则消息事件会在本地与集群之间随机分流，表现为机器人时灵时不灵。

本机部署涉及的内容：

| 本机路径 | 内容 | 处置 |
|---|---|---|
| `C:\Users\Administrator\.tokenrank-server\config.json` | 本地服务配置（端口/飞书凭证/public_origin） | 随服务下线，不再需要 |
| `C:\Users\Administrator\.tokenrank-server\tokenrank.db` | **本地机器人库（含 46 天历史）** | 保留，迁移验证完成前不要删 |
| `~\.tokenmeter\tokenmeter.db` | token-watcher 统计库（客户端只读数据源） | 保留，改接集群后继续用 |
| `~\.tokenrank\` | 独立同步器配置 | 会被 `connect` 覆写为集群地址 |

## 迁移步骤（顺序不可调换）

### 第 1 步（对方）：重置飞书 App Secret

1. 打开 [飞书开放平台](https://open.feishu.cn/) → 开发者后台 → 应用 `cli_aa6be61fddf85cf3` → 「凭证与基础信息」→ **重置 App Secret**。
2. 新 Secret **不要**发到群聊或任何公开链接（上一版 Secret 已因此泄露过一次）。通过私下渠道交给运维。

> 重置后旧 Secret 立即失效 → **本地实例的长连接会自动断开**（这就是「下线本地」的第一刀，天然避免双实例分流窗口）。本地服务进程会开始报连接失败，属预期现象。

### 第 2 步（运维）：把新 Secret 更新到集群

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj create secret generic tokenrank-feishu \
  --from-literal=app-id=cli_aa6be61fddf85cf3 --from-literal=app-secret=<新App Secret> \
  --dry-run=client -o yaml | kubectl --kubeconfig=<kubeconfig> apply -f -

kubectl --kubeconfig=<kubeconfig> -n ai-pj rollout restart deploy/tokenrank
kubectl --kubeconfig=<kubeconfig> -n ai-pj logs deploy/tokenrank --tail=20
```

验收：日志出现 `飞书长连接已启动 app=cli_aa6be61fddf85cf3` 与 `[ws] ws client ready`。

### 第 3 步（对方）：本地服务善后（PowerShell）

```powershell
# 1) 确认 8790 监听已无流量；找到本地服务进程
netstat -ano | findstr ":8790"

# 2) 停止本地服务进程（用上一步的 PID，不要按进程名全杀 node）
taskkill /PID <PID> /F

# 3) 检查自启项（计划任务 / 启动文件夹），有则移除，避免重启后本地实例又抢长连接
```

- 本地 `tokenrank.db` **保留**：它是 46 天历史的唯一副本，等第 5 步确认服务端能查到这些历史后再归档。

### 第 4 步（对方）：本机同步客户端改接集群

接入码二选一：

- **飞书私聊机器人**：给机器人发「帮助」，按卡片指引绑定账号，机器人会下发/复用你的 32 位接入码（推荐，无需找运维）；
- 运维手工签发：见 [CLIENT-CONNECT.md](CLIENT-CONNECT.md) §1.1。

改接集群（保留原有 token-watcher 采集器与统计库，安装脚本会自动复用、不重装不丢数据）：

```powershell
# 全新安装 / 覆盖安装（推荐）
& ([scriptblock]::Create((irm 'https://tokenrank.oortcloudsmart.com:2443/install.ps1'))) 'https://tokenrank.oortcloudsmart.com:2443' '<接入码>'

# 或已安装过、只改接入地址
tokenrank connect https://tokenrank.oortcloudsmart.com:2443 <接入码>
```

首次同步把本机 46 天历史全量上传：

```powershell
tokenrank rank push --full     # 分批上传，几百 KB 量级，几分钟内完成
tokenrank rank status          # connected=true、server=...2443、last_error=null
```

后台自启服务（install-agent）注册的同步任务不受影响；它读取的仍是本机 token-watcher 库，之后每日增量自动上报。

### 第 5 步：双方验收

| 检查项 | 方式 | 期望 |
|---|---|---|
| 入口连通 | 浏览器/curl `https://tokenrank.oortcloudsmart.com:2443/healthz` | `{"ok":true,...}` |
| 机器人 | 飞书私聊发「帮助」 | 回接入卡片；卡片里「网页版完整界面」可打开 `/app/` |
| 群榜/我的 | 飞书机器人菜单或 `/app/` | 能看到本机上传的用量与历史 |
| 云端数据 | 运维查 `daily_totals`（命令见 [CLIENT-CONNECT.md](CLIENT-CONNECT.md) §3） | 出现本机 46 天历史日桶 |
| 本地无残留 | `netstat -ano | findstr ":8790"` | 无监听 |

## 回退方案（仅限集群机器人异常时）

集群侧先停长连接（避免双实例），再恢复本地：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj scale deploy/tokenrank --replicas=0
```

本地按原方式启动 node-service（配置里 public_origin 用 `https://tokenrank.oortcloudsmart.com:2443` 不变）。恢复集群时 `--replicas=1` 并确认本地已停。
