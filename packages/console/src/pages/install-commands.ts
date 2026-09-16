/**
 * 安装命令生成(纯函数,便于回归测试)。
 * Windows 路径一律用正斜杠:JS 模板字符串里 `\q` 会被转义吞掉——
 * 曾把复制出的命令变成 `$env:TEMPqlong-install.ps1`(文件不存在,评审 bb1d8f8 同源问题)。
 */
export const DIST_BASE = 'https://lomehong-qlong.ms.show';

export function unixInstallCommand(token: string, version = 'latest'): string {
  const flag = version !== 'latest' ? ` --version ${version}` : '';
  return `curl -fsSL ${DIST_BASE}/install.sh -o /tmp/qlong-install.sh && echo "${token}" | sh /tmp/qlong-install.sh --enroll-stdin${flag}`;
}

export function winInstallCommand(token: string, version = 'latest'): string {
  const flag = version !== 'latest' ? ` -Version ${version}` : '';
  return `irm ${DIST_BASE}/install.ps1 -OutFile "$env:TEMP/qlong-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP/qlong-install.ps1" -EnrollToken "${token}"${flag}`;
}
