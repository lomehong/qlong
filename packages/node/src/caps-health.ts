/**
 * 能力自愈两段式(03 §7,D32):声明与现实对齐,但可见、可恢复、不误摘。
 *
 * - 触发仅限本地确定性检查失败(fail(caps_missing).missing_caps);禁止凭任务失败推断。
 * - 软摘(suspected):10 分钟窗口内 ≥3 次命中 → 从上报档案排除(档案保留),24h 无复发自动恢复;
 * - 硬摘(removed):软摘窗口内复发且本地确定性复核确认缺失(verifyCapability=false)→ 从静态声明删除;
 * - 滞回:恢复/硬摘后 24h 内不再自动软摘(防抖动);
 * - 全程产生审计事件(cap_tag_suspected / cap_tag_removed / cap_tag_recovered)。
 */

export interface CapsHealthOptions {
  /** 静态声明来源(原始标签集,健康视图据此过滤) */
  staticCaps: () => string[];
  /** 确定性复核:返回 false = 确认缺失(硬摘);未提供 = 只软摘不硬摘 */
  verifyCapability?: (tag: string) => boolean;
  now?: () => number;
  /** 软摘触发阈值:窗口内命中次数(默认 3) */
  suspectThreshold?: number;
  /** 命中统计窗口(默认 10 分钟,评审 I-20 QA 建议) */
  suspectWindowMs?: number;
  /** 软摘后无复发自动恢复时长(默认 24h) */
  recoverAfterMs?: number;
  /** 滞回:恢复/硬摘后不再自动软摘的时长(默认 24h) */
  hysteresisMs?: number;
  onEvent?: (event: 'cap_tag_suspected' | 'cap_tag_removed' | 'cap_tag_recovered', tag: string) => void;
}

export interface CapsHealthDelta {
  suspected: string[];
  removed: string[];
}

interface TagState {
  hits: number[];
  suppressedUntil?: number;
  removedAt?: number;
  lastTransitionAt?: number;
}

export class CapsHealth {
  private readonly opts: {
    now: () => number;
    suspectThreshold: number;
    suspectWindowMs: number;
    recoverAfterMs: number;
    hysteresisMs: number;
    onEvent?: CapsHealthOptions['onEvent'];
    staticCaps: () => string[];
    verifyCapability?: (tag: string) => boolean;
  };
  private readonly state = new Map<string, TagState>();

  constructor(opts: CapsHealthOptions) {
    this.opts = {
      now: opts.now ?? (() => Date.now()),
      suspectThreshold: opts.suspectThreshold ?? 3,
      suspectWindowMs: opts.suspectWindowMs ?? 10 * 60_000,
      recoverAfterMs: opts.recoverAfterMs ?? 24 * 3_600_000,
      hysteresisMs: opts.hysteresisMs ?? 24 * 3_600_000,
      onEvent: opts.onEvent,
      staticCaps: opts.staticCaps,
      verifyCapability: opts.verifyCapability,
    };
  }

  /** 健康视图:静态声明 − 软摘 − 硬摘(上报与闸3 均使用此视图) */
  effectiveCaps(): string[] {
    const now = this.opts.now();
    const recovered: string[] = [];
    for (const [tag, st] of this.state) {
      if (st.suppressedUntil !== undefined && now >= st.suppressedUntil) {
        delete st.suppressedUntil;
        st.lastTransitionAt = now;
        recovered.push(tag);
        this.opts.onEvent?.('cap_tag_recovered', tag);
      }
    }
    void recovered;
    return this.opts.staticCaps().filter((t) => {
      const st = this.state.get(t);
      return !(st && (st.suppressedUntil !== undefined || st.removedAt !== undefined));
    });
  }

  /** fail(caps_missing) 回流:对每个缺失标签跑两段式判定 */
  onCapsMissing(tags: string[]): CapsHealthDelta {
    const now = this.opts.now();
    const suspected: string[] = [];
    const removed: string[] = [];
    for (const tag of tags) {
      if (this.inHysteresis(tag, now)) continue;
      const st = this.state.get(tag) ?? { hits: [] };
      st.hits = st.hits.filter((t) => now - t < this.opts.suspectWindowMs);
      st.hits.push(now);
      if (st.hits.length >= this.opts.suspectThreshold) {
        const confirmedMissing = this.opts.verifyCapability ? this.opts.verifyCapability(tag) === false : false;
        if (confirmedMissing) {
          st.removedAt = now;
          st.lastTransitionAt = now;
          st.hits = [];
          removed.push(tag);
          this.opts.onEvent?.('cap_tag_removed', tag);
        } else {
          st.suppressedUntil = now + this.opts.recoverAfterMs;
          st.lastTransitionAt = now;
          st.hits = [];
          suspected.push(tag);
          this.opts.onEvent?.('cap_tag_suspected', tag);
        }
      }
      this.state.set(tag, st);
    }
    return { suspected, removed };
  }

  /** 滞回:恢复/硬摘后 24h 内不再自动软摘(单一来源重复失败只降权不摘,评审 I-20③) */
  private inHysteresis(tag: string, now: number): boolean {
    const st = this.state.get(tag);
    return st?.lastTransitionAt !== undefined && now - st.lastTransitionAt < this.opts.hysteresisMs;
  }
}
