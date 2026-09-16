import { DEFAULT_PARAMS, envelopeDigest, isUuid, newId, type EnvelopeV1, type QlongParams } from '@qlong/core';
import { canApplyLeaseRenewal, isLeaseFence } from '../../../core/src/lease.js';
import type { FencedDriver, RunFence, RunHandle, RunOutcome } from '../driver/run-handle.js';
import { gateCaps, gatePolicy, type LocalPolicy } from '../executor/gates.js';
import type { Outbound } from '../wire.js';
import type { NodeRuntimeStore, RuntimeJson, RuntimeState, RuntimeTransition } from './store.js';

export type { FencedDriver, RunFence, RunHandle, RunOutcome } from '../driver/run-handle.js';

const STATE_KEY = 'executor:v2';
const EFFECT_KIND = 'executor.run';
type Phase = 'prepared' | 'starting' | 'running' | 'stopping' | 'recovery_required';
type StopReason = 'cancel' | 'lease_expired' | 'shutdown' | 'execution_interrupted' | 'driver_start_timeout';

export interface DurableRun {
  fence: RunFence;
  phase: Phase;
  lead: string;
  offerMsgId: string;
  offer: Record<string, unknown>;
  mayHaveStarted: boolean;
  leaseMs: number;
  leaseDeadline: number;
  heartbeatAt: number;
  seq: number;
  lastRenewalSeq: number;
  progress: { msg_id: string; seq: number; sentAt: number } | null;
  cancelMsgId: string | null;
  stopReason: StopReason | null;
}

export interface DurableExecutorSnapshot {
  version: 2;
  nodeId: string;
  teamId: string;
  generation: number;
  slot: DurableRun | null;
  last: { fence: RunFence; lead: string; outcome: RunOutcome } | null;
}

export interface DurableExecutorOptions {
  store: NodeRuntimeStore;
  nodeId: string;
  teamId: string;
  params?: QlongParams;
  seal: (out: Outbound) => EnvelopeV1;
  driver?: FencedDriver;
  /** Bound each driver wait, not execution time. Timeout never proves quiescence. */
  driverTimeoutMs?: number;
  capabilities?: () => string[];
  policy?: LocalPolicy;
  onFault?: () => void;
}

interface LiveRun {
  fence: RunFence;
  handle: RunHandle;
  outcome?: RunOutcome;
  closedFault: boolean;
  closure: Promise<RunOutcome>;
  quiescence?: Promise<RunOutcome>;
}

function same(a: RunFence, b: RunFence): boolean {
  return a.task_id === b.task_id && a.attempt === b.attempt &&
    a.generation === b.generation && a.run_id === b.run_id;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return value === 0 || positive(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Persisted offer/outcome bodies retain the envelope's D23 integer-only numeric domain. */
function protocolJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every((item) => protocolJson(item, depth + 1));
  return record(value) && Object.values(value).every((item) => protocolJson(item, depth + 1));
}

/** The store already validates bounded, lossless JSON; validate the domain fields here. */
function supportedOffer(value: unknown): value is Record<string, unknown> {
  return record(value) && value.kind === 'aid' && typeof value.summary === 'string' && value.summary.length > 0 &&
    value.project === undefined && value.payload_ref === undefined &&
    (value.lease_ms === undefined || positive(value.lease_ms)) &&
    (value.offer_ttl_ms === undefined || positive(value.offer_ttl_ms)) &&
    (value.requires === undefined || (Array.isArray(value.requires) && value.requires.length === 0)) &&
    (value.required_caps === undefined || (Array.isArray(value.required_caps) &&
      value.required_caps.every((cap) => typeof cap === 'string' && cap.length > 0))) && protocolJson(value);
}

function validOutcome(value: unknown): value is RunOutcome {
  return record(value) && (value.kind === 'result' || value.kind === 'failed') && record(value.body) && protocolJson(value.body);
}

function validRun(value: unknown, generation: number): value is DurableRun {
  if (!record(value) || !isLeaseFence(value.fence) || value.fence.generation !== generation ||
      !isUuid(value.lead) || !isUuid(value.offerMsgId) || !supportedOffer(value.offer) ||
      !['prepared', 'starting', 'running', 'stopping', 'recovery_required'].includes(value.phase as string) ||
      typeof value.mayHaveStarted !== 'boolean' || !positive(value.leaseMs) ||
      (positive(value.offer.lease_ms) && value.leaseMs > value.offer.lease_ms) ||
      !positive(value.leaseDeadline) || !positive(value.heartbeatAt) ||
      !nonnegative(value.seq) || !nonnegative(value.lastRenewalSeq) ||
      (value.cancelMsgId !== null && !isUuid(value.cancelMsgId)) ||
      (value.stopReason !== null && !['cancel', 'lease_expired', 'shutdown', 'execution_interrupted',
        'driver_start_timeout'].includes(value.stopReason as string))) return false;
  if (value.phase === 'prepared' ? value.mayHaveStarted :
      value.phase !== 'stopping' && !value.mayHaveStarted) return false;
  if (!value.mayHaveStarted && (value.seq !== 0 || value.lastRenewalSeq !== 0)) return false;
  if (value.seq === 0 && value.lastRenewalSeq !== 0) return false;
  if (value.seq > 0 && value.progress === null && value.lastRenewalSeq === 0) return false;
  if (value.cancelMsgId !== null && value.stopReason !== 'cancel') return false;
  if (value.stopReason === 'cancel' && value.cancelMsgId === null) return false;
  if (['prepared', 'starting', 'running'].includes(value.phase as string) && value.stopReason !== null) return false;
  if ((value.phase === 'stopping' || value.phase === 'recovery_required') && value.stopReason === null) return false;
  return value.progress === null || (record(value.progress) && isUuid(value.progress.msg_id) &&
    positive(value.progress.seq) && value.progress.seq === value.seq && nonnegative(value.progress.sentAt) &&
    value.progress.sentAt < value.leaseDeadline && value.progress.sentAt < value.heartbeatAt);
}

class DriverTimeoutError extends Error {
  constructor() { super('Driver operation timed out; recovery required'); }
}

function failed(reason: string): RunOutcome {
  return { kind: 'failed', body: { reason_code: 'other', retryable: false, summary: reason } };
}

/** One owner per store. No timers/driver IO inside SQL, no default execution backend. */
export class DurableExecutor {
  private readonly params: QlongParams;
  private readonly driverTimeoutMs: number;
  private live?: LiveRun;
  private settling?: Promise<void>;
  private recovering?: Promise<void>;
  private starting = false;
  private ready = false;
  private closing = false;
  private faulted = false;

  constructor(private readonly opts: DurableExecutorOptions) {
    if (opts.store.nodeId !== opts.nodeId || !opts.teamId) throw new TypeError('Invalid executor identity');
    this.params = { ...(opts.params ?? DEFAULT_PARAMS) };
    this.driverTimeoutMs = opts.driverTimeoutMs ?? 5_000;
    if (!positive(this.driverTimeoutMs) || this.driverTimeoutMs > 2_147_483_647) {
      throw new TypeError('Invalid driver timeout');
    }
    if (!positive(this.params.leaseMsAid) || !positive(this.params.offerTtlMsAid)) {
      throw new TypeError('Invalid executor lease/TTL');
    }
  }

  private notifyFault(): void {
    // Payloads and driver/storage exception text never enter the callback.
    try { this.opts.onFault?.(); } catch { /* Preserve the original failure. */ }
  }

  private checked<T>(action: () => T): T {
    try { return action(); } catch (error) { this.failClosed(); throw error; }
  }

  private async checkedAsync(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { this.failClosed(); throw error; }
  }

  private failClosed(): void {
    const firstFault = !this.faulted;
    this.faulted = true;
    this.ready = false;
    // No SQL here: consume/tick may have just faulted the store. Pending starts check this latch.
    if (this.live) void this.quiesce(this.live).catch(() => this.notifyFault());
    // A callback may initiate close; do not recursively notify that same latched fault.
    if (firstFault) this.notifyFault();
  }

  private assertHealthy(): void {
    if (this.faulted) throw new Error('Executor faulted; explicit recovery required');
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DriverTimeoutError()), this.driverTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  private decode(row: RuntimeState | undefined): DurableExecutorSnapshot {
    if (!row) return { version: 2, nodeId: this.opts.nodeId, teamId: this.opts.teamId,
      generation: 0, slot: null, last: null };
    const state = row.value;
    if (!record(state) || state.version !== 2 || state.nodeId !== this.opts.nodeId || state.teamId !== this.opts.teamId ||
        !nonnegative(state.generation) || (state.slot !== null && !validRun(state.slot, state.generation)) ||
        (state.last !== null && (!record(state.last) || !isLeaseFence(state.last.fence) ||
          !isUuid(state.last.lead) || !validOutcome(state.last.outcome) ||
          state.last.fence.generation !== state.generation - (state.slot === null ? 0 : 1))) ||
        (state.last === null && state.generation !== (state.slot === null ? 0 : 1))) {
      throw new Error('Invalid durable executor state; explicit recovery required');
    }
    return structuredClone(state) as unknown as DurableExecutorSnapshot;
  }

  snapshot(): DurableExecutorSnapshot {
    return this.checked(() => this.decode(this.opts.store.state(STATE_KEY)));
  }

  private transition(state: DurableExecutorSnapshot, outbox: EnvelopeV1[] = []): RuntimeTransition {
    return { state: state as unknown as RuntimeJson, outbox };
  }

  private change(edit: (state: DurableExecutorSnapshot, outbox: EnvelopeV1[]) => boolean): boolean {
    const row = this.opts.store.state(STATE_KEY);
    const state = this.decode(row);
    const outbox: EnvelopeV1[] = [];
    if (!edit(state, outbox)) return false;
    // All callbacks/signing have finished; transform is data-only and CAS-protected.
    const output = this.transition(state, outbox);
    this.opts.store.transition(STATE_KEY, row?.revision ?? 0, () => output);
    return true;
  }

  private message(run: DurableRun, type: string, body: Record<string, unknown>, replyTo = run.offerMsgId): EnvelopeV1 {
    return this.opts.seal({ type, to_node: run.lead, task_id: run.fence.task_id, attempt: run.fence.attempt,
      reply_to: replyTo, body: { ...body, generation: run.fence.generation, run_id: run.fence.run_id } });
  }

  /** Custody/crypto verification precedes this call; authorized must be refreshed by the inbox pump. */
  consume(env: EnvelopeV1, authorized: boolean): void {
    this.checked(() => {
      this.assertHealthy();
      const row = this.opts.store.state(STATE_KEY);
      const state = this.decode(row);
      const output = this.transition(state);
      const now = Date.now();
      if (env.to.node_id === this.opts.nodeId) {
        const allowed = env.from.team_id === this.opts.teamId && authorized && !!env.sig;
        const fresh = env.exp !== undefined && Date.parse(env.exp) > now;
        if (env.type === 'task.offer') {
          this.offer(state, env, now, output, !allowed ? 'policy_denied' : !fresh ? 'expired' : undefined);
        } else if (allowed && fresh) this.control(state, env, now, output.outbox!);
      }
      const digest = envelopeDigest(env);
      this.opts.store.consume({ fromNode: env.from.node_id, msgId: env.msg_id,
        stateKey: STATE_KEY, expectedRevision: row?.revision ?? 0 }, ({ envelope }) => {
        if (envelopeDigest(envelope) !== digest) throw new Error('Executor custody mismatch');
        return output;
      });
    });
  }

  private offer(state: DurableExecutorSnapshot, env: EnvelopeV1, now: number, output: RuntimeTransition,
    denied?: 'policy_denied' | 'expired'): void {
    const body = env.body;
    const ttl = body.offer_ttl_ms ?? this.params.offerTtlMsAid;
    const lease = body.lease_ms ?? this.params.leaseMsAid;
    let reason: string | undefined;
    if (denied) reason = denied;
    else if (!this.ready || state.slot || this.closing) reason = 'busy';
    else if (!this.opts.driver || body.kind !== 'aid' || body.project !== undefined || body.payload_ref !== undefined ||
        !isUuid(env.task_id) || !positive(env.attempt) ||
        (body.requires !== undefined && (!Array.isArray(body.requires) || body.requires.length > 0))) reason = 'policy_denied';
    else if (!positive(ttl) || !positive(lease) || !Number.isSafeInteger(now + lease) ||
        !Number.isFinite(Date.parse(env.ts)) || now >= Date.parse(env.ts) + ttl) reason = 'expired';
    else if (!gatePolicy(this.opts.policy, structuredClone(body)).ok) reason = 'policy_denied';
    else if ((body.required_caps !== undefined && (!Array.isArray(body.required_caps) ||
        !body.required_caps.every((cap) => typeof cap === 'string' && cap.length > 0))) ||
        !gateCaps(body.required_caps as string[] | undefined, this.opts.capabilities?.() ?? []).ok) reason = 'unsupported_caps';
    else if (!supportedOffer(body)) reason = 'policy_denied';
    else if (state.last?.fence.task_id === env.task_id && env.attempt! <= state.last.fence.attempt) reason = 'stale_attempt';
    if (reason) {
      output.outbox!.push(this.opts.seal({ type: 'task.reject', to_node: env.from.node_id,
        task_id: env.task_id, attempt: env.attempt, reply_to: env.msg_id,
        body: { reason_code: reason, retryable: reason === 'busy' || reason === 'expired' } }));
      return;
    }
    if (!Number.isSafeInteger(state.generation + 1)) throw new Error('Executor generation exhausted');
    state.generation++;
    const leaseMs = Math.min(lease as number, this.params.leaseMsAid);
    const run: DurableRun = {
      fence: { task_id: env.task_id!, attempt: env.attempt!, generation: state.generation, run_id: newId() },
      phase: 'prepared', lead: env.from.node_id, offerMsgId: env.msg_id, offer: structuredClone(body),
      mayHaveStarted: false, leaseMs, leaseDeadline: now + leaseMs,
      heartbeatAt: now + Math.max(1, Math.floor(leaseMs / 3)), seq: 0, lastRenewalSeq: 0,
      progress: null, cancelMsgId: null, stopReason: null,
    };
    state.slot = run;
    output.effects = [{ id: run.fence.run_id, kind: EFFECT_KIND, payload: { ...run.fence } }];
    output.outbox!.push(this.message(run, 'task.accept', { lease_ms: leaseMs, started_at: new Date(now).toISOString() }));
  }

  private control(state: DurableExecutorSnapshot, env: EnvelopeV1, now: number, outbox: EnvelopeV1[]): void {
    const run = state.slot;
    if (!run) {
      const last = state.last;
      if (env.type === 'task.cancel' && last && env.from.node_id === last.lead &&
          env.task_id === last.fence.task_id && env.attempt === last.fence.attempt) {
        outbox.push(this.opts.seal({ type: 'task.cancel.ack', to_node: last.lead, task_id: env.task_id,
          attempt: env.attempt, reply_to: env.msg_id, body: { ...last.fence,
            completed_before_cancel: last.outcome.kind === 'result' } }));
      }
      return;
    }
    if (env.from.node_id !== run.lead || env.task_id !== run.fence.task_id || env.attempt !== run.fence.attempt) return;
    if (env.type === 'task.cancel') {
      if ((env.body.generation !== undefined && env.body.generation !== run.fence.generation) ||
          (env.body.run_id !== undefined && env.body.run_id !== run.fence.run_id)) return;
      run.cancelMsgId = env.msg_id;
      run.stopReason = 'cancel';
      if (run.phase !== 'recovery_required') run.phase = 'stopping';
    } else if (env.type === 'task.lease.renew' && (run.phase === 'running' || run.phase === 'starting') &&
        run.progress && positive(env.body.deadline_ms) && env.body.deadline_ms > run.leaseDeadline &&
        canApplyLeaseRenewal({ body: env.body, fence: run.fence, progressMsgId: run.progress.msg_id,
          progressSeq: run.progress.seq, lastRenewalSeq: run.lastRenewalSeq, now,
          maxLeaseMs: run.leaseMs, currentDeadlineMs: run.leaseDeadline })) {
      run.lastRenewalSeq = env.body.renewal_seq as number;
      run.leaseDeadline = env.body.deadline_ms;
      run.progress = null;
    }
  }

  /** Polling persists due timers; transport receipts have no lease semantics. */
  tick(now = Date.now()): void {
    this.checked(() => {
      this.assertHealthy();
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid executor time');
      this.change((state, outbox) => {
        const run = state.slot;
        if (!run || run.phase === 'stopping' || run.phase === 'recovery_required') return false;
        if (now >= run.leaseDeadline) {
          run.phase = 'stopping'; run.stopReason = 'lease_expired'; return true;
        }
        if ((run.phase !== 'running' && run.phase !== 'starting') || now < run.heartbeatAt) return false;
        if (!Number.isSafeInteger(run.seq + 1)) throw new Error('Executor progress exhausted');
        if (!Number.isSafeInteger(now + Math.max(1, Math.floor(run.leaseMs / 3)))) {
          throw new Error('Executor heartbeat time exhausted');
        }
        run.seq++;
        const progress = this.message(run, 'task.progress', { seq: run.seq,
          state: run.phase === 'starting' ? 'starting' : 'working' });
        run.progress = { msg_id: progress.msg_id, seq: run.seq, sentAt: now };
        run.heartbeatAt = now + Math.max(1, Math.floor(run.leaseMs / 3));
        outbox.push(progress);
        return true;
      });
    });
  }

  private finish(fence: RunFence, outcome: RunOutcome): void {
    this.change((state, outbox) => {
      const run = state.slot;
      if (!run || !same(run.fence, fence)) return false;
      const final = run.stopReason ? failed(run.stopReason) : outcome;
      if (run.cancelMsgId) outbox.push(this.message(run, 'task.cancel.ack', { completed_before_cancel: false }, run.cancelMsgId));
      else outbox.push(this.message(run, final.kind === 'result' ? 'task.result' : 'task.fail', final.body));
      state.last = { fence: { ...fence }, lead: run.lead, outcome: structuredClone(final) };
      state.slot = null;
      return true;
    });
    if (this.live && same(this.live.fence, fence)) this.live = undefined;
  }

  private unknown(fence: RunFence, reason: StopReason = 'execution_interrupted'): void {
    this.change((state) => {
      if (!state.slot || !same(state.slot.fence, fence)) return false;
      state.slot.phase = 'recovery_required';
      state.slot.stopReason ??= reason;
      return true;
    });
    this.notifyFault();
  }

  /** Reconcile old external work, never replay a possibly invoked start. */
  async recover(): Promise<void> {
    this.assertHealthy();
    // In-process start/stop reconciliation owns any in-flight handle; do not race it with recovery.
    if (this.starting || (this.ready && this.settling)) {
      if (this.settling) await this.settling;
      return;
    }
    if (this.recovering) return this.recovering;
    this.recovering = this.checkedAsync(async () => {
      const run = this.snapshot().slot;
      if (run?.mayHaveStarted && (!this.live || run.phase === 'recovery_required')) {
        let status: 'stopped' | 'unknown' = 'unknown';
        try {
          status = await this.bounded(Promise.resolve().then<'stopped' | 'unknown'>(() =>
            this.opts.driver?.recover(Object.freeze({ ...run.fence })) ?? 'unknown'));
        }
        catch { /* Driver failure cannot prove quiescence. */ }
        this.assertHealthy();
        if (status === 'stopped') this.finish(run.fence, failed('execution_interrupted'));
        else this.unknown(run.fence);
      }
      this.completeOldEffects();
      this.ready = true;
    });
    try { await this.recovering; } finally { this.recovering = undefined; }
  }

  private completeOldEffects(): void {
    const fence = this.snapshot().slot?.fence;
    for (const effect of this.opts.store.pendingEffects(undefined, true)) {
      if (effect.stateKey === STATE_KEY && effect.kind === EFFECT_KIND && effect.id !== fence?.run_id) {
        // Slot/generation reconciliation, NOT effect revision alone, proves this intent is obsolete.
        this.opts.store.completeEffect(effect.id, STATE_KEY, effect.revision, true);
      }
    }
  }

  private async start(run: DurableRun): Promise<void> {
    const committed = this.change((state) => {
      if (!state.slot || !same(state.slot.fence, run.fence) || state.slot.phase !== 'prepared') return false;
      state.slot.phase = 'starting'; state.slot.mayHaveStarted = true; return true;
    });
    if (!committed) return;
    let handle: RunHandle;
    this.starting = true;
    const pending = Promise.resolve().then(() => {
      this.assertHealthy();
      return this.opts.driver!.start(Object.freeze({ ...run.fence }), structuredClone(run.offer));
    });
    try { handle = await this.bounded(pending); }
    catch (error) {
      if (error instanceof DriverTimeoutError) {
        // Keep starting latched until the actual invocation settles. Recovery must not
        // release the fence while this start can still produce external work.
        void this.checkedAsync(async () => {
          try {
            let late: RunHandle;
            try { late = await pending; } catch { return; }
            const live = this.attach(run, late);
            let outcome: RunOutcome;
            try { outcome = await this.quiesce(live); }
            catch {
              if (!this.faulted) this.unknown(run.fence, 'driver_start_timeout');
              return;
            }
            if (!this.faulted) {
              this.finish(run.fence, outcome);
              this.completeOldEffects();
            }
          } finally { this.starting = false; }
        }).catch(() => { /* checkedAsync already fenced and notified the fault. */ });
      } else this.starting = false;
      this.unknown(run.fence, error instanceof DriverTimeoutError ? 'driver_start_timeout' : 'execution_interrupted');
      return;
    }
    this.starting = false;
    const live = this.attach(run, handle);
    // A consume/tick storage failure can happen while start is awaiting the driver.
    if (this.faulted) {
      try { await this.quiesce(live); } catch { this.notifyFault(); }
      this.assertHealthy();
    }
    this.change((state) => {
      if (!state.slot || !same(state.slot.fence, run.fence) || state.slot.phase !== 'starting') return false;
      state.slot.phase = 'running'; return true;
    });
  }

  private attach(run: DurableRun, handle: RunHandle): LiveRun {
    const live: LiveRun = { fence: { ...run.fence }, handle, closedFault: false, closure: handle.closed };
    // Callbacks only update their own captured handle, never SQL or a newer run.
    void live.closure.then((outcome) => {
      try {
        if (!validOutcome(outcome)) throw new Error('Invalid driver outcome');
        live.outcome = structuredClone(outcome);
      } catch { live.closedFault = true; }
    }, () => { live.closedFault = true; });
    this.live = live;
    if (!isLeaseFence(handle.fence) || !same(handle.fence, run.fence)) {
      // Latch a fatal fault before any closure can be applied to the expected fence.
      this.failClosed();
      throw new Error('Driver returned a different run fence');
    }
    return live;
  }

  private quiesce(live: LiveRun): Promise<RunOutcome> {
    // One stop invocation per exact handle. Late proof is retained even after a bounded wait fails.
    live.quiescence ??= this.bounded(Promise.race([
      Promise.resolve().then(() => live.handle.stop()).then(() => failed('stopped')),
      // A rejected closed promise is NOT closure; stop may still confirm it.
      live.closure.then((outcome) => {
        if (!validOutcome(outcome)) throw new Error('Invalid driver outcome');
        return structuredClone(outcome);
      }).catch(() => new Promise<RunOutcome>(() => {})),
    ]).then((outcome) => { live.outcome ??= outcome; return outcome; }));
    return live.quiescence;
  }

  private async stop(run: DurableRun, live: LiveRun): Promise<void> {
    let outcome: RunOutcome;
    try { outcome = await this.quiesce(live); }
    catch { this.unknown(run.fence); return; }
    this.finish(run.fence, outcome);
  }

  /**
   * Drive pending intents outside SQL. Background this promise in a pump so consume/tick
   * continue during bounded driver waits. Concurrent callers share reconciliation.
   */
  async settle(): Promise<void> {
    if (this.settling) return this.settling;
    this.settling = this.checkedAsync(async () => {
      this.assertHealthy();
      if (!this.ready) await this.recover();
      // A slot needs at most start -> stop/finish -> empty. Never spin on synchronous callbacks.
      for (let pass = 0; pass < 4; pass++) {
        this.tick();
        const run = this.snapshot().slot;
        if (!run) break;
        const live = this.live;
        if (live && !same(live.fence, run.fence)) throw new Error('Executor live fence mismatch');
        if (live?.outcome) { this.finish(run.fence, live.outcome); continue; }
        if (run.phase === 'prepared') {
          if (!this.opts.driver) { this.finish(run.fence, failed('driver_unavailable')); continue; }
          await this.start(run);
          continue;
        }
        if (run.phase === 'stopping') {
          if (!run.mayHaveStarted) { this.finish(run.fence, failed(run.stopReason ?? 'stopped')); continue; }
          if (live) { await this.stop(run, live); continue; }
          this.unknown(run.fence);
        } else if (live?.closedFault && run.phase !== 'recovery_required') this.unknown(run.fence);
        break;
      }
      this.completeOldEffects();
    });
    try { await this.settling; } finally { this.settling = undefined; }
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      this.checked(() => {
        this.assertHealthy();
        this.change((state) => {
          const run = state.slot;
          if (!run || run.phase === 'recovery_required') return false;
          run.phase = 'stopping'; run.stopReason ??= 'shutdown'; return true;
        });
      });
      await this.settle();
      if (this.snapshot().slot || this.live || this.starting) throw new Error('Executor closure unconfirmed; recovery required');
    } catch (error) {
      // Even with unavailable storage, stop a known exact handle. Never clear its durable slot
      // or turn the original storage failure into a successful close.
      this.notifyFault();
      if (this.live) {
        try { await this.quiesce(this.live); } catch { this.notifyFault(); }
      }
      throw error;
    }
  }
}