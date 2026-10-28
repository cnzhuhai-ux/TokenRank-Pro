# TokenRank 上 K8s（ai-pj 命名空间）运行说明

代码来自独立拉取的 GitLab 副本（本目录即该副本），提交 `61713ec`（main，含安全加固）。

## 1. 架构

```
客户端 ──HTTPS(30443)──> [pod] nginx(8443) ──┐
                              │  静态: /install.sh /update.sh /dl/* /releases/*
                              └─proxy──> Node 服务(127.0.0.1:8790) ──> SQLite(PVC /data)
```

- Node 只监听回环（`TOKENRANK_HOST=127.0.0.1`），明文不出 pod；TLS 由 nginx 终止。
- nginx 同时承担安装脚本/分发包的静态下载——Node 服务本身没有静态路由，这是上游文档要求的「前置反代」。
- initContainer：`init-db` 建库/补迁移，`fill-webroot` 把镜像内的安装脚本与 `/dl` 分发包铺到共享空目录。

## 2. 构建与推送

```bash
SHA=$(git rev-parse --short=7 HEAD)
TAG=$SHA-$(date +%m%d%H%M)          # 每次重建都要换 tag，原因见下方“坑”
docker build --provenance=false --sbom=false \
  -f deploy/k8s/Dockerfile --build-arg APP_VERSION=$SHA \
  -t hb.oortcloudsmart.com/ai/tokenrank:$TAG .
docker push hb.oortcloudsmart.com/ai/tokenrank:$TAG
```

构建期自动做的事：

- 客户端分发包：`client/scripts/pack-dist.sh` 产出 `server/public/dl/tokenrank-client-<版本>.tar.gz` + `.sha256`（仓库里不入库）。
- **CRLF 还原**：Windows 克隆的 `.sh` 是 CRLF，Linux 客户端执行会直接失败，构建期统一转 LF 后再打包/分发。
- 只装生产依赖（`wrangler` 等 devDependencies 不进镜像）。

**坑：不要复用镜像 tag。** `imagePullPolicy: IfNotPresent` 下改了 tag 内容也不会重拉，节点会继续用旧缓存（表现为镜像里缺文件、容器起不来）。换新 tag 后同步改 `manifests.yaml` 的 3 处 `image:`。

基础镜像：`hb.oortcloudsmart.com/base/node:24.19-alpine`（含 `node:sqlite`，已实测）、`hb.oortcloudsmart.com/base/nginx:1.23.4-alpine`（**amd64**；同项目里的 `1.29.8-alpine3.23-slim` 是 arm64，用了会 `exec format error`）。

## 3. 证书与部署

```bash
# 首次：生成内网 CA + 服务端证书（SAN 需含对外域名与客户端可能直连的节点 IP）
sh deploy/k8s/gen-certs.sh /path/to/tokenrank-certs 192.168.50.13,192.168.50.11,192.168.50.15 tokenrank.oortcloudsmart.com

# 换证（不换 CA）：目录里已有 ca.crt/ca.key 时只重签服务端证书，客户端无需重新装 CA
sh deploy/k8s/gen-certs.sh /path/to/tokenrank-certs 192.168.50.13,192.168.50.11,192.168.50.15 tokenrank.oortcloudsmart.com

# 生成/更新 nginx ConfigMap + TLS Secret，并应用清单
K=<kubectl 路径> KC='<kubeconfig 路径>' sh deploy/k8s/apply-config.sh /path/to/tokenrank-certs

kubectl --kubeconfig=<kubeconfig> -n ai-pj rollout status deploy/tokenrank
```

- 对外入口：`https://tokenrank.oortcloudsmart.com:30443`。域名解析到 `192.168.50.15`，Pod 实际跑在 `192.168.50.13`；NodePort 在集群任意节点都可接入，换节点不用改客户端。
- `ca.crt` 分发给客户端使用；`ca.key` 仅管理员持有，不要入仓、不要外发。
- 证书 825 天到期；只换服务端证书时沿用同一 CA，客户端无需重装。
- **改成公信证书（推荐，客户端免装 CA）**：集群已有 cert-manager，用 DNS-01 的 ClusterIssuer 签发 `Certificate`，或直接替换 `tokenrank-tls` Secret，步骤见 [CLIENT-CONNECT.md](CLIENT-CONNECT.md) 第 7 节。
- 飞书凭证需要时建 Secret，在 ConfigMap 位置改 `valueFrom.secretKeyRef`，不要写进清单。

## 4. 运行时形态

- 数据：SQLite `/data/tokenrank.db`（PVC `tokenrank-data` 5Gi，默认 `nfs-storage`）。
- 建库：`init-db.mjs`，空库执行 `schema.sql` 并把当前 20 个迁移标记为已应用（schema 已含其结果，重复 ALTER 会因列已存在失败）；旧库只补未应用的迁移。
- 非 root：app 容器 uid/gid 10001 + `fsGroup: 10001`；nginx 容器 uid/gid 101；均 `capabilities: drop ALL`。
- 副本数固定 1 + `Recreate`：SQLite 不支持多写。
- 探针：app 用 exec 自检（`fetch 127.0.0.1:8790/healthz`，因为 kubelet 从 pod IP 连不到回环）；web 用 httpGet 8080。
- Service：`http 8790→8080(NodePort 32748)` 仅排障用，`https 443→8443(NodePort 30443)` 是对外入口，客户端统一用 `https://tokenrank.oortcloudsmart.com:30443`。

## 5. 已验证 / 未验证

已验证：

- 集群可拉 Harbor 镜像；pod 2/2 就绪；`/healthz` 200。
- HTTPS（域名 + CA 校验 + 主机名校验）下 `/install.sh`、`/update.sh`、`/version.txt`、`/dl/*.tar.gz`(+sha256) 全部 200，脚本为 LF。
- 真实客户端端到端（Linux 容器内，走域名）：下载分发包 → sha256 校验 → `connect` → 上报 `accepted:1`（1 天 4100 tokens）→ 重复 `rank push` `accepted:0`；服务端 `daily_totals` 数值与夹具一致。
- NFS PVC 上 SQLite WAL：3000 行增删改 + checkpoint + `integrity_check=ok`；删 Pod 重建数据保留。

未验证 / 需注意：

- **Windows 真机安装链路**未实测（`install.ps1` + PowerShell 信任库 + `NODE_EXTRA_CA_CERTS` 组合）。
- token-watcher 首次采集（依赖真实登录态数据）未跑。
- 集群内 pod 出网（飞书长连接、厂商接口）未测。
- 当前用内网 CA，客户端需装 CA；换成公信证书后该步骤可省（见第 3 节）。

## 6. 升级

```bash
git pull
SHA=$(git rev-parse --short=7 HEAD); TAG=$SHA-$(date +%m%d%H%M)
# 构建推送新 tag，然后：
sed -i "s/ai\/tokenrank:[0-9a-z-]*/ai\/tokenrank:$TAG/g" deploy/k8s/manifests.yaml
kubectl --kubeconfig=<kubeconfig> apply -f deploy/k8s/manifests.yaml
```

新镜像里若多了 `migrations/*.sql`，initContainer 会自动补齐。客户端分发包版本变了（`client/package.json`）时，`/dl` 会随镜像更新，但 `install.sh` 里写死的 `VERSION` 与 `releases/` 目录也要随仓库更新。

客户端对接见 [CLIENT-CONNECT.md](CLIENT-CONNECT.md)。
