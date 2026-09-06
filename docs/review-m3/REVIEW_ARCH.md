# 群龙 M3 评审意见——架构与收口视角

> 评审对象:M3「双机真实传输闭环」——`packages/node/src/remote/session.ts`(RemoteNodeSession)、`packages/gateway/test/cross-machine.spec.ts`、`packages/gateway/test/lost-redelivery.spec.ts`、`docs/testing/WALKTHROUGH-2NODE.md`、`docs/testing/R-MATRIX.md`;并对照复阅 `packages/node/src`(lead/executor/harness/gateway-client/outbox)与 `packages/gateway/src`。
> 设计基线:纪要、01/02/03 篇、实现总体规划 §1(A1–A10)/§3(M3 工作包);已决事项对照 `docs/review-m1/`、`docs/review-m2/`(P0 已修毕,major 项逐条核对现状)。
> 评审视角:仅架构与收口——M3 收口判定(A1–A10 逐项闭环/缺口清单)、单机总线与 RemoteNodeSession 双轨收敛、node 包 lead/executor/session/driver 模块边界、向 M4(能力上报/执行档案沙箱)的接缝。协议细节、安全渗透、测试覆盖度由其他角色评审。

## 结论 verdict

**需重大修订**。

M3 的骨架方向正确:`RemoteNodeSession` 以薄会话层把两台纯状态机接到真实 ws + 真实 JCS 签名,状态机零改动(P2 兑现),正向派单、lost→cancel 入收件箱→R4 drain→改派 attempt=2 的真实时序闭环真实跑通。但**收口判定不能通过**:①真实传输路径存在 2 项 blocker 级接线遗漏——执行方对称租约续租(R3)与已决状态重复 offer 防重跑(R0/R1)在 RemoteNodeSession 均未接线,前者使任何超过单次租约的真实长任务必然自暂停→被 lost→烧尽预算,后者使 at-least-once 重放常态下已完成的任务被完整重跑;②M1/M2 评审点名为「M3 前必须修毕」的两项 major(A4 验签接线 M2-ARCH-12、R8 排除闭环 M1-DIST-4)实测仍未修,且 R-矩阵/走查剧本的 ✅ 标注与代码现状不符;③impl §3 M3.1(离散事件仿真/故障注入清单)、M3.2 之 I-09 与「回执帧驱动 aid 即时改派」、M3.4(payload_ref)均未交付,WALKTHROUGH「当前状态」未如实披露。问题集中在「接线完整性与收口诚实度」,不在架构方向——修复面有限,但必须在 M4 开工前修毕并复验。

## 摘要

- **blocker ×2**:执行方对称租约续租未接线,真实链路长任务必自毁(ARCH-1);已决状态重复 offer 重新接单重跑,R0/R1 两层防线在真实路径双缺(M1 ARCH-4 未修,ARCH-2)。
- **major ×8**:A4 入站验签真实链路缺省缺位(ARCH-3);I-09 断线计时暂停未实现(ARCH-4);回执驱动改派与「无候选滞留 drafting」无出口(ARCH-5);R8 排除记录面缺失+跨机测试硬编码绕过(ARCH-6);M3.3/M3.4 收口缺口未披露——A8 审计关联缺失、payload_ref 零实现、FileOutbox/周期退避未做(ARCH-7);离散事件仿真与故障注入清单未交付,时序验收依赖 300–400ms 真实时序(ARCH-8);RemoteNodeSession 绕过 Supervisor/检查点,双轨未收敛(ARCH-9);R2 body 级 TTL 判定不可达,补投死单照单执行(ARCH-10)。
- **minor ×3**:同进程集成形态与生产形态差距未声明(ARCH-11);包公共面/测试基建(ARCH-12);M4 四处接缝未预留(ARCH-13)。
- **nit ×2**:来源校验/剧本口径(ARCH-14);杂项(ARCH-15)。

### M3 收口判定:A1–A10 逐项对照

| 验收项 | 判定 | 说明 |
|---|---|---|
| A1 入网/目录互见 | ✅(限定形态) | 跨机链路内闭环;但为同进程三件套 + 20ms 进程内快照,生产目录通道缺口延续(ARCH-11) |
| A2 派单闭环 | ✅(带保留) | 正向闭环真实跑通;但用例自称「五道闸」不实——闸1 未在链路执行(ARCH-3),且 >lease 场景零覆盖,恰是 ARCH-1 盲区 |
| A3 contract/acceptance_results | 🔲 M4 | W3 未做;当前 kind=project 无 contract 照单全收,连必填校验都没有(ARCH-13④/ARCH-14) |
| A4 lost→改派 | ✅ 主闭环 | lost-redelivery 真实时序打通;但排除语义被硬编码绕过(ARCH-6)、I-09 未实现(ARCH-4) |
| A5 重放/exp 拒收 | ◐ 部分 | exp 层有链路覆盖;已决重跑(ARCH-2)与 body TTL(ARCH-10)两个真实缺口未闭 |
| A6 能力反馈改派 | 🔲 M4 | 闸3+missing 在;目录查询/pickTarget 接线、caps 上报、能力记忆无落点(ARCH-13①) |
| A7 执行档案沙箱 | 🔲 M4 | 闸5 无插位;DriverTask 未扩 source/profile(M1 SEC-5 未修,ARCH-13②) |
| A8 日志还原 | ✗(M3 范围内未核验) | WALKTHROUGH 自列「W8 → M3 收口核验」,实际审计缺五关联字段、无落盘形态(ARCH-7) |
| A9 ACL 拒绝路径 | ✅ | M2 遗产 + 跨机 A1 负向;A5 防御兜底用例在 |
| A10 自动化+剧本 | ◐ 部分 | 用例真实、断言扎实;剧本映射有出入(W2 kind 不一致)、时序确定性缺口(ARCH-8) |

**留给 M4 的真实缺口清单**(收口报告应照此列明):W3 contract 校验与 acceptance_results 链路;W6 目录驱动的 pickTarget + caps/load 上报 + 03 §7 自愈;W7 执行档案沙箱(前置:DriverTask 接缝扩展);W8 审计关联字段 + 本地日志 sink;M3.4 payload_ref 临时方案(全仓仅参数占位);R11 FileOutbox 持久化 + 周期退避重发;部署形态(registry/gateway 跨进程 + node 侧 registry HTTP 客户端);基座驱动适配(已承认的后续批次)。**此外 ARCH-1/2/3/4/5/6/10 属 M3 收口必修项,不应顺延。**

---

## 问题清单

### ARCH-1|blocker|执行方对称租约续租(R3)未接线:真实链路上任何超过单次租约的任务必然自暂停→被误回收→烧尽预算

- **位置**:`packages/node/src/remote/session.ts:73-93`(构造器只接 `onEnvelope`/`onRoutingDenied`,从不接 `client.onAck`)、`session.ts:189-197`(exec 定时器只驱动 `onHeartbeatDue/onLeaseSelfTimeout/onTtlCheck`);对照 `packages/node/src/local/harness.ts:194-197、231-239`(loopback 两条路径都调 `onHeartbeatAcked`)与 `packages/node/src/gateway-client.ts:41`(onAck 空默认,无人消费)。
- **问题**:`ExecutorMachine.onHeartbeatAcked`(executor/machine.ts:244-260)是 R3 执行方对称计时器「自最后一条**成功送达(获网关 ACK)的心跳**起算 lease_ms」的唯一实现,生产代码零调用(仅 SingleNodeHarness 与单测调用)。RemoteNodeSession 下 `leaseSelfDeadline = accept 时刻 + lease`,之后永不续期:任何运行超过一个租约(aid 120s/project 300s,默认参数)的真实任务,执行方在首个租约到期即 `paused`(停发心跳、暂停副作用)→ 牵头方心跳断 → 判 lost → cancel → attempt+1 改派 → 新 attempt 再过 300s 再自毁 → 循环烧到 escalate。**「长任务靠心跳续租」这一 R3 核心场景在 M3 真实传输形态下结构性不可用**。lost-redelivery 用例恰好因 B 本就要「挂起」而被掩盖;cross-machine 的驱动 50ms 完成远小于 400ms 租约,同样照不到。
- **依据**:01 R3(执行方对称计时器及不变式)、R11(回执帧);impl M1.3「租约对称计时器」为 M1 已验收语义,harness 的接线证明这是 M3 会话层遗漏而非设计取舍。
- **建议**:① session 构造时接 `client.onAck`:维护 in-flight `task.progress` 的 `msg_id` 集合(seal 时登记、ack/终态清理),匹配的 delivered/queued 回执才调 `exec.onHeartbeatAcked(now)`;② 补跨机用例:`completeAfterMs > 2×lease_ms` 的健康长任务,断言 attempt===1、无 reclaim 审计、执行方无 paused(该用例同时服务 ARCH-4 的 I-09 语义)。

### ARCH-2|blocker|已决状态收到同键重复 offer 会重新接单重跑(R0 末句/R1 违反;M1 ARCH-4 判 major 且要求传输接线前修毕,至今未修)

- **位置**:`packages/node/src/executor/machine.ts:100-148`(`onOffer` 的同键守卫仅覆盖 `offered/running`;`result_sent/fail_sent/rejected/stopped/cleaned` 直接落 `evaluateOffer` → 闸门通过即再次 accept+startDriver);`packages/node/src/remote/session.ts:227-262`(入站无 R1 去重边界,core `DedupStore` 零接线)。
- **问题**:M1 评审 ARCH-4 已判明「已决状态重复 offer 完整重跑已完成的任务并二次发送 result」,并明确建议「至少修状态机守卫,M2/M3 接线时把 DedupStore 放节点入站边界」。M3 现状两层皆缺:一条已发 result 的任务,若同 `(task_id, attempt)` 的 offer 经 outbox 重发或收件箱补投再度到达(01 P4:重投是常态),执行方会**重新执行整个任务**(真实驱动下=重复副作用)并重发 result。M1 单机回环不产生重复投递故未见;M3 引入真实 outbox/收件箱后这是常态路径,属数据错乱级。
- **依据**:01 R0 末句「任何已决状态下的重复消息一律忽略 + 审计」、R1(去重保留期下限、`dedup_mismatch`);M1 评审 ARCH-4(已决事项);02 §10(重放缓解 = exp + R1 保留期,均要求在端上生效)。
- **建议**:① `onOffer` 入口先判 `rec.task_id === o.task_id && rec.attempt === o.attempt` 且 state∈已决集 → 忽略+审计;② RemoteNodeSession 入站接 `DedupStore`(保留期按 01 §10 下限),与状态机守卫双层并存(02 P10 同构);③ 补跨机用例:B 完成 → 同键 offer 补投 → 断言无第二次 driver.start。

### ARCH-3|major|A4 入站验签在真实双机链路缺省不执行:节点侧唯一签名执法点缺位,测试注释「+A4」失实

- **位置**:`packages/gateway/test/cross-machine.spec.ts:98-113` 与 `lost-redelivery.spec.ts:82-101`(GatewayClient 均未注入 `verifyInbound`);`packages/node/src/gateway-client.ts:186-199`(`verify` 未配置即交付,仅计数);`cross-machine.spec.ts:146`(用例名自称「真实 ws+签名+A4」)。
- **问题**:M2 评审 ARCH-12(major)已判明「verifyInbound 缺省放行使 P10 双重执法退化为网关单点」,并明确要求「M3 接线时按 ARCH-13.3 提供完整验签链实现(密钥目录 + TOFU 钉扎 + 纪元现势)」。M3 交付的两条真实链路用例全部走缺省放行:节点侧对入站信封零验签,A4 闸1 在「双机真实传输」中从未执行——R-矩阵「闸1 core/sig ×6+trio A4 ✅」指的是 core 纯函数与 M2 trio 的注入式用例,不是 M3 运行形态;W2 剧本「B 五道闸通过」同样不实(闸1 未跑)。
- **依据**:02 §7 A4、P10(单点执法必有单点失守)、§6.2/§10(TOFU 钉扎、纪元现势)、D16;M2 评审 ARCH-12/ARCH-13.3(已决事项);impl §5(实现偏离不静默)。
- **建议**:① 实现节点侧 PubkeyDirectory 验签组件:首连钉扎 + 纪元现势校验 + `(node_id, key_epoch)` 查取(可先消费 registry 快照,跨进程端点另见 ARCH-11),作为 RemoteNodeSession 的缺省构件;② 缺省未配置验签 → 拒交付 + 审计(把「跳过验签」变成显式 opt-in 测试模式);③ cross-machine 补坏签名负向用例(B 静默计数、会话无感知);④ R-矩阵闸1 行注明「链路级接线 🔲 待本项修复」。

### ARCH-4|major|R3/I-09 断线计时暂停与 drain 重开未实现:自身链路抖动即误判 lost,改派风暴

- **位置**:`packages/node/src/remote/session.ts`(全文件无 `client.onClose` 接线;`leadTimers/execTimers` 为真实 setTimeout,断线期间照走);`packages/node/src/gateway-client.ts:43`(`onClose` 回调存在,无人消费)。
- **问题**:01 R3(评审 I-09)明文:「ws 断线期间,本节点全部入站任务的 lost 计时暂停,重连后从最后一条(含补投的)心跳重新起算;drain 窗口随重连重新打开」。RemoteNodeSession 的 lead `lease/offer_ttl/drain/cancel_wait` 定时器与 ws 连接态完全无关:A 侧网络抖动数秒,其牵头的全部任务即按真实时序判 lost→cancel→改派;若对端实际健在,改派还会触发 R0③ 隐式取消连锁。这是 impl §3 M3.2 验收原文包含的项(「断线重连计时暂停+drain 重开(I-09)」),未交付且未在收口材料披露。
- **依据**:01 R3(I-09 定案原文);impl §3 M3.2 验收;02 §8(presence 以连接态为准的语义前提是计时跟随连接态)。
- **建议**:① session 订阅 `onClose`:暂停全部定时器池(记录剩余时长),`auth_ok`(重连成功)后按剩余时长重排,并对 reclaiming 中任务重开 drain;② 补「A 断连 1×lost 窗口 → 重连 → 不误判、任务存活」用例,建议落在虚拟时钟层(与 ARCH-8 合并解决)。

### ARCH-5|major|回执帧不进状态机:「aid 即时改派」(M3.2 验收项)落空;「无候选」时 lead 永久滞留 drafting,无定时器、无审计、无终态

- **位置**:`packages/node/src/remote/session.ts:88-92`(`onRoutingDenied` 只透传宿主回调,不进 lead)、`session.ts:147-153`(`requestDispatch` 中 `pickTarget` 返回 undefined 即 `break`,无后续);`packages/node/src/lead/machine.ts:400-402`(budgetOrEscalate 置 drafting 后语义全部依赖外部再驱动);`packages/gateway/src/core.ts:151-156`(`rejected(offline_not_stored)` 回执已产生)。
- **问题**:两处语义断链。① 01 §9/评审 I-11 的机制支撑是「aid 类不暂存 → `rejected(offline_not_stored)` → 牵头方**据此立即改派**」,impl M3.2 验收原文即「回执帧驱动 aid 即时改派」;现状回执只清理 outbox 并唤起 waiter,lead 停在 offered 干等 offer_ttl(aid 10s/project 60s)才走 R4——「即时」不存在,routing.denied(A1/A2)同理只能等超时。② `pickTarget` 返回 undefined(目录暂无候选)时任务永久停在 drafting:无重试定时器、无审计、无 escalate 出口,派单面静默停滞。
- **依据**:01 §9(回执「仅用于诊断与**改派触发判定**」)、R4;impl §3 M3.2;01 §11(派单停滞类中间态应可观测)。
- **建议**:① LeadTaskMachine 增加回执输入动作(如 `onDispatchRejected(reason)`):`offline_not_stored`/A1/A2 拒绝 → 进入 R4 改派语义(不可达目标的 cancel 可简化,口径回写 R4);② `requestDispatch` 无候选时排退避重试定时器(或 N 轮后 escalate),history/审计留痕;③ session 把 `onAck(ack_type:'rejected', reason)` 与 `onRoutingDenied` 统一映射进 ①。

### ARCH-6|major|R8 排除记录面缺失:fail(retryable)/lost 不写 excluded(M1 DIST-4 判 major 未修),跨机用例以硬编码 pickTarget 绕过,R-矩阵 ✅ 失真

- **位置**:`packages/node/src/lead/machine.ts:241-254`(task.fail 路径不调 `applyExclusion`)、`318-327`(lost 路径同)、`405-416`(applyExclusion 仍仅被 offered 态 reject 分支调用);`packages/gateway/test/lost-redelivery.spec.ts:137-142`(`pickTarget` 硬编码「首投 B、改派一律 C」且 `void excluded`);`docs/testing/R-MATRIX.md:18`(R8 行标 ✅)。
- **问题**:R8「其余瞬时 retryable 仅排除一次」与「判 lost 节点按 R4 取消衔接处理」在状态机层均未落地:retryable fail 与 lost 后 B 不进 excluded,`pickTarget` 拿到的硬约束数据为空,宿主完全可能把改派目标再选回刚失败/失联的节点,连烧预算后 escalate。lost-redelivery 的「排除后选 C」是测试剧本硬编码,排除机制未被端到端行使——R-矩阵据此标 ✅ 属追溯失真(M1 评审已指出「记录面缺失不在豁免范围」)。
- **依据**:01 R8;M1 评审 DIST-4/ARCH-8(已决事项,建议原文「beginReclaim 按 origin 记录:fail(retryable)→once、lost→once」);impl §5(R-矩阵如实标注)。
- **建议**:① `beginReclaim` 增加排除语义:fail(retryable) 与 lost 对 `rec.target` 记 `'once'`(acceptance_failed 不排除,维持重做可回原节点);② lost-redelivery 的 pickTarget 改为「按 excluded 过滤 + 目录顺序选第一个非排除候选」,使 C 的入选由机制产生;③ R-矩阵 R8 行如实降级至本项修复。

### ARCH-7|major|M3 收口缺口未如实披露:A8 审计关联缺失、M3.4 payload_ref 零实现、R11 FileOutbox/周期退避未做——三处均为 impl/R-矩阵自设的 M3 范围

- **位置**:`packages/node/src/remote/session.ts:135-137、174-176`(`makeAudit` 仅传 node_id/reason,core `AuditFields` 的 envelope/trace_id/task_id/attempt 全部未用;console.log 缺 01 §11 五字段);全仓无 payload_ref/payload 拉取实现(仅 `core/src/params.ts:28-29` 占位);`packages/node/src/gateway-client.ts:124-130`(flush 仅重连触发,无周期退避;`outbox.ts` 仅 MemoryOutbox);`docs/testing/R-MATRIX.md:20-21`(R10「🔲 M3 尾」、R11「🔲 FileOutbox(M3 收口前)」);`docs/testing/WALKTHROUGH-2NODE.md:32-35`(「当前状态」未列这三项)。
- **问题**:① A8/W8「仅凭双机本地日志 + trace_id 还原派单全生命周期」被 WALKTHROUGH 自列为 M3 收口核验项,现状是审计事件不带 trace_id/task_id/attempt/头摘要(01 §11:「缺字段视为日志缺陷」),也无任何日志落盘形态,离线还原不可成立;② M3.4 工作包(payload_ref 临时方案:受限拉取器 + sha256/size 校验,验收「大负载走引用、篡改被拒」)零实现;③ R-矩阵自己把 FileOutbox 标为「M3 收口前」,现状仍 MemoryOutbox + 仅重连 flush,「连接保活但回执丢失」场景关键消息无限期滞留(M2 ARCH-11 的两个半边都未修)。三者均未进入 WALKTHROUGH「当前状态」的缺口披露——收口材料的完整性问题比缺口本身更需纠正。
- **依据**:impl §3 M3.3/M3.4;01 §11、R10、R11/D26;R-矩阵自设承诺;impl §5(不静默偏离)。
- **建议**:① session 的 audit 动作携带 envelope(出站可取已封信封)/trace_id/task_id/attempt,提供最小 JSONL sink 作为「本地日志形态」落点,并把「双机日志 + trace_id 离线还原一次派单」的核验记录写入 WALKTHROUGH;② payload_ref 与 FileOutbox 二选一:本批补做,或显式移入 M4 工作包并在 R-矩阵/WALKTHROUGH 改标 🔲 M4——但不得以「M3 完成」口径收口。

### ARCH-8|major|M3.1 离散事件仿真与故障注入清单未交付:时序类验收建立在 300–400ms 真实时序上,确定性承诺落空

- **位置**:`packages/gateway/test/cross-machine.spec.ts:16-30`、`lost-redelivery.spec.ts:12-26`(FAST_PARAMS:lease 400ms、心跳 133ms、drain 100ms,全部真实 setTimeout/Date.now);impl §3 M3.1(「离散事件仿真(时钟可控,赛跑/超时确定性复现)| 故障注入清单全过」)。
- **问题**:M3.1 的离散事件仿真未交付,当前跨机用例以数百毫秒真实时序断言赛跑/超时/lost:CI 负载抖动即可翻转结果(cross-machine 内预留的 DIAG 诊断分支即是自我预期),且**时序敏感场景的覆盖被参数压缩反向限制**——为避免 flaky,所有用例都把驱动完成时间压在租约内,直接造成 ARCH-1(>lease 续租)这类盲区。M1 评审 DIST-6(同刻 tie-break)与 QA-9 已为离散仿真铺好 SingleNodeHarness 基础,M3 未接续;「故障注入清单」作为文档也不存在。
- **依据**:impl §3 M3.1 验收原文;01 §6(时序规则需确定性可复现的测试);M1 评审 DIST-6/QA-9(已决方向)。
- **建议**:① 把 lost/改派/赛跑类时序剧本移植到虚拟时钟层(SingleNodeHarness 或其抽出的调度抽象)做确定性回归,真实 ws 保留冒烟级 1–2 条;② 建立 `docs/testing/FAULT-INJECTION.md` 故障注入清单(lost/断连/重放/改派回原节点/回执丢失/补投死单),逐项标注覆盖位置——它同时是 ARCH-1/2/4/5/10 修复用例的宿主。

### ARCH-9|major|双轨未收敛:RemoteNodeSession 绕过 LeadSupervisor/检查点,接管承诺在真实运行形态不可用;多任务发起静默无效

- **位置**:`packages/node/src/remote/session.ts:60、101-113`(自持单个 `lead` 实例;`startLeadTask` 对已有 lead 直接复用旧机器——第二个 taskId 的派发被状态机守卫静默吞掉,而 traces 已记在新 taskId 下)、`session.ts:125-162`(processLead 无任何 persist/restore);对照 `packages/node/src/lead/supervisor.ts:114-116`(每转移落检查点)、`store.ts`(JsonFileStore 生产形态就绪但零生产调用方)。
- **问题**:M1 验收核心「接管 = 同机进程重启 + 检查点重放(01 §4.4)」只存在于 Supervisor/SingleNodeHarness 测试轨道;M3 真实运行形态 RemoteNodeSession 完全绕开:lead 的 attempt/排除表/history 在进程重启后全部蒸发,重启即任务丢失——分布式系统的常态事件。同时单 lead 限制使 project 模式(一图多子任务,W3/M4 前置)在会话层无承载,`lead:${timer}` 定时器键不含 task_id 也与多任务互斥。这正是「单机总线与 RemoteNodeSession 双轨并存」未给收敛计划的具体表现:两条轨道已开始分叉(执行方续租只在总线侧接线即为一例,见 ARCH-1)。
- **依据**:01 §4.4(v1 接管定案);impl §3 M1.2(已验收语义应在后续里程碑保持);M2 评审 ARCH-13(TransportAdapter 统一装配建议)。
- **建议**:① RemoteNodeSession 内部改持 `LeadSupervisor`:每任务一机、每转移 persist、`restoreAll + rearm + onNeedDispatch` 在会话启动时接线(定时器重挂复用现有 arm 池);`startLeadTask` 校验 taskId 唯一,重复即抛错;② 在 docs 写一页双轨收敛 ADR:SingleNodeHarness 定位为「状态机+调度语义的确定性测试总线」,RemoteNodeSession 为唯一传输运行形态,两者共享 Ingress 校验(验签/exp/去重/to_node)与定时器调度抽象——M1 API-5/M2 ARCH-13 的建议至此落地;③ 定时器键补 task_id 维度。

### ARCH-10|major|R2 body 级 offer_ttl 判定在真实路径不可达:收件箱补投的死单会被照单执行

- **位置**:`packages/node/src/executor/machine.ts:150-205`(`evaluateOffer` 到达时无任何 offer_ttl 检查;唯一到达时检查是信封 exp,horizon 默认 24h)、`218-228`(`onTtlCheck` 依赖的 `offered` 态在状态机内不可达——executor.spec.ts:75 靠「手工置回 offered 态」才能测到)。
- **问题**:01 R2「执行方以『晚于』TTL 判过期;过期 → `reject(expired)`」;01 §9/02 §8「长期离线节点上线后收件箱批量过期 offer → 整批 `reject(expired)`(必测场景)」。R-矩阵 R2 行标 ✅,实际覆盖仅有 core 纯函数(「晚于」边界)与 exp 层链路,body TTL 的现役执行路径不存在。后果:暂存补投的过期死单(aid 10s/project 60s 级)只要在 exp(24h)内到达就被接单执行——牵头方早已改派他人,同一任务双执行,旧 attempt 的副作用(文件/网络操作)照常发生,其 result 再被 R0 拒收,算力与副作用双浪费。M4 闸5 的「本地确认与 offer_ttl 赛跑」(03 §6.2)也以此为前置。
- **依据**:01 R2、§9、03 §6.2;R-矩阵 R2 行(标注与实现不符)。
- **建议**:① `evaluateOffer` 到达时按「晚于 receivedAt + offer_ttl_ms」判 `reject(expired)`(与 M1-API-1 的 exp→reject(expired) 口径合并,审计 reason 区分 exp/ttl);② 补跨机用例:B 离线 → A 派 project 单入收件箱 → 超过 offer_ttl 后 B 重连补投 → 断言 reject(expired) 且无 driver.start;③ 顺带清理 `offered` 死态或注释钉死「v1 接单为同步评估,offered 仅测试注入用」。

### ARCH-11|minor|M3 集成形态与生产形态的差距未声明:同进程三件套 + 进程内目录快照,node 侧无 registry HTTP 客户端

- **位置**:`packages/gateway/test/cross-machine.spec.ts:59-77、91-124`(registry/gateway 同进程直连,`syncRegistry` 用测试侧 20ms setInterval;「双机」实为同进程内两个 ws 客户端);`packages/registry/src/http.ts`(无目录快照/订阅端点,M2 ARCH-3 未动);`packages/node/src`(无任何 registry HTTP 客户端,`pickTarget` 无目录可查)。
- **问题**:M2 ARCH-3 已判「目录通道必须跨进程化」为 major(单实例通道协议不属集群化开放问题豁免),M3 未推进且收口材料未声明当前形态:A1 的「通讯录互见」在测试断言层成立,在生产部署形态(registry/gateway 独立进程)没有通道。node 侧 registry HTTP 客户端(M2 ARCH-13.4)缺位,使 M4 的 W6(目录过滤选目标)没有落点——`pickTarget` 回调 today 只能由宿主凭空实现。
- **依据**:02 §7.1/§9;impl §3 M2.3/M3.3;M2 评审 ARCH-3/ARCH-13.4(已决事项);纪要 §3(中心三件部署形态)。
- **建议**:① WALKTHROUGH 前置节显式声明「当前为同进程集成形态,跨进程通道见 🔲 清单」;② M4 开工前立部署形态工作包:registry 目录端点(快照/增量)+ node 侧轻量 HTTP 客户端(enroll/通讯录/pubkey/caps 上报四件),W6 的 pickTarget 直接建在其上。

### ARCH-12|minor|包公共面与测试基建:M3 核心类未导出、index 重复导出、跨包深引、回调经 `opts` 被测试改写

- **位置**:`packages/node/src/index.ts`(未导出 `remote/session.js`、`lead/supervisor.js`、`lead/checkpoint.js`、`lead/store.js`;`driver.js`/`local/harness.js` 仍重复导出,M2 ARCH-20④ 未修);`packages/gateway/test/cross-machine.spec.ts:8-9、137、148` 与 `lost-redelivery.spec.ts:7-8`(相对路径深引 node 源码,且 `sessionA.opts.onTerminal/pickTarget` 直接改写 readonly opts);跨机两份 spec 约 100 行 registry/gateway/sync/enroll 脚手架完全重复。
- **问题**:M3 的主角类不可从 `@qlong/node` 导入,外部宿主(CLI/M4)只能深引源码——M1 ARCH-15/M2 ARCH-19 的包边界问题第三次重演;`opts` 的 readonly 只是装饰,测试直接改写回调说明回调注入面设计未收口;脚手架重复使第三条跨机剧本(如 W6/W8)的边际成本居高。
- **依据**:impl §2(packages/testing 承载走查剧本)、§5;M1/M2 评审同款已决事项。
- **建议**:① index 补导出并清理重复;② `RemoteSessionOptions` 回调提供构造后注册方法(`on('terminal', ...)` 风格)替代裸 opts 改写;③ 跨机脚手架抽到 `packages/testing`(顺手补建该包),cross-machine/lost-redelivery 收敛为剧本数据 + 公共驱动。

### ARCH-13|minor|向 M4 的四处接缝未预留:能力上报无通路、DriverTask 无档案上下文、reply_to 被 seal 丢弃、hops 不入执行方

- **位置与问题**:① `session.ts:38`(`capabilities` 仅作闸3 本地输入;无 `PUT /v1/nodes/me/caps|load` 上报调用点)——03 §4 上报协议、A6「A 更新本地能力记忆」与 03 §7 两段式自愈在 node 层零落点;② `driver.ts:6-10`(`DriverTask = {task_id, attempt, offer}` 原样透传 offer,M1 SEC-5 判 major 未修)——M4.2 执行档案的 `source/profile` 无着力点,基座适配接上时必然破坏接口;③ `session.ts:267-285`(`seal()` 不装配 `Outbound.reply_to`,§4.5/I-57 的逐类型映射形同虚设);④ `session.ts:238-251`(入站 offer 不向 `exec.onOffer` 传 `hops`,01 §7 的 `refused_loop` 无执法落点)。
- **依据**:03 §4/§6.1/§6.2、01 §4.5/§7;M1 评审 SEC-5(已决事项);impl §3 M4.1/M4.2。
- **建议**:四项在 M4 首轮一次性定接口:① session 挂 caps/load 上报器(周期 + 事件触发);② `DriverTask` 扩 `{source:{node_id, team_id?, remote}, profile?}` 并钉死「offer.body 未经档案包装不得直达基座」;③ seal 透传 reply_to;④ onOffer 入参加 hops 并在闸序中先行校验。

### ARCH-14|nit|来源校验与剧本口径:cancel 不校验来源节点;W2 剧本 aid vs 用例 project;contract 必填无校验

- **位置**:`packages/node/src/executor/machine.ts:308-333`(`onCancel` 只比对 attempt,不比对 `fromNode === rec.from`——同队任意节点可撤销他人任务;P7 之下属纵深防御缺失,一行可修);`docs/testing/WALKTHROUGH-2NODE.md:17`(W2 写「aid 单」)对照 `cross-machine.spec.ts:151`(用例发 `kind:'project'`);01 §4.2(kind=project contract 必填)对照两条 spec 的 offer body(均无 contract,无任何一层拒收)。
- **建议**:① onCancel 补来源比对,不匹配忽略+审计;② W2 剧本与用例对齐(改剧本为 project 或补 aid 用例);③ contract 必填校验与 W3 一并留 M4,但 R-矩阵/走查应注明「当前不校验」。

### ARCH-15|nit|杂项:dispose 不解绑回调、ackTimeout 硬编码、hops 硬编码 0、01 篇示例自相矛盾

- **位置与建议**:`session.ts:314-319`(`dispose()` 不清 `client.onEnvelope`,停机后迟到信封仍会进入已清空定时器的状态机,建议置空回调);`session.ts:289`(`ackTimeoutMs: 2_000` 硬编码,建议入 opts);`session.ts:277-279`(`hops: 0` 硬编码——v0.1 单跳发起正确,建议注释钉死「转派/多跳属 v1.5,届时由任务上下文携带」);`docs/QLONG_DESIGN_01_MSG_PROTOCOL.md:69`(§3.2 示例 `hops:1` 与 §3.1「发起为 0」/§7.3「发起 parent_span=null」矛盾,建议随文档回写顺手修正,避免后续实现照抄示例)。

---

## 亮点

1. **P2「换通道不换语义」真实兑现**:两台状态机零改动接入真实传输,RemoteNodeSession 仅做 Outbound→信封(seal 全字段校验 + JCS 签名)、入站分发、定时器落地三件事,320 行薄会话层;跨机用例跑的是真实 ed25519 签名与真实 ws 帧,不是仿真替身。
2. **lost→回收→改派主闭环质量高**:真实时序下 B 失联→A 判 lost→cancel 入网关收件箱(断言 inbox 非空)→drain 收口→attempt=2 改派 C→done,R4「先撤销后改派」、drain 赛跑窗口、R5 `completed_before_cancel` 全部按设计条款行使,断言打到了 acceptedFailedBudget 与审计事件这类语义位。
3. **M1 blocker 修复真实落地并被回归锁定**:lease 定时器 cancelTimers+deadline 复核、单执行位 busy 守卫、接管重挂定时器(regressions-m1.spec 逐条对号),未出现「修了又退」。
4. **负向路径的端到端可见性**:A1 跨队 routing.denied 到达发起方本人且 B 无感知、A5 防御兜底直注伪造信封被会话层静默计数——回声分级在双机形态下有直接断言。
5. **集成时序细节处理正确**:enroll 后立即同步目录再建连,消除「第一封 offer 因目录滞后被 A1 误拒」的竞态;FAST_PARAMS 的 grace 不变式(100 ≤ 400−266)保持成立。
6. **收口自查意识**:WALKTHROUGH 明确把 W3/W6/W7 划给 M4、把 W8 列为收口核验项,大方向诚实——本评审的分歧只在「划出去的边界是否与 impl/R-矩阵自设承诺一致」与「留下的是否真的闭环」。

## 开放问题(提请设计/委员会裁决)

1. **双轨终态**(配合 ARCH-9):SingleNodeHarness 是长期保留为「确定性时序测试总线」并与 RemoteNodeSession 共享 Ingress/调度抽象,还是逐步淘汰?建议前者并出一页 ADR;若后者,lost/赛跑类确定性回归(ARCH-8)将无处安放,需先补离散仿真再拆。
2. **回执进状态机的接口形状**(配合 ARCH-5):ack/routing.denied 以新增输入动作(如 `onDispatchRejected`)进入 LeadTaskMachine,还是复用 `onMessage` 伪 type?该决定同时约束 M4 目录驱动改派(W6)的输入面,建议随 R4 口径回写一并定案。
3. **执行方多任务形态**(M1 DIST 开放问题延续):v1 单执行位与 03 §3.3 `queue_depth` 并发语义的偏差何时收口?M4 的闸4 阈值、caps/load 上报、accepting 快照都依赖 running/queue_depth 的真实取值,建议 M4.1 开工前定案。
4. **FAST_PARAMS 短时序参数的定位**(配合 ARCH-8):允许常驻 CI 回归,还是仅作冒烟、时序断言一律下沉虚拟时钟?涉及 flaky 预算与覆盖策略,建议在故障注入清单文档中一并约定。
