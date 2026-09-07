import { describe, expect, it, vi } from 'vitest';

describe('createProductionNode', () => {
  it('fetch /v1/nodes/me 失败时抛出明确错误', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', mockFetch);
    const { createProductionNode } = await import('../src/remote/factory.js');
    await expect(createProductionNode({
      registryUrl: 'http://fake',
      gatewayUrl: 'ws://fake',
      nodeToken: 'bad',
    })).rejects.toThrow('401');
    vi.unstubAllGlobals();
  });
});