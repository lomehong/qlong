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
import { serviceDefinition, serviceInstall, serviceUninstall, type ServicePlatform } from './service.js';
import { assertNodeRuntime, MIN_NODE_MAJOR } from './runtime.js';

try {
  assertNodeRuntime(process.versions.node);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const cmd = process.argv[2] ?? 'demo';

if (cmd === 'demo') {
  const h = new SingleNodeHarness({
    kind: 'project',
    validateAcceptance: () => true, // 离线冒烟演练;PROJECT 验收闸语义见 machine-safety 测试
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
  const validateAcceptance = (): boolean => true; // 离线冒烟演练;PROJECT 验收闸语义见 machine-safety 测试
  const s1 = new LeadSupervisor({ store, validateAcceptance });
  const m1 = s1.create('demo-task', 'project');
  s1.dispatch('demo-task', 'node-b', { kind: 'project', summary: '接管演练', lease_ms: 300000, offer_ttl_ms: 60000 }, 0);
  s1.deliver('demo-task', 'task.accept', 'node-b', 1, { lease_ms: 300000 }, 0);
  console.log('before crash :', m1.rec.state, '| attempt', m1.rec.attempt);
  // —— 进程崩溃:内存全丢,仅检查点存储幸存 ——
  const s2 = new LeadSupervisor({ store, validateAcceptance });
  s2.restoreAll();
  const m2 = s2.get('demo-task');
  console.log('after restore:', m2?.rec.state, '| attempt', m2?.rec.attempt);
  s2.deliver('demo-task', 'task.result', 'node-b', 1, { status: 'done', summary: '恢复后交付' }, 100);
  console.log('after result :', m2?.rec.state);
  process.exit(m2?.rec.state === 'done' ? 0 : 1);
}

/** stdin 读取一行(安装器经管道传入邀请码,评审 I-16:不进 history/进程参数) */
async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

if (cmd === 'enroll') {
  const stdinFlag = process.argv.includes('--stdin');
  const positional = process.argv.slice(3).filter((a) => !a.startsWith('--'))[0];
  const flag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const token = stdinFlag ? await readStdinLine() : positional;
  const registryUrl = (flag('--registry', process.env.QLONG_REGISTRY_URL) ?? 'http://127.0.0.1:3200') as string;
  const gatewayUrl = (flag('--gateway', process.env.QLONG_GATEWAY_URL) ?? 'ws://127.0.0.1:3100') as string;
  const caps = (flag('--caps', process.env.QLONG_CAPS ?? '') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!token) {
    console.error('缺少邀请码:请经 stdin 传入(qlong enroll --stdin < token)或作为位置参数');
    console.error('邀请码无效/过期时,请回到控制台或 /install 页面重新生成');
    process.exit(1);
  }
  try {
    const cfg = await joinAndSave({ registryUrl, gatewayUrl, token, caps });
    console.log('入网完成: node', cfg.node_id, '| team', cfg.team_id);
    process.exit(0);
  } catch (e) {
    console.error('入网失败:', e instanceof Error ? e.message : e);
    console.error('邀请码无效/过期时,请回到控制台或 /install 页面重新生成,重跑同一安装命令即可');
    process.exit(1);
  }
}

if (cmd === 'service') {
  const action = process.argv[3] ?? 'install';
  const platform = process.platform as ServicePlatform;
  const entrance = process.argv[1] ?? 'qlong';
  const home = qlongHome();
  // 额外参数原样透传给注册的 `qlong run`(存储准入等);保证自启与手跑同一配置。
  const runArgs = process.argv.slice(4);
  if (action === 'install') {
    const r = await serviceInstall(platform, entrance, home, runArgs);
    console.log('服务已注册:', r.path || '(计划任务)');
    console.log('自启已启用:重启后节点自动在线');
    process.exit(0);
  }
  if (action === 'uninstall') {
    await serviceUninstall(platform, entrance, home);
    console.log('服务已卸载(自启解除)');
    process.exit(0);
  }
  console.log('usage: qlong service <install|uninstall>');
  process.exit(2);
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
    console.log('下一步: qlong run --storage-mode create --confirm-local-filesystem(首次;之后改 open)');
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
  // 持久 v2 节点:显式存储准入(与中心同语义);不再默认走旧内存演示链路。
  const { runStorageOptions } = await import('./run-storage-options.js');
  const { createDurableNode } = await import('../../node/src/runtime/node.js');
  const { FencedProcessDriver } = await import('../../node/src/driver/fenced-driver.js');
  const { PersistentRunHandleStore } = await import('../../node/src/runtime/run-handles.js');
  const { loadIdentity } = await import('../../node/src/identity.js');
  let node: Awaited<ReturnType<typeof createDurableNode>>;
  try {
    node = await createDurableNode({
      registryUrl: cfg.registry_url,
      gatewayUrl: cfg.gateway_url,
      nodeToken: cfg.node_token,
      // identity.json 同源:join 时生成,run 时恢复(02 §3.2);绝不自动生成替代密钥
      privKey: process.env.QLONG_PRIV_B64
        ? new Uint8Array(Buffer.from(process.env.QLONG_PRIV_B64, 'base64'))
        : loadIdentity(home).priv,
      storage: runStorageOptions(process.argv.slice(3), process.env, home),
      // 工厂形式:用 createDurableNode 内部装配的持久 runtime 背书 run handle(C1c),
      // 使 fence→pid+启动证据跨进程重启存活,recover 得以据持久句柄判定静默。
      driver: (runtime) => new FencedProcessDriver({
        workdir: home,
        runHandles: new PersistentRunHandleStore(runtime),
      }),
      driverTimeoutMs: 15_000, // npx 冷启动可能较慢;有界等待仍封顶执行器契约
      capabilities: () => cfg.caps,
      reportIntervalMs: 60_000,
    });
  } catch (e) {
    console.error('节点启动失败:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
  await node.start();
  console.log('qlong 节点已启动(持久 v2):', cfg.node_id, '@', cfg.registry_url);
  console.log('节点存储:', node.store.path);
  console.log('Ctrl+C 退出(关停会静默在跑任务并把终态落中心)');
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void node.stop().then(
      () => process.exit(0),
      () => {
        console.error('关停未完全收口:请保留节点数据目录,恢复后用 open 模式重启');
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await new Promise(() => undefined); // 常驻
}

if (cmd === 'server') {
  const { startQlongServer } = await import('./server.js');
  const { serverStorageOptions } = await import('./server-storage-options.js');
  const flag = (name: string, def: number): number => {
    const i = process.argv.indexOf(name);
    return i > 0 ? Number(process.argv[i + 1]) : def;
  };
  const sflag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  // 默认单端口(PORT/7860 兼容容器平台):registry API + 书坊 + 控制台 + 网关 ws(/gateway)
  const handles = await startQlongServer({
    ...serverStorageOptions(process.argv.slice(3), process.env),
    registryPort: flag('--registry-port', Number(process.env.PORT ?? 3200)),
    gatewayPort: process.argv.includes('--gateway-port') ? flag('--gateway-port', 3100) : undefined,
    gatewayPath: process.argv.includes('--gateway-port') ? undefined : '/gateway',
    distDir: sflag('--dist-dir', process.env.QLONG_DIST_DIR),
    seedTeam: process.argv.includes('--no-seed-team') ? false : {},
    // v0.8:收件箱落盘 + 网关集群(02 §12.1)——环境变量驱动,容器编排友好
    authPersistDir: process.env.QLONG_AUTH_DIR,
    inboxPersistFile: process.env.QLONG_MAILBOX_FILE,
    clusterSecret: sflag('--cluster-secret', process.env.QLONG_CLUSTER_SECRET),
    clusterName: sflag('--cluster-name', process.env.QLONG_CLUSTER_NAME),
    clusterPeers: (process.env.QLONG_CLUSTER_PEERS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    // d1d:custody 集群中继(多 authority 共享同一中心库)——环境变量驱动,容器编排友好
    relaySecret: sflag('--relay-secret', process.env.QLONG_RELAY_SECRET),
    relayPeers: (process.env.QLONG_RELAY_PEERS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  });
  console.log('qlong server:http://' + (handles.storageMode === 'ephemeral' ? '127.0.0.1:' : '0.0.0.0:') + handles.registryPort, handles.gatewayPath ? '| 网关 ws 同端口 ' + handles.gatewayPath : '| 网关 ws://127.0.0.1:' + handles.gatewayPort);
  console.log('中心存储:', handles.storageMode, handles.storageMode === 'ephemeral' ? '| 内存演示形态' : '| custody mailbox/claim 注册表/任务投影持久化');
  if (handles.cluster) {
    console.log('网关集群:密钥已启用' + (handles.cluster.size > 1 ? ',成员 ' + handles.cluster.size : '(单实例形态)'));
  }
  if (process.env.QLONG_RELAY_SECRET) {
    console.log('custody 集群中继:/internal/pump 已启用,peers ' + (process.env.QLONG_RELAY_PEERS ?? '(无)'));
  }
  if (sflag('--dist-dir', process.env.QLONG_DIST_DIR)) {
    console.log('书坊分发 → /install /install.sh /install.ps1 /releases/<版本>/ | 控制台 → /');
  }
  console.log('Ctrl+C 退出');
  const shutdown = (): void => {
    void handles.close().then(() => { process.exit(0); }, () => {
      console.error('中心关闭失败,请保留数据目录并检查恢复状态');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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

if (cmd === 'doctor') {
  console.log('qlong doctor(真实联调前检查)');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(nodeMajor >= MIN_NODE_MAJOR ? '✓ node ' + process.versions.node + ' >= 24' : '✗ Node.js 需 >= 24');
  if (process.env.DSH_HARNESS_CMD) {
    console.log('✓ DSH_HARNESS_CMD =', process.env.DSH_HARNESS_CMD);
  } else {
    console.log('○ dsh 走默认 npx 通道(首次任务会拉取 @deepseek-ai/dsh,需 npm 网络)');
    console.log('  模型凭证按 dsh 文档在 headless profile 侧配置');
  }
  const home = qlongHome();
  let joined = false;
  try { const c = readConfig(home); joined = true; console.log('✓ 已入网: node', c.node_id, '| team', c.team_id, '| registry', c.registry_url); } catch { console.log('○ 未入网(qlong join <token>)'); }
  if (joined) {
    try {
      const cfg = readConfig(home);
      const res = await fetch(cfg.registry_url + '/v1/nodes/me', { headers: { Authorization: 'Bearer ' + cfg.node_token } });
      console.log(res.ok ? '✓ registry 可达且凭证有效(' + res.status + ')' : '✗ registry 返回 ' + res.status + '(token 失效/服务未启动)');
    } catch (e) {
      console.log('✗ registry 不可达:', e instanceof Error ? e.message : e);
    }
  }
  console.log('提示:任务执行会调用 deepseek-harness(dsh);模型凭证见 https://deepseek-harness.github.io/deepseek-harness/');
  process.exit(0);
}

console.log('usage: qlong <demo|takeover|enroll|join|run|service|server|doctor|status|tasks>');
process.exit(2);
