# 群龙(Qlong)安装脚本 — Windows PowerShell
# 用法(两步式,token 不进命令行 history,评审 I-16):
#   irm https://lomehong-qlong.ms.show/install.ps1 -OutFile "$env:TEMP\qlong-install.ps1"
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\qlong-install.ps1" -EnrollToken "<邀请码>"
# 卸载: powershell -File <本脚本> -Uninstall
param(
  [string]$EnrollToken,
  [string]$InstallDir = "$env:LOCALAPPDATA\qlong",
  [string]$Version = $env:QLONG_VERSION,
  [string]$DistBase = $env:QLONG_DIST_URL,
  [switch]$Uninstall
)
if (-not $Version) { $Version = 'latest' }
if (-not $DistBase) { $DistBase = 'https://lomehong-qlong.ms.show' }

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

# 运行时检测:内置 SQLite 需要 Node.js >= 24
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error ">>> 安装中止:未检测到 node,请先安装 Node.js >= 24(https://nodejs.org)"
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 24) {
  Write-Error ">>> 安装中止:Node.js 需 >= 24(当前 $nodeMajor)"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# 下载发布物(评审 I-22):程序 bundle + 启动垫片,二者缺一不可
$releaseBase = "$DistBase/releases/$Version"
Write-Host ">>> 下载 qlong($Version)..."
Invoke-WebRequest -Uri "$releaseBase/qlong-cli.mjs" -OutFile "$InstallDir\qlong-cli.mjs"
Invoke-WebRequest -Uri "$releaseBase/qlong-win-x64.cmd" -OutFile "$InstallDir\qlong.cmd"

# 发布物校验(评审 I-16):对程序 bundle 做 SHA256 比对,不匹配即中止
Write-Host ">>> 校验发布物..."
$sumsUrl = "$releaseBase/SHA256SUMS.txt"
$sumsPath = "$InstallDir\SHA256SUMS.txt"
try {
  Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath
  $expectedLine = (Get-Content $sumsPath) | Where-Object { $_ -match 'qlong-cli\.mjs' }
  $expected = ($expectedLine -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 "$InstallDir\qlong-cli.mjs").Hash.ToLower()
  if ($expected -and $actual -ne $expected) {
    Write-Host ">>> 安装中止:发布物校验和不匹配(预期 $expected,实际 $actual)" -ForegroundColor Red
    Remove-Item "$InstallDir\qlong-cli.mjs", "$InstallDir\qlong.cmd", $sumsPath -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host ">>> 校验通过"
} catch {
  Write-Host ">>> 警告:无法获取 SHA256SUMS.txt,跳过校验($($_.Exception.Message))"
}
Remove-Item $sumsPath -ErrorAction SilentlyContinue

# 环境变量(qlong 命令全局可用)
$currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($currentPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$currentPath;$InstallDir", 'User')
}

# enrollment(token 经 stdin;中心地址随分发源走:装自哪个中心就入哪个网)
$gwBase = $DistBase -replace '^https://', 'wss://' -replace '^http://', 'ws://'
$gatewayUrl = if ($env:QLONG_GATEWAY_URL) { $env:QLONG_GATEWAY_URL } else { "$gwBase/gateway" }
if ($EnrollToken) {
  Write-Host ">>> 注册入网..."
  $EnrollToken | & "$InstallDir\qlong.cmd" enroll --stdin --registry "$DistBase" --gateway "$gatewayUrl"
  if ($LASTEXITCODE -ne 0) {
    Write-Host ">>> 安装中止:入网失败(邀请码无效/过期或网络不可达);回控制台重新生成邀请码后重跑同一安装命令" -ForegroundColor Red
    exit 1
  }
  Write-Host ">>> 入网完成"
}

# 服务化自启(纪要 §8.5:装完即在线/重启自动在线)。
# 持久节点拒绝隐式启动:自启必须显式准入(open + 本地文件系统确认 + Windows ACL 确认);
# create 不能注册为自启(重启即 DATABASE_EXISTS 失败循环)——首次创建须手动完成。
$serviceArgs = @()
if ($env:QLONG_STORAGE_MODE -and $env:QLONG_LOCAL_FS_CONFIRMED -eq '1') {
  if ($env:QLONG_STORAGE_MODE -ne 'open') {
    Write-Host ">>> 跳过自启注册:QLONG_STORAGE_MODE=$($env:QLONG_STORAGE_MODE);自启必须 open"
    Write-Host "    首次手动执行: qlong run --storage-mode create --confirm-local-filesystem --confirm-windows-acl"
    Write-Host "    完成后以 QLONG_STORAGE_MODE=open 重跑安装即可注册自启"
  } else {
    if ($env:QLONG_DATA_DIR) { $serviceArgs += @('--data-dir', $env:QLONG_DATA_DIR) }
    if ($env:QLONG_DATA_BASE) { $serviceArgs += @('--data-base', $env:QLONG_DATA_BASE) }
    $serviceArgs += @('--storage-mode', 'open', '--confirm-local-filesystem')
    if ($env:QLONG_WINDOWS_ACL_CONFIRMED -eq '1') { $serviceArgs += '--confirm-windows-acl' }
    & "$InstallDir\qlong.cmd" service install @serviceArgs
  }
} else {
  Write-Host ">>> 跳过自启注册:未配置持久存储准入(QLONG_STORAGE_MODE=open + QLONG_LOCAL_FS_CONFIRMED=1 + QLONG_WINDOWS_ACL_CONFIRMED=1)"
  Write-Host "    数据目录须在本机本地磁盘(勿用 NFS/SMB/云同步盘);配置后重跑安装,"
  Write-Host "    或手动: qlong service install --storage-mode open --confirm-local-filesystem --confirm-windows-acl"
}

# 装完即在线验收(I-22 清单)
Write-Host ">>> 验收入网状态..."
& "$InstallDir\qlong.cmd" status

Write-Host ">>> 安装完成: $InstallDir\qlong.cmd"
Write-Host ">>> 卸载: powershell -File `$PSCommandPath -Uninstall(含凭证清除)"

