# Transport v2：持久接管与当前实施边界

本批实现单 authority 消息接管链和节点事务存储基础，**不等同完整任务运行时、强隔离或多网关已完成**。不自动迁移旧 JSON、部署、拉镜像或调用真实模型。

## 协商与兼容

- 业务签名仍为 `EnvelopeV1`；保留 D23 全安全整数约束，不更改签名语义。
- `auth` 在首帧携带 node token、`transport_version: 2` 和 `features`，不可把 token 放 URL。
- 能力集为 `durable-custody`、`receiver-receipt`、`lease-renewal`；`lease-renewal`（B2 业务续租：牵头方回发 `task.lease.renew` 续租）在生产半落地后宣称，两端引用同一常量 `CUSTODY_FEATURES` 全量协商。
- 中心有 SQLite custody 时必须同时满足 v2 与三项能力（缺任一即 4004，陈旧对端只宣旧两位也拒）。`auth_ok` 携带版本、能力、节点身份，先于任何补投。
- 缺能力、版本不符或节点身份不符均拒绝；关闭码 4004 表示不兼容，无旧 `queued/delivered` 降级。
- 正式 `startQlongServer` 持久模式已启用 v2。显式回环 `--ephemeral` 使用旧演示协议，拒绝 v2。
- `GatewayClient({ runtime })` 要求 `NodeRuntimeStore`，不能同时传旧 `outbox/dataDir`。持久节点装配 `createDurableNode`（runtime/node.ts）已把生产链路接到事务任务 runtime：显式 SQLite 准入 + 收件箱 pump（逐条重授权后消费）+ `DurableExecutor` + 关停 flush；`qlong run` 已默认走该装配，须 `--storage-mode create|open` 与本地文件系统准入。旧 `createProductionNode` / 旧 `RemoteNodeSession` 仍为 v1 演示链路，不能连接持久 v2 中心完成任务。

## 三个持久边界

| 边界 | 必须先提交 | 提交后允许 |
|---|---|---|
| 发送节点 → 中心 | 固定签名/ID outbox；中心 mailbox | 中心返回 `stored` |
| 接收节点收件 | 验签/目标/摘要通过后持久 inbox | 返回 `receipt` |
| 中心收 receipt | 认证连接票据校验，原子终结 mailbox | 删除 payload，留下 received 记录 |

- 消息身份是发送节点 principal + `msg_id`；摘要是包括签名的完整信封 JCS SHA-256。
- `stored` 帧含 `from_node/msg_id/digest`。发送端必须匹配本地身份和持久摘要，再原子清 outbox payload、更新 delivery tracking。
- 未知 ACK、旧 ACK、NACK、routing.denied 不能清 v2 outbox。已存 stored 记录的重复 send 直接返回 stored，不复活 payload。
- 中心在线/离线一律先落盘，不依据 socket.send 成功作接管保证；收到同 ID 同正文重试返回 stored，同 ID 不同正文拒绝。
- `delivery` 帧携带 `envelope/digest/ticket`。随机不透明 ticket 留在当前连接内，绑定发送者、消息、摘要、接收节点及 connId；新连接重新签发，不跨重启复用。
- `receipt` 携带 `from_node/msg_id/digest/ticket`。网关只信当前认证连接身份，不信帧自报接收者。伪造/过时票据不释放 payload。
- 接收端重复同内容投递只补 receipt；不同摘要不确认。收到 receipt 不代表业务已处理，更不代表 project 验收完成。
- 数据库错误不伪装成功 ACK：中心停止接入/重试并关闭连接；节点存储故障停止自动接入，等待恢复。配额 FULL/身份 CONFLICT 是可解释的拒绝，不等同磁盘损坏。

## 有界行为

- 信封上限 256 KiB，额外帧包装预算 4 KiB；WS maxPayload 和 bufferedAmount 有限制。
- 网关每连接最多 16 个在投票据，默认 1 秒重投；接收端最多 16 个串行待验签条目，验证超时后停止而非积累悬挂验证。
- 客户端存活连接也重试，100ms 发送窗口最多 16 条，持久 attempts/lastAt，退避封顶 5 秒；握手有超时，旧 socket 回调受守卫约束。
- 中心每次新接管必须有有效绝对 exp，剩余寿命不超过 24 小时，严格到期不继续投递。到期 payload 转为持久 expired 记录；重复接管不会延长寿命。
- 客户端到期停止重发，但保留未获 stored 的 payload/tracking；没有伪造成功或静默清理。
- 默认中心上限：10,000 个身份（含终结记录）、64 MiB 待投 payload、每目标 1,000 条 pending。默认节点：10,000 个领域记录、64 MiB 逻辑字节。
- **tombstone GC 已实现，dedup/inbox/state 仍无 GC**：终态投递 tombstone（stored/received/expired）可由可选保留窗口 `retentionMs` 驱动 `prune()` 超窗回收（A1；未配置窗口则永久保留，pending/未投递 payload 永不淘汰）。但 dedup/inbox/state/effects 永不回收，上限仍是累计记录预算而非仅待处理队列预算，长时运行仍会满；须再实现 dedup/状态归档与收尾预留才能视为长期运行版本。不可删库或淘汰已接管记录解决满库。
- 逻辑字节限制不是物理数据库/WAL/磁盘配额；尚无容量/吞吐量基准，同步 SQLite 的事件循环阻塞仍须测量。

## 节点事务存储，不是旧会话包装

- `NODE_SCHEMA`/`NodeRuntimeStore` 绑定一个已登记 node UUID。独立数据目录/ownership 锁，显式 create/open。私钥与原始认证凭据不写运行库。
- `receive` 只持久收件；`pending` 返回待消费条目；重启 auth_ok 会通知已有 pending，而非再次执行。
- `consume` 在一个短事务内提交 inbox 决议、任务消息 dedup、state revision CAS、固定签名 outbox 和 effect intent。失败全回滚，回调不得进行网络、容器、Git 等外部 IO。
- 启动及相关读/写路径验证摘要、规范化 JSON、身份、delivery/outbox 配对、状态修订及关联。损坏状态拒绝恢复；不能隐藏损坏 payload 后继续确认。
- effect 由 `DurableExecutor` 以 RunHandle fence（task/attempt/generation/run_id）防陈旧完成；提交后由节点 pump 驱动 fenced driver（`FencedDriver`）。`FencedProcessDriver` 提供进程级 start/stop；注入持久 `RunHandleStore` 后于 start 返回前落盘 fence→pid+启动证据，recover 据此可判定：所记录 pid 已释放（`ESRCH`）即证明该精确 fence 跨重启静默 → `stopped`（执行器安全 settle 为 `execution_interrupted`，绝不重放 start）；pid 仍存活或无法跨平台核验身份（防 PID 复用误杀）、无句柄、fence 不符 → `unknown`（fail-closed → recovery_required）。未注入端口时退回恒 `unknown`。
- PROJECT 产物交付与验收（E2，详见 [产物可信验收设计](ARTIFACT-ACCEPTANCE.md)）：`FencedProcessDriver` 在按 fence 派生的隔离工作区执行（e2d-1）；PROJECT 完成路径在 SQL 事务外读契约声明文件、`buildManifest`+`signManifest`（ed25519 单独签名）、异步 `publishSignedArtifacts` 发布到每-attempt 分支 `qlong/<task>/a<attempt>`（绝不 force），注入 `task.result.body.artifacts=[{repo,manifest,branch}]`（e2d-2）。牵头侧 drain 在 `lead.consume` 前 `stageArtifactVerification(envelope)`（单参）独立收取产物字节、按 registry 登记纪元公钥验签、逐 deliverable 重哈希、核对契约完整性（四道防线），判定入每任务同步缓存供机器纯同步读取；缺清单 / 篡改 / 错钥 / 契约缺件一律 fail-closed → `acceptance_failed` → 改派，绝不误判 done（e2d-3/4）。
- v2 不调用旧 `onEnvelope`；旧 `RemoteNodeSession` 构造时拒绝 v2 client。旧演示链路仅保留 delivered 续租兼容；stored/queued/rejected/receipt 都不续租。
- 实际 task reducer、计时器（B1）、命令（E3）、业务续租（B2）与恢复 pump（C1）已接入同事务：`consume` 原子提交 inbox 决议/dedup/state CAS/签名 outbox/effect intent，提交后由节点 pump 驱动 fenced intent（`DurableExecutor`/`FencedDriver`）。仍不可消费 inbox 后再异步写状态，也不可先开容器再补意图。

## 已运行的测试入口

- core `transport.spec.ts`：协商/帧验证/完整信封摘要。
- gateway `custody-store.spec.ts`、`transport-v2.spec.ts`：SQLite 重开、COMMIT 错误、配额、过期、真假/旧票据、连接存活时重投、无先发后存。
- node `runtime-store.spec.ts`、`gateway-custody.spec.ts`、`session-custody-boundary.spec.ts`：事务与恢复损坏、收件失败不 receipt、stored 丢失/错误 ACK 不删、本地重复 send、串行验证、窗口/背压与会话阻断。
- cli `server-custody.spec.ts`：正式中心 + 真实 Registry 验签 + 实际 client/runtime，中心/节点重开、接管与收件 COMMIT 故障、v1→v2 追加迁移保留原数据/校验和。
- node `durable-node.spec.ts`：`createDurableNode` 全链 pump——v2 闭环（offer→accept→driver→result→stored 释放）、无 driver 拒单、重启 pending 重授权消费、验证失败留 pending 重试、cancel/租约到期、关停 flush、create/open 准入与身份不匹配拒绝、consume COMMIT 故障 fail-closed。
- node `fenced-driver.spec.ts`：`FencedProcessDriver` 的 exit 0/非零、stop 静默、任务超时、spawn 失败、workdir 装配、run handle 落盘/清除，以及 recover 判定矩阵（持久 pid 已释放 → stopped；存活/无端口/无句柄/fence 不符/pid 非法 → unknown，防 PID 复用误判）。
- node `run-handle-store.spec.ts`：`PersistentRunHandleStore`（`node_state` 单键 `runhandle:v2` 背书）record/load/clear 往返、精确 fence 隔离、墓碑复用、损坏值 fail-closed，以及句柄跨真实 SQLite 重开的 e2e（已退出孤儿 → recover stopped，存活孤儿 → recover unknown）；`durable-node.spec.ts` 另固化 driver 工厂形式装配（`createDurableNode` 用持久 runtime 解析工厂并接线执行器）。
- node `durable-lease-loop.spec.ts`：B2 业务续租端到端闭环——牵头方 `DurableLead` 生产半与执行方 `DurableExecutor` 消费半经双独立 store + 手动中继信封互操作（offer→accept→跨心跳 progress→`task.lease.renew`→业务租约死线延长），并验证延长死线跨 store 重开持久（多网关接续的唯一事实基础）。生产半/消费半的单元边界另由 `durable-lead.spec.ts`（B2a）与 `durable-executor.spec.ts` 固化。
- gateway `grant.spec.ts`：D2 跨队能力授权——`grantLookup` 返回活跃 grant 的 `caps_visible` 并集（`undefined` = 无 grant）；跨队派发强制 `required_caps ⊆ caps_visible`（复用 core `matchCaps`，§3.2/D31 单一实现防派发/执行语义分叉），覆盖/不覆盖、版本段语义、AND 全覆盖、`caps_visible` 空、畸形 `required_caps` fail-closed、无 grant 优先于 caps 判定。registry `directory.spec.ts` 的 `grantCaps` describe 固化并集/双向对称/过期失效/revoke 回落。
- node `durable-lead-takeover.spec.ts`、`durable-executor.spec.ts`（C2b/C2c）、`durable-node.spec.ts`（C2d）：多 lead / 单 exec 归属仲裁——`exportTasks/importTasks` 的 attempt 高水位 fence（禁双主回退 / 终态归档 / 在途 attempt+1 归位 drafting / task_seq·renewalSeq 续接 / 损坏 fail-closed）、执行方 `stale_attempt` 高水位守卫与 control 的 lead+attempt 身份匹配、单槽 busy 串行、接管↔续租（renewalSeq 单调续接）↔恢复（recover 不复活陈旧 run）联动，以及 `createDurableNode.takeover` 两节点跨机接管端到端（导入即重派 attempt+1、flush 新 offer、投影续接 task_seq）。
- 本批接管集成是回环 WS/SQLite 重开及故障注入；不是双机、容器、真实模型、进程全链强杀或掉电验收。storage 包已有的子进程强杀测试不能代替这些验证。

任务 pump 接线批次最终验证：全仓 **1350 项通过、2 项平台跳过**，7 包类型检查、CLI 构建/离线 demo（demo/takeover）、Console 构建通过。完整测试命令为 `pnpm -r --workspace-concurrency=1 --if-present run test --exclude '**/dsh-e2e.spec.ts' --retry 0 --maxWorkers=2`，退出码 0。默认高并发曾出现 Vitest `ERR_IPC_CHANNEL_CLOSED`；降低 runner 并发完成全量检查，没有启用失败测试自动重试或新增排除。另修复 gateway `routeAsync` 兜底入箱与连接补投的竞态（节点在判离线后、入箱前上线会滞留信封到下次重连；入箱后同一步复查连接表并立即补投），`bus.spec` 单文件重复运行回归通过。

> 更正：上述“退出码 0”在提交时并不成立——`node/test/runtime-local.spec.ts` 的 2 项 state 列举用例实为失败。根因是 `node:sqlite` 读回 TEXT 列时在首个 NUL 字节处截断（库内字节完整，仅读回被截断），而 `NodeRuntimeStore` 契约允许 state key 含 embedded NUL。已在 `runtime/store.ts` 修复：所有 node_state 读取改走 `CAST(state_key AS BLOB)` 投影，`decodeState` 从 blob 精确还原 key。修复后按同一命令全仓 **1353 项通过、2 项平台跳过**，7 包类型检查通过，退出码 0。

> C1（RunHandle/orphan 恢复产品化）收尾验证：`FencedProcessDriver` 注入持久 `RunHandleStore`（`PersistentRunHandleStore` 以 `node_state` 单键 `runhandle:v2` 背书，`createDurableNode` 用 driver 工厂形式装配），recover 由恒 `unknown` 收敛为可判定——已退出孤儿跨真实 SQLite 重开可证静默 → `stopped`（执行器安全 settle 为 `execution_interrupted`，绝不重放 start），存活孤儿因 PID 复用无法跨平台核验身份 → `unknown`（fail-closed）。按同一命令全仓 **1434 项通过、2 项平台跳过**，7 包类型检查通过，退出码 0。

> C2（多 lead / 单 exec 归属仲裁）收尾验证：`DurableLead` 增跨机接管 fence——`exportTasks`/`importTasks` 按 attempt 高水位仲裁（本地 ≥ 导入 → fenced 禁双主回退；终态 → archived 不重跑；在途 → attempt+1 归位 drafting 且 task_seq/renewalSeq 原样保留供序号单调续接；损坏 bundle/本地状态一律 fail-closed）。`createDurableNode` 暴露一等 `takeover(bundle)`：importTasks 后立即驱动一次 `lead.tick()`（归位 drafting 的在途任务经注入 `selectTarget` 重派）+ `client.flush()` 发出新 offer + `flushReports()` 投影首条修订——等价 v1 `lead/takeover.ts` `importCheckpoints` 的 `onNeedDispatch` 回调接线到持久泵，无需等待下个周期。执行方单 exec 归属仲裁（`stale_attempt` 高水位守卫、control 的 lead+attempt 身份匹配、单槽 busy 串行）与接管↔续租↔恢复联动（renewalSeq 跨接管单调续接、recover 绝不复活旧 lead 陈旧 run）由回归护栏固化。自动选举（谁有权触发接管、免人工）仍属开放问题（01 §13.2）。按同一命令全仓 **1448 项通过、2 项平台跳过**，7 包类型检查通过，退出码 0。

> D1（网关集群 claim 注册表）收尾验证:`LocalClaimRegistry`（d1a/b）→ `SqliteClaimStore`（d1c,中心 schema v3,generation 高水位跨进程/跨重启单调）→ custody 集群路由解禁（d1d,`PumpRelay` + `/internal/pump` 双形态 + fence 守卫）。claim 对节点完全透明（不进 `CUSTODY_FEATURES`,不改 transport 协商）;分裂脑经 generation"高者恒胜"收敛,TTL 是死 authority claim 残留上界。全仓 **1489 项通过、2 项平台跳过**,7 包类型检查通过。设计定稿与验证记录见 [CLUSTER-REGISTRY](CLUSTER-REGISTRY.md) §7b。

## 仍待完成

任务 pump：单 executor aid 闭环已接通（`createDurableNode` + `FencedProcessDriver`：offer→accept→progress 心跳→result/fail/lease_expired/cancel 全事务，重启 pending 逐条重授权消费，关停 flush 后断连；CLI `qlong run` 已接入并要求显式 create/open 存储）。**业务续租（B2）已端到端接通**：牵头方在 running 收到带 v2 fence 的 `task.progress` 时回发 `task.lease.renew`（生产半，`renewalSeq` 持久单调、重启对齐），执行方经 `canApplyLeaseRenewal` 绑定 fence 与 progress 身份后延长业务租约死线（消费半）；`lease-renewal` 能力位两端引用同一 `CUSTODY_FEATURES` 全量协商，陈旧对端缺此位即 4004。延长死线跨 store 重开持久，多网关/进程接续只读执行方持久 `leaseDeadline`，无需专门的网关租约逻辑。持久状态上报（`DurableTaskReporter` 经真实 HTTP 汇把牵头任务生命周期投影到中心）、投递结果查询 API（`GET /v1/nodes/me/deliveries/:msgId`，仅发送方可读）、保留窗口/tombstone GC（回收终态 stored 墓碑、绝不删 pending）亦已落地。**节点跨队能力授权（D2）已接通**：`GrantRecord.caps_visible` 从死字段变为执法依据——注册中心 `grantCaps(from,to)` 取活跃 grant 的 `caps_visible` 并集（双向对称、过期失效、无 grant → `undefined`），网关上行 ACL 跨队派发强制 `required_caps ⊆ caps_visible`（复用 core `matchCaps`，与执行侧闸3 单一实现防语义分叉），不覆盖即 `routing_denied(acl_caps_not_granted)` + 跨队审计；派发侧授权与执行侧自评构成双层防御。**多 lead / 单 exec 归属仲裁（C2）已接通**：`DurableLead.exportTasks/importTasks` 以 attempt 高水位仲裁跨机接管（本地 ≥ 导入 → fenced 禁双主回退、终态 → archived、在途 → attempt+1 归位 drafting 并原样保留 task_seq/renewalSeq），`createDurableNode.takeover(bundle)` 导入即驱动一次重派 + flush 新 offer/上报（等价 v1 `importCheckpoints` 的 `onNeedDispatch` 接线到持久泵）；执行方单 exec 以 `stale_attempt` 高水位守卫 + control 的 lead/attempt 身份匹配 + 单槽 busy 串行防双执行，接管与续租/恢复联动经回归护栏固化；自动选举仍属开放问题（01 §13.2）。仍待完成：活孤儿安全接管（RunHandle 恢复产品化 C1 已让**已退出**孤儿跨重启可证静默 → stopped、执行器安全 settle 不重放 start；**存活**孤儿因 PID 复用无法跨平台核验身份仍 → unknown/recovery_required，其安全接管待 E1 强隔离提供进程身份证据）、Docker/Podman network-none 与模型 broker、产物可信验收、IPC/owner 命令、gateway-only/authority 连接登记、旧数据显式迁移与全链故障矩阵。

建议后续修改每个提交边界时先补故障回归，再运行对应测试、全仓类型检查和排除真实模型 E2E 的全仓测试。未完成强隔离前不向不受信节点开放执行。


