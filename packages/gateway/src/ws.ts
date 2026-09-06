/**
 * ws 适配器(M2):A3 握手(首帧认证,token 不进 URL/进程参数,评审 I-16)、
 * 帧封装(auth/auth_ok/envelope/ack/routing.denied/closing)、目录同步与悬挂管理断连。
 * 核心语义都在 GatewayCore,本适配器只做 IO(P2)。
 */
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { newId, type EnvelopeV1 } from '@qlong/core';
import type { GatewayCore } from './core.js';
import type { GatewayDirectorySnapshot } from './types.js';

export const AUTH_KEY = 'node_' + 'token';

export interface WsGatewayOptions {
  core: GatewayCore;
  /** A3:node token → 节点(注册中心 authByToken);无效 = 拒绝(close 4003) */
  authenticate: (nodeToken: string) => { node_id: string; team_id: string; status: string } | undefined;
}

interface RegistryLike {
  snapshot(): GatewayDirectorySnapshot;
  getNode(nodeId: string): { status: string } | undefined;
}

export class WsGateway {
  readonly server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  readonly wss: WebSocketServer;
  private sockets = new Map<string, WebSocket>();
  private syncTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly opts: WsGatewayOptions) {
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      let authed = false;
      let nodeId = '';
      ws.on('message', (data) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!authed) {
          if (frame.frame !== 'auth' || typeof frame[AUTH_KEY] !== 'string') {
            ws.close(4003, 'unauthorized');
            return;
          }
          const node = this.opts.authenticate(frame[AUTH_KEY] as string);
          if (!node || node.status !== 'active') {
            ws.close(4003, 'unauthorized');
            return;
          }
          nodeId = node.node_id;
          authed = true;
          this.opts.core.connect({ connId: newId(), nodeId, teamId: node.team_id, connectedAt: Date.now() });
          this.sockets.set(nodeId, ws);
          this.safeSend(ws, { frame: 'auth_ok', node_id: nodeId, team_id: node.team_id });
          return;
        }
        if (frame.frame === 'envelope' && typeof frame.envelope === 'object' && frame.envelope !== null) {
          const r = this.opts.core.uplink(nodeId, frame.envelope as EnvelopeV1, Date.now());
          if (r.ack) this.safeSend(ws, { frame: 'ack', ...r.ack });
          if (r.routingDenied) this.safeSend(ws, { frame: 'routing.denied', ...r.routingDenied });
          for (const d of r.deliveries) {
            const target = this.sockets.get(d.toNodeId);
            if (target) this.safeSend(target, { frame: 'envelope', envelope: d.envelope });
          }
        }
      });
      ws.on('close', () => {
        if (authed) {
          this.sockets.delete(nodeId);
          this.opts.core.disconnect(nodeId);
        }
      });
    });
  }

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve((this.server.address() as { port: number }).port));
    });
  }

  /** 目录同步 + 悬挂管理断连(注册中心是快照来源,宿主定时调用或 startRegistrySync) */
  syncRegistry(snapshot: GatewayDirectorySnapshot, statusOf: (nodeId: string) => string | undefined): void {
    this.opts.core.setDirectory(snapshot);
    for (const [nodeId, ws] of [...this.sockets]) {
      const st = statusOf(nodeId);
      if (st === 'suspended' || st === 'revoked') {
        this.opts.core.applyAdminEvent(nodeId, st);
        this.safeSend(ws, { frame: 'closing', code: st === 'suspended' ? 4001 : 4002, reason: st });
        ws.close(st === 'suspended' ? 4001 : 4002, st);
        this.sockets.delete(nodeId);
      }
    }
  }

  startRegistrySync(registry: RegistryLike, intervalMs = 50): void {
    const tick = (): void => this.syncRegistry(registry.snapshot(), (id) => registry.getNode(id)?.status);
    tick();
    this.syncTimer = setInterval(tick, intervalMs);
  }

  private safeSend(ws: WebSocket, obj: unknown): void {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    } catch {
      /* 连接竞态:忽略,由对端 outbox 重发兜底 */
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    for (const ws of this.sockets.values()) ws.close(1001, 'gateway closing');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.server.close();
  }
}