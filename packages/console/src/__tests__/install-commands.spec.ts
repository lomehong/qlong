import { describe, expect, it } from 'vitest';
import { unixInstallCommand, winInstallCommand } from '../pages/install-commands';

/**
 * 回归:JS 模板字符串 `\q` 转义曾把复制出的 Windows 命令变成
 * `$env:TEMPqlong-install.ps1`(-File 找不到文件)。路径必须始终是正斜杠。
 */
describe('安装命令生成', () => {
  const TOKEN = 'test-enroll-token-123';

  it('Windows 命令:TEMP 路径为正斜杠,绝无 TEMPqlong 粘连', () => {
    const cmd = winInstallCommand(TOKEN);
    expect(cmd).toContain('-OutFile "$env:TEMP/qlong-install.ps1"');
    expect(cmd).toContain('-File "$env:TEMP/qlong-install.ps1"');
    expect(cmd).not.toContain('TEMPqlong');
    expect(cmd).not.toContain('\\');
    expect(cmd).toContain(`-EnrollToken "${TOKEN}"`);
  });

  it('Windows 命令:非 latest 版本追加 -Version', () => {
    expect(winInstallCommand(TOKEN, 'v0.9.0')).toContain('-Version v0.9.0');
    expect(winInstallCommand(TOKEN, 'latest')).not.toContain('-Version');
  });

  it('Unix 命令:token 经 stdin 传入,版本旗标一致', () => {
    const cmd = unixInstallCommand(TOKEN);
    expect(cmd).toContain(`echo "${TOKEN}" | sh /tmp/qlong-install.sh --enroll-stdin`);
    expect(cmd).toContain('https://lomehong-qlong.ms.show/install.sh');
    expect(unixInstallCommand(TOKEN, 'v0.9.0')).toContain('--version v0.9.0');
  });
});

