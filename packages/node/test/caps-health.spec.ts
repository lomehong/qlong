import { describe, expect, it } from 'vitest';
import { CapsHealth } from '../src/caps-health.js';

/**
 * 03 §7 能力自愈两段式(D32):软摘可恢复、硬摘需确定性复核、滞回防抖、全程有事件。
 */
describe('CapsHealth 两段式自愈', () => {
  it('软摘:10 分钟内 ≥3 次命中 → 排除出健康视图;24h 无复发自动恢复', () => {
    let now = 1_000_000;
    const events: Array<[string, string]> = [];
    const h = new CapsHealth({
      staticCaps: () => ['tool:node@20', 'tool:ffmpeg'],
      now: () => now,
      onEvent: (e, tag) => events.push([e, tag]),
    });
    // 前两次不触发
    h.onCapsMissing(['tool:node@20']);
    h.onCapsMissing(['tool:node@20']);
    expect(h.effectiveCaps()).toContain('tool:node@20');
    // 第三次 → 软摘
    const d = h.onCapsMissing(['tool:node@20']);
    expect(d.suspected).toEqual(['tool:node@20']);
    expect(h.effectiveCaps()).toEqual(['tool:ffmpeg']);
    expect(events).toContainEqual(['cap_tag_suspected', 'tool:node@20']);
    // 24h 无复发 → 自动恢复
    now += 24 * 3_600_000 + 1;
    expect(h.effectiveCaps()).toEqual(['tool:node@20', 'tool:ffmpeg']);
    expect(events).toContainEqual(['cap_tag_recovered', 'tool:node@20']);
  });

  it('硬摘:确定性复核确认缺失 → 从声明删除,24h 后也不恢复', () => {
    let now = 1_000_000;
    const events: Array<[string, string]> = [];
    const h = new CapsHealth({
      staticCaps: () => ['tool:ios-sign'],
      verifyCapability: () => false, // 确定性检查:确认缺失
      now: () => now,
      onEvent: (e, tag) => events.push([e, tag]),
    });
    h.onCapsMissing(['tool:ios-sign']);
    h.onCapsMissing(['tool:ios-sign']);
    const d = h.onCapsMissing(['tool:ios-sign']);
    expect(d.removed).toEqual(['tool:ios-sign']);
    expect(h.effectiveCaps()).toEqual([]);
    expect(events).toContainEqual(['cap_tag_removed', 'tool:ios-sign']);
    now += 24 * 3_600_000 + 1;
    expect(h.effectiveCaps()).toEqual([]); // 硬摘不自动恢复(重新声明须走静态变更上报)
  });

  it('滞回:阈值触发后 24h 内的重复失败不再摘(防抖)', () => {
    let now = 1_000_000;
    const events: Array<[string, string]> = [];
    const h = new CapsHealth({
      staticCaps: () => ['tool:x'],
      now: () => now,
      onEvent: (e, tag) => events.push([e, tag]),
    });
    h.onCapsMissing(['tool:x']);
    h.onCapsMissing(['tool:x']);
    h.onCapsMissing(['tool:x']); // 触发软摘
    expect(events.filter((e) => e[0] === 'cap_tag_suspected').length).toBe(1);
    // 恢复前反复失败:处于滞回,不再累计触发
    now += 60_000;
    h.onCapsMissing(['tool:x']);
    h.onCapsMissing(['tool:x']);
    h.onCapsMissing(['tool:x']);
    expect(events.filter((e) => e[0] === 'cap_tag_suspected').length).toBe(1);
  });

  it('窗口外命中不计入阈值(10 分钟窗口)', () => {
    let now = 1_000_000;
    const h = new CapsHealth({ staticCaps: () => ['tool:x'], now: () => now, suspectThreshold: 3 });
    h.onCapsMissing(['tool:x']);
    h.onCapsMissing(['tool:x']);
    now += 11 * 60_000; // 窗外:旧命中过期
    const d = h.onCapsMissing(['tool:x']);
    expect(d.suspected).toEqual([]); // 仅 1 次有效命中
  });
});
