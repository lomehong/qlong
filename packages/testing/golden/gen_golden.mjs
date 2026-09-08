import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const jcsInput = JSON.parse(String.raw`{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/", "literals": [null, true, false]}`);
const jcsExpected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;

writeFileSync(
  join(here, 'jcs.json'),
  JSON.stringify(
    {
      spec: 'RFC 8785 JCS golden vectors — cross-language signature interop (QLONG_DESIGN_01 §3.3.2 / D23)',
      cases: [
        { name: 'rfc8785-numbers-string-literals', input: jcsInput, expected: jcsExpected },
        { name: 'utf16-key-order', input: { '€uro': 1, alpha: 3, Beta: 2 }, expected: '{"Beta":2,"alpha":3,"€uro":1}' },
      ],
    },
    null,
    2,
  ) + '\n',
);

const teamId = randomUUID();
const nodeA = randomUUID();
const nodeB = randomUUID();

const offerProject = {
  v: 1,
  type: 'task.offer',
  msg_id: randomUUID(),
  ts: '2026-09-06T12:00:00+08:00',
  exp: '2026-09-07T12:00:00+08:00',
  from: { node_id: nodeA, team_id: teamId, key_epoch: 1 },
  to: { node_id: nodeB, team_id: teamId },
  trace: { trace_id: randomUUID(), parent_span: null, origin_node: nodeA },
  hops: 0,
  task_id: randomUUID(),
  attempt: 1,
  body: {
    kind: 'project',
    summary: '为示例仓库补齐 README 的安装一节',
    contract: {
      deliverables: [{ path: 'README.md', desc: '新增 ## 安装 小节' }],
      acceptance: [{ check: 'README.md 含 ## 安装 小节', machine_checkable: true }],
    },
    offer_ttl_ms: 60000,
    lease_ms: 300000,
    project: { project_id: randomUUID(), lead_node: nodeA },
    required_caps: ['tool:node@20'],
  },
};

const offerAid = {
  v: 1,
  type: 'task.offer',
  msg_id: randomUUID(),
  ts: '2026-09-06T12:00:00+08:00',
  exp: '2026-09-07T12:00:00+08:00',
  from: { node_id: nodeB, team_id: teamId, key_epoch: 1 },
  to: { node_id: nodeA, team_id: teamId },
  trace: { trace_id: randomUUID(), parent_span: null, origin_node: nodeB },
  hops: 0,
  task_id: randomUUID(),
  attempt: 1,
  body: { kind: 'aid', summary: '口头确认 5432 端口是否可达', offer_ttl_ms: 10000, lease_ms: 120000 },
};

const rpcAsk = {
  v: 1,
  type: 'rpc.ask',
  msg_id: randomUUID(),
  ts: '2026-09-06T12:00:00+08:00',
  from: { node_id: nodeA, team_id: teamId, key_epoch: 1 },
  to: { node_id: nodeB, team_id: teamId },
  trace: { trace_id: randomUUID(), parent_span: null, origin_node: nodeA },
  body: { request_id: randomUUID(), question: '当前分支名?', timeout_ms: 5000 },
};

for (const [name, obj] of [
  ['task-offer.project', offerProject],
  ['task-offer.aid', offerAid],
  ['rpc.ask', rpcAsk],
]) {
  writeFileSync(join(here, 'envelopes', name + '.json'), JSON.stringify(obj, null, 2) + '\n');
}

writeFileSync(
  join(here, 'envelopes', 'README.md'),
  '# 黄金信封样本\n\n未签名信封(即签名输入 signature_input 的载体;sig 字段由签名方附加,签法见 01 篇 §3.3.2 / D23)。\n测试与跨语言互操作以此为准。\n',
);
console.log('golden written');