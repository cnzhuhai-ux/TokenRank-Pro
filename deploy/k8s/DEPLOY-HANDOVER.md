# TokenRank K8s 协作部署手册（交接文档）

> 面向接手协作开发的同事。目标：拿到仓库与 kubeconfig 后，能独立完成「拉代码 → 构建镜像 → 部署 → 验证」全流程。
> 深入细节见 [README.md](README.md)（运行形态与原理）、[CLIENT-CONNECT.md](CLIENT-CONNECT.md)（客户端接入）、[LOCAL-MIGRATION.md](LOCAL-MIGRATION.md)（本地实例下线/迁移）。
> 文中「当前状态」以 2026-11-02 为准，会随后续部署漂移；以集群实际运行为准。

## 1. 地址与访问入口

| 项 | 值 |
|---|---|
| 服务地址（外网） | `https://tokenrank.oortcloudsmart.com:2443`（公网证书，客户端零配置） |
| 网页版界面 | `https://tokenrank.oortcloudsmart.com:2443/app`（飞书机器人卡片「打开网页版完整界面」同源） |
| 健康检查 | `https://tokenrank.oortcloudsmart.com:2443/healthz` → `{"ok":true,...}` |
| 客户端分发 | `/install.sh` `/install.ps1` `/update.*` `/version.txt` `/dl/*` `/releases/*`（服务端静态白名单直发） |
| 代码仓库（GitLab） | `http://192.168.88.125/zhangxuelian/tokenrank.git`（默认分支 `main`） |
| 镜像仓库（Harbor） | `hb.oortcloudsmart.com`（**必须用域名**，IP 访问会证书失败），项目/仓库 `ai/tokenrank` |
| K8s 集群 | 单租户生产集群，API `https://192.168.88.112:6443`（内网），工作命名空间 `ai-pj` |

请求链路：`客户端 ──443/2443──> 公网网关(2443→NodePort 32259) ──> ingress-nginx ──TLS 终止──> Service(tokenrank:80) ──> Pod 8790`
证书由 cert-manager 以 DNS-01 自动签发续期（ClusterIssuer `dnspod-cert-manager-webhook-dnspod-cluster-issuer`）。公网端口映射由网关维护，不在仓库内。

## 2. K8s RBAC 与 kubeconfig

- kubeconfig 文件：`single-prod-ai-pj.conf`（团队内部传递，**严禁提交进仓库**——内含凭证）。
- 获取方式：向集群管理员索取「单租户生产集群 ai-pj 命名空间管理员」的 ServiceAccount kubeconfig。
- 权限范围：`ai-pj` 内全部资源（Deployment/Service/Ingress/NetworkPolicy/PVC/ConfigMap/Secret）+ pod 日志/exec/cp/rollout；**无集群级权限**（看不到 Node 列表，需要节点 IP 时看 pod 的 `status.hostIP`）。
- 所有 kubectl 命令统一带 `--kubeconfig=<kubeconfig路径> -n ai-pj`。快速自检：

```bash
kubectl --kubeconfig=<kubeconfig> -n ai-pj get pods
kubectl --kubeconfig=<kubeconfig> -n ai-pj get deploy tokenrank -o jsonpath='{.spec.template.spec.containers[0].image}'
```

## 3. 工作目录约定

- 每人 clone 自己的独立目录工作，**不要共用同一目录**（历史上有并行会话共目录导致互相覆盖）。本仓库现役副本：`AI-DEPLOY/tokenrank-k8s`（旧的 `tokenrank/`、`tr-wt-credits/` 克隆已于 2026-11-02 清理，内容全在 origin/main，无损失）。
- 部署提交模式：改完 manifests 镜像 tag 后单独提交，信息格式 `deploy: image <tag> (<一句话变更>)`，随功能提交一起 push 到 `main`。
- GitHub 开源镜像（github.com/xmasdong/tokenrank）由仓库所有者另行同步，GitLab `main` 为协作事实源。

## 4. Harbor 登录

```bash
docker login hb.oortcloudsmart.com   # 凭证向管理员索取；登录一次长期有效
```

基础镜像 `hb.oortcloudsmart.com/base/node:24.19-alpine`（含 `node:sqlite`，已实测）。不要用 `base/nginx:1.29.8-…` 等 arm64 tag（`exec format error`）。

## 5. 标准发布流程（每次更新照此执行）

```bash
# 0) 前置：同步代码、确认工具可用
git pull --ff-only origin main
kubectl --kubeconfig=<kubeconfig> -n ai-pj get pods          # kubectl 连通
docker version --format '{{.Server.Version}}'                # docker 可用

# 1) 构建镜像（tag 规范：<git短sha>-b<序号/时间戳>，绝不复用旧 tag）
SHA=$(git rev-parse --short=7 HEAD)
TAG=$SHA-b$(date +%m%d%H%M)
docker build --provenance=false -f deploy/k8s/Dockerfile \
  --build-arg APP_VERSION=$SHA -t hb.oortcloudsmart.com/ai/tokenrank:$TAG .

# 2) 推送 Harbor
docker push hb.oortcloudsmart.com/ai/tokenrank:$TAG

# 3) 改 manifests（两处 image:，init-db 与主容器）
sed -i "s|ai/tokenrank:[0-9a-z.-]*|ai/tokenrank:$TAG|g" deploy/k8s/manifests.yaml

# 4) 部署并等待滚动完成（单副本 Recreate：旧 Pod 先停再起新 Pod，约几十秒）
kubectl --kubeconfig=<kubeconfig> -n ai-pj apply -f deploy/k8s/manifests.yaml
kubectl --kubeconfig=<kubeconfig> -n ai-pj rollout status deploy/tokenrank --timeout=180s

# 5) 验证（见 §6），全部通过后：

# 6) 提交推送
git add deploy/k8s/manifests.yaml
git commit -m "deploy: image $TAG (<变更一句话>)"
git push origin main
```

**离线构建注意（国内网络）**：构建期 `pack-dist.sh` 需要官方 zstd，GitHub 直连不通时先准备缓存文件（存在则只校验不联网）：
`zstd-1.5.7-win64.exe`（sha256 `8076aae0…`，zip `acb4e811…`，见脚本内固定值）与 `zstd-LICENSE.txt` 放到 `server/public/dl/`。可从任一旧镜像取：
`docker run --rm --entrypoint sh <旧镜像> -c 'cat /app/server/public/dl/zstd-1.5.7-win64.exe' > server/public/dl/zstd-1.5.7-win64.exe`（取完校验 sha）。

## 6. 部署后验证清单

| 检查 | 命令/方法 | 期望 |
|---|---|---|
| 建库/迁移 | `kubectl … logs <pod> -c init-db` | 「已由 schema.sql 创建…」或「已存在，补齐 N 个迁移」；报错则部署失败 |
| 应用启动 | `kubectl … logs <pod>` | `http://0.0.0.0:8790`、（若启用机器人）「飞书长连接已启动」+ `ws client ready` |
| 健康检查 | `curl -sk https://tokenrank.oortcloudsmart.com:2443/healthz` | 200 `{"ok":true}` |
| 版本/分发包 | `curl -sk …:2443/version.txt`；`/dl/tokenrank-client-<ver>.tar.gz` | 与 `client/package.json` 一致；200 |
| 网页版 | `curl -skL -o /dev/null -w '%{http_code}' …:2443/app` | 200（`/app` 301 → `/app/`） |
| 榜单 API | `curl -sk '…:2443/api/leaderboard?metric=tokens&period=day'` | 正常 JSON；`metric=credits` 为积分榜 |
| Trae 扩展分发 | `…/dl/trae-extension/latest.json` | 200，版本与 `client/trae-extension/package.json` 一致 |

改了网页前端（`server/public/app/`）时，额外确认线上 `/app/app.js` 的 sha256 与仓库文件一致，防止节点缓存旧镜像。

## 7. 服务形态要点（详见 README §4-5）

- 单副本 + `Recreate`：SQLite 不支持多写，**不要改副本数/滚动策略**。
- 数据：PVC `tokenrank-data`(5Gi, NFS) 上的 `/data/tokenrank.db`；`init-db.mjs` 空库执行 `schema.sql` 并标记迁移已应用，旧库只补未应用的迁移（新增迁移放 `server/migrations/`，编号递增）。
- 非 root（uid 10001）+ 只读加固；探针 `/healthz`。
- ai-pj 有 `default-deny-all`：放行策略在 manifests 里（`tokenrank-allow-ingress-nginx` 是 Ingress→Pod 必需，`tokenrank-allow-egress-feishu` 是机器人出网 443 必需），**不要删**。

## 8. 飞书机器人

- 凭证：Secret `tokenrank-feishu`（keys：`app-id`、`app-secret`），值不入 git；创建/轮换步骤见 README §3.1。
- 同一飞书应用**只允许一处长连接**：确认集群内已启用后，任何人本地起的开发实例必须停掉，否则消息在两处随机分流（表现：时而收不到消息）。

## 9. 已知坑速查

| 症状 | 原因与处置 |
|---|---|
| 换了代码但行为没变/镜像缺文件 | 复用了旧 tag，节点 `IfNotPresent` 用缓存。**每次构建用新 tag**，并同步改 manifests 两处 `image:` |
| 构建在 pack-dist 下载 zstd 处失败 | GitHub 直连被墙，按 §5 离线缓存 zstd 后重建 |
| Windows 下 docker 命令路径报错 | Git Bash 路径转换问题：docker 命令前加 `MSYS_NO_PATHCONV=1`（kubectl 用 Windows 路径，不要加） |
| `kubectl cp` 报 "must be a local file specification" | 同上，加 `MSYS_NO_PATHCONV=1` 且本地路径用相对路径 |
| TLS 握手成功但请求超时 | `tokenrank-allow-ingress-nginx` NetworkPolicy 丢失/被改 |
| 证书签发 NXDOMAIN | 域名 A 记录被删；恢复 DNS 后删 Certificate 重新触发（README §3） |
| 飞书时收到时收不到消息 | 两处长连接竞争：停掉集群外的本地实例 |
| 构建出的客户端 .sh 在 Linux 报 `\r` | 不应出现：Dockerfile 构建期已统一 LF；若自建打包链路需自行处理 |
| 回滚 | 把 manifests `image:` 改回上一个仍存在于 Harbor 的 tag，重新 `apply` + `rollout status` |

## 10. 本地测试（部署前建议）

```bash
# 客户端套件（Windows 下有 ~45 个已知环境性失败：EPERM symlink / getuid / 缺兄弟仓；
# 权威验证建议在 Linux 容器跑，与生产同环境）：
docker run --rm -v <仓库路径>:/repo -w /repo/client hb.oortcloudsmart.com/base/node:24.19-alpine \
  node --test "test-sync/*.test.mjs"
# 服务端：
cd server && npm test
```
