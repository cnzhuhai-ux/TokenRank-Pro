#!/bin/sh
# 生成本机内网用的自签 CA 与服务端证书（SAN 含节点 IP 与对外域名）。CA 私钥不入库、不外发。
# 用法：sh gen-certs.sh <输出目录> [节点IP] [DNS名]
#   目录里已有 ca.crt/ca.key 时复用该 CA，只重签服务端证书（客户端无需重新装 CA）。
set -eu
OUT=${1:?用法: sh gen-certs.sh <输出目录> [节点IP] [DNS名]}
NODE_IPS=${2:-192.168.50.13,192.168.50.11}
DNSNAMES=${3:-tokenrank.oortcloudsmart.com}
DAYS_CA=${DAYS_CA:-3650}
DAYS_SRV=${DAYS_SRV:-825}

mkdir -p "$OUT"
cd "$OUT"

if [ ! -f ca.crt ] || [ ! -f ca.key ]; then
  cat > ca.cnf <<'EOF'
[ req ]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[ dn ]
C = CN
O = TokenRank Internal CA
CN = TokenRank Internal CA
[ v3_ca ]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS_CA" \
    -keyout ca.key -out ca.crt -config ca.cnf
  echo "新建 CA：$OUT/ca.crt"
else
  echo "复用已有 CA：$OUT/ca.crt"
fi

{
  cat <<'EOF'
[ req ]
distinguished_name = dn
req_extensions = v3_req
prompt = no
[ dn ]
C = CN
O = TokenRank
CN = tokenrank.oortcloudsmart.com
[ v3_req ]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[ alt ]
IP.1 = 127.0.0.1
EOF
  i=2
  for ip in $(echo "$NODE_IPS" | tr ',' ' '); do
    echo "IP.$i = $ip"
    i=$((i + 1))
  done
  d=1
  for name in $(echo "$DNSNAMES" | tr ',' ' '); do
    echo "DNS.$d = $name"
    d=$((d + 1))
  done
  echo "DNS.$d = tokenrank.internal"
  echo "DNS.$((d + 1)) = tokenrank.ai-pj.svc.cluster.local"
} > srv.cnf

openssl req -newkey rsa:2048 -nodes -keyout tls.key -out tls.csr -config srv.cnf

openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days "$DAYS_SRV" -sha256 -extfile srv.cnf -extensions v3_req -out tls.crt

rm -f tls.csr ca.srl
openssl x509 -in tls.crt -noout -text | grep -A1 "Subject Alternative Name"
echo "已生成：$OUT/{ca.crt,tls.crt,tls.key}（服务端证书 $DAYS_SRV 天到期）"
