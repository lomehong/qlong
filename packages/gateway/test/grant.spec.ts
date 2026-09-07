import { describe, expect, it } from 'vitest';
import type { EnvelopeV1 } from '@qlong/core';
import { newId } from '@qlong/core';
import { evaluateUplink } from '../src/acl.js';
import type { EnvelopeHeadLite, GatewayConnection, GatewayDirectorySnapshot } from '../src/types.js';

const TX = 't-x';
const TY = 't-y';
const A = 'aaa';
const B = 'bbb';

const dir: GatewayDirectorySnapshot = {
  epoch: 1,
  nodes: [
    { node_id: A, team_id: TX, status: 'active', currentEpoch: 1 },
    { node_id: B, team_id: TY, status: 'active', currentEpoch: 1 },
  ],
};

let grantActive = false;
const testGrant = (from: string, to: string): boolean => grantActive;

function connFor(nodeId: string, teamId: string): GatewayConnection {
  return { connId: 'c-' + nodeId, nodeId, teamId, connectedAt: 0 };
}

function mkOffer(fromId: string, fromTeam: string, toId: string, toTeam?: string): EnvelopeHeadLite {
  const env = mkEnvelope(fromId, fromTeam, toId, toTeam);
  return { ...env, envelope: env };
}

function mkEnvelope(fromId: string, fromTeam: string, toId: string, toTeam?: string): EnvelopeV1 {
  return {
    v: 1,
    type: 'task.offer',
    msg_id: newId(),
    ts: new Date().toISOString(),
    exp: new Date(Date.now() + 3600000).toISOString(),
    from: { node_id: fromId, team_id: fromTeam, key_epoch: 1 },
    to: { node_id: toId, ...(toTeam ? { team_id: toTeam } : {}) },
    trace: { trace_id: newId(), parent_span: null, origin_node: fromId },
    hops: 0,
    task_id: newId(),
    attempt: 1,
    sig: { alg: 'ed25519', value: 'x' },
    body: { kind: 'aid', summary: 's' },
  };
}

describe('D1 cross-team grant', () => {
  it('no grant -> routing_denied', () => {
    grantActive = false;
    const v = evaluateUplink({
      conn: connFor(A, TX),
      head: mkOffer(A, TX, B, TY),
      dir: { snapshotEpoch: 1, lookup: (id) => dir.nodes.find((n) => n.node_id === id), grantLookup: testGrant },
    });
    expect(v.verdict).toBe('routing_denied');
  });

  it('grant TX->TY -> route', () => {
    grantActive = true;
    const v = evaluateUplink({
      conn: connFor(A, TX),
      head: mkOffer(A, TX, B, TY),
      dir: { snapshotEpoch: 1, lookup: (id) => dir.nodes.find((n) => n.node_id === id), grantLookup: testGrant },
    });
    expect(v.verdict).toBe('route');
  });

  it('reverse: B(TY) -> A(TX) with grant -> route', () => {
    grantActive = true;
    const connB = connFor(B, TY);
    const env = mkEnvelope(B, TY, A, TX);
    const v = evaluateUplink({
      conn: connB,
      head: { ...env, envelope: env },
      dir: { snapshotEpoch: 1, lookup: (id) => dir.nodes.find((n) => n.node_id === id), grantLookup: testGrant },
    });
    expect(v.verdict).toBe('route');
  });

  it('no grantActive -> routing_denied again', () => {
    grantActive = false;
    const v = evaluateUplink({
      conn: connFor(B, TY),
      head: mkOffer(B, TY, A),
      dir: { snapshotEpoch: 1, lookup: (id) => dir.nodes.find((n) => n.node_id === id), grantLookup: testGrant },
    });
    expect(v.verdict).toBe('routing_denied');
  });
});