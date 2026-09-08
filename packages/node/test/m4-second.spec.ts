import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPayloadRef, fetchPayload, isPrivateHost } from '../src/executor/fetcher.js';
import { checkRequires } from '../src/executor/profile.js';

function sha(b: Buffer | Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

describe('R10 baseline', () => {
  it('scheme whitelist', () => {
    expect(checkPayloadRef({ ref_uri: 'file:///etc/passwd', sha256: 'x', size: 1 }).ok).toBe(false);
    expect(checkPayloadRef({ ref_uri: 'http://example.com/x', sha256: 'x', size: 1 }).ok).toBe(false);
    expect(checkPayloadRef({ ref_uri: 'https://example.com/x', sha256: 'x', size: 1 }).ok).toBe(true);
  });
  it('private/loopback denied by default; allowlist passes', () => {
    expect(checkPayloadRef({ ref_uri: 'https://169.254.169.254/meta', sha256: 'x', size: 1 }).ok).toBe(false);
    expect(checkPayloadRef({ ref_uri: 'https://169.254.169.254/meta', sha256: 'x', size: 1 }, { allowHosts: ['169.254.169.254'] }).ok).toBe(true);
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('example.com')).toBe(false);
  });
  it('size cap precheck', () => {
    expect(checkPayloadRef({ ref_uri: 'https://example.com/x', sha256: 'x', size: 1000 }, { maxBytes: 500 }).ok).toBe(false);
  });
});

describe('fetchPayload checks (loopback allowlist policy)', () => {
  let server: ReturnType<typeof createServer>;
  let base = '';
  let host = '';
  const payload = Buffer.from('hello payload');
  const payloadSha = createHash('sha256').update(payload).digest('hex');
  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/ok') { res.writeHead(200); res.end(payload); return; }
      if (req.url === '/big') { res.writeHead(200); res.end(Buffer.alloc(2000)); return; }
      if (req.url === '/jump') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    base = 'http://127.0.0.1:' + addr.port;
    host = '127.0.0.1:' + addr.port;
  });
  afterAll(() => server.close());
  it('loopback denied by default (SSRF line)', async () => {
    const r = await fetchPayload({ ref_uri: base + '/ok', sha256: payloadSha, size: payload.length });
    expect(r.ok).toBe(false);
  });
  it('allowlist pass + sha256/size ok', async () => {
    const r = await fetchPayload({ ref_uri: base + '/ok', sha256: payloadSha, size: payload.length }, { allowedSchemes: ['https', 'http'], allowHosts: [host] });
    expect(r.ok).toBe(true);
    expect(r.data?.toString()).toBe('hello payload');
  });
  it('R10:重定向一律拒绝(不跟随,防白名单借道私网)', async () => {
    const r = await fetchPayload({ ref_uri: base + '/jump', sha256: payloadSha, size: payload.length }, { allowedSchemes: ['https', 'http'], allowHosts: [host] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('302'); // 不跟随:3xx 按 HTTP 错误拒绝(opaqueredirect 不产生第二次请求)
  });
  it('sha256 mismatch -> corrupt', async () => {
    const r = await fetchPayload({ ref_uri: base + '/ok', sha256: 'f'.repeat(64), size: payload.length }, { allowedSchemes: ['https', 'http'], allowHosts: [host] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('sha256');
  });
  it('404 -> unavailable', async () => {
    const r = await fetchPayload({ ref_uri: base + '/missing', sha256: payloadSha, size: 1 }, { allowedSchemes: ['https', 'http'], allowHosts: [host] });
    expect(r.ok).toBe(false);
  });
  it('size mismatch -> reject', async () => {
    const r = await fetchPayload({ ref_uri: base + '/big', sha256: 'x'.repeat(64), size: 1 }, { allowedSchemes: ['https', 'http'], allowHosts: [host] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('size');
  });
});

describe('gate5 requires precheck (pure fn)', () => {
  const profile = { toolWhitelist: ['ffmpeg'], netWhitelist: ['office-vpn'], confirmChannel: true };
  it('whitelisted tool passes', () => {
    expect(checkRequires([{ cls: 'tool', value: 'ffmpeg', reason: 'r' }], profile)).toEqual([]);
  });
  it('tool outside whitelist -> violation', () => {
    expect(checkRequires([{ cls: 'tool', value: 'unknown-bin', reason: 'r' }], profile)).toHaveLength(1);
  });
  it('net egress outside whitelist -> violation', () => {
    expect(checkRequires([{ cls: 'net', value: 'datacenter-vpn', reason: 'r' }], profile)).toHaveLength(1);
  });
  it('no confirm channel -> violation', () => {
    expect(checkRequires([{ cls: 'confirm', value: 'x', reason: 'r' }], { ...profile, confirmChannel: false })).toHaveLength(1);
  });
});
