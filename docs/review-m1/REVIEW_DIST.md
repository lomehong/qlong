# M1 评审意见:分布式语义与可靠性(DIST)

> 评审对象:M1「单机核心」packages/node + packages/cli 全部源码与测试;对照基线 = `QLONG_DESIGN_01_MSG_PROTOCOL.md`(下称 01)、`QLONG_DESIGN_03_CAPABILITY.md`(下称 03)、`QLONG_IMPL_PLAN.md`、`docs/testing/R-MATRIX.md`。
> 评审视角:租约/心跳时序、回收与改派语义(R3/R4/R5/R7/R8)、attempt 口径、检查点接管、单机总线虚拟时钟确定性。其余视角(协议编码/安全/工程结构)归队友。
> 行号以本次评审时点文件内容为准。

## 结论(verdict)

**需重大修订。**

存在 1 项 blocker:牵头方心跳续租不取消旧 lease 定时器,任何存活超过首个租约死线(默认 230s)的健康长任务必被误判 lost 并进入改派循环直至 escalate——M1 自己的集成测试(最长 150s)恰好全部落在死线之下,未能暴露。另有 5 项 major(R2 执行方过期判定生产路径不可达、R5 租约超时自检缺失、R8 排除只记不用且 fail/lost 路径不记录、接管后 attempt 可回退、虚拟时钟同刻定时器序未定义)。R4 撤销-改派次序、R7 双预算、R0 特别则等主干语义实现正确、可测性意识好,修掉上述问题后骨架可保。

## 摘要

- **blocker ×1**:lead 侧 `task.progress` 续租只排新定时器不取消旧定时器,`onTimer('lease')` 又无 deadline 复核 → 误判 lost(R3 违反,长任务功能性死锁)。
- **major ×5**:R2 执行方 TTL 守卫不可达(`offered` 态是死代码,测试靠状态注入);R5 自检漏「本地租约已超时」分支;R8 排除语义不闭环(只记录不使用、fail/lost 不记录);`dispatchTo` 无条件重置 attempt=1 破坏接管 fencing;harness 同刻定时器按插入序触发,边界赛跑结论不稳定。
- **minor ×6 / nit ×3**:reclaiming/cancelling 不校验来源节点、R3 lost 锚点偏差一拍、accept 可上调租约、busy 无 retry_after 不排除、fail_sent 收 cancel 不回 ack、赛跑窗口内 result 绕过验收校验;不变式断言零调用、包导出面缺漏、若干口径小疵。

## 问题清单(按严重度排序)

---

### DIST-1|blocker|心跳续租不取消旧 lease 定时器,长任务必被误判 lost

- **位置**:`packages/node/src/lead/machine.ts` L218-222(`onRunningMessage` 的 `task.progress` 分支,仅返回 `{kind:'schedule', timer:'lease'}`,无 `cancelTimers`);L305-310(`onTimer('lease')` 仅判 `state==='running'`,无 `now ≥ rec.leaseDeadline` 复核);`packages/node/src/local/harness.ts` L128-130(`schedule` 直接追加)、L110-114(`cancelTimers` 仅由动作驱动)。
- **问题**:每次心跳续租都会向 harness 定时器表**追加**一条新的 `lease` 定时器,旧定时器仍然存活且到期更早。最早一条(accept 时刻排的 `accept+lostAfterMs`)先触发,`onTimer('lease')` 不核对当前 `leaseDeadline` 即判 lost → `beginReclaim`。默认参数(lease=300s,grace=30s,lost=230s)下,**任何运行超过 230s 的健康任务**(心跳每 100s 正常到达)在 t=230s 被误回收;改派后新 attempt 的首个 lease 定时器又在 +230s 误触发,循环烧尽 `max_attempts=3` → escalate。对照执行方:`ExecutorMachine.onHeartbeatAcked`(executor/machine.ts L230-238)续自身租约时**先 `cancelTimers(['lease_self'])` 再排程**,不对称恰好证明 lead 侧是遗漏而非设计。
- **依据**:01 §6 R3「心跳即续租」「lost 判定公式:自最后一个应收心跳的预计时刻起……仍无心跳 → 判 lost」;01 §5.1 running 状态转移。误判 lost 属协议违反,且造成长任务永远无法完成的**功能性死锁**。
- **测试盲区**:`integration.spec.ts` L7-17 主路径 `completeAfterMs:150_000`,150s < 230s,`finish()` 的 `stopTimers` 恰好在误触发前清场;其余用例均在 1-3s 内失败/完成。全套 37 项无一覆盖「心跳存活跨过首个 lost 死线」的场景——这正是 R-矩阵 R3 行(✅)未兑现的部分。
- **建议**:① `task.progress` 分支返回 `[ {kind:'cancelTimers',timers:['lease']}, {kind:'schedule',…} ]`(与执行方 `onHeartbeatAcked` 对齐);② 防御性兜底:`onTimer('lease')` 增加 `if (now < (this.rec.leaseDeadline ?? 0)) return []` 复核;③ 补一条集成用例:心跳存活 ≥ 2×lostAfter 的长任务跑完,断言 `attempt===1`、无 `reclaim` 审计。

---

### DIST-2|major|R2 执行方 offer 过期判定在生产路径不可达

- **位置**:`packages/node/src/executor/machine.ts` L137-192(`evaluateOffer`:闸2/3/4 之后**无条件**置 `state:'running'` 并 accept,全程无 `now` 与 `offer_ttl_ms` 的比较);L205-215(`onTtlCheck` 要求 `state==='offered'`);`ExecutorState` 的 `'offered'` 与 `timer:'ttl'` 在生产代码中**从未被赋值/排程**(全仓 grep 证实:`state: 'offered'` 仅出现在测试的状态注入里)。
- **问题**:offer 到达即同步评估接单,「执行方按本地时刻判 offer 过期」这条 R2 语义没有可执行的路径。设计明言的必测场景——**长期离线节点上线后收件箱批量过期 offer → 整批 `reject(expired)`**(01 R2,评审 I-38「晚于」判过期)——在当前实现下会被照单全收并开跑僵尸任务,只能靠牵头方 offer_ttl 定时器事后回收。测试 `executor.spec.ts` L75-84 只能靠 `Object.assign(m.rec, { state:'offered', … })` 后门到达该分支,测试注释自己也承认「offered 为瞬态」——但生产代码里它根本不是「瞬态」,是**不存在**。
- **依据**:01 §6 R2;01 §4.2 `offer_ttl_ms`(「执行方按 R2 独立判过期」);02 §8 离线暂存语义(补投后由端上独立判过期)。
- **建议**:`evaluateOffer` 入口增加过期闸(在闸2 之前或之后均可,建议最前):`if (o.now > o.receivedAt + offerTtlMs) → reject(expired)`(「晚于」严格比较,与 `onTtlCheck` L209 口径一致);或真正落地 offered 暂存态 + ttl 定时器。同时把 `R-MATRIX.md` R2 行的 ✅ 降级/加注——当前用例未覆盖生产路径。

---

### DIST-3|major|R5 僵尸自检缺「本地租约已超时」分支,paused 后完成仍发 result

- **位置**:`packages/node/src/executor/machine.ts` L250-269(`onDriverCompleted` 仅检查 `this.rec.cancelReceived`);L240-248(`onLeaseSelfTimeout` 置 `paused=true` 后,`onDriverCompleted` 对 `paused` 视而不见)。
- **问题**:R5 明文:「执行方发送 result 前自检——**已收到 cancel 或本地租约已超时(R3 执行方计时器)** → 不发 result,回 `cancel.ack`」。实现只实现了前半个条件。租约超时(`paused=true`)后驱动若仍完成(桩驱动 `pause()` 是空实现,真实基座下「暂停后完成」完全可能),执行方会照发 `task.result`——这既违反 R5,也违反 R3 执行方侧「超时**立即暂停产生新副作用**」(发 result 就是新副作用)。协议上靠 lead 的 R0 stale 拒收兜底,但恰好把设计专门为「僵尸防护」立的规则架空了。
- **依据**:01 §6 R5;01 §6 R3(执行方对称计时器);01 §5.2。
- **建议**:`onDriverCompleted` 改为 `if (this.rec.cancelReceived || this.rec.paused) → state='stopped' + cancel.ack`(租约超时场景按 R5 回 ack,可附 `detail` 区分原因);`onDriverFailed` 同理自检。补用例:`onLeaseSelfTimeout` 后 `onDriverCompleted` → 断言发的是 `cancel.ack` 而非 `task.result`。

---

### DIST-4|major|R8 排除语义不闭环:fail/lost 路径不记录,excluded 全仓无读取方

- **位置**:`packages/node/src/lead/machine.ts` L388-399(`applyExclusion` 仅被 `onOfferedMessage` 的 reject 分支调用,L206-212);L236-249(`task.fail` 路径只 `beginReclaim`,不排除);L300-310(lost 路径不排除);L396-397(busy 一律不排除,见 DIST-10);`rec.excluded` 除测试断言(`lead.spec.ts` L112)外**全仓无任何读取方**;`supervisor.ts` L49-61(无选目标逻辑);`harness.ts` L125-127(`requestDispatch` 硬编码改派回 `nodeBId`)。
- **问题**:三处缺口。① **记录面缺失**:R8「其余瞬时 retryable 仅排除一次」覆盖 `task.fail(retryable)`(如 `internal_error`,§4.3 明言「同节点最多一次」)、`caps_missing`(✅换目标)——这些路径一个都不记 `excluded`;判 lost 节点也不记(01 R8「判 lost 节点的排除按 R4 取消衔接处理」,至少应记 once)。后果在 M1 demo 里就现形:`cli demo` 对同一节点连续三次 `internal_error` 重试(三次全派 nodeB),第 2 次起已违反「同节点最多一次」。② **使用面缺失**:`excluded` 写了没人读,R-MATRIX L18 披露了「过滤在 supervisor 选目标时执行,M2 集成」——这部分算已披露;但**记录面缺失未披露**,且 M1 的 harness 改派硬编码 nodeB,连「排除后改派他人」的语义在 M1 都无从演练。③ R-矩阵 R8 行标 ✅(部分),实际兑现的只有「reject 码分类」一格。
- **依据**:01 §6 R8;01 §4.3 fail 码表(`internal_error` 同节点最多一次 / `caps_missing` 换目标)。
- **建议**:`beginReclaim`/`budgetOrEscalate` 按 origin 记录——fail(retryable) → `excluded[node]='once'`,lost → `'once'`,验收失败 → 不排除(重做可回原节点,合理);supervisor 增加带 `excluded` 过滤的选目标接缝(哪怕 M1 只有单候选,也应让 harness 的 `requestDispatch` 处理器读 `rec.excluded` 并在无可用目标时走 escalate/等待分支,而非硬编码);R-矩阵相应行如实降级。

---

### DIST-5|major|接管恢复后 dispatch/redispatch 可混用,attempt 可被重置回退

- **位置**:`packages/node/src/lead/machine.ts` L127-131(`dispatchTo` 守卫仅 `state!=='drafting'`,随后**无条件 `this.rec.attempt = 1`**);`packages/node/src/lead/supervisor.ts` L49-61(`dispatch` 与 `redispatch` 两个公开入口,语义区分全靠调用方自律);`packages/node/src/lead/checkpoint.ts` L43-55(`pendingTimers` 对 `drafting` 返回空,重启后没有任何「该任务正等改派」的重放信号)。
- **问题**:改派中途(预算判定后、`redispatchTo` 前)崩溃的任务,检查点里是 `state:'drafting'` 且 `attempt≥2`。恢复后调用方若误用 `supervisor.dispatch`(与初始派发同名同形),attempt 被重置为 1 重新派发——§3.1「执行权纪元」单调性被破坏:旧执行方手中在途的 attempt=2 消息会被新 offers 的 attempt=1 反超,R0 fencing(正是 01 §4.4 为跨机接管预留的前置条件「attempt 高水位」)在本机接管场景先失守。API 层面无任何守卫或区分,`checkpoint.ts` 头注宣称「检查点自带 attempt 高水位」仅指 `rec.attempt` 字段存在,防不了这条回退路径。
- **依据**:01 §3.1(attempt 定义与递增口径);01 §4.4 接管前置条件;01 §6 R0。
- **建议**:`dispatchTo` 增加 `if (this.rec.attempt !== 0) return []` 守卫(或与 `redispatchTo` 合并为单一入口,内部按 `attempt===0` 分流);恢复流程对 `attempt>0 && !terminal && state==='drafting'` 的任务显式重发 `requestDispatch`;补用例:改派中途崩溃 → 恢复 → 断言 attempt 继续递增、旧 attempt 不被复用。

---

### DIST-6|major|harness 虚拟时钟同刻定时器按插入序触发,边界赛跑结论不稳定

- **位置**:`packages/node/src/local/harness.ts` L92-104(`advanceTo`:`sort((a,b)=>a.at-b.at)` 取最早者,同刻时依赖 ES 稳定排序 = **插入序**;无任何 owner/type 优先级规则)。
- **问题**:同刻定时器的触发顺序完全由「谁先被排程」决定,而协议对边界的约定并不统一(R2 执行方「晚于」才过期 = 到点仍有效;lead 的 offer_ttl 定时器到点即收;machines 层对 `now === deadline` 无定义)。两个具体反例:① 自定义参数 grace=0、lease=3000(心跳 1000ms)时,progress@t 后 lead 死线 t+2000 与执行方心跳 t+2000 同刻——lease 定时器在 t 时刻插入、心跳在 t+1000 插入,插入序使 **lease 先触发 → 误判 lost**,而按 R2 式「到点仍有效」约定应心跳先到完成续租;② 驱动完成与 lease 死线同刻时,driver 回调(accept 时插入)恰先于 lease 定时器插入,结果为 done——若插入序相反则变成 lost→cancel→ack→改派。**同一物理场景因调度插入顺序不同得出相反终态**,即评审重点所指的假阳性/假阴性:当前默认参数(230 与 100 的倍数错开)回避了全部同刻,所以 37 项测试全绿,但 M3.1 离散事件仿真明确要「赛跑/超时确定性复现」,将直接继承这套未定义语义。
- **依据**:01 §6 R2(「晚于」边界约定)/R3/R4(赛跑窗口语义);`QLONG_IMPL_PLAN.md` M3.1(离散事件仿真是 M1 harness 的直接下游)。
- **建议**:在 harness 定义并文档化显式 tie-break,建议:同刻时按「消息投递/驱动回调(代表已发生的事实)> 执行方心跳 > 超时类定时器」排序,同 owner 同刻按排程序;并把 machines 层对 `now === leaseDeadline`、`now === offerTtlUntil` 的取舍与 R2「晚于」对齐(lead 的 offer_ttl 亦应「到点不收、晚于才收」,或在 R-矩阵注明两处口径差异是有意的);补一条同刻赛跑的确定性用例锁定该规则。

---

### DIST-7|minor|reclaiming/cancelling 态不校验消息来源节点

- **位置**:`packages/node/src/lead/machine.ts` L257-281(`onReclaimingMessage`)、L283-296(`onCancellingMessage`)——均不接收/不校验 `fromNode`;对照 L216-217(`onRunningMessage` 首行 `if (fromNode !== this.rec.target) return []`)。
- **问题**:running 态校验来源,reclaiming/cancelling 却不校验:窗口期内任何同队节点发来的伪造/串线 `task.result`(attempt 恰为当前值)都能把任务标 done。attempt 闸门挡不住「当前 attempt」的冒名,因为闸门只对数不对人。
- **依据**:01 §5.1 状态机(竞态出口的前提是「收到执行方消息」);01 §4.4(在途 `(task_id, attempt, 执行方)` 三元组——执行方身份本就是记录的一部分)。
- **建议**:两处签名补 `fromNode` 并统一 `fromNode === this.rec.target` 校验;不匹配 → 忽略 + 审计。harness 的 `deliverToLead` 目前硬编码 `from=nodeBId`,顺带把来源做成参数以便测试。

---

### DIST-8|minor|R3 lost 判定在 accept 时点提前一个心跳间隔,与公式锚点不符

- **位置**:`packages/node/src/lead/machine.ts` L197-199(accept 时 `leaseDeadline = now + lostAfterMs(lease)`);`packages/core/src/params.ts` L63-66(`lostAfterMs = 2×(lease/3)+grace`)。
- **问题**:R3 公式的锚点是「**最后一个应收心跳的预计时刻**」。accept 后首个心跳预计于 `accept + lease/3`(01 §5.3 时序图),故首个死线应为 `accept + lease/3 + 2×lease/3 + grace = accept + lease + grace`;实现从 accept 直接加 `lostAfterMs`,提前了一个心跳间隔(默认参数 300s vs 430s,差 100s)。方向上偏保守(仍先于执行方本地租约 `accept+lease` 超时,不变式不破),但首个心跳因真实调度抖动迟到超过 `lease/3 + grace` 即误判 lost——比设计允诺的容忍窗(2×lease/3+grace)少了一半。progress 到达后的重锚(`arrival + lostAfterMs`)与公式一致,仅 accept 锚点有偏差。
- **依据**:01 §6 R3;01 §5.3 正常时序(首跳 ≈lease/3)。
- **建议**:accept 时 `leaseDeadline = now + lease/3 + lostAfterMs(lease)`;或实现保持现状、回写设计文档注明「accept 视为虚拟心跳」的口径决策(实现偏离一律走文档回写,见 IMPL_PLAN §5)。

---

### DIST-9|minor|accept 可上调租约,违反「确认或下调」约定

- **位置**:`packages/node/src/lead/machine.ts` L197-199(`const lease = typeof body.lease_ms === 'number' ? body.lease_ms : this.rec.leaseMs`,无上限钳制)。
- **问题**:01 §4.2 `lease_ms`:「执行方在 accept 里可**确认或下调**」。实现照单全收:执行方(或其缺陷)报一个超大 `lease_ms`,lead 的 lost 判定随之被无限拉长,租约超时回收机制对该任务失效。同队互信下更像健壮性问题,但这是租约语义的根。
- **依据**:01 §4.2 offer body `lease_ms` 说明。
- **建议**:`lease = Math.min(body.lease_ms ?? suggested, suggested)`;执行方确需更长租约应在 reject/协商路径提出,而非单方上调。

---

### DIST-10|minor|busy 不带 retry_after_ms 也不排除,与 R8 字面不符

- **位置**:`packages/node/src/lead/machine.ts` L396-397(`if (code==='busy' && retry_after_ms) return; if (code==='busy') return;`——两支都不排除)。
- **问题**:R8 的豁免写作「`busy`(**带 `retry_after_ms`**)不排除」;不带 `retry_after_ms` 的 busy 并不在豁免括号内,按「其余瞬时 retryable 仅排除一次」应记 `'once'`。当前实现对两者都不排除。影响有限(busy 本就是负载信号,下一轮是否再选该节点属牵头方策略),但既然排除表存在,口径应与文档一致,否则 M2 接上过滤后会放大。
- **依据**:01 §6 R8;01 §4.3 reject 码表 busy 行。
- **建议**:busy 无 `retry_after_ms` → `excluded[target]='once'`;或回写 R8 明确「busy 一律不排除」,二选一,不留歧义。

---

### DIST-11|minor|fail_sent/stopped/cleaned 态收到 cancel 不回 ack,提前收口对失败路径失效

- **位置**:`packages/node/src/executor/machine.ts` L279-305(`onCancel` 仅覆盖 running/offered/result_sent 三态);`packages/node/src/lead/machine.ts` L275-279(cancel.ack 提前收口)。
- **问题**:执行方已 `fail_sent` 后收到 cancel(重试型回收的常规时序:fail 先到、cancel 后到)→ 静默忽略,无 ack;lead 只能等满 `drain_ms`。R5/I-39 为 result_sent 专门定义了「回 ack 带标记,不重发 result」,对 fail_sent 的对称情形未定义,实现顺势沉默。至少一次投递下,stopped/cleaned 态收到**重发型 cancel** 同样无回执——M3 接上 R11 outbox 重发后,每个 cancel 都会重发到满窗口。
- **依据**:01 §6 R5 / 评审 I-39;01 §5.2(running 收 cancel → ack);R-MATRIX L14(「ack 提前收口用例排 M3」——用例排期已披露,但执行方侧缺的这条规则未披露)。
- **建议**:`onCancel` 增加 `fail_sent/stopped/cleaned` 分支:回 `cancel.ack`(可附终态摘要),使 lead 的提前收口对所有改派路径生效。

---

### DIST-12|minor|赛跑窗口内 result 绕过验收校验直接 done

- **位置**:`packages/node/src/lead/machine.ts` L259-264(`onReclaimingMessage` 的 result 分支直接 `finish('done')`);对照 L223-235(running 态 result 过 `validateAcceptance`)。
- **问题**:实现忠实照抄了 I-06 的竞态出口「reclaiming 收 result → done」,但与 R4 验收语义(01 §4.2 `acceptance_results` 回填、验收失败走 `cancel(acceptance_failed)`)存在未调和的缝:R1 去重正常工作时不掏问题,一旦同 attempt 的验收失败 result 在去重保留期外/绕过去重重投(reclaiming 窗口恰是「result 仍接受」期),一份**验收不过**的产物会被标记 done 并进入整合。I-06 写规则时未与验收归途对表,实现选了字面。
- **依据**:01 §5.1 竞态行(I-06)vs 01 §6 R4 验收失败归途 / D25。
- **建议**:窗口内 result 同样过 `validateAcceptance`:不过 → 维持 reclaiming(该 result 记 history 后忽略),避免竞态出口成为验收旁路;若认为设计有意豁免,回写 I-06 注明。

---

### DIST-13|nit|`assertLeaseInvariant` 全仓零调用,R3 不变式仅存在于测试

- **位置**:`packages/core/src/params.ts` L73-79;grep 证实唯一引用在 `core/test/semantics.spec.ts` L86-88。
- **问题**:注释写「违反即实现配置错误」,但没有任何生产代码在装配 `QlongParams`/构造机器时调用它。自定义参数(如 grace=200s)会静默产出一个执行方先于 lead 判 lost 的配置——恰是 I-07 不变式要防的事,直到运行期以诡异时序暴露。
- **建议**:`LeadTaskMachine`/`ExecutorMachine` 构造(或 params 装配入口)调用 `assertLeaseInvariant(leaseMs, params)`。

---

### DIST-14|nit|node 包入口不导出 checkpoint/supervisor/store,CLI 以相对路径穿透

- **位置**:`packages/node/src/index.ts`(仅导出 wire/caps/gates/driver/两台机器/harness);`packages/cli/src/main.ts` L5-7(`import … from '../../node/src/lead/supervisor.js'`)。
- **问题**:M1.2/M1.3 的交付物(检查点、监督器、存储)不在包导出面上,CLI 靠源码相对路径穿透引用。M2 的网关/注册中心或测试包一旦按正规方式 `import '@qlong/node'` 会拿不到接管组件。
- **建议**:`index.ts` 补 `export * from './lead/checkpoint.js'` 等三行;CLI 改从包入口导入。

---

### DIST-15|nit|三处口径小疵集中列出

- **位置与问题**:
  1. `packages/node/src/local/harness.ts` L167:`msg.attempt ?? this.lead.rec.attempt`——发送方漏带 attempt 时由接收方**伪造**当前值补齐,会把执行方状态机的 attempt 装配缺陷掩盖成「恰好正确」,建议去掉回退、缺 attempt 直接审计报错。
  2. `packages/node/src/executor/gates.ts` L21-25:`gatePolicy` 允许 `policy_denied` 附 `retry_after_ms`,与 §4.3 码表方向不符(`policy_denied` 持久不可重试;`retry_after_ms` 是 busy 专属语义)。lead 侧 `applyExclusion` 不看它所以无害,但码表纪律应从源头守住。
  3. `packages/node/src/lead/machine.ts` L366-381:escalate 结构化事件缺 §11 schema 的 `trace_id` 与 `diagnostics_ref` 字段(M1 无 trace 管道可以理解,建议在 `LeadInit` 预留 trace 入参并在摘要中带出,避免 M3 接线时改事件形状)。

---

## 亮点

- **状态机纯函数化、动作外置**(send/audit/schedule/terminal 由上层解释):传输无关(P2)落实得很干净,M2/M3 换真实传输时机器零改动是可信的。
- **参数单一事实源**:`params.ts` 与 01 §10 逐项对应,`lostAfterMs` 与文档公式逐字一致,`lead.spec.ts` L32 直接断言 230s——公式层无偏差(偏差在锚点,见 DIST-8)。
- **R4「先撤销后改派」在所有路径统一走 `beginReclaim`**,cancel 先于新 offer 入通道有显式断言(lead.spec L63-75);expired 也走撤销(I-08)没有漏。
- **R7 双预算分离清晰**:`acceptedFailedBudget`/`dispatchRounds` 独立计数、任一耗尽即 escalate,`retryable=false 不烧 attempt` 有专例;escalate 带结构化历史。
- **R0 特别则(更高 attempt = 隐式取消 + 旧态摘要再评估)**实现与 I-04③ 吻合,且「先用旧态字段装配出站、再重置记录」的顺序处理有注释有测试(executor.spec R0③)。
- **检查点为 §4.4 预留到位**:rec 内含 attempt 与在途 (task_id, attempt, target),`pendingTimers` 按状态重挂,接管测试覆盖 running/reclaiming 双态恢复。

## 开放问题(非缺陷,提请后续里程碑注意)

1. **R1 去重未在 node 层接线**:harness 是「送达即消费」的零重投环回,`core/dedup.ts` 纯函数与状态机之间没有装配点。M3.2 引入 outbox 重发时,去重层挂在 deliver 入口的哪个位置、保留期随 attempt 增长如何取值(max(offer_ttl,lease)×max_attempts 是否按实际 attempt 数),需要一次显式设计。
2. **R3 断线计时暂停与 drain 重开(I-09)**:M1 无连接态概念,当前 lease 定时器是纯本地时钟;M3 接 ws 后「断线暂停入站任务 lost 计时」需要定时器层支持暂停/恢复语义,现有 `schedule/cancelTimers` 动作集是否够用值得提前验证。
3. **ExecutorMachine 的多任务形态**:单实例单记录,第二个 task_id 的 offer 会走闸4 之外直接覆盖 rec(harness 里不存在该场景)。M2 起每任务一实例由谁分发、`queue_depth` 如何驱动闸4,建议在 M2.2 前给一页接口约定。
4. **R8 lost 排除的准确语义**(01 R8「按 R4 取消衔接处理」本身留白):建议在 §8.4 双机走查时把「lost → once 排除」钉进 R8 文本,消除实现侧自由裁量。
