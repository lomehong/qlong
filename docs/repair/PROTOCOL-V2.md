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
- **本批无 tombstone/dedup GC**：上限是累计记录预算，不是仅待处理队列预算，长时运行会满；必须在实现保留窗口/归档与收尾预留后才能视为长期运行版本。不可删库或淘汰已接管记录解决满库。
- 逻辑字节限制不是物理数据库/WAL/磁盘配额；尚无容量/吞吐量基准，同步 SQLite 的事件循环阻塞仍须测量。

## 节点事务存储，不是旧会话包装

- `NODE_SCHEMA`/`NodeRuntimeStore` 绑定一个已登记 node UUID。独立数据目录/ownership 锁，显式 create/open。私钥与原始认证凭据不写运行库。
- `receive` 只持久收件；`pending` 返回待消费条目；重启 auth_ok 会通知已有 pending，而非再次执行。
- `consume` 在一个短事务内提交 inbox 决议、任务消息 dedup、state revision CAS、固定签名 outbox 和 effect intent。失败全回滚，回调不得进行网络、容器、Git 等外部 IO。
- 启动及相关读/写路径验证摘要、规范化 JSON、身份、delivery/outbox 配对、状态修订及关联。损坏状态拒绝恢复；不能隐藏损坏 payload 后继续确认。
- effect 由 `DurableExecutor` 以 RunHandle fence（task/attempt/generation/run_id）防陈旧完成；提交后由节点 pump 驱动 fenced driver（`FencedDriver`），`FencedProcessDriver` 提供进程级 start/stop 与恒为 unknown 的 recover（重启在跑任务 → recovery_required，绝不重放 start）。
- v2 不调用旧 `onEnvelope`；旧 `RemoteNodeSession` 构造时拒绝 v2 client。旧演示链路仅保留 delivered 续租兼容；stored/queued/rejected/receipt 都不续租。
- 下一阶段须把实际 task reducer、计时器、命令、业务续租与恢复 pump 接入同事务，提交后执行 fenced intent。不能消费 inbox 后再异步写状态，也不能先开容器再补意图。

## 已运行的测试入口

- core `transport.spec.ts`：协商/帧验证/完整信封摘要。
- gateway `custody-store.spec.ts`、`transport-v2.spec.ts`：SQLite 重开、COMMIT 错误、配额、过期、真假/旧票据、连接存活时重投、无先发后存。
- node `runtime-store.spec.ts`、`gateway-custody.spec.ts`、`session-custody-boundary.spec.ts`：事务与恢复损坏、收件失败不 receipt、stored 丢失/错误 ACK 不删、本地重复 send、串行验证、窗口/背压与会话阻断。
- cli `server-custody.spec.ts`：正式中心 + 真实 Registry 验签 + 实际 client/runtime，中心/节点重开、接管与收件 COMMIT 故障、v1→v2 追加迁移保留原数据/校验和。
- node `durable-node.spec.ts`：`createDurableNode` 全链 pump——v2 闭环（offer→accept→driver→result→stored 释放）、无 driver 拒单、重启 pending 重授权消费、验证失败留 pending 重试、cancel/租约到期、关停 flush、create/open 准入与身份不匹配拒绝、consume COMMIT 故障 fail-closed。
- node `fenced-driver.spec.ts`：`FencedProcessDriver` 的 exit 0/非零、stop 静默、任务超时、spawn 失败、workdir 装配与恒 unknown 的 recover。
- 本批接管集成是回环 WS/SQLite 重开及故障注入；不是双机、容器、真实模型、进程全链强杀或掉电验收。storage 包已有的子进程强杀测试不能代替这些验证。

任务 pump 接线批次最终验证：全仓 **1350 项通过、2 项平台跳过**，7 包类型检查、CLI 构建/离线 demo（demo/takeover）、Console 构建通过。完整测试命令为 `pnpm -r --workspace-concurrency=1 --if-present run test --exclude '**/dsh-e2e.spec.ts' --retry 0 --maxWorkers=2`，退出码 0。默认高并发曾出现 Vitest `ERR_IPC_CHANNEL_CLOSED`；降低 runner 并发完成全量检查，没有启用失败测试自动重试或新增排除。另修复 gateway `routeAsync` 兜底入箱与连接补投的竞态（节点在判离线后、入箱前上线会滞留信封到下次重连；入箱后同一步复查连接表并立即补投），`bus.spec` 单文件重复运行回归通过。

> 更正：上述“退出码 0”在提交时并不成立——`node/test/runtime-local.spec.ts` 的 2 项 state 列举用例实为失败。根因是 `node:sqlite` 读回 TEXT 列时在首个 NUL 字节处截断（库内字节完整，仅读回被截断），而 `NodeRuntimeStore` 契约允许 state key 含 embedded NUL。已在 `runtime/store.ts` 修复：所有 node_state 读取改走 `CAST(state_key AS BLOB)` 投影，`decodeState` 从 blob 精确还原 key。修复后按同一命令全仓 **1353 项通过、2 项平台跳过**，7 包类型检查通过，退出码 0。

## 仍待完成

任务 pump：单 executor aid 闭环已接通（`createDurableNode` + `FencedProcessDriver`：offer→accept→progress 心跳→result/fail/lease_expired/cancel 全事务，重启 pending 逐条重授权消费，关停 flush 后断连；CLI `qlong run` 已接入并要求显式 create/open 存储）。仍待完成：业务续租（多网关接续）、多 lead/单 exec、RunHandle/orphan 恢复产品化（当前 recover 恒 unknown → recovery_required）、Docker/Podman network-none 与模型 broker、产物可信验收、IPC/owner 命令、持久状态上报、节点跨队能力授权、gateway-only/authority 连接登记、投递结果查询 API、保留窗口/GC/收尾预算、旧数据显式迁移与全链故障矩阵。

建议后续修改每个提交边界时先补故障回归，再运行对应测试、全仓类型检查和排除真实模型 E2E 的全仓测试。未完成强隔离前不向不受信节点开放执行。


