import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { newId } from '@qlong/core';
import { defineMigration, SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import { Registry } from '../src/directory.js';
import { createRegistryServer, type RegistryServerOptions } from '../src/http.js';
import { COMMAND_SQL, SqliteCommandStore } from '../src/command-store.js';

/**
 * E3a-3:owner 命令路由 + 节点命令 PULL/ack 路由(设计 docs/repair/OWNER-COMMAND.md §4.2/§4.3)。
 *
 * 三个不可违背的性质各设变异靶点:
 * - **授权**(§1.2):owner 命令路由必过 assertOwner——非 owner 403 且不入队。
 * - **投影只读**(§1.4):owner 路由只 enqueue 命令意图,中心 TaskProjection 状态绝不翻转(202 非 200)。
 * - **防越权 PULL**(§1.2):节点只能取/ack `lead=本机` 的命令——同队他节点取不到、ack 被栅栏。
 * 命令通道未配置(无中心 SQLite)→ 503 失败关闭,绝不伪称"查无命令"。
 */
const PUB = Buffer.alloc(32, 1).toString('base64');
const tempBase = realpathSync(tmpdir());
const roots = new Set<string>();
const stores = new Set<SqliteStore>();

function storageOptions(): SqliteStoreOptions {
  const root = mkdtempSync(join(tempBase, 'qlong-cmdroute-'));
  roots.add(root);
  return {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create', busyTimeoutMs: 25,
    localFilesystemConfirmed: true, windowsAclConfirmed: true,
    schema: {
      id: 'qlong.command-route-test',
      migrations: [defineMigration({ version: 1, name: 'command', sql: COMMAND_SQL })],
    },
  };
}

describe('registry owner-command routes (E3a-3)', () => {
  let registry: Registry;
  let commandStore: SqliteCommandStore;
  let opts: RegistryServerOptions;
  let server: ReturnType<typeof createRegistryServer>;
  let base: string;
  let teamId: string;
  let otherId: string;
  let lead: { node_id: string; node_token: string };
  let member: { node_id: string; node_token: string };
  let taskId: string;

  beforeEach(async () => {
    registry = new Registry();
    teamId = registry.createTeam({ owner_user_id: 'test-owner' }).team_id;
    otherId = registry.createTeam({ owner_user_id: 'other-owner' }).team_id;
    lead = registry.enroll({ token: registry.issueEnrollToken(teamId), pubkey: PUB });
    member = registry.enroll({ token: registry.issueEnrollToken(teamId), pubkey: PUB });
    // 牵头节点上报一条任务投影,使 getTask 返回 lead=lead.node_id 的权威只读投影。
    taskId = newId();
    registry.reportTask(lead.node_token, teamId, {
      task_id: taskId, type: 'project', team_id: teamId, lead: lead.node_id,
      exec: null, attempt: 1, status: 'running', task_seq: 1,
    });
    const storage = SqliteStore.open(storageOptions());
    stores.add(storage);
    commandStore = new SqliteCommandStore(storage);
    opts = { registry, commandStore, ownerAuth: (req, team) => req.headers['x-test-owner-team'] === team };
    server = createRegistryServer(opts);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const storage of [...stores].reverse()) storage.close();
    stores.clear();
    for (const root of roots) {
      if (dirname(root) !== tempBase || !basename(root).startsWith('qlong-cmdroute-')) {
        throw new Error('Unsafe command-route test cleanup target');
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    roots.clear();
  });

  async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json');
    const res = await fetch(base + path, {
      method, headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
  }
  const ownerHeaders = (team = teamId) => ({ 'x-test-owner-team': team });
  const nodeHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

  // ---- owner 命令路由(§4.2)----

  it('owner cancel 入队为 pending、路由到任务牵头节点,返回 202(受理待执行,非已完成)', async () => {
    const res = await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ kind: 'cancel', task_id: taskId, lead: lead.node_id });
    expect(typeof res.body?.command_id).toBe('string');
    const pending = commandStore.pendingFor(lead.node_id, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: res.body?.command_id, kind: 'cancel', task_id: taskId, lead: lead.node_id, status: 'pending',
    });
  });

  it('owner redispatch 入队 kind=redispatch,返回 202', async () => {
    const res = await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/redispatch`, ownerHeaders());
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ kind: 'redispatch', task_id: taskId, lead: lead.node_id });
    expect(commandStore.pendingFor(lead.node_id, 10).map((c) => c.kind)).toEqual(['redispatch']);
  });

  it('非 owner 下命令被拒 403 且不入队(assertOwner 授权靶点)', async () => {
    const res = await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders(otherId));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'not_team_member' } });
    expect(commandStore.pendingFor(lead.node_id, 10)).toEqual([]);
  });

  it('任务不存在 → 404,不入队', async () => {
    const res = await call('POST', `/v1/teams/${teamId}/tasks/${newId()}/cancel`, ownerHeaders());
    expect(res.status).toBe(404);
    expect(commandStore.pendingFor(lead.node_id, 10)).toEqual([]);
  });

  it('跨队任务(URL team 非任务归属 team)→ 404,不入队(getTask 按 team 作用域)', async () => {
    const res = await call('POST', `/v1/teams/${otherId}/tasks/${taskId}/cancel`, ownerHeaders(otherId));
    expect(res.status).toBe(404);
    expect(commandStore.pendingFor(lead.node_id, 10)).toEqual([]);
  });

  it('owner 命令路由只入队意图,中心任务投影保持只读(status/content_hash 不变)——投影只读靶点', async () => {
    const before = registry.getTask(teamId, taskId);
    const res = await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders());
    expect(res.status).toBe(202);
    const after = registry.getTask(teamId, taskId);
    expect(after?.status).toBe(before?.status); // 仍 'running',未翻成 cancelling/closed
    expect(after?.content_hash).toBe(before?.content_hash);
  });

  it('命令通道未配置 → owner 命令路由 503 失败关闭', async () => {
    opts.commandStore = undefined;
    const res = await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders());
    expect(res.status).toBe(503);
  });

  // ---- 节点命令 PULL/ack 路由(§4.3)----

  it('牵头节点用 nodeToken PULL 取回路由到自己的 pending 命令', async () => {
    await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders());
    const res = await call('GET', '/v1/nodes/me/commands', nodeHeaders(lead.node_token));
    expect(res.status).toBe(200);
    const commands = res.body?.commands as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: 'cancel', task_id: taskId, lead: lead.node_id, status: 'pending' });
  });

  it('节点 PULL 按 lead 过滤:同队他节点取不到牵头节点的命令(防越权靶点)', async () => {
    await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders());
    const res = await call('GET', '/v1/nodes/me/commands', nodeHeaders(member.node_token));
    expect(res.status).toBe(200);
    expect(res.body?.commands).toEqual([]);
  });

  it('无凭证 PULL → 401', async () => {
    const res = await call('GET', '/v1/nodes/me/commands');
    expect(res.status).toBe(401);
  });

  it('命令通道未配置 → PULL 503 失败关闭', async () => {
    opts.commandStore = undefined;
    const res = await call('GET', '/v1/nodes/me/commands', nodeHeaders(lead.node_token));
    expect(res.status).toBe(503);
  });

  it('牵头节点 ack 命令 → ok:true,命令离开 pending', async () => {
    const enq = await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders());
    const commandId = enq.body?.command_id as string;
    const res = await call('POST', `/v1/nodes/me/commands/${commandId}/ack`, nodeHeaders(lead.node_token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(commandStore.pendingFor(lead.node_id, 10)).toEqual([]);
  });

  it('ack 被 lead 栅栏:他节点 ack 牵头节点命令 → ok:false,命令仍 pending', async () => {
    const enq = await call('POST', `/v1/teams/${teamId}/tasks/${taskId}/cancel`, ownerHeaders());
    const commandId = enq.body?.command_id as string;
    const res = await call('POST', `/v1/nodes/me/commands/${commandId}/ack`, nodeHeaders(member.node_token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false });
    expect(commandStore.pendingFor(lead.node_id, 10).map((c) => c.id)).toEqual([commandId]);
  });
});
