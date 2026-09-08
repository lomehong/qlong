# M3 评审意见:分布式语义与一致性(DIST)

> 评审对象:M3「双机真实传输闭环」——`packages/node/src/remote/session.ts`、`packages/gateway/test/cross-machine.spec.ts`、`packages/gateway/test/lost-redelivery.spec.ts`,并核对被接线的两台状态机(`lead/machine.ts`、`executor/machine.ts`)、传输件(`gateway-client.ts`、`outbox.ts`、`driver.ts`)与网关适配(`gateway/src/ws.ts`、`core.ts`、`acl.ts`)。
> 对照基线:`QLONG_DESIGN_01_MSG_PROTOCOL.md`(下称 01)、`QLONG_DESIGN_02_REGISTRY_TRUST.md`(下称 02)、`QLONG_DESIGN_03_CAPABILITY.md`(下称 03)、`QLONG_IMPL_PLAN.md`、`docs/testing/WALKTHROUGH-2NODE.md`、`docs/testing/R-MATRIX.md`;并对照 `docs/review-m1/`、`docs/review-m2/` 已决事项(M1/M2 已决不重复,已决未修且被 M3 激活的点只补增量证据)。
> 评审视角:RemoteNodeSession 接线的语义完整性(Outbound→信封字段、trace 透传/新建、入站分派完备性)、lost/改派演练时序与 R3/R4/R7/R8 对照、真实 setTimeout 定时器管理、enroll 后同步+20ms 推送的竞态窗口。其余视角(安全/接口/架构/测试)归队友。行号以本次评审时点文件内容为准。

## 结论(verdict)

**需重大修订。**

M3 的主干语义在真实时序下首次成立:lost 判定→cancel 入真实收件箱→drain→attempt+1 改派→R7 双预算记账,端到端有真实断言,R4「先撤销后改派」次序经真实传输保持有序,trace 透传/新建规则与 01 §7 一致。但**接线层存在 1 项 blocker**:R3 执行方对称计时器的核心机制「心跳获网关回执 → 续自身租约」在 RemoteNodeSession 中**根本没有接线**(`onHeartbeatAcked` 全仓无生产消费方),导致 M3 真实传输形态下**任何执行时长超过一个 lease 周期的远端任务必然走向「假暂停→永久停跳→被判 lost→循环改派→escalate」**——与 M1 DIST-1(blocker)同型,恰被 50ms 完成的桩驱动与 400ms 的测试租约错开掩盖。另有 4 项 major:startLeadTask 单 lead 槽无守卫(静默丢发/跨任务错配)、R2 执行方 offer_ttl 判定在真实补投链路上仍不可达(exp 闸不能替代)、R8 排除记录面缺失且 lost 演练硬编码绕开 excluded(R-矩阵 ✅ 失真)、入站缺 `unsupported_type` 兜底(违反 01 §8 禁止静默丢弃)。blocker 与 major 修毕并复验后方可收口。

## 摘要

- **blocker ×1**:执行方 R3 对称计时器断裂——`onHeartbeatAcked` 未接线 → `lease_self` 永不续期,健康长任务在 lease 到点被自暂停,且恢复路径(即使接线)也不重排心跳定时器,停跳必被牵头方判 lost(01 §6 R3 违反,长任务功能性不可完成)。
- **major ×4**:startLeadTask 复用单 lead 槽无守卫,终态复用静默丢发、drafting 窗口复用跨任务错配并重置 attempt(M1 问题 9 的守卫仍未落,session 层放大);R2 执行方 offer_ttl 过期判定不可达,`offered` 态仍是死状态,M3 真实收件箱补投会照单开跑超过 TTL 的死单;R8 lost/fail 路径不记排除表 + lost 演练 `pickTarget` 硬编码绕开 `excluded`,R-MATRIX「R8 ✅」账实不符;未知消息类型静默丢弃,无 `reject(unsupported_type)` 路径(01 §8「禁止静默丢弃」)。
- **minor ×7 / nit ×1**:reply_to 在 Outbound→信封转换被丢弃;stale_attempt 闭环三缝(lead 回弹隐式取消回执、task.reject 不分派执行方、onStaleReject 无归属校验);hops 超限被客户端校验静默丢弃(refused_loop 不可达);dispose 非粘性+终态残留不回收;驱动回调无 (task_id, attempt) 归属校验;A5 兜底无审计、审计调用缺 §11 关联字段;enroll 同步窗口无契约;nit 一束。

## 问题清单(按严重度排序)

---

### DIST-1|blocker|执行方 R3 对称计时器未接线:心跳回执无人消费,健康长任务 lease 到点必被自暂停并停跳至误判 lost

- **位置**:`packages/node/src/remote/session.ts` 全文(`GatewayClient.onAck` 仅在构造器接管了 `onRoutingDenied`,L88-92,**从未接管 `onAck`**;grep 证实 `onHeartbeatAcked` 的唯一生产调用方是单机环回 `local/harness.ts` L196/L234,session 中零调用);`packages/node/src/executor/machine.ts` L182-197(accept 时一次性排 `lease_self = now + offeredLease`,此后仅 `onHeartbeatAcked` L243-260 能续期)、L231-241(`onHeartbeatDue`:paused 时 `return []`,心跳定时器被消费后**不再重排**)、L247-254(恢复分支只 `resumeDriver` + 重排 `lease_self`,**不重排心跳**)。
- **问题**:R3 执行方侧的核心机制是「自**最后一条成功送达(获网关 ACK)**的心跳起算 `lease_ms`」(01 §6 R3),它依赖 ack → `onHeartbeatAcked` → 续 `lease_self` 这条链。M3 会话没有接这条链:`lease_self` 在 accept 时刻一次定格,永不续期。推演真实形态(默认参数 lease=300s,心跳 100s):t=0 accept 并开跑;心跳 t=100/200s 正常发出且获网关 `delivered` 回执(client L156-166 收到 ack 后只清 outbox、调默认空 onAck);t=300s `onLeaseSelfTimeout` 触发 → `paused=true` → 暂停驱动;此后 `onHeartbeatDue` 因 paused 直接返回且**不重排心跳** → 心跳链永久断裂;牵头方在最后一个死线(≈200s+lostAfterMs)判 lost → R4 回收改派;新执行方重复同一时序 → 循环烧尽 `max_attempts` → escalate。**即 M3 真实传输形态下,任何执行超过一个 lease 周期的远端任务必然失败**——与 M1 DIST-1(blocker,心跳续租定时器泄漏)同型:主干测试全绿只因桩驱动 50ms 完成 ≪ 测试租约 400ms,两个时标错开把缺陷完全藏住。第二层:即便将来把 ack 接上,M1 修复的 paused→resume 路径(`onHeartbeatAcked` L247-254)只恢复驱动与 `lease_self`、不重排心跳定时器,恢复后的任务同样停跳至误判 lost——该缺陷在 M3 被第一层掩盖(恢复路径不可达),接线修复时必须一并修。
- **依据**:01 §6 R3(执行方对称计时器、不变式锚点、「无法发出心跳持续超过 grace_ms 亦暂停」的对称性);01 §5.3 正常时序(心跳 ≈lease/3 周期续跑);M1 评审问题 18 的修复意图(paused 恢复路径);`QLONG_IMPL_PLAN.md` M3「把状态机接到真实网关传输」的交付定义。
- **建议**:① session 构造器接管 `client.onAck`:按 `msg_id` 识别在途 progress(维护待确认 progress msg_id 集,或由 core 在 ack 帧回带消息类型提示),命中才调 `exec.onHeartbeatAcked(now)`(accept/result 等 ack 不应续租);② `onHeartbeatAcked` 的 paused 恢复分支补 `{kind:'schedule', timer:'heartbeat', atMs: now+hb}`;③ 补真实时序回归:驱动时长 = 2.5×lease、心跳正常送达,断言 `attempt===1`、无 `reclaim` 审计、无 paused;再补「lease_self 误触发 → ack 恢复 → 心跳恢复」的恢复链用例。

---

### DIST-2|major|startLeadTask 复用单 lead 槽无守卫:终态复用静默丢发,drafting 窗口复用跨任务错配并重置 attempt

- **位置**:`packages/node/src/remote/session.ts` L101-113(`if (!this.lead) { new LeadTaskMachine(...) }` 之后无条件 `traces.set`/`lastOfferBody.set` 并对该(可能是旧的)机器调 `dispatchTo`);`packages/node/src/lead/machine.ts` L127-143(`dispatchTo` 仅守卫 `state!=='drafting'`,随后**无条件 `this.rec.attempt = 1`**,M1 问题 9 要求的 `attempt !== 0` 守卫至今未落);对照 `executor/machine.ts` L141-146(执行方单执行位已有 busy 守卫,M1 P0 修)。
- **问题**:`LeadTaskMachine` 是「每个 task_id 一份」(01 §5.1),而 RemoteNodeSession 只有一个 `lead` 槽且 `startLeadTask` 无任何 task 归属校验。两个后果:① **静默丢发**——上一个任务终态后再 `startLeadTask(task2)`,复用的旧机器 `terminal=true`,`dispatchTo` 返回 `[]`,task2 的派发无声消失(无异常、无审计、`onTerminal` 永不触发),调用方无从感知;② **跨任务错配**——旧任务处于 drafting 改派间隙(`budgetOrEscalate` L401 置 drafting 等待 `requestDispatch`)时调用 `startLeadTask(task2, target2, body2)`,`dispatchTo` 在旧机器上成功执行:发出的是**旧 task_id + attempt=1 + task2 的 body/目标**的信封——attempt 高水位被重置(M1 问题 9/M1 DIST-5 的 fencing 破坏在 session 层被放大),且两个任务的载荷互相污染。串行跑第二个任务是 M3 运行形态的必然用法,不是边角。
- **依据**:01 §5.1(状态机按 task_id 一份)、01 §3.1(attempt 执行权纪元单调);M1 评审问题 5/9(接管 fencing,已决未修);IMPL_PLAN §5(实现偏离不静默)。
- **建议**:① 最小守卫:`startLeadTask` 在 `this.lead && this.lead.task_id !== taskId` 时抛错或审计+忽略(与 `cancelLead` L121-123 的归属校验对齐);② 正解:`lead` 改 `Map<task_id, LeadTaskMachine>`,入站按 `env.task_id` 路由(执行方侧 M1 已决的单槽/多槽模型一并对表);③ `dispatchTo` 补 `attempt !== 0` 守卫(M1 P1 遗留,顺手关闭);④ 补用例:同 session 串行两个 lead 任务均能 done;drafting 窗口内新任务不串任务号。

---

### DIST-3|major|R2 执行方 offer_ttl 判定在双机真实链路仍不可达:exp 闸(小时级)不能替代 TTL 闸(分钟级),真实收件箱补投会照单开跑死单

- **位置**:`packages/node/src/executor/machine.ts` L91-148(`onOffer` 仅有信封 exp 闸 L137-140;`evaluateOffer` 过闸后**同步置 running**,从不进入 `offered`、从不排 ttl 定时器);L218-228(`onTtlCheck` 要求 `state==='offered'`——grep 证实**无任何生产路径赋值 `state='offered'`**,M1 blocker #1 的死状态原样保留);`packages/gateway/src/ws.ts` L100-104(M2-02 修复后,重连即补投收件箱——过期死单的投送通道在 M3 已真实存在);`docs/testing/R-MATRIX.md` L12(R2 行 ✅,注「gateway lost-redelivery 过期链路」——实为牵头方侧 offer_ttl 到期,非执行方侧判定)。
- **问题**:01 R2 明文「执行方按 R2 独立判过期」+ 必测场景「长期离线节点上线后收件箱批量过期 offer → 整批 `reject(expired)`」。现状:执行方唯一过期闸是信封 `exp`(地平线 `exp_horizon` 缺省 24h,测试 1h),而 `offer_ttl_ms` 是 60s(project)/10s(aid)量级——离线 2 小时的 offer:`exp` 有效 → 过闸 → accept + **startDriver 真实开跑**(真实基座下是真实的会话启动与副作用),僵尸任务只能等同批/迟到的 cancel 兜住(P4 不保序,兜底不保证及时),且以「accept」而非「reject(expired)」回填,牵头方的 R8「expired 换目标」信号失真。M1 blocker #1 的 P0 修复记录写的是「执行方 exp 过期守卫(API-1)」——以 exp 闸替代了评审要求的「TTL 闸或两段式 offered 驻留」,该口径收窄未见任何设计回写(01/02 文本未改),而 M3 的真实补投链路恰好把这条被替代的路径激活成常态路径。
- **依据**:01 §6 R2 + 必测场景;02 §8(离线暂存 + 端上独立判过期);IMPL_PLAN §5(偏离一律回写设计);M1 报告 blocker #1 与修订记录。
- **建议**:二选一并落文档:① `evaluateOffer` 入口补 TTL 闸:`now > 收到时刻 + offer_ttl_ms`(「晚于」判向,I-38)→ `reject(expired)`,与 exp 闸并存——改动最小,推荐;② 若委员会确认「执行方过期判定 = 信封 exp」的口径收窄,按 IMPL_PLAN §5 回写 01 R2 并同步改 R-MATRIX R2 行的 ✅ 注记。补「补投过期 offer → reject(expired) → 牵头方换目标」端到端用例。

---

### DIST-4|major|R8 排除记录面缺失:lost/fail 路径不记 `excluded`,lost 演练用硬编码绕开排除表,R-MATRIX「R8 ✅」账实不符

- **位置**:`packages/node/src/lead/machine.ts`(`applyExclusion` L405-416 的唯一调用点是 reject 分支 L210;lost 路径 L317-327 与 `task.fail` 路径 L241-254 均只 `beginReclaim`,不记排除——M1 DIST-4 ① 的缺口原样存活);`packages/gateway/test/lost-redelivery.spec.ts` L136-142(`pickTarget` 显式 `void excluded`,按 `nextAttempt` 硬编码切换目标——L136 注释「R8:改派目标选择 —— B 被排除后选 C」与实际机制不符);`docs/testing/R-MATRIX.md` L18(「R8 改派排除 | lead excluded 表 + lost-redelivery 排除后选 C | ✅」)。
- **问题**:三层。① 语义层:判 lost 的节点按 R8「排除按 R4 取消衔接处理」至少应记 `once`,`fail(retryable)`(如 `internal_error`,§4.3「同节点最多一次」)同样应记——当前都不记,真实部署里读 `rec.excluded` 选目标的 `pickTarget` 实现会在 lost 后**再次选中 B**(B 可能仍在线,只是心跳抖动),「改派」退化为本节点重试;② 验证层:演练宣称验证 R8,实际把排除逻辑放在测试闭包里硬编码,`excluded` 参数被 `void` 丢弃——端到端没有任何一处断言排除表被写入或被消费;③ 账实层:R-MATRIX 据此标 ✅,追溯账本再次失真(M1 问题 28、M2-29 同款问题第三次出现)。
- **依据**:01 §6 R8(「判 lost 节点的排除按 R4 取消衔接处理」「其余瞬时 retryable 仅排除一次」);01 §4.3 fail 码表;M1 DIST-4(记录面缺失,已决,P2 项至今未落);IMPL_PLAN §5。
- **建议**:① `onTimer('lease')` lost 分支与 `task.fail(retryable)` 分支落 `excluded[target]='once'`(验收失败归途不排除,保持可回原节点);② lost-redelivery 演练改为断言 `sessionA.lead?.rec.excluded[execB] === 'once'`,且 `pickTarget` 真实消费 `excluded`(排除 B 后选 C),删除 nextAttempt 硬编码;③ R-MATRIX R8 行按实际覆盖改写(「记录/消费」两半都落地前不得标 ✅)。

---

### DIST-5|major|入站分派缺 `unsupported_type` 兜底:未知类型静默丢弃,违反 01 §8「禁止静默丢弃」

- **位置**:`packages/node/src/remote/session.ts` L227-261(`onEnvelope` 三路分派:`task.offer`/`task.cancel` → 执行方;其余 → `if (this.lead)` 透传;两台状态机对未知 type 的最终归宿都是 `return []`/`default: return []`——`lead/machine.ts` L189、executor 侧无对应分支;session 亦无尾部兜底)。
- **问题**:01 §8:「收到未知 `type` → 回 `reject(unsupported_type)`(验签+同 team 复核之后)……**禁止静默丢弃**」。当前接线里,一个未来版本新增的类型(如 v1.1 的 `task.notify`)或本实现未覆盖的 `rpc.*` 类型到达节点后无声消失:发送方拿不到任何回执,只能等超时——版本演进期两端行为分叉时,这正是 §8 要求用 NACK 暴露差异的场景。M3 把入站分派做成 session 的职责(头注 L4「入站信封 → A5 复核 → 分发」),兜底缺失属于本次交付的接线缺口而非状态机缺口。触发面是版本演进期而非今天,故 major 而非 blocker。
- **依据**:01 §8(演进规则)、§4.3(`unsupported_type` 双向)、§3.3.4(回执须排在验签+同 team 复核之后——session L229-236 的 A5 复核恰是该前置,位置正确)。
- **建议**:`onEnvelope` 尾部(A5 复核之后)对未知 type 回 `task.reject(unsupported_type, {supported_v:[1,1]})`(经 `seal` 签名发出)+ 审计;已知族内未实现的具体类型(如 `rpc.ask`)至少记审计(是否实现 rpc 属范围决策,应显式声明而非静默);补「未知 type → 收到 unsupported_type 回执」用例。

---

### DIST-6|minor|reply_to 在 Outbound→信封转换中被丢弃:状态机装配的 §4.5 消息级关联到不了线上

- **位置**:`packages/node/src/remote/session.ts` L49-55(`OutboundSpec` 无 `reply_to` 字段)、L170(`processExec` 的 send 分支**逐字段重建** `{type, to_node, task_id, attempt, body}`,显式丢掉 `a.msg.reply_to`)、L128-132(`processLead` 把含 `reply_to` 的 `Outbound` 整体传入 `seal`,但 `seal` L267-285 装配 `base` 时不取该字段);`packages/node/src/wire.ts` L2-9(`Outbound` 已定义 `reply_to`);`packages/node/src/executor/machine.ts` L207-216(`outFor` 为 accept/reject 装配 `reply_to = offer.msg_id`——被 session 丢弃)。
- **问题**:M1 问题 14 按建议给 `Outbound` 补了 reply_to 装配位,执行方 accept/reject 也确实填了;M3 的 `seal` 转换却把它丢掉——同一段链路上「装配了 → 传输时丢弃」,属于接线语义不完整。影响有界:01 §3.1 明文「`reply_to` 缺失不构成协议错误」,任务级关联以 `(task_id, attempt)` 为准;但 §4.5 的排障用途(W8 日志还原的关联辅助)在双机链路上整体失效。另注意 progress/result/fail 的 reply_to(应指向 offer msg_id,§4.5)在状态机侧也未装配(`out()` 调用点均不传 replyTo)——两层都补齐才算闭环。
- **依据**:01 §3.1(`reply_to` 字段表)、§4.5(逐类型规则);M1 评审问题 14(接口元数据缺位,部分修复)。
- **建议**:`OutboundSpec` 补 `reply_to?` 并在 `seal` 的 `base` 中透传(`validateEnvelope` 已校验 uuid,L114);`processExec` 重建对象改为透传 `a.msg.reply_to`;executor 侧为 progress/result/fail 补 `reply_to = rec.msg_id`。补一条「accept.reply_to === offer.msg_id」的线上断言。

---

### DIST-7|minor|stale_attempt 闭环三处未闭合:lead 回弹隐式取消回执、task.reject 不分派执行方、onStaleReject 无归属校验

- **位置**:① `packages/node/src/lead/machine.ts` L169-177(入站 `attempt < current` 一律回 `reject(stale_attempt)` + `stale_attempt_rejected` 审计——不区分「迟到旧消息」与「执行方对隐式取消的回执」);`packages/node/src/executor/machine.ts` L115-133(R0③ 隐式取消回执携带**旧 attempt** 发出);② `packages/node/src/remote/session.ts` L259-261(`task.reject` 落入 lead 分支;执行方 session 无 lead → 静默丢弃,`onStaleReject` 在 M3 接线中不可达);③ `packages/node/src/executor/machine.ts` L336-344(`onStaleReject()` 无参——M1 问题 20 要求的 (task_id, attempt) 归属校验未落,凡 running/offered 一律停驱动清理)。
- **问题**:改派回原节点(B 持旧 attempt=1 在途,lead 改派 attempt=2 给 B)时:B 按 R0③ 回 `reject(stale_attempt, attempt=1)` 作为「旧态已终止」的回执,再评估新 offer;lead 收到后按「attempt < current」机械弹回又一个 `reject(stale_attempt)` 并记一次 `stale_attempt_rejected` 审计——01 §4.3 对 stale_attempt 的双向注记(「执行→牵头:旧 attempt 隐式取消回执,R0 特别则」)在 lead 侧没有实现,回执被当违规处置:多一跳无谓消息 + A8 链路还原里出现伪造的「拒收」事件。同时,执行方侧收到 lead 的 stale_attempt 拒收(如迟到 result 被拒)本应触发 §5.2 的「本地记账/清理 → 终态」(旧 attempt 的驱动残留靠它兜底收口),M3 接线把它静默丢弃,`onStaleReject` 成死代码;且该方法本身无归属校验,一旦未来有人接上线,就是 M1 问题 20 的「回弹杀伤新 attempt」原样复发。
- **依据**:01 §6 R0(特别则)、§4.3(stale_attempt 方向约束)、§5.2(执行方收 reject(stale_attempt) 的清理转移);M1 评审问题 20。
- **建议**:① lead 对「`task.reject` 且 `reason_code==='stale_attempt'` 且 attempt < current」按回执消化(仅审计 `reason:'implicit_cancel_receipt'`,不回弹);② session 将 stale_attempt 类入站 `task.reject` 分派给执行方 `onStaleReject`;③ `onStaleReject` 补 `(task_id, attempt)` 入参,仅与当前记录一致才清理,否则忽略+审计;④ 补「改派回原节点」端到端用例(现演练只改派给 C,该路径零覆盖)。

---

### DIST-8|minor|hops 超限在客户端校验层被静默丢弃:`reject(refused_loop)` 与 R8 永久排除不可达

- **位置**:`packages/core/src/envelope.ts` L149-154(`hops > maxHops` 按结构错误判非法);`packages/node/src/gateway-client.ts` L181-185(入站 `validateEnvelope` 不过 → `rejectedInbound += 1` 静默丢弃);01 §7.1(「收到 `hops > MAX_HOPS` 的 offer → `reject(refused_loop)`」)、§4.3(`refused_loop` 持久失败,R8 要求本 task 生命周期永久排除该节点)。
- **问题**:设计把 hops 超限定为**可回应的语义拒绝**(执行方拒单并附码,牵头方据此永久排除该节点、换路改派);实现把同一信封挡在结构校验层静默丢弃——牵头方只能等 offer_ttl 超时按 `expired` 处理,环上节点既得不到 `refused_loop`、进不了 `excluded[permanent]`,委托深度的防护从「快速失败+绕行」退化为「超时+重试」。M3 单跳(hops 恒 0)不触发,属多跳/转派批次的前置地雷;按「缺省行为有风险应指出」记录。
- **依据**:01 §7.1、§4.3、R8;`QLONG_IMPL_PLAN.md` §7 委托链条款。
- **建议**:入站校验对「仅 hops 超限」的信封走语义分支:先单独预检 hops(或在结构校验中豁免该项),命中即回 `reject(refused_loop)` + 审计,再进入常规校验/分派;多跳批次落地前补单测锁定。

---

### DIST-9|minor|dispose 非粘性:disposed 后入站信封仍可再武装定时器、驱动回调仍可发消息;终态任务的 traces/lastOfferBody 永不回收

- **位置**:`packages/node/src/remote/session.ts` L314-319(`dispose` 仅清三个定时器池,不设标志、不解绑 `client.onEnvelope`、不 `driver.stop()`);L190-197/L295-303(disposed 后任何入站信封驱动的 `schedule` 动作会向已清空的池**重新插入**定时器);L67-71(`traces`/`lastOfferBody` 两个 Map 终态后不清理,`dispose` 也不清)。
- **问题**:三处。① `dispose` 后会话并未真正停机:测试的 afterAll 先 `dispose` 再 `client.close`,窗口期内到达的信封(网关补投、重发)照常驱动状态机并重新排定时器——「优雅停机」承诺不成立;真实节点的运行态重载同样踩中。② 驱动未停:`stopDriver` 只在状态机动作中触发,dispose 不调 `driver.stop()`,桩驱动的挂起回调在 dispose 后触发仍会走 `complete → 发消息`。③ 内存面:每个任务在 `traces`(键 `taskId` 与 `exec:taskId`)与 `lastOfferBody` 各留一条永久记录,offer body 可含内联 payload(上限 `MAX_BODY_INLINE` 256KB)——长期运行节点线性泄漏。
- **依据**:session L313 自述「优雅停机」;01 §4.2(offer body 体量上限);IMPL_PLAN M3(运行形态)。
- **建议**:`dispose` 置 `disposed=true`(入站早退+计数审计)、调 `this.opts.driver?.stop()`;终态回调(`terminal` 动作处)清理 `traces`/`lastOfferBody` 对应键;补「dispose 后入站不驱动、驱动完成不外发」用例。

---

### DIST-10|minor|DriverHost.complete/fail 无 (task_id, attempt) 归属校验:迟到的驱动回调会以新 attempt 身份发结果

- **位置**:`packages/node/src/remote/session.ts` L206-223(`driverHost` 闭包捕获旧 offer 的 trace/attempt,`complete`/`fail` 直通 `exec.onDriverCompleted/onDriverFailed`,不比对回调归属);`packages/node/src/executor/machine.ts` L273-297(状态机侧仅检 `paused/cancelReceived`——R0③ 隐式取消+重接单后 `rec` 已整体重置,自检全部失效);对照 `driver.ts` L63-74(桩驱动用 `stopped` 标志+cancelFn 兜住,真实基座接口无此保证)。
- **问题**:改派回原节点(R0③)或同任务重接时序里,旧 attempt 的驱动若在 `stop()` 后仍迟到回调(真实 deepseek-harness 会话型基座大概率如此,M1 问题 13 已认定「不可强杀」),`onDriverCompleted` 会把**旧 attempt 的结果体**以**当前 attempt** 发出(`out` 取 `rec.attempt`)——牵头方验收通过即 done,新 attempt 的执行被旧结果顶替,属跨 attempt 数据错配。当前被桩驱动的 stop 语义掩盖;真实基座适配属后续批次(不重复立项),但接缝归属校验是 M3 的 DriverHost 形状问题,现在补成本最低。
- **依据**:01 §3.1(attempt = 执行权纪元,结果必须按纪元配对)、R5(僵尸防护的本意)、R0;M1 评审问题 13(会话型基座适配)。
- **建议**:`driverHost` 闭包在 `complete/fail` 入口比对 `(task_id, attempt)` 与 `this.exec.rec.task_id/attempt`,不符 → 忽略+审计(`stale_driver_callback`);接口注释钉死「stop 后回调不作数」;真实基座适配批次复验此缝。

---

### DIST-11|minor|A5 兜底只计数无审计;session 审计调用缺 §11 关联字段——A8「仅凭日志还原链路」在节点半边缺料

- **位置**:`packages/node/src/remote/session.ts` L229-236(A5 复核失败仅 `rejectedInbound += 1`,无审计事件;02 §7 A5 要求「静默丢弃 + **审计**」)、L136/L175(`makeAudit(event, { node_id, reason }, ts)`——`onEnvelope` 上下文里现成的 `task_id/attempt/trace_id` 一概不传;01 §11「每条与任务相关的日志必须含 trace_id/task_id/attempt/msg_id,缺字段视为日志缺陷」)。
- **问题**:跨机防御兜底(A5)在节点侧零留痕,网关被绕过/直连场景(v1.5)下伪造探测不可观测;同时 session 是 M3 唯一同时握有信封头与审计出口的装配点,却继续产出「只有 event+node_id」的贫审计——WALKTHROUGH 自己把 W8(日志还原)列为「M3 收口核验」,当前节点侧审计字段不足以支撑该验收。
- **依据**:02 §7 A5;01 §11(审计 schema 与日志关联规范);IMPL_PLAN §1 A8;`docs/testing/WALKTHROUGH-2NODE.md` L35。
- **建议**:`onAudit` 上下文化:session 内统一注入 `task_id/attempt/trace_id/msg_id`(入站信封可得,出站动作亦可从 `a.msg` 取);A5 分支改记审计事件(复用 `to_mismatch`/`acl_rejected_cross_team` 的节点侧语义)+ 保留计数;W8 收口核验时以「双机日志拼出全生命周期」实测而非抽查。

---

### DIST-12|minor|enroll 后目录同步窗口无契约:两个 M3 剧本的同步时点互相矛盾,窗口内首消息仍可被 routing.denied 终局吞掉

- **位置**:`packages/gateway/test/cross-machine.spec.ts` L96-98(enroll 后、`client.open()` **前**同步);`packages/gateway/test/lost-redelivery.spec.ts` L102-103、L130(`client.open()` **后**才同步);两文件 L57-58/L71-72(20ms 全量轮询);`packages/node/src/gateway-client.ts` L167-177(`routing.denied` → `outbox.remove`,终局不重发——M2-06 的分级处置属「随 M3 接线批次处理」的遗留,本次未落地);`docs/testing/WALKTHROUGH-2NODE.md` L8(「目录同步 < 50ms」作为前提句,非机制)。
- **问题**:竞态窗口本体(目录快照滞后 → A1/A2 失败关闭 → `not_team_member`/`not_active` 误拒)M2-06/M2-17 已裁定并延期,不重复;M3 的增量问题是:**宣称的「enroll 后立即同步目录 + 20ms 定时推送」只存在于测试文件里**——同步调用由测试 Harness 手工发起,两个剧本一个在 open 前、一个在 open 后,说明「节点何时可被寻址/何时可发包」没有契约,全靠各剧本自行掐表。生产形态(注册中心与网关跨进程)下该窗口是真实的:入网后首封消息若撞上窗口,`routing.denied` 会按现行终局语义把消息从 outbox 永久删除,可靠性只剩上层 TTL 超时兜底。M3 交付以「测试内手工同步」代替了机制,却未在文档标注这是测试形态。
- **依据**:02 §7.1(bump 主动推送/落后即回源);01 §9(回执不参与可靠性,D26);M2 报告 M2-06/M2-17(P1 随 M3 批次);IMPL_PLAN M3.3(剧本即 e2e)。
- **建议**:① 短平快:把「enroll → 目录可见 → 才允许 open/发包」做成测试公共装配函数(两剧本共用一个时点),并在 ws.ts 头注标注「生产目录就绪契约待 M2-17 落地」;② 正解随 M2-06/M2-17 收口:`not_team_member/not_active` 保留 outbox + 触发重同步后有限重发;③ WALKTHROUGH 前置第 1 条从「目录同步 < 50ms」改为指明目录就绪的判定机制(如 auth_ok 前网关回源确认)。

---

### DIST-13|nit|装配兜底与调试残留三则

- **位置与问题**:
  1. `packages/node/src/remote/session.ts` L277-279:`seal` 对缺 `attempt` 的出站静默兜底 `?? 1`——机器装配缺陷(如在 idle 态误发)会被漂白成合法 attempt=1 通过 R0 闸,M1 问题 19 对同型 `??` 兜底的结论(删除、缺失即审计报错)应同样适用;
  2. `packages/node/src/remote/session.ts` L129-130:`processLead` 对查不到的 trace 静默 `newTraceContext` 兜底并回写 map——trace 断链被掩盖成「恰好可用」,新 trace_id 混入同一任务链会破坏 A8 还原;建议缺失即审计;
  3. `packages/node/src/remote/session.ts` L131-132:`console.log('[exec send]'…)` 调试输出残留在生产接线路径;`deliver` 的 catch(L290-292)静默吞错且无日志,R11 重发不可观测;`cross-machine.spec.ts` L75-76 `tokenY` 重复签发一次(无害,顺手清理)。
- **依据**:01 §11(日志关联与可观测性基线);M1 评审问题 19。
- **建议**:去兜底、去调试输出,`deliver` 失败补 debug 级日志(attempts 已在 outbox 条目上)。

---

## 亮点

- **lost/改派闭环第一次在真实时序下成立且有真实断言**:真实 setTimeout 判 lost(非虚拟时钟)、cancel 经真实网关入离线收件箱(`core.inbox.size` 断言)、drain 收口后 attempt+1 改派 C、`acceptedFailedBudget=1`(R7「已 accept 后失败」记账精确)、`reclaim` 审计在位——R3/R4/R7 主干在传输形态下经得起对照(lost-redelivery.spec L152-167)。
- **R4「先撤销、后改派」次序经真实传输保持有序**:cancel 由 `beginReclaim` 动作序先入通道,新 offer 由 drain 定时器收口后经 `requestDispatch→redispatchTo` 才发出,「僵尸入口对一切改派路径关闭」在跨机链路上成立。
- **trace 透传/新建规则正确**:发起侧 `newTraceContext`(`parent_span=null`,§7.3/I-43)、执行方原样透传入站 `env.trace`(§7.2),改派不换 `trace_id`,session 内 trace 键按任务隔离——M1 问题 14 要的 trace 管道在 M3 接线里落了地。
- **seal 出站构造与 §3.1 对齐**:`exp = ts + exp_horizon`、`from` 含 `key_epoch`、`to.team_id` 自报一致、task.* 必填字段齐备(hops/task_id/attempt 由校验器强制),且「先 `allowMissingSig` 校验、后 `signEnvelope`」的次序正确——出站即校验,与网关侧 M2-01 的结构防线两端对称。
- **跨机负向两例干净**:A1 `routing.denied` 只达发送方本人且 B 无感知(断言 B 收不到任何信封),A5 防御兜底对伪造跨队信封静默计数——回声分级(D28)在 session 层的落点选得对(静默),仅缺审计(DIST-11)。
- **定时器管理有防回退设计**:`arm` 先 `disarm` 防重复、`onTimer('lease')` 保留 M1 DIST-1 修复的死线复核(lead/machine.ts L318-326)——真实 setTimeout 下 M1 的定时器纪律没有退化。
- **lost 演练对「B 离线不误判」的语义注释诚实**(L165「B 会话机器无从处理,保持 running 属正确」),与 R11 降级面声明一致。

## 开放问题(非缺陷,提请后续批次注意)

1. **真实基座适配批次**:DriverHost 的归属校验(DIST-10)、进度通道与会话型停止语义(M1 问题 13)应作为该批次的验收项一并复验,避免「桩驱动全绿、真实基座翻车」第三次发生(M1 blocker、本 blocker 同因)。
2. **多跳/转派批次**:`hops` 递增、`trace.parent_span` fork(`forkTraceForDispatch` 已在 core 备好但零调用)、`refused_loop` 语义接线(DIST-8)需随转派功能一次设计;当前 seal 硬编码 `hops:0` 是「仅发起」假设,应在代码注释与 R-矩阵显式声明。
3. **`rpc.*` 族未实现**:M3 范围取舍合理(验收 A1–A10 不含 rpc),但 §4.1 是 v1 协议族,建议在 WALKTHROUGH 或 README 显式记「rpc 未实现,收到按 DIST-5 的兜底处理」,避免静默缺口被误当已交付。
4. **目录推送与 routing.denied 分级(M2-06/M2-17,已决随 M3 批次)**:落地前,双机剧本不得依赖「入网后立即发包」;落地后回填 WALKTHROUGH 前置条件(DIST-12)。
5. **ws 保活与 presence 僵尸**(M2 开放问题延续):「连接即在线」失真会同时污染 lost 判定前提(B 半开时 A 仍向其投递)与 aid 即时改派,建议 M3 收口时定保活周期。
6. **FileOutbox 持久化(M2-09,已决随 M3 批次)**:lost 演练目前是内存 outbox;「执行方算完即崩溃 → 重启补发 result」的真实降级语义(01 R11)在双机剧本中尚无对应 W 步骤,建议纳入 M3 收口或 M4 计划。
