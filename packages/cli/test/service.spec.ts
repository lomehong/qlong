import { describe, expect, it } from 'vitest';
import { serviceDefinition, selfEntrance } from '../src/service.js';

/** 纪要 §8.5 服务化:三平台注册物生成(纯函数;不执行系统调用) */
describe('service 跨平台注册物', () => {
  it('linux:systemd user unit(ExecStart 指向入口,自启 + 失败重启)', () => {
    const d = serviceDefinition('linux', '/home/u/.local/bin/qlong', '/home/u');
    expect(d.path).toBe('/home/u/.config/systemd/user/qlong.service');
    expect(d.content).toContain('ExecStart=/home/u/.local/bin/qlong run');
    expect(d.content).toContain('Restart=on-failure');
    expect(d.installCmds.join(' ')).toContain('systemctl --user enable --now');
    expect(d.uninstallCmds.join(' ')).toContain('disable --now');
  });

  it('darwin:LaunchAgent(RunAtLoad + KeepAlive)', () => {
    const d = serviceDefinition('darwin', '/Users/u/.local/bin/qlong', '/Users/u');
    expect(d.path).toContain('Library/LaunchAgents/io.qunlong.qlong.plist');
    expect(d.content).toContain('<string>/Users/u/.local/bin/qlong</string>');
    expect(d.content).toContain('<key>RunAtLoad</key>');
    expect(d.installCmds[0]).toContain('launchctl load -w');
  });

  it('win32:计划任务(ONLOGON,免外部依赖)', () => {
    const d = serviceDefinition('win32', 'C:/Users/u/AppData/Local/qlong/qlong.cmd', 'C:/Users/u');
    expect(d.installCmds[0]).toContain('schtasks /Create');
    expect(d.installCmds[0]).toContain('/TN qlong');
    expect(d.installCmds[0]).toContain('run');
    expect(d.uninstallCmds[0]).toContain('/Delete');
  });

  it('selfEntrance:裸命令名按安装目录补全,win32 反斜杠规范化', () => {
    expect(selfEntrance('qlong', 'linux')).toContain('.local/bin/qlong');
    expect(selfEntrance('/x/y/qlong', 'linux')).toBe('/x/y/qlong');
  });
});
