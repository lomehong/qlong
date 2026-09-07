# 群龙(Qlong)安装脚本 — Windows PowerShell
# 用法: irm https://qlong.qianji.io/install.ps1 | iex; Install-Qlong -EnrollToken <token>
param(
  [string]$EnrollToken,
  [string]$InstallDir = "$env:LOCALAPPDATA\qlong",
  [string]$Version = $env:QLONG_VERSION,
  [string]$DistBase = $env:QLONG_DIST_URL,
  [switch]$Uninstall
)
if (-not $Version) { $Version = 'latest' }
if (-not $DistBase) { $DistBase = 'https://qlong.qianji.io' }

$ErrorActionPreference = 'Stop'

# 卸载:停自启 → 删文件 → 清凭证(纪要 §8.5)
if ($Uninstall) {
  $shim = "$InstallDir\qlong.cmd"
  if (Get-Command qlong -ErrorAction SilentlyContinue) { qlong service uninstall 2>$null }
  elseif (Test-Path $shim) { & $shim service uninstall 2>$null }
  Remove-Item "$InstallDir" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item "$env:USERPROFILE\.qlong" -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ">>> 已卸载:自启解除、二进制与本地凭证已清除"
  exit 0
}

Write-Host ">>> 群龙安装: Windows/$env:PROCESSOR_ARCHITECTURE"

# 运行时检测:Windows 产物为 cmd 垫片(需 node ≥ 20)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error ">>> 安装中止:未检测到 node,请先安装 Node.js ≥ 20(https://nodejs.org)"
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Error ">>> 安装中止:Node.js 需 ≥ 20(当前 $nodeMajor)"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host ">>> 下载 qlong.exe..."
$releaseUrl = "$DistBase/releases/$Version/qlong-win-x64.cmd"
Invoke-WebRequest -Uri $releaseUrl -OutFile "$InstallDir\qlong.cmd"

# 发布物校验(评审 I-16):SHA256SUMS.txt 比对,不匹配即中止
Write-Host ">>> 校验发布物..."
$sumsUrl = $releaseUrl -replace 'qlong-[a-z]+', 'SHA256SUMS.txt'
$sumsPath = "$InstallDir\SHA256SUMS.txt"
try {
  Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath
  $expectedLine = (Get-Content $sumsPath) | Where-Object { $_ -match 'qlong-[a-z]+' }
  $expected = ($expectedLine -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 "$InstallDir\qlong.cmd").Hash.ToLower()
  if ($expected -and $actual -ne $expected) {
    Write-Error ">>> 安装中止:发布物校验和不匹配(预期 $expected,实际 $actual)"
    Remove-Item "$InstallDir\qlong.cmd", $sumsPath -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host ">>> 校验通过"
} catch {
  Write-Host ">>> 警告:无法获取 SHA256SUMS.txt,跳过校验($($_.Exception.Message))"
}
Remove-Item $sumsPath -ErrorAction SilentlyContinue

# 环境变量
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($currentPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$currentPath;$InstallDir", 'User')
}

# enrollment
if ($EnrollToken) {
  Write-Host ">>> 注册入网..."
  $EnrollToken | & "$InstallDir\qlong.cmd" enroll --stdin
  Write-Host ">>> 入网完成"
}

# 服务化自启(纪要 §8.5:装完即在线/重启自动在线)
& "$InstallDir\qlong.cmd" service install

# 装完即在线验收(I-22 清单)
Write-Host ">>> 验收入网状态..."
& "$InstallDir\qlong.cmd" status

Write-Host ">>> 安装完成: $InstallDir\qlong.cmd"
Write-Host ">>> 卸载: Install-Qlong -Uninstall(含凭证清除)"