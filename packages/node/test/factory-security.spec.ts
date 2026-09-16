import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, newKeyPair, signEnvelope, toBase64, validateEnvelope, type EnvelopeV1 } from '@qlong/core';
import { Registry, createRegistryServer } from '../../registry/src/index.js';
import { GatewayCore } from '../../gateway/src/core.js';
import { WsGateway } from '../../gateway/src/ws.js';
import { loadOrCreateIdentity } from '../src/identity.js';
import { createProductionNode, type ProductionNode, type ProductionNodeOptions } from '../src/remote/factory.js';
import { REGISTRY_TIMEOUT_MS } from '../src/remote/registry-verifier.js';

interface Fault {
  status?: number;
  body?: unknown;
  raw?: string;
  redirect?: string;
  hang?: boolean;
  disconnect?: boolean;
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'qlong-factory-security-'));
  const dataDir = join(dir, 'receiver');
  const senderDir = join(dir, 'sender');
  const identity = loadOrCreateIdentity(dataDir);
  const senderIdentity = loadOrCreateIdentity(senderDir);
  const registry = new Registry();
  const team = registry.createTeam({ owner_user_id: 'factory-security-test' });
  const enroll = (pubkey: string) => registry.enroll({ token: registry.issueEnrollToken(team.team_id), pubkey });
  const receiver = enroll(identity.pubkeyB64);
  const sender = enroll(senderIdentity.pubkeyB64);
  const core = new GatewayCore();
  const gw = new WsGateway({
    core,
    authenticate: (token) => {
      try {
        const n = registry.authByToken(token);
        return { node_id: n.node_id, team_id: n.team_id, status: n.status };
      } catch {
        return undefined;
      }
    },
  });
  gw.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
  // Keep a stale gateway snapshot intentionally: endpoint verification must catch revocation itself.
  const faults: { me?: Fault; key?: Fault } = {};
  const paths: string[] = [];
  const registryApi = createRegistryServer({ registry });
  const http = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET') paths.push(req.url ?? ''); // Never record headers/tokens/bodies.
    const fault = path === '/v1/nodes/me' ? faults.me : path?.endsWith('/pubkey') ? faults.key : undefined;
    if (!fault) {
      registryApi.emit('request', req, res);
      return;
    }
    if (fault.hang) return;
    if (fault.disconnect) { res.destroy(); return; }
    res.writeHead(fault.redirect ? 302 : fault.status ?? 200,
      fault.redirect ? { Location: fault.redirect } : { 'Content-Type': 'application/json' });
    res.end(fault.raw ?? JSON.stringify(fault.body ?? null));
  });
  const nodes: ProductionNode[] = [];
  const driver = { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  cleanup.push(async () => {
    for (const node of nodes) { node.session.dispose(); node.stop(); }
    await gw.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    expect(driver.start).not.toHaveBeenCalled();
  });
  const [gatewayPort, registryPort] = await Promise.all([
    gw.listen(0, '127.0.0.1'),
    new Promise<number>((resolve) => http.listen(0, '127.0.0.1', () => resolve((http.address() as { port: number }).port))),
  ]);
  const registryUrl = `http://127.0.0.1:${registryPort}`;
  async function build(overrides: Partial<ProductionNodeOptions> = {}) {
    const node = await createProductionNode({
      registryUrl, gatewayUrl: `ws://127.0.0.1:${gatewayPort}`, nodeToken: receiver.node_token,
      dataDir, driver, reportIntervalMs: 0, capabilities: () => ['tool:node@20'], ...overrides,
    });
    nodes.push(node);
    return node;
  }
  async function boot(overrides: Partial<ProductionNodeOptions> = {}) {
    const node = await build(overrides);
    const received = vi.spyOn(node.session, 'onEnvelope'); // Preserve real session dispatch, not its verifier.
    await node.start();
    expect(node.client.state).toBe('authed');
    return { node, received };
  }
  function envelope(overrides: Partial<EnvelopeV1> = {}, priv = senderIdentity.priv): EnvelopeV1 {
    return signEnvelope({
      v: 1, type: 'rpc.answer', msg_id: newId(), ts: new Date().toISOString(),
      exp: new Date(Date.now() + 60_000).toISOString(),
      from: { node_id: sender.node_id, team_id: team.team_id, key_epoch: 1 },
      to: { node_id: receiver.node_id, team_id: team.team_id },
      trace: { trace_id: newId(), parent_span: null, origin_node: sender.node_id },
      reply_to: newId(), body: { request_id: newId(), answer: { summary: 'signed answer' }, refs: [] },
      ...overrides,
    }, priv);
  }
  function send(env: EnvelopeV1) {
    expect(validateEnvelope(env).ok).toBe(true); // Must pass schema before exercising security gates.
    gw.deliverTo(receiver.node_id, env); // Production relay path, including deliberately misaddressed frames.
  }
  const keyPaths = () => paths.filter((path) => path.includes('/pubkey?'));
  const me = () => ({
    node_id: receiver.node_id, team_id: receiver.team_id, key_epoch: receiver.key_epoch,
    status: 'active', pubkeys: [{ epoch: 1, pubkey: identity.pubkeyB64 }],
  });
  const key = () => ({ node_id: sender.node_id, status: 'current', key_epoch: 1, pubkey: senderIdentity.pubkeyB64 });
  return { dir, dataDir, senderDir, identity, senderIdentity, registry, registryUrl, receiver, sender, team,
    faults, paths, keyPaths, build, boot, envelope, send, me, key };
}

type Harness = Awaited<ReturnType<typeof harness>>;
async function denied(h: Harness, c: Awaited<ReturnType<Harness['boot']>>, env: EnvelopeV1) {
  const rejected = c.node.client.rejectedInbound;
  const delivered = c.received.mock.calls.length;
  h.send(env);
  await vi.waitFor(() => expect(c.node.client.rejectedInbound).toBe(rejected + 1));
  expect(c.received).toHaveBeenCalledTimes(delivered);
  expect(c.node.client.state).toBe('authed');
}

async function creationDenied(h: Harness, overrides: Partial<ProductionNodeOptions> = {}) {
  // Never assert a returned node/options object: an unexpected success could print private seed fields.
  const failure = await h.build(overrides).then(() => null, (error: unknown) => error);
  expect(failure instanceof Error).toBe(true);
  const message = failure instanceof Error ? failure.message : '';
  expect(message.includes('response-body-marker')).toBe(false);
  return message;
}

describe('production factory trust chain over Registry HTTP and WebSocket', () => {
  it('two production factories exchange a signed RPC without running a model', async () => {
    const h = await harness();
    const receiver = await h.boot();
    const sender = await h.boot({ nodeToken: h.sender.node_token, dataDir: h.senderDir });
    expect(await sender.node.session.ask(h.receiver.node_id, 'caps.query')).toEqual({ caps: ['tool:node@20'], load: null });
    expect(receiver.received).toHaveBeenCalledOnce();
    for (const [env] of receiver.received.mock.calls) expect(validateEnvelope(env).ok).toBe(true);
    expect(receiver.node.client.rejectedInbound + sender.node.client.rejectedInbound).toBe(0);
    expect(h.keyPaths()).toHaveLength(2);
  });

  it('accepts current and historical epochs using the exact signed epoch', async () => {
    const h = await harness();
    const c = await h.boot();
    h.send(h.envelope());
    await vi.waitFor(() => expect(c.received).toHaveBeenCalledOnce());
    const rotated = newKeyPair();
    // Seed directory rotation state; rotation authorization is covered by Registry tests.
    h.registry.getNode(h.sender.node_id)!.keys.push({ epoch: 2, pubkey: toBase64(rotated.publicKey) });
    h.send(h.envelope());
    h.send(h.envelope({ from: { node_id: h.sender.node_id, team_id: h.team.team_id, key_epoch: 2 } }, rotated.priv));
    await vi.waitFor(() => expect(c.received).toHaveBeenCalledTimes(3));
    expect(h.keyPaths().filter((path) => path.endsWith('epoch=1'))).toHaveLength(2);
    expect(h.keyPaths().filter((path) => path.endsWith('epoch=2'))).toHaveLength(1);
  });

  it.each(['tamper', 'bad signature', 'wrong signer'] as const)('denies %s after successful schema validation', async (kind) => {
    const h = await harness();
    const c = await h.boot();
    const env = h.envelope();
    if (kind === 'tamper') env.body.answer = { summary: 'tampered answer' };
    if (kind === 'bad signature') env.sig = { alg: 'ed25519', value: toBase64(new Uint8Array(64)) };
    if (kind === 'wrong signer') env.from.node_id = h.receiver.node_id;
    await denied(h, c, kind === 'wrong signer' ? signEnvelope(env, h.senderIdentity.priv) : env);
  });

  it('a schema-valid tampered task.offer never reaches the executor', async () => {
    const h = await harness();
    const c = await h.boot();
    const env = h.envelope({
      type: 'task.offer', task_id: newId(), attempt: 1, hops: 0,
      body: { kind: 'aid', summary: 'signed task', lease_ms: 120000, offer_ttl_ms: 10000 },
    });
    env.body.summary = 'tampered task';
    await denied(h, c, env);
  });

  it('unknown epoch performs one lookup per message, without fallback or refresh loops', async () => {
    const h = await harness();
    const c = await h.boot();
    const env = () => h.envelope({ from: { node_id: h.sender.node_id, team_id: h.team.team_id, key_epoch: 999 } });
    await denied(h, c, env());
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.keyPaths()).toHaveLength(1);
    await denied(h, c, env());
    expect(h.keyPaths()).toHaveLength(2);
    expect(h.keyPaths().every((path) => path.endsWith('epoch=999'))).toBe(true);
  });

  it.each(['sender revoked', 'sender suspended', 'receiver revoked'] as const)('fresh lookup rejects %s after an accepted message', async (kind) => {
    const h = await harness();
    const c = await h.boot();
    h.send(h.envelope());
    await vi.waitFor(() => expect(c.received).toHaveBeenCalledOnce());
    if (kind === 'sender suspended') h.registry.suspend(h.sender.node_id);
    else h.registry.revoke(kind === 'receiver revoked' ? h.receiver.node_id : h.sender.node_id);
    await denied(h, c, h.envelope());
    expect(h.keyPaths()).toHaveLength(2);
  });

  it.each(['from team', 'to team', 'to node', 'missing from team', 'missing to team'] as const)('binds %s before lookup', async (kind) => {
    const h = await harness();
    const c = await h.boot();
    const env = h.envelope();
    if (kind === 'from team') env.from.team_id = newId();
    if (kind === 'to team') env.to.team_id = newId();
    if (kind === 'to node') env.to.node_id = newId();
    if (kind === 'missing from team') delete env.from.team_id;
    if (kind === 'missing to team') delete env.to.team_id;
    await denied(h, c, signEnvelope(env, h.senderIdentity.priv));
    expect(h.keyPaths()).toHaveLength(0);
  });

  it('does not trust a foreign node that claims the local team', async () => {
    const h = await harness();
    const c = await h.boot();
    const pair = newKeyPair();
    const foreign = h.registry.enroll({ pubkey: toBase64(pair.publicKey) });
    await denied(h, c, h.envelope({ from: { node_id: foreign.node_id, team_id: h.team.team_id, key_epoch: 1 } }, pair.priv));
    expect(h.keyPaths()).toHaveLength(1);
  });

  it.each(['outage', 'disconnect', 'malformed JSON', 'null', 'array', 'wrong node', 'wrong epoch',
    'wrong status', 'wrong team', 'short key', 'long key', 'noncanonical key', 'wrong key', 'invalid point', 'redirect'] as const)(
    'directory %s fails closed', async (kind) => {
      const h = await harness();
      const c = await h.boot();
      const body: Record<string, unknown> = h.key();
      const fault: Fault = { body };
      if (kind === 'outage') { fault.status = 503; fault.raw = 'response-body-marker'; }
      if (kind === 'disconnect') fault.disconnect = true;
      if (kind === 'malformed JSON') fault.raw = '{response-body-marker';
      if (kind === 'null') fault.body = null;
      if (kind === 'array') fault.body = [body];
      if (kind === 'wrong node') body.node_id = h.receiver.node_id;
      if (kind === 'wrong epoch') body.key_epoch = 2;
      if (kind === 'wrong status') body.status = 'revoked';
      if (kind === 'wrong team') body.team_id = newId();
      if (kind === 'short key') body.pubkey = toBase64(new Uint8Array(31));
      if (kind === 'long key') body.pubkey = toBase64(new Uint8Array(33));
      if (kind === 'noncanonical key') body.pubkey = toBase64(new Uint8Array(32)).slice(0, -2) + 'B=';
      if (kind === 'wrong key') body.pubkey = h.identity.pubkeyB64;
      if (kind === 'invalid point') body.pubkey = toBase64(new Uint8Array(32).fill(255));
      if (kind === 'redirect') fault.redirect = h.registryUrl + '/redirect-target';
      h.faults.key = fault;
      await denied(h, c, h.envelope());
      expect(h.paths.includes('/redirect-target')).toBe(false);
    },
  );

  it.each(['throw', 'reject'] as const)('fetch %s cannot escape the verifier', async (kind) => {
    const h = await harness();
    const c = await h.boot();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      if (kind === 'throw') throw new Error('response-body-marker');
      return Promise.reject(new Error('response-body-marker'));
    });
    await denied(h, c, h.envelope());
  });

  it('aborts stalled directory requests at the configured timeout', async () => {
    const h = await harness();
    const c = await h.boot();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const configured: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => { configured.push(ms); return timeout(25); });
    h.faults.key = { hang: true };
    await denied(h, c, h.envelope());
    expect(configured).toContain(REGISTRY_TIMEOUT_MS);
  });
});

describe('factory restores and binds enrolled identity without replacing it', () => {
  it.each(['no identity', 'missing file', 'missing directory', 'broken JSON', 'broken keypair', 'empty seed', 'short seed', 'wrong seed'] as const)(
    '%s prevents construction and never overwrites identity', async (kind) => {
      const h = await harness();
      const file = join(h.dataDir, 'identity.json');
      const opts: Partial<ProductionNodeOptions> = {};
      if (kind === 'no identity') opts.dataDir = undefined;
      if (kind === 'missing file') rmSync(file);
      if (kind === 'missing directory') opts.dataDir = join(h.dir, 'not-created');
      if (kind === 'broken JSON') writeFileSync(file, '{response-body-marker');
      if (kind === 'broken keypair') writeFileSync(file, JSON.stringify({
        priv_b64: toBase64(newKeyPair().priv), pubkey_b64: h.identity.pubkeyB64,
      }));
      if (kind === 'empty seed') opts.privKey = new Uint8Array(0);
      if (kind === 'short seed') opts.privKey = new Uint8Array(31);
      if (kind === 'wrong seed') opts.privKey = newKeyPair().priv;
      const before = existsSync(file) ? readFileSync(file) : null;
      await creationDenied(h, opts);
      expect(existsSync(file)).toBe(before !== null);
      if (before) expect(readFileSync(file).equals(before)).toBe(true); // Boolean only, never print private file bytes.
      expect(existsSync(join(h.dir, 'not-created'))).toBe(false);
      if (kind !== 'wrong seed') expect(h.paths).toHaveLength(0);
    },
  );

  it.each(['null', 'array', 'inactive', 'bad node', 'bad team', 'missing epoch', 'fractional epoch', 'no current key',
    'duplicate epoch', 'malformed pubkeys', 'bad base64', 'short key', 'wrong current key', 'conflicting aliases'] as const)(
    'rejects /me %s without reconstructing or guessing identity', async (kind) => {
      const h = await harness();
      const body: Record<string, unknown> = h.me();
      if (kind === 'inactive') body.status = 'suspended';
      if (kind === 'bad node') body.node_id = '../wrong';
      if (kind === 'bad team') body.team_id = '';
      if (kind === 'missing epoch') delete body.key_epoch;
      if (kind === 'fractional epoch') body.key_epoch = 1.5;
      if (kind === 'no current key') body.key_epoch = 2;
      if (kind === 'duplicate epoch') body.pubkeys = [h.me().pubkeys[0], h.me().pubkeys[0]];
      if (kind === 'malformed pubkeys') { body.pubkeys = null; body.keys = h.me().pubkeys; }
      if (kind === 'bad base64') body.pubkeys = [{ epoch: 1, pubkey: h.identity.pubkeyB64 + '\n' }];
      if (kind === 'short key') body.pubkeys = [{ epoch: 1, pubkey: toBase64(new Uint8Array(31)) }];
      if (kind === 'wrong current key') body.pubkeys = [{ epoch: 1, pubkey: h.senderIdentity.pubkeyB64 }];
      if (kind === 'conflicting aliases') body.keys = [{ epoch: 1, pubkey: h.senderIdentity.pubkeyB64 }];
      h.faults.me = { body: kind === 'null' ? null : kind === 'array' ? [body] : body };
      const file = join(h.dataDir, 'identity.json');
      const before = readFileSync(file);
      await creationDenied(h);
      expect(readFileSync(file).equals(before)).toBe(true);
    },
  );

  it.each(['pubkeys', 'keys'] as const)('uses only explicit current epoch with %s, not array order or maximum', async (field) => {
    const h = await harness();
    const body: Record<string, unknown> = h.me();
    delete body.pubkeys;
    body.key_epoch = 7;
    body[field] = [{ epoch: 99, pubkey: h.senderIdentity.pubkeyB64 },
      { epoch: 7, pubkey: h.identity.pubkeyB64 }, { epoch: 1, pubkey: h.senderIdentity.pubkeyB64 }];
    h.faults.me = { body };
    const node = await h.build({ dataDir: undefined, privKey: h.identity.priv });
    expect(node.session.opts.keyEpoch).toBe(7);
  });

  it.each(['HTTP error', 'JSON error', 'redirect', 'timeout'] as const)('sanitizes /me %s and fails closed', async (kind) => {
    const h = await harness();
    if (kind === 'HTTP error') h.faults.me = { status: 503, raw: 'response-body-marker' };
    if (kind === 'JSON error') h.faults.me = { raw: '{response-body-marker' };
    if (kind === 'redirect') h.faults.me = { redirect: h.registryUrl + '/redirect-target' };
    if (kind === 'timeout') {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(25));
      h.faults.me = { hang: true };
    }
    await creationDenied(h);
    expect(h.paths.includes('/redirect-target')).toBe(false);
  });
});