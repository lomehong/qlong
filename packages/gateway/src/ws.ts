/**
 * ws 适配器(M2,评审 M2-01/02/03 修订版):
 * - A3 首帧认证:认证态留存于连接闭包,认证前不处理任何业务帧(token 不进 URL,评审 I-16)
 * - 上行信封过 validateEnvelope + uplink 全程 try/catch —— 畸形帧不可能击穿进程(M2-01)
 * - 认证成功即接线收件箱补投(M2-02,评审 I-11/D24)
 * - 连接表以 connId 守卫:同节点新连接踢旧连接,旧连接的 close 不会误删新会话(M2-03)
 * - 非 active 节点连不开(M2-18);管理断连带语义 close code 4001/4002(A6)
 */
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { newId, validateEnvelope, type EnvelopeV1 } from '@qlong/core';
import type { GatewayCore } from './core.js';
import type { GatewayDirectorySnapshot } from './types.js';

export const AUTH_KEY = 'node_' + 'token';

export interface WsGatewayOptions {
  core: GatewayCore;
  /** A3:node token → 节点(注册中心 authByToken);无效或非 active = 拒绝(close 4003) */
  authenticate: (nodeToken: string) => { node_id: string; team_id: string; status: string } | undefined;
}

interface RegistryLike {
  snapshot(): GatewayDirectorySnapshot;
  getNode(nodeId: string): { status: string } | undefined;
}

interface ConnState {
  ws: WebSocket;
  nodeId: string;
}

export class WsGateway {
  readonly server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  readonly wss: WebSocketServer;
  /** connId → 连接(守卫键:M2-03) */
  private socketsByConn = new Map<string, ConnState>();
  /** nodeId → 当前 connId(同节点新连接踢旧) */
  private currentConnByNode = new Map<string, string>();
  private syncTimer?: NodeJS.Timeout;

  constructor(private readonly opts: WsGatewayOptions) {
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      let connId: string | null = null;
      let nodeId = '';

      const cleanup = (): void => {
        if (connId === null) return;
        this.socketsByConn.delete(connId);
        // M2-03:仅当自己仍是该节点当前连接时才摘除在线态(防旧 close 误删新会话)
        if (this.currentConnByNode.get(nodeId) === connId) {
          this.currentConnByNode.delete(nodeId);
          this.opts.core.disconnect(nodeId);
        }
      };

      ws.on('message', (data) => {
        let frame: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(String(data));
          // M2-01:null/数组/原始类型一律按垃圾帧静默 —— 不得在后续属性访问中炸出未捕获异常
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          frame = parsed as Record<string, unknown>;
        } catch {
          return; // 非 JSON:认证前静默;认证后按未知帧静默(协议演进位)
        }

        // ---- A3 认证帧(connId === null 表示尚未认证)----
        if (connId === null) {
          const token = frame[AUTH_KEY];
          if (frame.frame !== 'auth' || typeof token !== 'string') {
            ws.close(4003, 'unauthorized');
            return;
          }
          const node = this.opts.authenticate(token);
          if (!node || node.status !== 'active') {
            ws.close(4003, 'unauthorized'); // M2-18:非 active 节点连不开
            return;
          }
          connId = newId();
          nodeId = node.node_id;
          // M2-03:同节点旧连接踢下线(新连接接管;旧 close 由守卫忽略)
          const oldConnId = this.currentConnByNode.get(nodeId);
          if (oldConnId !== undefined) {
            const old = this.socketsByConn.get(oldConnId);
            this.socketsByConn.delete(oldConnId);
            try {
              old?.ws.close(4000, 'replaced');
            } catch {
              /* ignore */
            }
          }
          this.currentConnByNode.set(nodeId, connId);
          this.socketsByConn.set(connId, { ws, nodeId });
          this.opts.core.connect({ connId, nodeId, teamId: node.team_id, connectedAt: Date.now() });
          // M2-02:认证成功即接线收件箱补投(离线期间排队的 project 单)
          const take = this.opts.core.takeInbox(nodeId, Date.now());
          for (const d of take.deliveries) {
            this.safeSend(ws, { frame: 'envelope', envelope: d.envelope });
          }
          this.safeSend(ws, { frame: 'auth_ok', node_id: nodeId, team_id: node.team_id });
          return;
        }

        // ---- 已认证:上行信封 ----
        if (frame.frame !== 'envelope' || typeof frame.envelope !== 'object' || frame.envelope === null) {
          return; // 未知帧:静默(协议演进位,§8 兼容承诺)
        }
        const env = frame.envelope as EnvelopeV1;
        const chk = validateEnvelope(env);
        if (!chk.ok) {
          // M2-01:结构非法 → 结构化拒绝(已认证发送方;连接与进程不受影响)
          this.safeSend(ws, {
            frame: 'ack',
            ack_type: 'rejected',
            msg_id: typeof env.msg_id === 'string' ? env.msg_id : 'unknown',
            reason: 'bad_frame',
          });
          return;
        }
        let result;
        try {
          result = this.opts.core.uplink(nodeId, env, Date.now());
        } catch {
          // M2-01:兜底 —— 进程与连接必须存活
          this.safeSend(ws, { frame: 'ack', ack_type: 'rejected', msg_id: env.msg_id, reason: 'internal_error' });
          return;
        }
        for (const a of result.audits) void a;
        if (result.ack) this.safeSend(ws, { frame: 'ack', ...result.ack });
        if (result.routingDenied) this.safeSend(ws, { frame: 'routing.denied', ...result.routingDenied });
        for (const d of result.deliveries) {
          this.routeToNode(d.toNodeId, { frame: 'envelope', envelope: d.envelope });
        }
      });

      ws.on('close', () => cleanup());
      ws.on('error', () => {
        try {
          ws.close(1011, 'error');
        } catch {
          /* already closing */
        }
      });
    });
  }

  private routeToNode(nodeId: string, frame: unknown): void {
    const connId = this.currentConnByNode.get(nodeId);
    if (connId === undefined) return;
    const state = this.socketsByConn.get(connId);
    if (state) this.safeSend(state.ws, frame);
  }

  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => resolve((this.server.address() as { port: number }).port));
    });
  }

  /** 目录同步 + 悬挂管理断连(connId 守卫版,§7.1) */
  syncRegistry(snapshot: GatewayDirectorySnapshot, statusOf: (nodeId: string) => string | undefined): void {
    this.opts.core.setDirectory(snapshot);
    for (const [nodeId, connId] of [...this.currentConnByNode]) {
      const st = statusOf(nodeId);
      if (st === 'suspended' || st === 'revoked') {
        this.opts.core.applyAdminEvent(nodeId, st);
        const state = this.socketsByConn.get(connId);
        if (state) {
          this.safeSend(state.ws, { frame: 'closing', code: st === 'suspended' ? 4001 : 4002, reason: st });
          try {
            state.ws.close(st === 'suspended' ? 4001 : 4002, st);
          } catch {
            /* ignore */
          }
        }
        this.socketsByConn.delete(connId);
        this.currentConnByNode.delete(nodeId);
        this.opts.core.disconnect(nodeId);
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
      /* 竞态忽略 */
    }
  }

  async close(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    for (const s of this.socketsByConn.values()) {
      try {
        s.ws.close(1001, 'gateway closing');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.server.close();
  }
}