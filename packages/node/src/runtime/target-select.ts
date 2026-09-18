/**
 * 默认改派目标选择器(第 2 步牵头生产链路;DurableLead.selectTarget 的目录驱动实现)。
 *
 * 设计约束:
 * - `TargetSelector` 是**同步**端口(lead 事务内调用),而团队目录来自中心 HTTP —— 故采用
 *   "后台刷新 + 同步快照"结构:宿主周期调 `refresh()` 拉目录,选择器只读最近一次快照。
 *   快照为空(启动首拉未完成/中心不可达)→ 返回 null,任务按既有语义留在 drafting 等下次 tick
 *   重试 —— 目录不可达绝不会被放大成错误目标。
 * - 过滤:非本机、status=active、避开 R8 排除表、required_caps ⊆ node.caps(复用 core matchCaps,
 *   与执行侧闸3/D2 单一实现防语义分叉,D31)。
 * - offer 模板:首发与改派共用同一模板(kind 由请求覆盖),保证改派单与原单任务书一致。
 */
import { matchCaps } from '@qlong/core';
import type { TargetSelector } from './lead.js';

export interface DirectoryNode {
  node_id: string;
  status: string;
  caps?: string[] | null;
}

/** 拉取本团队目录(实现负责鉴权,如 Bearer node token;抛错由 refresh 捕获并保留旧快照)。 */
export type DirectoryFetcher = () => Promise<DirectoryNode[]>;

export interface TargetSelectorOptions {
  selfNodeId: string;
  fetchDirectory: DirectoryFetcher;
  /** offer 模板(summary/lease_ms/offer_ttl_ms/required_caps 等;kind 由改派请求覆盖) */
  offerTemplate: Record<string, unknown>;
  /** 缺省 'round-robin';'first' 固定取首个合格候选(测试/确定性场景) */
  strategy?: 'round-robin' | 'first';
}

export interface TargetSelectorHandle {
  selector: TargetSelector;
  /** 拉取并替换目录快照;失败保留旧快照并返回 false(不抛出,宿主按需记日志)。 */
  refresh: () => Promise<boolean>;
  /** 当前快照大小(诊断/测试)。 */
  snapshotSize: () => number;
}

export function createTargetSelector(opts: TargetSelectorOptions): TargetSelectorHandle {
  if (!Array.isArray(opts.offerTemplate)) {
    // offerTemplate 必须是普通对象(防御:CLI 传入 JSON 解析产物)。
    if (typeof opts.offerTemplate !== 'object' || opts.offerTemplate === null) {
      throw new TypeError('offerTemplate must be an object');
    }
  }
  const requiredCaps = Array.isArray(opts.offerTemplate.required_caps)
    ? (opts.offerTemplate.required_caps as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
  let snapshot: DirectoryNode[] = [];
  let cursor = 0;

  const selector: TargetSelector = (request) => {
    const candidates = snapshot.filter((n) =>
      n.node_id !== opts.selfNodeId &&
      n.status === 'active' &&
      request.excluded[n.node_id] === undefined &&
      (requiredCaps.length === 0 || matchCaps(requiredCaps, n.caps ?? []).ok));
    if (candidates.length === 0) return null;
    const pick = opts.strategy === 'first'
      ? candidates[0]!
      : candidates[cursor++ % candidates.length]!;
    return { target: pick.node_id, offerBody: { ...opts.offerTemplate, kind: request.kind } };
  };

  return {
    selector,
    refresh: async (): Promise<boolean> => {
      try {
        const next = await opts.fetchDirectory();
        if (!Array.isArray(next)) return false;
        snapshot = next;
        return true;
      } catch {
        return false; // 保留旧快照:目录瞬断不改写本地视图,更不产生错误目标
      }
    },
    snapshotSize: (): number => snapshot.length,
  };
}
