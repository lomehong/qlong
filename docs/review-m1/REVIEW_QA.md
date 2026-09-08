# 群龙 M1 评审意见 —— 测试充分性与可观测性

> 评审角色:测试充分性与可观测性(QA)
> 评审对象:M1「单机核心」packages/node + packages/cli 全部源码与测试(37 项),对照 docs/testing/R-MATRIX.md、01 §5/§6/§11、03 §3.2/§6、IMPL_PLAN §1/M1
> 复核动作:实机复跑 `pnpm -r test`,core 42 + node 37 全部通过,与 R-MATRIX / 任务声明一致;grep 证实 packages/node 未引用 core 的 `attemptGate` / `DedupStore` / `isExpiredByTtl`。
> 日期:2026-09-06

## 结论 verdict

**有条件通过**。规则→用例追溯的骨架诚实可用(R-MATRIX 与实际用例数吻合,无虚报总数),虚拟时钟集成测试确定性良好;但存在 8 项 major:R0「统一闸门」在 node 侧被重复实现而脱测、R5 一半分支缺失、执行方暂停无恢复路径、改派间隙(drafting)竞态未定义、检查点崩溃一致性三类场景零覆盖、R8 排除记录零断言、集成层缺 lost 驱动路径、审计缺任务关联字段。均可在下一版修订内落地,不否定架构方向;按 IMPL_PLAN §5 里程碑门流程修订后收口。

## 摘要

R-MATRIX 声称的 ✅ 大体属实,但有四类系统性缺口:①规则实现未单源化——R0/R1/R2 的核心纯函数在 core 已测,node 两台状态机却各自内联重写,重复实现的关键分支(attempt>current 丢弃、attempt<current 拒收)无用例;②两台状态机各有一条设计明文要求的转移缺失(R5 租约超时自检、R3 暂停恢复),恰都落在测试盲区;③检查点「转移与持久化之间」「恢复时定时器已过期」「检查点损坏」三类崩溃一致性问题零测试,接管承诺(01 §4.4)最薄弱处未验证;④可观测性基线(01 §11)未落到 node 层,harness 审计不含 task_id/attempt,忽略类动作无审计,与 A8「仅凭日志还原全生命周期」的距离未被 M1 度量。集成测试 5 例全部走 fail/cancel 路径,最常见故障 lost(租约超时)在集成层不可表达。

## 问题清单

### QA-1 【major】R0「统一闸门」三处实现,node 侧重复实现未经任何测试,R-MATRIX ✅ 由 core 测试越权背书
- **位置**:`packages/core/src/attempt-gate.ts:21-25`(被测纯函数);`packages/node/src/lead/machine.ts:166-177`(`onMessage` 内联 R0);`packages/node/src/executor/machine.ts:100-131`(`onOffer` 内联 R0);`docs/testing/R-MATRIX.md:10`(R0 行标 ✅,引 core/semantics + property)
- **问题**:01 §6 R0 / D25 要求「attempt 统一闸门」。core 已有纯函数 `attemptGate` 并配 5 例确定性测试 + 全序 property(`core/test/property.spec.ts:9-25`),但 grep 证实 node 两台状态机均未调用它,而是各自内联重写判定逻辑。重复实现中两条分支完全脱测:①lead 侧「attempt > 当前且非 offer → 丢弃 + 审计」(`lead/machine.ts:175-176`,只有一行审计,无任何用例);②executor 侧「attempt < 本地 → reject(stale_attempt)」(`executor/machine.ts:106-111`,executor.spec 只测了更高 attempt 的隐式取消)。一旦某次修改只动其中一处,R-MATRIX 的 ✅ 不会变红。
- **建议**:node 两台状态机改为调用 core `attemptGate`(判 attempt 前置、状态分发在后),删除内联分支;若因入参形态暂不改,至少为上述两条分支补 node 侧用例,并在 R-MATRIX R0 行注明「property 仅覆盖 core 函数,node 内联实现另见 lead/executor 用例 ×N」。

### QA-2 【major】R5 僵尸防护缺失「本地租约已超时」分支:租约超时后驱动完成仍发 result,违反 01 §6 R5,无用例暴露
- **位置**:`packages/node/src/executor/machine.ts:251-269`(`onDriverCompleted` 仅检查 `cancelReceived`);对照 `machine.ts:241-248`(`onLeaseSelfTimeout` 置 `paused`);设计条款 01 §6 R5(行 237)「执行方发送 result 前自检——已收到 cancel **或本地租约已超时**(R3 执行方计时器)→ 不发 result,回 cancel.ack」
- **问题**:R5 自检是二选一条件,实现只实现了一半。执行方 `lease_self` 超时(`paused=true`)后若驱动完成,`onDriverCompleted` 因 `state==='running'` 照常发出 `task.result`——这正是 R5 要拦的僵尸 result。现有用例只测了「paused 抑制心跳」(`executor.spec.ts:134-141`)与「收到 cancel 后驱动完成不发 result」(`executor.spec.ts:107-115`),「租约超时后驱动完成」这条转移完全落在盲区,故缺陷未被发现。下游虽有 R0/R4 兜底(stale 拒收或 drain 赛跑),但协议字面已被违反,且 drain 窗口内该 result 会被当赛跑收下,与「执行方已自判租约失效」的事实矛盾。
- **建议**:`onDriverCompleted` 增加 `paused || leaseSelfDeadline <= now` 分支 → 置 `stopped`、回 `cancel.ack`;补用例「lease_self 超时 → 驱动完成 → 回 cancel.ack 不发 result」。若有意收窄 R5(如认为暂停即不发),须回写设计文档并记决策。

### QA-3 【major】执行方 `paused` 无恢复路径:暂停后永不解冻,与 R3 暂停的暂时性语义不符,恢复转移无测试
- **位置**:`packages/node/src/executor/machine.ts:246`(`paused=true` 后全仓库无复位点);`machine.ts:231-238`(`onHeartbeatAcked` 既不检查也不清除 `paused`);设计条款 01 §6 R3(行 235)「无法发出心跳持续超过 grace_ms 亦暂停」及 I-09 断线重连语义
- **问题**:`paused` 是单向阀门:置位后 `onHeartbeatDue` 拒发心跳(`machine.ts:219`),而 `onHeartbeatAcked` 仍会续 `leaseSelfDeadline` 并重排 `lease_self` 定时器——形成「定时器空转但永不恢复」的半死态。R3 的对称语义是发送能力恢复即重新续租(I-09:重连后重新起算),实现缺「paused → running」转移;也没有任何测试覆盖「暂停后恢复」(M1 loopback 回执必达,该场景在集成层结构性不可达)。M3 真实传输接入时,一次网络抖动就会把执行方永久冻结在本任务上,只能等牵头方 lost 回收。
- **建议**:定义恢复条件(建议:心跳发送获回执成功即解除 `paused` 并重排心跳),在 `onHeartbeatAcked` 实现;补两例:①paused 后心跳 ack → 恢复发心跳;②paused 期间 ack 到达 → 不再空转重排 lease_self。M3 前必须钉死,否则 I-09 联调会把该缺陷当成网络问题排查。

### QA-4 【major】改派间隙(drafting 态)竞态未定义且未测试:drain 收口后、新 offer 前到达的旧 attempt result 被静默吞掉
- **位置**:`packages/node/src/lead/machine.ts:383-385`(`budgetOrEscalate` 尾部置 `drafting`,**attempt 不递增**)、`machine.ts:166-177`(R0 按 `attempt===current` 放行进入状态分发)、`machine.ts:188-189`(`drafting` 落入 `default: return []`);对照设计 01 §5.1(行 196)竞态条款只列「cancelling/reclaiming 收到 result」
- **问题**:drain 到期后到 `redispatchTo` 执行前,记录处于 `drafting` 且 attempt 仍为旧值。此窗口内旧 attempt 的 `task.result` 满足 `attempt===current` → 状态机静默忽略(无审计、无 stale 拒收、无 done 裁决)。M1 里 `requestDispatch` 被同步处理(`harness.ts:125-127`),窗口被掩盖;但 supervisor 架构下 redispatch 由调用方驱动(`supervisor.ts:56-61`),M2 引入选目标/查目录后该窗口可任意长——执行方明明已交付,牵头方却照常改派,造成双执行且旧交付无任何痕迹。这正是评审重点所列「progress 晚于 cancel / reject 迟到」一族的更危险变体。
- **建议**(二选一,连同用例一起落):①drain 收口时即 `attempt+1` 作 fence,`drafting` 入站旧 attempt 消息自然落入 R0 stale 分支;②保留现结构,但 `drafting` 态收 `result` 按 §5.1 竞态同样裁决 done 并取消待决改派。补用例:「drain 收口 →(redispatch 前)迟到 result」。另请双机走查时一并钉死相邻张力:`onReclaimingMessage`/`onCancellingMessage` 收 result 直接 done 不做验收校验(`machine.ts:259-264`、`283-288`),字面符合 §5.1 竞态条款,但与 D25 验收语义的关系应明示。

### QA-5 【major】检查点崩溃一致性三类场景零测试:恢复时定时器已过期、检查点损坏、持久化与动作的顺序不变式
- **位置**:`packages/node/src/lead/checkpoint.ts:43-55`(`pendingTimers` 返回绝对时刻,无 past-due 契约);`packages/node/src/lead/supervisor.ts:35-43`(`restoreAll` 对单文件 `restoreLeadMachine` 抛错无兜底,一个坏文件瘫痪全部任务接管)、`supervisor.ts:101-103`(先 `persist` 后返回动作——这是崩溃一致性的关键顺序,无注释无用例锁定);`packages/node/src/lead/store.ts:44-48`(`writeFileSync+renameSync`,无 fsync,崩溃残留 `.tmp` 无清理);`packages/cli/src/main.ts:28-43`(takeover 演练根本不重挂定时器);`checkpoint.spec.ts:58-108`(三个接管用例全部在期限前恢复);设计条款 01 §4.4(行 164)
- **问题**:①**恢复时定时器已过期**是最常见的真实崩溃形态(崩溃时长 > 剩余租约):`pendingTimers` 会返回过去的 `leaseDeadline`,谁负责「立即触发」完全未定义——若 M2/M3 调度器对过去时刻去重或钳位,将出现永不回收的僵尸任务;当前无用例、无契约文档。②`restoreAll` 无逐文件 try/catch:一个损坏/未知版本的检查点让**所有**任务恢复失败,接管可用性归零。③「先持久化后执行动作」的顺序是当前崩溃安全(消息未发、状态可回滚)的根据,但没有测试或注释锁定——未来若有人改成先发后存,会打开「cancel 已发、检查点未记」的窗口且无回归报警。fsync 缺失对 v1「仅防进程崩溃」(01 §4.4)范围可接受,但应注释声明「不防断电」。
- **建议**:补三类用例:①崩溃跨越 lease 到期 → 恢复 + 定时器立即触发 → 判 lost 进入 reclaiming 并发出 cancel;②`restoreAll` 遇损坏 blob → 隔离该文件 + 审计事件 + 其余任务照常恢复;③断言 supervisor 在动作被消费前已完成 persist(可用注入 store 抛错验证「动作不执行」)。`pendingTimers` 补契约注释(atMs ≤ now 时消费方必须立即触发);`JsonFileStore.save` 加 fsync 或范围注释,启动时清理 `.tmp`。

### QA-6 【major】R8 排除表零断言:持久拒绝的排除记录无用例,fail 路径完全不记排除
- **位置**:`packages/node/src/lead/machine.ts:389-399`(`applyExclusion` 仅被 `onOfferedMessage` 的 reject 分支调用,`machine.ts:206-212`);`lead.spec.ts:108-119`(全仓库唯一涉及 `excluded` 的断言是「busy **不**排除」);`docs/testing/R-MATRIX.md:18`(R8 行 ✅(部分));设计条款 01 §6 R8(行 240)、§4.3 fail 码表(行 156「internal_error ✅(同节点最多一次)」)
- **问题**:R-MATRIX 括号里说「过滤在 supervisor 选目标时执行,M2 集成」,但「**记录**排除」这本属 M1 的半句同样无用例:`unsupported_caps / policy_denied / refused_loop` → `permanent`、其余瞬时 reject → `once` 两条赋值路径均无断言,`excluded` 表将来驱动改派过滤(M2),此处出错是静默的。另外 fail 路径(`beginReclaim`)完全不调用排除逻辑:`internal_error` 按 §4.3 应「同节点最多一次」(即一次后排除),实现中 fail(retryable) 改派后仍可能再次选中同节点,R-MATRIX 的 ✅ 覆盖不到这一偏离。
- **建议**:补用例:①reject(unsupported_caps) → `excluded[target]='permanent'`;②reject(其他) → `'once'`;③busy 无 `retry_after_ms` → 不排除(现已覆盖,保留)。fail 路径是否记排除需先回写设计(R8 与 §4.3 码表对齐),再实现与补测;若推迟到 M2,请在 R-MATRIX R8 行如实标注「fail 侧排除未实现未测」。

### QA-7 【major】集成层缺 lost 驱动路径(A4 的核心):harness 无「杀执行方/停心跳」原语,5 个集成用例全部走 fail/cancel
- **位置**:`packages/node/src/local/harness.ts:204-213`(`fireExecTimer` 心跳必 ack,无故障注入点)、全文件无停跳原语;`packages/node/test/integration.spec.ts:19-59`(两个「A4 种子」用例实际走 fail(retryable/false) 路径);任务书 A4(IMPL_PLAN §1 行 18)「**杀掉 B 进程**:A 在 lost 判定后 cancel→drain→attempt+1 改派;超 max_attempts → escalate」
- **问题**:用例命名自称覆盖 A4,但 A4 的主路径——心跳停发 → 牵头方判 lost → reclaim → drain → 改派——在集成层无法表达:只要执行方活着,心跳每 lease/3 必达,lease 定时器永不到期;唯一能触发 lost 的挂起驱动(如 `completeAfterMs: 999_999`)仍持续心跳。lost→reclaim 只存在于单元层(`lead.spec.ts:86-95`),「执行方静默死亡」这一分布式系统最典型的故障从未被端到端排演过,而它恰恰是 M3 仿真层(M3.1 故障注入清单)要复用的剧本种子。
- **建议**:harness 增加 `killExecutor()`(取消 exec 全部定时器 + driver.stop,模拟进程消失),补集成用例:①心跳停发 → lost → reclaiming(cancel 入通道)→ drain 到期 → attempt=2 改派 → done;②连杀三轮 → escalate。此原语同时服务 QA-9 的不变式 property。

### QA-8 【major】可观测性基线未落到 node 层:审计无任务关联字段、忽略类动作零审计、escalate 摘要缺 §11 字段
- **位置**:`packages/node/src/local/harness.ts:122-124、181-183`(`makeAudit` 只传 `node_id/reason`,不传 `task_id/attempt`——而 `core/src/audit.ts:52-64` 本就支持);`packages/node/src/lead/machine.ts:167`(terminal 后入站静默)、`188-189`(drafting 静默)、`217`(running 态非目标来源静默)、`packages/node/src/executor/machine.ts:304`(cancel attempt 不符静默);`machine.ts:366-373`(escalate 摘要无 `trace_id/diagnostics_ref`);设计条款 01 §11(行 301「缺字段视为日志缺陷」、行 299 事件枚举)、R0/R1 的「忽略 + 审计」字样(行 232-233)
- **问题**:R0/R1 明文要求重复/忽略类消息「忽略 **+ 审计**」,实现一律裸 `return []`;§11 v1 枚举(`AUDIT_EVENTS`)中也没有 drop/ignore 类事件名可承载这些审计(lead 对 attempt>current 丢弃复用 `stale_attempt_rejected`,语义勉强,对「重复消息忽略」则完全无事件可用)。harness 是 M3.3「仅凭双机日志 + trace_id 离线还原」(A8)的种子,现在连 task_id 都不带,A8 的距离从未被度量。escalate 结构化事件按 §11 应含 `trace_id` 与 `diagnostics_ref`,实现两者皆缺(M1 无 trace 可理解,但 schema 应预留字段位)。
- **建议**:①`LeadAction.audit`/`ExecAction.audit` 携带 `{task_id, attempt}`(M1 无 envelope,先落这两项,trace_id 留 M2),harness 透传给 `makeAudit`;②`AUDIT_EVENTS` 增加 `duplicate_ignored`/`dropped_future_attempt`(或文档声明复用口径),五处静默点补审计;③escalate 摘要加 `trace_id?: null` 与 `diagnostics_ref?: null` 占位并对齐 §11 schema 断言;④R-MATRIX 增加「§11 审计/指标」行,如实标注 M1 已有(事件发射)与 🔲(指标聚合)。

### QA-9 【minor】property 测试盲区:全部三个 property 都在 core 纯函数上,双机状态机没有任何不变式 property 兜底
- **位置**:`packages/core/test/property.spec.ts:9-54`(R0 全序 / R1 去重 / JCS 幂等,均纯函数);node 侧 0 个 property;M1.2 验收原文(IMPL_PLAN 行 51)「状态×消息×定时器矩阵全转移覆盖」
- **问题**:设计已自认「完整矩阵随双机走查定稿」,本条不重复该承认;要指出的是**在矩阵定稿前的空窗期**,stateful 状态机恰恰最需要 fast-check model-based(命令序列)property 来守住不变式,而现状为零。本次评审的 QA-2/3/4 三处缺陷全部位于「无 property 也无用例」的转移上,即是明证。候选不变式(随机 offer/accept/progress/result/fail/cancel/cancel.ack/定时器交错序列下断言):终态吸收性(终态后任何入站不改变状态)、终态优先级、attempt 单调不减、`acceptedFailedBudget/dispatchRounds ≤ maxAttempts/maxDispatchRounds`、一切新 offer 前必有同 task 的 cancel 先于其入通道(R4 顺序)、executor `result` 发出前必经 `cancelReceived=false` 且未 paused(R5,现会抓到 QA-2)。
- **建议**:用 fast-check `commands` 对 `LeadTaskMachine`+`ExecutorMachine`(可直接以 `SingleNodeHarness` 为 SUT)建 model-based property,先落上述 6 条不变式;双机走查产出全矩阵后,把矩阵用例回填为回归。

### QA-10 【minor】R2 执行方用例靠 `Object.assign` 注入结构性不可达的 offered 态,「offered」实为死状态,R-MATRIX 标注失真
- **位置**:`packages/node/test/executor.spec.ts:75-84`(注释自认「offered 为瞬态」,直接改写 `m.rec`);`packages/node/src/executor/machine.ts:147-192`(四道闸同步通过即 accept,无任何路径停在 `offered`)、`machine.ts:206-215`(`onTtlCheck` 仅 offered 生效)、`machine.ts:296-299`(`onCancel` 的 offered 分支);`docs/testing/R-MATRIX.md:12`(R2 行「node/executor R2(补投 offered 态)」)
- **问题**:M1 实现中执行方不存在可停留的 offered 态(闸 5 本地确认属 M4,03 §6.2),因此 `onTtlCheck` 与 onCancel 的 offered 分支是当前不可达代码;R-MATRIX 所称「补投 offered 态」实为状态注入的合成场景,不是补投语义的验证。规则本体(「晚于」才过期)已由 core `isExpiredByTtl` 边界用例覆盖,风险有限,但 ✅ 的口径与事实不符,且死分支会随重构腐烂。
- **建议**:R-MATRIX R2 行改注「executor 侧 TTL 守卫为 M4 闸 5 异步化后的活性代码,M1 以状态注入覆盖其判定逻辑」;或在代码注释标明 offered 为 M4 预留态。M4 实现闸 5 本地确认时,必须让 offered 成为真实驻留态并补「确认完成遇过期仍 reject(expired)(可附 confirmed_late)」用例(03 §6.2 末条)。

### QA-11 【minor】「A2 单机版」集成用例全部 kind:'project',aid 参数路径在集成层零覆盖
- **位置**:`packages/node/test/integration.spec.ts:8、20、37、49、62`(五例均 `kind: 'project'`);A2 原文(IMPL_PLAN §1 行 16)「A 派 **aid 单** → …」;M1.1 验收(IMPL_PLAN 行 50)「桩执行器跑通 A2 的单机版」;参数差异 `packages/core/src/params.ts:33-37`
- **问题**:集成标题声称「A2 单机版种子」,但 A2 定义是 aid 单;aid 的参数组合(offer_ttl 10s / lease 120s / 心跳 40s / lost 110s)只被单元层的 `offerInput` 字面量间接碰到,集成层(两台状态机 + 虚拟时钟 + 驱动联动)从未以 aid 参数跑过。kind 在代码里仅影响参数化,风险低,但这是追溯口径问题:要么改 A2 的对照说法,要么补齐参数。
- **建议**:把集成主路径用例参数化为 `kind: 'aid'`(断言心跳间隔 40s、lost 110s),project 版保留并改称 A3 种子;或最小代价加一例 aid 主路径。

### QA-12 【minor】CLI(M1.4)零自动化测试,demo/takeover 的退出码契约无回归保护
- **位置**:`packages/cli/src/main.ts:25、42`(以退出码承载验收判定);仓库无任何 cli 测试文件;M1.4 验收(IMPL_PLAN 行 53)「断网单机全功能(A2 单机版)」
- **问题**:CLI 是 M1 唯一的进程级出口,其「成功=exit 0」契约目前只靠手工运行;`main.ts` 直接深路径 import `../../node/src/...`(绕过包导出),包边界正确性也无测试。风险低(逻辑薄),但里程碑验收项不应只有手工证据。
- **建议**:补一个 vitest 子进程冒烟用例:`node packages/cli/src/main.ts demo` 与 `... takeover` 断言 exit 0;R-MATRIX 增加 CLI 行。

### QA-13 【nit】R-MATRIX 两处与代码现状不同步
- **位置**:`docs/testing/R-MATRIX.md:14`(R4 行「🔲 ack 提前收口用例排 M3 仿真」)——`checkpoint.spec.ts:77-94` 已实际覆盖 reclaiming 中 cancel.ack 提前收口→改派;`R-MATRIX.md:12`(R2 行措辞,见 QA-10)
- **问题/建议**:矩阵是追溯的唯一账本,落后于测试会误导下一版排期;请把 ack 提前收口移入 ✅(并注明覆盖位置),R2 措辞同步。

## 亮点

- **测试真实可复跑且账实相符**:实机复跑 core 42 + node 37 全绿,与 R-MATRIX 声明的用例数(lead 9 / executor 11 / caps 5 / checkpoint 7 / integration 5)逐一吻合,无凑数用例。
- **虚拟时钟集成层确定性设计好**:`SingleNodeHarness.advanceTo` 按时间序推演含过程中新排程的定时器(`harness.ts:93-104`),同一剧本可精确复现,是 M3.1 离散事件仿真的正确雏形;集成断言打到了 `lastSeq === heartbeatCount` 这类跨机一致性上(`integration.spec.ts:14`)。
- **参数与不变式单一事实源**:01 §10 → `core/params.ts` 同源,`assertLeaseInvariant` 把 R3 不变式变成可执行断言并在 core 语义测试中验证正反例。
- **竞态主场景有真实断言**:R4/R5 双向赛跑(lead reclaiming 收 result → done;executor result_sent 收 cancel → ack 带标记)、cancelling 三分支(ack/超时/竞态 done)均有用例;检查点接管连「reclaiming 中崩溃 → ack 提前收口 → 改派」这种深剧本都覆盖了(`checkpoint.spec.ts:77-94`)。
- **caps D31 匹配语义正反例齐全**(`caps.spec.ts`),含「档案段数不足不匹配」「未知类整串精确」等评审 I-30 的关键钉死点。

## 开放问题(提请委员会/双机走查裁定,非缺陷)

1. **竞态窗口内 result 是否过验收**:§5.1 竞态条款(reclaiming/cancelling 收 result → done)与 D25 验收语义在「窗口内到达的 result 验收不过」时冲突,实现目前取 done(见 QA-4 附注),需双机走查钉死并回写。
2. **fail 路径的 R8 排除口径**:`internal_error`「同节点最多一次」(§4.3)与 R8「瞬时 retryable 仅排除一次」是否适用于 fail(而非仅 reject),实现与矩阵均未覆盖,需裁定后回写。
3. **执行方恢复条件的权威定义**:R3 只写「暂停」,恢复触发(心跳发送成功?获回执?)需在 01 篇补一句,M3 前定稿(见 QA-3)。
4. **`pendingTimers` past-due 契约的归属**:恢复方立即触发过期定时器的责任写在实现注释还是 01 §4.4,建议随双机走查一并入文(见 QA-5)。