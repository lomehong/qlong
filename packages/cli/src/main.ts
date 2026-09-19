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
import { QLONG_USER_AGENT } from '@qlong/core';
import { serviceDefinition, serviceInstall, serviceUninstall, type ServicePlatform } from './service.js';
import { assertNodeRuntime, MIN_NODE_MAJOR } from './runtime.js';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readLocalDshCmd } from './dsh-cmd.js';

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
  const artifactRepo = flag('--artifact-repo', process.env.QLONG_ARTIFACT_REPO);
  if (!token) {
    console.error('缺少邀请码:请经 stdin 传入(qlong enroll --stdin < token)或作为位置参数');
    console.error('邀请码无效/过期时,请回到控制台或 /install 页面重新生成');
    process.exit(1);
  }
  try {
    const cfg = await joinAndSave({ registryUrl, gatewayUrl, token, caps, artifactRepo });
    console.log('入网完成: node', cfg.node_id, '| team', cfg.team_id);
    // 不 process.exit:fetch 的空闲 TLSSocket 在强制退出时触发 libuv 断言崩溃
    // (Windows/Node24,src\winsync.c);空闲连接已 unref,自然排空即干净退出。
  } catch (e) {
    console.error('入网失败:', e instanceof Error ? e.message : e);
    console.error('邀请码无效/过期时,请回到控制台或 /install 页面重新生成,重跑同一安装命令即可');
    process.exitCode = 1;
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
  const artifactRepo = flag('--artifact-repo', process.env.QLONG_ARTIFACT_REPO);
  try {
    const cfg = await joinAndSave({ registryUrl, gatewayUrl, token, caps, artifactRepo });
    console.log('入网完成:');
    console.log('  node_id :', cfg.node_id);
    console.log('  team_id :', cfg.team_id);
    console.log('  caps    :', cfg.caps.join(', ') || '(无)');
    if (cfg.artifact_repo) console.log('  artifact_repo :', cfg.artifact_repo);
    console.log('下一步: qlong run --storage-mode create --confirm-local-filesystem(首次;之后改 open)');
    // 同 enroll:自然排空退出,避免 TLS 句柄强制关闭崩溃
  } catch (e) {
    console.error('入网失败:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
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
  const { FencedWorkspace } = await import('../../node/src/collab/workspace.js');
  const { PersistentRunHandleStore } = await import('../../node/src/runtime/run-handles.js');
  const { loadIdentity } = await import('../../node/src/identity.js');
  // 单机的龙 = 完整 dsh 运行时:安装器写入 dsh.json 后优先本地运行时(离线可用、版本固定)
  { const localDsh = readLocalDshCmd(home); if (localDsh) process.env.DSH_HARNESS_CMD = localDsh; }
  // ---- 第 2 步:牵头生产链路旗标(--originate / --auto-select / --takeover)----
  const sflag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const originateFile = sflag('--originate');
  const takeoverFile = sflag('--takeover');
  const takeoverKeyHex = sflag('--takeover-key');
  if (takeoverFile !== undefined && takeoverKeyHex === undefined) throw new Error('--takeover 需要 --takeover-key <64位hex>');
  if (takeoverFile === undefined && takeoverKeyHex !== undefined) throw new Error('--takeover-key 需要 --takeover <文件>');
  let originate: Record<string, unknown> | undefined;
  if (originateFile !== undefined) {
    originate = JSON.parse((await import('node:fs')).readFileSync(originateFile, 'utf8')) as Record<string, unknown>;
    if (originate.kind !== 'aid' && originate.kind !== 'project') throw new Error('--originate 文件 kind 必须为 "aid" 或 "project"');
    if (typeof originate.summary !== 'string' || originate.summary.length === 0) throw new Error('--originate 文件需要非空 summary');
  }
  // 目录驱动选择器:后台 30s 刷新 + 同步快照;快照空 → 任务留 drafting 等 tick 重试(绝不瞎派)。
  const selectorHandle = (process.argv.includes('--auto-select') || originateFile !== undefined)
    ? (async () => {
      const { createTargetSelector } = await import('../../node/src/runtime/target-select.js');
      const template: Record<string, unknown> = {
        lease_ms: 300_000, offer_ttl_ms: 60_000, ...originate,
      };
      delete template.kind;
      delete template.target;
      const handle = createTargetSelector({
        selfNodeId: cfg.node_id,
        fetchDirectory: async () => {
          const res = await fetch(cfg.registry_url.replace(/\/+$/, '') + `/v1/teams/${encodeURIComponent(cfg.team_id)}/nodes`, {
            headers: { Authorization: 'Bearer ' + cfg.node_token, 'User-Agent': QLONG_USER_AGENT },
            signal: AbortSignal.timeout(5_000),
            redirect: 'error',
          });
          if (!res.ok) throw new Error('directory fetch ' + res.status);
          return ((await res.json()) as { nodes?: Array<{ node_id: string; status: string; caps?: string[] | null }> }).nodes ?? [];
        },
        offerTemplate: template,
      });
      return handle;
    })()
    : undefined;
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
      // e2d-1:cwd 不再是静态 home——执行器为每个 fence 解析隔离工作区并传入 ctx.cwd,
      // 故此处不再设 workdir;缺省工作区根落在 os.tmpdir 下(跨平台安全)。
      driver: (runtime) => new FencedProcessDriver({
        runHandles: new PersistentRunHandleStore(runtime),
      }),
      workspace: new FencedWorkspace(),
      // e2d-2:节点级共享产物仓(配置后 PROJECT 交付才准入并发布签名产物;未配置则 PROJECT policy_denied)。
      artifactRepo: cfg.artifact_repo,
      driverTimeoutMs: 15_000, // npx 冷启动可能较慢;有界等待仍封顶执行器契约
      capabilities: () => cfg.caps,
      reportIntervalMs: 60_000,
      selectTarget: (await selectorHandle)?.selector,
    });
  } catch (e) {
    console.error('节点启动失败:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
  await node.start();
  console.log('qlong 节点已启动(持久 v2):', cfg.node_id, '@', cfg.registry_url);
  console.log('节点存储:', node.store.path);
  if (selectorHandle) {
    const handle = await selectorHandle;
    await handle.refresh();
    const refreshTimer = setInterval(() => { void handle.refresh(); }, 30_000);
    refreshTimer.unref();
  }
  if (takeoverFile !== undefined) {
    const { verifyTakeoverBundle } = await import('../../node/src/runtime/takeover-bundle.js');
    const { publicKeyFromPrivate } = await import('@qlong/core');
    const seed = Buffer.from(takeoverKeyHex!, 'hex');
    if (seed.length !== 32) { console.error('--takeover-key 必须为 64 个 hex 字符(32 字节 ed25519 种子)'); process.exit(1); }
    const verified = verifyTakeoverBundle(
      JSON.parse((await import('node:fs')).readFileSync(takeoverFile, 'utf8')),
      publicKeyFromPrivate(new Uint8Array(seed)),
    );
    if (!verified.ok) { console.error('接管 bundle 验签失败:', verified.reason); process.exit(1); }
    const r = node.takeover(verified.bundle);
    console.log('跨机接管:重派', r.imported.length, '| fenced(禁双主)', r.fenced.length, '| 归档', r.archived.length);
  }
  if (originate) {
    const { randomUUID } = await import('node:crypto');
    const taskId = randomUUID();
    node.lead.originate(taskId, originate.kind as 'aid' | 'project');
    let target = typeof originate.target === 'string' ? originate.target : undefined;
    let offerBody: Record<string, unknown> = {
      kind: originate.kind, summary: originate.summary,
      lease_ms: originate.lease_ms ?? 300_000, offer_ttl_ms: originate.offer_ttl_ms ?? 60_000,
      ...(Array.isArray(originate.required_caps) ? { required_caps: originate.required_caps } : {}),
    };
    if (target === undefined) {
      const pick = (await selectorHandle)?.selector({ task_id: taskId, nextAttempt: 1, excluded: {}, kind: originate.kind as 'aid' | 'project' });
      if (pick) { target = pick.target; offerBody = pick.offerBody; }
    }
    if (target !== undefined) {
      node.lead.dispatch(taskId, target, offerBody);
      console.log('已发起牵头任务', taskId, '→', target);
    } else {
      console.log('已发起牵头任务', taskId, '(暂无合格目标,保留 drafting;目录刷新后由周期泵改派)');
    }
  }
  console.log('Ctrl+C 退出(关停会静默在跑任务并把终态落中心)');
  let stopping = false;
  let releaseMain: (() => void) | undefined;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void node.stop().then(
      () => { releaseMain?.(); },
      () => {
        console.error('关停未完全收口:请保留节点数据目录,恢复后用 open 模式重启');
        process.exitCode = 1;
        releaseMain?.();
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // 常驻;关停后 resolve 让模块自然收尾 —— 不 process.exit(TLS 句柄强制关闭崩溃,同 enroll 注)
  await new Promise<void>((resolve) => { releaseMain = resolve; });
}

if (cmd === 'lead') {
  // 第 2 步:跨机接管的运维入口(节点**停止态**独占 runtime.sqlite;运行态接管走 `qlong run --takeover`)。
  // bundle 为裸 JSON,经 ed25519(JCS 签名域)封套防伪造高 attempt 劫持;key 为操作员种子,与节点身份无关。
  const sub = process.argv[3] ?? '';
  if (sub !== 'export' && sub !== 'import') {
    console.error('用法:');
    console.error('  qlong lead export --out <文件> --key <64位hex> --data-dir <节点数据目录> --storage-mode open --confirm-local-filesystem');
    console.error('  qlong lead import --in <文件> --key <64位hex> --data-dir <节点数据目录> --storage-mode open --confirm-local-filesystem');
    console.error('(须在节点停止后运行;key 为操作员持有的 32 字节 ed25519 种子)');
    process.exit(1);
  }
  const home = qlongHome();
  const cfg = readConfig(home);
  const { runStorageOptions } = await import('./run-storage-options.js');
  const storage = runStorageOptions(process.argv.slice(4), process.env, home);
  if (storage.mode !== 'open') throw new Error('lead export/import 只作用于既有节点库:请用 --storage-mode open');
  const sflag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const keyHex = sflag('--key') ?? '';
  const seed = Buffer.from(keyHex, 'hex');
  if (seed.length !== 32) throw new Error('--key 必须为 64 个 hex 字符(32 字节 ed25519 种子)');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { SqliteStore } = await import('../../storage/src/index.js');
  const { NODE_SCHEMA } = await import('../../node/src/runtime/schema.js');
  const { NodeRuntimeStore } = await import('../../node/src/runtime/store.js');
  const { DurableLead } = await import('../../node/src/runtime/lead.js');
  const { signTakeoverBundle, verifyTakeoverBundle } = await import('../../node/src/runtime/takeover-bundle.js');
  const { publicKeyFromPrivate } = await import('@qlong/core');
  const store = SqliteStore.open({ ...storage, schema: NODE_SCHEMA, filename: 'runtime.sqlite' });
  try {
    const runtime = new NodeRuntimeStore(store, cfg.node_id);
    const lead = new DurableLead({
      store: runtime, nodeId: cfg.node_id, teamId: cfg.team_id,
      seal: () => { throw new Error('lead export/import 不产生出站消息'); },
    });
    if (sub === 'export') {
      const out = sflag('--out');
      if (out === undefined) throw new Error('缺少 --out <文件>');
      const bundle = lead.exportTasks();
      writeFileSync(out, JSON.stringify(signTakeoverBundle(bundle, new Uint8Array(seed)), null, 2));
      console.log('已导出', bundle.tasks.length, '个牵头任务 →', out, '(已签名;导入方需同密钥验签)');
    } else {
      const inPath = sflag('--in');
      if (inPath === undefined) throw new Error('缺少 --in <文件>');
      const verified = verifyTakeoverBundle(JSON.parse(readFileSync(inPath, 'utf8')), publicKeyFromPrivate(new Uint8Array(seed)));
      if (!verified.ok) { console.error('接管 bundle 验签失败:', verified.reason); process.exit(1); }
      const r = lead.importTasks(verified.bundle);
      console.log('已导入:重派', r.imported.length, '| fenced(禁双主)', r.fenced.length, '| 归档', r.archived.length);
      console.log('提示:重派需节点以 --auto-select(或 --originate)运行以获得目录驱动选择器');
    }
  } finally { store.close(); }
}

if (cmd === 'solo') {
  // 单机形态(愿景:一条龙独立干活):零令牌、零入网、零外部中心 —— 一条命令独立干活。
  // 用法: qlong solo --summary "任务书" [--kind aid|project] [--timeout-ms 600000]
  //       qlong solo --originate task.json
  const sflag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const taskFile = sflag('--originate');
  const kindArg = (sflag('--kind') ?? 'aid');
  if (kindArg !== 'aid' && kindArg !== 'project') {
    console.error('--kind 必须为 aid 或 project');
    process.exit(2);
  }
  let kind = kindArg as 'aid' | 'project';
  let summary = sflag('--summary') ?? '';
  if (taskFile !== undefined) {
    const t = JSON.parse((await import('node:fs')).readFileSync(taskFile, 'utf8')) as Record<string, unknown>;
    if (t.kind !== undefined) {
      if (t.kind !== 'aid' && t.kind !== 'project') { console.error('--originate 文件 kind 必须为 aid 或 project'); process.exit(2); }
      kind = t.kind as 'aid' | 'project';
    }
    if (typeof t.summary === 'string' && t.summary.length > 0) summary = t.summary;
  }
  if (summary.trim().length === 0) {
    console.error('用法: qlong solo --summary "<任务书>" [--kind aid|project] [--timeout-ms 600000]');
    console.error('      qlong solo --originate task.json');
    console.error('单机形态:无需入网/令牌/中心,一条龙独立执行(真实 dsh)。');
    process.exit(2);
  }
  const { runSolo } = await import('./solo.js');
  console.log('单机模式启动:', kind, '|', summary.slice(0, 40) + (summary.length > 40 ? '…' : ''));
  const timeoutMs = Number(sflag('--timeout-ms', '600000'));
  const r = await runSolo({
    kind,
    summary,
    dataDir: join(qlongHome(), 'solo', 'data'),
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600_000,
  });
  console.log('任务状态:', r.state, '| attempt:', r.attempt, '| task:', r.taskId.slice(0, 8));
  if (r.resultBody && typeof (r.resultBody as { summary?: unknown }).summary === 'string') {
    console.log('执行结果:', (r.resultBody as { summary: string }).summary);
  }
  process.exitCode = r.state === 'done' ? 0 : 1;
  // 自然排空退出(不 process.exit,同 enroll 注)
}

if (cmd === 'agent') {
  // 单机的"龙"对话入口(粘合层):你输入目标,直接调本机 dsh 运行时执行。
  // Agent 的实现就是 dsh 本身;qlong 只做粘合 —— 装 dsh、管工作区、展示输出。
  const { runAgentSession } = await import('./agent.js');
  const { readLocalDshCmd } = await import('./dsh-cmd.js');
  const sflag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const workdir = sflag('--workdir') ?? join(qlongHome(), 'agent-workspace');
  mkdirSync(workdir, { recursive: true });
  const localDsh = readLocalDshCmd(qlongHome());
  const code = await runAgentSession({
    workdir,
    dshCmd: localDsh ?? sflag('--dsh-cmd'),
    profile: sflag('--profile') ?? undefined,
  });
  process.exitCode = code;
  // 自然排空退出
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
  let releaseMain: (() => void) | undefined;
  const shutdown = (): void => {
    void handles.close().then(() => { releaseMain?.(); }, () => {
      console.error('中心关闭失败,请保留数据目录并检查恢复状态');
      process.exitCode = 1;
      releaseMain?.();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // 常驻;关停后 resolve 自然退出(避免强杀 TLS 句柄崩溃,同 enroll 注)
  await new Promise<void>((resolve) => { releaseMain = resolve; });
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
  const res = await fetch(regUrl + '/v1/teams/' + teamId + '/tasks', { headers: { Authorization: 'Bearer ' + tok, 'User-Agent': QLONG_USER_AGENT } });
  const d = (await res.json()) as { tasks?: Array<{ task_id: string; status: string; type: string }> };
  for (const t of d.tasks ?? []) console.log(t.task_id.slice(0, 12), t.type, t.status);
  // fetch 后自然排空退出(不 process.exit,同 enroll 注)
}

if (cmd === 'task') {
  // owner 任务级控制(E3,OWNER-COMMAND §4.2):cancel/redispatch 经授权 API 事务化下达。授权 = owner 会话
  // (Cookie + CSRF,与 console 同源);命令入队中心持久队列,由牵头节点周期 PULL 后经 lead.cancel/redispatch
  // 单任务 CAS 事务执行。202 = 已受理待执行(非即时完成);投影只读,新状态由牵头节点回报(§1.4)。
  const sub = process.argv[3] ?? '';
  const taskId = process.argv[4] ?? '';
  if ((sub !== 'cancel' && sub !== 'redispatch') || !taskId) {
    console.error('用法: qlong task <cancel|redispatch> <task_id>');
    console.error('  环境: QLONG_REGISTRY_URL QLONG_TEAM_ID QLONG_OWNER_COOKIE QLONG_OWNER_CSRF');
    process.exit(2);
  }
  const regUrl = process.env.QLONG_REGISTRY_URL ?? 'http://127.0.0.1:3200';
  const teamId = process.env.QLONG_TEAM_ID ?? '';
  const cookie = process.env.QLONG_OWNER_COOKIE ?? '';
  const csrf = process.env.QLONG_OWNER_CSRF ?? '';
  if (!teamId || !cookie || !csrf) {
    console.error('set QLONG_TEAM_ID + QLONG_OWNER_COOKIE + QLONG_OWNER_CSRF(owner 会话凭证;控制台登录后从浏览器会话取得)');
    process.exit(1);
  }
  const res = await fetch(`${regUrl}/v1/teams/${teamId}/tasks/${taskId}/${sub}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, 'User-Agent': QLONG_USER_AGENT },
  });
  const d = (await res.json().catch(() => ({}))) as { command_id?: string; kind?: string; task_id?: string; lead?: string; error?: { message?: string } };
  if (res.status === 202) {
    console.log('已受理(202):', d.kind ?? sub, (d.task_id ?? taskId).slice(0, 12), '→ 牵头节点', (d.lead ?? '').slice(0, 12), '| 命令', (d.command_id ?? '').slice(0, 12));
    console.log('命令已入队中心;牵头节点下次 PULL 时事务化执行(取消/改派),非即时完成。');
  } else {
    console.error(`命令被拒(${res.status}):`, d.error?.message ?? res.statusText);
    process.exitCode = 1;
  }
  // fetch 后自然排空退出(不 process.exit,同 enroll 注)
}

if (cmd === 'migrate') {
  // F1/P2 旧数据显式迁移(docs/repair/DATA-MIGRATION.md):离线、只读预检 → 事务化导入 → 复核。
  // 逻辑全在 migrate/ 模块;此处仅解析参数 + 调用 + 打印(粘合层惯例不单测)。
  const sub = process.argv[3] ?? '';
  const sflag = (name: string, def?: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  if (sub !== 'inspect' && sub !== 'import' && sub !== 'verify') {
    console.error('用法:');
    console.error('  qlong migrate inspect --auth-dir <目录> [--mailbox <文件>] [--to <center.sqlite>] [--json]');
    console.error('  qlong migrate import  --auth-dir <目录> [--mailbox <文件>] --to <center.sqlite> --confirm-migration --confirm-local-filesystem');
    console.error('  qlong migrate verify  --to <center.sqlite>');
    console.error('(离线只读预检;缺省 auth-dir=$QLONG_AUTH_DIR、mailbox=$QLONG_MAILBOX_FILE。import/verify 见 §5 slice2/slice3)');
    process.exit(2);
  }
  const authDir = sflag('--auth-dir', process.env.QLONG_AUTH_DIR);
  const mailboxFile = sflag('--mailbox', process.env.QLONG_MAILBOX_FILE);
  if (sub === 'verify') {
    console.error('qlong migrate verify 尚未实现(见 docs/repair/DATA-MIGRATION.md §5 slice3)');
    process.exit(2);
  }
  if (sub === 'inspect') {
    if (authDir === undefined && mailboxFile === undefined) {
      console.error('缺少迁移源:请提供 --auth-dir <目录> 或 --mailbox <文件>(或设置 QLONG_AUTH_DIR / QLONG_MAILBOX_FILE)');
      process.exit(2);
    }
    // dry-run 只读:readMigrationSources 绝不写源(尤其不写 initialized);readTargetSnapshot 只读打开目标库。
    const { readMigrationSources, readTargetSnapshot, formatInventory } = await import('./migrate/read.js');
    const { inspectMigration } = await import('./migrate/inspect.js');
    try {
      const sources = readMigrationSources({ authDir, mailboxFile });
      const inventory = await inspectMigration(sources, readTargetSnapshot(sflag('--to') ?? ''), Date.now());
      console.log(process.argv.includes('--json') ? JSON.stringify(inventory, null, 2) : formatInventory(inventory));
    } catch (e) {
      console.error('迁移预检失败:', e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  }
  if (sub === 'import') {
    // 事务化导入是写操作:双重确认门 --confirm-migration(操作)+ --confirm-local-filesystem(存储介质准入)。
    // 目标必须已存在(mode open:须含 registry 节点供离线验签);逻辑全在 migrate/import.ts,此处仅粘合。
    const to = sflag('--to');
    if (to === undefined || !isAbsolute(to)) {
      console.error('import 需要绝对 --to <center.sqlite> 路径(指向已存在的 v2 中心库)');
      process.exit(2);
    }
    if (!process.argv.includes('--confirm-migration')) {
      console.error('拒绝执行:导入是写操作,请加 --confirm-migration 显式确认(建议先跑 qlong migrate inspect 预检)');
      process.exit(2);
    }
    if (!process.argv.includes('--confirm-local-filesystem') && process.env.QLONG_LOCAL_FS_CONFIRMED !== '1') {
      console.error('拒绝执行:请用 --confirm-local-filesystem 确认目标库在本地非共享存储(DATA-MIGRATION.md §7)');
      process.exit(2);
    }
    if (authDir === undefined && mailboxFile === undefined) {
      console.error('缺少迁移源:请提供 --auth-dir <目录> 或 --mailbox <文件>(或设置 QLONG_AUTH_DIR / QLONG_MAILBOX_FILE)');
      process.exit(2);
    }
    const windowsAcl = process.argv.includes('--confirm-windows-acl') || process.env.QLONG_WINDOWS_ACL_CONFIRMED === '1';
    const dataDir = dirname(to);
    const { readMigrationSources } = await import('./migrate/read.js');
    const { importMigration } = await import('./migrate/import.js');
    try {
      const sources = readMigrationSources({ authDir, mailboxFile });
      const report = await importMigration(sources, {
        now: Date.now(),
        target: {
          allowedBase: sflag('--data-base', process.env.QLONG_DATA_BASE) ?? dirname(dataDir),
          dataDir, filename: basename(to), mode: 'open',
          localFilesystemConfirmed: true, windowsAclConfirmed: windowsAcl ? true : undefined,
        },
      });
      console.log(report.idempotent
        ? `导入无副作用(全部来源摘要已在账本,幂等重跑):${report.targetPath}`
        : `导入完成:${report.usersInserted} 用户 / ${report.mailboxStored} 待投消息 → ${report.targetPath}`);
      for (const e of report.ledger) {
        console.log(`  账本 [${e.kind}] migratable=${e.migratable} blocked=${e.blocked} non_migratable=${e.non_migratable} invalid=${e.invalid} @${e.imported_at}`);
      }
      console.log('提示:请运行 qlong migrate verify 复核后再切换部署(源数据未删除;失败已回滚)。');
    } catch (e) {
      console.error('迁移导入失败(目标库已回滚,源数据保留):', e instanceof Error ? e.message : e);
      process.exitCode = 1;
    }
  }
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
      const res = await fetch(cfg.registry_url + '/v1/nodes/me', { headers: { Authorization: 'Bearer ' + cfg.node_token, 'User-Agent': QLONG_USER_AGENT } });
      console.log(res.ok ? '✓ registry 可达且凭证有效(' + res.status + ')' : '✗ registry 返回 ' + res.status + '(token 失效/服务未启动)');
    } catch (e) {
      console.log('✗ registry 不可达:', e instanceof Error ? e.message : e);
    }
  }
  console.log('提示:任务执行会调用 deepseek-harness(dsh);模型凭证见 https://deepseek-harness.github.io/deepseek-harness/');
  process.exit(0);
}

// 已匹配命令的块走"自然排空退出"(见 enroll 注);仅未知命令落到这里。
const KNOWN_COMMANDS = ['demo', 'takeover', 'enroll', 'join', 'run', 'solo', 'agent', 'service', 'server', 'doctor', 'status', 'tasks', 'task', 'lead', 'migrate'];
if (!KNOWN_COMMANDS.includes(cmd)) {
  console.log('usage: qlong <demo|takeover|enroll|join|run|solo|agent|service|server|doctor|status|tasks|task|lead|migrate>');
  process.exit(2);
}
