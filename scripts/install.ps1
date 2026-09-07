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

# 发布物校验(评审 I-16):SHA256SUMS.txt 比对,不匹配即中止
Write-Host ">>> 校验发布物..."
$sumsUrl = $releaseUrl -replace 'qlong-[a-z]+', 'SHA256SUMS.txt'
$sumsPath = "$InstallDir\SHA256SUMS.txt"
try {
  Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath
  $expectedLine = (Get-Content $sumsPath) | Where-Object { $_ -match 'qlong-[a-z]+' }
  $expected = ($expectedLine -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 "$InstallDir\qlong.exe").Hash.ToLower()
  if ($expected -and $actual -ne $expected) {
    Write-Error ">>> 安装中止:发布物校验和不匹配(预期 $expected,实际 $actual)"
    Remove-Item "$InstallDir\qlong.exe", $sumsPath -ErrorAction SilentlyContinue
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
  $EnrollToken | & "$InstallDir\qlong.exe" enroll --stdin
  Write-Host ">>> 入网完成"
}

Write-Host ">>> 安装完成: $InstallDir\qlong.exe"