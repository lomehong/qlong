# 群龙(Qlong)安装脚本 — Windows PowerShell
# 用法: irm https://qlong.qianji.io/install.ps1 | iex; Install-Qlong -EnrollToken <token>
param(
  [string]$EnrollToken,
  [string]$InstallDir = "$env:LOCALAPPDATA\qlong"
)

$ErrorActionPreference = 'Stop'
Write-Host ">>> 群龙安装: Windows/$env:PROCESSOR_ARCHITECTURE"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host ">>> 下载 qlong.exe..."
$releaseUrl = "https://github.com/lomehong/qlong/releases/latest/download/qlong-win-x64.exe"
Invoke-WebRequest -Uri $releaseUrl -OutFile "$InstallDir\qlong.exe"

# 环境变量
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($currentPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$currentPath;$InstallDir", 'User')
}

# enrollment
if ($EnrollToken) {
  Write-Host ">>> 注册入网..."
  $EnrollToken | & "$InstallDir\qlong.exe" enroll --stdin
  Write-Host ">>> 入网完成"
}

Write-Host ">>> 安装完成: $InstallDir\qlong.exe"