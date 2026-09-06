# 群龙 M2 里程碑评审意见 —— 测试充分性

> 评审角色:测试充分性(对照 `docs/testing/R-MATRIX.md` 与 01 §9/§11、02 §6/§7/§9、IMPL_PLAN M2 验收口径)。
> 评审范围:`packages/registry`(directory.ts/errors.ts/http.ts + test 17 项)、`packages/gateway`(acl.ts/mailbox.ts/core.ts/ws.ts + test 19 项,含三方联调 6 项)、`packages/node/src/gateway-client.ts` + `outbox.ts`(node/test 中零引用,仅经 gateway/test/trio.spec.ts 间接覆盖)。行号以评审时点文件为准。
> 本文件为只读评审产物,仅此一份。

## 结论 verdict

**有条件通过。** 17+19 项测试真实可复跑、无凑数痕迹:ACL 纯函数裁决与 02 §7 的确定性断言纪律(I-13「伪造 to.team_id 必须被拒绝」配对用例)落实到位,联调层全程 `waitFor` 无固定 sleep,是 M3 离散事件仿真的正确底子。但存在 1 项 blocker:**ws 入站信封零结构校验,已认证节点一帧即可击穿网关进程,而畸形帧负路径测试为零**;补投与在线态两处「核心单测绿、真实接线缺失」被测试口径掩盖;限流、P12 owner 默认拒绝、密钥轮换双因子三处契约要么无行为断言、要么用例空转。修订意见落实并补齐下述用例后方可收口。

## 摘要

- **blocker ×1**:网关对上行信封不做任何结构校验(`ws.ts` 直转 `core.uplink`),缺 `from`/`to`/`body` 的信封在 ACL 或 `body.kind` 访问处抛 TypeError 且无任何层捕获,属可用性安全漏洞;畸形帧/缺字段负例集完全缺失。
- **major ×10**:收件箱补投在真实 ws 路径未接线(仅 core 单测覆盖);ws 生命周期负路径(错误 token/认证超时/重复认证帧/重叠重连替换缺陷)零测试;半开连接无 keepalive 致 presence 失真与 delivered 回执虚发;客户端重连/退避/竞态零单测且 `close()` 存在复活缺陷;enroll 限流零行为断言;P12 owner 默认拒绝用例空转;审计只断言 event 名且网关审计缺 §11 关联字段;密钥轮换双因子契约无测试锁定(缺省单因子放行);presence 端到端断链;R-MATRIX 未随 M2 更新、追溯断链。
- **minor ×3 / nit ×1**:ACL 分支断言缺口(A0/A1 留空合法、A1 回程锚定、A6 回执归因等);enroll/keys/caps 负面契约与格式校验缺失;收件箱容量与 revoked 暂存边界零测试;杂项。

---

## 问题清单(按严重度排序)

### Blocker

#### QA-1 blocker|网关入站信封零结构校验,已认证节点单帧可击穿网关进程;畸形帧负路径测试为零

- **位置**:`packages/gateway/src/ws.ts:64-72`(envelope 帧未校验直接 `core.uplink`);`packages/gateway/src/core.ts:113-121`(head 组装直接解引用 `envelope.from/to`)、`core.ts:152`(`envelope.body.kind` 访问);`gateway/src` 全包未 import `validateEnvelope`(grep 证实,该函数在 core 已存在且被 node 客户端使用)。
- **问题**:已认证节点发送 `{frame:'envelope', envelope:{}}` 或 `{from:{node_id:自机}}` 而 `to`/`body` 缺失的信封时:① `evaluateUplink`→`checkFromPin` 对 `head.from.node_id`、`args.head.to.node_id` 解引用 undefined 抛 TypeError(acl.ts:26、56);② 通过 ACL 的信封在 `core.ts:152` 对 `envelope.body.kind` 解引用 null/undefined 同样抛错。异常发生在 ws `message` 事件监听器内,`ws.ts` 无 try/catch、core 无防御,沿事件发射链成为 uncaughtException,击穿网关进程——单点中心组件可被任一已认证成员(或被攻陷的同队机器)一帧打死。对照 02 P12「失败关闭」与 02 §7 执法前提(网关执法只依赖「信封头」存在性);这正是「负路径零测试」掩盖的活体缺陷:`acl-core.spec` 全部用 `envelope()` 工厂构造完整合法信封,`trio.spec` 无任何畸形帧用例。客户端侧(`gateway-client.ts:155-159`)反而有 `validateEnvelope` 防线——攻守不对称。
- **建议**:① `ws.ts` envelope 分支(或 `core.uplink` 入口)先过 `validateEnvelope`(至少头字段存在性 + msg_id 为 uuid),不合格回 `rejected(acl_rejected)` 或静默计数,禁止向上抛;② uplink 全程包 try/catch 兜底审计;③ 补畸形帧负例集(每例断言「连接存活 + 网关进程存活 + 无投递」):缺 `from`/`to`/`body`、`from:null`、`to:null`、`body:null`、`envelope:[]`(数组可过 `typeof === 'object'` 检查)、非对象 envelope、垃圾 JSON、超长帧(>1MB)、auth 后重复 auth 帧;④ 补一条 fuzz 风格 property(随机截断/字段删除的合法信封变体不崩溃)。

### Major

#### QA-2 major|收件箱补投在真实 ws 路径未接线,core 单测绿掩盖了「重连即补投」整体缺失

- **位置**:`packages/gateway/src/ws.ts:47-62`(auth 成功后仅 `connect + auth_ok`,无任何 `core.takeInbox` 调用;全仓 grep:`takeInbox` 仅出现于 `core.ts:164` 定义与 `acl-core.spec.ts:178` 测试直调);对照 01 §9「离线暂存……重连即补投」、IMPL_PLAN M2.2 验收「收件箱补投 + exp 兜底」。
- **问题**:补投逻辑(`GatewayCore.takeInbox`,含过期剔除 + exp_rejected 审计)实现正确、core 级测试到位,但 ws 适配器从不调用——生产路径上入收件箱的 project 信封永远无人投递。而 `gateway-client` 也没有「上线后拉取」帧,两侧都没接。R11 联调用例(trio.spec:156-163)恰好掩盖了这一点:D 重发的消息因 B 已被 suspend 而入 B 的死信箱,断言只到「D 的 outbox 清空」为止,从未断言消息真正到达 B。结果:M2.2 验收的「补投」半句只在 core 单测层成立,集成层不可达且无测试失败信号——典型的「账实两层各自绿」。
- **建议**:① ws 适配器在 `auth_ok` 后调用 `core.takeInbox(nodeId, now)` 并逐帧推送(或定义客户端 `fetch_inbox` 帧,二选一并在 02 §9 注明);② 补端到端用例:B 离线 → A 发 project offer(获 `queued` 回执)→ B 重连 → `waitFor` 断言 B 收到**同一 msg_id** 信封;③ 同用例补变体:暂存期间过期 → B 重连后收不到 + 网关侧 `exp_rejected` 审计字段完整(联动 QA-8)。

#### QA-3 major|ws 生命周期负路径与连接替换缺陷零覆盖:4003 拒绝路径、认证超时缺失、重叠重连误删新连接

- **位置**:`packages/gateway/src/ws.ts:37-79`。对照 02 §7 A3(连接认证)、A6(回声分级)、01 §9;任务书明列「ws 生命周期(半开连接、认证超时、重复认证帧、malformed 帧)」。
- **问题**:四类负路径全部无测试、其中两类无实现:
  1. **认证超时缺失**:未认证连接可无限挂起(`connection` 处理器无任何定时器),慢速连接即可占满连接面;客户端侧 `open()` 同样无超时,网关不应答 auth_ok 时 Promise 永不 settle(gateway-client.ts:44-81)。
  2. **重复认证帧静默**:authed 后再收 `{frame:'auth'}` 落入无分支匹配,静默忽略,无审计无断连——帧序状态机无「已认证后 auth 帧」语义定义,也无测试钉住行为。
  3. **拒绝路径无断言**:错 token → 4003、非 active(suspended/revoked)节点认证 → 4003、认证前发 envelope → 4003,三个分支都实现了(ws.ts:47-56)但零测试。
  4. **重叠重连缺陷**:同 nodeId 二次认证时 `core.connect` 与 `sockets.set` 直接覆盖旧条目,旧 socket 未被关闭;旧 socket 随后触发 `close` 事件(ws.ts:74-79)按 **nodeId** 删表,把**新连接**的连接表/套接字映射一并删掉——在线态丢失、后续消息误入收件箱。这是重连时序的常态竞态(网络抖动下新旧连接交叠),当前零测试。
- **建议**:① 认证超时可配置(建议默认 10s),超时 close 4003;客户端 open() 对称加超时;② 已认证后收到 auth 帧:close 4xxx 或审计,落用例钉死;③ 补三个 4003 负例;④ 连接替换时先 `ws.close` 旧 socket,且 close 处理按 `connId` 比对而非 nodeId;⑤ 补「同 token 两个 ws 相继认证 → 关第一个 → 断言第二个仍在线可收发」用例。

#### QA-4 major|半开连接无 keepalive:presence 失真 + delivered 回执虚发,至少一次投递被静默绕过

- **位置**:`packages/gateway/src/ws.ts`(无 ping/pong/心跳);`core.ts:144-149`(仅按 `connections.has` 判在线即回 `delivered`);`ws.ts:109-115`(safeSend 静默吞错)。对照 01 §9 投递语义「至少一次」、R11(获回执即停发)、02 §8(在线权威 = 网关连接态)。
- **问题**:TCP 半开(对端断电/NAT 静默失效)不产生 close 事件:网关连接表保持「在线」,上行信封被判 `delivered` 并回执发送方,outbox 随即删除(R11 语义:获回执停发),而消息实际沉入死 socket——**至少一次投递在这一形态下被打破,且无任何审计痕迹**。同时 presence 长期虚高,误导目录在线态与 aid 改派判定。v1 未把「网关半开」列入 01 §9 已知限制,属缺省行为风险;测试侧 `trio.spec` 全部走干净 close,该形态不可达。
- **建议**:① ws 层加 ping/pong 心跳(建议 30s 间隔 + 2 次失活判死),失活走与 close 相同的清理路径;② 短期兜底:`safeSend` 失败/readyState 非 OPEN 时把投递降级为入箱并把 ack 从 `delivered` 改为 `queued`;③ 若 v1 明确不做了,须回写 01 §9「已知限制」声明该窗口,并补一个假死 socket 用例(server 侧 `socket.destroy()` 不发 close 帧)至少钉住当前实际行为;④ presence 判定联调用例联动 QA-10。

#### QA-5 major|客户端重连/退避/outbox 时序竞态零单测:`close()` 后挂起的退避定时器会复活重连,ackWaiter 泄漏

- **位置**:`packages/node/src/gateway-client.ts:44-45`(`open()` 首行 `closedByUser = false`)、`110-114`(`close()` 不清除待触发定时器)、`176-186`(`scheduleReconnect` 的 setTimeout 无句柄、不可取消)、`93-99`(超时后 ackWaiter 不清理);`node/test` 对 gateway-client/outbox **零引用**(grep 证实),唯一覆盖是 trio 6 项。对照 R11、任务书「客户端重连/退避/outbox 时序竞态」。
- **问题**:① 用户 `close()` 若发生在退避等待窗口内,挂起的 `setTimeout` 到点仍触发 `open()`,而 `open()` 重置 `closedByUser=false`——客户端违背用户意愿自动重连,且此后永久脱离用户控制;② 退避公式 `base*2^min(n,6)` 封顶 5s 无任何断言(指数曲线、封顶、auth_ok 后归零均未测);③ ack 超时返回 `timeout` 后 `ackWaiters` 条目滞留,同一 msg_id 后到的回执还会触发已废弃的 waiter(幸为 no-op),长期是缓慢泄漏;④ `MemoryOutbox.save` 的 attempts 递增语义(重发计数)无测试。联调用例只覆盖「未连接发送 → 重连 → 重发」一条阳光路径。
- **建议**:① `scheduleReconnect` 记录定时器句柄,`close()` 时 clearTimeout;`open()` 由用户显式调用时才重置 closedByUser;② 抽出 `nextBackoffMs(attempts)` 纯函数补单测(序列、封顶、归零);③ 超时 resolve 时删除 waiter;④ 补用例:close() 竞态、verifyInbound 抛错走计数分支、收到 `routing.denied` 后 outbox 终局不重发(trio 只测了 accepted 侧)。

#### QA-6 major|enroll 限流(02 §9/评审 I-16)零行为测试:唯一沾边用例名不副实,实现硬编码时钟且缺省关闭

- **位置**:`packages/registry/src/http.ts:83-96`(限流器,`Date.now()` 硬编码;`enrollRatePerMinPerIp` 未配置即不启用);`packages/registry/test/http.spec.ts:83-95`(用例名「……+ 限流独立」但 `enrollRatePerMinPerIp: 1000` 形同关闭,无任何 429 断言);对照 02 §9「限流与配额」、评审 I-16、任务书「限流窗口边界」。
- **问题**:防滥用基线是开放注册的唯一闸门,当前:① 零行为测试(无 429、无 `retryable: true` 断言、无窗口滚动重置、无按 IP 隔离、无「仅 /v1/enroll 生效」验证);② 时钟不可注入,边界(第 N 次 200、第 N+1 次 429、窗口恰好 60s 判向)无法确定性测试;③ 缺省关闭——生产装配漏配参数即裸奔,属 v1 缺省行为风险,应在契约上显性(缺省给保守默认值或启动告警)。
- **建议**:① 限流器抽为可注入时钟的纯类(或导出判定函数)并单测:限内通过/超限 429 + `retryable:true`/窗口边界判向/IP 隔离/仅 enroll 计数;② http.spec 真实起服务打满阈值断言 429;③ 缺省值与风险写进 TSDoc 与 02 §9 回写。

#### QA-7 major|P12「owner 接入点默认拒绝」测试空转:断言的是函数元数而非行为;owner/节点权限隔离与 revoke HTTP 面无测试

- **位置**:`packages/registry/test/http.spec.ts:111-118`(「P12:owner 鉴权未配置 → 503」用例:创建两个 server 即 `close()`,最终断言 `expect(createRegistryServer.length).toBeGreaterThanOrEqual(1)`——函数参数个数,零 HTTP 行为);`http.spec.ts:97-109`(owner 用例在 `ownerAuth: () => true` 下用节点 bearer 调 suspend 即通过,「拒绝」半边无测试);revoke 端点 HTTP 契约(应回 `closeCode: 4002`)全无覆盖。对照 02 P12、§3.2、§9,任务书「owner 接入点默认拒绝」。
- **问题**:P12 失败关闭是 owner 面的安全底线,当前 guarded by 一个**空转用例**——若实现回归为「未配置即放行」,测试依然全绿。同时:ownerAuth 配置为拒绝函数时 owner 端点应 403、**普通节点 token 冒充 owner** 应被拒(现在是节点 bearer 调 suspend 成功,测试反而演示了越权放行)、revoke 端点与 4002 语义无 HTTP 级断言——owner 面的实际防线未经任何行为验证。
- **建议**:① 重写 P12 用例:未配置 `ownerAuth` 的服务真实监听,POST suspend/enroll-tokens 断言 503 + `owner_auth_unconfigured`;② 补 ownerAuth 返回 false → 403;③ 补「节点 token 调 owner 端点被拒」权限隔离用例;④ 补 revoke HTTP 契约(4002)及「revoke 后 token 立即 403 node_revoked」;⑤ 清理该用例中的 `void s2`/`void noAuth` 死代码。

#### QA-8 major|审计断言止步 event 名:网关审计缺 01 §11 关联字段(trace_id/task_id/attempt),A4 客户端无审计落地,digest 无断言

- **位置**:`packages/gateway/src/core.ts:102、109、129、133、168-170`(五处 `makeAudit` 仅传 `node_id/reason/envelope`,未提取信封中现成的 `trace_id/task_id/attempt`);gateway 全部测试断言最深仅 `audits[0]?.event`(acl-core.spec:61、68、92、127、181、188);`gateway-client.ts:157-171`(A4 验签失败仅 `rejectedInbound` 计数,无 `sig_verify_failed` 审计事件)。对照 01 §11「统一审计事件 schema……缺字段视为日志缺陷」「日志关联规范」、A4「验签失败→静默丢弃+审计」、A8 验收(仅凭 trace_id 离线还原)。
- **问题**:① 网关审计记录缺关联字段,尽管 `makeAudit` 的 `AuditFields` 明明支持、信封里字段现成——A8「离线还原派单全生命周期」在网关侧日志上不成立;② 所有测试只断言事件名,`node_id/reason/envelope_head_digest/trace_id/task_id/attempt` 六个字段零断言——schema 回归(如 digest 算法变更、字段误删)不会被任何用例捕获;③ `envelope_head_digest` 的 P3 承诺(不含 body、同头异 body 摘要相同)无任何测试;④ 客户端 A4 只剩计数器,与 02 A4「+审计」不符,坏签名联调用例(trio:142-149)断言的也只是计数。
- **建议**:① core.ts 五处补传 `trace_id/task_id/attempt`(信封可得时);② 每类审计事件至少一条「字段集断言」用例(event/node_id/reason/digest/trace_id/task_id/attempt);③ 补 digest 性质用例(同头异 body 摘要相等、改头摘要变);④ 客户端 verify 失败接入审计回调(AuditRecord 或至少事件名),trio 坏签名用例改断言审计字段而非裸计数。

#### QA-9 major|密钥轮换双因子契约(02 §6.1/评审 I-03③)无测试锁定,且缺省配置下单因子即可轮换

- **位置**:`packages/registry/src/directory.ts:262-274`(`verifyRequestSig` 可选参数,未传即跳过签名校验);`packages/registry/src/http.ts:148-163`(`opts.verifyRotationSig` 未配置时传 undefined——**缺省仅 token 认证放行**;且 verifier 只收到 `{node_id}` 与 `{pubkey,sig}`,§6.1 签名要素 `JCS({method, path, sha256(body), ts, nonce})` 的 method/path/body 哈希无从拼装);`directory.spec.ts:78-87`、`http.spec.ts:86`(两处轮换用例都走无签名单因子路径)。对照 02 §6.1「token 认证 + 当前私钥对请求签名」「双因子取舍的代价如实声明」。
- **问题**:轮换正是「token 泄露后夺回身份」的防线;现缺省配置下,窃得 token 即可把节点公钥换成攻击者公钥(注册中心 = 事实 CA,02 §10 的信任根被单因子打穿),而签名校验即使配置了也无法按设计的签名要素验(接口缺参)。测试全走旁路路径,双因子契约(签名不符 → 401、重放 nonce → 拒、pubkey 与签名不匹配 → 拒)零断言。
- **建议**:① 缺省拒绝单因子轮换(`verifyRotationSig` 未配置 → 503/400,与 owner 面 P12 同构)或在 TSDoc/文档显性声明偏离并回写 02 §6.1;② verifier 接口补齐 `method/path/sha256(body)/ts/nonce` 要素(或改为接收完整 req + rawBody);③ 补契约用例:签名不符 → 401、ts/nonce 重放 → 拒、轮换后旧 epoch 仍可验签(补投窗口,联动 02 §6.2——该半边已有测试)。

#### QA-10 major|presence 端到端断链:网关连接态从未回写注册中心,目录在线态(impl 验收 A1 组成部分)不可验证

- **位置**:`packages/gateway/src/core.ts:71-74`(`connect` 注释声称「presence 置真」但 GatewayCore 不持有任何 presence 引用);全仓 grep:`Registry.presence` 在 src 中只有 `false` 写入(directory.ts:207、297),置真仅存在于测试手工 `set`(directory.spec.ts:136);`gateway/test/trio.spec.ts:30-31、44`(registryHttp 起了服务但全程零请求)。对照 02 §8「权威来源 = 通讯网关连接态」、§9「目录 API 的 online 字段来自网关连接态」、IMPL_PLAN A1「目录互相可见(**含在线态**、caps 摘要)」。
- **问题**:M2 没有任何 gateway→registry 的 presence 回写点(连回调接口都没预留),生产装配下 `online` 恒为 false;三方联调从未经真实 HTTP 查询目录,A1 验收的在线态半句既无实现也无端到端断言——与 QA-2 同属「单测绿、集成断链」。
- **建议**:① WsGateway 增加可选 `onPresence(nodeId, online)` 回调(或在 `authenticate` 返回的 registry 句柄上回写),连接/断开/管理断连三处都触发;② trio 补用例:A、B 连接后经**真实 HTTP** `GET /v1/teams/{id}/nodes` 断言两者 `online:true`;B 断连(含 4001 推送)后再查 `online:false`;③ 顺带覆盖 `next_cursor` 预留字段与 `platform/qlong_version` 回显(§9/I-52)。

#### QA-11 major|R-MATRIX 未随 M2 更新,追溯断链:ACL 区整段仍是「🔲 M2 待落」,R9/R11 行未反映已交付实现

- **位置**:`docs/testing/R-MATRIX.md:24-26`(ACL 区:「全部 🔲 M2 网关实现时落确定性断言……」,未映射到 gateway/test 实际 13 条 ACL 用例);`R-MATRIX.md:19`(R9「🔲 M2」——M2 已交付网关一对一路由但无用例映射);`R-MATRIX.md:21`(R11「🔲 M3」——回执帧消费与 outbox 重发已在 M2 实现并经 trio 覆盖,应拆行如实标注,M3 剩余的是持久化 outbox)。对照 IMPL_PLAN §5(R-矩阵是「01 §6 可追溯」的兑现)、impl plan M2.2 验收 A9、M1 评审问题 28(同类失真,收口条件第 3 条曾要求更正)。
- **问题**:R-矩阵是追溯唯一账本;M2 交付后 ACL 区零更新,「A9:ACL 全部拒绝路径(A0–A6)有确定性测试断言」无法对账核验(哪些 A 分支有断言、哪些缺,见 QA-12);R9/R11 行停留在旧排期口径。下版排期将据此误判。
- **建议**:① A0–A6 逐条映射用例编号(acl-core.spec 各 it + trio 对应用例),缺口如实标 🔲(联动 QA-12 清单);② R11 拆「回执帧消费/outbox 重发(M2 ✅,gateway/test/trio)」与「持久化 outbox(M3 🔲)」;③ R9 补命名用例(至少「信封缺 to 必被拒」——当前该形态落到 QA-1 的崩溃路径)或注明由 core 校验器+网关何者保证。

### Minor

#### QA-12 minor|ACL 分支断言缺口(对照 02 §7 逐条与 A9 验收)

- **位置**:`packages/gateway/test/acl-core.spec.ts`、`packages/gateway/test/trio.spec.ts`。
- **问题**(已覆盖的不列):① **A0 留空合法分支**:`from.team_id` 缺省应放行(01 §3.1 `team_id?` 可选;02 A0 只罚「不一致」),无用例;② **A1 留空合法分支**:02 A1 明文「`to.team_id` 留空合法」,现只有跨队负例与带 team 正例,「留空 + 同队 → route」无用例;③ **A1 回程锚定**(D27 明文「回程消息的 to 同样按发起方目录归属锚定」):同路径但无命名用例,未来若对 reject/answer 类做特判无回归防护;④ **A6 回执归因**:trio 的 `routingDeniedSeen` 为共享数组(trio.spec:27、77),断言无法区分「谁收到了 denied」——「C 无感知」(trio:139)只验证了 envelope 未达,未验证 routing.denied 帧不会误发给接收方/第三方;⑤ **`setDirectory` 旧 epoch 快照拒绝**(core.ts:54 无用例):乱序目录推送不得回退缓存;⑥ **offline_not_stored 端到端**:aid 不暂存仅 core 级断言(acl-core:161-169),trio 无对应(离线 + aid → 发送方收 rejected 回执)。
- **建议**:每条补一例,归因问题给 `routingDeniedSeen` 加 client 标记;回程锚定用例按 01 §4.3 方向约束构造「执行方 reject 回牵头方」信封。

#### QA-13 minor|enroll/keys/caps 负面契约与格式校验缺失:pubkey 经 `String()` 漂白入库,caps 非数组被静默清空,join 无 HTTP 面

- **位置**:`packages/registry/src/http.ts:105`(`pubkey: String(body.pubkey ?? '')`——数字/对象 pubkey 漂白后通过非空校验)、`http.ts:136`(`body.caps` 非数组被当作 `[]` 传入 `putCaps` → **全量清空能力档案**且 caps_rev 自增)、`http.ts:101-111`(缺 pubkey 仅由 directory 层 400 兜底,无 HTTP 级负例);`directory.ts:170`(pubkey 仅校验非空串,无 base64/32 字节 Ed25519 格式契约);`joinTeam`(directory.ts:213-226)无任何 HTTP 路由,join(重装恢复)形态(02 §4.2 第二形态)未实现、未测试、也无范围声明;PATCH /v1/nodes/me(http.ts:124-129)、HTTP 4xx 面(405/413/非法 JSON/未知路径)零测试。对照 02 §4.1、§9「统一错误信封」、评审 I-60。
- **问题**:目录是 TOFU 信任根的登记处,任意形状 pubkey 可入库(后端验签时才失败,污染目录与审计);caps 清空是「畸形 body 静默改写数据」——一条负例本可拦住;join 在 HTTP 面缺席使 02 §4.2 换队流程在 M2 集成上不可达(仅 directory 单测),与「02 §9 API 面逐端点契约测试」的 M2.1 验收口径之间缺一句范围说明。
- **建议**:① pubkey 契约:非字符串 400、非合法 base64/长度不符 400,补负例集;② caps 非数组 → 400(全量替换语义仅对合法数组成立);③ join:补 HTTP 路由 + 契约用例(双因子、token 复用 409、epoch 推进),或在 R-MATRIX/回写文档声明「join HTTP 面延后」;④ 补 405/413/非法 JSON/404 各一例,锁定统一错误信封形状。

#### QA-14 minor|收件箱容量与「向非 active 节点暂存」边界零测试:'full' 返回值为死分支

- **位置**:`packages/gateway/src/mailbox.ts:19-23`(溢出 shift 丢最旧无测试;`return box.length >= this.capacity ? 'stored' : 'stored'` 两臂相同,'full' 不可达);`core.ts:151-160`(暂存判定只看 `body.kind==='aid'` 与连接态,不查目标 status——对 suspended/revoked 节点照常入箱,revoked 节点永不上线即死存储)。对照 01 §9「aid 类不暂存」、02 §6.1「revoke:网关停路由」、02 §10「已投递到对端收件箱的离线消息,上线后 A4/A5 仍拦」。
- **问题**:① 容量上限是设计认可的存储保护,「丢最旧」行为却零测试(丢哪条、容量边界、drain 后容量恢复);② revoked 节点继续接收暂存与「网关停路由」的完整语义存在张力——02 §10 只豁免「已投递」存量,未授权增量暂存;v1 缺省行为应显性裁决(revoke 后至少停增量入箱 + 可选清箱),当前无测试也无文档口径;③ `InboxStore.offer` 的 `'full'` 返回值永远不出现,类型契约撒谎,调用方若依赖必踩坑。
- **建议**:① 补容量用例(capacity=2 时入 3 条断言丢最旧、size 上限、drain 清空);② revoked → 不入箱(ack 仍 `queued` 或改 `rejected(expired)` 需定夺并回写),suspend → 至少落审计;③ 修掉死三元或实现真实 'full' 语义。

### Nit

#### QA-15 nit|杂项四处

- **位置与问题**:① `packages/registry/src/errors.ts:6`:`enroll_token_in_flight` 登记在错误码表(02 §9),但同步单进程实现下不存在 in-flight 窗口,属死字母——建议 TSDoc 注明「预留给集群化(02 §12.1)」或移除,防止误以为已实现;② `gateway/test/trio.spec.ts:49`:`void gw.close()` 未 await,悬挂句柄可能跨文件泄漏;同步机制为 `setInterval` 轮询(20/50ms)而非 02 §7.1 明文的「主动推送」,建议回写设计口径(轮询为 v1 形态)并在 M3 换事件推送时同步改测试;③ `AUTH_KEY = 'node_' + 'token'` 拼接式定义在 `gateway/src/ws.ts:12` 与 `node/src/gateway-client.ts:9` 重复,协议帧字段名应进 core 单一事实源(对照 impl plan §2「参数单一事实源」);④ `http.ts:121、127`:`GET/PATCH /v1/nodes/me` 返回完整 NodeRecord 展开(含 `keys` 全史与序列化为 `null` 的 `tokenHash`),建议响应白名单裁剪——测试现只断言「无 tokenHash 属性」,对 `keys` 泄露无感知。

---

## 亮点

1. **联调层时序纪律好**:`trio.spec` 全程 `waitFor` 轮询断言、无一处固定 sleep;`wait.ts` 带超时兜底最后一次复查——为 M3.1 离散事件仿真打了正确底子。
2. **ACL 纯函数 + 确定性断言落到了实处**:`evaluateUplink` 与引擎双路同判用例(acl-core:71-81)、I-13 钦定的「伪造 to.team_id 必须被拒绝」配对用例(acl-core:85-94)、目录 epoch 缓存「换队后旧 team 立即不可达」用例(acl-core:146-157)均与 02 §7/§7.1 逐条对得上。
3. **回声分级的「静默无回执」半边覆盖扎实**:A0/过期/断连后 uplink 三条静默路径都显式断言了 `ack === undefined`,A6 的静默/可见分界在 core 层是清晰的。
4. **补投的「过期剔除 + 审计」与 aid 不暂存在 core 级测试完整**(acl-core:161-190),exp 虚拟时钟用例把 D24 漂移预算判向也钉住了。
5. **错误信封契约测试有区分度**:invalid/expired/used 三态分用例断言到 `code` 与 httpStatus(directory.spec:23-53),node_suspended 与 node_revoked 的错误码分流有覆盖——符合评审 I-23③「人话错误呈现」方向。
6. **outbox「同 msg_id 重发」的骨架正确**:`MemoryOutbox` 按 msg_id 键控、`save` 递增 attempts、routing.denied 终局移除的语义注释清楚,trio R11 主路径真实演练了「未获回执保留 → 重连 → 清理」。

## 开放问题(评审已知悉,不重复展开;仅标注与本评审的交界)

- **网关集群化(02 §12.1)**:enroll 原子性「单进程外」的并发语义、`enroll_token_in_flight` 的启用时点,均属该开放问题——本报告仅以 QA-15① 要求标注死字母口径,不要求 v1 实现。
- **owner 账号体系(纪要 §8.7)**:ownerAuth 为产品侧接入点,v1 API-only 缺省拒绝是正确的;本报告 QA-7 只要求把「缺省拒绝」从空转用例变成真断言。
- **跨队 grant、目录多副本**:v1 未做,无 v1 缺省行为风险,未列意见。
- 已按「v1 缺省行为风险」单独指出的三处:限流缺省关闭(QA-6)、半开连接无 keepalive(QA-4)、revoked 节点收暂存(QA-14)。

## 收口建议

进入收口前须完成:QA-1(修复 + 负例集)、QA-2(补投接线 + 端到端用例)、QA-7(P12 用例重写)为 P0;QA-3/4/5/9 在 M3 接真实网络前必须落(P1);QA-6/8/10/11 为 M2 修订批次(P1);QA-12/13/14 随批(P2)。修订后按各条建议用例做针对性复验,并同步更新 R-MATRIX 恢复追溯账本可信。