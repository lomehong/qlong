# M3 双机真实传输闭环 评审意见——传输安全视角

> 评审对象:M3 交付物:packages/node/src/remote/session.ts(RemoteNodeSession)、packages/node/src/gateway-client.ts(入站路径)、packages/gateway/test/cross-machine.spec.ts、packages/gateway/test/lost-redelivery.spec.ts、docs/testing/WALKTHROUGH-2NODE.md、docs/testing/R-MATRIX.md;必要时对照 executor/lead 状态机与 gateway core/acl(传输链路的上下游)。
> 评审对照物:QLONG_DESIGN_NOTES.md、QLONG_DESIGN_01_MSG_PROTOCOL.md(下称 01)、QLONG_DESIGN_02_REGISTRY_TRUST.md(下称 02)、QLONG_DESIGN_03_CAPABILITY.md(下称 03)、QLONG_IMPL_PLAN.md;并对照 docs/review-m1/REVIEW_SEC.md、docs/review-m2/REVIEW_SEC.md(已决事项不重复立条,仅引用)。
> 范围声明:仅端到端传输安全视角(A4 验签绕过面、seal 签名覆盖与重放(exp)、A5 防御完备性、检查点/收件箱篡改面的 M3 增量、trace 伪造影响、capability/会话信息泄露)。协议完备性、可靠性工程、API 契约由其他角色评审。
> 严重度:blocker=协议违反/安全漏洞/数据错乱/死锁/丢失;major=实质缺口;minor=局部问题;nit=措辞建议。

## 结论 verdict

**需重大修订**:1 条 blocker、4 条 major 必须在 M3 收口前修复或显式裁决。核心问题:**「双机真实传输闭环」的节点侧认证层(A4)实际全程缺位,且测试标题与追溯文档声称其已覆盖**——网关(主执法层,继承 M2)扎实,但 02 P10 明定的双重执法只剩单层;A5 复核、exp 新鲜性、R1 去重、消息来源绑定在真实链路上均未落地或存在绕过面。这些缺口在 M1/M2 评审中大多已有预告(M2 SEC-5/SEC-12),M3 是它们本应闭环的里程碑,故按「实质缺口已坐实」从严定级。

## 摘要

端到端走查确认:出站方向 seal() 先校验后签名、JCS/Ed25519/密钥纪元查取符合 D23,出站不会发出无签名信封;网关 A0/A1/A2 与回声分级(M2 已评审)在 M3 两个 spec 中有真实负向用例。但入站方向:A4 验签是 `verifyInbound` 可选钩子,未配置即直通,而 M3 全部真实链路接线(cross-machine/lost-redelivery 两 spec、RemoteNodeSession 构造器)无一配置它——测试标题却写「真实 ws+签名+A4」,R-MATRIX 标「A4 全覆盖 ✅」;A5 兜底用例绕过传输层直呼 `onEnvelope`,伪造签名 `value:'x'` 从未被任何层校验,且 `from.team_id` 省略即可绕过 A5。exp 校验仅覆盖执行方的 task.offer,lead 入站与 cancel 路径全无新鲜性判断;R1 去重(纯函数 M0 已备)未集成进真实链路;reclaiming/cancelling 态接受任意来源的 result/fail/cancel.ack,执行方 cancel 不校验发送方。网关妥协或 v1.5 直连场景下,上述任何一条都直接放大为「任意任务书注入执行」。

## 问题清单

### SEC-1|blocker|A4 入站验签在真实传输链路全程未接线,测试与追溯文档虚标覆盖——双重执法的「辅」层整体缺席

- **位置**:`packages/node/src/gateway-client.ts:20`(可选钩子)、`gateway-client.ts:186-190`(`if (!verify) { this.onEnvelope(env); return; }` 缺省直通);`packages/gateway/test/cross-machine.spec.ts:98-102` 与 `lost-redelivery.spec.ts:83-87`(两处 `new GatewayClient({...})` 均未配置 `verifyInbound`);`packages/node/src/remote/session.ts:25-47`(`RemoteSessionOptions` 有 `priv` 无任何验签/公钥目录依赖,构造器亦不设 verify);仓库内 `verifyInbound` 唯一接线是 `gateway/test/trio.spec.ts:67-71`(M2 遗留测试)。
- **问题**:①02 P10「双重执法:ACL 在网关执法(主),节点侧复核(辅,验签 + team 复核 + 策略),**单点执法必有单点失守**」;02 §10 对「网关作恶(重放注入)」「被吊销节点残留作恶」两条威胁的缓解均明文依赖「A4/A5 复核」。当前 M3 交付的「真实传输形态」即缺省形态:入站信封不验签直达状态机,`from.node_id` 完全自报。网关被攻陷/作恶、ws 明文链路被注入(见 SEC-8)、乃至 v1.5 直连落地后的对端认证,全部失去防线;执行方把 offer 直接交给驱动(M4 接真实 deepseek-harness 基座后即本地执行),等于**任意任务书注入执行**。②覆盖声明失真:`cross-machine.spec.ts:146` 用例标题「……(真实 ws+签名+A4)」——实际仅有出站签名,入站 A4 未发生;`cross-machine.spec.ts:186-205` 的「A5 防御兜底」用例直呼 `sessionC.onEnvelope(forged)`,同时绕过网关与客户端两层,forged 信封的 `sig.value:'x'` 不被任何层校验,该用例只证明了「自报跨队 team_id 被计数」;`docs/testing/R-MATRIX.md:26`(「A4 坏签名静默……全覆盖 ✅」)、`:30`(「闸1 …+trio A4 ✅」)与 `docs/testing/WALKTHROUGH-2NODE.md:20/34`(W5 标 ✅)据此失真,验收 A9 的「ACL 全部拒绝路径有确定性测试」对 A4 的节点侧分支不成立。M2 SEC-5 已将「缺省直通」定为 major 并预警「M3 接真实节点时极易以缺省形态跑在无验签状态」,M3 交付物坐实了该预警。
- **依据**:02 P10/P12、§7 A4、§10(网关作恶行);01 §3.3.1(task.*/rpc.* 必签)、§3.3.4(验签失败静默丢弃+审计);D16/D23;M2 评审 SEC-5/SEC-12。
- **建议**:①**失败关闭**:`verifyInbound` 未提供时,对 `task.*`/`rpc.*` 一律静默丢弃 + 计数(或以 `allowUnverifiedInbound: true` 显式开洞并留审计),不允许缺省直通;②把 trio 中「目录查 `(node_id, key_epoch)` 公钥 + `verifyEnvelopeSig` + 纪元三态(current/historical)」实现下沉为 node 包默认构件(如 `createDirectoryVerifier(registryClient)`),由 `RemoteNodeSession` 构造时自动装配,宿主零配置即有 A4;纪元现势性(02 §6.2 回源)与 TOFU 钉扎(02 §10)至少留接口位;③cross-machine 与 lost-redelivery 两 spec 全部接入 verifyInbound,并补端到端负向用例:B 侧收到坏签名信封 → 不达状态机、驱动不启动;④回填 WALKTHROUGH W5/R-MATRIX A4 行,如实标注「trio 单点已测、双机链路待接线」的现状。

### SEC-2|major|A5 复核存在绕过面且零审计:`from.team_id` 省略即放行;静默丢弃只剩内存计数

- **位置**:`packages/node/src/remote/session.ts:233`(`if (env.from.team_id !== undefined && env.from.team_id !== this.teamId)`——undefined 即通过)、`session.ts:62-63`(`rejectedInbound += 1`,无 `makeAudit`)、`gateway-client.ts:183/194/197`(结构非法与验签失败同样只计数)。
- **问题**:①A5 的语义是「钉扎后跨队 → 静默丢弃 + 审计」(02 §7 A5/A6)。节点侧唯一可自核的跨队信号就是入签名的 `from.team_id`;当前实现把「省略」当作「通过」,而 01 §3.2 示例与 `seal()`(session.ts:274)显示诚实节点恒携带该字段——**省略 `from.team_id` 的信封只有攻击者有动机**,恰好命中 P12「状态不明 → 拒绝」的反面。在 SEC-1 修复(验签锚定 `from.node_id`)之后,team 归属仍可回源目录复核;在修复之前,该检查是 A5 的全部,而它可被一个字段省略绕过。②所有 A5/exp/结构丢弃路径只递增内存计数:01 §11 的 v1 事件枚举(`to_mismatch`/`acl_rejected_cross_team`/`sig_verify_failed`/`exp_rejected`)在节点侧一条都产不出来,「谁在伪造我、何时、什么形状」完全不可观测,A8「审计事件可查」的节点半边落空(网关半边见 M2 SEC-8;客户端计数无审计见 M2 SEC-12,session 层是新增的同源缺口)。`onAudit` 钩子在 session 中已存在,丢弃路径却绕开它。
- **依据**:02 §7 A5/A6、P12;01 §3.3.4、§11;M2 评审 SEC-8/SEC-12(同源,彼时限于 gateway-client 计数,M3 session 层扩大了面)。
- **建议**:①`from.team_id === undefined` 且类型属 task.*/rpc.* → 按跨队同款静默丢弃(A4 修复后可改为「验签通过但缺 team_id」仍失败关闭,诚实发送方 `seal()` 恒携带,无误伤);②丢弃路径统一走 `makeAudit` + `opts.onAudit`(事件名用 01 §11 枚举,附 `envelope_head_digest`/`msg_id`/`from.key_epoch` 关联字段);③补用例:省略 `from.team_id` 的信封被丢弃且有审计;A5 丢弃产生 `acl_rejected_cross_team`。

### SEC-3|major|exp 新鲜性校验仅覆盖 task.offer:lead 入站与 cancel 路径全无,重放窗口等于 exp 全窗

- **位置**:`packages/node/src/remote/session.ts:227-262`(`onEnvelope` 入口无 exp 检查;`:259-261` lead 路径连 exp 参数都不传给 `lead.onMessage`);`packages/node/src/executor/machine.ts:137`(唯一检查点,仅 offer);`packages/gateway/src/core.ts:101/166`(网关侧两道 exp——恰说明节点侧防线不能依赖网关)。
- **问题**:01 §3.1 定义 exp 为 task.* 必填的新鲜性字段,「接收方按『接收时刻 ≤ exp + 漂移预算』判废弃,过期静默丢弃 + 审计」——接收方是**节点**,不是网关;02 §10 对「消息重放」的缓解是「exp + 漂移预算;R1 去重保留期下限;`dedup_mismatch` 审计」三件套(前提即节点侧独立执法,P2 传输无关)。当前实现里 exp 只在执行方评估 offer 时生效,同一重放信封若 type 是 `task.fail`/`task.result`/`task.cancel` 则 24h+10min 内永远新鲜。可复现的危害:同 attempt 的合法历史 fail 重放进 reclaiming 窗口(`lead/machine.ts:278-287`,retryable=false 直接终态 failed,**吞掉改派机会**)、旧 result 重放进 cancelling 窗口(`:296-301` → done)——R0 的 attempt 闸门只拦「跨 attempt」重放,同 attempt 窗口内全靠 exp/去重,而两者都缺(去重见 SEC-5)。02 §10 重放行明文要求「实现须测试覆盖」,M3 无任何补投重放负向用例。
- **依据**:01 §3.1/D24、§9(「正确性不依赖暂存——exp 与 body 内相对有效期由端上独立判过期」)、R2 精神;02 P2、§10(重放行);M1 评审对 core 失败方向的肯定(实现件已在,缺的是接线)。
- **建议**:①把 exp 检查提到 `RemoteNodeSession.onEnvelope` 入口:`task.*` 缺 exp/不可解析/过期 → 静默丢弃 + `exp_rejected` 审计(与网关 core.ts:101 同判式,复用 `isExpiredByExp`),不依赖各状态机自觉;②补用例:过期 cancel / 过期 fail 补投被节点丢弃并留审计;reclaiming 窗口内重放同 attempt 旧 fail(fatal) 不改变终局。

### SEC-4|major|消息来源绑定缺失:reclaiming/cancelling 接受任意节点的 result/fail/ack,执行方 cancel 不校验发起方

- **位置**:`packages/node/src/lead/machine.ts:184`(`onReclaimingMessage(type, body, now)`——`fromNode` 在 `onMessage` 作用域内可得却未传入)、`:262-294`(无来源比对)、`:296-309`(`onCancellingMessage(type, body)` 同);对照 `:194/:206`(offered 态有 `fromNode === this.rec.target`)、`:218`(running 态有同款检查);`packages/node/src/executor/machine.ts:308-333`(`onCancel(fromNode, attempt)` 只比对 attempt,不比对 `fromNode === rec.from`,ack 回给任意 fromNode)。
- **问题**:01 §3.1 四 ID 表定义 attempt 为「执行权纪元」——result/fail 的交付主体是该 attempt 执行权的持有方;01 §4.5 亦以 `(task_id, attempt)` 关联任务。当前 lead 状态机在 offered/running 两态正确校验了来源,但在 **reclaiming/cancelling 两个赛跑窗口**对来源完全失防:同队任意第三节点(或 SEC-1 修复前的任意伪造者)可发送伪造 `task.result`(attempt 对齐即可)使任务以攻击者可控的 `resultBody` 进 `done` 并流入验收整合/图谱,或以伪造 `cancel.ack` 提前收口 drain 改任改派目标。执行方侧同理:任意节点的 `task.cancel` 可停掉在途任务(定向 DoS),且 ack 发往攻击者。三处检查的不一致(offered/running 有、reclaiming/cancelling 无)本身就说明这是遗漏而非设计取舍。
- **依据**:01 §3.1(四 ID 分工)、§4.5、§5.1(reclaiming 收 result → done 的前提是执行方赛跑窗口)、R0;02 A5(节点复核含来源合理性)。
- **建议**:①`onReclaimingMessage`/`onCancellingMessage` 增加 `fromNode` 参数并断言 `=== rec.target`(reclaiming 后 target 未变;确需豁免的场景显式注释);②`ExecutorMachine.onCancel` 校验 `fromNode === this.rec.from`,不符静默丢弃 + 审计,不回 ack;③补用例:第三节点在 drain 窗口发伪造 result/cancel.ack → 被忽略 + 审计;异源 cancel 不停任务。

### SEC-5|major|R1 去重未集成进真实链路:at-least-once 常态下节点侧零幂等防线,`dedup_mismatch` 审计缺失

- **位置**:`packages/node/src/remote/session.ts`(全文无 DedupStore)、`gateway-client.ts`(入站路径无去重);对照 `packages/core/src/dedup.ts`(M0 已评审的纯函数实现,被测试覆盖却无生产消费方);`docs/testing/R-MATRIX.md:11`(R1 标 ✅,依据仅 core/semantics)。
- **问题**:P4/R1 明定投递假设为「至少一次、不保序」,重投是常态;01 R1 要求除 progress 外的 task.* 以 `(task_id, attempt, type)` 去重、保留期 ≥ `max(offer_ttl, lease) × max_attempts + drain_ms`、同键不同 body → `dedup_mismatch` 审计。当前真实链路里网关不去重(at-least-once 语义本来也不要求)、节点不去重,幂等完全侥幸依赖状态机的形状(如 executor 对同 attempt offer 返回 `[]`、terminal 态吞消息)。具体缺口:①网关补投重放(trio M2-02 已演示同 msg_id 补投)在节点侧无任何防线,与 SEC-3 叠加后 02 §10 重放行的三件套缓解只剩网关侧 exp 清理;②重复 `task.cancel` 在 result_sent 态每次都回 ack(machine.ts:328-331,回声放大);③同键不同 body 的 `dedup_mismatch` 审计事件全链路无人产出;④R-MATRIX 以 core 纯函数测试标注 R1 ✅,属「组件已测 ≠ 集成已落地」,追溯承诺失真。
- **依据**:01 P4/R1;02 §10(重放行「实现须测试覆盖」);01 §6「每条规则可追溯到测试用例」。
- **建议**:①在 `RemoteNodeSession.onEnvelope`(或 gateway-client 入站回调前)集成 core `DedupStore`:键 `(task_id, attempt, type)`,progress 豁免 + `seq` 单调,重复静默丢弃 + 审计,保留期按 R1 下限参数化;②R-MATRIX R1 行拆分「core 纯函数 ✅ / 真实链路集成 🔲」并随本次修复回填;③补用例:同 msg_id 补投重放不二次执行、同键异 body 触发 `dedup_mismatch`。

### SEC-6|minor|未知 `task.*` 类型被静默丢弃,违反 §8「禁止静默丢弃」与 unsupported_type 回执义务

- **位置**:`packages/node/src/remote/session.ts:238-261`(仅识别 `task.offer`/`task.cancel`,其余类型进入 `lead.onMessage` 后无匹配即 `[]`;executor 对非 offer/cancel 类型直接忽略)。
- **问题**:01 §8:「收到未知 type → 回 `reject(unsupported_type)`(验签+同 team 复核之后)……**禁止静默丢弃**」。当前实现下,拼写错误的 `task.acsept` 或未来新增的 `task.foo` 都无声消失:发起方得不到快速拒绝(R6 精神),协议演进(§8 允许新增 type)时新旧节点互操作退化为超时等待。ws 适配器对未知**帧**静默属协议演进位(M2 已评审),但信封 type 层的 unsupported_type 回执是节点义务,两者不是一回事。
- **依据**:01 §8、R6;02 A6(已认证场景结构化回执)。
- **建议**:`session.onEnvelope` 对 `task.*` 未知动作类型,在验签 + 同队复核通过后回 `reject(unsupported_type)`;rpc.* 同理(answer/ask)。补用例:未知 type 获 reject(unsupported_type),未认证伪造者的未知 type 探测仍静默。

### SEC-7|minor|trace 三元组无任何一致性核对即透传与落日志:伪造 origin_node 可污染 A8 链路还原

- **位置**:`packages/node/src/remote/session.ts:240`(`this.traces.set('exec:${taskId}', env.trace)` 原样采信)、`:129-132`(lead 出站以存储 trace 签名透传)、`gateway/test/cross-machine.spec.ts:196`(测试自身也随手伪造 `origin_node: credsA.node_id`,佐证该字段无可信锚)。
- **问题**:01 §7.2 要求 trace 原样透传、不得改写,其价值在 A8「仅凭双机日志 + trace_id 还原全链路」;但 `trace.origin_node`(发起节点)从不与任何目录事实核对,`trace_id` 也无唯一性约束。同队节点(或 SEC-1 修复前的任意伪造者)可自称 origin 为任意第三方节点、或与他人任务撞 `trace_id`,把审计/日志关联导向错误结论——对取证型审计是定向污染。威胁边界声明:与 A4 类似,验签开启后属「同队成员作恶」面(02 §10 已认全互信),故定 minor;但它与 SEC-1 叠加时零成本。
- **依据**:01 §7、§11(日志关联规范)、A8;02 §10(同队攻陷豁免的边界声明)。
- **建议**:①最小核对:`hops === 0` 的发起消息要求 `trace.origin_node === from.node_id`(不符 → 丢弃 + 审计;转派透传不核对);②审计记录同时携带 `from.node_id` 与 `trace.origin_node`,使事后核账可发现不一致;③WALKTHROUGH W8 执行时把「origin 与 from 一致」列入还原核对项。

### SEC-8|minor|ws 仅明文:`wss`/TLS 在客户端与服务端均无支持,跨机「真实传输」即明文跨网

- **位置**:`packages/node/src/gateway-client.ts:70`(`new WebSocket(this.opts.url)` 对 scheme 无任何约束)、`packages/gateway/src/ws.ts:34`(`createServer` 明文 HTTP)、`:159-163`(`listen(port, host = '127.0.0.1')`)。
- **问题**:M3 的双机形态一旦按字面跨机部署(listen 0.0.0.0 + `ws://<ip>:port`),node token 首帧(A3 凭证)与全部信封头/body 明文过网:token 可被窃取冒用连接,消息面可被被动收集与主动注入(在 SEC-1 修复前,注入即执行)。设计侧对等物——install 通道「仅 HTTPS/HSTS」(02 §10)——在消息面没有对应物。TLS 终止可由生产反代承担,但当前代码对 `wss://` 的可用性与证书校验行为均未验证,也没有文档声明「明文 ws 仅限本机/可信内网」。
- **依据**:02 §10(install 通道基线的精神)、P9(token 是通行证,泄露即可冒用);01 §9(网关承载全部消息面)。
- **建议**:①`GatewayClient` 对非本机地址的 `ws://` 给显式警告或要求 `allowInsecureTransport` 配置项;②服务端文档化「仅 TLS 终止反代之后暴露」,并补一条 `wss://` 连通性说明或测试占位;③在 WALKTHROUGH 前置节声明双机演示的网络边界假设。

### SEC-9|nit|`hops > MAX_HOPS` 的 `reject(refused_loop)` 语义在实现中不可达,R8 永久排除死分支

- **位置**:`packages/core/src/envelope.ts:149-153`(hops 超限判结构非法,传输两端在状态机之前即拒)对照 01 §7「收到 hops 超限的 offer → `reject(refused_loop)`」;`packages/node/src/lead/machine.ts:408`(`applyExclusion` 的 `refused_loop` 永久排除分支因此不可达)。
- **问题**:超限 offer 在网关/客户端结构校验即被拒(回执 reason 是 `bad_frame` 而非 `refused_loop`),执行方永远不会以 refused_loop 拒单,lead 的 R8 永久排除表收不到该码。v1 单跳下无实害,但这是 §7 与校验器之间的语义分叉:设计意图是「业务层拒绝 + 记忆」,实现变成了「结构层丢弃」。建议要么在设计文档回写「hops 超限按结构拒绝,refused_loop 仅留给节点侧直连路径」(记决策),要么把 hops 检查从结构校验挪到节点语义层。当前形态至少应注释说明,避免 M4/直连批次误以为 refused_loop 链路已通。

### SEC-10|nit|`seal()` 丢弃 `reply_to`:01 §4.5 的消息级关联在真实链路整体缺失

- **位置**:`packages/node/src/remote/session.ts:49-55`(`OutboundSpec` 无 reply_to)、`:170`/`:267-285`(seal 装配不含该字段);对照 `packages/node/src/wire.ts:7`(`Outbound.reply_to` 字段存在,状态机 `out()`/`outFor()` 均已填)。
- **问题**:执行方/牵头方状态机按 01 §4.5(I-57)正确产出了 reply_to,传输层装配时静默丢弃——accept/reject 指向 offer 的 msg_id、result 指向 offer msg_id 的排障链路在双机链路上断裂(A8 还原只能靠 task_id/attempt)。01 §3.1 说 reply_to 缺失不构成协议错误,故仅 nit;但字段在两层间「有产出、无装配」的不对称宜趁 M3 收口对齐:在 `seal()` 的 base 中透传 `a.msg.reply_to`(存在时),一行修复。

## 亮点

- **出站方向纪律扎实**:`seal()` 先 `validateEnvelope(…, { allowMissingSig: true })` 全字段校验、后 `signEnvelope`(session.ts:282-284),保证真实链路不会发出无签名或非法信封;JCS 签名域(剔除整个 sig)、alg 白名单、按 `from.key_epoch` 查钥与 D23/I-36 逐条吻合,黄金样本测试在位。
- **exp 判定的失败方向正确**:`isExpiredByExp` 对不可解析 exp 按过期处置、「晚于」判向与 I-38 一致(core/freshness.ts);网关侧 uplink 与补投两道 exp 清理实现干净(core.ts:101/165-167)——缺的是节点侧接线,不是实现件。
- **网关执法层(继承 M2)在 M3 端到端用例中得到真实锤炼**:A1 跨队投递 → `routing.denied` → 接收方零感知的负向断言(cross-machine.spec.ts:171-184)是「中心只见头、伪造值在网关即死」的有效行为级证据。
- **lost/改派演练把可靠性规则跑成了真实时序**:真实 setTimeout + 真实 ws 断连驱动 R3 判 lost → cancel 入收件箱待补投 → R8 排除 B 改派 C → attempt=2 done,并对收件箱留痕有显式断言(lost-redelivery.spec.ts:154-167)。
- **R0 attempt 闸门两侧前置且方向正确**:执行方对更高 attempt 的隐式取消 + 旧态摘要(executor/machine.ts:104-134)、lead 对迟到旧 attempt 的 `stale_attempt` 回执,均有确定性测试,与 D25 一致。

## 开放问题(提请委员会,非缺陷)

1. **节点侧公钥目录的获取形态**(SEC-1 的前置):M3 节点与注册中心之间目前只有 enroll 一锤子买卖,无 HTTP 客户端与目录缓存;A4 默认实现需要决定「enroll 时同步拉取全队公钥 + 订阅 epoch 推送」还是「按需回源 + 本地钉扎」,与 02 §6.2 纪元现势、§10 TOFU 钉扎同场定案。
2. **trace 校验强度**(SEC-7):`origin_node === from.node_id`(仅 hops=0)是否足够、要不要把 trace 一致性纳入 `dedup_mismatch` 同款审计,建议随 A8「日志还原」验收核验一并定。
3. **节点侧审计 sink**(SEC-2/SEC-3 的落地依赖):与 M2 评审开放问题 2(网关审计持久化形态)合并处置——节点 onAudit 与网关 onAudit 的 sink、保留期、查询口径应一次定,避免两侧各落一套。
