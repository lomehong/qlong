/**
 * 执行档案纯函数(03 §6.1/§6.2,D22/D33):
 * offer.requires 与本地档案比对;越权项产 violations(闸5/驱动前置共用)。
 * 权限单向收窄:offer 只能声明,永远不能放宽档案(P13 延伸)。
 */
export interface RequireEntry {
  cls: string;
  value: string;
  reason?: string;
}

export interface ExecutionProfile {
  /** 工具白名单(空 = 仅档案默认工具集) */
  toolWhitelist: string[];
  /** 允许的网络出口目标(空 = 默认拒绝内网敏感网段,https 公网放行) */
  netWhitelist: string[];
  /** 是否存在人工确认通道 */
  confirmChannel: boolean;
}

export interface ProfileViolation {
  cls: string;
  value: string;
  reason: string;
}

/** 闸5 的 requires 预检:返回越权/需确认清单(空数组 = 通过) */
export function checkRequires(requires: RequireEntry[], profile: ExecutionProfile): ProfileViolation[] {
  const out: ProfileViolation[] = [];
  for (const r of requires ?? []) {
    if (r.cls === 'tool' && !profile.toolWhitelist.includes(r.value)) {
      out.push({ cls: r.cls, value: r.value, reason: '工具不在白名单' });
    }
    if (r.cls === 'net' && !profile.netWhitelist.includes(r.value)) {
      out.push({ cls: r.cls, value: r.value, reason: '网络出口不在白名单' });
    }
    if (r.cls === 'confirm' && !profile.confirmChannel) {
      out.push({ cls: r.cls, value: r.value, reason: '无本地人确认通道' });
    }
  }
  return out;
}