#!/bin/sh
# Explicit maintenance for an already connected computer. No account token in this command.
set -eu
SERVER="${1:-}"
[ -n "$SERVER" ] || { echo '用法：curl -fsSL <服务器>/update.sh | sh -s <服务器>'; exit 1; }
VERSION=0.2.22
command -v node >/dev/null 2>&1 || { echo '请先安装 Node.js 22.13+'; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13))process.exit(1)' || { echo '需要 Node.js 22.13+'; exit 1; }
node -e 'const u=new URL(process.argv[1]); if(u.protocol!=="https:"&&!(["localhost","127.0.0.1","[::1]"].includes(u.hostname)&&u.protocol==="http:"))process.exit(1); if(u.username||u.password||u.search||u.hash)process.exit(1)' "$SERVER" || { echo '服务器地址无效：需使用 HTTPS'; exit 1; }
[ -f "$HOME/.tokenrank/config.json" ] || { echo '尚未接入，请先执行小程序里的接入命令'; exit 1; }
[ ! -L "$HOME/.tokenrank" ] || { echo '同步器目录不能是符号链接'; exit 1; }
TMP=$(mktemp -d "$HOME/.tokenrank/update.XXXXXX")
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir "$TMP/stage"
BASE="${SERVER%/}"
PKG="tokenrank-client-$VERSION.tar.gz"
echo '下载更新工具，校验完整性与版本…'
curl --connect-timeout 20 --max-time 180 -fsSL "$BASE/dl/$PKG" -o "$TMP/app.tar.gz"
curl --connect-timeout 20 --max-time 60 -fsSL "$BASE/dl/$PKG.sha256" -o "$TMP/app.sha256"
EXPECTED=$(tr -d ' \t\r\n' < "$TMP/app.sha256")
ACTUAL=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TMP/app.tar.gz")
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo '安装包校验失败，已停止更新'; exit 1; }
tar -xzf "$TMP/app.tar.gz" -C "$TMP/stage"
node -e 'const p=require(process.argv[1]); if(p.name!=="tokenrank-client"||p.version!==process.argv[2])process.exit(1)' "$TMP/stage/package.json" "$VERSION" || { echo '下载内容不是预期版本，已停止更新'; exit 1; }
node --no-warnings "$TMP/stage/bin/tokenrank.js" update-and-resync
