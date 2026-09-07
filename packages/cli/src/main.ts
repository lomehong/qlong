/**
 * qlong CLI:v0.3 运营面。
 * - demo / takeover  : 单机总线端到端 + 同机重启接管演练(M1 演练命令)
 * - join             : 生成/恢复身份 → enroll → 写配置(02 §4)
 * - run              : 读取配置,组装生产节点并常驻(factory,01 §9)
 * - server           : 单进程中心三件套(registry HTTP + 通讯网关 ws)
 * - status / tasks   : 查询
 */
import { SingleNodeHarness } from '../../node/src/local/harness.js';
import { LeadSupervisor } from '../../node/src/lead/supervisor.js';
import { MemoryStore } from '../../node/src/lead/store.js';
import { joinAndSave, qlongHome, readConfig } from './join.js';

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

if (cmd === 'join') {
  const token = process.argv[3];
  const flag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const registryUrl = flag('--registry', process.env.QLONG_REGISTRY_URL ?? 'http://127.0.0.1:3200') as string;
  const gatewayUrl = flag('--gateway', process.env.QLONG_GATEWAY_URL ?? 'ws://127.0.0.1:3100') as string;
  const caps = (flag('--caps', process.env.QLONG_CAPS ?? '') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const cfg = await joinAndSave({ registryUrl, gatewayUrl, token, caps });
    console.log('入网完成:');
    console.log('  node_id :', cfg.node_id);
    console.log('  team_id :', cfg.team_id);
    console.log('  caps    :', cfg.caps.join(', ') || '(无)');
    console.log('下一步: qlong run');
    process.exit(0);
  } catch (e) {
    console.error('入网失败:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

if (cmd === 'run') {
  const home = qlongHome();
  let cfg: ReturnType<typeof readConfig>;
  try {
    cfg = readConfig(home);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  const { createProductionNode } = await import('../../node/src/remote/factory.js');
  const node = await createProductionNode({
    registryUrl: cfg.registry_url,
    gatewayUrl: cfg.gateway_url,
    nodeToken: cfg.node_token,
    dataDir: home, // identity.json 同源:join 时生成,run 时恢复(02 §3.2)
    privKey: process.env.QLONG_PRIV_B64
      ? new Uint8Array(Buffer.from(process.env.QLONG_PRIV_B64, 'base64'))
      : undefined, // 缺省由 dataDir/identity.json 提供(02 §3.2)
    capabilities: () => cfg.caps,
    reportIntervalMs: 60_000,
  });
  await node.start();
  console.log('qlong 节点已启动:', cfg.node_id, '@', cfg.registry_url);
  console.log('Ctrl+C 退出');
  process.on('SIGINT', () => {
    node.stop();
    process.exit(0);
  });
  await new Promise(() => undefined); // 常驻
}

if (cmd === 'server') {
  const { startQlongServer } = await import('./server.js');
  const flag = (name: string, def: number): number => {
    const i = process.argv.indexOf(name);
    return i > 0 ? Number(process.argv[i + 1]) : def;
  };
  const handles = await startQlongServer({
    registryPort: flag('--registry-port', 3200),
    gatewayPort: flag('--gateway-port', 3100),
  });
  console.log('qlong server:registry http://127.0.0.1:' + handles.registryPort, '| gateway ws://127.0.0.1:' + handles.gatewayPort);
  console.log('Ctrl+C 退出');
  process.on('SIGINT', () => {
    void handles.close();
    process.exit(0);
  });
  await new Promise(() => undefined); // 常驻
}

if (cmd === 'status') {
  console.log('qlong v0.3');
  console.log('Home   :', qlongHome());
  try {
    const cfg = readConfig();
    console.log('Team   :', cfg.team_id);
    console.log('Node   :', cfg.node_id);
    console.log('Registry:', cfg.registry_url);
  } catch {
    console.log('未入网(qlong join <token>)');
  }
  process.exit(0);
}

if (cmd === 'tasks') {
  const regUrl = process.env.QLONG_REGISTRY_URL ?? 'http://127.0.0.1:3200';
  const teamId = process.env.QLONG_TEAM_ID ?? '';
  const tok = process.env.QLONG_NODE_TOKEN ?? '';
  if (!teamId || !tok) {
    console.error('set QLONG_TEAM_ID + QLONG_NODE_TOKEN');
    process.exit(1);
  }
  const res = await fetch(regUrl + '/v1/teams/' + teamId + '/tasks', { headers: { Authorization: 'Bearer ' + tok } });
  const d = (await res.json()) as { tasks?: Array<{ task_id: string; status: string; type: string }> };
  for (const t of d.tasks ?? []) console.log(t.task_id.slice(0, 12), t.type, t.status);
  process.exit(0);
}

console.log('usage: qlong <demo|takeover|join|run|server|status|tasks>');
process.exit(2);
