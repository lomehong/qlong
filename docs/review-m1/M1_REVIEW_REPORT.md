# 群龙 M1 里程碑评审报告

> 评审委员会汇总报告。本报告仅依据 `docs/review-m1/` 下五份 `REVIEW_*.md` 汇总合并,不引入新论断;行号以各评审文件评审时点为准。

## 一、评审信息

- **评审对象**:M1「单机核心」`packages/node` + `packages/cli` 全部源码与测试(node 37 项);core 为 M0 已评审基线,仅在与 M1 交界面处核对(core 42 项,实机复跑全绿)。
- **对照基线**:`QLONG_DESIGN_01_MSG_PROTOCOL.md`、`QLONG_DESIGN_02_REGISTRY_TRUST.md`、`QLONG_DESIGN_03_CAPABILITY.md`、`QLONG_DESIGN_NOTES.md`、`QLONG_IMPL_PLAN.md`、`docs/testing/R-MATRIX.md`。
- **角色覆盖**:5/5 齐备,无缺失角色。

### 评审团构成

| 角色 | 评审文件 | 结论 | 意见数(blocker/major/minor/nit) |
|---|---|---|---|
| 架构与状态机 | REVIEW_ARCH.md | 有条件通过 | 1 / 6 / 5 / 3(计 15) |
| 分布式语义与可靠性 | REVIEW_DIST.md | 需重大修订 | 1 / 5 / 6 / 3(计 15) |
| 安全 | REVIEW_SEC.md | 有条件通过 | 0 / 5 / 4 / 1(计 10) |
| 测试充分性与可观测性 | REVIEW_QA.md | 有条件通过 | 0 / 8 / 4 / 1(计 13) |
| 接口与实现质量 | REVIEW_API.md | 有条件通过 | 1 / 7 / 2 / 2(计 12) |

合计原始意见 65 条,合并同一问题后为 **37 条:blocker ×3、major ×18、minor ×11、nit ×5**。

## 二、总体结论与执行摘要

M1 单机核心的骨架方向获评审团一致肯定:两台「纯转移函数 + 动作外置、时钟注入」的状态机忠实落实 P2「换通道不换语义」,§5.1 主干与终态优先级、R4「先撤销后改派」、R7 双预算、参数/码表单一事实源实现准确且测试真实可复跑、账实相符。但汇总后存在 **3 项 blocker、18 项 major**:接管恢复后定时器无人重挂、心跳续租定时器泄漏致存活超 230s 的健康长任务必被误判 lost、执行方 `offered` 态不可达使 R2 过期拒收失效——三者均属「M2 接上真实传输/真实时序即激活」的缺陷,今天被单机回环与默认参数错开的测试盲区掩盖。其余 major 集中在执行方对异常消息序列的守卫缺口(异任务覆盖、已决重复 offer 重跑、赛跑窗口绕过验收)、core 语义纯函数未在 node 复用导致的语义分叉与脱测、检查点恢复路径失败开放、以及审计关联字段/信封元数据在接口层整体缺位。五视角中四判「有条件通过」,分布式视角因长任务功能性死锁单判「需重大修订」。**建议:修订后进入 M2**——blocker 与 P0 项修毕并针对性复验通过后方可收口,当前状态不可直接收口。

### 三个关键风险

1. **接管(重启恢复)活性断裂**:M1.2 验收核心特性在真实条件下根本不可用(问题 2)。
2. **心跳续租定时器泄漏**:任何长于首个 lost 死线(默认 230s)的健康任务必被误回收并循环改派直至 escalate,功能性死锁;现有集成测试(最长 150s)恰好全部落在死线之下未暴露(问题 3)。
3. **执行方接单闸同步内联、`offered` 死状态**:M2 至少一次投递/收件箱补投一接入,过期 offer 将被照单接受开跑僵尸任务;且同批守卫缺口(重复 offer 重跑、异任务覆盖、赛跑窗口绕验收)会被至少一次投递同时激活(问题 1、4、7、21)。

## 三、问题清单(合并去重,blocker > major > minor > nit)

### Blocker

| 编号 | 严重度 | 位置 | 问题 | 建议 | 提出角色 |
|---|---|---|---|---|---|
| 1 | blocker | `node/src/executor/machine.ts`(evaluateOffer L137-192、onTtlCheck L206-215;无任何路径置 `offered`);`test/executor.spec.ts:75-84`;`docs/testing/R-MATRIX.md:12` | 执行方接单闸被实现为同步内联评估,`offered` 为不可达状态:`onTtlCheck` 与 `onCancel` 的 offered 分支均为死代码,R2 的 `reject(expired)` 拒绝路径在生产流程不可达——长期离线节点上线后批量过期 offer 会被照单接受并开跑(01 R2 必测场景)。测试靠 `Object.assign` 伪造状态到达该分支,R-MATRIX R2 行 ✅ 口径失真;同步闸模型也无法表达 M4 闸 5「本地确认与 TTL 赛跑」所需的可驻留待决态 | `evaluateOffer` 改两段式:onOffer 先置 `offered` 并排 ttl 定时器,评估结果到达后再 accept/reject,TTL 先到即 `reject(expired)`(「晚于」判向);或至少在闸 2 前增加以本机收到时刻为起点的 TTL 闸。补「批量补投过期」确定性用例;R2 TTL 时刻锚定口径(补投场景的原始派发时刻来源)提请设计侧补一句话;R-MATRIX R2 行改回如实 | API(blocker)、ARCH(major)、DIST(major)、QA(minor) |
| 2 | blocker | `node/src/lead/supervisor.ts:35-43`(restoreAll)、`lead/checkpoint.ts:43-55`(pendingTimers 生产零调用)、`cli/src/main.ts:28-43`(takeover 命令) | 接管恢复活性断裂:`restoreAll()` 只重建机器对象不调度任何定时器,`pendingTimers()` 全仓库无生产调用方;真实重启后恢复为 offered/running/reclaiming/cancelling 的任务永远等不到 offer_ttl/lease/drain/cancel_wait,恢复为 drafting 的任务改派意图(requestDispatch)无人补发且无守卫定时器——01 §4.4 接管与 M1.2 验收核心在真实条件下不可用。「恢复时定时器已过期」(崩溃时长>剩余租约)的责任归属未定义、零测试;CLI takeover 用同进程 MemoryStore 伪造「崩溃」,演示与验收语义不符 | `restoreAll()` 返回每任务 `{taskId, timers, needsDispatch}` 由上层 TimerService 重挂(到期定时器立即触发一次转移),drafting 恢复重发 requestDispatch 并补活性守卫;`pendingTimers` 补 past-due「消费方必须立即触发」契约并回写 01 §4.4;takeover 改 JsonFileStore + 子进程真实重启演示;补「崩溃跨越 lease 到期→恢复→立即判 lost→reclaim」用例 | ARCH(blocker)、QA(major,过期定时器恢复零覆盖)、SEC(nit,演示叙事)、ARCH(nit,演示工程化) |
| 3 | blocker | `node/src/lead/machine.ts` L218-222(task.progress 续租仅排新 lease 定时器不取消旧)、L305-310(onTimer('lease') 无 deadline 复核);`local/harness.ts` L128-130 | 心跳续租向定时器表**追加**新 lease 定时器而旧的不取消,最早一条(accept 时刻)先触发且 `onTimer('lease')` 不核对当前 `leaseDeadline` 即判 lost:默认参数下任何存活超过 230s 的健康长任务(心跳每 100s 正常到达)必被误回收,改派后循环烧尽 max_attempts→escalate,功能性死锁。执行方续租先 cancelTimers 再排程的不对称证明系遗漏而非设计;集成测试最长 150s 恰好全部落在死线下,37 项无一覆盖「心跳存活跨过首个 lost 死线」 | `task.progress` 分支返回 `[cancelTimers(['lease']), schedule(lease)]`(与执行方对齐);`onTimer('lease')` 增加 `now < leaseDeadline ? return []` 防御复核;补「心跳存活 ≥2×lostAfter 的长任务跑完,attempt===1、无 reclaim 审计」集成用例 | DIST(blocker) |

### Major

| 编号 | 严重度 | 位置 | 问题 | 建议 | 提出角色 |
|---|---|---|---|---|---|
| 4 | major | `executor/machine.ts:21-37、100-135、169-184、251-269、281-304`;`executor/gates.ts:44-53`;`local/harness.ts`(未注入 load) | 执行方单任务记录:异 task_id offer 无守卫直接覆盖 rec——旧驱动不被 stop、旧牵头方 cancel 因 attempt 不匹配被静默丢弃(旧任务永不可撤销),旧驱动迟到 complete 会以新任务的 `rec.from` 发往新牵头方(跨任务结果错配);gateLoad `>` 判满 off-by-one(maxRunning=1 时 `1>1` 为假放行)恰好触发覆盖。与 03 §3.3「queue_depth 含已接受远端任务」的并发语义相悖;M1 单任务接线掩盖,M2 起真实生效 | 二选一,M3 双机前必须定案。A. 单槽语义:running/offered 收异 task_id offer 一律 `reject(busy, retry_after_ms)`;B. 并发化:`rec` 改 `Map<task_id, ExecRecord>`,`onDriverCompleted/onCancel/onStaleReject` 带 task_id 校验归属。无论 A/B,onCancel 增加 task_id 参数比对;gateLoad 改 `>=` 并让闸 4 计入机内状态;补「旧任务仍可被 cancel 停止」用例;执行槽模型提请双机走查定案 | ARCH(major)、SEC(major)、API(major) |
| 5 | major | `lead/machine.ts:169-177、389-405`;`executor/machine.ts:206-215`;core 的 attempt-gate/dedup/reason-codes/freshness 在 packages/node 零引用(grep 证实) | core 语义纯函数(attemptGate/DedupStore/isExpiredByTtl/isPersistentReject/normalizeRejectCode/normalizeFailCode)未被 node 复用,两台状态机内联重写且已分叉弱于 core:丢 implicit_cancel 与「已决重复忽略」语义、未知码原样透传(`x-` 私有码被当瞬时失败排除)、`normalizeFailCodeOrReject` 空壳名不副实;重复实现中两条 R0 分支(lead 侧 attempt>current 丢弃、executor 侧 attempt<current 拒收)完全脱测,R-MATRIX ✅ 由 core 测试越权背书——core 42 项绿灯对 node 无约束力 | node 入站统一先过 core `attemptGate` 按裁决分派;R8 排除改用 `isPersistentReject`、TTL 判定改用 `isExpiredByTtl`、码表归一改用 core normalizer(custom 原值进 detail);增加架构测试或 lint 规则禁止 machine 内重写这四类判定;过渡期至少为脱测分支补 node 用例并在 R-MATRIX 注明覆盖口径 | ARCH(major)、QA(major)、API(major×2) |
| 6 | major | `executor/machine.ts:241-248、250-269` | R5 僵尸自检只实现一半:`onDriverCompleted` 仅查 cancelReceived,本地租约已超时(paused)后驱动完成仍发 result——违反 R5 字面与 R3「暂停产生新副作用」;M3.2 断线重连场景下正是协议要求抑制的僵尸形态。现有用例只测 paused 抑制心跳与 cancel 后完成,该转移落在盲区 | `onDriverCompleted` 增加 `cancelReceived \|\| paused` 分支→置 stopped、回 cancel.ack(可附 detail 区分原因);`onDriverFailed` 同理自检;补「lease_self 超时→驱动完成→回 ack 不发 result」用例 | DIST(major)、QA(major)、ARCH(minor) |
| 7 | major | `lead/machine.ts:259-264、283-288`(对照 running 态 223-235 均经验收) | reclaiming/cancelling 赛跑窗口内 result 直接 finish('done') 不调 validateAcceptance:验收不合格产物可作为终态交付进整合,绕过 R4 验收失败归途与 D25。01 §5.1 竞态行字面支持现实现——设计两处相互冲突,实现取了字面之一;按 impl plan §5 必须显性裁决,不能停在代码现状 | reclaiming 窗口内 result 仍执行验收:通过→done,不通过→维持改派(记 acceptance_failed);cancelling(用户主动取消)可保留 done;按裁决回写 01 §5.1 竞态行消除双源冲突,随 §8.4 双机走查定稿 | ARCH(major)、DIST(minor)、QA(major 附注) |
| 8 | major | `lead/checkpoint.ts:28-39`;`lead/store.ts:44-56`;`lead/supervisor.ts:35-43、101-103` | 检查点恢复路径失败开放:`restoreLeadMachine` 对 blob 仅 JSON.parse 后整体信任(state 非法静默吞、attempt 可置 0/负、history 任意形状注入);`JsonFileStore.load` 捕获一切异常返回 undefined→任务无痕消失、无审计无告警;`restoreAll` 无逐文件 try/catch,一个坏文件瘫痪全部任务接管。「先持久化后动作」的崩溃安全顺序无注释无用例锁定;tmp+rename 无 fsync、残留 .tmp 无清理;检查点损坏/持久化顺序两类崩溃一致性场景零测试 | 新增 `validateCheckpoint` 严格校验(v/state 枚举/attempt≥1/terminal 与 state 一致/预算非负不超上限/无 NaN);坏文件重命名隔离区(`*.quarantine`)+ 审计事件(如 `checkpoint_restore_failed`)+ 启动摘要;`restoreAll` 逐文件 try/catch;补用例:损坏 blob→隔离+审计+其余任务照常恢复;注入 store 抛错断言「动作不执行」;fsync 或注释声明「不防断电」,启动时清理 .tmp | SEC(major)、QA(major) |
| 9 | major | `lead/checkpoint.ts:2-15`;`lead/machine.ts:127-131`(dispatchTo 无条件 attempt=1);`lead/supervisor.ts:49-61` | attempt 高水位/检查点纪元仅有注释声称而无实质字段与单调性防御:`dispatch`/`redispatch` 两入口可混用,改派中途(drafting、attempt≥2)崩溃恢复后误用 dispatch 会把 attempt 重置回 1——执行权纪元单调性破坏,R0 fencing 失守;检查点文件回滚(备份恢复/同步盘回滚)场景同样无防备;01 §4.4 要求的全局 attempt 高水位、检查点纪元、恢复单调断言均缺失 | `dispatchTo` 增加 `attempt !== 0` 守卫(或与 redispatchTo 合并单入口按 attempt===0 分流);恢复时断言 attempt 单调,回退→拒绝恢复并走隔离+审计;`LeadCheckpoint` 增加 epoch 占位字段(只增不减);restoreAll 输出在途 `(task_id, attempt, target)` 清单,为 01 §4.4 跨机 fence 预留数据 | SEC(major)、DIST(major) |
| 10 | major | `lead/machine.ts:197-199` | accept 回值 `lease_ms` 照单全收、可被单方面上调:01 §4.2 明文「确认或下调」;异常/被攻陷执行方回 `1e13` 即令 lost 判定与 R4 回收被单方面解除,任务成不可回收僵尸租约——单位写错(毫秒传微秒)即可触发同后果 | clamp 为 `min(body.lease_ms, offer 建议值)`(或引入参数化上界 maxLeaseMs),clamp 发生记审计(`lease_ms_clamped`);补「accept 上调租约→leaseDeadline 仍按 offer 值」用例 | SEC(major)、DIST(minor)、ARCH(nit) |
| 11 | major | `lead/machine.ts:236-249、300-310、389-399、396-397`;`local/harness.ts:125-127`;`lead/supervisor.ts:49-61` | R8 排除不闭环:fail(retryable)/lost 路径完全不记排除(`internal_error`「同节点最多一次」在 cli demo 即违反)、busy 无 retry_after_ms 不排除与 R8 文义不符;`excluded` 表全仓无读取方、requestDispatch 动作不携带排除快照,harness 硬编码重派 nodeB——连「排除后改派他人」在 M1 都无从演练;R-MATRIX 未披露记录面缺失 | beginReclaim/budgetOrEscalate 按 origin 记录:fail(retryable)→once、lost→once、busy 无 retry_after_ms→once(或回写 R8「busy 一律不排除」二选一);requestDispatch 增加 excluded 字段;supervisor/harness 增加带排除过滤的选目标接缝(无可用目标走 escalate/等待);fail 路径排除口径先回写设计再实现;R-矩阵相应行如实降级 | DIST(major)、QA(major)、ARCH(minor)、DIST(minor:busy 口径) |
| 12 | major | `lead/machine.ts:383-385、166-177、188-189` | drafting 改派间隙竞态未定义:drain 收口到 redispatch 之间 attempt 不递增,窗口内旧 attempt result 满足 `attempt===current` 被静默吞掉(无审计、无 stale 拒收、无 done 裁决)——M1 里 requestDispatch 同步处理掩盖窗口;M2 引入选目标/查目录后窗口可任意长,造成双执行且旧交付无任何痕迹;01 §5.1 竞态条款未覆盖 drafting 态 | 二选一(连同用例落定):① drain 收口即 attempt+1 作 fence,旧 attempt 消息自然落入 R0 stale 分支;② 保留现结构,drafting 收 result 按 §5.1 竞态同样裁决 done 并取消待决改派。补「drain 收口→redispatch 前迟到 result」用例 | QA(major) |
| 13 | major | `executor/driver.ts:6-26`;`executor/machine.ts:279-294、218-228` | 驱动接缝双向不足:① `stop(): void` 无完成回调、DriverHost 无 stopped/progress 通道——承接不了 deepseek-harness 会话型、不可强杀基座,适配层只能在会话真停前谎报 cancel.ack 或在状态机外打补丁;心跳体硬编码,progress 的 pct/note/logs_ref 无处来源;② `DriverTask` 未预留来源与执行档案上下文(from.node_id/remote 判定/profile 约束集),真实基座直连后驱动无法区分远端任务,03 §6.1 低权执行档案在接口上无着力点,M4 沙箱要么破坏接口要么外层绕接缝 | `DriverHost` 增 `stopped(): void` 与可选 `progress(partial)`;执行方 stopDriver 后进 stopping 过渡,收到 stopped() 才回 cancel.ack(驱动可声明同步停止能力时豁免);心跳体合并 driver 进度;`DriverTask` 增加 `source:{node_id, team_id?, remote}` 与 `profile`(工作区根/出口策略/凭证注入开关),接口注释钉死「offer.body 未经档案包装不得直达基座」;为 R10 预留受限网络出口钩子 | API(major)、SEC(major) |
| 14 | major | `lead/machine.ts:166、59-66、366-381`;`executor/machine.ts:280、105、304 等`;`wire.ts:2-8`;`local/harness.ts:122-124、181-184` | 状态机接口不含 msg_id/trace 等信封元数据,§4.5 reply_to 与 §11 审计关联在当前 API 下不可实现:审计仅 event/node_id/reason,task_id/attempt 在调用点明明可得却不传(01 §11「缺字段视为日志缺陷」);R0/R1 要求的「忽略+审计」在五处以上静默分支裸 return,枚举中也无 drop/ignore 事件可承载;escalate 摘要缺 trace_id/diagnostics_ref;M2 换传输时接口须破坏性修改,与「只换传输、状态机不动」承诺冲突 | 入站统一传信封头切片(至少 `{msg_id, trace}`),Outbound 补 trace/reply_to 装配位;audit 动作携带 task_id/attempt(msg_id/trace_id 留 M2 信封),harness 透传 core/audit 现成字段;AUDIT_EVENTS 增 `duplicate_ignored`/`dropped_future_attempt`(或文档声明复用口径),五处静默点补审计;escalate 摘要补 trace_id/diagnostics_ref 占位并对齐 §11 schema | API(major)、QA(major)、ARCH(minor)、SEC(minor)、DIST(nit)、ARCH(nit) |
| 15 | major | `local/harness.ts:92-104`(advanceTo 同刻按插入序) | 虚拟时钟同刻定时器按插入序触发、无 tie-break 规则:grace=0 等参数下 lease 死线与心跳同刻时,插入序使 lease 先触发误判 lost(按 R2「晚于才过期」应心跳先到完成续租);驱动完成与 lease 死线同刻时结果因插入序相反而相反——同一物理场景得出相反终态。默认参数(230/100 错开)回避了全部同刻故 37 项全绿;M3.1 离散事件仿真明确要「赛跑/超时确定性复现」,将直接继承该未定义语义 | 定义并文档化显式 tie-break(建议:消息投递/驱动回调(已发生事实)> 执行方心跳 > 超时类定时器,同 owner 同刻按排程序);machines 层对 `now === deadline` 的取舍与 R2「晚于」对齐(或在 R-矩阵注明口径差异系有意);补同刻赛跑确定性用例锁定规则 | DIST(major) |
| 16 | major | `node/src/index.ts:1-7`;`cli/src/main.ts:5-7`;`node/package.json`(无依赖声明,tsconfig paths 别名) | 包边界失真:公共 API 不含 store/checkpoint/supervisor——M1.2/M1.3 交付物(检查点、监督器、存储)无包契约,M2 registry/gateway 按 `@qlong/node` 正规导入拿不到接管组件;CLI 相对路径深引 node 源码,node 任何内部重组即断;exFAT 折衷使「package」退化为目录约定 | index.ts 补齐三模块导出;CLI 改从 `@qlong/node` 包名导入(路径别名机制可保留);README 记录 exFAT 约束与退出条件(换 NTFS/CI 环境恢复 workspace 依赖),防折衷永久化 | API(major)、ARCH(nit)、DIST(nit) |
| 17 | major | `local/harness.ts:204-213`(心跳必 ack,无故障注入点);`test/integration.spec.ts:19-59` | 集成层缺 lost 驱动路径:5 个集成用例全部走 fail/cancel,「执行方静默死亡」(心跳停发→lost→reclaim→drain→改派→escalate)这一分布式最典型故障从未被端到端排演,而它正是 M3.1 故障注入清单要复用的剧本种子;用例自称覆盖 A4 但 A4 主路径在集成层结构性不可表达(lost 只存在于单元层) | harness 增加 `killExecutor()`(取消 exec 全部定时器 + driver.stop,模拟进程消失);补集成用例:① 心跳停发→lost→cancel 入通道→drain 到期→attempt=2 改派→done;② 连杀三轮→escalate;该原语同时服务 model-based property | QA(major) |
| 18 | major | `executor/machine.ts:246、231-238` | executor paused 无恢复路径:单向阀门——置位后拒发心跳,但 ack 仍续租重排 lease_self 定时器,形成「定时器空转但永不恢复」半死态;R3 对称语义(发送能力恢复即重新续租,I-09)缺「paused→running」转移,零测试覆盖(loopback 回执必达使该场景在集成层不可达);M3 一次网络抖动即把执行方永久冻结,只能等牵头方 lost 回收 | 定义恢复条件(建议:心跳发送获回执成功即解除 paused 并重排心跳)在 `onHeartbeatAcked` 实现;补两例:paused 后 ack→恢复发心跳;paused 期间 ack→不再空转重排。恢复条件权威定义回写 01 篇,M3 前定稿 | QA(major) |
| 19 | major | `local/harness.ts:144-174`(无 ingress 管线;L167 attempt 兜底);`executor/machine.ts:86-99`(verified 前置仅在注释);`executor/gates.ts:16-26` | harness 入站管线缺未来网关语义接缝:无 to_node 校验、无 exp 检查、无 R1 去重位、无验签证据(onOffer 的「闸1 已验签」前置只存在于注释,验签失败分支漏接时 missing 明细将发往未认证方,违反 02 A6 回声分级);`msg.attempt ?? rec.attempt` 兜底把「缺 attempt」协议违规漂白为合法当前值,与 R0「attempt 第一道闸门」相反——M2 将在无测试先例的空白层上加执法 | 抽出 `IngressPipeline`(验签→to_node→exp→DedupStore→attemptGate)接口,M1 即用 core 纯函数实现并用故障注入用例锁住,M2 换真实现;删除 `??` 补齐(出站 attempt 必填、入站缺失按装配错误丢弃+审计);onOffer 增加字面量类型 `verified: true` 前置或入口断言;gatePolicy/ExecutorOptions 缺省「未配置=全放行」写进 TSDoc | API(major 部分)、ARCH(minor)、SEC(minor×2)、DIST(nit) |
| 20 | major | `executor/machine.ts:112-130、308-316`;`lead/machine.ts:169-177`;`local/harness.ts:159-161` | R0③ 隐式取消回执回弹杀伤新 attempt:改派回原节点且执行方持旧 attempt 时(lost→drain 收口→同节点重 offer,M3 常态),执行方按 R0③ 发回旧 attempt 的 reject(stale_attempt) 后 accept 新 attempt;牵头方 R0 见 attempt 低于当前机械弹回,执行方 onStaleReject 不校验 (task_id, attempt) 凡 running 一律停驱动清理——把刚启动的新 attempt 杀掉,随后等满 230s 判 lost 再烧一个 attempt。单节点回环 cancel 同步送达使路径不触发,被传输形态掩盖 | `onStaleReject` 增加 (task_id, attempt) 入参,仅与当前一致才清理,否则忽略+审计;harness 路由 task.reject 透传 attempt;牵头方对旧 attempt 回弹的审计 reason 标注「隐式取消回执回弹」;补直接注入消息序列的单测:offer(1) running→offer(2)→断言 accept(2) 后执行方仍 running | ARCH(major) |
| 21 | major | `executor/machine.ts:100-135`;`local/harness.ts:144-162` | 已决状态收到同 attempt 重复 offer 会重新接单重跑:R0 明文「已决状态下重复消息一律忽略+审计」,现实现 result_sent/fail_sent/rejected/stopped/cleaned 状态直接落入 evaluateOffer 重新 accept+startDriver——完整重跑已完成任务并二次发送 result(至少一次投递下重放在 M2+ 是常态);同键重复的忽略分支亦无审计;总线层无 R1 去重,状态机守卫与传输边界去重两层今天都缺 | onOffer 入口先判同 (task_id, attempt) 且 state∈已决集→忽略+审计;M2 接线时把 DedupStore 放节点入站边界(与 02 P10 双重执法同构),两层并存;至少修状态机守卫,同时防住「非重复但异常」的同键 offer | ARCH(major)、API(major①) |

### Minor

| 编号 | 严重度 | 位置 | 问题 | 建议 | 提出角色 |
|---|---|---|---|---|---|
| 22 | minor | `lead/machine.ts:257-296`(对照 running 态 L216-217 有来源校验) | reclaiming/cancelling 不校验消息来源节点:窗口内任何同队节点的伪造/串线 result(attempt 恰为当前值)都能把任务标 done——attempt 闸门只对数不对人 | 两处签名补 fromNode 并统一 `fromNode === rec.target` 校验,不匹配→忽略+审计;harness deliverToLead 的 from 做成参数便于测试 | DIST(minor) |
| 23 | minor | `lead/machine.ts:197-199`;`core/params.ts:63-66` | R3 lost 判定锚点提前一个心跳间隔:公式锚点是「最后一个应收心跳的预计时刻」,首个死线应为 accept+lease+grace;实现从 accept 直接加 lostAfterMs(默认 300s vs 430s)。方向保守、不变式不破,但容忍窗比设计允诺少一半 | accept 时 `leaseDeadline = now + lease/3 + lostAfterMs(lease)`;或保持现状并回写文档注明「accept 视为虚拟心跳」的口径决策 | DIST(minor) |
| 24 | minor | `executor/machine.ts:279-305` | fail_sent/stopped/cleaned 态收 cancel 不回 ack(重试型回收常规时序:fail 先到、cancel 后到),lead 只能等满 drain_ms;至少一次投递下 stopped/cleaned 收重发型 cancel 无回执,M3 接 R11 outbox 后每个 cancel 会重发到满窗口 | onCancel 增加 fail_sent/stopped/cleaned 分支:回 cancel.ack(可附终态摘要),使提前收口对所有改派路径生效 | DIST(minor) |
| 25 | minor | `executor/machine.ts:137-192`;`lead/machine.ts:31-55、88-93` | deadline_ms 与 contract 未入状态机:执行方无超期自弃路径(fail(deadline_exceeded) 在 node 层不可达,超期任务跑满 lease 白耗算力,属状态机语义不应随驱动接口悬置);LeadRecord 不存 offerBody/contract,缺省验收对「contract.acceptance 非空而 acceptance_results 未回填」判过,fail-open 与 A3 收紧方向相反 | accept 时按 `now + deadline_ms` 排程,到期置 paused 并 `fail(deadline_exceeded, retryable=true)`;LeadRecord 存 offerBody(与 ExecRecord 对称);缺省验收改为「contract.acceptance 非空而结果缺失→不通过」 | ARCH(minor)、API(minor) |
| 26 | minor | `lead/store.ts:35-47` | JsonFileStore 文件面硬化缺位:file(taskId) 未校验字符集(`..`/路径分隔符可落点目录外,M2+ 以远端 offer 携带的 task_id 作存储键即成路径穿越);检查点文件权限未收窄(内容含任务书/结果正文);无完整性校验(HMAC/校验和),损坏与篡改恢复前不可发现(与问题 8 叠加) | file() 校验 taskId 匹配 uuid/`[A-Za-z0-9-]` 格式;落盘显式 mode 0o700/0o600;blob 追加 HMAC(密钥本机随机、与检查点分目录存放),随校验函数一并消费;密钥选型与 01 §13.2 跨机加密同场设计 | SEC(minor) |
| 27 | minor | `core/test/property.spec.ts:9-54`(node 侧 0 property) | 双机状态机无任何不变式 property 兜底:本次 R5 自检、paused 恢复、drafting 竞态三处缺陷全部位于「无 property 也无用例」的转移上;矩阵定稿前的空窗期恰最需要 model-based property | 用 fast-check commands 对双机(以 SingleNodeHarness 为 SUT)建 model-based property,先落 6 条不变式:终态吸收性、终态优先级、attempt 单调不减、双预算不超上限、新 offer 前 cancel 先入通道、executor 发 result 前必未 paused 未收 cancel;矩阵定稿后回填回归 | QA(minor) |
| 28 | minor | `docs/testing/R-MATRIX.md:10、12、14、18` | R-MATRIX 账实不符多处:R0 行 ✅ 由 core 测试越权背书 node 内联实现;R2 行「补投 offered 态」实为状态注入合成场景(与问题 1 联动);R8 行未披露 fail 侧排除未实现未测;R4 行「ack 提前收口排 M3」实际已被 checkpoint.spec 覆盖——矩阵是追溯唯一账本,落后于测试会误导下一版排期 | R0 行注明 node 侧内联用例位置;R2 行改注「executor TTL 守卫为 M4 异步化后的活性代码」;R8 行如实标注 fail 侧缺口;ack 提前收口移入 ✅ 并注明覆盖位置 | QA(minor+nit)、DIST(major 披露部分) |
| 29 | minor | `test/integration.spec.ts:8、20、37、49、62` | 「A2 单机版」集成用例全部 kind:'project',aid 参数组合(offer_ttl 10s/lease 120s/心跳 40s/lost 110s)在集成层零覆盖,追溯口径不符 | 主路径用例参数化 kind:'aid'(断言心跳 40s、lost 110s),project 版改称 A3 种子;或最小代价补一例 aid 主路径 | QA(minor) |
| 30 | minor | `packages/cli`(无任何测试);`cli/src/main.ts:25、42` | CLI 零自动化测试:「成功=exit 0」契约只靠手工运行;深路径 import 的包边界正确性无测试;里程碑验收项不应只有手工证据 | 补 vitest 子进程冒烟用例:`node main.ts demo` 与 `... takeover` 断言 exit 0;R-MATRIX 增加 CLI 行 | QA(minor) |
| 31 | minor | `lead/supervisor.ts:63-75、101-103`;`lead/checkpoint.ts:43-55` | Supervisor 未知 task_id 直接触发异常(stray 消息炸宿主,应按 R0 忽略+审计);终态检查点只写不删、无限累积(CheckpointStore.delete 无调用方);pendingTimers 返回 string 丢了 TimerName 类型约束,恰在最不该出错的恢复边界丢类型 | 未知任务入站按 R0 返回「忽略+审计」动作而非抛异常;任务进终态后由 supervisor 调度 store.delete 或标记可回收;pendingTimers 返回 TimerName | API(minor) |
| 32 | minor | `executor/machine.ts:90-99、137-146`;`executor/gates.ts:16-26` | onOffer/evaluateOffer 的 team 入参从未使用(虚位误导调用方以为已复核);gatePolicy(undefined) 缺省全放行未在接口声明——不要求 M1 落地 ACL,但不应默默假装存在防线 | 删死参数或落地最小校验(不等则删);缺省语义写进 TSDoc 并留 M4 执行档案闸接入口说明 | API(minor) |

### Nit

| 编号 | 严重度 | 位置 | 问题 | 建议 | 提出角色 |
|---|---|---|---|---|---|
| 33 | nit | `core/params.ts:73-79`(生产零调用) | assertLeaseInvariant 仅存在于测试:自定义参数(如 grace=200s)会静默产出执行方先于 lead 判 lost 的配置,直到运行期以诡异时序暴露 | LeadTaskMachine/ExecutorMachine 构造(或 params 装配入口)调用该断言 | DIST(nit) |
| 34 | nit | `executor/machine.ts:255-261`;`lead/machine.ts:53-54、146-163` | 竞态细节三则:cancel 后完成的空 ack 无 `completed_before_cancel` 标记(成果不进 drain 窗口,白烧一次改派);redispatchTo 不清 resultBody/cancelReason,跨 attempt 残留进检查点(escalate 摘要缺字段已并入问题 14) | ack 带标记并给 lead 在 reclaiming 收到带标记 ack 时提前收口为 done 的裁量路径(随 §8.4 走查定稿,先记待办);redispatchTo 清理上一 attempt 残留 | ARCH(nit) |
| 35 | nit | `executor/gates.ts:21-25` | gatePolicy 允许 `policy_denied` 附 `retry_after_ms`,与 §4.3 码表方向不符(持久不可重试;retry_after_ms 是 busy 专属语义) | 码表纪律从源头守住:删该分支或加断言 | DIST(nit) |
| 36 | nit | `lead/machine.ts:11-20、165、360、127-164` | 命名与死代码:`normalizeFailCodeOrReject` 名不副实(随问题 5 修);注释引用不存在的 onForeignAttempt;budgetOrEscalate 参数未用;dispatchTo/redispatchTo 近乎复制可合并;状态名 escalated 与 01 §5.1 终态名 escalate 不一致 | 随问题 5 一并清理;命名对齐设计术语 | API(nit) |
| 37 | nit | `executor/machine.ts:267、286、53`;`lead/machine.ts` 记录命名 | 结果体以 `{status:'done', ...resultBody}` 展开,resultBody 可覆盖协议固定 status 字段(应统一「协议字段后置」);ScriptStubDriver 空脚本数组解引用崩溃,构造器应校验;驼峰/下划线混用且被原样序列化进检查点 v:1——字段改名即破坏兼容;restoreLeadMachine 缺 rec 形状校验(与问题 8 联动) | 协议字段后置统一;构造器校验空脚本;检查点 v1 定稿时统一命名并补 rec 形状校验 | API(nit) |

## 四、亮点(合并去重)

1. **状态机架构形态正确且测试友好**(ARCH/DIST/API/QA 一致认可):两台机器均为「入站事件→纯转移+动作列表」,发信/审计/排程/终态全部外置、时间由调用方注入——P2「换通道不换语义」的正确兑现方式;lead 侧对 R0/R2-R8/D25 的转移矩阵忠实且覆盖到位。
2. **§5.1 主干与终态语义实现准确**:done>closed>failed>escalated 优先级、四条失败归途、cancelling/reclaiming 竞态行、R7 双预算(acceptedFailedBudget/dispatchRounds 独立计数、retryable=false 不烧 attempt 有专例)均与 01 一致。
3. **R4「先撤销后改派」纪律严格执行**:expired/retryable/lost/acceptance_failed 四条路径统一走 beginReclaim,cancel 先于新 offer 入通道有显式断言,「僵尸入口对一切改派路径关闭」。
4. **参数与码表单一事实源在 core 层兑现**:params.ts/reason-codes.ts 与 01 §10/§4.3 逐条对齐,lostAfterMs 与 R3 文内算例一致;assertLeaseInvariant 把 R3 不变式做成可执行断言并验证正反例。
5. **D31 caps 匹配语义实现与测试堪称范本**(ARCH/API):逐段数值比较、「档案段数不足即不匹配」、未知类整串精确,正反例与 03 §3.2 一一对应,caps.spec 全覆盖。
6. **检查点设计边界划得干净**:定时器不持久化、绝对 deadline 入档、validateAcceptance 不入档由新进程重注入、tmp+rename 原子写(多数同级实现会漏);接管测试覆盖 running/reclaiming 双态恢复及「reclaiming 中崩溃→ack 提前收口→改派」深剧本(接线缺口见问题 2/8/9)。
7. **测试真实可复跑且账实相符**:实机复跑 core 42 + node 37 全绿,与 R-MATRIX 声明用例数逐一吻合,无凑数;虚拟时钟集成层确定性设计好,是 M3.1 离散事件仿真的正确雏形;R4/R5 双向赛跑、cancelling 三分支等竞态主场景有真实断言。
8. **core 纯函数失败方向正确**(SEC):isExpiredByExp 对不可解析 exp 按过期处置(失败关闭)、R2「晚于才过期」判向与 I-38 一致、attemptGate/DedupStore verdict 与 R0/R1 逐字对应。
9. **四道闸实现与 03 §6 完全同构**:闸序(策略→能力→负载)、拒绝码方向、missing 明细反哺改派均符合定案;闸4 注释正确区分 accepting 快照与本地阈值闸门。
10. **CLI 安全面干净**:demo/takeover 未打印凭证/密钥/token,exit code 语义明确。
11. **R-MATRIX 已建立且总体诚实**:🔲 项标注里程碑、部分项标注「部分」,未虚报总数、未把未测项伪装成已覆盖(个别行失真见问题 28)。

## 五、修订清单(按优先级,≤10 条)

| # | 优先级 | 修订项 | 对应问题 |
|---|---|---|---|
| 1 | P0 | 修复心跳续租定时器泄漏:progress 分支先 cancelTimers 再排程,onTimer('lease') 加 deadline 复核;补长任务存活用例 | 3 |
| 2 | P0 | 修复接管活性:restoreAll 重挂 pendingTimers(到期立即触发)+ drafting 恢复重发 requestDispatch + past-due 契约入文;takeover 改真实重启演示 | 2 |
| 3 | P0 | 恢复 R2 执行方过期拒收:evaluateOffer 增 TTL 闸或两段式 offered 驻留;补批量补投过期用例;R2 时刻锚定口径请设计侧定一句 | 1 |
| 4 | P0 | 异 task_id offer 守卫(单槽 reject(busy) 或多槽 Map)+ onCancel 带 task_id + gateLoad 改 `>=` | 4 |
| 5 | P0 | R5 自检补「本地租约已超时」分支;已决态重复 offer 忽略+审计 | 6、21 |
| 6 | P1 | node 复用 core 纯函数(attemptGate/isPersistentReject/normalizer/isExpiredByTtl),补两条脱测 R0 分支用例,加架构测试防回退 | 5 |
| 7 | P1 | 检查点恢复硬化:validateCheckpoint + 逐文件隔离 + 审计事件 + 崩溃一致性三类用例 + persist 顺序锁定 | 8 |
| 8 | P1 | attempt 单调防御:dispatchTo 守卫/单入口 + epoch 占位;赛跑窗口验收裁决并回写 §5.1;drafting fence(attempt+1 或裁决 done) | 9、7、12 |
| 9 | P1 | 审计与信封地基:audit 动作带 task_id/attempt、静默点补审计、escalate 摘要占位;抽 IngressPipeline 接缝并删除 attempt `??` 兜底 | 14、19 |
| 10 | P2 | 批次顺手修:同刻 tie-break 文档化+用例、killExecutor 原语与 lost 集成用例、paused 恢复路径、lease_ms clamp、R8 排除记录面、包导出补齐、R-MATRIX 失真行更正 | 15、17、18、10、11、16、28 |

## 六、M1 收口判定建议

**判定:修订后进入 M2。**(五视角原始结论:4× 有条件通过,1× 需重大修订;无任何视角支持「可直接进入」,亦无视角要求推翻架构重做。)

- **不构成「需重大返工」的依据**:骨架方向——纯状态机/动作外置/时钟注入、检查点边界、core 单一事实源、caps 匹配语义——获五视角一致肯定;缺陷集中在接缝与守卫,均有明确、局部的修法。
- **不可「直接进入 M2」的依据**:3 项 blocker 全部属于「M2 接上真实传输/真实时序即激活」的性质——至少一次投递会激活过期 offer 照单接收(问题 1)、重复 offer 重跑(问题 21)、异任务覆盖(问题 4)与回弹杀伤(问题 20);真实重启使接管特性不可用(问题 2);真实长任务必然触发心跳定时器泄漏死锁(问题 3)。带病进入 M2 会让这些缺口在双机环境下同时爆发且难以归因。
- **进入 M2 的前置门(收口条件)**:
  1. 修订清单 P0 全部完成(问题 1、2、3、4、6、21),并以各条建议中的新增确定性用例复验通过;
  2. 设计双源冲突按 impl plan §5 显性裁决并回写文档:§5.1 竞态行 vs R4 验收归途(问题 7)、R8 fail 侧排除口径(问题 11)、drafting 活性守卫(问题 2/12)、paused 恢复条件(问题 18)、执行槽模型单槽/多槽(问题 4)、R2 TTL 时刻锚定(问题 1);
  3. R-MATRIX 失真行(问题 28)更正,恢复追溯账本可信;
  4. P1 项(问题 5、8、9、14、19)在 M2 传输接线动工前完成——其中问题 14/19 本身就是「M2 只换传输、状态机不动」承诺的前置条件。
- **复验方式**:blocker 修复由委员会对新增用例做针对性复验(用例清单已列入各问题建议);分布式视角的「需重大修订」在其 blocker(问题 3)修复并复验后即视为条件满足。

---

## 修订记录(评审后)

- P0 修订已落库(提交 35990ae):接管恢复重挂定时器 + drafting 意图续推(ARCH-1/QA-5);心跳续租取消旧 lease 定时器 + 死线复核(DIST-1);执行方 exp 过期守卫(API-1)、异任务 busy 守卫(ARCH-2)、暂停后完成 → ack 不发 result(R5 自检)、paused → resume 恢复路径;reclaiming 赛跑窗口收 result 须过验收(评审 QA);reject 码归一改用 reject 登记表(语义分叉收敛)。
- 针对性复验:新增 regressions-m1.spec.ts 8 项回归(含接管后定时器重挂 → lost → 改派兜底完成的全链路推演),node 45 + core 42 全绿,typecheck 0 错。
- 遗留 major(信封元数据入接口、驱动会话型基座适配、检查点校验/审计字段、core 复用进一步收敛)随 M2 接线与安全硬化批次处理,不阻塞进入 M2。
