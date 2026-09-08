import { describe, expect, it } from 'vitest';
import { matchCaps, matchOne, parseTag } from '../src/executor/caps.js';

describe('能力标签匹配(D31,评审 I-30)', () => {
  it('解析:类:值@版本', () => {
    expect(parseTag('tool:node@20')).toEqual({ cls: 'tool', value: 'node', version: ['20'] });
    expect(parseTag('env:python')).toEqual({ cls: 'env', value: 'python', version: null });
  });

  it('无 @:类+值完全相等(忽略档案版本段),非前缀匹配', () => {
    expect(matchOne('tool:node', ['tool:node@20'])).toBe(true);
    expect(matchOne('tool:node', ['tool:nodejs'])).toBe(false);
    expect(matchOne('tool:node', ['tool:node-lts'])).toBe(false);
  });

  it('带 @:逐段数值比较;@20 命中 @20.1;@3.12 不命中 @3.2;档案未声明版本不满足', () => {
    expect(matchOne('tool:node@20', ['tool:node@20.1'])).toBe(true);
    expect(matchOne('env:python@3.12', ['env:python@3.2'])).toBe(false);
    expect(matchOne('tool:node@20', ['tool:node'])).toBe(false);
    expect(matchOne('tool:node@20', ['tool:node@18'])).toBe(false);
  });

  it('未知类照存照传:整串精确相等(评审 I-30④)', () => {
    expect(matchOne('ml:tpu-v5', ['ml:tpu-v5'])).toBe(true);
    expect(matchOne('ml:tpu-v5', ['ml:tpu-v5e'])).toBe(false);
  });

  it('matchCaps:AND 语义,missing 明细反哺改派(03 §6 闸3)', () => {
    const r = matchCaps(['tool:node@20', 'env:wsl2'], ['tool:node@20.3']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['env:wsl2']);
    expect(matchCaps([], []).ok).toBe(true);
  });
});