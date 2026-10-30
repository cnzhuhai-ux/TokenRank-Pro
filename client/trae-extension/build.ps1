# build.ps1 —— 离线打包 trae-credits-poc VSIX（不依赖 npm/vsce，PowerShell 5.1 可用）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$ver = $pkg.version

# ---- 1. 组装暂存目录 ----
$stage = Join-Path $env:TEMP ('trae-credits-poc-stage-' + [guid]::NewGuid().ToString('N'))
$ext = Join-Path $stage 'extension'
New-Item -ItemType Directory -Path $ext -Force | Out-Null
foreach ($f in 'package.json', 'extension.js', 'README.md') {
    Copy-Item (Join-Path $root $f) (Join-Path $ext $f)
}

# ---- 2. 生成 VSIX 元数据（UTF-8 无 BOM） ----
$manifest = @'
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="trae-credits-poc" Version="__VER__" Publisher="local-poc"/>
    <DisplayName>Trae Credits POC</DisplayName>
    <Description xml:space="preserve">POC: read per-session credits via icube.common.getToken. Read-only, no token logging.</Description>
    <Tags>credits,usage,poc</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.70.0"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
'@
$manifest = $manifest.Replace('__VER__', $ver)
$ctypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="xml" ContentType="text/xml"/>
</Types>
'@
[System.IO.File]::WriteAllText((Join-Path $stage 'extension.vsixmanifest'), $manifest)
[System.IO.File]::WriteAllText((Join-Path $stage '[Content_Types].xml'), $ctypes)

# ---- 3. 打 zip（正斜杠条目，符合 VSIX 规范） ----
$vsix = Join-Path $root ('trae-credits-poc-' + $ver + '.vsix')
if (Test-Path $vsix) { Remove-Item $vsix -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($vsix, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem $stage -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($stage.Length + 1) -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $zip.Dispose() }
Remove-Item $stage -Recurse -Force
Write-Host "OK: $vsix ($((Get-Item $vsix).Length) bytes)"
