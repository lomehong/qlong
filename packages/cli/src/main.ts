/**
 * qlong CLI(M1.4 雏形):demo = 单机总线端到端;takeover = 同机重启接管演练。
 * 正式长驻进程与跨机命令随 M2/M3 落地。
 */
import { SingleNodeHarness } from '../../node/src/local/harness.js';
import { LeadSupervisor } from '../../node/src/lead/supervisor.js';
import { MemoryStore } from '../../node/src/lead/store.js';

const cmd = process.argv[2] ?? 'demo';

if (cmd === 'demo') {
  const h = new SingleNodeHarness({
    kind: 'project',
    script: [
      { failAfter: { ms: 1_000, body: { reason_code: 'internal_error', retryable: true, summary: '瞬态错误' } } },
      { completeAfterMs: 2_000, resultBody: { summary: '重做成功' } },
    ],
  });
  h.startTask();
  h.advanceTo(200_000);
  console.log('state        :', h.lead.rec.state);
  console.log('attempt      :', h.lead.rec.attempt);
  console.log('heartbeats   :', h.heartbeatCount);
  console.log('audit events :', h.audits.map((a) => a.event).join(', '));
  process.exit(h.lead.rec.state === 'done' && h.lead.rec.attempt === 2 ? 0 : 1);
}

if (cmd === 'takeover') {
  const store = new MemoryStore();
  const s1 = new LeadSupervisor({ store });
  const m1 = s1.create('demo-task', 'project');
  s1.dispatch('demo-task', 'node-b', { kind: 'project', summary: '接管演练', lease_ms: 300000, offer_ttl_ms: 60000 }, 0);
  s1.deliver('demo-task', 'task.accept', 'node-b', 1, { lease_ms: 300000 }, 0);
  console.log('before crash :', m1.rec.state, '| attempt', m1.rec.attempt);
  // —— 进程崩溃:内存全丢,仅检查点存储幸存 ——
  const s2 = new LeadSupervisor({ store });
  s2.restoreAll();
  const m2 = s2.get('demo-task');
  console.log('after restore:', m2?.rec.state, '| attempt', m2?.rec.attempt);
  s2.deliver('demo-task', 'task.result', 'node-b', 1, { status: 'done', summary: '恢复后交付' }, 100);
  console.log('after result :', m2?.rec.state);
  process.exit(m2?.rec.state === 'done' ? 0 : 1);
}

if (cmd === 'status') {   console.log('qlong v0.2');   console.log('Team: ' + (process.env.QLONG_TEAM_ID ?? '(unset)'));   console.log('Registry: ' + (process.env.QLONG_REGISTRY_URL ?? 'http://127.0.0.1:3200'));   process.exit(0); } if (cmd === 'tasks') {   const regUrl = process.env.QLONG_REGISTRY_URL ?? 'http://127.0.0.1:3200';   const teamId = process.env.QLONG_TEAM_ID ?? '';   const tok = process.env.QLONG_NODE_TOKEN ?? '';   if (!teamId || !tok) { console.error('set QLONG_TEAM_ID + QLONG_NODE_TOKEN'); process.exit(1); }   const res = await fetch(regUrl + '/v1/teams/' + teamId + '/tasks', { headers: { Authorization: 'Bearer ' + tok } });   const d = await res.json() as { tasks?: Array<{ task_id: string; status: string; type: string }> };   for (const t of d.tasks ?? []) console.log(t.task_id.slice(0, 12), t.type, t.status);   process.exit(0); } console.log('usage: qlong <demo|takeover|status|tasks>');
process.exit(2);