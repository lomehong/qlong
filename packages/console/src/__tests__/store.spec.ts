import { describe, expect, it } from 'vitest';
import { useStore } from '../store/useStore';

describe('useStore', () => {
  it('setError', () => {
    useStore.getState().setError('test');
    expect(useStore.getState().error).toBe('test');
    useStore.getState().setError(null);
    expect(useStore.getState().error).toBeNull();
  });
  it('初始状态', () => {
    const s = useStore.getState();
    expect(s.agents).toEqual([]);
    expect(s.overview).toBeNull();
  });
});