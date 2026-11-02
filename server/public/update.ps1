param([Parameter(Mandatory=$true)][string]$Server)
$ErrorActionPreference = 'Stop'
$VERSION = '0.2.30'
$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $node --version
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.Trim().TrimStart('v')) -lt [version]'22.13.0') { throw '需要 Node.js 22.13+' }
$uri = [uri]$Server
if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) { throw '服务器需使用 HTTPS' }
if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw '服务器地址不能包含凭据或参数' }
$root = Join-Path $env:USERPROFILE '.tokenrank'
if (-not (Test-Path (Join-Path $root 'config.json'))) { throw '尚未接入，请先执行小程序里的接入命令' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '同步器目录不能是链接' }
$tmp = Join-Path $root ('update-' + [guid]::NewGuid().ToString('N'))
$stage = Join-Path $tmp 'stage'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
  $base = $Server.TrimEnd('/')
  $pkg = "tokenrank-client-$VERSION.tar.gz"
  Write-Host '下载更新工具，校验完整性与版本…'
  Invoke-WebRequest -Uri ($base + '/dl/' + $pkg) -OutFile (Join-Path $tmp 'app.tar.gz') -UseBasicParsing -TimeoutSec 180
  Invoke-WebRequest -Uri ($base + '/dl/' + $pkg + '.sha256') -OutFile (Join-Path $tmp 'app.sha256') -UseBasicParsing -TimeoutSec 60
  $expected = (Get-Content -LiteralPath (Join-Path $tmp 'app.sha256') -Raw).Trim().ToLower()
  $actual = (Get-FileHash -LiteralPath (Join-Path $tmp 'app.tar.gz') -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw '安装包校验失败，已停止更新' }
  tar -xzf (Join-Path $tmp 'app.tar.gz') -C $stage
  if ($LASTEXITCODE -ne 0) { throw '下载包解压失败，尚未更改原版' }
  $manifest = Get-Content (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
  if ($manifest.name -ne 'tokenrank-client' -or $manifest.version -ne $VERSION) { throw '下载内容不是预期更新工具' }
  & $node --no-warnings (Join-Path $stage 'bin\tokenrank.js') update-and-resync
  if ($LASTEXITCODE -ne 0) { throw '更新或回传未完成，请处理上述错误后重试' }
} finally { Remove-Item -LiteralPath $tmp -Recurse -Force }
