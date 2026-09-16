import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_PARAMS, newId, newKeyPair, signEnvelope, toBase64 } from '@qlong/core';
import { Registry, createRegistryServer } from '../../registry/src/index.js';
import { REGISTRY_SQL } from '../../registry/src/state-store.js';
import { defineMigration, SqliteStore, type SqliteStoreOptions } from '../../storage/src/index.js';
import type { ExecutorDriver } from '../src/executor/driver.js';
import { LeadTaskMachine } from '../src/lead/machine.js';
import { createProductionNode, type ProductionNode, type ProductionNodeOptions } from '../src/remote/factory.js';
import type { TerminalTaskProjection } from '../src/remote/session.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
  }
});

function durableRegistry() {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, 'qlong-terminal-projection-'));
  let storage: SqliteStore | undefined;
  cleanup.push(() => {
    storage?.close();
    if (dirname(root) !== base || !basename(root).startsWith('qlong-terminal-projection-')) {
      throw new Error('Unsafe terminal projection fixture cleanup target');
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const options: SqliteStoreOptions = {
    allowedBase: root, dataDir: join(root, 'data'), mode: 'create',
    schema: { id: 'qlong.terminal-projection-test', migrations: [defineMigration({ version: 1, name: 'registry', sql: REGISTRY_SQL })] },
    localFilesystemConfirmed: true, windowsAclConfirmed: true, busyTimeoutMs: 25,
  };
  storage = SqliteStore.open(options);
  return {
    registry: new Registry({ storage }),
    reopen() {
      storage?.close();
      storage = SqliteStore.open({ ...options, mode: 'open' });
      return new Registry({ storage });
    },
  };
}

async function fixture(overrides: Partial<ProductionNodeOptions> = {}, registry = new Registry()) {
  const identity = newKeyPair();
  const executorIdentity = newKeyPair();
  const team = registry.createTeam({ owner_user_id: 'terminal-projection-test' });
  const enroll = (pubkey: string) => registry.enroll({ token: registry.issueEnrollToken(team.team_id), pubkey });
  const lead = enroll(toBase64(identity.publicKey));
  const exec = enroll(toBase64(executorIdentity.publicKey));
  const path = `/v1/teams/${team.team_id}/tasks`;
  const faults: { status?: number; disconnect?: boolean } = {};
  const statuses: number[] = [];
  let posts = 0;
  const api = createRegistryServer({ registry });
  const http = createServer((req, res) => {
    if (req.method === 'POST' && req.url === path) {
      posts += 1;
      res.once('finish', () => statuses.push(res.statusCode));
      if (faults.disconnect) { res.destroy(); return; }
      if (faults.status) {
        req.resume();
        res.writeHead(faults.status);
        res.end('response-body-marker');
        return;
      }
    }
    api.emit('request', req, res);
  });
  const driver = { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn() } satisfies ExecutorDriver;
  let node: ProductionNode | undefined;
  cleanup.push(async () => {
    node?.session.dispose();
    node?.stop();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    expect(driver.start).not.toHaveBeenCalled();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const registryUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const errors = vi.fn<NonNullable<ProductionNodeOptions['onTaskReportError']>>();
  node = await createProductionNode({
    registryUrl, gatewayUrl: 'ws://127.0.0.1:9', nodeToken: lead.node_token,
    privKey: identity.priv, reportIntervalMs: 0, onTaskReportError: errors, ...overrides, driver,
  });
  // Exercise the real session and HTTP reporter, not gateway transport or host/model execution.
  // Do not start the gateway client; replace only its outbound transport to avoid ACK timers.
  vi.spyOn(node.client, 'send').mockResolvedValue('timeout');
  const session = node.session;
  const reports: TerminalTaskProjection[] = [];
  const reporter = session.opts.taskStatusReporter!;
  session.opts.taskStatusReporter = (report) => { reports.push(report); reporter(report); };
  function start(kind: 'aid' | 'project' = 'aid', taskId = newId()) {
    session.startLeadTask(taskId, kind, exec.node_id, { kind, summary: 'terminal projection test' });
    return taskId;
  }
  function receive(taskId: string, type: string, body: Record<string, unknown> = {}, attempt = 1) {
    session.onEnvelope(signEnvelope({
      v: 1, type, msg_id: newId(), task_id: taskId, attempt, hops: 0,
      ts: new Date().toISOString(), exp: new Date(Date.now() + 60_000).toISOString(),
      from: { node_id: exec.node_id, team_id: team.team_id, key_epoch: 1 },
      to: { node_id: lead.node_id, team_id: team.team_id },
      trace: { trace_id: newId(), parent_span: null, origin_node: exec.node_id }, body,
    }, executorIdentity.priv));
  }
  function complete(taskId: string) {
    receive(taskId, 'task.accept');
    receive(taskId, 'task.result', { summary: 'finished' });
  }
  async function readTask(taskId: string) {
    const response = await fetch(`${registryUrl}${path}/${taskId}`, { headers: { Authorization: `Bearer ${lead.node_token}` } });
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, unknown>>;
  }
  return { node, session, registry, teamId: team.team_id, leadId: lead.node_id, execId: exec.node_id,
    faults, statuses, reports, errors, start, receive, complete, readTask, postCount: () => posts };
}

describe('production terminal-only task projection (not reliable node reporting)', () => {
  it('POSTs one immutable aid terminal projection through Registry HTTP and survives a Registry store reopen', async () => {
    const durable = durableRegistry();
    const h = await fixture({}, durable.registry);
    const taskId = h.start();
    expect(h.reports).toHaveLength(0);
    h.receive(taskId, 'task.accept');
    expect(h.reports).toHaveLength(0);
    h.receive(taskId, 'task.result', { summary: 'finished' });
    const expected: TerminalTaskProjection = {
      task_id: taskId, team_id: h.teamId, lead: h.leadId, exec: h.execId,
      attempt: 1, status: 'done', type: 'aid', task_seq: 0,
    };
    expect(h.reports).toEqual([expected]);
    expect(Object.isFrozen(h.reports[0])).toBe(true);
    await vi.waitFor(() => expect(h.statuses).toEqual([200]));
    expect(await h.readTask(taskId)).toMatchObject(expected);
    h.receive(taskId, 'task.result', { summary: 'finished' });
    expect(h.reports).toHaveLength(1);
    expect(h.postCount()).toBe(1);
    expect(h.errors).not.toHaveBeenCalled();
    // Only Registry persistence is proved here; node restart/replay is deliberately not implemented.
    expect(durable.reopen().getTask(h.teamId, taskId)).toMatchObject(expected);
  });

  it('onTerminal starting a project and mutating the old record cannot rewrite the earlier aid report', async () => {
    const h = await fixture();
    const taskId = h.start();
    const original = h.session.lead!;
    const replacementId = newId();
    h.session.opts.onTerminal = vi.fn((id, state, result) => {
      expect([id, state, result?.summary]).toEqual([taskId, 'done', 'finished']);
      h.start('project', replacementId);
      original.rec.kind = 'project';
      original.rec.target = null;
      original.rec.attempt = 99;
    });
    h.complete(taskId);
    expect(h.session.lead?.task_id).toBe(replacementId);
    expect(h.session.opts.onTerminal).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.statuses).toEqual([200]));
    expect(await h.readTask(taskId)).toMatchObject({ task_id: taskId, type: 'aid', exec: h.execId, attempt: 1, status: 'done', task_seq: 0 });
    expect(h.registry.getTask(h.teamId, replacementId)).toBeUndefined();
  });

  it('keeps the originating lead when an escalation callback replaces it before the terminal action', async () => {
    const h = await fixture({ params: { ...DEFAULT_PARAMS, maxDispatchRounds: 1 } });
    const taskId = h.start('project');
    const replacementId = newId();
    h.session.opts.onEscalate = () => { h.start('aid', replacementId); };
    h.receive(taskId, 'task.reject', { reason_code: 'busy' });
    await vi.waitFor(() => expect(h.statuses).toEqual([200]));
    expect(await h.readTask(taskId)).toMatchObject({ task_id: taskId, type: 'project', attempt: 1, status: 'escalated', task_seq: 0 });
    expect(h.session.lead?.task_id).toBe(replacementId);
  });

  it('preserves a null executor and a positive attempt without inventing an executor ID', async () => {
    const h = await fixture();
    const taskId = newId();
    // Seed the nullable record shape; this does not imply production checkpoint restore exists.
    const lead = new LeadTaskMachine({ task_id: taskId, kind: 'aid' });
    lead.rec.attempt = 2;
    h.session.lead = lead;
    // A targetless cancellation cannot be closed by an unsolicited ack (machine-safety);
    // the I-06 cancel_wait timeout is the only closing path for this shape.
    vi.useFakeTimers();
    h.session.cancelLead(taskId);
    vi.advanceTimersByTime(DEFAULT_PARAMS.cancelWaitMs);
    vi.useRealTimers();
    await vi.waitFor(() => expect(h.statuses).toEqual([200]));
    expect(await h.readTask(taskId)).toMatchObject({ task_id: taskId, exec: null, attempt: 2, status: 'closed', type: 'aid', task_seq: 0 });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('does not report invalid/unoffered attempt %s as attempt 1', async (attempt) => {
    const h = await fixture();
    const taskId = newId();
    const lead = new LeadTaskMachine({ task_id: taskId, kind: 'aid' });
    lead.rec.attempt = attempt;
    h.session.lead = lead;
    const terminal = vi.fn();
    h.session.opts.onTerminal = terminal;
    vi.useFakeTimers();
    h.session.cancelLead(taskId);
    vi.advanceTimersByTime(DEFAULT_PARAMS.cancelWaitMs);
    vi.useRealTimers();
    expect(terminal).toHaveBeenCalledWith(taskId, 'closed', undefined);
    expect(h.reports).toHaveLength(0);
    expect(h.postCount()).toBe(0);
    expect(h.registry.getTask(h.teamId, taskId)).toBeUndefined();
  });

  it.each([401, 409, 503])('exposes HTTP %s using only task_id and status', async (status) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await fixture();
    h.faults.status = status;
    const taskId = h.start();
    h.complete(taskId);
    await vi.waitFor(() => expect(h.errors).toHaveBeenCalledExactlyOnceWith({ task_id: taskId, status }));
    expect(h.postCount()).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(h.registry.getTask(h.teamId, taskId)).toBeUndefined();
  });

  it('exposes a disconnected HTTP request without a fabricated HTTP status or raw network error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await fixture();
    h.faults.disconnect = true;
    const taskId = h.start();
    h.complete(taskId);
    await vi.waitFor(() => expect(h.errors).toHaveBeenCalledExactlyOnceWith({ task_id: taskId }));
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject', 'absent'] as const)('contains an error callback that is %s and logs only a generic fallback', async (mode) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const callback = vi.fn(() => {
      if (mode === 'throw') throw new Error('callback-error-marker');
      return Promise.reject(new Error('callback-error-marker'));
    });
    const h = await fixture({ onTaskReportError: mode === 'absent' ? undefined : callback });
    h.faults.status = 503;
    const taskId = h.start();
    expect(() => h.complete(taskId)).not.toThrow();
    await vi.waitFor(() => expect(log).toHaveBeenCalledExactlyOnceWith('任务终态上报失败'));
    if (mode !== 'absent') expect(callback).toHaveBeenCalledExactlyOnceWith({ task_id: taskId, status: 503 });
    expect(h.postCount()).toBe(1);
    expect(h.session.lead?.rec.state).toBe('done');
  });
});