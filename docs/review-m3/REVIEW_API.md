# 群龙 M3 评审意见——接口与集成缝视角

> 评审对象:M3「双机真实传输闭环」——`packages/node/src/remote/session.ts`(RemoteNodeSession)、`packages/gateway/test/cross-machine.spec.ts`、`packages/gateway/test/lost-redelivery.spec.ts`,及其接口对端(`gateway-client.ts`、`lead/machine.ts`、`executor/machine.ts`、`local/harness.ts`、`outbox.ts`、`gateway/src/ws.ts`、`node/src/index.ts`)与文档交付物(`docs/testing/WALKTHROUGH-2NODE.md`、`docs/testing/R-MATRIX.md`)。
> 对照基线:`QLONG_DESIGN_NOTES.md`、`QLONG_DESIGN_01_MSG_PROTOCOL.md`(下称 01)、`QLONG_DESIGN_02_REGISTRY_TRUST.md`(下称 02)、`QLONG_DESIGN_03_CAPABILITY.md`(下称 03)、`QLONG_IMPL_PLAN.md`;并对照 `docs/review-m1/`、`docs/review-m2/` 已决事项(M1 API-1/API-4/API-5、M2-06/09/13/20 等已裁事项只提「M3 缝上的现状」,不重复原论证)。
> 评审范围:仅接口与集成缝(RemoteNodeSession 与 GatewayClient/状态机的边界、envelope 组装职责与 OutboundSpec/Outbound/EnvelopeV1 三套类型收敛、回调覆写链语义、走查剧本与 A1–A10 映射、与 M4 的接缝预留)。协议语义细则、安全渗透、测试充分性由其他视角队友评审。
> 已承认不重复:网关集群化、owner 账号、跨队 grant、目录多副本、真实 deepseek-harness 基座适配(后续批次)。

## 结论 verdict

**需重大修订**。方向正确:seal() 出站统一「校验→签名」、R4 先撤后改派在真实时序上成立、lost/改派端到端把 M1 虚拟时钟矩阵第一次接上了真实网关,骨架值得肯定。但接线只完成了机器接口的**半张图**:①执行方「回执续租」输入(client ACK → `onHeartbeatAcked`)在双机会话中不可达,任何超过 lease 的任务都会假暂停→假 lost→改派循环,属任务丢失级缺陷(blocker);②入站缝没有 R1 去重管线,已终态任务重放同 attempt offer 会被重新接受执行;③入站按「类型二分」粗粒度分发,执行方方向的 `reject(stale_attempt)` 到不了状态机,rpc.* 被塞进牵头方 R0 闸产生垃圾回执;④A4 验签、I-09 断线暂停、R8 排除消费、§11 审计关联字段四条已定设计在 M3 缝上均无承载位,而 e2e 标题与 R-MATRIX 已按「已覆盖」记账。这些缝正是 M4(能力上报/执行档案/异步接单)要踩的地面,必须在 M4 开工前处置。

## 摘要

M3 的价值在「把纯状态机接到真实传输」时**不动机器**,这一点做到了;问题集中在会话层对机器接口的**单向接线**:出站(send/audit/schedule/driver)全接了,入站反馈(ACK 回执、stale reject、连接态)一个都没接——单机总线 `SingleNodeHarness` 接了这三样,双机会话全漏,两台机器在真实链路上实际跑在「残输入」状态。类型层面,`OutboundSpec` 与 `wire.Outbound` 近乎重复,seal() 在唯一的出站装配点丢弃 `reply_to`、钉死 `hops:0`、转派 trace 无参数位;回调覆写链 onEnvelope 覆写 / onRoutingDenied 链式不对称,测试被迫二次覆写自证。文档层面,W3 推迟与 IMPL_PLAN M3.2「A3 过」矛盾,W1 在线态无承载,W5 的「A5」与 ACL A5 同码双义,R-MATRIX 多行记账先于实现。

## 问题清单

### API-1|blocker|执行方「回执续租」未接线:`onHeartbeatAcked` 在真实链路不可达,超过 lease 的任务必然假暂停→假 lost→改派循环

- **位置**:`packages/node/src/remote/session.ts` L87-92(构造器只绑 `onEnvelope`/`onRoutingDenied`,未订阅 `client.onAck`)、L166-204(`processExec` 无任何回执→机器通路,`deliver` L287-293 的返回值被 `void` 丢弃);对照 `gateway-client.ts` L41/L156-165(`onAck` 默认 noop,ack 分支只清 outbox);`executor/machine.ts` L244-260(`onHeartbeatAcked` 是 `lease_self` 唯一的续期入口)、L263-270(`onLeaseSelfTimeout` 到点即 `paused`)、L277-282(暂停后完成 → 发 `cancel.ack` 而非 result);`lead/machine.ts` L255-258(running 收 cancel.ack → 忽略)。
- **问题**:01 R3 明文「执行方侧对称计时器:**自最后一条成功送达(获网关 ACK)的心跳起算 `lease_ms`**」——续租的输入就是回执。`RemoteNodeSession` 没有把任何回执信号喂给 `exec.onHeartbeatAcked`,于是 `lease_self` 在 accept 时刻一次性排定、永不续期:任务时长超过 lease 时,执行方在 lease 末尾必然进入 `paused`,此后 result 被改发为 `cancel.ack`(L277-282),心跳停止,牵头方在 `2×lease/3+grace` 后误判 lost → R4 回收改派——**健康链路上的长任务 100% 走假回收**,若 `pickTarget` 再选回原节点则循环烧尽 `max_attempts` → escalate(任务丢失)。01 §10 对 `lease_ms` 的说明就是「长任务靠心跳续」,此缝使该承诺在 M3 运行形态整体失效。决定性对照:**单机总线接了这条输入**——`local/harness.ts` L194-197(progress 送达即回 `onHeartbeatAcked`)与 L232-234(heartbeat 触发后紧跟 ack);双机会话把同一台机器的同一输入丢了。现有测试未暴露,只因 `FAST_PARAMS` lease=400ms 而桩 50ms 完成(cross-machine.spec L16-30/L138)。R-MATRIX L13 R3 行「executor seq/**回执续租**/暂停 ✅」对真实链路是失真记账(该覆盖仅存在于 harness 的单测)。
- **建议**:最小改法不需要新接口——`deliver()` 已 `await client.send()` 拿到 `SendReceipt`:progress 出站改为 `void this.deliver(env).then(r => { if (r === 'delivered' || r === 'queued') this.processExec(this.exec.onHeartbeatAcked(Date.now()), …) })`(R11 语义下获网关回执即算送达);或在构造器接 `opts.client.onAck` 按 msg_id 关联。补一条「stub 完成时间 > lease(依赖心跳续租)→ 仍 result 交付、attempt=1」的回归用例,并把 R-MATRIX R3 行拆注「harness 已测 / session 已接线」两种状态。

### API-2|major|R1 去重管线缺席:已终态任务重放同 attempt offer 会被重新接受执行,`dedup_mismatch`/保留期语义无承载

- **位置**:`packages/node/src/remote/session.ts` L227-262(`onEnvelope` 仅做 to/跨队两查后直分机器,无 DedupStore);`core/src/dedup.ts` 全仓唯一调用方是 core 自测(semantics/property.spec);`executor/machine.ts` L104-147(`onOffer` 的重复吸收仅覆盖 offered/running 态;`result_sent/stopped/cleaned` 态收到同 `(task_id, attempt)` 的 offer 会落到 L147 `evaluateOffer` 重新接单并 `startDriver`);`gateway-client.ts` L181(入站仅形状校验)。
- **问题**:01 P4「一切消息至少一次、**执行必须幂等**」、R1「去重靠 ID 体系,不在传输层解决」,02 §10 把「网关/收件箱等持有者原样重放」列为在册威胁并以 R1 为缓解。M1 API-5 已裁定「R1 去重属于入口管线,harness 没有这条管线的接缝,M2 换真实现」——M3 会话正是那条缝,但 `onEnvelope` 没有接 DedupStore。后果:执行方已完成(result_sent)后,同一 offer 因 outbox 重发/网关重放再次到达(offer_ttl 60s、exp 地平线 24h,时间窗极宽),状态机无 R1 挡押,`gateLoad(undefined)` 缺省放行 → **整任务重新执行**(数据错乱级);lead 侧终态机器 `onMessage` L167 直接吞,亦无 `dedup_mismatch` 审计与保留期记账。另:running 态重复 offer 走 L108 `return []`,连 R0 要求的「忽略 **+ 审计**」都没有。
- **建议**:`onEnvelope` 入口接 core `DedupStore`(键 `(task_id, attempt, type)`,progress 豁免+可选 `seq`;保留期用 `dedupRetentionMs`),同键异体 → `dedup_mismatch` 审计后丢弃;running 态重复消息补审计动作;补「result_sent 后重放同 attempt offer → 忽略+审计、驱动不重启」确定性用例。管线形态建议与 M1 开放问题 Q1(异步接单)合并为独立 Ingress 组件(harness/session 共用),见开放问题 Q2。

### API-3|major|入站按「类型二分」分发而非按 (task_id, 角色):executor 方向的 `reject(stale_attempt)` 不可达,rpc.* 被塞进牵头方 R0 闸

- **位置**:`packages/node/src/remote/session.ts` L238-261(仅 `task.offer`/`task.cancel` 分给 exec,其余一律 `this.lead.onMessage(...)`);`executor/machine.ts` L336-344(`onStaleReject` 实现了 01 §5.2「收到 reject(stale_attempt)→本地记账/清理→终态」,但 RemoteNodeSession 零调用——全仓唯一调用方是 `local/harness.ts` L183-185);`lead/machine.ts` L166(`onMessage` 无 task_id 形参,会话层也未过滤 `env.task_id === this.lead.task_id`)、L169-177(attempt 闸)。
- **问题**:①R0 的「牵头→执行:拒收迟到旧 attempt 消息」与 01 §5.2 的对应转移,在双机链路上不可达:B 迟发的 result 被 A 回 `reject(stale_attempt)` 后,B 会话把它喂给 lead(无 lead 则静默丢),`onStaleReject` 成死代码,执行方本地状态/驱动清理缺失;②`rpc.ask/answer` 信封无 `attempt` 字段,session L260 以 `env.attempt ?? 0` 喂进 lead 的 attempt 闸 → `0 < 当前` → **对一条 rpc 问答回 `task.reject(stale_attempt)`**(协议垃圾回执,01 §4.1 问答独立于 task 族);③一节点同时牵头 X、执行 Y 时,Y 方向的 reject 会进 X 的机器,仅靠 `fromNode === rec.target`(L194/L206/L218)侥幸吸收,`reclaiming/cancelling` 分支无 from 校验,attempt 恰好同值时即跨任务污染。
- **建议**:`onEnvelope` 改为按类型白名单+task_id 分发:`task.reject` 且 `body.reason_code === 'stale_attempt'` 且非当前 lead 目标 → `exec.onStaleReject()`(或给机器加带 reason 的 `onReject` 入口);`rpc.*` 显式分流(回 `unsupported_type` 前先验签+同队复核,01 §3.3.4)或独立 rpc 分发缝;`lead.onMessage` 增加 task_id 校验参数,会话层过滤后再投,不靠 fromNode 巧合。`SingleNodeHarness.deliverToExecutor` L167-185 的三分发就是要复刻的语义。

### API-4|major|A4 验签在 M3 集成层缺位:e2e 标题声称「A4」但 `verifyInbound` 从未配置,节点密钥目录无落点

- **位置**:`gateway-client.ts` L186-189(`verifyInbound` 未配置 → 信封直通 `onEnvelope`,即 M2-13 判定的 fail-open 缺省);`cross-machine.spec.ts` L98-102、`lost-redelivery.spec.ts` L83-87(两处构造 GatewayClient 均不传 `verifyInbound`);`cross-machine.spec.ts` L146(测试标题「真实 ws+签名+**A4**」);全仓 `verifyInbound` 唯一接线是 M2 的 `trio.spec.ts` L67;`session.ts` 全文无验签/公钥目录触点。
- **问题**:02 P10「双重执法:网关主(不验签)+ 节点辅(验签+复核)」——v1 网关不验签,节点侧验签是签名体系唯一现役执法点。M2 修订清单 #8 明确把「A4 验签缺省拒绝/包内默认实现」列为 **M3 接线前必修**,M3 交付的会话(自称「运行形态」)没有安装该钩子,两个 M3 e2e 里**没有任何一封入站信封被验过签**——出站签名是真的,「+A4」的标题断言不成立。同时 M2-20 第 3 项「节点密钥目录(TOFU 钉扎+纪元现势校验+历史纪元查取,02 §6.2/D29)」在 node 包仍无落点,session 持有 priv/teamId 是安装校验的自然位置,接口上却没有承接位;v1.5 直连落地后这里就是唯一防线,形状现在不定,M4/直连必返工。
- **建议**:`RemoteSessionOptions` 增加 `verifyInbound` 透传,并提供包内默认工厂(注入「node_id → (pubkey, key_epoch) 目录」接口,可先复用测试里已存在的目录快照对象;TOFU 首连钉扎按 02 §10 最小硬化);`GatewayClient` 在未配置 `verifyInbound` 时对 `task.*`/`rpc.*` 静默丢弃+计数(fail-closed,M2-13 原建议);cross-machine 补「坏签名信封不得到达 onEnvelope/不得产生 result」断言,让标题与事实一致。

### API-5|major|I-09「断线暂停 lost 计时」无接缝:机器无连接态输入,session 不订阅 onClose,自身断网窗口内必假判 lost

- **位置**:01 R3(「**ws 断线期间,本节点全部入站任务的 lost 计时暂停**,重连后从最后一条(含补投的)心跳重新起算;drain 窗口随重连重新打开」,评审 I-09);`QLONG_IMPL_PLAN.md` L68(M3.2 交付项明列「断线重连计时暂停+drain 重开(I-09)」);`lead/machine.ts` L57/L311-337(定时器仅 offer_ttl/lease/drain/cancel_wait,无任何连接态入口);`session.ts` L138-146(lead 定时器直接真实 setTimeout,全文无 `client.onClose` 订阅——`gateway-client.ts` L21/L43/L95 该回调存在且空闲);`lost-redelivery.spec.ts` 只覆盖「对端真死→判 lost」,不覆盖「自身断线→暂停」半边。
- **问题**:R3 的停跳可能来自两端任何一端,I-09 专门裁定「计时器以各自连接态为准」。M3 会话把 lead 的 lease/drain 定时器直接挂在墙上钟上,自身与网关的连接抖动(网关重启、网络分区超过 `2×lease/3+grace`,默认参数约 230s)期间收不到心跳,定时器照走 → 对健康的执行方发起 cancel+改派级联,执行方还可能同时在跑新 attempt(R0③ 隐式取消)——一次网络抖动换来一次无谓的 attempt 消耗。这是 IMPL_PLAN 点名 M3.2 交付的规则,R-MATRIX L13 未单列、实现无承载位,属「里程碑验收行与实现脱节」。
- **建议**:优先在机器加输入:`onConnectionLost(now)`(冻结判定并记住剩余死线)+ `onConnectionRestored(now)`(按最后心跳重排 lease、重开 drain),session 订阅 `client.onClose`/auth_ok 接线;最小替代:session 层在断线时 disarm 全部 lead 定时器并记录,恢复后按 `rec.leaseDeadline` 重排(语义近似,文档声明差异)。补「A 断线 >lost 窗口→重连→不误改派、心跳重起算」用例。

### API-6|major|R8 排除表没有消费契约:`pickTarget` 由应用自选且测试刻意绕开 `excluded`,「排除后选 C」实际未被测试

- **位置**:`session.ts` L147-153(`requestDispatch` → `opts.pickTarget(taskId, nextAttempt, m.rec.excluded)`,无缺省实现);`lead/machine.ts` L406-416(`applyExclusion` 维护 permanent/once,协议侧完整);`lost-redelivery.spec.ts` L137-142(pickTarget 写 `void excluded`,按 `nextAttempt<=1 ? B : C` 硬编码);`docs/testing/R-MATRIX.md` L18(R8 行:「lead excluded 表 + lost-redelivery **排除后选 C** ✅」)。
- **问题**:01 R8 是协议层硬约束(「持久失败:本 task 生命周期内**永久排除**该节点;瞬时 retryable 仅排除一次」)。机器忠实维护了排除表,会话把表递给应用回调后,**没有任何机制保证回调读它**:测试的 pickTarget 明确 `void excluded`、按 attempt 数选 C——「B 被排除后选 C」的断言从未发生,被验证的只是「第 2 次派给 C」。应用若忽略 excluded,立即违反 R8。R-MATRIX 该行把「表被维护」记成「排除被消费」,记账失真。
- **建议**:session 提供缺省 picker(过滤 `excluded` 后按目录顺序取首个候选,无候选维持 drafting 等待),应用回调定位为覆盖;lost-redelivery 用例改为:不注入 pickTarget,断言缺省选择跳过 B 选中 C;或至少断言改派时 `rec.excluded` 含 B 的正确档位(permanent/once);R-MATRIX 拆行如实记账。

### API-7|major|§11 审计关联字段在会话层断裂:audit 动作只有 event/reason,W8「关联字段齐备」在 M3 链路不可达

- **位置**:`lead/machine.ts` L61、`executor/machine.ts` L41(audit 动作形状仅 `{ event, reason? }`);`session.ts` L136/L175(`makeAudit(a.event, { node_id, reason }, …)`,机器产出的任务上下文无从透传);`session.ts` L44 与 `lead/machine.ts` L384-390(escalate 摘要无 `trace_id`);01 §11(「每条与任务相关的日志必须含 `trace_id / task_id / attempt / msg_id`(外加 `key_epoch`)——**缺字段视为日志缺陷**」;escalate 结构化事件含 `trace_id`)。
- **问题**:A8(v0.1 验收项)要求「仅凭双机本地日志 + trace_id 离线还原一次派单全生命周期」,WALKTHROUGH L24 把 W8 排在「M3 收口核验」;但 M3 运行形态里节点侧审计事件只有事件名+reason,无任何任务关联字段,`reclaim/escalate/stale_attempt_rejected` 等关键事件无法与 task/trace 关联——A8 的机器半边(事件在发)与传输半边(事件可还原)在会话缝上断开。M1 API-4 的裁定(审计动作增加关联字段,core `makeAudit` 已支持这些字段)没有落进机器动作形状;lost-redelivery L143-144/L163 只断言了事件名。这是 M4 之前必须补的接口形状(动作加字段是纯增量)。
- **建议**:`LeadAction/ExecAction` 的 audit 分支增加 `task_id/attempt/trace_id/msg_id`(两台机器都掌握这些字段;escalate 摘要补 `trace_id`),session 透传给 `makeAudit`;cross-machine 增加一条「reclaim 事件含 trace_id/task_id/attempt」断言;R-MATRIX 增设 §11/审计行,与 W8 收口核验对表。

### API-8|major|R2 body 级 `offer_ttl` 在执行方不可达:`offered` 驻留与 ttl 定时器缺位,补投的过期 offer 被照单接受

- **位置**:`executor/machine.ts` 全文无 `state = 'offered'` 赋值(L219-228 `onTtlCheck` 以 `state==='offered'` 为前置,恒死代码),`evaluateOffer` L182-204 同步置 running 且只排 heartbeat/lease_self(不排 `'ttl'`);`session.ts` L189-197 的定时器分发保留 `onTtlCheck` 分支但永远无人排 `'ttl'`;对照 01 R2(「执行方以『晚于』TTL 判过期……**长期离线节点上线后收件箱批量过期 offer → 整批 `reject(expired)`(必测场景)**」)、02 §8(project 类 offer 收件箱暂存 + offer_ttl)。
- **问题**:M1 API-1 blocker 的裁决修法是入口 exp 闸(machine L136-140,引「评审 M1-API-1」),它只挡 24h 级 `exp` 过期;body 内 `offer_ttl_ms`(project 60s/aid 10s)的 R2 判定在 M3 链路**没有任何执行点**——网关按 P3 读不到 body TTL,补投照发;执行方收到 2 小时前的补投 offer,exp 仍新鲜,直接 accept 开跑。缓解有限:改派链上 R0③ 隐式取消可自愈,但 `max_attempts` 耗尽/escalate 后的死单会被 B 认领并完整执行(result 被 R0 拒,白烧唯一执行位)。同时,「offered 可驻留、可被 TTL 打断」正是 M4 闸5「本地人确认与 offer_ttl 赛跑」(03 §6.2,评审 DIST-13)的必要形态——同步 `evaluateOffer` 的模型下 M4 只能破坏性重构。另 R-MATRIX L12 R2 行把「过期链路」记在 `gateway lost-redelivery` 名下,该文件无任何过期用例(真实覆盖在 M2 `acl-core.spec` L171-188 的网关侧 exp 剔除),归因失真。
- **建议**:落实 M1 API-1 原方案的两段式:`onOffer` 先置 `offered`+排 `'ttl'` 定时器,闸评估(含 M4 确认回调)到达后再 accept/reject,TTL 先到即 `reject(expired)`(「晚于」判定);session 的 `'ttl'` 分发分支已就位,机器恢复排程即可。补「补投 2×offer_ttl 的 project offer → reject(expired) 整批场景」用例;R-MATRIX R2 行按实际归属改写。此项与 API-2 的 Ingress 管线建议合并设计,避免二次动刀。

### API-9|major|回调覆写链不对称且不可组合:onEnvelope 无条件覆写、onRoutingDenied 链式+无谓 bind,宿主注入的处理器会被静默丢弃

- **位置**:`session.ts` L87(`opts.client.onEnvelope = (env) => this.onEnvelope(env)` 直接覆写;宿主经 `GatewayClientOptions.onEnvelope`(gateway-client.ts L16,文档化选项)注入的处理器无声消失)、L88-92(`onRoutingDenied` 却走链式,且 `opts.client.onRoutingDenied?.bind(opts.client)` 对实例字段函数 bind(client) 无意义);`gateway-client.ts` L39-43(回调即公开实例字段,构造器保证默认 noop,`?.` 恒真);两个 M3 测试被迫在构造后**再次**覆写 `client.onEnvelope`(cross-machine.spec L116-121、lost-redelivery.spec L101)才能插入录制逻辑——集成契约事实上是「谁最后覆写谁生效」。
- **问题**:同一 client 上两种回调两种语义:envelope 独占(覆写)、denied 累加(链式)。若一节点挂两个 session(如按任务分 session,见 API-13),denied 会广播给所有 session 而 envelope 只给最后一个——行为不可推理;`dispose()`(L314-319)不清回调,已废弃 session 仍接收信封并可能驱动已清空的定时器池。这是「回调覆写链是否易错」的实锤:测试为绕开它写的二次覆写代码就是未来每个宿主要交的学费。
- **建议**:client 改显式订阅 API(`on(fn)/off(fn)` 或 handlers 数组),session 构造时订阅、dispose 时退订;过渡方案:session 保存 prev 并对 onEnvelope 也链式(与 denied 对齐),TSDoc 钉死「单 client 单 session」约束并在二次绑定时显式报错。两个测试文件的二次覆写即可删除,作为重构的验证。

### API-10|major|走查剧本与验收/矩阵的映射失真:W3 推迟与 IMPL_PLAN M3.2「A3 过」矛盾、W1 在线态无承载、「A5」同码双义

- **位置**:`docs/testing/WALKTHROUGH-2NODE.md` L4(「运行形态:registry(HTTP)+gateway(ws)+两个 qlong 节点进程」)、L19-25(W1–W10)、L32-35(当前状态:W3→M4、W1/W5 标 ✅);`QLONG_IMPL_PLAN.md` L68(M3.2 验收=「**A3**/A4/A5 过」);`cross-machine.spec.ts` L171-184(「A1 跨机负向」测试名指 02 ACL A1)、L186(「A5 防御兜底」指 02 ACL A5);`docs/testing/R-MATRIX.md` L12(R2 行)。
- **问题**:①**W3(A3)推迟 M4 与里程碑验收直接矛盾**:IMPL_PLAN 把 A3(acceptance_results→`cancel(acceptance_failed)+attempt+1`)划给 M3.2,且机器/会话已具备全部链路(`validateAcceptance` 选项、lead L228-239 验收失败归途),跨机 A3 用例缺席不是能力问题而是映射改写——走查文档无权单方面下调里程碑验收,按实现计划 §5 应走文档回写或补用例;②**W1 的「通讯录互见(online=true)」无承载**:presence 回写(M2-08,遗留 P1「随 M3 批次处理」)在 `ws.ts` 仍无任何落点(`WsGatewayOptions` 无 onPresence,`core.connect/disconnect` 无事件出口),caps 上报属 M4,W1 标 ✅ 的依据是 registry 单测里手工注入 presence 的绕行路径,两个 M3 spec 均不查目录;③**「A5」双义**:IMPL_PLAN 验收 A5=重放/exp 拒绝,cross-machine 的「A5 防御兜底」=02 ACL A5,walkthrough「W5 已覆盖 ✅」依赖这一歧义——M3 两个 spec 里没有验收 A5 的对应用例(网关侧 exp 剔除在 M2 acl-core,节点侧 R1 去重见 API-2 缺口);④**运行形态描述失真**:实态是单进程 + `registry.enroll()` 直连对象 + 测试自搭 `setInterval(…, 20)` 同步(cross-machine L71-72/L97),「两个节点进程、registry(HTTP)」并不存在,M2-17 的跨进程缝仍以「测试代管集成」方式存在。
- **建议**:W3 要么补跨机 A3 用例(推荐:链路现成,一条用例的事)要么走文档回写把 A3 移入 M4 并同步修订 IMPL_PLAN;W1 拆注「目录可见 ✅ / online 态 🔲(presence 回写契约)」;walkthrough 为每个 W 步骤标注「验收 A 编号 vs ACL 规则编号」消歧;「运行形态」改为如实描述并注明生产装配(host 负责 enroll 后立即同步 + 周期推送)仍缺一个可复用组件。

### API-11|minor|seal() 丢弃 `reply_to`、`hops` 钉 0、转派 trace 无参数位:§4.5/§7 字段在唯一出站装配点没有位置

- **位置**:`session.ts` L267-285(seal 的 base 无 `reply_to`;L277-279 `hops: 0` 硬编码)、L170(`processExec` 显式挑选 `{type,to_node,task_id,attempt,body}`,把机器已装配的 `reply_to` 丢弃——对照 `executor/machine.ts` L214(`outFor` 明确回填 `reply_to = o.msg_id`)、L111;`session.ts` L110(`startLeadTask` 一律 `newTraceContext(this.nodeId)`,无 trace/parent_span 入参)。
- **问题**:01 §4.5(I-57)逐类型规定 reply_to 指向,§3.1 说明「缺失不构成协议错误」——所以这不是协议违反,但机器层特意装配的排障字段被传输层静默吞掉,`task.accept/result/… → reply_to=offer.msg_id` 的关联在 M3 出站信封上全部为空,§11 的 msg_id 关联少一条现成线索;`hops:0` 对单回程无害,但转派链(B 收 A 单再派 C)下 C 的回程 hops 与链上深度不符且无从表达;转派场景 `startLeadTask` 新建 trace——trace_id 断裂、`origin_node` 伪报为本机、`parent_span` 无处传,直接违反 01 §7.2/7.3(「trace 三元组原样透传,不得改写」「转派时 parent_span=上游 msg_id」)。R-MATRIX L22「trace 透传(session seal)✅」仅对执行方回程成立,转派侧未支持也未注明。接口现在冻结,转派(哪怕 v0.2)就要破坏性改签名。
- **建议**:seal 透传 `reply_to`(随 API-12 的类型收敛自然获得);`startLeadTask` 增加可选 `{ trace?, parentSpan?, hops? }`(缺省=新建,转派由调用方传入上游值);R-MATRIX §7 行注明「转派透传未支持(🔲)」。

### API-12|minor|`OutboundSpec` 与 `wire.Outbound` 近乎重复:三套出站类型的收敛位被错过

- **位置**:`session.ts` L49-55(本地 `OutboundSpec` = `wire.Outbound` 去掉 `reply_to` 的子集重声明);`wire.ts` L1-9(头注「完整信封装配与签名由传输层完成,M2/M3」——M3 正是履约批次);`session.ts` L132(`processLead` 直接把机器的 `Outbound` 传给形参为 `OutboundSpec` 的 seal,靠结构相容)。
- **问题**:M0 时代留给 M3 的收敛点(Outbound → 完整信封),M3 却新造第三个类型:机器动作里的 msg 本就是 `Outbound`,seal 只读其中五个字段、`reply_to` 因此「顺理成章」地没有位置(API-11 的根因之一)。`OutboundSpec/Outbound/EnvelopeV1` 三套形状并存,下一个消费方(CLI、转派层、M4 档案)将无所适从——这正是 M1 API-4/M2-20 反复要求的「传输适配层装配契约」没有定型的表现。
- **建议**:删除 `OutboundSpec`,`seal(out: Outbound, trace)`;seal 消费 `reply_to` 并参数化 `hops/trace`(见 API-11);wire.ts 头注改为「本类型即传输装配的唯一入参」。

### API-13|minor|「一 session 一 lead 任务(终身)」形状未声明:二次 `startLeadTask` 会把新任务的 body 塞给旧机器

- **位置**:`session.ts` L60(`lead?` 单数)、L101-113(`if (!this.lead)` 才创建;lead 已存在时 `startLeadTask(TASK2,…)` 会写 TASK2 的 traces/lastOfferBody,却对 TASK1 的机器调 `dispatchTo`——终态机器静默返回 [](新任务无声不启动),drafting 机器(等待改派中)则用 TASK2 的 body 派 TASK1 的单,跨任务 body 错配);`executor/machine.ts` L141-145(执行位单槽 busy 是显式裁决,v1 单执行位有文档,lead 侧单任务无任何声明/守卫)。
- **问题**:一个节点先后/同时牵头两个任务是最基本的运行诉求;当前接口下「换任务」的正确姿势(new 一个 session)又被 API-9 的覆写语义堵死(旧 session 的 exec 机从此收不到入站)。这不是 M3 验收路径上的故障(剧本单任务),但接口形状正在被两个 e2e 冻结成「节点=单任务进程」,M4 的能力上报/负载快照(queue_depth 含多任务)一到位就撞墙。
- **建议**:短期:lead 已存在时 `startLeadTask` 直接 throw(显式失败优于静默错配),TSDoc 声明「一 session 一 lead 任务、一 client 一 session」;中期:lead 按 task_id 的 Map + `onEnvelope` 按 `env.task_id` 分发(与 API-3 的分发重整一并设计)。

### API-14|minor|`deliver()` 吞错注释依赖「R11 重发兜底」,但缺省 outbox 非持久、无周期重发——M2-09 遗留在 M3 接缝上仍未闭合

- **位置**:`session.ts` L287-293(catch 空,注释「outbox 保留,R11 重发兜底」);`outbox.ts` L16-34(唯一实现 MemoryOutbox;`attempts` 递增但无消费方,`lastAt` 恒 0);`gateway-client.ts` L112(`send` 对**一切类型**无条件入 outbox,含 `task.progress`)、L124-130(flush 仅 auth_ok 触发,无周期定时器/退避——连接存活但 safeSend 静默失败的消息本次连接内永不重试)。
- **问题**:M2-09(FileOutbox 持久化、周期退避重发)被 M2 报告列为「随 M3 接线批次处理」,M3 未交付,而 M3 会话的可靠性注释恰恰建立在这半成品上:进程重启 → result/fail/cancel(outbox 中)蒸发,R11「关键消息本地持久化」落空;附带一笔:`progress` 也被持久化重发,断线重连后一批过期心跳将按「每条均处理」灌回牵头方续租(R1 的 progress 豁免+`seq` 乱序丢弃在 lead 侧未消费,`lead/machine.ts` L219-227 对任何 progress 续租),把误判窗口进一步拉长。缺省行为有风险且未在接口上声明。
- **建议**:本批至少交付 FileOutbox(复用 `lead/store.ts` 的 tmp+rename 先例)+周期 flush 定时器;或将「缺省内存 outbox 仅限测试」写进 `OutboxStore`/session TSDoc 与部署注记,把缺口显性化;`send` 入 outbox 前按 R11 关键消息白名单过滤(至少排除 progress 的持久重发,或重发前按 seq/时效剪枝)。

### API-15|nit|测试与杂项:诊断输出残留、token 拼接+as 断言、下标猜位、index.ts 重复导出且 M3 主交付物未导出

- **位置与问题**:①`session.ts` L131/L132(lead 路径打出标签 `'[exec send]'` 的 console.log,且 catch 后 console.log——生产会话不应有 stdout 副作用);②`cross-machine.spec.ts` L159-162、`lost-redelivery.spec.ts` L159(DIAG console.log 残留);③`cross-machine.spec.ts` L75-76(`tokenY` 连续两次签发,第一次死赋值)、L93-94 与 `lost-redelivery.spec.ts` L77-80(`{ ['to'+'ken']: token, … } as Parameters<…>` 字符串拼接+类型断言绕形状,直接写字面量即可);④`lost-redelivery.spec.ts` L155(`clients[clients.length - 2]` 下标猜位,注释自认脆弱——让 enroll 返回句柄);⑤`node/src/index.ts` L4/L6 重复导出 `executor/driver.js`、L9/L11 重复导出 `local/harness.js`,而 M3 主交付物 `remote/session.ts` **不在包公共 API**(两个 spec 不得不深引 `'../../node/src/remote/session.js'`)——M1 API-7/M2-30 的包边界问题第三次重现,且这次落在旗舰模块上。
- **建议**:清理 ①-④;`index.ts` 补 `export * from './remote/session.js'`、去重,测试改从 `@qlong/node` 导入。

## 亮点

1. **出站装配有闸**:seal() 统一走 `validateEnvelope(allowMissingSig) → signEnvelope`(session.ts L267-285),出站形状问题在发送前抛错而非上线才爆——M1 API-4 要求的「传输层装配位」以最小形态落地了出站半边。
2. **R4 顺序在真实时序上成立且被端到端钉住**:先 cancel 后新 offer 跨越真实 drain 窗口(lost-redelivery 全程真实 setTimeout),`acceptedFailedBudget=1`、attempt=2、`audits` 含 reclaim、B 的 cancel 入收件箱四条断言把 M1 虚拟时钟矩阵的关键转移第一次接上了真实网关,断言粒度是对着 R7/R4 条款写的。
3. **exp 闸在执行方入口落地**(machine L136-140,D24 + 补投死单拒收),并把 `exp` 作为 `onOffer` 显式入参——会话→机器的参数面为新鲜性留了位置(M1 API-1 裁决的兑现,虽然 R2 body TTL 仍缺,见 API-8)。
4. **回声分级语义在会话层守住了**:A5 防御兜底静默计数不回声(cross-machine L186-205),A1 跨队负向断言「routing.denied 只到发送方、B 无感知」(L171-184),与 02 A6 的执法口径一致。
5. **ScriptStubDriver 的数组剧本**(`startedCount` 顺序消费,driver.ts L41-75)让「第一次失败、改派后成功」类剧本可表达;`FAST_PARAMS` 全参数缩时证明状态机参数面(01 §10)完整可注入,没有隐藏常量。
6. **定时器卫生良好**:arm/disarm 幂等、三池 dispose 统一清理(session.ts L295-319),lead 续租「先 cancelTimers 再 schedule」的 M1-DIST-1 修法在真实定时器下未回归。

## 开放问题(建议委员会路由)

- **Q1 回执→机器输入的规范通道**:`SendReceipt`(deliver 返回值)与 per-msg `onAck`(带 msg_id)二选一还是并用?与 M2 遗留的回执终局性 Q1(routing.denied/rejected 分级)一并裁,统一「回执语义表」后 API-1/API-14 才有唯一锚点。
- **Q2 入站管线(Ingress)的组件归属**:验签(A4)/DedupStore(R1)/exp(R2、D24)/team 复核(A5)是内联进 session 还是独立组件供 harness/session 共用?它同时是 M4 闸5 异步接单模型(M1 开放问题 Q1)与 offered 驻留(API-8)的承载物,建议立 M4.0 前置小包一次定形。
- **Q3 多任务/多会话形状**:一节点多个 lead 任务的承载单元(session 池 vs lead Map + task_id 分发)与 client 回调组合语义(API-9/API-13);涉及 M4 负载快照(queue_depth)的定义域,建议随 M4.1 定。
- **Q4 目标选择的缺省策略归属**:R8 排除的缺省消费放 session 内置 picker 还是上移应用?与 M4 的节点-能力记忆/软降权(03 §7)同场设计,避免两套排除语义。
- **Q5 R2 body TTL 的判定锚定**:收件箱补投场景「晚于 TTL」以何时刻为基准(信封携带派发时刻 vs 网关回填路由时刻)?M1 评审开放问题 Q2 的遗留,补「批量过期」必测场景前需设计侧一句话。
- **Q6 W3(A3)的里程碑归属**:按 IMPL_PLAN 补跨机用例,还是走文档回写移入 M4?(API-10①)属实现计划 §5 的偏离回写程序问题,建议随本批修订一并定案。

---
*评审人角色:接口与集成缝评审。本文件为委员会汇总输入之一;除本文件外未创建/修改/删除任何文件。*
