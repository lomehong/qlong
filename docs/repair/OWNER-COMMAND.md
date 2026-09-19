# Owner 命令通道设计（E3 / 02 §8.7 · V02_PLAN D6 · PROTOCOL-V2 line 51 同场设计）

> 本文兑现 V02_PLAN D6（line 83）明确延迟的 owner 控制面 `POST /v1/teams/{id}/nodes/{nid}/actions`
> 与 PROTOCOL-V2 line 51 "命令…接入同事务" 的待办，落地 E3 "owner 对节点/任务的控制命令
> （暂停/取消/改派/查询）经授权 API 事务化下达"。范围由用户选定为 **机制 A：中心持久命令队列 +
> 节点认证 HTTP PULL**，命令集为 **cancel（取消）+ redispatch（强制改派）**。
>
> 本文是**设计**，不是计划文件；实施按 §6 分片走 TDD（RED→GREEN→变异检验）。

## 1. 约束（不可违背）

1. **耐久**：命令须在节点离线/重启时存活 → 持久化在**中心**（owner 认证发生处、任务投影权威处）。
   节点 PULL 模型天然满足：未 ack 的命令静置中心，节点重连后周期泵续拉（对比 WS 推送：节点离线即丢）。
2. **防伪造**：owner 是**人**（非持钥节点）。命令信任根 = **中心权威 + nodeToken**，**不引入节点签名**：
   - 创建命令须过 `assertOwner`（会话 CSRF 或 `QLONG_OWNER_TOKEN`，同 suspend/revoke/grants 路由，http.ts:485/505）。
   - 节点只能拉取 `lead = 本机 node_id` 的命令（查询按 nodeToken 解析的 node_id 过滤）→ 他节点无法窃取/伪造。
   - 节点**已信任中心**投递目录快照与任务投影（node.ts putRegistry/defaultTaskReportSink 同一 Bearer 通道），
     故信任中心投递的命令与现有信任模型一致。**这正是拒绝"custody 信封注入"的根因**：信封是节点间信任模型
     （需节点签名），中心无节点签名钥，owner 非持钥节点，强行注入即伪造。
3. **事务化执行**（PROTOCOL-V2 line 51）：命令在牵头节点经 `lead.cancel()`/`lead.redispatch()` 应用——
   二者皆是**单任务 CAS 事务**（lead.ts transitionEvent → store.transition 原子提交 state+outbox+effects），
   提交后由泵执行 fenced intent（task.cancel 信封 / task.report 投影修订）。**绝不消费命令后再异步写状态**。
4. **中心投影只读**：`TaskProjection` 是牵头机器的只读投影（task-projection.ts），**取消/改派必须抵达牵头节点**
   由 lead 执行后回报新投影（task.report），中心**绝不**直接翻权威状态。owner 路由只**持久化命令意图**，不改 task 行。
5. **存储铁律**：命令表损坏进入 recovery（fail-closed 抛出），绝不静默重建；GC 只回收**已 ack 且过保留窗口**
   的命令，**绝不删除 pending/未投递命令**（同 custody tombstone GC 语义，A1）。
6. **schema 追加迁移**：命令表以 `CREATE TABLE` 片段 + 中心 **v4** 追加迁移落地（同 `CUSTODY_SQL`/`CLAIM_SQL`
   模式，schema.ts:7 已预留 "Future mailbox/command migrations must append"），不改既有表。
7. **at-least-once + 幂等**：节点应用命令（本地事务）与 ack（HTTP）是两步；崩溃在 ack 前 → 命令重拉重应用。
   故命令应用**必须幂等**：`cancelByUser` 对 cancelling/终态 no-op（machine.ts:374-375）；`redispatchByOwner`
   对终态/cancelling/已 reclaiming no-op（§4.4 守卫）。重复投递不产生重复副作用。

## 2. 现状（证据）

- **节点级 owner 控制已完整**：`POST /v1/nodes/:id/suspend|revoke`（http.ts:355，node 级）+
  `POST /v1/teams/:id/nodes/:nid/suspend|resume`（http.ts:484，team 级）→ `directory.suspend/resume/revoke`
  （directory.ts:424/433/442）→ closeCode 4001/4002 → 网关 syncRegistry → closing 帧 → 断连。**E3 不重做节点暂停**。
- **任务查询已完整**：`GET /v1/teams/:id/tasks`（http.ts:461，listTasks）、`/tasks/:tid`（http.ts:475，getTask）、
  `/overview`（http.ts:442）。**E3 不重做查询**。
- **任务取消原语已在节点**：`lead.cancel(taskId)`（lead.ts:269）→ `machine.cancelByUser`（machine.ts:373）
  → cancelling → task.cancel → ack 或 cancel_wait 超时 → closed。**但无 owner 路由触发它**——这是 E3 核心缺口。
- **改派原语已在节点**：`beginReclaim`（machine.ts:391，私有）= "先撤销、后改派" → reclaiming → task.cancel
  → drain → `budgetOrEscalate`（machine.ts:411）→ drafting → `requestDispatch` → `redispatchTo`（经 selectTarget）。
  **仅由 offer_ttl/lease 到期或 fail/acceptance_failed 消息触发，无 owner 入口**。
- **节点→中心认证 HTTP 通道已在**：`defaultTaskReportSink`（node.ts:255，POST /v1/teams/:id/tasks）+
  `putRegistry`（node.ts:332，PUT /v1/nodes/me/caps|/load），皆 Bearer nodeToken + AbortSignal.timeout(5000)
  + redirect:'error' + .catch(()=>{})。**命令 PULL 镜像此通道**（GET /v1/nodes/me/commands）。
- **中心 `/v1/nodes/me/*` 认证模式**：`bearer(req)`（http.ts:336）+ `authByToken`（directory.ts:357，
  suspended→403 node_suspended / revoked→403 node_revoked）。命令 PULL 路由复用此认证。
- **泵定时器已在**：node.ts start() 装配 `tickTimer`（pumpTick，tickIntervalMs）+ `reportTimer`（reportLoad）
  + `gcTimer`（runtime.prune）。**命令 PULL 增并列 `commandTimer`**（或并入 pumpTick）。
- **CENTER_SCHEMA**（schema.ts:8-15）：v1 registry-auth、v2 durable-custody、v3 cluster-claim。**命令表 = v4**。

## 3. 缺口与范围

| 能力 | 现状 | E3 范围 |
| --- | --- | --- |
| 节点暂停/恢复/吊销 | ✅ 完整（http.ts:355/484） | 不重做 |
| 任务查询 | ✅ 完整（listTasks/getTask/overview） | 不重做 |
| **任务取消（owner 触发）** | 原语在（lead.cancel），**无 owner 路由** | **做**：owner 路由 + 命令队列 + 节点 PULL 应用 |
| **任务强制改派（owner 触发）** | 原语在（beginReclaim），**无 owner 入口/机器事件** | **做**：新增 `redispatchByOwner` 机器事件 + 命令路由 + PULL 应用 |
| 统一 `/actions` 路由 | 未实现 | **不做**（YAGNI，cancel/redispatch 用专用子路由，见 §8） |

## 4. 核心设计

### 4.1 命令模型与 schema（CENTER_SCHEMA v4 追加迁移）

```sql
-- COMMAND_SQL（新片段，同 CUSTODY_SQL/CLAIM_SQL 模式；中心 v4 追加迁移，不改既有表）
CREATE TABLE registry_commands (
  id TEXT NOT NULL CHECK (length(id) = 36),          -- 命令 UUID（newId）
  team_id TEXT NOT NULL CHECK (length(team_id) = 36),
  lead TEXT NOT NULL CHECK (length(lead) = 36),      -- 路由目标 = 牵头节点 node_id
  task_id TEXT NOT NULL CHECK (length(task_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('cancel', 'redispatch')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'acked')),   -- pending 永不删（铁律 §1.5）
  created_at TEXT NOT NULL,                          -- ISO；FIFO 排序键（同 task 多命令按 created_at,id 应用）
  acked_at TEXT,                                     -- GC 依据：status='acked' 且 acked_at < now-retention
  PRIMARY KEY (id),
  -- 跨字段不变量：pending 时 acked_at IS NULL，acked 时 acked_at NOT NULL（应用层 load 复核同构，损坏 fail-closed）
  CHECK ((status = 'pending' AND acked_at IS NULL) OR (status = 'acked' AND acked_at IS NOT NULL))
) STRICT;
-- 无 FK（同 CUSTODY_SQL/CLAIM_SQL：队列是运维实体，节点吊销/prune 不得因悬空 FK 阻塞）；无 record 列（由列投影为 CommandRecord）。
-- 节点 PULL 热路径：按 (lead, status) 取 pending，FIFO 排序 (created_at, id)。
CREATE INDEX registry_commands_pending ON registry_commands(lead, status, created_at, id);
```

```ts
interface CommandRecord {
  id: string; team_id: string; lead: string; task_id: string;
  kind: 'cancel' | 'redispatch'; status: 'pending' | 'acked';
  created_at: string; acked_at?: string;
}
```

- **CommandStore 端口**（registry 侧，SqliteCommandStore 实现，镜像 SqliteClaimStore）：
  - `enqueue(cmd): void`（owner 路由调用，事务内 INSERT）
  - `pendingFor(leadNodeId, limit): CommandRecord[]`（节点 PULL，`WHERE lead=? AND status='pending' ORDER BY created_at,id LIMIT ?`）
  - `ack(commandId, leadNodeId, now): boolean`（`WHERE id=? AND lead=? AND status='pending'` → status='acked',acked_at；
    被 fence/已 ack 返回 false，幂等）
  - `prune(now, retentionMs): number`（**仅删 status='acked' 且 acked_at < now-retentionMs**；pending 永不删）
  - 损坏 → fail-closed 抛出（同 custody-store.ts:43-46），绝不静默重建。

### 4.2 Owner 命令路由（授权 = assertOwner）

```
POST /v1/teams/:id/tasks/:tid/cancel       → 取消任务
POST /v1/teams/:id/tasks/:tid/redispatch   → 强制改派任务
```

处理（镜像 http.ts:484 suspend/resume 路由的授权与 team 归属校验）：
1. `requireTeamAccess` 不适用（这是 owner 管理面）→ `await assertOwner(opts, req, teamId)`（会话 CSRF 或 owner token）。
2. `const task = registry.getTask(teamId, tid)`；不存在 → 404。`task.team_id !== teamId` → 403（防跨队越权）。
3. **不改 task 行**（投影只读，§1.4）；`commandStore.enqueue({ id:newId(), team_id:teamId, lead:task.lead,
   task_id:tid, kind:'cancel'|'redispatch', status:'pending', created_at:now })`。
4. 返回 `202 { command_id, kind, task_id, lead }`（202=已受理待节点执行，非 200=已完成；命令是异步意图）。
5. **幂等**：同 task 重复 cancel/redispatch → 多条 pending 命令；节点侧幂等应用（§1.7）保证无重复副作用。
   （可选优化：enqueue 前查 pending 同 (task,kind) 去重——v1 不做，依赖节点幂等。）

### 4.3 节点 PULL + 事务化应用 + ack

```
GET  /v1/nodes/me/commands            → { commands: CommandRecord[] }（Bearer nodeToken，仅 lead=本机 的 pending）
POST /v1/nodes/me/commands/:id/ack    → { ok:true }（Bearer nodeToken，校验 :id 的 lead=本机）
```

节点侧 `pullCommands()`（node.ts，镜像 putRegistry/reportLoad 的 Bearer + timeout + redirect:'error' 风格）：
1. `GET /v1/nodes/me/commands`（Bearer nodeToken）→ 拿 pending 命令列表（FIFO）。
2. 逐条**事务化应用**（§1.3）：
   - `kind='cancel'` → `lead.cancel(task_id)`（lead.ts:269，单任务 CAS 事务）。
   - `kind='redispatch'` → `lead.redispatch(task_id)`（新适配器方法，§4.4，单任务 CAS 事务）。
   - 应用失败（任务不存在/未牵头/已 faulted）→ **不 ack**，留 pending 重试（或记诊断）；lead.cancel 对
     非牵头任务静默 no-op（lead.ts:385 consume 同语义），对未 originate 任务抛出 → 捕获后跳过（命令指向
     已不存在的本地任务，ack 之以免永久滞留；见 §7 开放）。
3. 应用成功 → `POST /v1/nodes/me/commands/:id/ack`（best-effort，.catch(()=>{})；ack 丢失 → 重拉重应用，幂等兜底）。
4. **泵接线**：`commandTimer = setInterval(pullCommands, commandIntervalMs)`（node.ts start()，与 tickTimer 并列，
   unref）。重启后 pending 命令由中心续存，首次 commandTimer 触发即续拉（§1.1 耐久）。

### 4.4 `redispatchByOwner` 机器事件（新增）+ DurableLead 适配器

**机器事件**（machine.ts，与 cancelByUser 并列；TDD 先固化于 lead.spec.ts）：
```ts
/** owner 强制改派：排除当前 target('once') + 先撤销后改派；终态/cancelling/reclaiming 幂等 no-op（§1.7）。 */
redispatchByOwner(now: number): LeadAction[] {
  if (this.terminal) return [];
  if (this.rec.state === 'cancelling') return []; // 用户取消优先,不被改派覆盖
  if (this.rec.state === 'reclaiming') return []; // §1.7 幂等:已在回收途中,重拉不重复撤销
  if (this.rec.target) this.rec.excluded[this.rec.target] = 'once'; // 改派 = 离开当前节点
  if (this.rec.state === 'drafting') {
    // 已在等待改派:补排除当前 target 后请求重派(selectTarget 避开),不重复撤销
    return [{ kind: 'requestDispatch', nextAttempt: this.rec.attempt + 1 }];
  }
  // offered/running:先撤销当前 attempt(task.cancel reason:reclaim)后经 drain→budgetOrEscalate 改派
  this.rec.history.push({ node: this.rec.target ?? '?', attempt: this.rec.attempt, outcome: 'owner_redispatch' });
  return this.beginReclaim('reclaim', now);
}
```

**语义决策**：owner-redispatch **复用标准 reclaim 路径**（beginReclaim → budgetOrEscalate），故**消耗 dispatch
预算**（running→acceptedFailedBudget++，offered→dispatchRounds++）。理由：① 最简、复用已充分固化的机器；
② 防 owner 无限改派循环（escalate 是安全阀）；③ 与"任务被移走因当前节点有问题"语义一致。**预算旁路的
纯行政迁移（rebalance 不罚预算）列为后续**（§7），v1 不做。

**边界**：排除当前 target 后若无替代目标（selectTarget 返回 null），任务留 drafting 由后续 tick 重试（同自动
改派）；不 escalate（drafting 分支不消耗预算）。

**DurableLead 适配器**（lead.ts，镜像 cancel()）：
```ts
/** owner 强制改派(E3):排除当前 target 经 reclaim→selectTarget 重派;单任务 CAS 事务。 */
redispatch(taskId: string, now = Date.now()): boolean {
  return this.checked(() => {
    this.assertHealthy();
    if (!isUuid(taskId)) throw new TypeError('redispatch taskId must be a UUID');
    return this.transitionEvent(taskId, (machine) => machine.redispatchByOwner(now), now);
  });
}
```

### 4.5 延迟优化（notify，可选 / e3c 拉伸）

轮询 `commandIntervalMs` 是耐久基线（默认拟 1–5s）。降延迟可选：中心 enqueue 后经网关 WS 向 `lead` 节点推
"you have pending commands" 提示帧（**只提示不搬命令**，命令仍由节点 PULL 取回——镜像 d1d `/internal/pump`
"只通知不搬 payload" 哲学）。提示丢失由周期泵兜底。**v1 先做轮询**，notify 列为 e3c 拉伸（不阻塞闭环）。

## 5. 装配（server.ts / node.ts）

- **中心**：`SqliteCommandStore` 与 `SqliteCustodyStore`/`SqliteClaimStore` 并列构造（共享 `storage`，server.ts:126
  附近）；`RegistryServerOptions` 增可选 `commandStore?`（同 relaySecret?/onPumpNotify? 可选模式，http.ts:12-36）。
  owner 命令路由 + 节点 PULL/ack 路由接线 http.ts。CENTER_SCHEMA 增 v4 迁移（schema.ts）。
- **节点**：`createDurableNode` 增 `commandIntervalMs?` + 复用现有 registryUrl/nodeToken；start() 装配
  commandTimer → pullCommands → lead.cancel/redispatch → ack。DurableNode 返回对象暴露 `pullCommands`（测试/手动驱动）。

## 6. TDD 分片（每片 RED→GREEN→变异检验 + 独立提交）

| 片 | 内容 | 测试入口 | 变异检验要点 |
| --- | --- | --- | --- |
| **e3a** | `SqliteCommandStore`（enqueue/pendingFor/ack/prune，损坏 fail-closed）+ CENTER_SCHEMA v4 + owner 命令路由（cancel/redispatch，assertOwner，投影只读）+ 节点 PULL/ack 路由 | `registry/test/command-store.spec.ts`（新）、`http-security.spec.ts` 扩展 | 移除 assertOwner → 非 owner 可下命令（RED）；prune 删 pending → 数据丢失（RED）；命令路由改 task 行 → 投影非只读（RED） |
| **e3b** | `redispatchByOwner` 机器事件 + `DurableLead.redispatch` 适配器 | `node/test/lead.spec.ts`（机器级）、`durable-lead.spec.ts`（适配器级） | 移除 excluded 当前 target → 改派回原节点（RED）；移除 cancelling 守卫 → 取消被改派覆盖（RED）；redispatch 不走事务 → 状态/上报不一致（RED） |
| **e3c** | 节点 `pullCommands`（GET→应用→ack，at-least-once+幂等）+ createDurableNode commandTimer 接线 + 重启续拉 | `node/test/durable-node.spec.ts` 扩展、`cli/test/server-durable.spec.ts` | 移除 ack → 命令重拉但幂等无重复副作用（正确性不 RED，计数断言 RED）；应用不走 lead.cancel/redispatch → 非事务化（RED）；重启丢 pending → 不耐久（RED） |
| **e3d** | CLI（`qlong task cancel/redispatch`）+ e2e（owner→中心命令→牵头节点 PULL→closed/重派→投影回报）+ 全量验证 + 文档回填 + 独立提交 | `cli/test/server-*.spec.ts`、全仓 `pnpm -r … test` + 7 包 typecheck | e2e 变异：移除节点 PULL → 命令永不下达（RED） |

**验证基线**（HEAD c0d74dd）：全仓 1499 passed | 3 skipped；7 包 typecheck 绿。每片提交后重跑。

## 7. 风险与开放

- **命令指向已不存在的本地任务**（牵头节点已 GC 该任务状态 / 任务从未 originate）：`lead.cancel`/`redispatch` 对
  未 originate 任务**抛出**（lead.ts checked 路径）——若"先应用再 catch"，抛出时已经 checked→onFault **fail-closed
  整节点**，catch 为时已晚。故 pullCommands 采用 **ledByUs 预检**（node.ts:387，镜像 drain 的 env 路由判定）：应用前
  `runtime.state(leadStateKey(task_id)) === undefined` → **ack 丢弃**（陈旧命令重拉无益，绝不 fault 节点）；预检为真却
  仍抛出 = 真实存储/损坏故障 → 已 fail-closed，**不 ack**（留 pending 待恢复后续拉）。e3c 固化此判定。
- **owner 改派消耗预算**（§4.4）：行政性 rebalance 会罚任务预算，反复改派 → escalate。预算旁路变体列为后续。
- **命令顺序**：同 task 多命令按 created_at FIFO 应用；cancel 后 redispatch → redispatch 对 closed no-op（幂等）；
  redispatch 后 cancel → cancel 对 reclaiming 生效（cancelling 优先）。机器守卫保证收敛，无需中心排序仲裁。
- **轮询延迟**：commandIntervalMs 是命令下达延迟上界；notify（§4.5）降延迟但不影响耐久正确性。
- **多中心**：本设计假定单中心/单 authority 域（同 D1）；多中心命令一致性不在 E3 范围。

## 8. 不做（YAGNI 边界）

- 统一 `POST /v1/teams/:id/nodes/:nid/actions` 路由（V02_PLAN D6 字面）——cancel/redispatch 用专用子路由
  `/tasks/:tid/cancel|redispatch` 更 RESTful、授权/校验更直接；`/actions` 收敛列为后续（若命令集扩张）。
- owner 指定改派目标节点（"dispatch to Y"）——v1 仅"触发重派经 selectTarget 选新目标"（用户选定语义），
  避免 owner 绕过能力/排除逻辑。指定目标列为后续。
- 命令的节点签名 / custody 信封注入（§1.2 已论证违反信任模型，拒绝）。
- 节点级 suspend/resume/revoke 重做（已完整）、任务查询重做（已完整）。
- 命令表 Redis 实现 / 多中心一致性（端口预留，v1 只 SQLite 单中心）。
- notify 降延迟的网关 WS 提示帧（§4.5，e3c 拉伸，不阻塞闭环）。
