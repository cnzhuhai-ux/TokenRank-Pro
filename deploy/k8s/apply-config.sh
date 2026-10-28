#!/bin/sh
# 生成/更新 nginx ConfigMap 与 TLS Secret，并应用部署清单。
# 用法：K=<kubectl 路径> KC=<kubeconfig 路径> sh deploy/k8s/apply-config.sh [证书目录]
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
K=${K:?请设置 K 为 kubectl 路径}
KC=${KC:?请设置 KC 为 kubeconfig 路径}
CERTS=${1:-$DIR/certs}

if [ ! -f "$CERTS/tls.crt" ] || [ ! -f "$CERTS/tls.key" ]; then
  echo "缺少 $CERTS/tls.crt 与 tls.key，请先执行：sh $DIR/gen-certs.sh $CERTS" >&2
  exit 1
fi

"$K" --kubeconfig="$KC" -n ai-pj create configmap tokenrank-nginx-conf \
  --from-file=nginx.conf="$DIR/nginx.conf" \
  --from-file=server-common.conf="$DIR/nginx-server-common.conf" \
  --dry-run=client -o yaml | "$K" --kubeconfig="$KC" apply -f -

"$K" --kubeconfig="$KC" -n ai-pj create secret tls tokenrank-tls \
  --cert="$CERTS/tls.crt" --key="$CERTS/tls.key" \
  --dry-run=client -o yaml | "$K" --kubeconfig="$KC" apply -f -

"$K" --kubeconfig="$KC" apply -f "$DIR/manifests.yaml"
