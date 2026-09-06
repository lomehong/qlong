# 群龙 M1 评审意见——架构与状态机视角

> 评审对象:M1「单机核心」`packages/node`、`packages/cli` 全部源码与测试(37 项)。
> 对照基线:`QLONG_DESIGN_01_MSG_PROTOCOL.md`(下称 01)、`QLONG_DESIGN_02_REGISTRY_TRUST.md`(02)、`QLONG_DESIGN_03_CAPABILITY.md`(03)、`QLONG_DESIGN_NOTES.md`、`QLONG_IMPL_PLAN.md`。
> 评审视角:仅架构与状态机;协议细节、安全、测试覆盖度等由其他角色评审。

## 结论 verdict

**有条件通过**。

M1 的骨架质量高:两台状态机均为「纯转移函数 + 动作出站」形态,P2(传输无关)落实到位;§5.1/§5.2 主转移表、终态优先级(done>closed>failed>escalated)、R7 双预算、R4「先撤销后改派」与终态竞态行实现正确且有确定性虚拟时钟测试;参数/码表单一事实源兑现。但存在 **1 项 blocker**:接管(01 §4.4)恢复后没有任何代码路径重挂定时器或补发改派意图,活动任务在真实重启后全部永挂——接管是 M1.2 的验收核心,该缺陷使特性在真实条件下根本不可用。另有 6 项 major 集中在:执行方对「非正常消息序列」(过期补投、重复 offer、旧 attempt 回执回弹、异任务覆盖)的守卫缺口,以及 core 语义纯函数未被 node 复用导致的语义分叉。blocker 与 major 应在进入 M2(真实传输层)前修毕,否则至少一次投递会把今天被单机回环掩盖的缺口全部激活。

## 摘要

- **blocker ×1**:接管恢复活性断裂(supervisor.restoreAll 不重挂定时器、drafting 态改派意图丢失)。
- **major ×6**:执行方 R2 判定不可达(过期补投单会被照单接收);R0③ 隐式取消回执被牵头方 R0 弹回后杀伤执行方新 attempt(违反 §4.5 关联规则);已决状态重复 offer 重新接单重跑(R0 末句违反,且总线亦无 R1 去重层);异 task_id offer 静默覆盖在途任务 + 闸4 阈值边界错误;core 的 attemptGate/DedupStore/isExpiredByTtl/isPersistentReject 未被 node 复用、内联重写已分叉;reclaiming/cancelling 赛跑窗口 result 不经验收即 done(与 R4/D25 验收归途冲突)。
- **minor ×5 / nit ×3**:R8 排除集不完整、总线缺网关语义接缝、审计关联字段缺失、deadline_ms 未实现、R5 自检缺一半;lease_ms 上调采信、cancel 后空 ack 无赛跑标记等;包边界工程化。

---

## 问题清单

### ARCH-1|blocker|接管后活动任务全部永挂:restoreAll 不重挂定时器、drafting 改派意图丢失
- **位置**:`packages/node/src/lead/supervisor.ts:35-43`(restoreAll)、`packages/node/src/lead/checkpoint.ts:43-55`(pendingTimers,生产代码零调用)、`packages/cli/src/main.ts:28-43`(takeover 命令)。
- **问题**:01 §4.4 定案 v1 接管 = 同机进程重启 + 本地检查点重放。检查点确实记入了绝对 deadline(`offerTtlUntil/leaseDeadline/drainUntil/cancelWaitUntil`),`pendingTimers()` 也按状态给出了重挂清单——设计思路正确。但 `restoreAll()` 只重建机器对象,不调度任何定时器,全仓库(除 checkpoint.spec 的断言外)没有任何调用方消费 `pendingTimers`;supervisor 自身无定时器设施,harness 与 CLI 也未接线。后果:真实重启后,恢复为 `offered/running/reclaiming/cancelling` 的任务永远等不到 `offer_ttl/lease/drain/cancel_wait`,执行方又与进程同死、不会自发来信——任务永久停滞,只能人工干预。恢复为 `drafting`(drain 收口后等待改派)的任务同样永挂:`budgetOrEscalate`(machine.ts:384-385)的 `requestDispatch` 意图只存在于返回值中,重启后无人再补发,且 drafting 态没有任何定时器兜底。CLI takeover 演示之所以通过,是因为它用 MemoryStore 在同一进程内伪造「崩溃」并手工投递 result,未触及任何定时器路径。
- **依据**:01 §4.4「v1 的 leader 接管 = 同一物理节点上的进程重启 + 本地检查点重放」;M1.2 验收「本地图谱+sqlite 检查点、cancel_wait_ms 出口」;impl plan §5「实现偏离不静默」。
- **建议**:
  1. `restoreAll()` 返回每任务的 `{taskId, timers: pendingTimers(m), needsDispatch: rec.state==='drafting'}`,由上层 TimerService 重挂;或让 SupervisorDeps 直接注入 `schedule/cancelTimers` 与 `onRequestDispatch` 回调,restore 时对到期(deadline ≤ now)的定时器立即触发一次转移。
  2. drafting 态恢复时重发 `requestDispatch`;并为 drafting 增加一个守卫定时器(如复用 drain 结算时刻 + 上限),防止「预算未耗尽但无候选节点」的永挂——该出口目前设计也未定义,建议随 M2 选型定形。
  3. CLI takeover 改用 JsonFileStore + 子进程边界演示真实重启,并断言重挂后的 lease 定时器会在 deadline 后触发 reclaim。

### ARCH-2|major|执行方 R2 判定不可达:接单路径无 offer_ttl 检查,离线补投的过期 offer 会被照单接收
- **位置**:`packages/node/src/executor/machine.ts:137-192`(evaluateOffer:闸2/3/4 之后直接 accept,无 TTL 判定)、`:206-215`(onTtlCheck 仅在 `state==='offered'` 时生效,而全机无任何路径把 state 置为 'offered',属死代码)、`packages/node/test/executor.spec.ts:75-84`(用 `Object.assign(m.rec, {state:'offered',...})` 强行造态才能测到)。
- **问题**:实现采取「五道闸同步通过即 accept」,`offered` 状态在真实流程中不存在,于是 R2 的执行方判定(「晚于」TTL 即 `reject(expired)`)在唯一重要的场景——M2 网关收件箱补投——完全不生效:长期离线节点上线后,批量过期 offer 会被逐单接受并启动执行,而非 R2 要求的「整批 reject(expired)(必测场景)」。单机回环即时送达掩盖了这一点;测试注释也自认「offered 为瞬态」,用 Object.assign 绕过,属于用测试掩盖缺口。
- **依据**:01 §6 R2、§5.2「offered ── accept ──▶ running / 本地 offer_ttl 过期 ──▶ reject(expired)」;core `freshness.ts:21-23` 的 `isExpiredByTtl` 已提供正确判定但未被调用。
- **建议**:在 `evaluateOffer` 进入闸2 之前先做 TTL 判定(起点 = 本机收到时刻,「晚于」判向),过期立即 `reject(expired)`。同时建议恢复 `offered` 为真实状态(接单评估异步化),为 M4 闸5「本地人确认与 TTL 赛跑」(03 §6.2)预留形态——那时 accept 不再可能同步完成。

### ARCH-3|major|R0③ 隐式取消回执遭牵头方 R0 弹回,执行方 onStaleReject 无 (task_id, attempt) 关联,会杀掉刚接的新 attempt
- **位置**:`packages/node/src/executor/machine.ts:112-130`(隐式取消:先发 `reject(stale_attempt)`(旧 attempt),再 accept 新 attempt)、`:308-316`(onStaleReject 不校验 attempt/task_id,凡 running/offered 一律停驱动清理)、`packages/node/src/lead/machine.ts:169-177`(R0:`attempt < current` 一律回 `reject(stale_attempt)`)、`packages/node/src/local/harness.ts:159-161`(一切入站 task.reject 无条件路由到 onStaleReject)。
- **问题**:推演「改派回原节点且执行方尚持旧 attempt」(真实 M3 的常态:lost → cancel 在途/未达 → drain 收口 → 同节点重新 offer):执行方按 R0③ 发回 `reject(stale_attempt)`(attempt=旧值)+ 旧态摘要,随即 accept 新 attempt 并开工。牵头方 R0 闸门见 attempt 低于当前,机械弹回 `reject(stale_attempt)`;执行方收到任何 task.reject 就无条件停驱动、置 cleaned——**把刚启动的新 attempt 执行杀掉**。牵头方随后等满 230s 判 lost → reclaim → 再烧一个 attempt 重派。即使考虑消息乱序,执行方在本机是先 accept 后收到回弹,杀伤必然发生。根因有二:① 执行方处理 reject(stale_attempt) 未按 01 §4.5「任务级关联一律以 (task_id, attempt) 为准」做关联校验——回弹携带的是旧 attempt,与本机当前 attempt 不符时应忽略;② 牵头方未把「对旧 attempt 的 stale_attempt 回执」识别为 I-04③ 的预期回执(至少应在审计中区分,而非与真实拒单同途)。M1 单节点回环下 cancel 同步送达使执行方先入 stopped、回执路径不触发,故测试全绿——这是被传输形态掩盖,不是不存在。
- **依据**:01 §5.2 R0 特别则行、§4.5、R0;P4(至少一次、不保序——该序列在 M2+ 是常态而非异常)。
- **建议**:① `onStaleReject` 增加 `(task_id, attempt)` 入参,仅当与 `rec.task_id/rec.attempt` 一致时才清理,否则忽略+审计;② harness 路由 task.reject 时透传 attempt 并按 ① 分派;③ 牵头方对 `attempt < current` 的入站 reject(stale_attempt) 保留弹回,但审计 reason 标注「隐式取消回执回弹」以便链路还原;④ 补一条直接注入消息序列的单测(不依赖回环时序):offer(1) running → offer(2) → 断言 accept(2) 后执行方仍 running。

### ARCH-4|major|已决状态收到同 attempt 重复 offer 会重新接单重跑(违反 R0 末句),且总线层 R1 去重同样缺席
- **位置**:`packages/node/src/executor/machine.ts:100-135`(onOffer 仅在 offered/running 处理同任务重复;`result_sent/fail_sent/rejected/stopped/cleaned` 状态直接落入 evaluateOffer → 闸门通过即再次 accept+startDriver)、`packages/node/src/local/harness.ts:144-162`(deliverToExecutor 直调 onOffer,无 R1 去重过滤)。
- **问题**:R0 明文「任何已决状态(已 accept/reject/终态)下的重复消息一律忽略 + 审计」。当前实现下,一条已发 result 的任务若再收到同 `(task_id, attempt)` 的 offer(至少一次投递下的重放/重发在 M2+ 是常态),会**完整重跑一次已完成的任务**并二次发送 result——重复副作用正是 R1/R0 要消灭的东西。M1 回环不产生重复投递,故未暴露;而 R1 的唯一现役实现(core `dedup.ts` DedupStore)也没接进总线。两层(状态机守卫、传输边界去重)今天都缺。
- **依据**:01 §6 R0 末句、R1、P4。
- **建议**:① onOffer 入口先判 `rec.task_id === o.task_id && rec.attempt === o.attempt` 且 state ∈ 已决集 → 忽略+审计;② M2 接线传输层时把 DedupStore 放在节点入站边界(网关语义的单机镜像),两层并存(与 02 P10 双重执法同构)。至少要修 ①,因为它同时防住「非重复但异常」的同键 offer。

### ARCH-5|major|执行方单任务记录:异 task_id offer 静默覆盖在途任务(不 stopDriver、不通知旧牵头方),闸4 阈值边界错误放大该风险
- **位置**:`packages/node/src/executor/machine.ts:21-37`(ExecRecord 单任务)、`:100-111`(同 task_id 才走 R0 分支;异 task_id 直接 evaluateOffer)、`:169-184`(rec 整体覆盖,旧任务驱动不停止、对旧牵头方无 cancel.ack/fail)、`packages/node/src/executor/gates.ts:44-53`(gateLoad 用 `>` 判满)。
- **问题**:03 §3.3 明确 `queue_depth`「含已接受的远端任务」、闸4 以阈值拒新单——协议语义默认执行方可持有多个在途任务;而执行方状态机结构上只能持一个。当 running 中收到异 task_id 的 offer 且闸门放行时,记录被整体覆盖:旧驱动继续运行(无人 stop)、旧牵头方等不到心跳/结果(其 cancel 到来时因 attempt 不匹配被静默丢弃,machine.ts:281-304 无匹配分支),旧任务退化为「lost→改派」的必然浪费;更糟的是旧驱动的迟到 complete 会经 `onDriverCompleted` 以新任务的 `rec.from` 发往**新牵头方**(machine.ts:251-269 无 task_id 参数),跨任务串结果。gateLoad 的 `running > maxRunning` 属 off-by-one:maxRunning=1 且已有 1 个在途时 `1 > 1` 为假,闸4 放行,恰好触发上述覆盖。M1 harness 单任务接线掩盖了一切,但这是 M2 起真实生效的结构缺陷。
- **依据**:03 §3.3、03 §6 闸4;01 §5.2(执行方状态机应按任务实例运转,与 §5.1「每个 task_id 一份」对偶)。
- **建议**:① 执行方改为 `Map<task_id, ExecRecord>`(与 LeadSupervisor 同构),`onDriverCompleted/onCancel/onStaleReject` 一律带 task_id 并校验归属;② 若 M1 有意维持单任务,则 running/offered 下收到异 task_id offer 必须 `reject(busy)` 而非评估接单;③ gateLoad 改 `>=`(队列同理),并让闸4 把当前机内状态计入 running。

### ARCH-6|major|跨包职责边界:core 语义纯函数未被 node 复用,状态机内联重写且已与 core 分叉
- **位置**:`packages/node/src/lead/machine.ts:169-177`(手写 attempt 比较,未用 core `attemptGate`)、`:389-399`(applyExclusion 内联持久码清单,未用 core `isPersistentReject`)、`:403-405`(normalizeFailCodeOrReject 空壳,未用 core `normalizeRejectCode/normalizeFailCode`,丢弃 custom 标记)、`packages/node/src/executor/machine.ts:206-215`(手写 TTL 判定,未用 `isExpiredByTtl`;且该路径死代码,见 ARCH-2);grep 证实 node 全包未 import `attemptGate/DedupStore/isExpiredByTtl/isPersistentReject`。
- **问题**:impl plan §2 与 M0.3 的立意是 R0/R1/R2 判定以 core 纯函数为单一事实源(property-based 测试护住不变式),node 只做编排。现状是 node 两台状态机各自内联重写,且重写已经弱于 core 版本:core attemptGate 精确区分 process/reject_stale/implicit_cancel/drop 四态,node 版本丢掉了 implicit_cancel 与「已决重复忽略」的语义(直接导致 ARCH-3/ARCH-4);core 的去重与 TTL 判定在 node 完全旁路。这既是重复实现,更让「core 测试全绿」与「node 行为正确」脱钩——core 的 42 项绿灯对 node 无约束力。
- **依据**:impl plan §2「参数单一事实源」的同一原则推广到语义纯函数;01 §6「每条规则可追溯到测试用例」的兑现路径(M0.3 property 不变式 → M1 状态机)。
- **建议**:node 状态机入站统一先过 core `attemptGate`,按裁决分派;R8 排除改用 `isPersistentReject`;TTL 判定改用 `isExpiredByTtl`;码表归一改用 core normalizer 并保留 custom 原值进 detail。给 node 增加一条架构测试(或 lint 规则)禁止在 machine 内重写这四类判定。

### ARCH-7|major|reclaiming/cancelling 赛跑窗口内的 result 不经验收即 done,R4/D25 验收失败归途被绕过
- **位置**:`packages/node/src/lead/machine.ts:259-264`(onReclaimingMessage:result 直接 finish('done'),未调 validateAcceptance)、`:284-288`(onCancellingMessage 同);对照 `:223-235`(running 态 result 均经验收,失败走 cancel(acceptance_failed))。
- **问题**:最现实的触发:执行方本地完成但投递迟滞,牵头方判 lost 进入 reclaiming,赛跑窗口内 result 到达——若该 result 的 `acceptance_results` 不合格,当前实现直接记 done,不合格产物作为终态交付进整合。这与 R4「验收失败归途:校验不符 → cancel(acceptance_failed) + attempt+1 重做」和 D25 的验收语义冲突。需说明:01 §5.1 竞态行「cancelling/reclaiming 收到 result ──▶ done(I-06)」字面上支持现实现——这是设计两处相互冲突,实现取了字面之一。按 impl plan §5「发现设计冲突回写文档,不静默」,此点必须显性裁决,不能停在代码现状。
- **依据**:01 §6 R4、D25、§5.1 竞态行(冲突方);评审 I-04⑥/I-24。
- **建议**:reclaiming 路径对窗口内 result 仍执行 `validateAcceptance`:通过 → done;不通过 → 维持改派(计入 accepted 预算,history 记 acceptance_failed)。cancelling(用户主动取消)路径可保留 done(用户已放弃验收),但应回写 01 §5.1,把竞态行改写为「reclaiming 收 result 经验收后 done/继续改派;cancelling 收 result → done」,消除双源冲突。

### ARCH-8|minor|R8 排除集不完整:fail(retryable)/lost 不写排除;requestDispatch 不携带排除集,单机总线无条件重派同一节点
- **位置**:`packages/node/src/lead/machine.ts:389-399`(applyExclusion 仅在 offered 态 reject 分支被调用,`:206-213`;fail 与 lost 路径 `:236-249、:305-310` 均不排除)、`:59-66`(requestDispatch 动作仅含 nextAttempt)、`packages/node/src/local/harness.ts:125-127`(requestDispatch 无条件 redispatchTo(nodeB))。
- **问题**:R8「其余瞬时 retryable 仅排除一次」的最主要两个来源——已接受后的 retryable fail 与判 lost——都没有落排除;`busy` 不带 retry_after_ms 时按 R8 文义应计入「其余瞬时(排除一次)」,现也无条件不排除。同时 requestDispatch 动作不携带 excluded 快照,选目标的下一棒(M2/M3 的调度层)拿不到硬约束数据;M1 总线则无视排除集、永远重派 nodeB。R-MATRIX 已承认「过滤在选目标时执行,M2 集成」,但 fail/lost 不排除是状态机层的缺口,不在该豁免范围内。
- **依据**:01 §6 R8;评审 I-37。
- **建议**:fail(retryable) 与 lost 进入 reclaim 时对 `rec.target` 记 `'once'`;busy 无 retry_after_ms 记 `'once'`;requestDispatch 增加 `excluded` 字段(持久/一次),harness 在单执行方场景至少断言「排除集非空时仅当无替代目标才允许重派同节点」,为 M3.2 R8 用例留好接缝。

### ARCH-9|minor|harness 单机总线缺未来网关语义的接缝:无 to_node 校验、无入站过滤位、缺 attempt 消息被默认为当前值
- **位置**:`packages/node/src/local/harness.ts:144-162`(deliverToExecutor 不核对 `msg.to_node`,不检查来源)、`:164-174`(deliverToLead 不核对 to/from;`:167` `msg.attempt ?? this.lead.rec.attempt` 把缺失 attempt 消息放行为当前 attempt)。
- **问题**:harness 自我定位是「正式传输层替换 deliverTo* 实现,状态机不动」的 A2 种子,但总线上没有任何网关将要在 M2 执法的入站语义位:to.node_id≠本机静默丢弃(01 §3.3.4/02 A6)、R0 前置(经 core attemptGate)、R1 去重(经 DedupStore)、exp 检查(经 isExpiredByExp)。这些今天全部缺位,意味着 M2 接线时是在无测试先例的空白层上加执法,与「状态机不动、换传输层」的演进承诺相悖;`attempt ??` 兜底更是把「缺 attempt」这一协议违规伪装成合法当前值,与 R0「attempt 是第一道闸门」相反。
- **依据**:01 P2/P4、§3.3.4、R0/R1;02 §7 A5/A6(节点侧复核职责);impl plan M2.2。
- **建议**:在 harness 增加一个 `ingress(msg)` 入站过滤函数(to_node 校验 → exp → R1 去重 → attemptGate),M1 即接 core 纯函数实现并用故障注入用例锁住;删除 `?? rec.attempt` 兜底,缺 attempt 一律按协议违规丢弃+审计。

### ARCH-10|minor|审计基线不达标:关联字段缺失 + 多处「只忽略不审计」
- **位置**:`packages/node/src/local/harness.ts:122-124、:182-184`(makeAudit 仅 event/node_id/reason,无 task_id/attempt/trace_id/msg_id);`packages/node/src/lead/machine.ts:213、:217、:250-253、:296`(offered/running 的未处理消息、异源消息、running 态 cancel.ack 均静默返回)、`packages/node/src/executor/machine.ts:105`(重复 offer 忽略无审计)、`:304`(不匹配 cancel 丢弃无审计)。
- **问题**:01 §11 明文「每条与任务相关的日志必须含 trace_id/task_id/attempt/msg_id,缺字段视为日志缺陷」,并把「忽略 + 审计」写进 R0/R1 多处。M1 审计记录一个关联字段都没有,状态机大量「忽略」分支也没有配对审计动作——A8(仅凭日志+trace_id 还原派单全生命周期)的节点侧地基现在是缺的。
- **依据**:01 §11;impl plan A8。
- **建议**:LeadAction/ExecAction 的 audit 动作补充 task_id/attempt(机器已知,harness 可注入);「忽略」分支统一产 audit(事件可先用现有枚举形态,或提议扩枚举并回写 01 §11);trace_id 随 M2 信封接线补齐。

### ARCH-11|minor|deadline_ms 无执行方实现:无超期放弃、无 fail(deadline_exceeded)
- **位置**:`packages/node/src/executor/machine.ts:137-192`(evaluateOffer 不读 `deadline_ms`、不排程)、`packages/node/test/*.spec.ts`(无相关用例)。
- **问题**:01 §4.2 定义 `deadline_ms`「超期执行方自行放弃并 fail(deadline_exceeded)」,§4.3 给出对应 fail 码。执行方状态机对该字段零处理:超过 deadline 的任务会继续跑满 lease,靠牵头方租约回收兜底——这在真实执行器(deepseek-harness 基座)接入后意味着明知超期仍消耗算力。这与 01 §13.6「单机执行模型接口待走查」不同:deadline 排程是状态机语义,不是驱动接口问题,不应随接口开放悬置。
- **依据**:01 §4.2、§4.3、§10 P5(相对时长)。
- **建议**:accept 时按 `now + deadline_ms` 排程 deadline 定时器,到期置 paused 并 `fail(deadline_exceeded, retryable=true)`;driver.ts 的接缝注释同步说明该定时器归状态机管(与心跳同列)。

### ARCH-12|minor|R5 result 前自检缺一半:本地租约已超时(paused)仍发 result
- **位置**:`packages/node/src/executor/machine.ts:241-248`(onLeaseSelfTimeout 置 paused)、`:251-269`(onDriverCompleted 仅检查 cancelReceived,不检查 paused)。
- **问题**:R5 明文「发送 result 前自检——已收到 cancel **或本地租约已超时**(R3 执行方计时器)→ 不发 result,回 cancel.ack」。实现只查了前一半:paused 后驱动完成仍会发 result。实际后果有限(result 会落在牵头方 drain 窗口内被接受,或以 stale_attempt 被拒),但这是 R5 字面违反,且 M3.2 断线重连场景下「执行方停跳已超 grace → 本地租约到期 → 完成后补发 result」恰是协议要求抑制的僵尸形态。
- **依据**:01 §6 R5、R3 执行方对称计时器。
- **建议**:onDriverCompleted 增加 `if (this.rec.paused)` 分支 → 置 stopped、回 `cancel.ack`(可带 detail 说明本地租约超时),不发 result;补一条 paused 后完成的双断言用例。

### ARCH-13|nit|牵头方无条件采信执行方上调的 lease_ms
- **位置**:`packages/node/src/lead/machine.ts:197-199`。
- **问题**:01 §4.2 规定执行方在 accept 中「可确认或下调」租约;实现 `typeof body.lease_ms === 'number'` 即采纳,执行方上调会单方面延长牵头方 lost 时限。执行方现实现只回原值(machine.ts:167-168),故暂无实害。
- **建议**:clamp 为 `Math.min(body.lease_ms, offer 中 lease_ms)`,越界值审计备注。

### ARCH-14|nit|竞态细节三则:cancel 后完成的空 ack 无赛跑标记;escalate 摘要缺字段;跨 attempt 残留
- **位置**:`packages/node/src/executor/machine.ts:255-261`(cancelReceived 后驱动完成 → 空 body cancel.ack,已完成成果不进牵头方 drain 窗口,白烧一次改派;按 R5/I-39 精神宜回 `cancel.ack{completed_before_cancel:true}` 并附 result 摘要供牵头方裁量)、`packages/node/src/lead/machine.ts:366-381`(escalate 摘要无 trace_id/diagnostics_ref,§11 结构不齐,M1 可先留位)、`:53-54、:146-163`(redispatchTo 不清 `resultBody/cancelReason`,跨 attempt 残留进检查点)。
- **建议**:① ack 带标记并让 lead 在 reclaiming 收到带标记 ack 时可选提前收口为 done 的裁量路径(需随 §8.4 走查定稿,先记待办);② escalate 摘要补 trace_id 占位;③ redispatchTo 清理上一 attempt 的 resultBody/cancelReason。

### ARCH-15|nit|包边界工程化:CLI 相对路径直插 node src;node 包出口不全;takeover 演示非真实重启
- **位置**:`packages/cli/src/main.ts:5-7`(`'../../node/src/...'` 跨包源码引用)、`packages/node/src/index.ts:1-7`(未导出 supervisor/checkpoint/store,逼出上述引用)、`packages/cli/src/main.ts:29`(takeover 用 MemoryStore)。
- **问题**:impl plan §2 规定 cli 依赖 packages/node 包;相对路径导入绕过包边界,node 单独构建/发布即断。takeover 演示用同进程 MemoryStore 伪造崩溃(另见 ARCH-1),演示价值与验收语义不符。
- **建议**:index.ts 补导出四个模块,CLI 改 `@qlong/node` 别名导入(仓库已有 paths 先例);takeover 换 JsonFileStore + 独立进程。

---

## 亮点

1. **状态机架构形态正确且测试友好**:两台机器均为「入站事件 → 纯转移 + 动作列表」出站(发信/审计/排程/终态),时间由调用方注入,配合 SingleNodeHarness 的确定性虚拟时钟(harness.ts:93-104),把 R4 赛跑、lost、drain 这类时序敏感语义做成了可精确推演的单测——这是 P2「换通道不换语义」的正确兑现方式。
2. **§5.1 主干与终态语义实现准确**:done>closed>failed>escalated 优先级、四条失败归途(retryable/fatal/acceptance_failed/lost)、cancelling/reclaiming 竞态行、R7 双预算(acceptedFailedBudget/dispatchRounds 独立计数,machine.ts:360-386)均与 01 一致,lead.spec 覆盖到位。
3. **R4「先撤销后改派」纪律严格执行**:expired/retryable/lost/acceptance_failed 四条路径统一走 beginReclaim,cancel 先于 requestDispatch 进入通道,与评审 I-08 的「僵尸入口对一切改派路径关闭」吻合。
4. **参数与码表单一事实源兑现**:params.ts/reason-codes.ts 与 01 §10/§4.3 逐条对齐,lostAfterMs 与 R3 文内算例(230s)一致,R3 不变式以 assertLeaseInvariant 固化。
5. **D31 匹配语义实现与测试堪称范本**:caps.ts 的逐段数值比较、「档案段数不足即不匹配」、未知类整串精确,与 03 §3.2 正反例一一对应,caps.spec 全覆盖。
6. **检查点设计思路正确**:定时器不持久化、绝对 deadline 入档、恢复按状态重挂(pendingTimers),validateAcceptance 作为函数不入档、由新进程重注入(checkpoint.ts:22-26)——边界划得干净,只差接线(ARCH-1)。
7. **R-矩阵诚实可用**:🔲 项标注里程碑,部分项标注「部分」,未虚报覆盖。

## 开放问题(提请设计/委员会裁决)

1. **§5.1 竞态行 vs R4 验收归途的冲突**(ARCH-7):reclaiming 窗口内 result 是否仍须过验收?建议随 §8.4 双机走查一并回写 01 §5.1,消除双源。
2. **drafting 态的活性守卫**(ARCH-1):预算未耗尽但无候选节点时,改派等待有无上限、走 escalate 还是一直等?设计未定义,建议 M2 选型时定形并回写 R7。
3. **执行方 paused 的恢复语义**:R3 只定义了暂停,未定义恢复(重连/心跳恢复后是否自动恢复接单与心跳)。M3 断线重连用例前需要答案。
4. **执行方多任务形态**:per-task 多实例(建议)还是单任务+busy,牵动 03 §3.3 queue_depth 语义与闸4 阈值口径,建议 M2 前定稿。
