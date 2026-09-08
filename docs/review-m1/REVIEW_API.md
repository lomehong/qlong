# 群龙 M1 评审意见——接口与实现质量视角

> 评审对象:M1「单机核心」(packages/node + packages/cli,core 42 项 / node 37 项测试全绿)
> 对照基线:`QLONG_DESIGN_NOTES.md`、`QLONG_DESIGN_01_MSG_PROTOCOL.md`(下称 01)、`QLONG_DESIGN_02_REGISTRY_TRUST.md`(下称 02)、`QLONG_DESIGN_03_CAPABILITY.md`(下称 03)、`QLONG_IMPL_PLAN.md`
> 评审范围:仅接口与实现质量(模块 API 最小性与演进空间、core 类型复用边界、错误处理一致性、命名术语、驱动接口对 deepseek-harness 基座的承接力)。协议正确性细则、安全与测试充分性由其他视角队友评审。

## 结论 verdict

**有条件通过**。牵头方状态机、检查点/接管、单机总线的接口设计与实现质量整体优秀,可追溯性好;但存在 1 项 blocker:执行方状态机 `offered` 态不可达,致 R2 `reject(expired)` 拒绝路径在状态机内不可达,接上真实传输(M2 收件箱补投)即构成协议违反。该 blocker 与 6 项 major 必须在 M2/M3 传输接线前处置完毕;其余 minor/nit 随下一版顺手修。

## 摘要

M1 的分层是对的:两台纯状态机(动作外置、时钟注入)+ 可检查点重建 + 虚拟时钟单机总线,与 01 P2「传输无关」方向一致,lead 侧对 R0/R2-R8/D25 的转移矩阵忠实且测试到位。问题集中在「接缝」上:①执行方接单闸被实现成同步内联评估,状态机没有为 offer 驻留留出状态位,把 M2 离线补投与 M4 闸 5(本地人确认)两条已定路径堵死(blocker);②节点层绕开 core 已有纯函数自行内联 R0/码表归一,单一事实源原则在 node 层失守;③状态机接口不含 msg_id/trace 等信封元数据,§4.5 reply_to 与 §11 审计关联在当前接口下不可实现;④Driver 接口按「可强杀的同步任务」假设设计,承接不了会话型、不可强杀的 deepseek-harness 基座。

## 问题清单

### API-1|blocker|执行方 `offered` 态不可达,R2 `reject(expired)` 路径失效

- **位置**:`packages/node/src/executor/machine.ts`——`evaluateOffer`(L137-192,闸评估内联同步完成,L169-184 直接置 `running`);`onTtlCheck`(L206-215,以 `state === 'offered'` 为前置);全文无任何代码路径把 `ExecState` 置为 `'offered'`(仅测试用 `Object.assign` 伪造)。
- **问题**:01 §6 R2 规定执行方对 offer_ttl「晚于」判过期、过期必须回 `reject(expired)`,并把「长期离线节点上线后收件箱批量过期 offer → 整批 reject(expired)」列为必测场景;01 §5.2 状态机亦以 `offered` 为接单驻留态。当前实现里闸 2/3/4 在 `onOffer` 单次调用内同步出结果,`offered` 是**不可达状态**:`onTtlCheck` 是死代码,`onCancel` 的 offered 分支(L296-298)同样死。M2 收件箱补投的迟到 offer 将被照常评估并 accept(为死任务开租约),直接违反 R2/R6。`packages/node/test/executor.spec.ts` L75-84 只能靠 `Object.assign(m.rec, {state:'offered',...})` 伪造状态来测,`docs/testing/R-MATRIX.md` L12 却将 R2 标 ✅——追溯结论失真。更深一层:03 §6.2「本地确认与 offer_ttl 的赛跑」(M4 闸 5,人确认耗时可能超过 TTL)本质上要求 offer 在执行方有一个可驻留、可被 TTL 打断的待决态,当前同步闸模型无法表达。
- **建议**:①`evaluateOffer` 模型改为两段:`onOffer` 先置 `state='offered'` 并排 `ttl` 定时器,闸评估结果(同步或异步回调,含 M4 确认)到达后再 accept/reject;TTL 先到即 `reject(expired)`(R2「晚于」判定)。②补「补投批量过期」确定性用例,并把 R-MATRIX 的 R2 行改回如实状态。③随之需要委员会定一个小设计口径:R2 的 TTL 锚定「收到时刻」如何在收件箱补投场景取得(信封需携带可判定的派发时刻,或网关补投时回填原路由时刻),否则「批量过期」场景无机制支撑(见开放问题 Q2)。

### API-2|major|执行方对**异 task_id** 的并发 offer 无守卫,可致跨任务结果错配

- **位置**:`packages/node/src/executor/machine.ts`——`onOffer` L101-131 的 R0 特别则分支以 `this.rec.task_id === o.task_id` 为前提;异 task 的 offer 直接落 L133-135 进入 `evaluateOffer`,闸 4 缺省(`load` 未注入时 `gateLoad(undefined)` 放行,`gates.ts` L44-45)即覆写 `this.rec`(L169-184)并发 `startDriver`(L188),**旧 driver 未被 stop**。
- **问题**:M1 单机总线只有一任务,不可达;但该类就是 M2/M3 的执行方状态机(同 API-1 的「状态机不动」前提)。队内多个牵头方各派一单是常态:第二单被接受后,第一单的旧驱动完成时经 `DriverHost.complete` 回调进入 `onDriverCompleted`(L251-269),此时 `rec` 已是新任务,旧驱动的结果体会以**新 task_id/attempt** 发出 `task.result`——跨任务结果错配,属数据错乱级缺陷。`harness.ts` L215-228 的 `driverHost().complete` 也不携带 task 关联,无法兜底。
- **建议**:在 `onOffer` 入口补单槽守卫:`running/result_sent/fail_sent` 态收到异 task offer → `reject(busy)`(正合 03 §6 闸 4 的 running 阈值语义);同时明确契约:要么写死单槽并在文档标注,要么升级为多槽模型(`DriverTask` 会话句柄化、`complete/fail` 携带 task_id 路由)——后者与 API-6 一并设计。

### API-3|major|reason_code 处理绕开 core 登记表,「未知码按 other」元规则未落实

- **位置**:`packages/node/src/lead/machine.ts`——`normalizeFailCodeOrReject`(L403-405)只做 `typeof` 检查后**原样透传**,与自身注释「未知码按 other,不报错」相反;调用点 L207/L237/L266;`applyExclusion`(L389-399)手抄 `unsupported_caps/policy_denied/refused_loop` 三码,重复实现 core 的 `isPersistentReject`;签名 `code: FailCode | 'other' | string`(L389)用 **fail 码类型**承载 reject 码域,类型误标。`packages/core/src/reason-codes.ts` L49-64 的 `normalizeRejectCode/normalizeFailCode/isPersistentReject` 在 packages/node 中零调用(grep 证实,仅 core 自测使用)。
- **问题**:01 §4.3 元规则(未知码按 `other`、私有码 `x-` 前缀)是互操作底线;当前实现把任意未知字符串直接写进 `history.reason_code` 并参与排除判定,`x-` 私有码会被当作「瞬时失败」落入 `once` 排除,与「实现自定」的 `other` 语义漂移。这正是实现计划 §2「码表单一事实源、文档与代码同源」要防的分叉。
- **建议**:reject 路径改用 `normalizeRejectCode`、fail 路径改用 `normalizeFailCode`,归一后码入 `history`,custom 原值放 detail;`applyExclusion` 改调 `isPersistentReject`;顺带修正函数名与类型标注(现名 `normalizeFailCodeOrReject` 名不副实)。

### API-4|major|状态机接口不含 msg_id/trace 等信封元数据,§4.5 与 §11 在当前 API 下不可实现

- **位置**:`packages/node/src/lead/machine.ts`——`onMessage(type, fromNode, attempt, body, now)`(L166)不收 `msg_id`,`out()`(L109-114)生成的 `Outbound` 无从填 `reply_to`;`LeadAction.audit`(L59-66)只有 `event/reason`;`wire.ts` L2-8 的 `Outbound` 无 `trace` 字段;`harness.ts` L122-123/L182-183 落审计仅 `node_id/reason`;`LeadRecord`(L31-55)与 `LeadCheckpoint` 均无 trace。执行方侧:`onCancel(fromNode, attempt)`(L280)无 cancel 的 `msg_id` 入参,故 `task.cancel.ack` 无法按 01 §4.5 指向对应 cancel(L260/L293/L302 的 `reply_to` 均为空)。
- **问题**:01 §4.5(评审 I-57)逐类型规定 `reply_to` 指向;§11 要求任务相关日志必含 `trace_id/task_id/attempt/msg_id` 四字段、「缺字段视为日志缺陷」,escalate 结构化事件需 `trace_id/diagnostics_ref`;A8 验收要求仅凭日志 + trace_id 还原派单全链路。当前接口连**承载这些字段的位子都没有**:M1 的审计记录全部缺任务关联,M2 换真实传输时入站/出站接口必须破坏性修改——与「M2 只换传输、状态机不动」的承诺冲突。转派时 `trace.parent_span` = 上游 msg_id(§7.3)同样无处取材。
- **建议**:入站统一传信封头切片(至少 `{msg_id, trace}`),机器把它记入 `LeadRecord/ExecRecord` 并在 `Outbound` 增加可选 `reply_to`(已有)/`trace` 装配位;`audit` 动作增加 `task_id/attempt/msg_id/trace_id` 关联字段(harness 据此落 `makeAudit` 的现成字段,`core/audit.ts` L43-64 已支持);escalate 摘要补 `trace_id`。趁 M2 前改,成本低。

### API-5|major|core 纯函数未复用:R0 被两处内联重写,R1 去重在 node 层无落点

- **位置**:`packages/core/src/attempt-gate.ts` L21-25 与 `dedup.ts` 在 packages/node 零引用;`lead/machine.ts` L168-177 与 `executor/machine.ts` L101-131 各自内联 attempt 判定;`executor/machine.ts` L185/L225 内联 `Math.floor(lease/3)` 而不用 core `heartbeatIntervalMs`(params.ts L59-61);`harness.ts` L144-162 的 `deliverToExecutor` 无任何 ingress 管线(验签/exp/去重/team 复核)。
- **问题**:①语义已现漂移——executor 对重复 offer(同 attempt)`return []`(L105)无审计,违反 R0「已决状态下重复消息一律忽略 **+ 审计**」;两处内联与 core 纯函数三种写法并存,M2 后必然继续分叉。②R1 去重属于入口管线(harness→M2 网关/节点 ingress),当前 harness 没有这条管线的接缝,`SingleNodeHarness` 头注「M2/M3 替换 deliverTo* 即可、状态机不动」(L5)对 ingress 部分不成立。
- **建议**:两台状态机的 attempt 前置判定改为调用 `attemptGate`(含审计语义对齐);harness 抽出 `IngressPipeline` 接口(验签→exp→DedupStore→team 复核→状态机入口),M1 用透传实现,M2 换真实现——这才是 P2「换通道不换语义」该有的缝。

### API-6|major|Driver 接口按「可强杀同步任务」假设设计,承接不了 deepseek-harness 会话型基座

- **位置**:`packages/node/src/executor/driver.ts`——`ExecutorDriver.stop(): void`(L24)无完成回调;`DriverHost`(L12-20)无 `stopped()`/进度通道;`executor/machine.ts` `onCancel` running 分支(L279-294)在发出 `stopDriver` 的**同一批动作里**就发 `task.cancel.ack`。
- **问题**:实现计划 §6 与 README 均明确基座是原版 deepseek-harness——会话型执行、不可强杀,stop 只能是「请求终止」。当前接口下适配层只有两个坏选择:在会话真正停下前就回 cancel.ack(「确认停止」失真,违反 01 R5 ack 语义),或在状态机之外自行延迟回执(破坏动作外置模型)。R3 的「暂停产生新副作用(不强求杀进程)」同理:`pause()` 无就绪语义。另外 §4.2 progress 的 `pct?/note?/logs_ref?` 字段无处来源——`onHeartbeatDue` 心跳体硬编码 `{state:'working', seq}`(L218-228),真实驱动的进度信息进不来。
- **建议**:`DriverHost` 增 `stopped(): void` 与可选 `progress(partial: {pct?/note?/logs_ref?}): void`;执行方状态机在 `stopDriver` 后进 stopping 过渡,收到 `stopped()` 才回 cancel.ack(驱动可声明同步停止能力时豁免);心跳体合并 driver 进度。接口现在改是纯增量,M1.1 桩不受影响。

### API-7|major|包边界失真:公共 API(index.ts)≠ 实际使用面,CLI 深引源码

- **位置**:`packages/node/src/index.ts` 只导出 wire/caps/gates/driver/两台状态机/harness,**未导出** `lead/store.ts`、`lead/checkpoint.ts`、`lead/supervisor.ts`;`packages/cli/src/main.ts` L5-7 以相对路径 `'../../node/src/...'` 深引 node 源码;`packages/node/package.json` 无任何依赖声明,`@qlong/core` 靠 `tsconfig.json` L6 的 paths 别名解析(`vitest.config.ts` L4 注明 exFAT 不支持 symlink 的折衷)。
- **问题**:检查点/接管是 M1 的验收项(checkpoint.spec、CLI takeover 都在用),却不属于包公共 API——外部消费者(以及 M2 的 registry/gateway)无包契约可依;CLI 跨包深引使 node 任何内部重组都破坏 cli。exFAT 折衷可以理解,但它让「package」退化成目录约定,接口评审必须指出。
- **建议**:index.ts 补齐 store/checkpoint/supervisor 导出;cli 改为从 `@qlong/node` 包名导入(路径别名机制可保留,导入面先统一);在根 README 或包 README 记录 exFAT 约束与恢复 workspace 依赖的条件,防折衷永久化。

### API-8|minor|`deadline_ms` 与 contract 未入状态机:执行方无自弃路径,验收缺省 fail-open

- **位置**:`packages/node` 全 src 无 `deadline` 触点(grep 证实);`lead/machine.ts`——`LeadRecord` 不存 offerBody/contract(L31-55,`dispatchTo` 只读 `offer_ttl_ms` 后即弃),`validateAcceptance` 缺省实现(L88-93)对「结果未回填 `acceptance_results`」一律判过。
- **问题**:01 §4.2 规定 `deadline_ms` 超期由**执行方**自行放弃并 `fail(deadline_exceeded)`,执行方状态机连计时位都没有,该 fail 码在 node 层不可达(卡死任务只能等租约回收,与设计分配不符)。验收侧:aid 缺省判过合理,但 kind=project 且 `contract.acceptance` 非空而结果未回填时仍判过,与 A3「校验不过走 cancel(acceptance_failed)」的收紧方向相反(fail-open)。判据函数只能靠创建方闭包捕获 contract,机器自身不感知契约,接口上「验收」与「任务书」断裂。
- **建议**:`ExecRecord` 记 `deadlineUntil` 并排 timer,到期走 `onDriverFailed` 同型的自弃路径;`LeadRecord` 存 offerBody(与 `ExecRecord.offerBody` 对称),缺省验收改为「contract.acceptance 非空而 acceptance_results 缺失 → 不通过」。

### API-9|minor|`onOffer` 的 team 入参是死参数;闸 2 缺省 fail-open,与 P12 精神不符

- **位置**:`packages/node/src/executor/machine.ts` L90-99/L137-146——`onOffer/evaluateOffer` 签名带 `localTeamId?/fromTeamId?`,函数体从未使用;`gates.ts` L16-26——`gatePolicy(undefined)` 放行。
- **问题**:02 §7 A5 要求节点侧复核(钉扎后跨队静默丢弃),接口开了参数却无实现,属「虚位」——M2 接入时要么删参要么补语义,现在留着只会误导调用方以为已复核。闸 2 策略钩子缺省全放行对 M1 桩可接受,但应在接口注释显式声明「未配置策略 = 全放行」这一 fail-open 缺省(P12 的失败关闭是 ACL 语义,节点策略位至少不该默默假装存在防线)。
- **建议**:删掉死参数或落地最小校验(不等则删);`gatePolicy`/`ExecutorOptions.policy` 的缺省语义写进 TSDoc,并留 M4 执行档案闸的接入口说明。

### API-10|minor|Supervisor 未知任务抛异常、终态检查点永不清理、恢复边界类型弱化

- **位置**:`packages/node/src/lead/supervisor.ts`——`deliver` 经 `must`(L95-99)对未知 task_id 直接 throw(L63-75);`persist`(L101-103)只写不删,`CheckpointStore.delete`(store.ts L8)在 node 层无调用方,终态任务检查点无限累积;`checkpoint.ts` `pendingTimers`(L43-55)返回 `timer: string` 而非 `TimerName`,恰在「恢复重挂定时器」这个最不该出错的边界上丢了类型约束。另:`LeadAction.requestDispatch` 只带 `nextAttempt`(machine.ts L59-66),R8 的 `excluded` 表留在 `rec` 里无载体传递,目标选择方必须绕过接口直读 `rec.excluded`(过滤本身 M2 集成是 R-MATRIX L18 已承认的排期,不重复提,只提动作形状)。
- **建议**:未知 task_id 的入站按 R0 语义返回「忽略 + 审计」动作而非抛异常(stray 消息不应炸宿主);任务进终态后由 supervisor 调度 `store.delete`(或标记可回收);`pendingTimers` 返回 `TimerName`;`requestDispatch` 考虑携带排除清单/候选约束,给 R8 消费方一个正式接口。

### API-11|nit|命名与死代码细节(lead/machine.ts)

- `normalizeFailCodeOrReject` 名不副实(随 API-3 一并修);L165 注释引用不存在的 `onForeignAttempt`;`budgetOrEscalate(_now)`(L360)参数未用;`dispatchTo`/`redispatchTo`(L127-164)两段近乎复制的逻辑可合并(仅 attempt 赋值不同);状态名 `'escalated'`(L11-20)与 01 §5.1 的终态名 `escalate` 不一致,建议对齐设计术语。

### API-12|nit|结果体展开序、桩越界与序列化命名混用

- `onDriverCompleted` 以 `{status:'done', ...resultBody}`(executor/machine.ts L267)展开,resultBody 可覆盖协议固定的 `status` 字段(`onCancel` L286 把 `completed_before_cancel` 放在展开后是对的,两处应统一「协议字段后置」);`ScriptStubDriver` 空脚本数组在 L53 取 `undefined` 后解引用崩溃,构造器应校验;`LeadRecord`/`ExecRecord` 驼峰(`leaseMs/offerTtlUntil`)与下划线(`task_id/offerBody`)混用,且该混合结构被原样序列化进 `LeadCheckpoint v:1`——字段改名即破坏检查点兼容,建议趁 v1 定稿统一命名,并给 `restoreLeadMachine` 的 `rec` 补形状校验(现仅查 `v`,L28-40)。

## 亮点

1. **lead 状态机的规则落点精准**:R-MATRIX 所列 lead 9 例对 R0/R2/R4/R7/R8/D25 的关键转移(先撤销后改派、drain 赛跑、双预算、终态优先级、cancel_wait 出口)覆盖忠实,`acceptedFailedBudget/dispatchRounds` 双计数是评审 I-40 修订的干净实现。
2. **动作外置 + 注入时钟的纯状态机**是正确的接缝方向:`LeadAction/ExecAction` 把 IO 全部推给宿主,虚拟时钟 `SingleNodeHarness.advanceTo` 让竞态/超时完全确定可测,天然满足 01 P2。
3. **检查点方案诚实且自洽**:验收函数不入检查点、`pendingTimers` 重挂清单、同机接管语义与 01 §4.4(I-35)一致,checkpoint.spec 连 reclaiming 中崩溃恢复都覆盖了;store 的原子写(tmp+rename)与 exFAT 选型说明(L27-31)如实。
4. **core 单一事实源质量高**:params/reason-codes/audit 枚举与 01 §10/§4.3/§11 逐条对应,`assertLeaseInvariant` 把 R3 不变式做成可执行断言——问题只在 node 层没有用起来(见 API-3/5)。
5. **caps.ts 与 D31 逐条对齐**:无 @ 完全相等、带 @ 逐段数值、未知类整串精确、档案段数不足不匹配,正反例(caps.spec ×5)与设计表格一一对应。

## 开放问题(建议委员会路由)

- **Q1 执行方闸评估的异步化形态**:API-1 的两段式(onOffer → offered 驻留 → 评估回调)与 M4 闸 5「本地人确认」如何统一为一个接单会话模型?建议随 M2 ingress 管线一并定接口,避免两次破坏性修改。
- **Q2 R2 过期判定的时刻锚定**:offer_ttl 是相对时长(P5),收件箱补投场景「批量过期」需要可判定的原始派发时刻(信封携带或网关回填)。01 已把该场景列为必测,机制口径需设计侧补一句话。
- **Q3 执行槽模型**:单槽(busy 守卫)还是多槽(会话句柄化)?影响 Driver/Host 是否需要 task 路由(与 API-2/6 联动)。
- **Q4 目标选择归属**:R8 excluded 的消费点放 `LeadSupervisor`(requestDispatch 携带约束)还是上移项目图谱层?决定 `requestDispatch` 动作的最终形状。
- **Q5 exFAT 折衷的退出条件**:路径别名接入何时换回 workspace:* 依赖(换 CI 环境/NTFS 构建机),避免包边界长期虚化(与 API-7 联动)。

---
*评审人角色:接口与实现质量评审。本文件为委员会汇总的唯一输入;除本文件外未创建/修改任何文件。*
