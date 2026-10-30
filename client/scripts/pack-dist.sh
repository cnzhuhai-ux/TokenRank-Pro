#!/bin/sh
# Ship only the independent adapter, excluding legacy scanner and writable Store.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DL="$ROOT/../server/public/dl"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$DL" "$TMP/bin"
cp "$ROOT/bin/tokenrank.js" "$ROOT/bin/tokenwatcher.js" "$TMP/bin/"
cp -R "$ROOT/sync" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/LICENSE" "$TMP/"
COPYFILE_DISABLE=1 tar -czf "$DL/tokenrank-client.tar.gz" -C "$TMP" .
node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$ROOT/package.json" > "$DL/version.txt"
VERSION=$(cat "$DL/version.txt")
cp "$DL/tokenrank-client.tar.gz" "$DL/tokenrank-client-$VERSION.tar.gz"
node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex")+"\n")' "$DL/tokenrank-client-$VERSION.tar.gz" > "$DL/tokenrank-client-$VERSION.tar.gz.sha256"
mkdir -p "$ROOT/../server/public/releases/$VERSION"
cp "$ROOT/../server/public/install.sh" "$ROOT/../server/public/install.ps1" "$ROOT/../server/public/update.sh" "$ROOT/../server/public/update.ps1" "$ROOT/../server/public/releases/$VERSION/"
# Mirror the official Windows zstd for dsh sessions; the client pins the same SHA-256 (sync/zstd-check.js).
# Alpine 构建镜像里没有 curl/shasum/unzip，按可用工具回退；分发包已缓存时只做校验，不联网。
check_sha256() { # <expected> <file>
  if command -v shasum >/dev/null 2>&1; then echo "$1  $2" | shasum -a 256 -c - >/dev/null
  elif command -v sha256sum >/dev/null 2>&1; then echo "$1  $2" | sha256sum -c - >/dev/null
  else node -e 'const c=require("crypto"),f=require("fs"),p=process.argv[1],e=process.argv[2];const h=c.createHash("sha256").update(f.readFileSync(p)).digest("hex");if(h!==e){console.error("sha256 mismatch: "+p);process.exit(1)}' "$2" "$1"; fi
}
fetch() { # <url> <dest>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else echo "缺少 curl 或 wget，无法下载 $1；请先放入 server/public/dl/ 后重试" >&2; exit 1; fi
}
ZSTD_ZIP_SHA=acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9
ZSTD_EXE_SHA=8076aae03feac7c66b319579e82172eed168deed2a3f25e5e2d3c60f55e84111
ZSTD_EXE="$DL/zstd-1.5.7-win64.exe"
if [ ! -f "$ZSTD_EXE" ]; then
  fetch https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-v1.5.7-win64.zip "$TMP/zstd.zip"
  check_sha256 "$ZSTD_ZIP_SHA" "$TMP/zstd.zip"
  if command -v unzip >/dev/null 2>&1; then unzip -p "$TMP/zstd.zip" zstd-v1.5.7-win64/zstd.exe > "$ZSTD_EXE"
  elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xOf "$TMP/zstd.zip" zstd-v1.5.7-win64/zstd.exe > "$ZSTD_EXE"
  else echo "缺少 unzip 或 bsdtar，无法从 zstd.zip 取 zstd.exe" >&2; exit 1; fi
fi
check_sha256 "$ZSTD_EXE_SHA" "$ZSTD_EXE"
[ -f "$DL/zstd-LICENSE.txt" ] || fetch https://raw.githubusercontent.com/facebook/zstd/v1.5.7/LICENSE "$DL/zstd-LICENSE.txt"
echo "已打包独立同步器：$DL/tokenrank-client.tar.gz"
