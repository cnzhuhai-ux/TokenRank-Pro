#!/bin/sh
# Trae 采集扩展一键安装（macOS / Linux）：
#   curl -fsSL <BASE>/install-trae.sh | sh -s <BASE> [latest|x.y.z]
# 从本服务下载 VSIX（sha256 校验）后用 Trae CN CLI 安装；无 CLI 时降级解压到扩展目录。
# Linux 未在真机验证过，建议优先用 CLI 安装；解压降级不写 extensions.json，重启 Trae 后生效。
set -eu

SERVER="${1:-}"
VERSION="${2:-latest}"
[ -n "$SERVER" ] || { echo '用法：curl -fsSL <BASE>/install-trae.sh | sh -s <BASE> [latest|x.y.z]' >&2; exit 1; }
case "$SERVER" in
  http://127.0.0.1/*|http://localhost/*) ;;
  https://*) ;;
  *) echo '服务器需使用 HTTPS' >&2; exit 1 ;;
esac
BASE="${SERVER%/}"
case "$VERSION" in
  latest) ;;
  *[!0-9.]*|[!0-9]*) echo '版本号无效（latest 或 x.y.z）' >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

if [ "$VERSION" = latest ]; then
  VERSION="$(curl -fsSL "$BASE/dl/trae-extension/latest.json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$VERSION" ] || { echo '无法解析 latest.json' >&2; exit 1; }
fi
echo "安装 Trae 采集扩展 $VERSION ..."
REL="dl/trae-extension/$VERSION/trae-credits-poc-$VERSION.vsix"

curl -fsSL "$BASE/$REL" -o "$TMP/extension.vsix"
EXPECTED="$(curl -fsSL "$BASE/$REL.sha256" | awk '{print tolower($1)}')"
ACTUAL="$( (sha256sum "$TMP/extension.vsix" 2>/dev/null || shasum -a 256 "$TMP/extension.vsix") | awk '{print tolower($1)}')"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo '安装包校验失败，已停止安装' >&2; exit 1; }
head -c 2 "$TMP/extension.vsix" | grep -q 'PK' || { echo '下载内容不是 ZIP 包' >&2; exit 1; }

EXT_DIR="$HOME/.trae-cn/extensions/local-poc.trae-credits-poc-$VERSION"
if [ -f "$EXT_DIR/extension/extension.js" ]; then
  echo "已安装版本 $VERSION，跳过（重装先删除 $EXT_DIR）"
  exit 0
fi

CLI=""
for candidate in \
  "/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn" \
  "$HOME/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn" \
  "$(command -v trae-cn 2>/dev/null || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && CLI="$candidate" && break
done

if [ -n "$CLI" ]; then
  echo "通过 CLI 安装：$CLI"
  "$CLI" --install-extension "$TMP/extension.vsix" --force
else
  echo '未找到 trae-cn CLI，降级解压到扩展目录'
  unzip -t "$TMP/extension.vsix" >/dev/null
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR"
  unzip -q -o "$TMP/extension.vsix" -d "$EXT_DIR"
  [ -f "$EXT_DIR/extension/extension.js" ] || { echo '解压结果缺少 extension/extension.js' >&2; exit 1; }
fi

echo '完成：重启 Trae CN 窗口后生效。'
echo '验证：命令面板执行「Trae Credits: 查询每会话 Credits」，随后查看快照 ~/.trae-cn/credits-usage.json（schema 2）。'
echo '配合 TokenRank 同步器（另一条安装命令）每 15 分钟上报一次；未装同步器时扩展只写本地快照，不上传。'
