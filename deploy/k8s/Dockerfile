ARG BASE_IMAGE=hb.oortcloudsmart.com/base/node:24.19-alpine

FROM ${BASE_IMAGE} AS deps
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --omit=dev --registry=${NPM_REGISTRY}

# 客户端分发包：install.sh/ps1 从服务端 /dl/ 取包并校验 sha256，仓库里不入库
FROM ${BASE_IMAGE} AS dist
WORKDIR /build
COPY client/ ./client/
COPY server/public/ ./server/public/
# Windows 克隆会把 .sh 转成 CRLF，Linux 客户端执行会失败；构建期统一还原为 LF
RUN find ./client ./server/public -name '*.sh' -exec sed -i 's/\r$//' {} + \
 && sh client/scripts/pack-dist.sh

FROM ${BASE_IMAGE} AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    HOME=/data \
    APP_VERSION=${APP_VERSION}
WORKDIR /app
# server/src/sync-health.js 以 ../../client/package.json 取客户端版本，故保留仓库两级目录
COPY server/ ./server/
COPY client/package.json ./client/package.json
COPY deploy/k8s/init-db.mjs ./server/init-db.mjs
RUN rm -rf ./server/node_modules ./server/test ./server/wrangler.toml.example \
 && addgroup -g 10001 -S tokenrank \
 && adduser -u 10001 -S -G tokenrank -D -h /data tokenrank \
 && mkdir -p /data && chown -R 10001:10001 /app /data
COPY --from=deps /build/server/node_modules ./server/node_modules
# 用 dist 阶段已还原 LF 并打好包的 public 覆盖（含 dl/ 分发包与 releases/ 历史脚本）
COPY --from=dist /build/server/public ./server/public
USER 10001:10001
EXPOSE 8790
WORKDIR /app/server
ENTRYPOINT ["node", "/app/server/node-service.mjs"]
