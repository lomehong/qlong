/**
 * qlong service(纪要 §8.5 定稿:自启与服务化——"装完即在线/重启自动在线"的落地件)。
 * 纯函数生成各平台注册物(便于测试),install/uninstall 负责落盘与执行。
 * 平台矩阵:Linux = systemd user unit;macOS = LaunchAgent;Windows = 计划任务(ONLOGON,免外部依赖)。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

export type ServicePlatform = 'linux' | 'darwin' | 'win32';

export const SERVICE_NAME = 'qlong';

/** 自身可执行入口(安装器放置的 qlong;开发态为 process.argv[1]) */
export function selfEntrance(argv1 = process.argv[1] ?? 'qlong', platform: ServicePlatform = process.platform as ServicePlatform): string {
  const p = /[/\\]/.test(argv1) ? argv1 : join(platform === 'win32' ? '%LOCALAPPDATA%\\qlong' : '~/.local/bin', argv1);
  return platform === 'win32' ? p : p.replace(/\\/g, '/');
}

/** 生成注册物内容与安装/卸载命令(纯函数,供测试与执行共用) */
export function serviceDefinition(
  platform: ServicePlatform,
  entrance: string,
  home: string,
): { path: string; content?: string; installCmds: string[]; uninstallCmds: string[] } {
  if (platform === 'linux') {
    const path = home.split('\\').join('/') + '/.config/systemd/user/qlong.service';
    const content = [
      '[Unit]',
      'Description=Qlong node (群龙节点)',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=${entrance} run`,
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      path,
      content,
      installCmds: [`systemctl --user daemon-reload`, `systemctl --user enable --now qlong.service`],
      uninstallCmds: [`systemctl --user disable --now qlong.service`],
    };
  }
  if (platform === 'darwin') {
    const path = home.split('\\').join('/') + '/Library/LaunchAgents/io.qunlong.qlong.plist';
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>io.qunlong.qlong</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${entrance}</string>`,
      '    <string>run</string>',
      '  </array>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return {
      path,
      content,
      installCmds: [`launchctl load -w ${path}`],
      uninstallCmds: [`launchctl unload -w ${path}`],
    };
  }
  // win32:计划任务(登录触发,免 NSSM 外部依赖)
  return {
    path: '',
    installCmds: [
      `schtasks /Create /F /TN ${SERVICE_NAME} /SC ONLOGON /TR "'${entrance}' run"`,
    ],
    uninstallCmds: [`schtasks /Delete /F /TN ${SERVICE_NAME}`],
  };
}

/** 安装服务(生成注册物 + 执行启用命令 + 启动节点) */
export async function serviceInstall(
  platform: ServicePlatform,
  entrance: string,
  home: string,
  exec: (cmd: string) => Promise<void> = async (cmd) => {
    const { execSync } = await import('node:child_process');
    execSync(cmd, { stdio: 'inherit' });
  },
): Promise<{ path: string }> {
  const def = serviceDefinition(platform, entrance, home);
  if (def.content) {
    mkdirSync(dirname(def.path), { recursive: true });
    writeFileSync(def.path, def.content);
  }
  for (const cmd of def.installCmds) await exec(cmd);
  return { path: def.path };
}

/** 卸载服务(停自启;凭证目录由调用方决定是否清除) */
export async function serviceUninstall(
  platform: ServicePlatform,
  entrance: string,
  home: string,
  exec: (cmd: string) => Promise<void> = async (cmd) => {
    const { execSync } = await import('node:child_process');
    execSync(cmd, { stdio: 'inherit' });
  },
): Promise<void> {
  const def = serviceDefinition(platform, entrance, home);
  for (const cmd of def.uninstallCmds) {
    try {
      await exec(cmd);
    } catch {
      /* 服务不存在视为已卸载 */
    }
  }
  if (def.path && platform !== 'win32' && existsSync(def.path)) {
    rmSync(def.path);
  }
}
