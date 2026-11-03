# build.ps1 —— 薄封装：跨平台打包脚本在 Windows 上的入口（真正逻辑见 scripts/pack-vsix.mjs）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 [输出目录]
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction Stop).Source
& $node (Join-Path (Join-Path $root '..') (Join-Path 'scripts' 'pack-vsix.mjs')) @args
if ($LASTEXITCODE -ne 0) { throw "pack-vsix.mjs 退出码 $LASTEXITCODE" }
