import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { GatewayCore } from '../src/core.js';
import { AUTH_KEY, WsGateway, type WsGatewayOptions } from '../src/ws.js';
import { LocalClaimRegistry } from '../src/claim.js';
import { waitFor } from './wait.js';

const node = { node_id: 'presence-node', team_id: 'presence-team', status: 'active' };
const gateways: WsGateway[] = [];
const clients: WebSocket[] = [];
const servers: Server[] = [];

interface PresenceEvent {
  nodeId: string;
  online: boolean;
  connId: string;
  coreConnId: string | undefined;
}

function makeGateway(overrides: Partial<WsGatewayOptions> = {}) {
  const core = overrides.core ?? new GatewayCore();
  const presence: PresenceEvent[] = [];
  const gateway = new WsGateway({
    ...overrides,
    core,
    authenticate: overrides.authenticate ?? (() => node),
    onPresenceChange(nodeId, online, connId) {
      presence.push({ nodeId, online, connId, coreConnId: core.connections.get(nodeId)?.connId });
      overrides.onPresenceChange?.(nodeId, online, connId);
    },
  });
  gateways.push(gateway);
  return { gateway, core, presence };
}

/** Persistent collectors are installed before auth, so close/message races cannot lose events. */
async function connect(gateway: WsGateway, port: number, path = '/') {
  const accepted = new Promise<WebSocket>((resolve) => gateway.wss.once('connection', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  clients.push(ws);
  const opened = once(ws, 'open');
  ws.on('error', () => { /* Connection failures reject opened; teardown must not emit uncaught errors. */ });
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await opened;
  const serverWs = await accepted;
  const serverClosed = new Promise<void>((resolve) => serverWs.once('close', () => resolve()));
  return {
    ws, serverWs, frames, closed, serverClosed,
    sendAuth() { ws.send(JSON.stringify({ frame: 'auth', [AUTH_KEY]: 'presence-fixture' })); },
    async waitForFrame(frame: string) {
      expect(await waitFor(() => frames.some((f) => f.frame === frame))).toBe(true);
      return frames.find((f) => f.frame === frame)!;
    },
  };
}

async function listenHttp(server: Server, port = 0): Promise<number> {
  const listening = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  await listening;
  return (server.address() as AddressInfo).port;
}

function expectOffline(fixture: ReturnType<typeof makeGateway>): void {
  expect(fixture.gateway.has(node.node_id)).toBe(false);
  expect(fixture.core.connections.size).toBe(0);
}

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

describe('WsGateway single-instance presence lifecycle', () => {
  it('notifies after core.connect, before sending auth_ok, and once after close cleanup', async () => {
    const order: string[] = [];
    const core = new GatewayCore();
    const originalConnect = core.connect.bind(core);
    vi.spyOn(core, 'connect').mockImplementation((connection) => {
      originalConnect(connection);
      order.push('connect');
    });
    let sendsBeforePresence = -1;
    const fixture = makeGateway({
      core,
      authenticate: () => { order.push('authenticate'); return node; },
      onPresenceChange: (_nodeId, online) => {
        order.push(online ? 'online' : 'offline');
        if (online) sendsBeforePresence = send.mock.calls.length;
      },
    });
    const client = await connect(fixture.gateway, await fixture.gateway.listen());
    const send = vi.spyOn(client.serverWs, 'send');
    expect(fixture.presence).toEqual([]);
    client.sendAuth();
    await client.waitForFrame('auth_ok');
    order.push('auth_ok');
    const connId = core.connections.get(node.node_id)!.connId;
    expect(sendsBeforePresence).toBe(0);
    expect(order).toEqual(['authenticate', 'connect', 'online', 'auth_ok']);
    expect(fixture.presence).toEqual([{ nodeId: node.node_id, online: true, connId, coreConnId: connId }]);
    client.ws.close();
    await client.serverClosed;
    expectOffline(fixture);
    expect(fixture.presence[1]).toEqual({ nodeId: node.node_id, online: false, connId, coreConnId: undefined });
    await fixture.gateway.close();
    expect(fixture.presence).toHaveLength(2);
  });

  it('ignores a replaced connection error and delayed close without taking its successor offline', async () => {
    const fixture = makeGateway();
    const port = await fixture.gateway.listen();
    const old = await connect(fixture.gateway, port);
    old.sendAuth();
    await old.waitForFrame('auth_ok');
    old.ws.pause();
    const current = await connect(fixture.gateway, port);
    current.sendAuth();
    await current.waitForFrame('auth_ok');
    const connId = fixture.core.connections.get(node.node_id)!.connId;
    expect(connId).not.toBe(fixture.presence[0]!.connId);
    expect(() => old.serverWs.emit('error', new Error('old connection error'))).not.toThrow();
    old.ws.resume();
    expect((await old.closed).code).toBe(4000);
    await old.serverClosed;
    expect(fixture.presence.map((event) => event.online)).toEqual([true, true]);
    expect(fixture.gateway.has(node.node_id)).toBe(true);
    expect(fixture.core.connections.get(node.node_id)?.connId).toBe(connId);
    current.ws.close();
    await current.serverClosed;
    expectOffline(fixture);
    expect(fixture.presence.map((event) => [event.online, event.connId])).toEqual([
      [true, fixture.presence[0]!.connId], [true, connId], [false, connId],
    ]);
  });

  it('claims a monotonic generation on connect, increments on reconnect, releases on disconnect (D1a)', async () => {
    const claimRegistry = new LocalClaimRegistry();
    const fixture = makeGateway({ claimRegistry, authorityId: 'gwA' });
    const port = await fixture.gateway.listen();
    const first = await connect(fixture.gateway, port);
    first.sendAuth();
    await first.waitForFrame('auth_ok');
    // 连接携带 generation;claim 注册表登记现归属(单 authority 首认领 = gen 1)
    expect(fixture.core.connections.get(node.node_id)!.generation).toBe(1);
    expect(claimRegistry.lookup(node.node_id)).toEqual({ nodeId: node.node_id, authorityId: 'gwA', generation: 1 });

    // 重连:新连接超越旧(M2-03 踢旧),generation 单调 +1
    const second = await connect(fixture.gateway, port);
    second.sendAuth();
    await second.waitForFrame('auth_ok');
    expect(fixture.core.connections.get(node.node_id)!.generation).toBe(2);
    expect(claimRegistry.lookup(node.node_id)?.generation).toBe(2);

    // 断连:当前连接释放 claim(被踢的旧连接经 M2-03 守卫不释放)
    second.ws.close();
    await second.serverClosed;
    expectOffline(fixture);
    expect(claimRegistry.lookup(node.node_id)).toBeUndefined();
  });

  it.each([{ status: 'suspended', code: 4001 }, { status: 'revoked', code: 4002 }])(
    'notifies offline synchronously on admin $status and retains close code $code',
    async ({ status, code }) => {
      const fixture = makeGateway();
      const client = await connect(fixture.gateway, await fixture.gateway.listen());
      client.sendAuth();
      await client.waitForFrame('auth_ok');
      const connId = fixture.presence[0]!.connId;
      fixture.gateway.syncRegistry({ epoch: 1, nodes: [] }, () => status);
      expectOffline(fixture);
      expect(fixture.presence[1]).toEqual({ nodeId: node.node_id, online: false, connId, coreConnId: undefined });
      expect(await client.closed).toEqual({ code, reason: status });
      expect(await client.waitForFrame('closing')).toMatchObject({ code, reason: status });
      await client.serverClosed;
      fixture.gateway.syncRegistry({ epoch: 2, nodes: [] }, () => status);
      expect(fixture.presence).toHaveLength(2);
    },
  );

  it.each(['throw', 'missing', 'suspended', 'revoked'])('fails closed for authentication %s without presence', async (mode) => {
    const authenticate = vi.fn<WsGatewayOptions['authenticate']>(() => node).mockImplementationOnce(() => {
      if (mode === 'throw') throw new Error('authentication failed');
      return mode === 'missing' ? undefined : { ...node, status: mode };
    });
    const fixture = makeGateway({ authenticate });
    const port = await fixture.gateway.listen();
    const failed = await connect(fixture.gateway, port);
    failed.sendAuth();
    failed.sendAuth(); // Buffered frames must not authenticate after the first failure starts closing.
    expect((await failed.closed).code).toBe(4003);
    await failed.serverClosed;
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(failed.frames).toEqual([]);
    expect(fixture.presence).toEqual([]);
    expectOffline(fixture);
    const healthy = await connect(fixture.gateway, port);
    healthy.sendAuth();
    await healthy.waitForFrame('auth_ok');
    expect(fixture.gateway.has(node.node_id)).toBe(true);
  });

  it('rolls back a throwing online hook, contains rollback exceptions, and accepts later connections', async () => {
    let fail = true;
    const fixture = makeGateway({ onPresenceChange: () => { if (fail) throw new Error('presence failed'); } });
    const port = await fixture.gateway.listen();
    const client = await connect(fixture.gateway, port);
    client.sendAuth();
    expect((await client.closed).code).toBe(1011);
    await client.serverClosed;
    expect(client.frames).toEqual([]);
    expectOffline(fixture);
    expect(fixture.presence.map((event) => event.online)).toEqual([true, false]);
    expect(fixture.presence[1]!.connId).toBe(fixture.presence[0]!.connId);
    fail = false;
    const healthy = await connect(fixture.gateway, port);
    healthy.sendAuth();
    await healthy.waitForFrame('auth_ok');
    expect(fixture.gateway.has(node.node_id)).toBe(true);
  });

  it('does not notify online or send auth_ok when core.connect throws', async () => {
    const fixture = makeGateway();
    vi.spyOn(fixture.core, 'connect').mockImplementationOnce(() => { throw new Error('connect failed'); });
    const client = await connect(fixture.gateway, await fixture.gateway.listen());
    client.sendAuth();
    expect((await client.closed).code).toBe(1011);
    await client.serverClosed;
    expect(client.frames).toEqual([]);
    expect(fixture.presence.some((event) => event.online)).toBe(false);
    expectOffline(fixture);
  });

  it.each(['close', 'error', 'suspended', 'revoked', 'shutdown'])(
    'contains a throwing offline hook during %s and never repeats the notification',
    async (cause) => {
      const fixture = makeGateway({
        onPresenceChange: (_nodeId, online) => { if (!online) throw new Error('offline failed'); },
      });
      const client = await connect(fixture.gateway, await fixture.gateway.listen());
      client.sendAuth();
      await client.waitForFrame('auth_ok');
      if (cause === 'close') client.ws.close();
      else if (cause === 'error') {
        expect(() => client.serverWs.emit('error', new Error('transport failed'))).not.toThrow();
        expectOffline(fixture); // Error cleanup cannot wait for the eventual close event.
      } else if (cause === 'shutdown') await fixture.gateway.close();
      else expect(() => fixture.gateway.syncRegistry({ epoch: 1, nodes: [] }, () => cause)).not.toThrow();
      await client.serverClosed;
      await fixture.gateway.close();
      expectOffline(fixture);
      expect(fixture.presence.map((event) => event.online)).toEqual([true, false]);
      expect(fixture.presence[1]!.coreConnId).toBeUndefined();
    },
  );
});

describe('WsGateway listen and shutdown lifecycle', () => {
  it('rejects EADDRINUSE, removes temporary listeners, and closes safely after failed listen', async () => {
    const occupied = createServer();
    servers.push(occupied);
    const port = await listenHttp(occupied);
    const { gateway } = makeGateway();
    // Node's HTTP server already owns a listening hook; only our temporary listeners leave.
    const before = gateway.server.listeners('listening');
    await expect(gateway.listen(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(gateway.server.listenerCount('error')).toBe(0);
    expect(gateway.server.listeners('listening')).toEqual(before);
    await Promise.all([gateway.close(), gateway.close()]);
    expect(gateway.server.listening).toBe(false);
    expect(gateway.server.listenerCount('upgrade')).toBe(0);
    expect(occupied.listening).toBe(true);
  });

  it('allows a listen retry after failure and awaits the HTTP close event before resolving', async () => {
    const occupied = createServer();
    servers.push(occupied);
    const { gateway } = makeGateway();
    await expect(gateway.listen(await listenHttp(occupied))).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const port = await gateway.listen();
    let serverClosed = false;
    gateway.server.once('close', () => { serverClosed = true; });
    const closing = gateway.close();
    expect(gateway.close()).toBe(closing);
    await closing;
    expect(serverClosed).toBe(true);
    expect(gateway.server.address()).toBeNull();
    expect(gateway.close()).toBe(closing);
    await expect(gateway.listen()).rejects.toThrow('closing');
    const rebound = createServer();
    servers.push(rebound);
    expect(await listenHttp(rebound, port)).toBe(port);
  });

  it('handles close racing an in-flight listen and close before any listen', async () => {
    const { gateway } = makeGateway();
    const listening = gateway.listen();
    await Promise.all([listening, gateway.close()]);
    expect(gateway.server.listening).toBe(false);
    await makeGateway().gateway.close();
  });

  it('bounds shutdown for unresponsive authenticated and unauthenticated clients', async () => {
    const fixture = makeGateway();
    const port = await fixture.gateway.listen();
    const authenticated = await connect(fixture.gateway, port);
    authenticated.sendAuth();
    await authenticated.waitForFrame('auth_ok');
    const unauthenticated = await connect(fixture.gateway, port);
    authenticated.ws.pause();
    unauthenticated.ws.pause();
    const started = Date.now();
    const closing = fixture.gateway.close();
    expect(fixture.gateway.close()).toBe(closing);
    // Presence is removed before waiting for either client's close handshake.
    await Promise.resolve();
    expectOffline(fixture);
    await closing;
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(fixture.gateway.wss.clients.size).toBe(0);
    expect(fixture.gateway.server.listening).toBe(false);
    expect(fixture.presence.map((event) => event.online)).toEqual([true, false]);
    authenticated.ws.resume();
    unauthenticated.ws.resume();
    await Promise.all([authenticated.closed, unauthenticated.closed]);
  }, 4_000);

  it('detaches its upgrade listener without closing an attached server or removing other listeners', async () => {
    const attached = createServer((_req, res) => res.end('ok'));
    servers.push(attached);
    const unrelated = vi.fn();
    attached.on('upgrade', unrelated);
    const port = await listenHttp(attached);
    const fixture = makeGateway();
    fixture.gateway.attach(attached, '/gateway');
    fixture.gateway.attach(attached, '/gateway');
    fixture.gateway.attach(attached, '/another-gateway');
    expect(attached.listeners('upgrade')).toHaveLength(2);
    const client = await connect(fixture.gateway, port, '/gateway');
    client.sendAuth();
    await client.waitForFrame('auth_ok');
    await fixture.gateway.close();
    await client.serverClosed;
    expectOffline(fixture);
    expect(fixture.presence.map((event) => event.online)).toEqual([true, false]);
    expect(attached.listeners('upgrade')).toEqual([unrelated]);
    expect(attached.listening).toBe(true);
    expect(fixture.gateway.wss.clients.size).toBe(0);
    expect(() => fixture.gateway.attach(attached, '/late')).toThrow('closing');
  });
});