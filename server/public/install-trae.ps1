param([Parameter(Mandatory=$true)][string]$Server, [string]$Version = 'latest', [switch]$Force)
$ErrorActionPreference = 'Stop'
# Trae 采集扩展一键安装：从本服务下载 VSIX（sha256 校验）后用 Trae CN CLI 安装；
# 找不到 CLI 时降级解压到 Trae 的扩展目录（不写 extensions.json，重启 Trae 后生效）。
$env:PATH = "C:\Windows\System32;C:\Windows;$env:PATH"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$uri = [uri]$Server
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) { throw '服务器需使用 HTTPS' }
if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw '服务器地址不能包含凭据或参数' }
if ($Version -ne 'latest' -and $Version -notmatch '^[0-9]+(\.[0-9]+)*$') { throw '版本号无效（latest 或 x.y.z）' }
$base = $Server.TrimEnd('/')

$dir = Join-Path $env:TEMP ('trae-ext-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $dir | Out-Null
try {
  # 1) 解析版本：latest → 读指针文件；否则直接拼版本目录
  $version = $Version
  if ($Version -eq 'latest') {
    $pointer = Invoke-RestMethod -Uri ($base + '/dl/trae-extension/latest.json') -UseBasicParsing
    $version = [string]$pointer.version
  }
  Write-Host "安装 Trae 采集扩展 $version ..."
  $relative = "dl/trae-extension/$version/trae-credits-poc-$version.vsix"

  # 2) 下载 + sha256 校验
  $vsix = Join-Path $dir 'extension.vsix'
  Invoke-WebRequest -Uri ($base + '/' + $relative) -OutFile $vsix -UseBasicParsing
  $expected = (Invoke-WebRequest -Uri ($base + '/' + $relative + '.sha256') -UseBasicParsing).Content.Trim().ToLower()
  if ($expected -match '\s') { $expected = ($expected -split '\s')[0].Trim().ToLower() }
  $actual = (Get-FileHash -LiteralPath $vsix -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw '安装包校验失败，已停止安装' }
  $head = [System.IO.File]::ReadAllBytes($vsix)[0..1]
  if ($head[0] -ne 0x50 -or $head[1] -ne 0x4b) { throw '下载内容不是 ZIP 包' }

  # 3) 幂等判断：对比已安装目录记录的 sha256，同版本同内容才跳过
  $extDir = Join-Path $env:USERPROFILE ('.trae-cn\extensions\local-poc.trae-credits-poc-' + $version)
  $shaFile = Join-Path $extDir '.vsix.sha256'
  if (-not $Force -and (Test-Path $extDir -PathType Container -ErrorAction SilentlyContinue) -and (Test-Path $shaFile -PathType Leaf -ErrorAction SilentlyContinue)) {
    $installedSha = (Get-Content -LiteralPath $shaFile -Raw -ErrorAction SilentlyContinue).Trim().ToLower()
    if ($installedSha -eq $actual) {
      Write-Host "已安装版本 $version 且 VSIX 未变，跳过（重装加 -Force）"
      exit 0
    }
    Write-Host "发现已安装版本但 VSIX 已更新，重新安装…"
  }

  # 4) 清理旧版本残留目录（local-poc.trae-credits-poc-* 但不是当前版本）
  $extensionsRoot = Join-Path $env:USERPROFILE '.trae-cn\extensions'
  if (Test-Path $extensionsRoot -PathType Container -ErrorAction SilentlyContinue) {
    Get-ChildItem -LiteralPath $extensionsRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like 'local-poc.trae-credits-poc-*' -and $_.Name -ne ('local-poc.trae-credits-poc-' + $version) } |
      ForEach-Object {
        Write-Host "清理旧版本残留：$($_.Name)"
        try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { Write-Warning "无法删除旧目录 $($_.Name)：$($_.Exception.Message)" }
      }
  }

  # 5) 优先用 Trae CN CLI 安装（含装在自定义盘 Program Files 的情况）
  $cliCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Trae CN\bin\trae-cn.cmd'),
    (Join-Path $env:ProgramFiles 'Trae CN\bin\trae-cn.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'Trae CN\bin\trae-cn.cmd'),
    ((Get-Command trae-cn -ErrorAction SilentlyContinue).Source)
  )
  foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    $cliCandidates += (Join-Path ($drive.Name + ':\') 'Program Files\Trae CN\bin\trae-cn.cmd')
    $cliCandidates += (Join-Path ($drive.Name + ':\') 'Program Files (x86)\Trae CN\bin\trae-cn.cmd')
  }
  $cli = $cliCandidates | Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } | Select-Object -First 1
  if ($cli) {
    Write-Host "通过 CLI 安装：$cli"
    & $cli --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw 'Trae CLI 安装失败' }
    # CLI 安装后也写 sha256 记录，便于下次幂等判断（CLI 解压路径与我们一致）
    New-Item -ItemType Directory -Force -Path $extDir | Out-Null
    [IO.File]::WriteAllText($shaFile, $actual + "`n", (New-Object Text.UTF8Encoding $false))
  } else {
    # 6) 无 CLI 时降级解压到扩展目录（结构与 CLI 安装一致：extension\ 在版本目录下）
    Write-Host '未找到 trae-cn CLI，降级解压到扩展目录'
    $zipCopy = Join-Path $dir 'extension.zip'
    Copy-Item $vsix $zipCopy
    if (Test-Path $extDir) { Remove-Item -Recurse -Force $extDir }
    New-Item -ItemType Directory -Force -Path $extDir | Out-Null
    Expand-Archive -LiteralPath $zipCopy -DestinationPath $extDir -Force
    if (-not (Test-Path (Join-Path $extDir 'extension\extension.js'))) { throw '解压结果缺少 extension\extension.js' }
    [IO.File]::WriteAllText($shaFile, $actual + "`n", (New-Object Text.UTF8Encoding $false))
  }

  Write-Host '完成：重启 Trae CN 窗口后生效。'
  Write-Host '验证：命令面板执行「Trae Credits: 查询每会话 Credits」，随后查看快照 ~\.trae-cn\credits-usage.json（schema 2）。'
  Write-Host '配合 TokenRank 同步器（另一条安装命令）每 15 分钟上报一次；未装同步器时扩展只写本地快照，不上传。'
} finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
