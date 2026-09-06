# M1 单机核心 评审意见——安全视角

> 评审对象:M1「单机核心」(packages/node、packages/cli 全部源码与测试;core 为 M0 已评审基线,仅在与 M1 交界面处核对)。
> 评审对照物:QLONG_DESIGN_NOTES.md、QLONG_DESIGN_01_MSG_PROTOCOL.md(下称 01)、QLONG_DESIGN_02_REGISTRY_TRUST.md(下称 02)、QLONG_DESIGN_03_CAPABILITY.md(下称 03)、QLONG_IMPL_PLAN.md。
> 评审范围声明:仅安全视角(检查点篡改面/attempt 高水位/驱动注入面/CLI 泄露/失败关闭);协议完备性、架构与工程质量由其他角色评审。v0.1 单机信任边界与 02 篇网关/目录层的边界已划清,本意见不越界要求 A0–A6 相关实现(属 M2)。

## 结论 verdict

**有条件通过**:无 blocker;5 条 major 需在进入 M2/M3 前(即真实传输层与双机执行方接入前)修复或落实防御,4 条 minor 随下一版修,1 条 nit。

## 摘要

M1 的安全基线总体扎实:存储原子写、core 纯函数的失败方向(exp 不可解析按过期、R2「晚于」判向)与设计一致,四道闸顺序符合 03 §6,CLI demo/takeover 未发现敏感信息打印或凭证落盘。主要风险集中在**检查点恢复路径**:当前实现把本地检查点文件当作完全可信输入,既无完整性/一致性校验,失败时也无审计、无隔离——这与 P12「状态不明→拒绝」的原则相悖;同时 01 §4.4 要求的 attempt 高水位/检查点纪元仅有注释声称而无实质字段与单调性防御。执行方状态机存在并发 offer 覆盖导致撤销路径失效的缺口,驱动接缝未预留 03 §6.1 执行档案上下文,均需在 M3 前补齐。

## 问题清单

### SEC-1|major|检查点恢复路径失败开放:无校验、无隔离、无审计(注入面 + 单文件损坏全局失败)

- **位置**:`packages/node/src/lead/checkpoint.ts:28-39`(`restoreLeadMachine`)、`packages/node/src/lead/store.ts:50-56`(`JsonFileStore.load`)、`packages/node/src/lead/supervisor.ts:35-43`(`restoreAll`)。
- **问题**:①`restoreLeadMachine` 对 blob 仅做 `JSON.parse(blob) as LeadCheckpoint` 后**整体信任**:`m.rec = cp.rec`、`m.terminal = cp.terminal` 原样赋值,无任何字段级校验。`rec.state` 非法字符串会在 `onMessage` 的 switch 落入 default 被静默吞掉;`attempt` 可被置 0/负数;`history`/`excluded` 可注入任意形状;`terminal=false` 与 `rec.state='done'` 的矛盾组合也照单全收。被篡改或损坏的检查点由此成为对状态机的直接注入面。②失败处理两个方向都错:`JsonFileStore.load` 捕获一切异常返回 `undefined`,`restoreAll` 对其 `continue`——任务**无痕消失**(在途任务的执行方从此等不到 result/cancel),无任何审计与告警;而 `restoreAll` 循环无 per-file 异常隔离,**一个损坏文件**(`JSON.parse` 抛错或 `cp.v≠1`)会让 `restoreAll` 整体抛错,全部任务接管失败。
- **依据**:02 P12「ACL 失败关闭……状态不明 → 拒绝」的精神同样适用于本地状态恢复——状态不明(文件损坏/被改)不得静默吞掉、也不得放大为全局失败;01 §11 要求关键异常留审计事件。需澄清边界:02 §10「同队机器被攻陷=无」是**消息面**的模型前提,不豁免本机文件面(本地其他进程、同步盘回滚、备份恢复都在边界内);且 01 §4.4 已把检查点备份节点列为跨机接管候选,该面终将跨出单机。
- **建议**:新增 `validateCheckpoint(cp): LeadCheckpoint` 严格校验:`v===1`;`kind`/`state` 枚举;`attempt` 为 ≥1 整数;`terminal` 与 `rec.state` 一致(终态枚举↔true);`acceptedFailedBudget`/`dispatchRounds` 非负且 ≤ 上限;`history` 数组元素形状;数值字段无 NaN/Infinity。校验失败的文件**重命名为隔离区**(如 `*.cp.quarantine`)而非删除,并记审计事件(需在 core `AUDIT_EVENTS` 增补如 `checkpoint_restore_failed`)与启动摘要;`restoreAll` 改为逐文件 try/catch,坏文件不阻断其余任务恢复。

### SEC-2|major|attempt 高水位与检查点纪元缺失,恢复无单调性防御——注释声称与实质不符

- **位置**:`packages/node/src/lead/checkpoint.ts:2-4`(头注释)、`9-15`(`LeadCheckpoint`)、`supervisor.ts:35-43`。
- **问题**:checkpoint.ts 头注释称「检查点自带 attempt 高水位与在途 (task_id, attempt, 执行方) 信息(rec 内),满足跨机接管的前置预留」。对照 01 §4.4 原文:「检查点必须含 **attempt 高水位**与在途 `(task_id, attempt, 执行方)` 清单;接管方将所有在途任务 attempt **提到高水位之上再重派(fence)**;旧 lead 恢复后凭**检查点纪元**检测让位,禁止双主」——当前结构只有每任务 `rec.attempt` 与 `rec.target`,**没有全局高水位字段,没有检查点纪元字段,也没有任何恢复时单调性断言**。同机正常重启下 attempt 由进程内单调保证尚可;但检查点文件一旦回滚(备份恢复、云盘同步回滚、误覆盖——SEC-1 中被篡改亦同),`restoreLeadMachine` 会无防备地接受更小的 attempt,此后 lead 对执行方已有 attempt=2 在途结果一律回 `reject(stale_attempt)`(machine.ts:169-177),且以旧 attempt 重发 cancel/offer——R0 语义失效、重复执行或任务卡死。这正是 01 §4.4 要以 fence 防的「双主」前奏。
- **依据**:01 §4.4(接管前置条件);01 R0/D25。
- **建议**:①`restoreAll` 恢复时断言 attempt 单调:与 store 中既有记录(或上一次恢复值)比对,`cp.rec.attempt < 已知值` → 拒绝恢复该任务并走 SEC-1 的隔离+审计路径;②`LeadCheckpoint` 增加 `epoch` 字段(v1 同机恒 0,先占位),恢复时只增不减;③`restoreAll()` 返回值或新接口输出在途 `(task_id, attempt, target)` 清单——这是 01 §4.4 为跨机 fence 明文预留的数据,现在落字段,避免 M3+ 再破坏 checkpoint 格式。

### SEC-3|major|accept 回值 `lease_ms` 无上界校验,执行方可单方面解除超时回收

- **位置**:`packages/node/src/lead/machine.ts:197-199`(`onOfferedMessage` 对 `task.accept` 的处理)。
- **问题**:`const lease = typeof body.lease_ms === 'number' ? body.lease_ms : this.rec.leaseMs;`——对执行方回填的 `lease_ms` 不做任何界内检查即写入 `rec.leaseMs` 并据此排 `lease` 定时器。01 §4.2 `task.offer` 字段表白纸黑字:「lease_ms……执行方在 accept 里可**确认或下调**」;当前实现允许**上调**:异常或被攻陷执行方回 `lease_ms: 1e13` 即令 `leaseDeadline = now + lostAfterMs(1e13)`,R3 判 lost 与 R4 回收被单方面解除,任务沦为不可回收的僵尸租约(心跳照发即永不 lost)。无需恶意——单位写错(毫秒传成微秒)即可触发同后果。
- **依据**:01 §4.2(lease_ms 只许确认或下调);01 R3/R4(租约与回收语义);对照 03 §6.1 的对称原则——「offer 只能声明不能放宽档案」,对端回值同样不能放宽本方参数。
- **建议**:`lease = Math.min(body.lease_ms, this.rec.leaseMs)`(clamp 到 offer 建议值),或引入参数化上界 `maxLeaseMs`;clamp 发生时记审计(`reason: 'lease_ms_clamped'`)。补一条测试:accept 上调租约 → 实际 `leaseDeadline` 仍按 offer 值计算。

### SEC-4|major|并发异 `task_id` 的 offer 无条件覆盖执行方记录,旧任务驱动从此不可撤销

- **位置**:`packages/node/src/executor/machine.ts:100-135`(`onOffer` 的 R0 特别则仅覆盖同 `task_id`)、`280-305`(`onCancel` 无 `task_id` 参数且按 attempt 匹配)、`harness.ts` 未注入 `load`(闸4 恒过)。
- **问题**:`ExecutorMachine` 是单记录(`rec` 一份),但 `onOffer` 对**不同 task_id** 的 offer 不做任何防御,直接落 `evaluateOffer`:闸2/3/4(harness 未提供 `load()` 时闸4 恒过)通过后 `this.rec` 被整体重置为新任务,`startDriver` 启动新驱动,**旧任务的驱动无人 `stopDriver`**。此后旧 lead 发来的 `task.cancel` 因 `attempt === this.rec.attempt` 不成立而**被忽略**(且 `onCancel` 签名连 `task_id` 参数都没有,无从比对)——旧驱动以旧 offer 的任务书持续运行,协议层再无撤销它的路径。这不是边角:02 §3.3 负载快照含 `running`(正在执行的任务数),说明设计预期执行方并发多任务;当前实现等于「后来的任务静默顶掉先前的任务 + 先前任务永不可撤销」。对远端任务而言,撤销路径失效意味着 03 §6.1 低权档案下跑着的任务失去唯一的停止手段(R5 的存在意义)。
- **依据**:01 §5.2/R5(执行方必须可被 cancel 终止)、R4(cancel 语义);03 §6.3(执行面缓冲带以「可即时停止」为前提)。
- **建议**(二选一,M3 双机前必须定):A. 保持单实例语义:state=running 时收到异 `task_id` 的 offer 一律走闸4 回 `reject(busy, retry_after_ms)`,不进入 evaluateOffer;B. 真正并发化:`rec` 改为 `Map<task_id, ExecRecord>`,按 task 分桶。无论 A/B,`onCancel` 增加并比对 `task_id` 参数;`deliverToExecutor`(harness.ts:157-158)同步调整。补测试:running 中收到异 task_id offer → 旧任务仍可被 cancel 停止。

### SEC-5|major|驱动接缝 `DriverTask` 未预留来源与执行档案上下文,03 §6.1 的最锋利面在接口上无着力点

- **位置**:`packages/node/src/executor/driver.ts:6-26`(`DriverTask`/`DriverHost`/`ExecutorDriver`)。
- **问题**:`DriverTask = { task_id, attempt, offer }`,offer body 原样透传。01 §13.7 与 03 §6.1 已定案:真实驱动将以本地真实权限运行「由牵头方 LLM 写成的任务书」,远端任务必须默认套用低权执行档案(工作区/工具白名单/网络出口/凭证不注入/敏感操作确认)。但当前接缝**没有任何位置**携带:消息来源(`from.node_id`/`team_id`)、本地/远端判定、执行档案句柄或约束集。ScriptStubDriver 忽略 offer 故无碍;真实 deepseek-harness 基座适配「紧随其后」(driver.ts:3),若按现接口直连基座,驱动层无法区分远端/本地任务,M4 沙箱要么破坏接口、要么绕开接缝在更外层打补丁——两者都是档案被架空的形态。
- **依据**:03 §6.1/D22/D33(远端任务执行档案;权限收窄权在执行方);01 §13.7。
- **建议**:M2 开工前定型:`DriverTask` 增加 `source: { node_id: string; team_id?: string; remote: boolean }` 与 `profile`(执行档案句柄或约束集:工作区根、出口策略、凭证注入开关);并在接口注释钉死「offer.body 未经档案包装不得直达基座」。同时为 R10 预留:payload 拉取须走执行档案的网络出口约束(01 R10/03 §6.1),驱动/宿主层需能提供受限出口钩子。

### SEC-6|minor|`onOffer` 缺「已验签」的类型级前置,回声分级依赖注释约定

- **位置**:`packages/node/src/executor/machine.ts:86-99`(`onOffer` javadoc「闸1 在传输层」)、`137-166`(`evaluateOffer` 直接产出可回执的 reject)。
- **问题**:03 §6 闸1(验签,静默丢弃)先于闸2–4;当前 `onOffer` 的入参不含任何「该 offer 已验签且同 team」的证据,顺序约束只存在于注释。M2 传输层集成时一旦在验签前调用(或验签失败分支漏接),`reject(policy_denied/unsupported_caps + missing 明细)` 将发往未认证方——02 A6/01 §3.3.4 明令未认证场景静默,missing 明细等于向探测者披露本地能力缺口。
- **依据**:02 A6/D28(回声分级);03 §6(闸序)。
- **建议**:把前置编入类型:`onOffer(o: { ...; verified: true; fromTeamId: string, ... })`(字面量类型,由传输层在验签+同队复核通过后构造),或在函数入口断言;M1 测试同步补「未验证入参不可构造」的编译期证据。

### SEC-7|minor|`JsonFileStore` 无路径字符集校验与文件权限硬化,完整性校验缺位

- **位置**:`packages/node/src/lead/store.ts:40-47`(`file()`/`save()`)、`35-38`(构造)。
- **问题**:①`file(taskId)` 直接 `join(dir, \`${taskId}.cp.json\`)`,taskId 含 `..`/路径分隔符即可落点目录之外。M1 各调用点的 taskId 为内部生成 uuid 故未触发;但 `CheckpointStore` 是通用接口,M2+ 执行方侧若以**远端 offer 携带的 task_id** 作存储键(届时该字符串由对端可控),即成路径穿越。②检查点文件权限未显式收紧(继承 umask),而其内容含任务书正文、结果正文、协作节点历史——对标 01 P3「body 尽少扩散」的精神,本地落盘至少应收窄到属主。③无完整性校验(HMAC/校验和),损坏与篡改在恢复前不可发现(与 SEC-1 叠加)。加密**不在本条要求内**:单机信任根下收益有限,跨机备份的端到端加密已属 01 §4.4/§13.2 开放问题,不重复提。
- **依据**:01 §4.4(图谱本地持久化);02 §10(本地文件面不在「同队攻陷」豁免内);通用防御纵深。
- **建议**:`file()` 校验 taskId 匹配 uuid 格式(或 `[A-Za-z0-9-]`),不合法抛错;`mkdirSync`/`writeFileSync` 显式 `mode 0o700/0o600`(Windows 下对应 ACL 收敛到当前用户);blob 追加 HMAC(密钥本机随机生成、与检查点分目录存放)作为轻量完整性防线,随 SEC-1 的校验函数一并消费。

### SEC-8|minor|harness 审计记录缺日志关联字段,违反 01 §11 硬性规范

- **位置**:`packages/node/src/local/harness.ts:122-124、182-184`(`makeAudit` 调用)。
- **问题**:01 §11:「每条与任务相关的日志必须含 `trace_id / task_id / attempt / msg_id`(外加 `key_epoch`)——**缺字段视为日志缺陷**」。当前两处 `makeAudit(a.event, { node_id, reason })` 仅含 event/ts/node_id/reason,而 `task_id`(this.taskId)与 attempt(lead.rec.attempt)在调用点明明可得。harness 是「A2 单机版种子」、M3 正式总线的模板,审计形状会被继承。
- **依据**:01 §11;R-MATRIX A8(审计事件可查、可还原链路)。
- **建议**:调用点补 `task_id` 与 `attempt`(lead 侧取 `this.lead.rec.attempt`,exec 侧取 `this.exec.rec.attempt`);`trace_id/msg_id/envelope_head_digest` 在 M2 信封落地后由传输层补齐,接口上给 `AuditFields` 预留必填化的演进注释。

### SEC-9|minor|harness 出站消息 attempt 缺省补齐,弱化 R0 的模板隐患

- **位置**:`packages/node/src/local/harness.ts:167`(`msg.attempt ?? this.lead.rec.attempt`)。
- **问题**:执行方出站消息 attempt 缺失时,harness 自动以 lead 当前 attempt 补齐——把「attempt 不匹配」这类装配 bug 静默漂白为合法消息,R0 闸门在该路径上永不触发。状态机自身(`out()`/`outFor()`)总是带 attempt,故现测试不受影响;但 harness 自述是 M2/M3 正式传输层的替换模板(文件头注释),`??` 补齐模式一旦被照抄到传输层,迟到旧 attempt 消息的 R0 拒收(A5 验收项)将出现漏网路径。
- **依据**:01 R0(所有入站 task.* 先判 attempt)/§3.1(attempt 必填)。
- **建议**:删除 `??` 补齐:出站 `Outbound.attempt` 视为必填(装配缺失属编程错误,直接抛错),入站缺 attempt 的消息按装配错误处理;harness 中改为显式断言。

### SEC-10|nit|takeover 演示用 `MemoryStore`,与「仅检查点幸存」的叙事不符

- **位置**:`packages/cli/src/main.ts:29、35-37`。
- **问题**:注释与输出宣称「进程崩溃:内存全丢,仅检查点存储幸存」,但演示用的是进程内 `MemoryStore`——真崩溃时它同样消失。演示语义误导后来者,易被当成「接管持久化=内存即可」的范例(恰与 SEC-1/SEC-2 要守的文件面相反)。
- **建议**:演示改用 `JsonFileStore` + 临时目录(与 checkpoint.spec.ts:96-108 的跨进程用例一致),输出中标注存储路径;或在注释明示「此处以同进程双 supervisor 模拟重启,真实接管须文件存储」。

## 亮点

- **检查点原子写**:`JsonFileStore.save` 采用 tmp+rename(store.ts:44-48),避免半写检查点被恢复路径消费——多数同级实现会漏掉这一点。
- **core 纯函数的失败方向普遍正确**:`isExpiredByExp` 对不可解析 exp 按过期处置(freshness.ts:16,失败关闭);R2「晚于才过期」判向与 I-38 一致;`attemptGate`/`DedupStore` 的 verdict 语义与 R0/R1 逐字对应。
- **四道闸实现与 03 §6 完全同构**:闸序(策略→能力→负载)、拒绝码与方向、`missing` 明细反哺改派(gates.ts/caps.ts + executor.spec 闸序用例)均符合定案;闸4 注释正确区分了 `accepting` 快照(礼貌提示)与本地阈值闸门。
- **CLI 安全面干净**:demo/takeover 未打印任何凭证/密钥/token,takeover 全程内存态无落盘,exit code 语义明确——本视角的「敏感信息泄露」检查项通过。
- **R-MATRIX 已建立且如实标注缺口**(A0–A6/R9–R11 标 🔲 排期 M2/M3),没有把未测项伪装成已覆盖。

## 开放问题(提请委员会,非缺陷)

1. **检查点完整性机制的选型与密钥存放**:本机 HMAC 密钥放哪里(与检查点同盘不同目录?OS 凭证库?)与 01 §13.2 跨机接管的端到端加密方案强耦合,建议两事同场设计,避免 M1 先落一套、跨机再推翻。
2. **执行方并发模型需在 M3 前定案**:单 `ExecutorMachine` 实例 + reject(busy)(SEC-4 方案 A)还是多实例并发(方案 B),决定闸4 的 `running` 语义与撤销路径的实现形状,属于协议实现的关键分叉,建议随双机纸面走查(01 §6/I-04)一并敲定。
