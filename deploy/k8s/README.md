# TokenRank 上 K8s（单租户集群 · ai-pj）运行说明

代码来自独立拉取的 GitLab 副本（本目录即该副本），提交 `2d2ab97`。

## 1. 架构

```
客户端 ──HTTPS(外网 2443 → 控制器 NodePort 32259)──> Ingress(nginx, cert-manager 证书)
                                                        │
                                                        └──> Service(ClusterIP:80) ──> Node 单进程(8790)
                                                                                        └──> SQLite(PVC /data)
```

- **Ingress 承担 TLS 终止与域名证书**：注解 `cert-manager.io/cluster-issuer: dnspod-cert-manager-webhook-dnspod-cluster-issuer`，走 DNS-01 自动签发/续期，产物在 Secret `tokenrank-oortcloudsmart-tls`。
- **只有一个应用容器**：安装脚本与分发包（`/install.sh`、`/update.sh`、`/dl/*`、`/releases/*`、`/version.txt`）由 `server/node-service.mjs` 内置的静态白名单直接下发，不再需要 nginx sidecar。
- **没有 NodePort 服务、没有自签 CA**：客户端零配置（公信证书），不再需要导入 CA 或设置 `NODE_EXTRA_CA_CERTS`。
- 集群内到 pod 是明文（TLS 在 Ingress 终止），故 `TOKENRANK_HOST=0.0.0.0` + `TOKENRANK_ALLOW_INSECURE_HTTP=1`。

## 2. 构建与推送

```bash
SHA=$(git rev-parse --short=7 HEAD)
TAG=$SHA-b$(date +%m%d%H%M)          # 每次重建都要换 tag，原因见“坑”
docker build --provenance=false --sbom=false \
  -f deploy/k8s/Dockerfile --build-arg APP_VERSION=$SHA \
  -t hb.oortcloudsmart.com/ai/tokenrank:$TAG .
docker push hb.oortcloudsmart.com/ai/tokenrank:$TAG
```

构建期自动做的事：

- 客户端分发包：`client/scripts/pack-dist.sh` 产出 `server/public/dl/tokenrank-client-<版本>.tar.gz` + `.sha256`（仓库里不入库）。
- **CRLF 还原**：Windows 克隆的 `.sh` 是 CRLF，Linux 客户端执行会直接失败，构建期统一转 LF 后再打包/分发。
- 只装生产依赖（`wrangler` 等 devDependencies 不进镜像）。

**坑：不要复用镜像 tag。** `imagePullPolicy: IfNotPresent` 下改了 tag 内容也不会重拉，节点会继续用旧缓存（表现为镜像里缺文件、容器起不来）。换新 tag 后同步改 `manifests.yaml` 的 2 处 `image:`。

基础镜像：`hb.oortcloudsmart.com/base/node:24.19-alpine`（含 `node:sqlite`，已实测）。不要用 `base/nginx:1.29.8-alpine3.23-slim` 那类 arm64 tag。

## 3. 部署

```bash
kubectl --kubeconfig=<kubeconfig> apply -f deploy/k8s/manifests.yaml
kubectl --kubeconfig=<kubeconfig> -n ai-pj rollout status deploy/tokenrank
```

清单包含：PVC(5Gi) / ConfigMap / Deployment（initContainer 建库 + 应用容器）/ ClusterIP Service / Ingress / NetworkPolicy。

- **证书**：首次创建 Ingress 后 cert-manager 会自动建 Certificate → Order → Challenge(DNS-01)，一般 2~5 分钟拿到证书；续期自动。排查：`kubectl -n ai-pj get certificate,order,challenge`、`kubectl -n ai-pj describe challenge`。
- **DNS**：`tokenrank.oortcloudsmart.com` 的 A 记录必须存在（当前指向局域网节点，端口用 2443/32259）；DNS 记录缺失时 DNS-01 也可能因缓存返回 NXDOMAIN 而失败，届时删掉 Certificate 重新触发即可。
- **NetworkPolicy**：ai-pj 自带 `default-deny-all`，且既有放行策略的 ipBlock 排除了 pod 网段（172.20.0.0/16），所以必须保留清单里的 `tokenrank-allow-ingress-nginx`，否则 Ingress 转发到 pod 会一直超时（表现为 TLS 握手成功但无响应）。
- **出网**：`allow-egress-core` 只放行 DNS 与 apiserver；清单里的 `tokenrank-allow-egress-feishu` 为本应用放行公网 443（飞书长连接与开放平台 API，排除 pod 网段）。

## 3.1 启用飞书机器人（方案 A）

机器人（长连接收事件 + 卡片）随应用容器运行，需一次性注入凭证：

```bash
# 1) 创建 Secret（值不入 git；app-id 为 cli_ 开头的应用 ID）
kubectl --kubeconfig=<kubeconfig> -n ai-pj create secret generic tokenrank-feishu   --from-literal=app-id=cli_aa6be61fddf85cf3   --from-literal=app-secret=<App Secret>

# 2) 应用清单（Deployment 已引用 Secret；NetworkPolicy 已放行出网 443）
kubectl --kubeconfig=<kubeconfig> apply -f deploy/k8s/manifests.yaml
kubectl --kubeconfig=<kubeconfig> -n ai-pj rollout status deploy/tokenrank

# 3) 验证：pod 日志出现「飞书长连接已启动」与 ws client ready；
#    飞书单聊机器人发「帮助」应回卡片（长连接由 pod 主动连出，无需公网回调）
kubectl --kubeconfig=<kubeconfig> -n ai-pj logs deploy/tokenrank --tail=20
```

注意：同一飞书应用只允许一处长连接实例。集群启用后，请停掉本地开发实例（否则消息事件会在两处之间随机分流）。

## 4. 运行时形态

- 数据：SQLite `/data/tokenrank.db`（PVC `tokenrank-data` 5Gi，默认 SC `nfs-storage`）。
- 建库：`init-db.mjs`，空库执行 `schema.sql` 并把当前 20 个迁移标记为已应用；旧库只补未应用的迁移。
- 非 root：uid/gid 10001 + `fsGroup: 10001`，`capabilities: drop ALL`，禁止提权。
- 副本数固定 1 + `Recreate`：SQLite 不支持多写。
- 探针：`/healthz` httpGet（app 监听 0.0.0.0，探针可达）。

## 5. 已验证 / 未验证

已验证：

- 集群可拉 Harbor 镜像；单容器 Pod 就绪；`/healthz` 200。
- Ingress + Let's Encrypt 证书（`Ready=True`，签发者 Let's Encrypt YR2），严格校验（无 `-k`）下 `/install.sh`、`/install.ps1`、`/update.sh`、`/update.ps1`、`/version.txt`、`/dl/*.tar.gz`(+sha256)、`/releases/0.2.16/install.sh` 全部 200，未知路径 404。
- 静态白名单防穿越：`/dl/..`、`/dl/%2e%2e%2fconfig.json`、`/diagnose-update.mjs` 均 404。
- 真实客户端端到端（干净容器、**未装任何 CA**）：下载分发包 → sha256 校验 → `connect` → 上报 `accepted:1`（1 天 4100 tokens）→ 重复 `rank push` `accepted:0`；服务端 `daily_totals` 与夹具一致。
- NFS PVC 上 SQLite WAL：3000 行增删改 + checkpoint + `integrity_check=ok`；删 Pod 重建数据保留。

未验证 / 需注意：

- **Windows 真机安装链路**未实测（`install.ps1`）。
- token-watcher 首次采集（依赖真实登录态数据）未跑。
- 飞书长连接：清单已含出网放行与 Secret 引用，按 §3.1 创建 Secret 后即启用（此前未在集群内实测）。
- 外网端口 2443 → 控制器 NodePort 32259 的映射由网关维护，仓库里不体现。

## 6. 升级

```bash
git pull
SHA=$(git rev-parse --short=7 HEAD); TAG=$SHA-b$(date +%m%d%H%M)
# 构建推送新 tag，然后：
sed -i "s/ai\/tokenrank:[0-9a-z-]*/ai\/tokenrank:$TAG/g" deploy/k8s/manifests.yaml
kubectl --kubeconfig=<kubeconfig> apply -f deploy/k8s/manifests.yaml
```

客户端分发包版本变了（`client/package.json`）时，`/dl` 随镜像更新；`install.sh` 里写死的 `VERSION` 与 `releases/` 目录也要随仓库更新。

客户端对接见 [CLIENT-CONNECT.md](CLIENT-CONNECT.md)。
