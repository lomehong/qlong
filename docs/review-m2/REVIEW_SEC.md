# M2 中心三件 评审意见——信任边界与安全视角

> 评审对象:M2「中心三件」代码:packages/registry(directory.ts / errors.ts / http.ts)、packages/gateway(acl.ts / mailbox.ts / core.ts / ws.ts)、packages/node/src/gateway-client.ts + outbox.ts,及其测试(registry/test 2 件、gateway/test 2 件含三方联调)。
> 评审对照物:QLONG_DESIGN_NOTES.md、QLONG_DESIGN_01_MSG_PROTOCOL.md(下称 01)、QLONG_DESIGN_02_REGISTRY_TRUST.md(下称 02)、QLONG_DESIGN_03_CAPABILITY.md(下称 03)、QLONG_IMPL_PLAN.md;并对照 docs/review-m1/(M1 已决事项不重复提)。
> 范围声明:仅信任边界与安全视角(ACL 全规则逐条、A3 首帧认证、enroll、凭证生命周期、目录 epoch 缓存、限流配额、错误信封泄露、收件箱/持久化篡改面)。协议完备性、工程质量、API 契约由其他角色评审。
> 严重度:blocker=协议违反/安全漏洞/数据错乱/死锁;major=实质缺口,下版必修;minor=局部问题;nit=措辞建议。

## 结论 verdict

**需重大修订**:2 条 blocker、7 条 major 必须在 M2 收口前修复或显式裁决;核心 ACL 逻辑本身与 02 §7 逐条吻合,问题集中在 ws 适配器(崩溃面、补投缺失、连接表竞态)与多处「安全控制缺省关闭」的接线模式。

## 摘要

逐条对照 02 §7:A0 钉扎(from.team_id 可选语义)、A1 目录锚定与回程锚定、A2、A6 回声分级(A0/过期=静默无回执,A1/A2=本人可见 routing.denied,4001/4002 语义断连)实现与设计一致,并有确定性测试(I-13 伪造 to.team_id 用例在列);enroll 消费原子、token 哈希存储、CSPRNG、三态错误码符合 02 §4.3/§10;目录 epoch 缓存失效正确(§7.1);owner 面 P12 缺省拒绝;错误信封无信息泄露。主要风险:①ws 适配器对信封帧零校验,畸形信封在 ACL 路径抛未捕获异常可崩掉整个网关(开放入网下任何节点可触达);②收件箱补投从未在适配器接线,`queued` 回执已让发送方清空 outbox,离线消息实际永久丢失;③连接表按 nodeId 键控导致重连竞态静默黑洞、join 换队后钉扎过期;④A4 验签、轮换双因子、enroll 限流三项设计强制控制均为「未配置即放行」。

## 问题清单

### SEC-1|blocker|ws 适配器对信封帧零校验,畸形信封使网关进程未捕获异常崩溃

- **位置**:`packages/gateway/src/ws.ts:64-72`(`frame.envelope as EnvelopeV1` 直接下传)、`core.ts:101/113-121/152`(`envelope.exp`/`envelope.from`/`envelope.body.kind` 裸访问)、`acl.ts:26/56`(`head.from.node_id`/`args.head.to.node_id` 裸访问)。
- **问题**:认证后的 ws 帧只要满足 `frame.frame === 'envelope'` 且 `envelope` 为非 null 对象,就未经任何形状校验进入 `core.uplink`。发送 `{"frame":"envelope","envelope":{}}`(缺 `from`)→ `checkFromPin` 读 `head.from.node_id` 抛 TypeError;缺 `to` → A1 路径抛 TypeError;`from`/`to` 齐全但缺 `body` → `envelope.body.kind`(core.ts:152)抛 TypeError;`envelope` 传数组同样命中。异常发生在 ws 的 `message` 事件回调内,成为未捕获异常,**整个网关进程退出**。由于入网开放(02 §4.2 单机 team 零门槛),「已认证」不等于「可信」——互联网上任何人 enroll 后即可一发帧杀掉全网消息面;即便全员可信,一个 teammate 的装配 bug 也是全局 DoS。执法点(P12/D16 的网关)必须失败关闭,不能失败崩溃。
- **依据**:02 P12「状态不明 → 拒绝」、02 §7(网关为 ACL 执法点)、02 §4.2(开放入网 ⇒ 认证 ≠ 信任);01 §9(网关只看头做路由)。
- **建议**:①在适配器或 uplink 入口加最小头部校验(`msg_id`/`from.node_id`/`to.node_id` 为非空字符串、`body` 为对象或缺省),不合格静默丢弃 + 计数,连续畸形则语义断连;②`uplink` 调用包 try/catch,意外异常记审计(新增如 `envelope_malformed` 事件)而非冒泡;③补测试:缺 `from`/缺 `to`/缺 `body`/`envelope` 为数组四种畸形帧后网关仍存活、连接仍在。

### SEC-2|blocker|收件箱补投从未接线:`queued` 回执已清空发送方 outbox,离线消息永久丢失

- **位置**:`packages/gateway/src/ws.ts`(全文无 `takeInbox` 调用;auth 成功分支 47-62 行只做 connect/sockets.set/auth_ok)、`core.ts:157-160`(入箱并回 `queued` ack)、`gateway-client.ts:130-140`(收到任意 ack——含 `queued`——即 `outbox.remove`)。
- **问题**:`GatewayCore.takeInbox`(core.ts:164-175,含过期剔除与审计)在全仓库只有测试 acl-core.spec.ts:178 一处调用,ws 适配器在节点重连认证成功后**不排空收件箱**。链路后果:目标离线 → 信封入箱 → 网关按 01 §9 回 `queued` 回执 → 发送方(网关客户端)视其为回执,R11 重发终止、outbox 清空 → 此后没有任何机制把信封补投给重连节点。主路径上的**静默永久丢消息**,且发送方持有「网关已受理」的假象。M2.2 验收明文要求「持久收件箱……收件箱补投 + `exp` 兜底」(IMPL_PLAN §3 M2.2),该验收项实际未交付;trio.spec.ts 未覆盖「离线接收方重连收补投」,缺口因此不可见。
- **依据**:01 §9「离线暂存……重连即补投」、02 §8(离线暂存范围)、IMPL_PLAN §3 M2.2 验收、01 R11/§9(`queued` 回执后发送方不再重发)。
- **建议**:在 ws 认证成功分支(auth_ok 前后)调用 `takeInbox(nodeId, now)`,按 `deliveries` 逐帧推送 `{frame:'envelope'}`,`audits` 落审计;补三方联调用例:C 离线收 queued → C 重连 → 收到补投信封且对应 outbox 项此前未被误清。

### SEC-3|major|连接表按 nodeId 键控,重连竞态下旧 socket 关闭误删新连接——节点在线但上行被静默黑洞

- **位置**:`packages/gateway/src/ws.ts:59-60`(connect/sockets 以 nodeId 覆盖写入)、`ws.ts:74-79`(close 时无条件 `sockets.delete(nodeId)` + `core.disconnect(nodeId)`)、`core.ts:72-78`(`connect` 直接覆盖同 nodeId 旧连接)、`core.ts:106-111`(无连接分支静默无回执)。
- **问题**:同一节点先新连接替换注册、后旧 socket 才触发 close(弱网重连的常态时序),close 处理器会把**新连接**从 sockets/connections 中删除。此后:新 socket 仍处于 authed 状态,但其每条上行命中 `core.uplink` 的「无认证连接」分支被**静默丢弃、无任何回执**;发送给该节点的消息因不在 connections 而转入离线暂存。节点表现为「在线但完全失联」,且因 A6 静默无回声,只能靠自身 outbox 超时感知,而重试依旧被黑洞,直至下一次完整重连。这也是攻击者可借同一 token 反复建连挤压目标节点的可用性缺口。
- **依据**:02 §8(连接态 = 在线权威,连接表必须与真实 socket 生命周期一致);A6(静默分支只应服务伪造场景,不应吞掉诚实节点的日常流量)。
- **建议**:socket 与连接的绑定改用 `connId`:sockets 值携带 connId,close 时仅当「当前注册的 connId == 本 socket 的 connId」才删除;`GatewayCore.disconnect` 同样带 connId 校验。补竞态测试:同一 token 两连接先后建立、旧连接后关,新连接上行仍获回执。

### SEC-4|major|join 换队后连接钉扎不更新:conn.teamId 永远停留旧队,换队节点携带 from.team_id 的上行被 A0 永久静默丢弃

- **位置**:`packages/gateway/src/ws.ts:90-101`(`syncRegistry` 仅对 suspended/revoked 断连,不处理 team 变更)、`acl.ts:29-31`(A0 以 `conn.teamId`——握手时钉扎值——比对)、`core.ts:72-74`(connect 时一次性钉扎)。
- **问题**:02 §7.1 要求 join 换队 bump epoch 并推送,使「换队后旧 team 立即不可达」获得机制保证。跨队不可达方向确已由 A1/A2 的目录现查闭合(有测试);但**换队节点自己的既有连接**未被处理:`conn.teamId` 停留旧队,该节点此后所有携带 `from.team_id`(新队真值,01 §3.2 示例即携带)的上行在 A0 命中 `from.team_id ≠ conn.teamId` → **静默丢弃、无回执、永久**(syncRegistry 不会修复钉扎)。不携带 `from.team_id` 的消息虽可通行,但诚实发送者无从知道该字段已对自己变成雷区,配合 A6 静默构成无诊断线索的黑洞。
- **依据**:02 §7.1(epoch 推送的目的含换队后该节点自身状态的一致性)、A0(钉扎基准应为「连接身份(及目录归属)」,目录归属已变而连接身份未随)、D27。
- **建议**(择一):①`syncRegistry` 对比每个连接的 `conn.teamId` 与快照现值,不一致即重钉(`conn.teamId = entry.team_id`)或语义断连(如 close 4003/team_changed)强制重新握手重钉;②A0 的 `from.team_id` 比对基准改用目录现查的 sender 条目而非陈旧 conn 值。补测试:节点在线期间 joinTeam → 携带新 team_id 的上行获路由而非静默。

### SEC-5|major|A4 入站验签缺省关闭:未配置 verifyInbound 时节点无条件分发不验签信封,双重执法的「辅」层整体缺席

- **位置**:`packages/node/src/gateway-client.ts:17`(可选钩子)、`gateway-client.ts:160-164`(`if (!verify) { onEnvelope(env); return; }`)。
- **问题**:02 P10 明定「ACL 在网关执法(主),**节点侧复核(辅,验签 + team 复核 + 策略)**,单点执法必有单点失守」;02 §10 对「网关作恶——重放注入」的缓解正是「A4/A5 复核」。当前实现把 A4 做成可选回调且缺省直通:宿主不配置即失去全部验签防线,签名体系只剩「发送方自律」。仓库内无任何生产接线示例(trio.spec.ts:67 的实现是唯一范本且在 gateway 包测试里),M3 接真实节点时极易以缺省形态跑在无验签状态。v1.5 直连路径落地后,该缺省更是把「不经网关」路径的唯一认证防线置于可遗漏状态。
- **依据**:02 P10/§7 A4/§10(威胁模型明文依赖 A4/A5 兜底);01 §3.3.1(task.*/rpc.* 必签);D16(职责分离要求两层都在)。
- **建议**:①`verifyInbound` 未提供时,对 `task.*`/`rpc.*` 一律静默丢弃 + 计数(失败关闭),或在 options 以 `allowUnverifiedInbound: true` 显式开洞并留审计;②把 trio 中的「目录查 key + verifyEnvelopeSig」实现下沉为包内默认实现(`directoryLookupVerify`),宿主一行接入;③node 包补一条「未配置 verify → 信封不达 onEnvelope」的测试。

### SEC-6|major|密钥轮换双因子缺省降为单因子:仅持 node token 即可替换节点公钥(身份替换),违反 02 §6.1/P9

- **位置**:`packages/registry/src/http.ts:14-15`(`verifyRotationSig` 可选,注释自认「未配置 → 仅 token 认证放行」)、`http.ts:148-163`(未配置时 verifier=undefined 下传)、`directory.ts:262-274`(`rotateKeys` 的 `verifyRequestSig` 参数可选,`typeof === 'function'` 才校验)。
- **问题**:02 §6.1 明文:「常规轮换:`POST /v1/nodes/me/keys`(**token 认证 + 当前私钥对请求签名**双因子)」,并声明双因子的意义在于两因子后果分离(P9:token 是通行证、密钥是身份)。当前缺省形态下,偷到/泄露 node token 的攻击者可直接 `POST /v1/nodes/me/keys` 把目标节点公钥换成自己的——注册中心是事实 CA(02 §10),此后可长期伪造该节点的一切签名消息,而 token 本应「随时可吊销重发、身份不受影响」。附带缺陷:①`pubkey` 不做格式校验(任意非空字符串即入目录);②回调接口只传 `{node_id}` 与 `{pubkey, sig}`,无法落 02 I-03③ 的 `JCS({method, path, sha256(body), ts, nonce})` 规范(ts/nonce 缺位即无重放抵抗),宿主自证签名的正确性无保障。
- **依据**:02 §6.1(轮换双因子)、I-03③/I-46、P9、02 §10(密钥泄露缓解 = 轮换 + 纪元现势,前提是轮换本身不被单因子劫持)。
- **建议**:①比照 owner 面 P12 模式:`verifyRotationSig` 未配置时返回 503/新错误码(如 `rotation_sig_unconfigured`),**缺省拒绝**而非缺省放行;②core 包提供 `verifyRequestSignature`(JCS 规范化 + ts/nonce 窗口 + 方法/路径/body 哈希绑定)与黄金样本,http 层内置消费;③`pubkey` 校验 base64 且解码后 32 字节;http.spec.ts:86 现有「无 sig 轮换成功」用例应改为断言拒绝。

### SEC-7|major|enroll 限流/节点配额缺省关闭,限流桶无界增长:开放入网缺资源防线

- **位置**:`packages/registry/src/http.ts:16-17`(`enrollRatePerMinPerIp` 可选)、`http.ts:83-96`(`enrollLimit !== undefined` 才启用;`rate` Map 按 IP 只增不删)、`directory.ts:169-186`(无 token 即创建 self-owned team + node,无任何配额检查)。
- **问题**:02 §9/I-16/D30 把「/v1/enroll 按 IP/ASN 限流 + 每 owner 节点数配额 + orphan team GC」定为开放注册的强制基线。当前三者皆未落地且限流**缺省关闭**——不传参数即无限流;叠加「无 token enroll 即建 team+node」的开放路径,攻击者可以低成本灌入无限 team/node(目录、快照、`startRegistrySync` 每 50ms 全量 snapshot 的分配压力随之线性放大)。已启用的限流桶也按 IP 永久驻留内存(每 IP 一项,永不清理),公网部署下限流表自身成为内存放大器。
- **依据**:02 §9(限流与配额)、评审 I-16、D30、02 §4.2(orphan GC)。
- **建议**:①给缺省值(如 10/min/IP,部署可调)而非 undefined 才生效;②限流桶定期清扫(窗口过期即删)或改 LRU;③`issueEnrollToken`/`enroll` 落每 team(或每 owner)节点数上限常量(v1 保守值即可,超限回 `rate_limited`);④orphan/self-owned team 的 GC 至少留接口与策略参数占位,并在文档如实标注 v1 未实现。

### SEC-8|major|网关审计事件被整体丢弃:core 产出的 audits 在 ws 适配器无任何去向

- **位置**:`packages/gateway/src/ws.ts:65-72`(`const r = this.opts.core.uplink(...)`,仅消费 ack/routingDenied/deliveries,`r.audits` 弃置)。
- **问题**:`core.uplink`/`takeInbox` 为每条 A0 静默、A1/A2 拒绝、exp 剔除都按 01 §11 schema 生成了审计记录(含 head digest),但唯一 adapter 把它们丢进垃圾桶——伪造探测、跨队穿透尝试、吊销节点的挣扎在网关侧**零留痕**。01 §11 的 v1 事件枚举(`acl_rejected_from_pin` 等)与 A8 验收「审计事件可查、仅凭日志还原链路」对网关半边落空;安全运营(发现针对某节点的伪造攻击)也无从谈起。
- **依据**:01 §11(审计基线)、02 §7 A0/A1/A2(每条拒绝都带「+ 审计」)、IMPL_PLAN §1 A8。
- **建议**:`WsGatewayOptions` 增加 `onAudit?: (records: AuditRecord[]) => void`,uplink/takeInbox/syncRegistry 产生的审计统一回调,宿主接文件/SQLite sink;trio 测试断言 sink 收到 A1 拒绝事件。

### SEC-9|major|ws 面无帧上限、无连接数限制:未认证阶段可发起 100MiB 级帧与海量连接(内存/CPU DoS)

- **位置**:`packages/gateway/src/ws.ts:36`(`new WebSocketServer({ server })` 未设 `maxPayload`)、`ws.ts:37-80`(无每 IP/全局连接上限、无认证超时)。
- **问题**:ws v8 `maxPayload` 缺省 100MiB,未认证连接即可发送巨帧,`JSON.parse(String(data))` 触发百 MB 级字符串化 + 解析的内存/CPU 尖峰;同时服务端接受无限并发连接(认证失败的连接虽即 4003,但建连本身无速率约束)。注册中心 HTTP 面有 1MiB 上限(http.ts:20/42),网关 ws 面反而完全裸奔,两者不对称。
- **依据**:02 §9 限流基线的精神(入口资源保护);01 §9(网关承载全部消息面,是单点,须防资源型拒绝)。
- **建议**:`maxPayload` 设 1MiB 量级(≥ MAX_BODY_INLINE 256KB 加信封头余量);认证前空闲/失败计数(连续 N 坏帧断连并短暂拉黑);每 IP 并发连接上限;trio 补一条巨帧被拒(1009)的测试。

### SEC-10|minor|revoked 目标仍回 `queued`:发送方以为已受理,消息实际永不可达

- **位置**:`packages/gateway/src/acl.ts:56-83`(A1 只锚定 team,不查目标 status)、`core.ts:144-160`(不在线即入箱并回 queued)。
- **依据**:02 §6.1(revoke = 网关停路由 + 终态)、02 §10(被吊销节点残留作恶一行的处理意图)。
- **建议**:路由前查 `toTeam.status === 'revoked'` → 回 `routing.denied`(rule A1/reason `node_revoked`)不入箱;suspended 可保留 queued(可恢复,重连补投后仍有效)。补用例:吊销目标 → rejected 终局。

### SEC-11|minor|客户端对 4001/4002/4003 一律无限重连:违反 D28 的节点侧呈现要求,吊销节点永久敲门

- **位置**:`packages/node/src/gateway-client.ts:71-79`(close 仅透传 onClose,不区分语义码)、`gateway-client.ts:176-186`(任何非用户关闭都 scheduleReconnect,退避封顶 5s)。
- **问题**:D28 要求 suspend/revoke 后「节点本地呈现『本机已被团队 owner 暂停』」;现实现把语义 close code 当普通断线,被吊销节点以 0.2Hz 永久重试(每次都打满 A3 + 4003),用户侧无终态提示。宿主虽可在 onClose 里自行调 `close()` 止住重连,但正确行为不应依赖每个宿主记得这样做。
- **建议**:客户端内置终态识别:4001/4002/4003 → 停止自动重连,置终态(如 `state='blocked'`)+ 回调携带 status;补测试:suspend 断连后不再自动重连。

### SEC-12|minor|A4 静默丢弃只计数不留审计:缺 01 §11 的 `sig_verify_failed` 事件

- **位置**:`packages/node/src/gateway-client.ts:157/168-172`(`rejectedInbound += 1`,无 makeAudit)。
- **问题**:01 §11 v1 枚举明列 `sig_verify_failed`,且要求日志含 `trace_id/task_id/attempt/msg_id/key_epoch` 关联字段;纯计数无法回答「谁在伪造我」。A8 验收在节点侧同样依赖该事件。
- **建议**:复用 core `makeAudit('sig_verify_failed', ...)`,随 onAudit sink 输出(与 SEC-8 的 sink 同场落地)。

### SEC-13|minor|outbox 缺省 MemoryOutbox(非持久)且 ackWaiters 泄漏

- **位置**:`packages/node/src/outbox.ts:16-33`、`gateway-client.ts:40`(`opts.outbox ?? new MemoryOutbox()`)、`gateway-client.ts:93-99`(超时 resolve 'timeout' 但不删 `ackWaiters` 条目)。
- **问题**:①01 R11 要求关键消息「发送方本地**持久化**」,缺省实现进程重启即丢未获回执的 result/fail/cancel——恰是最不该丢的消息;接口已预留可注入,但仓库无持久实现。②`send` 超时后 ackWaiter 条目不删除,永不获回执的 msg_id 在 Map 中常驻(长期运行节点慢性泄漏);迟到回执会触发已 settled promise 的回调,无碍但条目仍在。
- **建议**:M3 前提供文件版 `FileOutbox`(可复用 M1 JsonFileStore 的 tmp+rename 原子写与 M1 SEC-7 的权限硬化结论);`send` 超时分支删除 waiter。

### SEC-14|minor|收件箱纯内存:网关重启即丢失所有已回 `queued` 的消息(单机 v1 缺省行为风险)

- **位置**:`packages/gateway/src/mailbox.ts:8-11`(boxes 为内存 Map)、`core.ts:41/49`。
- **问题**:与 §12.1 网关集群化的「收件箱共享持久存储」开放问题不同,这里是**单实例 v1** 的缺省行为:重启 = 已承诺(`queued` ack)的消息全灭,而发送方 outbox 已清(SEC-2 同因)。另外死节点的箱体无周期清扫,仅靠重连 drain 剔除过期,200 条/箱 × 无限箱体常驻内存。
- **依据**:01 §9(网关过期清理「仅回收存储」暗示存在清理机制);开放问题不重复,但 v1 缺省风险按评审指令须指出。
- **建议**:v1 最小做法:收件箱 append-only 落盘(JSONL/SQLite)重启回放;或文档显著声明「网关重启丢失已 queued 消息」并在 `queued` ack 语义中注明,任选其一,不可静默。加周期性过期清扫。

### SEC-15|minor|注册中心输入边界缺失:enroll token TTL 无上界、caps/load 无形状与体量约束

- **位置**:`packages/registry/src/http.ts:216-222`(`ttl_ms` 任意数字直传)、`directory.ts:156-166`(ttlMs 不钳制)、`directory.ts:304-314`(putCaps 无标签数/长度上限)、`directory.ts:316-319`(putLoad 原样存任意 JSON,≤1MiB)。
- **问题**:owner 端点可签发 TTL=十年的一次性 token(02 §4.3 只说「可配」未授权无界);已认证节点可把 1MiB 垃圾写进 load(通讯录逐条回传,读放大)、putCaps 无界标签撑大目录与 D31 过滤开销。均为已认证主体的资源放大,配合 SEC-7 的开放入网门槛极低。
- **依据**:02 §4.3(TTL 语义)、03 §3.3(load 字段白名单:queue_depth/running/accepting/ts/ttl_ms)、03 §3.1(标签形态;注册中心虽不做语义校验,但体量边界属存储保护)。
- **建议**:ttl 钳制(如 ≤24h);caps ≤200 条、每条 ≤128 字符;load 做字段白名单归一化,超限 400。

### SEC-16|minor|revoke 未清除 caps/load 档案(03 §8 隐私要求未兑现)

- **位置**:`packages/registry/src/directory.ts:293-300`(`revoke` 仅置状态/离线/epoch)。
- **问题**:03 §8(评审 I-47):「节点 revoked 后,注册中心即删除其 caps/load 档案」。现实现中档案随 NodeRecord 永久保留。当前 `listTeamNodes` 排除 revoked、snapshot 不含 caps,泄露面暂小,但档案一旦被后续接口(审计导出、目录回放)带出即成违约。
- **建议**:`revoke()` 中 `node.caps = []`、`node.load = null`(keys 保留供历史验签与审计)。

### SEC-17|minor|presence 无任何接线:通讯录 `online` 恒为 false,02 §8 在线权威未兑现

- **位置**:`packages/gateway/src/ws.ts:59-62/74-79`(连接/断开不回写)、`directory.ts:109/207/334`(presence 仅 enroll/revoke 置 false,src 内无置真路径;仅测试 directory.spec.ts:136 手工置真)。
- **问题**:02 §8「权威来源 = 网关连接态」、§9「目录 API 的 `online` 字段来自网关连接态」——当前 src 层没有任何桥,真实部署中通讯录全员永显示离线,牵头方据此的派单决策失真(方向保守但失真)。属跨模块集成缺口,落在信任边界数据路径上,故记录;接管方为集成/架构视角时可移转。
- **建议**:`WsGatewayOptions` 增 `onPresence?: (nodeId, online) => void`,由宿主写回 `registry.presence`;trio 补端到端断言(连上后通讯录 online=true)。

### SEC-18|nit|局部瑕疵四则

- `packages/registry/src/http.ts:66-71`:Bearer scheme 匹配大小写敏感,RFC 7235 §2.1 scheme 大小写不敏感,严格客户端(如某些语言库发 `bearer`)会被 401。
- `packages/gateway/src/core.ts:107-110`:「无认证连接」分支复用审计事件 `acl_rejected_from_pin`,语义失真(并非钉扎失败);建议独立事件(如 `unauthenticated_uplink`),便于 SEC-3 类竞态的现场甄别。
- `packages/gateway/src/mailbox.ts:23`:`box.length >= capacity ? 'stored' : 'stored'` 死三元,恒返回 'stored'。
- `packages/registry/src/directory.ts:213-226`:`joinTeam` 已实现但 http.ts 未暴露路由,现行不可达(非缺陷,预告:暴露时须套用与 enroll 同款的限流与错误契约,I-48②)。

### SEC-19|nit|R-MATRIX ACL 段未随 M2 回填,追溯承诺滞后于实现

- **位置**:`docs/testing/R-MATRIX.md:24-26`(ACL A0–A6 仍全部标 🔲 M2)、`:19-21`(R9/R11 状态未更新)。
- **问题**:gateway/test/acl-core.spec.ts 与 trio.spec.ts 已落 A0(两分支)/A1(三态)/A2/epoch 失效/4001/4002/补投剔除的确定性断言,矩阵未回填将使 A9 验收核对失真,也与 01 §6「每条规则可追溯到测试用例」的维护承诺不符。
- **建议**:按实际用例逐条回填(A3/A5/A6 的节点侧分支注明归属包与用例名);R9 已由校验器+网关结构保证,标 ✅ 并注依据。

## 亮点

- **ACL 纯函数与 core 引擎同构且逐条对表**:acl.ts 的 A0(含 `from.team_id` 缺省即不核对的可选语义)/A1(目录锚定 + 自报一致性核对 + 回程同规则)/A2 的判定顺序、审计事件名(01 §11 枚举)与 routing.denied 回声方向完全符合 02 §7/D27/D28;「I-13 伪造 to.team_id 跨队穿透被拒」有专测(trio.spec.ts:133-140)。
- **目录 epoch 缓存失效实现正确且被测试钉住**:条目携带快照 epoch、快照替换即清缓存(core.ts:53-69),「换队后旧 team 立即不可达」有确定性用例(acl-core.spec.ts:146-157)。
- **enroll 全链路干净**:token 仅存 sha256、明文单次出现、CSPRNG(16B/32B 符合 §4.3/§3.2 位数)、同步单线程下消费原子、无效/过期/已用三态码与人话呈现契约(I-23③)齐备;GET /nodes/me 不回显 tokenHash 有断言(http.spec.ts:61)。
- **owner 面 P12 缺省拒绝**(503 owner_auth_unconfigured),suspend/revoke 返回语义 close code 并端到端打通 4001 推送(trio.spec.ts:151-154);`lookupPubkey` 三态(current/historical/unknown)+ 非 active 回源拒绝,与 §6.2 纪元现势逐字吻合,且未引入负缓存(规避吊销抑制类缓存污染)。
- **错误信封统一且无泄露**:错误码表与 02 §9 一致(另加 owner_auth_unconfigured 合理),500 通用化不带栈/内部信息;API 无 CORS、凭证仅走 Authorization 头。
- **三方联调测试真实有效**:真实 ws + 真实 Ed25519 签名 + 真实注册中心进程,坏签名静默、outbox 重发同 msg_id、aid 不暂存等关键路径均为行为级断言。

## 开放问题(提请委员会,非缺陷)

1. **请求签名验证器的共享实现**:双因子轮换(SEC-6)落地需要 `verifyRequestSignature`(JCS({method,path,sha256(body),ts,nonce}))与黄金样本,属 core 公共件;建议列入 M2.1 修订或 M2.3 联调前交付,避免各宿主自证签名。
2. **网关审计 sink 的持久化形态**(SEC-8):文件/SQLite/汇聚到注册中心三选一的取舍与保留期,需与 A8「审计可查」验收口径同场定。
3. **跨进程部署下的 presence 回写与目录推送通道**(SEC-17):同进程直调(v1 现状)之外的形态本属 §12.1 集群化议题,但单机双进程形态(评测/演示常用)也需一条最小通道,建议在 §8.4 双机走查前一并定。