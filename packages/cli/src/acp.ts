/**
 * ACP(Agent Client Protocol)客户端 —— qlong agent 真流式的官方通道。
 *
 * dsh 原生暴露 `acp` profile(automation-only JSON-RPC stdio agent server):
 * spawn `node <dsh-bin.js> --profile acp` 后,该进程即成为 ACP 服务器;qlong 作为
 * ACP 客户端:initialize → session/new → 每轮 session/prompt。
 * 流式回答经 `session/update` 通知(agent_message_chunk)陆续到达。
 *
 * 相比 headless 每轮冷启动(实测 ~15s),ACP server 常驻、会话热着(实测 ~2s);
 * 分帧 = 换行分隔 JSON-RPC 2.0(与本机 0.1.6-alpha.2 实测一致)。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface AcpClientOptions {
  /** dsh 运行时真实入口(bin.js,用 node 执行;来自 resolveLocalDshRuntime) */
  dshBin: string;
  /** ACP profile 名 */
  profile: string;
  /** 会话工作区(session/new 的 cwd) */
  cwd: string;
  /** stderr 透传(dsh 的诊断/思考) */
  onStderr?: (text: string) => void;
}

interface PendingMessage {
  resolve: (msg: { result?: unknown; error?: { code: number; message: string } }) => void;
}

export interface AcpPromptResult {
  stopReason?: string;
}

export type AcpUpdateHandler = (update: Record<string, unknown>, sessionId: string) => void;

export class AcpClient {
  private child?: ChildProcess;
  private buf = '';
  private idc = 0;
  private readonly pending = new Map<number, PendingMessage>();
  private readonly opts: AcpClientOptions;
  private readonly onUpdate: AcpUpdateHandler;
  private readonly onStderr: (text: string) => void;

  constructor(opts: AcpClientOptions, onUpdate: AcpUpdateHandler) {
    this.opts = opts;
    this.onUpdate = onUpdate;
    this.onStderr = opts.onStderr ?? (() => {});
  }

  /** 启动 server 进程 + ACP 握手 + 会话创建。返回 sessionId。 */
  async connect(): Promise<string> {
    this.child = spawn(process.execPath, [this.opts.dshBin, '--profile', this.opts.profile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line.length === 0) continue;
        this.handleLine(line);
      }
    });
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (c: string) => this.onStderr(c));
    await this.rpc('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    const sess = await this.rpc<{ sessionId: string }>('session/new', {
      cwd: this.opts.cwd,
      mcpServers: [],
    }, 30_000);
    return sess.sessionId;
  }

  /** 提交一轮 prompt;流式增量经 onUpdate(agent_message_chunk)回调陆续到达。 */
  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    const r = await this.rpc<{ stopReason?: string }>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    return { stopReason: r.stopReason };
  }

  stop(): void {
    try { this.child?.kill(); } catch { /* 已退出 */ }
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.onStderr(`[非JSON] ${line.slice(0, 120)}\n`);
      return;
    }
    if (msg.id !== undefined && this.pending.has(Number(msg.id))) {
      const p = this.pending.get(Number(msg.id))!;
      this.pending.delete(Number(msg.id));
      p.resolve(msg);
      return;
    }
    if (msg.method === 'session/update') {
      const params = (msg.params ?? {}) as { sessionId?: string; update?: Record<string, unknown> };
      if (typeof params.sessionId === 'string') this.onUpdate(params.update ?? {}, params.sessionId);
    }
    // 其余服务器→客户端请求(如 fs 权限回调):v1 不支持,不响应(协议允许客户端拒答超时)
  }

  private rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown>, timeoutMs = 600_000): Promise<T> {
    if (this.child === undefined) return Promise.reject(new Error('ACP client 未启动'));
    const id = ++this.idc;
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          if (msg.error !== undefined) reject(new Error(`ACP ${method}: ${msg.error.message}`));
          else resolve((msg.result ?? {}) as T);
        },
      });
    });
  }
}
