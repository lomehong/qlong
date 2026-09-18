# 集群 claim 注册表设计（D1 / 02 §12.1 · 01 §13.5 同场设计）

> 本文兑现 02 §12.1 与 01 §13.5 明确延迟的"网关集群化三件套同场设计"，并落地
> CENTER-STORAGE.md line 64 标注的"gateway-only/单 authority 跨进程接线、连接登记
> generation/TTL 尚待实现"。范围由用户选定为 **option C：完整跨进程 claim 注册表**——
> 实现 generation+TTL 的跨进程连接 claim 注册，并安全解禁 custody 模式集群路由。
>
> 本文是**设计**，不是计划文件；实施按 §6 分片走 TDD（RED→GREEN→变异检验）。

## 1. 约束（不可违背）

1. **§8 在线权威 = 网关连接态**：连接即在线、断开即离线，**不发明第二套节点级心跳协议**
   （02 §8 line 160）。claim 的 TTL 必须是 **authority-liveness 租约**——由持有活 socket 的
   网关自身刷新，节点不额外发任何帧；claim 层对节点**完全透明**（不进 `CUSTODY_FEATURES`，
   不改 transport 协商，见 core/src/transport.ts:10）。
2. **claim 是归属仲裁层，不是 payload 交付正确性层**。custody 交付为 **store-then-push**：
   payload 在任何推送前先 `offer` 提交到共享 `SqliteCustodyStore`（ws.ts:365），且 retryTimer
   每 ≤100ms 周期泵所有连接（ws.ts:315-329）。故**跨进程正确性兜底已存在**（共享库 + 周期泵 +
   msg_id 去重 + 端上 R1）。claim 注册表的价值是：分裂脑收敛、可判定归属、低延迟中继——**均为
   best-effort 优化，失效不破坏交付正确性**。这界定了 D1 的风险上界。
3. **存储铁律**：claim 表损坏进入 recovery（fail-closed 抛出），绝不静默重建；GC/reap 只回收
   **已过期租约**，绝不触碰 custody pending payload（两者是不同表，claim 无 payload）。
4. **M2-03 守卫升级而非替换**：`currentConnByNode: Map<nodeId, connId>`（ws.ts:76）防陈旧
   close/error 误删新会话；generation 在此基础上叠加，令归属**跨进程可判定**，本地陈旧守卫语义不变。
5. **schema 追加迁移**：claim 表以 `CREATE TABLE` 片段 + 中心追加迁移落地（同 `CUSTODY_SQL`
   模式，custody-store.ts:9-28），不改既有表。

## 2. 现状（证据）

- **GatewayConnection**（types.ts:24-29）：`{connId, nodeId, teamId, connectedAt}`——**无 generation、无 TTL**。
- **core.connect**（core.ts:82-84）：按 nodeId last-writer-wins 覆盖；`connections: Map<nodeId, GatewayConnection>`（core.ts:49）是**进程内**连接表。
- **M2-03 守卫**（ws.ts:76/202/217/244/433）：`connId = newId()`（ws.ts:198，随机、**无序**），守卫 `currentConnByNode.get(nodeId) !== connId`——仅进程内有效，跨进程无法比较新旧。
- **custody 拒绝集群**（ws.ts:94-96）：`if (opts.custody && (opts.cluster || opts.clusterSecret)) throw`；且 `deliverTo`/`internalDeliver` 在 custody 下抛错（ws.ts:450/459）。**v2 生产路径当前无任何跨进程路由**。
- **custody 交付流**（ws.ts:332-413）：`admitCustody` = ACL → `custody.offer`（共享库 pending）→ `stored` 回执 → **仅当目标连在同一 authority**（`currentConnByNode.get(to.node_id)`，ws.ts:372）才 `pumpCustody` 立即推；否则静置共享库，由目标所在 authority 的周期泵补投。
- **legacy 集群**（cluster.ts / bus.ts）：`GatewayCluster` + FNV-1a 分片（cluster.ts:85-93）+ `HttpClusterBus`（共享密钥中继 `/internal/envelope`）——**仅非-custody 路径**，per-instance `InboxStore` 分片。
- **中心装配**（server.ts:104-151）：`onPresenceChange: (nodeId, online) => registry.presence.set(nodeId, online)`（server.ts:133）已是 presence 钩子——claim 注册表天然接线点；custody 共享同一 `storage`（server.ts:126）。

## 3. 三件套映射（对 02 §12.1 的诚实兑现）

| 三件套（02 §12.1 / 01 §13.5） | legacy 路径（现状） | **custody 路径（本设计）** |
| --- | --- | --- |
| **连接注册**（Redis pub/sub 或 gossip） | 无（进程内 `connections` Map） | **ClaimRegistry**：`nodeId → {authorityId, generation, leaseExpiresAt}`，跨进程共享、generation 单调 |
| **node_id 分片路由** | FNV-1a → home 分片网关入箱（cluster.ts:85-93） | **不需要**：`SqliteCustodyStore` 是单一中心侧共享库，节点 pending 永远在同一处，任一持有 claim 的 authority 可取；分片降为**扩容杠杆**（§7），非正确性所需 |
| **收件箱共享持久存储** | per-instance `InboxStore`（分片） | **已存在**：`SqliteCustodyStore`（中心侧、持久、pending 永不淘汰，custody-store.ts:173-177）即共享收件箱 |

**结论**：custody 路径的三件套中，"收件箱共享持久存储"已由 `SqliteCustodyStore` 兑现，
"node_id 分片"因库共享而不再是正确性所需，唯一缺口是"**连接注册**"——即本设计的 claim 注册表。

## 4. 核心设计

### 4.1 ClaimRegistry 端口（连接注册）

统一端口，d1a/d1b 用内存实现（单 authority），d1c 换 SQLite 共享实现（跨进程）——沿用
`HttpClusterBus` 的"可替换传输"哲学（bus.ts:11）。

```ts
interface Claim { nodeId: string; authorityId: string; generation: number; leaseExpiresAt: number }
interface ClaimRegistry {
  /** 原子认领：generation = 现存最大值 + 1（单调）；写 {authorityId, generation, leaseExpiresAt=now+ttl} */
  claim(nodeId: string, authorityId: string, now: number): Claim;
  /** 续租：仅当 (nodeId) 现 claim == (authorityId, generation) 才延长 leaseExpiresAt→now+ttl；被 fence 返回 false */
  renew(nodeId: string, authorityId: string, generation: number, now: number): boolean;
  /** 释放：仅当现 claim == (authorityId, generation) 才删除；被 fence 返回 false（不误删新主） */
  release(nodeId: string, authorityId: string, generation: number): boolean;
  /** 查归属：现 claim（可能已过期，调用方按 leaseExpiresAt vs now 判活）；无 → undefined */
  lookup(nodeId: string): Claim | undefined;
  /** 回收已过期租约（leaseExpiresAt <= now）：返回被清除的 nodeId；绝不触碰 custody pending */
  reapExpired(now: number): string[];
}
```

- **`LocalClaimRegistry`**（d1a/d1b）：`Map<nodeId, Claim>` + 单调计数器，单 authority 内 `claim` 恒成功、`renew/release` 恒匹配（无竞争）。TTL 逻辑在 d1b 加入。
- **`SqliteClaimStore`**（d1c）：中心侧共享表，`claim` 在**单事务**内 `SELECT generation ... → +1 → UPSERT`（generation 单调由事务串行化保证）；损坏 fail-closed（同 custody-store.ts:43-46）。

**claim 表 schema 片段**（中心追加迁移，同 `CUSTODY_SQL` 模式）：
```sql
CREATE TABLE gateway_claim (
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  authority_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  claimed_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at >= claimed_at),
  PRIMARY KEY (node_id)
) STRICT;
```

### 4.2 Generation = fencing token（分裂脑仲裁）

generation 是**每 nodeId 单调递增**的归属令牌（Kleppmann fencing token；同 C2 `DurableLead`
attempt 高水位仲裁的同构思想）。规则：**高 generation 恒胜**。

- 节点 N 连到 authority A（gen 5）；因 A 慢/分区，N 重连到 B → `B.claim(N)` 返回 **gen 6**（共享表单调）。
- A 后续 `renew(N, A, 5)` → **false**（现 claim 是 gen 6）→ A **被 fence**：立即丢弃 N 的本地连接（关闭半开 socket、停泵、`release` no-op）。
- 交付方向：relay 通知携 generation；authority **仅当持有现 generation** 才泵 N（`pumpCustody` 守卫叠加 `lookup(N).generation === 本地 generation`）。
- **收敛窗口**：无 claim 时，半开双服务窗口 = "直到 A 的 socket 层察觉"（不定）；有 generation fence 后 = "直到 A 下次 renew"（≤ renew 间隔，有界）。这是 claim 层对分裂脑的核心贡献。

### 4.3 Authority-liveness 租约（TTL，§8 一致）

- claim 携 `leaseExpiresAt = now + ttl`（ttl 默认拟 30s，可配）。
- **续租由 authority 侧定时器驱动**，对每个"本地仍持活 socket"的 nodeId 调 `renew`——
  **节点不发任何额外帧**（守 §8：这是"网关断言自己仍持有活 socket"的连接态，被持久化 +
  跨进程 + 加了 liveness 上界，而非第二套节点心跳）。
- **authority 崩溃**：renew 停止 → 租约过期 → `reapExpired` 清除 → 别的 authority 可 `claim`（gen+1）接管该节点的离线补投。
- **半开/僵死自愈**：① authority 与 claim 库分区 → renew 失败 → 本地进入 fail-closed（同 `assertAuthorityAvailable` 语义，ws.ts:321）；② authority 存活但 socket 半开 → 仍 renew（以为活），但一旦 generation 被别处超越即被 fence 丢弃（§4.2）；③ TTL 是"死 authority 的 claim 最长残留时间"的上界。
- **与 §8 的正交性**：claim 租约是**节点级 presence 的跨进程持久化**；01 R3 `task.progress` 是**任务层**租约（B2 已实现），两者正交、互不替代（02 §8 line 160 辨析）。

### 4.4 Custody 集群路由（解禁 ws.ts:94）

**解禁条件**：ws.ts:94-96 的 `throw` 改为——custody **允许**与 claim 注册表共存；仍**拒绝**
legacy `GatewayCluster`/`clusterSecret`（那是 per-instance InboxStore 分片模型，与共享 custody
库语义冲突）。即 custody 的"集群"= claim 注册表 + 共享 custody 库 + custody-aware relay，
**不复用** legacy `GatewayCluster`。

**上行路由（custody，改造 `admitCustody` ws.ts:365-374）**：
1. ACL → `custody.offer`（共享库 pending，提交后返回）→ `stored` 回执（**不变**，正确性锚点）。
2. 推送定向（新）：`lookup(to.node_id)`：
   - **本 authority 持现 claim** → `pumpCustody` 本地立即推（现状行为）。
   - **他 authority B 持现 claim** → relay **通知** B "pump N"（新 `/internal/pump` 端点，
     **只传 `{to_node_id, generation}`，不传 payload**——payload 已在共享库）。best-effort：
     通知丢失由 B 的周期泵（≤100ms）兜底。
   - **无 claim / 已过期（离线）** → 不推；payload 静置共享库，待某 authority `claim(N)` 后周期泵补投。

**连接生命周期（custody）**：
- connect（ws.ts:213-215 附近）：`claim(nodeId, authorityId, now)` → 记本地 generation → `pumpCustody`（从共享库补投 pending）。
- renew 定时器（新，复用/并列 retryTimer）：对每个活 socket `renew`；false（被 fence）→ 丢连接。
- disconnect（ws.ts:428-441）：M2-03 守卫通过后 `release(nodeId, authorityId, generation)`（仅当仍持现 generation）。
- `deliverTo`/`internalDeliver`（ws.ts:450/459）：custody 下不再抛错，改为 relay "pump 通知"语义（不搬 payload）。

### 4.5 M2-03 守卫升级

`currentConnByNode: Map<nodeId, connId>` → 值升级为 `{connId, generation}`（或并列
`generationByNode`）。本地陈旧 close/error 守卫（ws.ts:433）**语义不变**（仍比 connId）；
新增：跨进程归属由 generation 判定（§4.2）。`GatewayConnection`（types.ts:24）增
`generation: number` 字段，令 core 连接表也携带归属令牌（诊断 + 集群路由判定）。

## 5. 装配（server.ts）

- `SqliteClaimStore` 与 `SqliteCustodyStore` 并列构造（共享 `storage`，server.ts:126 附近），
  经中心 HTTP 端点（同 directory/auth 模式）或共享库对 gateway 进程暴露；单中心 v1 先**进程内**注入。
- `WsGateway` 增 `claimRegistry?` + `authorityId?`（默认 `clusterName ?? 'gw1'`）选项；
  custody + claimRegistry 存在即启用 custody 集群路由。
- `onPresenceChange`（server.ts:133）保持写 `registry.presence`（诊断）；claim/release 由
  ws 连接生命周期直接驱动（§4.4），不经 presence 回调（避免双写竞态）。

## 6. TDD 分片（每片 RED→GREEN→变异检验 + 独立提交）

| 片 | 内容 | 测试入口 | 变异检验要点 |
| --- | --- | --- | --- |
| **d1a** | `GatewayConnection.generation` + `LocalClaimRegistry`（单 authority 单调）+ M2-03 升级为 generation 可判定归属 | `gateway/test/claim.spec.ts`（新）、`cluster.spec.ts`、`presence-lifecycle.spec.ts` | 移除 generation 单调 → 陈旧连接可误删新会话（RED） |
| **d1b** | claim TTL 租约（`leaseExpiresAt`、renew 定时器、`reapExpired`、半开/僵死 fence 自愈）；§8 一致性（无节点帧） | `claim.spec.ts`、`presence-lifecycle.spec.ts` | 移除 renew → 活连接租约过期被误 reap（RED）；移除 fence → 被超越的 authority 不丢弃（RED） |
| **d1c** | `SqliteClaimStore`（共享、事务内 generation 单调、损坏 fail-closed）+ 跨进程 relay + 分裂脑/generation 仲裁 | `claim-store.spec.ts`（新）、`cross-machine.spec.ts`、`server-custody.spec.ts` | 两 authority 争 claim → 低 generation 被 fence（RED）；损坏表 → recovery 而非静默重建（RED） |
| **d1d** | custody 集群路由解禁（ws.ts:94 改造）+ custody-aware relay（`/internal/pump`）+ 连接生命周期接线 | `transport-v2.spec.ts`、`server-custody.spec.ts`、`cross-machine.spec.ts` | 移除 relay 通知 → 跨进程延迟退化但周期泵兜底仍达（正确性不 RED，延迟断言 RED）；移除 fence 守卫 → 双服务（RED） |
| **d1e** | 全量验证收尾 + 文档（02 §12.1 定稿、01 §13.5、PROTOCOL-V2、CENTER-STORAGE line 64 更新） | 全仓 `pnpm -r ... test` + 7 包 typecheck | — |

**验证基线**：node 包 698 passed | 1 skipped；全 monorepo 1448 passed | 2 skipped；7 包 typecheck 绿。每片提交后重跑。

## 7. 风险与开放

- **claim 库争用**：单中心共享表是热点。扩容杠杆：按 node_id 范围分片 claim 库（FNV-1a，
  复用 cluster.ts:85-93），或换 Redis（`claim` = `INCR` + `PEXPIRE`，`lookup` = `GET`，
  pub/sub 替代 relay）——`ClaimRegistry` 端口不变。**v1 不做**（YAGNI）。
- **半开检测上界**：authority 存活但 socket 半开且未被别处超越时，claim 层无法主动察觉
  （依赖 ws 层 ping/pong 或 TCP）；TTL 只兜 authority 崩溃。列入 E 阶段 socket liveness 强化。
- **多中心**：本设计假定**单中心/单 authority 域**（CENTER-STORAGE line 64 "单 authority 跨进程"）；
  多中心 claim 一致性（02 §12.5 目录多副本）不在 D1 范围。
- **legacy 集群**：`GatewayCluster` + `HttpClusterBus` 非-custody 路径**保持不变**（v0.8 行为）；
  是否让 legacy 路径也采用 claim 注册表以获分裂脑安全，列为后续（非 D1）。

## 8. 不做（YAGNI 边界）

- gossip 协议、多中心、节点侧任何改动、transport 特性位改动（claim 对节点透明）。
- legacy `InboxStore` 分片模型迁移到 custody（两套并存，各服务其路径）。
- claim 库的 Redis 实现（端口预留，v1 只 SQLite）。
