# 群龙 M3 评审意见:测试稳健性(REVIEW_QA)

> 评审对象:M3「双机真实传输闭环」——`packages/node/src/remote/session.ts`、`packages/gateway/test/cross-machine.spec.ts`、`packages/gateway/test/lost-redelivery.spec.ts`、`docs/testing/WALKTHROUGH-2NODE.md`、`docs/testing/R-MATRIX.md`。
> 对照基线:`docs/QLONG_DESIGN_01_MSG_PROTOCOL.md`(下称 01)、`02_REGISTRY_TRUST.md`、`QLONG_IMPL_PLAN.md` §1 验收清单、M1/M2 评审报告(已决事项不重复)。
> 视角:仅测试稳健性——真实时序脆弱性、断言时点、定时器/连接卫生、剧本-用例映射、崩溃一致性覆盖。协议/安全/架构视角归队友。

## 结论 verdict

**有条件通过。**

141 项全绿可信、e2e 走的是真实 ws + 真实签名 + 真实 setTimeout 的 lost 链路、失败路径有 DIAG 诊断输出,底子是好的。但本轮存在 **4 项 major**:其中 QA-1(R3 心跳回执接线缺失,被用例时间窗系统性掩盖)和 QA-2(R8 excluded 语义零覆盖,剧本化 pickTarget 反向掩盖实现缺口)属于「测试绿但语义链路断」的实质缺口;QA-3(固定 sleep)违背 M2 评审确立的时序纪律;QA-4(检查点 vs 会话)是 M1 成果与 M3 形态之间的无护栏接缝。建议补齐/修订后由主任确认收口。

## 摘要

M3 把状态机接上了真实传输,但测试窗口全部选在「缺陷不可见」的区间:没有用例让任务在链路健康状态下活过执行方自身租约死线(掩盖 QA-1),没有用例让 pickTarget 忠实消费 excluded(掩盖 QA-2),负向用例用固定 sleep 赌 150ms 时序(QA-3),没有任何用例在中途重建会话(QA-4)。另有 TTL 余量偏紧、追溯矩阵两处指针失真、测试卫生三类 minor。核心补测方向:健康长任务跨租约用例、excluded 消费用例、routing.denied 改 waitFor、会话级崩溃重启用例。

## 问题清单

### QA-1|major|R3 心跳回执→执行方续租接线在 RemoteNodeSession 缺失,e2e 无「健康任务跨租约期」用例致盲区

- **位置**:`packages/node/src/remote/session.ts:87-92`(构造器仅绑定 `client.onEnvelope` 与 `onRoutingDenied`,未绑定 `client.onAck`);对照 `packages/node/src/local/harness.ts:196、234`(仿真总线有接 `onHeartbeatAcked`);`packages/node/src/executor/machine.ts:244-260`(`onHeartbeatAcked` 在 remote 路径全仓库零调用,grep 证实)。
- **问题**:01 §6 R3 明文「执行方侧对称计时器:自**最后一条成功送达(获网关 ACK,R11)的心跳**起算 `lease_ms`」。真实链路上,网关 ack 只被 `gateway-client.ts:156-165` 用于 resolve `send()` 的 promise,从不进入执行方状态机。后果链:`lease_self` 仅在接单时布一次(accept+lease,`machine.ts:203`),心跳再久也得不到续期 → **任何运行时长 ≥ lease_ms 的健康任务必然在 lease_ms 处 `paused`→停心跳→被牵头方误判 lost 回收**。这正是 M1-#18(评审 major)在牵头方侧修掉的同类病灶(M1-DIST-1)在执行方侧、经真实传输形态复发;M1 QA 当时即预言「M3 真实传输接入时…会把该缺陷当成网络问题排查」。执行方暂停/恢复路径(评审 M1-QA,`machine.ts:247-254`)在真实传输下同为死代码。**测试为何没抓住**:cross-machine A2 驱动 50ms 完成(lease 400ms);lost-redelivery 的 B 在约 50ms 即断连、C 同样 50ms 完成——全部用例的任务寿命都短于 lease,`lease_self` 死线从未在链路健康状态下到达过。
- **建议**:① `session.ts` 构造器补接 `client.onAck`:对 `task.progress` 的 delivered 回执调用 `processExec(this.exec.onHeartbeatAcked(now), …)`(需 msg_id→任务 的最小映射或按当前执行位宽松处理);② 补 e2e 回归锁:FAST_PARAMS 下 B 接单后驱动 `completeAfterMs = 3 × leaseMsProject`(约 1.2s),全程心跳正常送达,断言 A 不产生 `reclaim` 审计、B 全程 `paused === false`、最终 `done(attempt=1)`;③ 同用例加变体:中途断 B 的 ws 再重连(退避 ≤5s),断言恢复后续租、不误判 lost(I-09 断线重连计时语义的端到端版)。

### QA-2|major|lost-redelivery 的 pickTarget 硬编码剧本绕开 excluded,R8 排除语义零覆盖,且反向掩盖「lost/fail 路径从不写入 excluded」的实现缺口

- **位置**:`packages/gateway/test/lost-redelivery.spec.ts:137-142`(`void excluded; return nextAttempt <= 1 ? B : C`);`packages/node/src/lead/machine.ts:405-416`(`applyExclusion` 仅被 `onOfferedMessage` 的 reject 路径调用,L210;lost 路径 L318-327 与 fail 路径 L241-254 均不调用);`packages/node/test/lead.spec.ts:108-119`(全仓库唯一 R8 单测只断言 busy **不**排除,永久排除/一次性排除均无断言)。
- **问题**:01 §6 R8 规定持久失败永久排除、瞬时 retryable 排除一次、判 lost 按 R4 取消衔接排除。R-MATRIX 第 18 行「R8 改派排除 | lead excluded 表 + lost-redelivery 排除后选 C | ✅」名不副实:用例选 C 靠 `nextAttempt` 硬编码,与 `excluded` 参数无关。双重后果:(a) 「excluded 表被正确写入、pickTarget 忠实消费」这条契约在单测与 e2e 两层都没有验证;(b) **掩盖实现缺口**——按现实现,判 lost 或 fail(retryable) 后 `excluded` 仍为空,一个忠实消费 excluded 的 pickTarget 会再次选中 B,形成 B→lost→B→lost 循环烧尽预算 escalate。当前 e2e 因为剧本化恰好测不出这一点。
- **建议**:① 先定语义:lost 节点是否入 `excluded`(建议按 R8/R4 入 `'once'`,或把「由 history 驱动」的取舍回写 01 决策记录),fail(retryable) 入 `'once'`、reject 持久码入 `'permanent'`;② 把 e2e pickTarget 改为忠实消费:`const t = [B, C].find(n => !excluded[n]); return t;` 并在改派后断言 `sessionA.lead.rec.excluded[execB.node_id]` 非空;③ lead 单测补三例:reject(unsupported_caps)→`'permanent'`、reject(policy_denied)→`'permanent'`、fail(retryable)→`'once'`。

### QA-3|major|A1 负向用例以固定 sleep(150ms) 赌 routing.denied 到达,慢环境下双断言齐崩,违背 M2 评审确立的「联调层零固定 sleep」纪律

- **位置**:`packages/gateway/test/cross-machine.spec.ts:181`(`await new Promise((r) => setTimeout(r, 150))`),L182-183 两条断言全部压在这 150ms 窗口上。
- **问题**:C→网关→C(routing.denied) 是完整 ws 往返 + 事件循环排队;CI 高负载或 GC 停顿超过 150ms 时 denied 未及到达 → `denied.some(...)` 假失败,且「B 无感知」断言也在错误时点做出。M2 REVIEW_QA 明确把「全程 waitFor 无固定 sleep」列为 M3 的正确底子,M3 首个负向用例即退步;该用例又是验收 A9/A6 的承载,抖动直接打在验收项上。
- **建议**:`const ok = await waitFor(() => denied.some((d) => d.rule === 'A1'), 3_000); expect(ok).toBe(true);` 之后再断言 B 静默——一旦观测到该 msg_id 的 routing.denied,信封已被网关终局拒绝,B 收不到它是确定性事实,B 静默断言即从时序赌注变成确定性断言。

### QA-4|major|崩溃一致性(检查点 vs 会话)零覆盖:RemoteNodeSession 无恢复路径,「恢复后改派静默失效」陷阱无测试护栏

- **位置**:`packages/node/src/remote/session.ts:67-71`(`traces`/`lastOfferBody`/三个定时器池纯内存)、L115-119(`redispatchLead` 对 `!body` **静默 return**);全文无 restore/adopt 方法。对照:`packages/node/src/local/harness.ts:100-113`(`adoptRestoredLead`:恢复 + 重挂 pendingTimers + drafting 重新派发)、`lead/supervisor.ts:39-56`(`restoreAll` → `onNeedDispatch`)。
- **问题**:01 §4.4 定案「v1 leader 接管 = 同机进程重启 + 检查点重放」。M1 已交付检查点/监督器并在 SingleNodeHarness 层验证(checkpoint.spec、regressions-m1),但 M3 真实会话形态与检查点世界完全脱节:A 进程在 reclaiming/drafting 期间崩溃重启后,`rec` 可由检查点恢复,而 `lastOfferBody`/`traces`/定时器全部丢失;`supervisor.restoreAll` 的 needDispatch → `redispatchLead` 会因 body 缺失**静默 no-op**,任务永久滞留 drafting——无消息、无审计、无终态。当前没有任何测试会碰到这个接缝(M3 两组 e2e 均无中途重建会话的用例),属于「检查点过了 M1 单测、会话过了 M3 e2e、接缝无人验」的典型缺口。
- **建议**:① 给 RemoteNodeSession 补恢复接线:adopt 检查点 + 按 `pendingTimers` 重挂 + `lastOfferBody` 持久化(或入检查点扩展字段);至少先让 `redispatchLead` 缺 body 时发审计/强制终态,消灭静默分支;② 补 e2e:A 判 lost 后、drain 关闭前「重启」(dispose 旧 session → 同 creds 新建 session → adopt 检查点)→ waitFor 断言改派续跑至 done;③ 若认定检查点-会话集成属后续批次,须在 WALKTHROUGH「当前状态」显式标注该缺口与排期,而非留白。

### QA-5|minor|FAST_PARAMS 时序余量系统性偏紧:offer TTL(200/300ms)压住整个接单往返,慢环境走 expired 连锁使 attempt===2 断言失真

- **位置**:`cross-machine.spec.ts:16-30`、`lost-redelivery.spec.ts:12-26`(TTL 200/300ms,lease 300/400ms);`lost-redelivery.spec.ts:161`(`attempt).toBe(2)`);`lead/machine.ts:313-317`(offer_ttl 到期即 beginReclaim;迟到的 accept 在 reclaiming 态被 L262-263 忽略)。
- **问题**:回环 ws 往返常态 <5ms,余量约 60 倍,但 vitest worker 满载/GC 停顿达数百 ms 并不罕见。一旦改派 offer 送达 C 超过 300ms:C 的 accept 在 reclaiming 态被忽略 → 二次 reclaim → attempt=3(断言失败,DIAG 误导为「改派未发生」);A2 的单一 offer 同理,且 A2 无 pickTarget,expired 后滞留 drafting,`done` 永不出现。整体 3s waitFor 预算对约 1s 名义路径仅约 3 倍,同属偏紧。
- **建议**:① 参数解耦——lost 链路要快的是 lease/grace/drain,TTL 无须压缩:两个 spec 的 `offerTtlMs*` 提到 ≥2s;② `attempt` 断言放宽为 `>=2` 并加 history 序列断言(`[lost(B)] → [accepted(C)]`)以区分「按剧本 attempt=2」与「慢环境多跑一轮」;③ 文件头注明各用例名义耗时与 waitFor 预算的倍数关系(建议 ≥5×),或以环境变量在 CI 整体放大 FAST_PARAMS。

### QA-6|minor|W1–W10 映射与 R-MATRIX 追溯存在三处失真/缺环

- **位置与依据**:
  - `docs/testing/R-MATRIX.md:12`(R2 行)「gateway lost-redelivery 过期链路 ✅」——`lost-redelivery.spec.ts` 全文无任何 expired/replay 场景(grep 证实);exp 覆盖实际在 `acl-core.spec.ts:171-190`(网关核级)与 regressions-m1/executor(单测级)。01 R2 的「必测场景」(长期离线批量过期 → 上线整批 reject(expired))缺「真实 ws + 收件箱补投 + 执行方拒收」端到端版(M2 评审 DIST-② 已预埋此建议)。
  - `docs/testing/R-MATRIX.md:22`(§7 委托链行)「trace 透传(session seal/cross-machine)✅」——`cross-machine.spec.ts` 无任何 trace 字段断言(grep 证实);「B 的 accept/result 携带 A 的原 trace_id」从未被验证,而这是 A8(日志还原)的前提。
  - `docs/testing/WALKTHROUGH-2NODE.md:34`(W1 标 ✅)——「通讯录互见(online=true、caps 摘要)」无任何断言:registry 17 项测 API 契约,M3 两组 e2e enroll 后均未查询目录互见;W4 的「或 escalate」分支在跨机层亦未覆盖(仅单机 lead.spec:108-119)。
- **建议**:① 修正 R-MATRIX 两处指针(R2 改指 acl-core.spec,并补端到端用例后改回);② lost-redelivery 补一项:B 断开 → A 发 offer(`queued`)→ 待 offer_ttl 过期 → B 重连 → waitFor 断言 A 收到 `reject(expired)`(01 R2 必测场景的 e2e 版);③ cross-machine 补一行断言:result 到达 A 时 `env.trace.trace_id === A 侧发起 trace_id`;④ W1 补目录互见断言,或在 WALKTHROUGH 把 W1 的 ✅ 收窄为「enroll 段 ✅,互见段未断言」。

### QA-7|minor|测试卫生:B 断连后残初心跳循环、按数组下标找 client、tokenY 重复签发、gw.close() 未 await

- **位置**:`lost-redelivery.spec.ts:155`(`clients[clients.length - 2]` 位置索引取 B 的 client)、L133 与 L156(B 断连后的残留循环);`cross-machine.spec.ts:75-76`(tokenY 连续签发两次,首个被丢弃)、L79-84(同步 afterAll 中 `void gw.close()`)。
- **问题**:① `bClient.close()` 后,B 会话心跳定时器继续触发:因 QA-1(无回执续期),`lease_self` 在 accept+400ms 处将其自停,但期间仍会发出约 3-4 条僵尸 progress——每条入 MemoryOutbox 并挂一个 2s ackWaiter;单用例文件尚可容忍,后续往该文件加用例即暴露交叉污染,且这些僵尸 outbox 项会冲淡对 R11 行为的断言。② 下标取 client 对 enroll 顺序脆弱:顺序一变即静默关错连接(如误关 C → offer 入收件箱 → done 永不出现,报错误导)。③ tokenY 双签发属笔误级噪音,首个 token 成为未消费死凭证。④ afterAll 不 await `gw.close()` 可能留 open handle,干扰 vitest 收尾判断。
- **建议**:`enroll()` 已返回 client,直接 `const bClient = execB.client`;close 后对 B 显式 `execB.session.dispose()`(或断言其心跳停发);删除重复的 tokenY 签发;afterAll 改 async 并 `await gw.close()`。

## 亮点

1. **失败可诊断性设计到位**:cross-machine A2 在 waitFor 失败分支打印双方状态/attempt/收发计数/history 再断言(cross-machine.spec.ts:158-164),把「慢环境挂掉」从黑盒变成可定位信息;`wait.ts` 封顶 + 末次复查的写法也正确。
2. **enroll 后立即同步目录再开跑**(cross-machine.spec.ts:96-97,注释写明动机):主动消除了 20ms 目录推送周期对第一封 offer 的误拒竞态,这正是「缺省行为有风险应指出」的反例——这里做对了。
3. **两套 e2e 与单测共用同一套状态机代码**,FAST_PARAMS 全参数注入,零逻辑复制;e2e 失败可下钻到 lead/executor 单测层定位,层次干净。
4. **真实时序 lost 链路的骨架正确**:366ms(2×133+100)真实 setTimeout 判 lost → cancel 先入通道 → drain 100ms → attempt+1 改派 → 收件箱断言,与 01 R3/R4 的顺序语义逐段对齐,DIAG 输出留有排障余量。

## 开放问题(不重复计 findings)

1. **真实 deepseek-harness 基座适配**属后续批次(任务书已声明);QA-1 的接线属会话协议层而非驱动层,建议不随基座适配顺延。
2. **FileOutbox 持久化**(R-MATRIX 标注「M3 收口前」)与 **R10 拉取器**(标注「M3 尾」)未在本轮交付内,收口前应见到对应用例。
3. **W8(日志还原 A8)**标注「M3 收口核验」:建议做成脚本化核验(从双机日志按 trace_id 拼回全生命周期并断言五字段齐备),与 QA-6 的 trace 断言联动,避免人工目测过关。
4. 网关集群化、owner 账号、跨队 grant、目录多副本:按评审约定不重复提。