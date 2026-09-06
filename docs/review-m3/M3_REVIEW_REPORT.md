# 群龙 M3 里程碑评审报告

> 汇总依据:仅依据 `docs/review-m3/` 下五份角色评审文件(REVIEW_DIST / REVIEW_SEC / REVIEW_API / REVIEW_QA / REVIEW_ARCH)汇总,不引入新论断。同题意见已合并并标注来源编号;合并条目取其中最高严重度。

## 一、评审信息

- **评审对象**:M3 跨机真实传输闭环(双机真实传输闭环:`packages/node/src/remote/session.ts`、`packages/gateway/test/cross-machine.spec.ts`、`packages/gateway/test/lost-redelivery.spec.ts` 及其接线对端与文档交付物)。
- **评审团构成**:5 个角色评审文件齐备,**无缺失角色**。

| 角色 | 评审文件 | 结论 | 意见数(blocker/major/minor/nit) |
|---|---|---|---|
| 分布式语义与一致性 | REVIEW_DIST.md | 需重大修订 | 13(1 / 4 / 7 / 1) |
| 传输安全 | REVIEW_SEC.md | 需重大修订 | 10(1 / 4 / 3 / 2) |
| 接口与集成缝 | REVIEW_API.md | 需重大修订 | 15(1 / 9 / 4 / 1) |
| 测试稳健性 | REVIEW_QA.md | 有条件通过 | 7(0 / 4 / 3 / 0) |
| 架构与收口 | REVIEW_ARCH.md | 需重大修订 | 15(2 / 8 / 3 / 2) |
| **合计** | — | — | **60(5 / 29 / 20 / 6)** |

- 汇总计数口径:原始意见 60 条;同题合并后本报告问题清单共 **34 条(blocker 3 / major 17 / minor 11 / nit 3)**,每条标注来源编号与提出角色。

## 二、总体结论与执行摘要

五位角色评审齐备,四位判「需重大修订」、一位判「有条件通过」,原始意见共 60 条(blocker 5 / major 29 / minor 20 / nit 6),同题合并为 34 条。M3 骨架方向获一致肯定:两台纯状态机零改动接入真实 ws + JCS 签名,lost→cancel 入收件箱→R4 drain→改派 attempt=2 的真实时序闭环第一次真实跑通,出站 seal「先校验后签名」纪律扎实。但接线只完成了机器接口的「半张图」:执行方 R3 心跳回执续租在 RemoteNodeSession 未接线,任何超过单次租约的健康任务必然假暂停→停跳→误判 lost→循环改派至 escalate,且被「桩驱动 50ms ≪ 测试租约 400ms」的用例时间窗系统性掩盖。安全面 A4 入站验签在全部真实链路缺省缺位而测试标题/R-MATRIX 虚标覆盖,R1 去重未集成使 at-least-once 重放下已完成的任务被完整重跑——双重执法只剩网关单层。追溯诚实度同样存在问题:R-MATRIX/走查对 A4、R2、R8、§7 trace 等多行标 ✅ 而实现缺位或被测试硬编码绕开,I-09、payload_ref、FileOutbox、离散仿真等自设 M3 范围未交付亦未披露。综合判定:**需重大修订**——blocker 与 major 修毕并复验、追溯账本对表后方可进入 M4。

**三个关键风险**:

1. **长任务必然自毁**:R3 心跳回执续租未接线,执行超过一个 lease 周期的远端任务必然「假暂停→永久停跳→被误判 lost→循环改派→escalate」;健康链路上的长任务 100% 走假回收,现有测试因任务寿命全部短于租约而照不到(DIST-1 / API-1 / ARCH-1 blocker,QA-1 major,四角色同指)。
2. **重放即重跑、注入即执行**:A4 入站验签全程未接线(`from.node_id` 全凭自报)叠加 R1 去重管线缺席——网关被攻陷/明文链路注入/v1.5 直连场景下即「任意任务书注入执行」;outbox 重发/网关补投重放会使已发 result 的任务被完整重跑并二次执行副作用(SEC-1 blocker / ARCH-2 blocker / API-2、SEC-5 major)。
3. **追溯账本失真**:R-MATRIX/走查多行 ✅ 与代码现状不符(A4「全覆盖」、R8「排除后选 C」、R2「过期链路」、§7「trace 透传」),W8 日志还原收口核验因审计缺五关联字段不可成立——「测试绿但语义链路断」属系统性风险,收口判定不可据账本直接采信(SEC-1、DIST-4、API-10、QA-6、ARCH-6/7 多角色同指)。

## 三、问题清单

> 同题合并规则:同一缺陷被多角色独立提出时合并为一条,保留最高严重度,并在「提出角色」中注明各来源编号及其原始严重度。共 34 条:blocker 3 / major 17 / minor 11 / nit 3。

### Blocker(3 条)

**BLK-1|blocker|执行方 R3 心跳回执续租未接线,长任务必然假暂停→误判 lost→循环改派**
- **位置**:`packages/node/src/remote/session.ts` 构造器(仅绑 `onEnvelope`/`onRoutingDenied`,从未接管 `client.onAck`;`onHeartbeatAcked` 生产代码零调用,唯一调用方是单机 `local/harness.ts`);`packages/node/src/executor/machine.ts`(accept 时一次性排 `lease_self`,仅 `onHeartbeatAcked` 能续期;`onHeartbeatDue` paused 即返回且不重排心跳;恢复分支不重排心跳);`packages/node/src/gateway-client.ts`(ack 仅清 outbox,默认空 onAck)。
- **问题**:01 §6 R3「自最后一条成功送达(获网关 ACK)的心跳起算 lease_ms」依赖 ack→`onHeartbeatAcked`→续租链,M3 会话未接;`lease_self` 在 accept 时刻一次定格永不续期,推演真实参数下任何执行超过一个 lease 周期的健康任务在租约到点被自暂停、心跳永久停跳、被牵头方判 lost→R4 回收改派→循环烧尽 `max_attempts`→escalate。与 M1 DIST-1(blocker)同型,恰被 50ms 桩驱动与 400ms 测试租约错开掩盖;单机总线接了这条输入而双机会话漏接,证明属会话层遗漏而非设计取舍。第二层:即便接上 ack,paused 恢复路径也不重排心跳定时器,须一并修。
- **建议**:① session 构造器接管 `client.onAck`,按 msg_id 识别在途 progress 回执才调 `exec.onHeartbeatAcked`(accept/result 等 ack 不续租);② 恢复分支补 `{kind:'schedule', timer:'heartbeat'}`;③ 补「驱动时长 2.5×lease、心跳正常送达→attempt===1、无 reclaim 审计、无 paused」回归用例及恢复链用例。
- **提出角色**:DIST-1(blocker)、API-1(blocker)、ARCH-1(blocker)、QA-1(major)。

**BLK-2|blocker|A4 入站验签在真实链路全程未接线,测试与追溯文档虚标覆盖——双重执法只剩网关单层**
- **位置**:`packages/node/src/gateway-client.ts`(`verifyInbound` 为可选钩子,未配置即直通);`cross-machine.spec.ts` 与 `lost-redelivery.spec.ts` 两处构造 GatewayClient 均未配置;`session.ts` 无任何验签/公钥目录触点;全仓唯一接线是 M2 遗留 `trio.spec.ts`。
- **问题**:02 P10「双重执法」的节点辅层整体缺席:入站信封不验签直达状态机,`from.node_id` 完全自报;网关被攻陷/作恶、ws 明文注入、v1.5 直连场景全部失去防线,执行方把 offer 直接交给驱动即「任意任务书注入执行」。覆盖声明失真:用例标题「真实 ws+签名+A4」实际入站 A4 未发生;「A5 防御兜底」用例绕过两层直呼 `onEnvelope`,伪造签名从不被校验;R-MATRIX「A4 全覆盖 ✅」、W5 ✅ 据此失真。M2 SEC-5 预警「M3 极易以缺省无验签形态运行」被坐实,且 M2 已决「A4 接线为 M3 前必修」仍未修。
- **建议**:① 失败关闭:`verifyInbound` 未提供时对 `task.*`/`rpc.*` 一律静默丢弃+计数(或显式 `allowUnverifiedInbound` 开洞留审计);② 提供节点侧默认验签构件(目录查 `(node_id, key_epoch)` 公钥+纪元三态,TOFU 钉扎留接口位),由 session 构造时自动装配;③ 两 spec 全部接入验签并补坏签名负向用例(不达状态机、驱动不启动);④ 回填 WALKTHROUGH W5/R-MATRIX A4 行,如实标注现状。
- **提出角色**:SEC-1(blocker)、API-4(major)、ARCH-3(major)。

**BLK-3|blocker|已决状态重复 offer 重新接单重跑 / R1 去重管线在真实链路缺席**
- **位置**:`packages/node/src/executor/machine.ts`(`onOffer` 同键守卫仅覆盖 offered/running,result_sent 等已决态落入 `evaluateOffer` 重新 accept+startDriver);`session.ts` `onEnvelope` 无 DedupStore(core 纯函数实现零生产消费方);`gateway-client.ts` 入站仅形状校验。
- **问题**:01 P4「至少一次、执行必须幂等」+ R1 去重要求,在真实链路两层皆缺:已发 result 的任务,同 `(task_id, attempt)` offer 经 outbox 重发/网关补投再度到达(offer_ttl 60s、exp 24h,时间窗极宽)即整任务重新执行(真实驱动下重复副作用)并重发 result;同键异 body 的 `dedup_mismatch` 审计全链路无人产出;重复 cancel 在 result_sent 态回声放大。M1 ARCH-4 已判明并要求接线前修毕,至今未修;M1 API-5 裁定的「入站管线接缝」正是 M3 会话,未落地。R-MATRIX R1 行以 core 纯函数标 ✅ 属「组件已测 ≠ 集成已落地」。
- **建议**:① `onOffer` 入口补已决态同键守卫(忽略+审计);② session 入站集成 core `DedupStore`(键 `(task_id, attempt, type)`,progress 豁免,保留期按 01 §10 下限),与状态机守卫双层并存;③ 补「B 完成→同键 offer 补投→无第二次 driver.start」确定性用例;④ R-MATRIX R1 行拆分「core ✅ / 真实链路集成 🔲」并回填。
- **提出角色**:ARCH-2(blocker)、API-2(major)、SEC-5(major)。

### Major(17 条)

**MAJ-1|major|R2 body 级 offer_ttl 执行方判定不可达:补投死单照单开跑**
- **位置**:`executor/machine.ts`(`evaluateOffer` 同步置 running,从不进入 offered、从不排 ttl 定时器;`onTtlCheck` 以 `state==='offered'` 为前置恒死代码);`gateway/src/ws.ts`(M2 修复后重连即补投,过期死单投送通道真实存在)。
- **问题**:执行方唯一过期闸是信封 exp(缺省 24h 级),`offer_ttl_ms`(60s/10s 级)判定在 M3 链路无执行点;离线后补投的过期 offer 被 accept 且 startDriver 真实开跑(真实副作用),且以 accept 而非 `reject(expired)` 回填,牵头方 R8「expired 换目标」信号失真。M1 blocker #1 以 exp 闸替代评审要求的「TTL 闸或两段式 offered 驻留」,口径收窄未见设计回写;「offered 驻留」亦是 M4 闸5「本地确认与 offer_ttl 赛跑」的必要形态。R-MATRIX R2 行把过期链路记在 lost-redelivery 名下,该文件无任何过期用例,归因失真。
- **建议**:二选一并落文档:① `evaluateOffer` 入口补 TTL 闸(`now > 收到时刻+offer_ttl_ms` 晚于判向→`reject(expired)`,与 exp 闸并存,推荐);② 若确认口径收窄,按 IMPL_PLAN §5 回写 01 R2 并同步改 R-MATRIX;补「补投 2×offer_ttl→reject(expired)→换目标」端到端用例。
- **提出角色**:DIST-3、API-8、ARCH-10。

**MAJ-2|major|R8 排除记录面缺失 + 演练硬编码绕开 + R-MATRIX「R8 ✅」账实不符**
- **位置**:`lead/machine.ts`(`applyExclusion` 唯一调用点是 reject 分支;lost 与 fail(retryable) 路径均不记排除);`lost-redelivery.spec.ts`(`pickTarget` 显式 `void excluded`,按 `nextAttempt` 硬编码选 C);`docs/testing/R-MATRIX.md` R8 行标 ✅。
- **问题**:判 lost 与 fail(retryable) 后 `excluded` 为空,真实部署中忠实消费排除表的 pickTarget 会再次选中刚失败/失联节点,「改派」退化为本节点重试、连烧预算;演练把排除逻辑放在测试闭包硬编码,端到端无任何一处断言排除表被写入或消费;R-MATRIX 据此标 ✅,追溯账本第三次同类失真。
- **建议**:① lost 分支与 fail(retryable) 分支落 `excluded[target]='once'`(验收失败不排除,保持可回原节点);② 演练改为断言 `excluded` 写入且 pickTarget 真实消费(或 session 提供缺省 picker 过滤 excluded);③ R-MATRIX R8 行按实际覆盖改写,「记录/消费」两半落地前不得标 ✅。
- **提出角色**:DIST-4、API-6、QA-2、ARCH-6(四角色同指)。

**MAJ-3|major|I-09 断线计时暂停与 drain 重开未实现:自身链路抖动即误判 lost**
- **位置**:`session.ts`(全文无 `client.onClose` 订阅,lead lease/offer_ttl/drain/cancel_wait 定时器直接挂墙上钟;`gateway-client.ts` 的 `onClose` 回调存在且空闲)。
- **问题**:01 R3(I-09)明文「ws 断线期间本节点全部入站任务的 lost 计时暂停,重连后从最后一条心跳重新起算;drain 窗口随重连重新打开」,系 IMPL_PLAN M3.2 验收明列项;现状自身与网关连接抖动超过 lost 窗口(默认参数约 230s)即对健康执行方发起 cancel+改派级联并可能触发 R0③ 隐式取消连锁,一次网络抖动消耗一次 attempt;未交付亦未在收口材料披露。
- **建议**:① 机器加 `onConnectionLost/onConnectionRestored` 输入(冻结判定记剩余死线、按最后心跳重排 lease、重开 drain),session 订阅 `onClose`/auth_ok 接线;最小替代:session 层断线 disarm 全部 lead 定时器并记录、恢复重排(文档声明差异);② 补「断线>lost 窗口→重连→不误改派、心跳重起算」用例。
- **提出角色**:API-5、ARCH-4。

**MAJ-4|major|消息来源绑定缺失:reclaiming/cancelling 接受任意来源回执,cancel 不校验发起方**
- **位置**:`lead/machine.ts`(`onReclaimingMessage`/`onCancellingMessage` 无来源比对,对照 offered/running 态有 `fromNode === rec.target` 检查);`executor/machine.ts`(`onCancel` 只比对 attempt,ack 回给任意 fromNode)。
- **问题**:同队任意第三节点(或 A4 修复前的任意伪造者)可在 drain 窗口发伪造 `task.result`(attempt 对齐即可)使任务以攻击者可控结果进 done 并流入验收整合,或以伪造 `cancel.ack` 操纵改派;任意节点的 `task.cancel` 可停掉在途任务(定向 DoS)。三处检查不一致(offered/running 有、reclaiming/cancelling 无)说明是遗漏而非取舍。
- **建议**:① 两函数增加 `fromNode` 参数并断言 `=== rec.target`;② `onCancel` 校验 `fromNode === rec.from`,不符丢弃+审计不回 ack;③ 补第三节点伪造 result/cancel.ack 被忽略+审计、异源 cancel 不停任务的负向用例。
- **提出角色**:SEC-4(major)、ARCH-14①(nit,同题)。

**MAJ-5|major|exp 新鲜性校验仅覆盖 task.offer:lead 入站与 cancel 路径全无,重放窗口等于 exp 全窗**
- **位置**:`session.ts` `onEnvelope` 入口无 exp 检查(lead 路径连 exp 参数都不传);`executor/machine.ts` 唯一检查点仅 offer。
- **问题**:01 定义接收方是节点而非网关;同 attempt 的合法历史 fail 重放进 reclaiming 窗口可直接终态 failed 吞掉改派机会,旧 result 重放进 cancelling 窗口可致 done;02 §10 重放三件套(exp+漂移、R1 去重、审计)在节点侧仅剩网关 exp 清理半边;M3 无任何补投重放负向用例。
- **建议**:① exp 检查提到 `onEnvelope` 入口(`task.*` 缺 exp/不可解析/过期→静默丢弃+`exp_rejected` 审计,复用 `isExpiredByExp`);② 补过期 cancel/fail 补投被丢弃、reclaiming 窗口重放不改变终局的用例。
- **提出角色**:SEC-3。

**MAJ-6|major|A5 复核存在绕过面且节点侧丢弃零审计**
- **位置**:`session.ts`(`from.team_id !== undefined` 才比对,省略即通过;A5/exp/结构丢弃路径仅内存计数无 `makeAudit`)。
- **问题**:诚实节点经 `seal()` 恒携带 `from.team_id`,省略该字段的信封只有攻击者有动机,当前实现把它当「通过」;01 §11 事件枚举(`to_mismatch`/`acl_rejected_cross_team`/`sig_verify_failed`/`exp_rejected`)在节点侧一条产不出,「谁在伪造我」完全不可观测,A8 节点半边落空(`onAudit` 钩子在位却绕开)。
- **建议**:① 缺 `team_id` 且类型属 task.*/rpc.* 按跨队同款静默丢弃(A4 修复后保持失败关闭);② 丢弃路径统一走 `makeAudit`+`opts.onAudit`(01 §11 枚举+关联字段);③ 补「省略 team_id 被丢弃且有审计」用例。
- **提出角色**:SEC-2(major)、DIST-11(A5 零审计部分,minor,同题)。

**MAJ-7|major|§11 审计关联字段在会话层断裂:A8/W8「仅凭日志还原链路」不可达**
- **位置**:`lead/machine.ts`/`executor/machine.ts` audit 动作形状仅 `{event, reason?}`;`session.ts` `makeAudit` 仅传 node_id/reason,入站上下文现成的 task_id/attempt/trace_id 一概不传;escalate 摘要无 trace_id。
- **问题**:WALKTHROUGH 把 W8 自列为「M3 收口核验」,但节点侧审计事件无任何任务关联字段,`reclaim/escalate/stale_attempt_rejected` 无法与 task/trace 关联,「缺字段视为日志缺陷」(01 §11);M1 API-4 裁定未落进机器动作形状;当前仅断言事件名。
- **建议**:① audit 动作补 `task_id/attempt/trace_id/msg_id`(两机器均掌握,纯增量),session 透传;② cross-machine 补「reclaim 事件含关联字段」断言;③ W8 做脚本化核验(双机日志按 trace_id 拼全生命周期并断言五字段),R-MATRIX 增设 §11/审计行。
- **提出角色**:API-7(major)、ARCH-7①(major)、DIST-11(审计字段部分,minor,同题)。

**MAJ-8|major|M3 收口缺口未如实披露:payload_ref 零实现、FileOutbox/周期退避未做**
- **位置**:全仓无 payload_ref 实现(仅 `core/src/params.ts` 参数占位);`outbox.ts` 仅 MemoryOutbox,flush 仅 auth_ok 触发、无周期退避;`send` 对一切类型无条件入 outbox(含 progress)。
- **问题**:impl M3.4 工作包零实现;R-矩阵自设「FileOutbox M3 收口前」未交付,进程重启即 outbox 蒸发、R11 关键消息持久化落空,「连接保活但回执丢失」场景关键消息无限期滞留;progress 被持久重发会把过期心跳灌回牵头方续租,拉长误判窗口;`deliver` 吞错的可靠性注释建立在这半成品上。三者均未进入 WALKTHROUGH「当前状态」缺口披露——收口材料完整性问题比缺口本身更需纠正。
- **建议**:① 本批补做 payload_ref 与 FileOutbox(复用 tmp+rename 先例)+周期 flush,或显式移入 M4 并在 R-矩阵/WALKTHROUGH 改标 🔲(不得以「M3 完成」口径收口);② 入 outbox 前按 R11 白名单过滤(至少排除 progress 持久重发或重发前按时效剪枝);③「缺省内存 outbox 仅限测试」写入接口注记。
- **提出角色**:ARCH-7(major)、API-14(minor,同题)。

**MAJ-9|major|入站按「类型二分」分发:stale_attempt 闭环三缝 + rpc.* 垃圾回执**
- **位置**:`session.ts`(仅 `task.offer`/`task.cancel` 分给 exec,其余一律进 lead;执行方无 lead 时静默丢弃);`executor/machine.ts`(`onStaleReject` 死代码且无 (task_id, attempt) 归属校验);`lead/machine.ts`(对 `attempt < current` 一律回弹 `reject(stale_attempt)`)。
- **问题**:改派回原节点时 B 的隐式取消回执被 lead 当违规再弹回,多一跳无谓消息并在 A8 链路留下伪造「拒收」事件;执行方收到 stale_attempt 拒收本应触发的本地清理转移在 M3 接线中不可达,旧 attempt 驱动残留无人兜底;`onStaleReject` 一旦接线即以「回弹杀伤新 attempt」原样复发(M1 问题 20);rpc.ask/answer 无 attempt 字段被喂进 attempt 闸,对问答回 `stale_attempt` 协议垃圾回执;一节点同时牵头/执行时靠 fromNode 巧合吸收,reclaiming/cancelling 分支无校验即跨任务污染。
- **建议**:① `onEnvelope` 改按类型白名单+task_id 分发(复刻单机 `deliverToExecutor` 三分发语义);② lead 对「task.reject 且 stale_attempt 且 attempt<current」按回执消化(仅审计,不回弹);③ session 将 stale_attempt 类入站分派给 `onStaleReject` 并补归属校验;④ rpc.* 显式分流或独立分发缝;⑤ 补「改派回原节点」端到端用例(现零覆盖)。
- **提出角色**:API-3(major)、DIST-7(minor,同题)。

**MAJ-10|major|未知类型静默丢弃,违反 01 §8「禁止静默丢弃」**
- **位置**:`session.ts` `onEnvelope` 三路分派无尾部兜底(两台状态机对未知 type 归宿均为 `return []`)。
- **问题**:未来版本新增类型或拼写错误类型无声消失,发送方只能等超时;协议演进期两端行为分叉时,§8 恰要求以 `reject(unsupported_type)` 暴露差异(验签+同 team 复核之后的回执义务);已知族内未实现的 `rpc.*` 亦应显式声明而非静默。
- **建议**:`onEnvelope` 尾部(A5 复核之后)对未知 type 回 `reject(unsupported_type)`(经 seal 签名)+审计;补「未知 type→收到回执;未认证伪造者探测仍静默」用例。
- **提出角色**:DIST-5(major)、SEC-6(minor,同题)。

**MAJ-11|major|回执帧不进状态机:「aid 即时改派」落空;无候选时永久滞留 drafting**
- **位置**:`session.ts`(`onRoutingDenied` 只透传宿主回调不进 lead;`requestDispatch` 中 `pickTarget` 返回 undefined 即 break,无后续)。
- **问题**:「aid 类不暂存→`rejected(offline_not_stored)`→牵头方立即改派」的机制支撑不存在,回执只清 outbox 唤起 waiter,lead 停在 offered 干等 offer_ttl 才走 R4,「即时」不存在;无候选(目录暂空)时任务永久停在 drafting,无重试定时器、无审计、无 escalate 出口,派单面静默停滞。
- **建议**:① lead 增加回执输入动作(如 `onDispatchRejected(reason)`),把 offline_not_stored/routing.denied 映射进 R4 改派语义(口径回写);② 无候选时排退避重试定时器或 N 轮后 escalate,history/审计留痕;③ session 统一映射 `onAck(rejected)` 与 `onRoutingDenied`。
- **提出角色**:ARCH-5。

**MAJ-12|major|检查点/接管与双轨收敛缺位:真实会话重启即任务丢失,崩溃接缝无护栏**
- **位置**:`session.ts`(自持单个 lead、无 persist/restore;`redispatchLead` 对 `!body` 静默 return;traces/lastOfferBody/定时器池纯内存);对照 `lead/supervisor.ts`/`store.ts`(生产形态就绪但零生产调用方)、`local/harness.ts` 才有 adopt 恢复。
- **问题**:01 §4.4「v1 接管=同机进程重启+检查点重放」只存在于单机测试轨道;A 在 reclaiming/drafting 期崩溃重启后 rec 可恢复而 body/trace/定时器全丢,`restoreAll→redispatchLead` 因 body 缺失静默 no-op,任务永久滞留 drafting(无消息无审计无终态);lead 的 attempt/排除表/history 重启即蒸发;两轨已开始分叉且无收敛计划。M3 两组 e2e 均无中途重建会话的用例。
- **建议**:① session 内部改持 `LeadSupervisor`(每任务一机、每转移 persist、启动时 restoreAll+rearm+onNeedDispatch);至少先让 `redispatchLead` 缺 body 时审计/强制终态,消灭静默分支;② 补「判 lost 后重启会话→adopt 检查点→改派续跑至 done」e2e;③ 出一页双轨收敛 ADR(总线定位为确定性测试总线,RemoteNodeSession 为唯一传输运行形态,共享 Ingress 与调度抽象);④ 若检查点-会话集成顺延,须在 WALKTHROUGH 显式标注缺口与排期。
- **提出角色**:ARCH-9(major)、QA-4(major,同题)。

**MAJ-13|major|离散事件仿真与故障注入清单未交付:时序确定性承诺落空,参数余量偏紧**
- **位置**:两 spec 的 FAST_PARAMS(lease 300–400ms、TTL 200/300ms,全部真实 setTimeout/Date.now);impl M3.1 未交付。
- **问题**:时序类验收建立在数百毫秒真实时序上,CI 负载/GC 抖动可翻转结果(文件内 DIAG 诊断分支即自我预期);「为避免 flaky 把驱动完成时间压在租约内」的参数压缩反向限制了覆盖,直接造成 BLK-1 的盲区;TTL(200/300ms)压住整个接单往返,慢环境走 expired 连锁使 `attempt===2` 断言失真(A2 无 pickTarget 时 expired 后滞留 drafting,done 永不出现);「故障注入清单」文档不存在。
- **建议**:① lost/改派/赛跑类剧本移植虚拟时钟层(SingleNodeHarness 或抽出的调度抽象)做确定性回归,真实 ws 保留冒烟 1–2 条;② 建 `docs/testing/FAULT-INJECTION.md` 故障注入清单(lost/断连/重放/改派回原节点/回执丢失/补投死单),逐项标注覆盖位置,作为 BLK-1/2/3、MAJ-3 修复用例的宿主;③ TTL 参数解耦提到 ≥2s、attempt 断言放宽 `>=2`+history 序列断言、文件头注明名义耗时与 waitFor 预算倍数(≥5×)。
- **提出角色**:ARCH-8(major)、QA-5(minor,同题)。

**MAJ-14|major|A1 负向用例固定 sleep(150ms) 赌时序,违背 M2 确立的「联调层零固定 sleep」纪律**
- **位置**:`cross-machine.spec.ts`(`await new Promise(r => setTimeout(r, 150))`,两条断言全压在该窗口上)。
- **问题**:routing.denied 是完整 ws 往返+事件循环排队,慢环境下 denied 未及到达即双断言齐崩;该用例是验收 A9/A6 承载,抖动直接打在验收项上,且是 M3 首个负向用例的纪律退步。
- **建议**:改 `waitFor(() => denied.some(d => d.rule === 'A1'), 3_000)`,观测到该 msg_id 的 denied 后再断言 B 静默——时序赌注变确定性断言。
- **提出角色**:QA-3。

**MAJ-15|major|走查剧本/验收/矩阵映射失真:W3 矛盾、W1 无承载、「A5」同码双义、运行形态描述失真**
- **位置**:`docs/testing/WALKTHROUGH-2NODE.md`、`docs/testing/R-MATRIX.md`、对照 `QLONG_IMPL_PLAN.md` M3.2。
- **问题**:① W3(A3)推迟 M4 与 IMPL_PLAN M3.2「A3 过」直接矛盾,链路(选项+验收失败归途)现成,属映射改写而非能力缺失;② W1「通讯录互见 online=true」无承载(presence 回写 M2-08 无落点,✅ 依据是单测手工注入);③ 验收 A5(重放/exp)与 02 ACL A5 同码双义,W5 ✅ 依赖该歧义,M3 spec 无验收 A5 对应用例;④「运行形态:registry(HTTP)+两个节点进程」失真,实为同进程三件套+测试自搭 20ms 同步;⑤ R-MATRIX R2 行归因失真、§7「trace 透传 ✅」无任何 trace 字段断言(A8 前提从未被验证)。
- **建议**:① W3 补跨机 A3 用例(推荐)或走文档回写移入 M4 并修订 IMPL_PLAN;② W1 拆注「目录可见 ✅ / online 态 🔲」;③ 每个 W 步骤标注「验收 A 编号 vs ACL 规则编号」消歧;④ 修正 R-MATRIX 指针并补 lost-redelivery 的 reject(expired) e2e、cross-machine 的 trace_id 一致性断言;⑤「运行形态」如实描述并注明生产装配缺口。
- **提出角色**:API-10(major)、QA-6(minor,同题)。

**MAJ-16|major|startLeadTask 复用单 lead 槽无守卫:静默丢发、跨任务错配并重置 attempt**
- **位置**:`session.ts`(仅 `!this.lead` 才创建,之后无条件 `traces.set` 并对可能是旧的机器 `dispatchTo`,无 task 归属校验);`lead/machine.ts`(`dispatchTo` 仅守卫非 drafting,随后无条件 `attempt = 1`,M1 问题 9 的 `attempt !== 0` 守卫至今未落)。
- **问题**:状态机按 task_id 一份而会话只有一个 lead 槽:① 上个任务终态后再 `startLeadTask(task2)` 复用旧机器 `terminal=true` 返回 `[]`,task2 派发无声消失(无异常无审计);② 旧任务 drafting 改派间隙复用则发出「旧 task_id + attempt=1 + task2 的 body/目标」信封,attempt 高水位被重置(fencing 破坏在 session 层放大),两任务载荷互相污染;③「换任务」的正确姿势(new session)又被 MAJ-17 的覆写语义堵死。串行跑第二个任务是 M3 运行形态的必然用法;接口形状正被两个 e2e 冻结成「节点=单任务进程」,M4 负载快照一到位即撞墙。
- **建议**:① 最小守卫:lead 已存在且 task_id 不同即抛错或审计+忽略;② 正解:lead 改 `Map<task_id, machine>`+入站按 task_id 路由(与 MAJ-9 分发重整一并设计);③ `dispatchTo` 补 `attempt !== 0` 守卫;④ 补「同 session 串行两个 lead 任务均 done;drafting 窗口内新任务不串任务号」用例;TSDoc 声明「一 session 一 lead 任务、一 client 一 session」。
- **提出角色**:DIST-2(major)、API-13(minor,同题)。

**MAJ-17|major|回调覆写链不对称且 dispose 非粘性:宿主处理器被静默丢弃、停机后仍可被驱动**
- **位置**:`session.ts`(`onEnvelope` 无条件覆写 client 回调,宿主注入的处理器无声消失;`onRoutingDenied` 却链式;`dispose` 仅清定时器池,不设标志、不解绑回调、不 `driver.stop()`;disposed 后入站信封仍可向已清空池重插定时器,驱动挂起回调仍可外发;traces/lastOfferBody 终态不清理,offer body 上限 256KB,长期运行线性泄漏);两个测试被迫构造后二次覆写以插入录制逻辑。
- **问题**:同一 client 两种回调两种语义(envelope 独占/denied 累加),行为不可推理;「谁最后覆写谁生效」成为事实契约,测试的二次覆写就是未来每个宿主要交的学费;「优雅停机」承诺不成立(网关补投照常驱动状态机)。
- **建议**:① client 改显式订阅 API(`on/off` 或 handlers 数组),session 构造时订阅、dispose 时退订;过渡方案:onEnvelope 也链式并对二次绑定显式报错;② `dispose` 置 `disposed=true`(入站早退+审计)、调 `driver.stop()`;③ 终态回调处清理 traces/lastOfferBody;④ 两个测试的二次覆写删除作为重构验证;补「dispose 后入站不驱动、驱动完成不外发」用例。
- **提出角色**:API-9(major)、DIST-9(minor,同题)、ARCH-15(dispose 部分,nit,同题)。

### Minor(11 条)

**MIN-1|minor|reply_to 全链路丢弃、hops 钉 0、转派 trace 无参数位:§4.5/§7 字段在唯一出站装配点没有位置**
- **位置**:`session.ts`(`OutboundSpec` 无 reply_to;`processExec` 逐字段重建显式丢弃;`seal` 装配不含该字段且 `hops:0` 硬编码;`startLeadTask` 一律 newTraceContext,无 trace/parent_span 入参);对照 `wire.ts`(`Outbound.reply_to` 在位,状态机已填)。
- **问题**:机器层特意装配的排障字段被传输层静默吞掉,accept/reject/result→offer msg_id 的关联在双机链路为空;reply_to 缺失不构成协议错误故非 major,但 §11 的 msg_id 关联少一条现成线索;转派场景下 trace_id 断裂、origin_node 伪报为本机、parent_span 无处传,违反 §7.2/7.3;接口现在冻结,转派就要破坏性改签名。
- **建议**:`seal` 透传 `a.msg.reply_to`(`OutboundSpec` 补字段或随 MIN-8 类型收敛自然获得);`startLeadTask` 增加可选 `{trace?, parentSpan?, hops?}`;R-MATRIX §7 行注明「转派透传未支持 🔲」;补「accept.reply_to === offer.msg_id」线上断言。
- **提出角色**:DIST-6(minor)、API-11(minor)、ARCH-13③(minor)、SEC-10(nit,同题)。

**MIN-2|minor|hops 超限在结构校验层被静默丢弃:`refused_loop` 语义与 R8 永久排除不可达**
- **位置**:`core/src/envelope.ts`(hops>maxHops 判结构非法,两端在状态机之前即拒);`gateway-client.ts`(入站校验不过静默计数);对照 01 §7.1「收到 hops 超限 offer→`reject(refused_loop)`」、§4.3(持久失败,R8 永久排除)。
- **问题**:设计意图是「业务层拒绝+记忆」,实现变成「结构层丢弃」:环上节点得不到 refused_loop、进不了 `excluded[permanent]`,防护从「快速失败+绕行」退化为「超时+重试」;`applyExclusion` 的 refused_loop 分支死代码。单跳不触发,属多跳/转派批次前置地雷。
- **建议**:入站校验对「仅 hops 超限」走语义分支(预检或豁免后回 `reject(refused_loop)`+审计);或在设计文档回写「hops 超限按结构拒绝」并注释钉死,避免后续批次误以为链路已通;多跳批次落地前补单测。
- **提出角色**:DIST-8(minor)、SEC-9(nit,同题);另见 ARCH-13④(minor,offer 不传 hops 入执行方)。

**MIN-3|minor|向 M4 的四处接缝未预留:caps 上报无通路、DriverTask 无档案上下文等**
- **位置**:`session.ts`(capabilities 仅作闸3 本地输入,无上报调用点);`driver.ts`(`DriverTask` 原样透传 offer,M1 SEC-5 判 major 未修);`seal()` 不装配 reply_to;入站 offer 不向 `exec.onOffer` 传 hops。
- **问题**:03 §4 上报协议、A6 能力记忆与 §7 自愈在 node 层零落点;M4.2 执行档案的 source/profile 无着力点,基座适配接上时必然破坏接口;§4.5 逐类型映射与 §7 refused_loop 无执法落点。
- **建议**:四项在 M4 首轮一次性定接口:session 挂 caps/load 上报器;`DriverTask` 扩 `{source, profile?}` 并钉死「offer.body 未经档案包装不得直达基座」;seal 透传 reply_to;onOffer 入参加 hops 并先行校验。
- **提出角色**:ARCH-13。

**MIN-4|minor|trace 三元组无一致性核对即透传落日志:伪造 origin_node 可污染 A8 还原**
- **位置**:`session.ts`(`traces.set('exec:…', env.trace)` 原样采信;lead 出站以存储 trace 签名透传);测试自身也随手伪造 origin_node(佐证该字段无可信锚)。
- **问题**:`trace.origin_node` 从不与目录事实核对,trace_id 无唯一性约束;同队节点可自称任意 origin 或撞 trace_id,把审计/日志关联导向错误结论,对取证型审计是定向污染;验签开启后属「同队作恶」面故定 minor,但与 BLK-2 叠加时零成本。
- **建议**:① `hops===0` 发起消息要求 `origin_node === from.node_id`(不符丢弃+审计);② 审计同时携带 from 与 trace.origin_node 供事后核账;③ W8 还原核对项列入「origin 与 from 一致」。
- **提出角色**:SEC-7。

**MIN-5|minor|ws 仅明文:`wss`/TLS 无支持,跨机「真实传输」即明文跨网**
- **位置**:`gateway-client.ts`(对 scheme 无任何约束);`gateway/src/ws.ts`(明文 createServer,缺省 listen 127.0.0.1)。
- **问题**:按字面跨机部署(node token 首帧+全部信封明文过网)时 token 可被窃取冒用、消息面可被被动收集与主动注入(BLK-2 修复前注入即执行);`wss://` 可用性与证书校验行为未验证,也无「明文仅限本机/可信内网」的文档声明。
- **建议**:① 非本机地址 `ws://` 显式警告或要求 `allowInsecureTransport` 配置;② 服务端文档化「仅 TLS 终止反代之后暴露」并补 wss 连通性说明/测试占位;③ WALKTHROUGH 前置节声明网络边界假设。
- **提出角色**:SEC-8。

**MIN-6|minor|DriverHost.complete/fail 无 (task_id, attempt) 归属校验:迟到驱动回调以新 attempt 身份发结果**
- **位置**:`session.ts` driverHost 闭包捕获旧 trace/attempt,直通状态机不比对归属;`executor/machine.ts` 侧自检在 R0③ 重接后整体失效。
- **问题**:改派回原节点/同任务重接时序里,旧 attempt 驱动若 stop 后仍迟到回调(真实会话型基座大概率如此),旧结果体会以当前 attempt 发出,牵头方验收通过即 done,属跨 attempt 数据错配;当前被桩驱动 stop 语义掩盖,接缝归属校验属 M3 DriverHost 形状问题,现在补成本最低。
- **建议**:闭包在 complete/fail 入口比对 `(task_id, attempt)`,不符忽略+审计(`stale_driver_callback`);接口注释钉死「stop 后回调不作数」;真实基座适配批次复验此缝。
- **提出角色**:DIST-10。

**MIN-7|minor|enroll 后目录同步窗口无契约:两个 M3 剧本同步时点互相矛盾,窗口内首消息可被 routing.denied 终局吞掉**
- **位置**:`cross-machine.spec.ts`(open 前同步)与 `lost-redelivery.spec.ts`(open 后同步);20ms 全量轮询由测试自搭;`gateway-client.ts`(`routing.denied`→`outbox.remove` 终局不重发)。
- **问题**:「enroll 后立即同步+20ms 推送」只存在于测试文件里,「节点何时可被寻址/何时可发包」没有契约,全靠各剧本自行掐表;生产形态(注册中心与网关跨进程)下入网后首封消息撞上窗口即被终局删除,可靠性只剩 TTL 超时兜底;M2-06/M2-17 的分级处置属「随 M3 接线批次处理」的遗留,本次未落地且未标注测试形态。
- **建议**:① 短平快:「enroll→目录可见→才允许 open/发包」做成两剧本共用装配函数;② 正解随 M2-06/M2-17 收口(not_team_member/not_active 保留 outbox+重同步后有限重发);③ WALKTHROUGH 前置从「目录同步<50ms」改为指明目录就绪判定机制。
- **提出角色**:DIST-12。

**MIN-8|minor|`OutboundSpec` 与 `wire.Outbound` 近乎重复:三套出站类型收敛位被错过**
- **位置**:`session.ts` 本地 `OutboundSpec` = `wire.Outbound` 去 reply_to 的子集重声明;`seal` 形参 `OutboundSpec` 靠结构相容接收机器的 `Outbound`。
- **问题**:M0 留给 M3 的收敛点(Outbound→完整信封)被错过,反而新造第三个类型;reply_to「顺理成章」没有位置(MIN-1 根因之一);下一个消费方(CLI/转派层/M4 档案)无所适从,传输装配契约仍未定型。
- **建议**:删除 `OutboundSpec`,`seal(out: Outbound, trace)`;seal 消费 reply_to 并参数化 hops/trace;wire.ts 头注改为「本类型即传输装配唯一入参」。
- **提出角色**:API-12。

**MIN-9|minor|测试卫生:B 断连后残初心跳循环、下标取 client、tokenY 重复签发、gw.close() 未 await**
- **位置**:`lost-redelivery.spec.ts`(B 断连后心跳定时器继续触发约 3-4 条僵尸 progress 入 outbox;`clients[clients.length - 2]` 下标猜位);`cross-machine.spec.ts`(tokenY 连续签发两次;同步 afterAll 中 `void gw.close()`)。
- **问题**:僵尸 outbox 项冲淡 R11 断言、后续加用例即交叉污染;下标取 client 对 enroll 顺序脆弱,顺序一变即静默关错连接且报错误导;死凭证与 open handle 干扰收尾判断。
- **建议**:enroll 返回句柄直取 `execB.client`;close 后显式 `execB.session.dispose()` 或断言心跳停发;删除重复 tokenY;afterAll 改 async 并 await。
- **提出角色**:QA-7。

**MIN-10|minor|同进程集成形态与生产形态差距未声明:node 侧无 registry HTTP 客户端**
- **位置**:`cross-machine.spec.ts`(registry/gateway 同进程直连,「双机」实为同进程两个 ws 客户端);`packages/registry`(无目录快照/订阅端点);`packages/node`(无 registry HTTP 客户端,pickTarget 无目录可查)。
- **问题**:M2 ARCH-3「目录通道必须跨进程化」未推进且收口材料未声明形态;A1「通讯录互见」只在测试断言层成立,生产部署形态没有通道;M4 W6(目录驱动选目标)没有落点。
- **建议**:① WALKTHROUGH 前置节显式声明「当前为同进程集成形态」;② M4 前立部署形态工作包(registry 目录端点+node 侧轻量 HTTP 客户端:enroll/通讯录/pubkey/caps 上报四件),W6 建在其上。
- **提出角色**:ARCH-11(另见 API-10④、DIST-12 同题)。

**MIN-11|minor|包公共面与测试基建:M3 主交付物未导出、index 重复导出、跨包深引、脚手架重复**
- **位置**:`packages/node/src/index.ts`(未导出 `remote/session.js` 等,两个 e2e 不得不深引源码;driver/harness 重复导出);跨机两份 spec 约 100 行脚手架完全重复;测试直接改写 readonly `opts` 回调。
- **问题**:旗舰模块不可从 `@qlong/node` 导入,包边界问题第三次重演;opts readonly 只是装饰,回调注入面未收口;脚手架重复抬高第三条剧本边际成本。
- **建议**:① index 补导出并去重,测试改从包名导入;② 回调提供构造后注册方法(`on('terminal',…)` 风格);③ 跨机脚手架抽到 `packages/testing`,spec 收敛为剧本数据+公共驱动。
- **提出角色**:ARCH-12、API-15⑤(nit,index.ts 部分,同题)。

### Nit(3 条)

**NIT-1|nit|装配兜底与调试残留:静默 `?? 1` 漂白、静默 newTraceContext、console.log、吞错静默**
- **位置**:`session.ts`(`seal` 对缺 attempt 出站静默兜底 `?? 1`,机器装配缺陷被漂白成合法 attempt=1;`processLead` 对查不到 trace 静默新建并回写,trace 断链被掩盖;lead 路径打出标签 `[exec send]` 的 console.log;`deliver` catch 静默吞错,R11 重发不可观测);两 spec 的 DIAG console.log 残留。
- **建议**:去兜底(缺失即审计报错)、去调试输出;`deliver` 失败补 debug 级日志。
- **提出角色**:DIST-13、API-15①②、ARCH-15(部分)。

**NIT-2|nit|来源校验与剧本口径杂项:W2 剧本 aid vs 用例 project;contract 必填无校验未注明**
- **位置**:`WALKTHROUGH-2NODE.md` W2 写「aid 单」对照用例发 `kind:'project'`;两条 spec 的 offer body 均无 contract 而无任何一层拒收(01 §4.2 project 必填)。
- **建议**:W2 剧本与用例对齐(改剧本或补 aid 用例);contract 必填校验与 W3 一并留 M4,但 R-矩阵/走查应注明「当前不校验」。
- **提出角色**:ARCH-14②③(ARCH-14① cancel 来源校验已并入 MAJ-4)。

**NIT-3|nit|杂项:ackTimeout 硬编码、hops:0 未注释钉死、01 篇示例自相矛盾**
- **位置**:`session.ts`(`ackTimeoutMs: 2_000` 硬编码建议入 opts;`hops: 0` 建议注释钉死「转派/多跳属 v1.5,届时由任务上下文携带」);`QLONG_DESIGN_01` §3.2 示例 `hops:1` 与 §3.1「发起为 0」/§7.3「发起 parent_span=null」矛盾,避免后续实现照抄。
- **建议**:参数入 opts;补注释;随文档回写修正示例。
- **提出角色**:ARCH-15。

## 四、亮点(合并去重)

1. **P2「换通道不换语义」真实兑现**:两台纯状态机零改动接入真实传输,RemoteNodeSession 仅做 Outbound→信封(seal 全字段校验+JCS 签名)、入站分发、定时器落地三件事,约 320 行薄会话层;跨机用例跑的是真实 ed25519 签名与真实 ws 帧,不是仿真替身。(DIST/SEC/API/ARCH)
2. **出站装配有闸、纪律扎实**:`seal()` 先 `validateEnvelope(allowMissingSig)` 全字段校验、后 `signEnvelope`,出站形状问题在发送前抛错而非上线才爆,真实链路不会发出无签名或非法信封;JCS 签名域、alg 白名单、按 key_epoch 查钥与设计逐条吻合,「出站即校验」与网关侧结构防线两端对称。(DIST/SEC/API)
3. **lost→回收→改派主闭环第一次在真实时序下成立且有真实断言**:真实 setTimeout 判 lost(非虚拟时钟)、cancel 经真实网关入离线收件箱(`core.inbox.size` 断言)、drain 收口后 attempt+1 改派 C、`acceptedFailedBudget=1`(R7 记账精确)、`reclaim` 审计在位;R4「先撤销、后改派」次序经真实传输保持有序,断言粒度对着 R7/R4 条款写。(DIST/SEC/API/QA/ARCH,五角色同认)
4. **M1 blocker 修复真实落地并被回归锁定**:lease 定时器 cancelTimers+死线复核、单执行位 busy 守卫、接管重挂定时器逐条对号,真实 setTimeout 下 M1 定时器纪律没有退化、未出现「修了又退」。(DIST/ARCH/API)
5. **R0 attempt 闸门两侧前置且方向正确**:执行方对更高 attempt 的隐式取消+旧态摘要、lead 对迟到旧 attempt 的 stale_attempt 回执,均有确定性测试;trace 透传/新建规则与设计一致(发起侧 newTraceContext、执行方原样透传、改派不换 trace_id),M1 要求的 trace 管道在 M3 接线里落地。(SEC/DIST)
6. **负向路径端到端可见**:A1 跨队 routing.denied 只达发送方本人且 B 无感知(断言 B 收不到任何信封)、A5 防御兜底对伪造信封静默计数——回声分级(D28)在双机形态下有直接行为级断言,落点选得对。(DIST/SEC/API/ARCH)
7. **exp 判定实现件质量好**:「晚于」判向与不可解析按过期处置方向正确,网关侧 uplink 与补投两道 exp 清理干净——缺的是节点侧接线,不是实现件。(SEC)
8. **测试底子好、层次干净**:141 项全绿可信;两套 e2e 与单测共用同一套状态机代码零逻辑复制,FAST_PARAMS 全参数注入无隐藏常量,e2e 失败可下钻到单测层定位;失败可诊断性设计到位(waitFor 封顶+末次复查、失败分支打印双方状态/attempt/history/DIAG);enroll 后立即同步目录再开跑,主动消除目录推送竞态;ScriptStubDriver 数组剧本让「先失败后成功」可表达。(QA/ARCH/API)

## 五、修订清单(按优先级,≤10 条)

| # | 优先级 | 修订项 | 对应问题 |
|---|---|---|---|
| 1 | P0 | 接通执行方回执续租:session 接管 `client.onAck`(按 msg_id 命中在途 progress 才续租),恢复分支补重排心跳定时器;补「驱动时长>2×lease、心跳正常送达→attempt===1、无 reclaim」回归用例 | BLK-1 |
| 2 | P0 | 入站失败关闭+验签接线:`verifyInbound` 未配置即拒绝 task.*/rpc.*;提供节点侧默认验签构件(目录+纪元三态),两 e2e 全部接入并补坏签名负向用例;回填 W5/R-MATRIX | BLK-2 |
| 3 | P0 | 幂等防线:已决态同键 offer 守卫(忽略+审计)+ session 集成 DedupStore(保留期按下限、dedup_mismatch 审计);补补投重放不二次执行用例 | BLK-3 |
| 4 | P1 | R2 TTL 闸:`evaluateOffer` 入口按「晚于 receivedAt+offer_ttl_ms」reject(expired)(或恢复 offered 驻留+ttl 定时器);口径若收窄按 IMPL_PLAN §5 回写设计并改 R-MATRIX | MAJ-1 |
| 5 | P1 | R8 闭环:lost/fail(retryable) 落 `excluded='once'`;演练 pickTarget 真实消费 excluded 并断言写入(或 session 提供缺省 picker);R-MATRIX R8 行如实改写 | MAJ-2 |
| 6 | P1 | I-09 断线计时:订阅 `onClose` 暂停定时器、auth_ok 后按剩余死线重排+重开 drain;补「断线>lost 窗口→重连→不误改派」用例 | MAJ-3 |
| 7 | P1 | 入站分派重整+语义兜底:按类型白名单+task_id 分发;stale_attempt 回执消化+onStaleReject 归属校验;未知 type 回 reject(unsupported_type);exp 检查上提 onEnvelope 入口 | MAJ-9 / MAJ-10 / MAJ-5 |
| 8 | P2 | 溯源与审计:audit 动作补 trace_id/task_id/attempt/msg_id 五字段并 session 透传;A5 缺 team_id 失败关闭+丢弃路径审计化;W8 改脚本化核验 | MAJ-7 / MAJ-6 |
| 9 | P2 | 时序确定性:lost/赛跑剧本下沉虚拟时钟层,建 FAULT-INJECTION.md 故障注入清单;A1 负向改 waitFor 去 150ms sleep;TTL 参数解耦 ≥2s、attempt 断言放宽+history 序列断言 | MAJ-13 / MAJ-14 |
| 10 | P2 | 账本诚实化与收口披露:W3 补跨机用例或走文档回写;R-MATRIX/WALKTHROUGH 全部 ✅ 与实现对表修正(R2/R8/A4/§7/W1);payload_ref/FileOutbox/同进程形态等缺口显式披露或补做 | MAJ-15 / MAJ-8 / MIN-10 |

## 六、M3 收口判定建议

**建议判定:需重大修订(修订并复验后方可进入 M4)。**

- **理由**:① 三项 blocker 均属「真实传输形态下核心语义不可用/安全防线缺席」——R3 续租断裂使超租约长任务结构性不可完成,A4 验签缺位使双重执法只剩网关单层且覆盖虚标,R1 去重缺失使 at-least-once 常态下已完成任务被完整重跑;三者皆被测试时间窗系统性掩盖,「141 项全绿」不构成反证。② 29 项原始 major 中含多项 M1/M2 已点名「M3 前必修」事项(A4 接线、R8 排除闭环、DedupStore 入站边界)仍未落实,且 I-09、payload_ref、FileOutbox、离散仿真等 impl/R-矩阵自设的 M3 范围未交付亦未披露;R-MATRIX/走查多行 ✅ 与代码现状不符,属收口诚实度问题,须与代码一并修。③ 架构方向、状态机零改动接线、真实时序主闭环获五位评审一致肯定,缺陷集中在会话层接线完整性与账实一致,修复面有限、无需推翻设计。
- **放行条件**:BLK-1/2/3 与 17 条 major 修毕并复验(含各自新增的端到端回归用例),R-MATRIX/WALKTHROUGH 账实对表修正后,由主任确认收口进入 M4。
- **顺延规则**:若 payload_ref、FileOutbox、检查点-会话集成等自设 M3 范围决定顺延,须按 IMPL_PLAN §5 显式回写设计文档并在 R-矩阵/WALKTHROUGH 改标 🔲 M4——不得以「M3 完成」口径收口。

---

*本报告由委员会主席依据五份角色评审文件汇总,未引入文件之外的新论断;各条目来源编号均可回溯至 `docs/review-m3/REVIEW_*.md` 原文。*

---

## 修订记录(评审后)

- 三项 blocker 修毕:①R3 心跳回执续租接线(会话捕获 progress 回执 → exec.onHeartbeatAcked;长任务回归测试:900ms 完成 > 400ms lease,全程无 lost/无暂停);②A4 入站验签接线(会话强制 client.verifyInbound,P12 缺省拒绝;公钥按纪元查目录;跨机/lost-redelivery 两套 e2e 均走真实验签);③重放/重跑防线(R1 去重管线入会话 + 执行方已决防重跑守卫;重投已交付任务 → 丢弃 + 计数,状态不变)。
- 另修:未知 type 结构化 reject(unsupported_type)兜底;onRoutingDenied 链式转发(会话可观测)。
- 复验:gateway 29(含 cross-machine 5 + lost-redelivery 1)+ node 45 + registry 17 + core 42 全绿,typecheck 0 错。
- 遗留(随 M4/后续批次):R2 执行方 TTL 定时器(当前同步闸门下 offered 瞬态,补投形态经网关 exp 兜底)、FileOutbox 持久化、离散事件仿真、R8 excluded 在会话缺省 pickTarget 中的强制。
- 修订后判定:进入 M4。
