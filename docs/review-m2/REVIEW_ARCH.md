# 群龙 M2 评审意见——架构与演进视角

> 评审对象:M2「中心三件」`packages/registry`(directory/errors/http + test 17 项)、`packages/gateway`(types/acl/mailbox/core/ws + test 19 项)、`packages/node/src/gateway-client.ts` 与 `outbox.ts`;对照 `docs/testing/R-MATRIX.md`。
> 设计基线:`QLONG_DESIGN_NOTES.md`(纪要)、`QLONG_DESIGN_01_MSG_PROTOCOL.md`(01)、`QLONG_DESIGN_02_REGISTRY_TRUST.md`(02)、`QLONG_DESIGN_03_CAPABILITY.md`(03)、`QLONG_IMPL_PLAN.md`;并对照 `docs/review-m1/` 已决事项(M1 三项 blocker 已修,见亮点 8)。
> 评审视角:仅架构与演进——分层一致性(P2/IO-free)、单实例假设清单、snapshot 规模边界、M3 接口就绪度、依赖方向。协议细节、安全渗透、测试覆盖度由其他角色评审。

## 结论 verdict

**有条件通过**。

M2 的分层骨架是对的:`GatewayCore` 严格 IO-free(无 `node:*` 依赖、时钟注入、假连接可测),ACL 裁决是纯函数并与引擎双路同判,依赖方向 core←{registry, gateway, node} 无一反向,gateway 不依赖 registry(接口注入倒置)——P2「换通道不换语义」在中心侧得到忠实兑现。但 ws 适配器(真实 IO 面)存在 **2 项 blocker**:① 同 node_id 重连竞态会把新连接从连接表/套接字表中误删,节点自认在线而网关静默丢弃其一切上行,无自愈直至 TCP 断开;② 上行入口不做信封 schema 校验,单条畸形信封即可让网关进程崩溃。二者都是 M3 真实链路第一天就会踩中的路径。此外 11 项 major 集中在:目录-网关一致性仍是同进程对象引用 + 50ms 全量轮询(02 §7.1 的「主动推送」未跨进程化)、收件箱补投未在适配器接线、resume/join 无 HTTP 端点、registry 无持久化、outbox 无持久化与周期退避重发、轮换双因子与 enroll 限流缺省关闭等——多数是「接线缺口」而非「方向错误」,修复面有限但**必须在进入 M3 前修毕并复验**,否则 M3 双机闭环会在传输接缝上系统性失真。

## 摘要

- **blocker ×2**:ws 适配器重连竞态致消息黑洞 + presence 失真无自愈(ARCH-1);网关上行无信封校验,畸形信封崩溃进程(ARCH-2)。
- **major ×11**:目录同步未跨进程化 + 全量轮询无增量位(ARCH-3);补投未接线(ARCH-4);authenticate 错误契约不匹配(ARCH-5);客户端生命周期(close 失效/重连风暴/无单飞)(ARCH-6);delivered 回执谬误与死连接无检测(ARCH-7);registry 安全件缺省关闭(ARCH-8);resume/join 端点缺失(ARCH-9);registry 无持久化(ARCH-10);outbox 无持久化 + 无周期退避重发(ARCH-11);A4 验签缺省放行(ARCH-12);M3 就绪缺口清单(ARCH-13)。
- **minor ×6**:P3 与 body.kind 的张力未明文化(ARCH-14);join 后连接身份滞留(ARCH-15);HTTP 面健壮性三则(ARCH-16);ws 面健壮性三则(ARCH-17);R-MATRIX 未随 M2 更新(ARCH-18);包边界与依赖声明(ARCH-19)。
- **nit ×1**:杂项(ARCH-20)。

---

## 问题清单

### ARCH-1|blocker|ws 适配器重连竞态:旧连接 close 误删新连接条目,消息黑洞且无自愈

- **位置**:`packages/gateway/src/ws.ts:59-60`(authed 后 `sockets.set(nodeId, ws)` 覆盖旧值、`core.connect` 覆盖连接表)、`ws.ts:74-79`(close 回调无条件 `sockets.delete(nodeId)` + `core.disconnect(nodeId)`)、`packages/gateway/src/core.ts:72-78`(connect/disconnect 以 nodeId 单键,不比对 connId)。
- **问题**:同一 node_id 二次认证(TCP 半开后的典型重连:客户端早已重连成功,旧连接超时才触发 close)时序为:新连接 `connect`+`sockets.set` → 旧连接 close → `sockets.delete(nodeId)` 与 `core.disconnect(nodeId)` 把**新连接的条目删掉**。此后该节点一切上行在 `core.ts:106-111` 因「无认证连接」被静默丢弃(无回执,客户端 outbox 重发同 msg_id 仍被静默),一切下行因 `ws.ts:69` 找不到 socket 而落入收件箱;而节点侧 socket 仍 OPEN、自认在线。系统无任何自愈路径,直到传输层最终断开触发一次真正的重连——期间该节点的 result/progress/cancel 全部滞留,若为 aid 场景则直接 `offline_not_stored` 误改派。同时 presence(网关连接态,02 §8/D17 的「在线权威」)对该节点持续误报离线,派单候选判断随之失真。
- **依据**:01 §9「在线投递:网关按 `to.node_id` 直接推送」与「投递语义:至少一次」;02 §8「权威来源 = 通讯网关的连接态」、D17;A3(连接认证后节点应处于可服务态)。
- **建议**:① `close` 回调与 `core.disconnect` 增加 connId/实例比对:仅当 `this.sockets.get(nodeId) === ws`(及 `connections.get(nodeId)?.connId === conn.connId`)时才删除;② 新连接认证成功时主动踢旧:向旧 socket 发 `closing` 并 `close(4000, replaced)` 后再登记新连接,使「一节点一连接」成为显式不变量;③ 补一条确定性测试:connect(A2) → close(A1) → 断言 A2 的 uplink 正常路由、presence 为在线。

### ARCH-2|blocker|网关上行入口无信封 schema 校验:单条畸形信封未捕获异常崩溃网关进程

- **位置**:`packages/gateway/src/ws.ts:64-72`(`frame.envelope` 为 object 即直接 `core.uplink`,无 `validateEnvelope`);`packages/gateway/src/core.ts:113-121、144、152`(`envelope.to.node_id`、`envelope.body.kind` 等直接解引用);对照发送侧 `packages/node/src/gateway-client.ts:88-89` 是做了 `validateEnvelope` 的。
- **问题**:适配器把「信封合法」当作上游已保证的契约,但契约从未在接收端兑现:已认证节点发送 `{"frame":"envelope","envelope":{"msg_id":"x"}}`(缺 `to`/`body` 等)时,`core.ts` 解引用 `undefined` 抛 TypeError,异常沿 ws message 监听器直冲 uncaughtException,**网关进程整体崩溃**——单条消息打死全体节点的中心。即便不崩(宿主恰好有全局兜底),畸形信封也会绕过 ACL 语义(A0 依赖 `from` 存在、A1 依赖 `to` 存在)进入不可预测分支。网关不验签(P3/02 §7)是对的,但「信封结构合法」是路由执法的前提,与验签无关。
- **依据**:01 §3.1 信封字段表(v1 信封契约);02 P12「查不到、验不了 → 拒绝」的失败关闭精神;01 §3.3.4 回声分级(结构非法属未认证类,应静默丢弃 + 审计)。
- **建议**:① `ws.ts` 在调用 `core.uplink` 前先 `validateEnvelope(env)`(core 包现成函数,`allowMissingSig` 口径需明确:网关层应允许缺 `sig` 但要求头字段齐备),失败 → 静默丢弃 + `makeAudit` 审计,不给任何回执;② `core.uplink` 入口加一次防御性形状断言(核心也不信任适配器),与 ① 双保险;③ 补畸形信封用例:缺 `to`/缺 `body`/`body` 非对象/`from` 缺失,断言网关存活且审计落账。

### ARCH-3|major|目录-网关一致性未跨进程化:同进程对象引用 + 50ms 全量轮询,「主动推送」与规模边界双缺位

- **位置**:`packages/gateway/src/ws.ts:20-23`(`RegistryLike` 进程内接口:`snapshot()`/`getNode()`)、`ws.ts:89-107`(`startRegistrySync` 默认 50ms 全量轮询;`syncRegistry` 接收目录快照 + 状态回调)、`packages/registry/src/http.ts`(全文件无目录快照/增量/订阅端点)、`packages/registry/src/directory.ts:345-357`(`snapshot()` 全量:全部节点的全部历史公钥)、`packages/gateway/src/core.ts:53-69`(`setDirectory` 每次清空 dirCache;lookup 为 O(n) 数组扫描)。
- **问题**:02 §7.1 定案「目录变更 bump epoch 并**主动推送**到各网关实例」,其机制保证目标是「换队后旧 team 立即不可达」。当前实现是:① registry 与 gateway 只能同进程(直连对象引用),跨进程部署时目录通道**不存在**——registry HTTP 面连快照端点都没有;② 通道形态是 50ms 全量轮询而非推送,suspend/revoke 断连的时效也被绑在轮询间隔上(trio 测试里 20ms 定时器本质上是把进程内轮询伪装成推送);③ 规模边界:`snapshot()` 携带全部节点的全部 key 条目,1 万节点量级 × 每秒 20 次全量序列化不可持续,`dirCache` 因每次 `setDirectory` 清空而形同虚设,`lookup` O(n) 扫描随目录线性恶化。这三点互为表里:接口不跨进程 → 只能靠轮询 → 轮询只能全量。
- **依据**:02 §7.1(Directory epoch 推送,评审 I-45)、§9「网关是目录变更的订户」、§12.5(目录多副本与高可用为开放问题——但**单实例的通道协议**不属于该开放问题的豁免范围,它是 M3 双机真实链路的前置件)。
- **建议**:① registry HTTP 面补网关专用目录端点:`GET /v1/directory?since_epoch=` 返回 304 或增量(新增/变更/删除节点列表,按 epoch 分段),并明确「增量不可得时回退全量」;② `GatewayCore.setDirectory` 支持合并式更新(保留 dirCache 的逐节点 epoch 比对语义,`lookup` 改 Map 索引);③ 推送形态可以后置(轮询 + 短间隔在单实例下等效),但**通道必须跨进程化**,并给 `syncIntervalMs` 一个明确的部署参数与文档口径;④ enroll/join/rotateKeys 的 epoch 推进与 suspend/revoke 一样通过快照携带,不再需要独立管理事件——但 join 断连语义另见 ARCH-15。

### ARCH-4|major|收件箱补投未在适配器接线:auth_ok 之后无人调用 takeInbox,生产链路补投不可达

- **位置**:`packages/gateway/src/ws.ts:47-62`(认证成功分支只发 `auth_ok`,无补投调用;全文件无 `takeInbox` 引用);`packages/gateway/src/core.ts:164-175`(`takeInbox` 仅存在);`packages/gateway/test/acl-core.spec.ts:171-182`(补投由测试**直调 core** 验证)。
- **问题**:02 §8「离线暂存 + 重连即补投」与 impl M2.2 验收「收件箱补投 + exp 兜底」的语义在 core 层实现了、测试了,但唯一的真实 IO 面(ws 适配器)没有调用它:真实部署中节点重连后,收件箱里的暂存消息**永远不被投递**,直到下一条新消息触发 uplink 才顺带走在线路径。被测试直调掩盖的接线缺口与 M1 阶段 ARCH-1(恢复不重挂定时器)是同一类病:核心语义正确、生产无人调用。M3 的「长期离线节点上线 → 批量过期 offer 整批 reject(expired)」必测场景依赖这条线。
- **依据**:02 §8(重连即补投)、01 §9(离线暂存语义)、impl M2.2 验收、impl M3.2(R2 批量过期场景)。
- **建议**:① `ws.ts` 认证成功、发送 `auth_ok` 之后即 `core.takeInbox(nodeId, now)`,deliver 逐条下行,审计照发;② 投递失败的条目回滚入箱(见 ARCH-7 的发送失败处理);③ trio 补一例:离线收 project 单 → 重连 → 断言补投到达 + 过期项被剔除并审计。

### ARCH-5|major|ws 适配器 authenticate 错误契约与 registry.authByToken 不匹配:直连注入会以未捕获异常崩连接/进程

- **位置**:`packages/gateway/src/ws.ts:16-18`(`authenticate` 契约:「无效 = 返回 undefined」,返回 `{status}` 由适配器判断)、`ws.ts:52-56`(调用点无 try/catch);`packages/registry/src/directory.ts:231-239`(`authByToken` 对无效/suspended/revoked 一律**抛 ApiError**);`packages/gateway/test/trio.spec.ts:34-41`(测试侧自行 try/catch 包装后返回 undefined)。
- **错误契约冲突**:ws 适配器期望「返回 undefined 表示拒绝」,而注册中心自然候选实现(`registry.authByToken`)是抛错风格。宿主直接把 `authByToken` 注入 `authenticate`(最自然的接线)时,suspended 节点重连(suspend 后的常态行为)会抛 ApiError——在 message 监听器里成为未捕获异常(同 ARCH-2 的崩溃路径)。trio 测试的包装函数掩盖了这一契约断裂,等于把防御责任悄悄转嫁给了每个未来宿主。
- **依据**:02 A3(连接认证)、A6(suspend 后连接应收到语义拒绝,而非打崩网关);impl §5「实现偏离不静默」。
- **建议**:① `ws.ts` 在 `authenticate` 调用点 try/catch,任何抛错按「无效凭证」处理 → `close(4003)`;② 或者改 `authenticate` 契约为「返回 `{ok:true,...} | {ok:false, reason}`」,把两种风格都接住;③ 在 `WsGatewayOptions` 的 TSDoc 里钉死错误语义;④ trio 增加一例「注入会抛错的 authenticate」断言网关存活、连接被 4003 拒绝。

### ARCH-6|major|GatewayClient 生命周期缺陷:close() 后 pending 重连定时器复活客户端;重连风暴无单飞守护;suspend 节点被永久重连骚扰

- **位置**:`packages/node/src/gateway-client.ts:44-46`(`open()` 首行 `this.closedByUser = false`)、`110-114`(`close()` 只置位并关闭当前 ws)、`176-186`(`scheduleReconnect` 的 setTimeout 句柄未保存、可重入)、`71-79`(close 事件每次都 `scheduleReconnect`)。
- **问题**:① 用户调用 `close()` 时若存在 pending 的重连定时器(断线后立即关闭的常态),定时器到点执行 `open()` 会把 `closedByUser` **重置为 false**,客户端违背用户意志复活并重连——节点停机时表现为幽灵客户端反复打注册中心/网关;② 无「单飞」守护:多次 close 事件(网络抖动、认证失败循环)可排布多个并发重连,叠加服务端 ARCH-1 的覆盖竞态进一步恶化;③ 语义 close code 无差别:`onClose(4001/4002/4003)` 只是回调,客户端对 4001(suspended)/4002(revoked)/4003(认证拒绝)照常指数退避重连——被 owner 暂停的节点会以 ~1.6s 封顶间隔永久重连(auth 必拒 → close → 再连),形成对中心的骚扰面;02 A6 要求的「节点本地呈现『本机已被团队 owner 暂停』」无承载。退避公式 `25×2^min(n,6)` 实际封顶 1600ms,注释声称的 5s 封顶不可达。
- **依据**:02 A6/D28(close code 是给节点看的反馈信道);01 R11 降级面声明(中心不可达时的行为应可控);impl M3.2(断线重连语义)。
- **建议**:① 保存重连定时器句柄,`close()` 清除之;`open()` 不重置 `closedByUser`,或拆分 `open()`/`resume()` 语义;② 重连前检查 `state === closed` 与在飞连接标志,保证单飞;③ 对 4001/4002/4003 停止自动重连(4001 可在收到 owner resume 信号或人工干预后显式重试),回调里给出语义化状态(suspended/revoked/unauthorized)供本地呈现;④ 修正退避封顶与文档一致(建议生产基数提到秒级,25ms 仅测试用)。

### ARCH-7|major|在线投递的 delivered 回执谬误:发送失败/半开连接下仍回 delivered,至少一次在在线路径存在丢失窗口;无 ws 保活检测

- **位置**:`packages/gateway/src/ws.ts:68-71`(deliveries 逐条 `safeSend`,失败被吞,`core.uplink` 已定 delivered 回执)、`ws.ts:109-115`(`safeSend` catch 后注释「由对端 outbox 重发兜底」——该兜底对**接收方**不存在)、`ws.ts`(全文件无 ping/pong/terminator 保活);`packages/gateway/src/core.ts:145-148`(在线判定即 delivered)。
- **问题**:`safeSend` 的注释把可靠性责任推给「对端 outbox」——但 outbox 是**发送方**的机制(R11),接收方从没收到消息就无从去重/兜底;而发送方此刻已收到 `delivered` 回执,按 R11 不会重发。结果:目标 socket 存在但对端半开(或 send 同步失败)时,消息既未送达也不在收件箱,回执却说 delivered——**P4「至少一次」在在线投递路径被静默打破**。ws 层无 ping/pong 使半开连接长期滞留连接表(presence 假在线),进一步放大该窗口。01 §9 说回执「不参与可靠性」是指不构成第二真相源,不豁免「回执不得说谎」。
- **依据**:01 §9 投递语义(至少一次)、P4;02 §8(连接态权威——死连接污染 presence);R11(回执驱动发送方停止重发)。
- **建议**:① deliveries 投递改为「发送入缓冲成功(ws send 回调确认)才计 delivered;失败/离线即时回退 `inbox.offer` 并改发 `queued` 回执」;② ws 层加 ping/pong 保活(如 30s 间隔、两次未回应即判死),死连接触发 disconnect 使 presence 回落、后续消息走收件箱;③ 补赛跑用例:uplink 时目标恰在断开边缘,断言回执与实际投递一致、消息不丢。

### ARCH-8|major|registry 安全件缺省关闭:密钥轮换缺省单因子、enroll 缺省不限流——安全缺省违反设计基线

- **位置**:`packages/registry/src/http.ts:14-15`(`verifyRotationSig` 可选,注释自认「未配置 → 仅 token 认证放行」)、`http.ts:148-163`(未配置即不构造 verifier)、`http.ts:17、83-96`(`enrollRatePerMinPerIp` 未配置 = 完全不限流);`packages/registry/src/directory.ts:262-274`(`rotateKeys` 的 `verifyRequestSig` 参数可选,undefined 即跳过)。
- **问题**:① 02 §6.1 定案常规轮换为「token 认证 + 当前私钥对请求签名」双因子,理由是「任一因子单独失效即无法自助轮换」——node token 在每个 API 调用上传输,泄露概率远高于私钥;当前缺省部署下,持有泄露 token 的攻击者可直接 `POST /v1/nodes/me/keys` 换公钥,**静默接管节点的责任身份**(此后可伪造该节点全部签名),正是双因子要挡的场景。② 02 §9/D30 的入网防滥用基线(IP 限流)在缺省配置下不生效,开放注册滥用面(02 §10「提高成本但不杜绝」的前提就是限流存在)失守。两处的共同模式是「安全可选件,缺省关」——与 P12「失败关闭」的精神相反,且 host 层(如 CLI)目前并未强制配置。
- **依据**:02 §6.1(评审 I-46)、§9 限流与配额(评审 I-16)、D30、P12。
- **建议**:① `verifyRotationSig` 未配置时轮换端点直接 503(`owner_auth_unconfigured` 同款失败关闭语义),或至少在返回体/文档中显式降级声明并由宿主显式 opt-in;② 限流给出非零缺省值(如 10/min/IP,可配大),`enrollRatePerMinPerIp: 0` 才表示关闭;③ 补「未配置即拒绝」的契约测试(http.spec 现有 P12 用例是伪断言,见 ARCH-20)。

### ARCH-9|major|resume 与 join 无 HTTP 端点:suspend 后无法恢复、认领流程只有进程内形态,API 面与目录能力不对齐

- **位置**:`packages/registry/src/http.ts`(全文件路由表无 `/resume`、无 `/join`;端点仅 enroll/nodes.me*/pubkey/suspend/revoke/teams.*);对照 `directory.ts:285-291`(`resume` 已实现)、`directory.ts:213-226`(`joinTeam` 已实现);`packages/registry/test/http.spec.ts:107`(测试也只能绕过 HTTP 直调 `registry.resume`)。
- **问题**:① 02 §5.2 节点状态机是 `active ⇄ suspended → revoked`,suspend 有 owner 端点而 resume 没有——owner 误暂停(或 runbook 演练)后**没有任何 API 路径恢复**,内存态下重启进程可意外「恢复」,接入持久化(ARCH-10)后将永久卡死:状态机设计断了一半。② join 是 02 §4.2 定案的认领双形态(换队/重装恢复),评审 I-48 的完整流程,目录层已实现但 API 面缺失——「先装后认领」的产品路径当前只能进程内演示;02 §4.2 孤儿 team GC、§10 认领流都以 join HTTP 存在为前提。③ 这两处缺口会在 M3「真机 enroll 入网」(A1)之后第一次真实暴露。
- **依据**:02 §5.2(状态机)、§4.2(join 双形态,评审 I-48)、纪要 §8.7(runbook 需要等价操作路径)、§9(API 面 v1 契约——设计表格本身也漏列 resume/join,应一并回写)。
- **建议**:① `POST /v1/nodes/{id}/resume`(owner 鉴权,返回与 suspend 对称的语义;目录层已就绪);② `POST /v1/nodes/me/join`(node token + enroll token 双因子,透传 joinTeam,换队前置确认与「旧 team 立即不可达」提示按 02 §4.2);③ 同步回写 02 §9 端点表,补齐 resume/join 两行。

### ARCH-10|major|Registry 无持久化接口:注册中心 = 事实 CA,重启即全网身份蒸发,演进位缺失

- **位置**:`packages/registry/src/directory.ts:103-110`(teams/nodes/enrollTokens/nodeByTokenHash 全为内存 Map,无存储抽象、无加载/落盘钩子)、`directory.ts:1-6`(文件头注释只声明了并发边界,未声明易失边界)。
- **问题**:注册中心在信任模型里是「事实 CA」(02 §10,D29)——node token、公钥目录、enroll token 消费记录全部只存在于进程内存。进程重启 = 所有节点凭证作废 + 所有 team 归属蒸发 + enroll 审计记录消失:双机闭环里 registry 与节点分别部署(M3 的「双机」含 registry 宿主重启、升级、崩溃的常态),当前实现使 A1 验收状态在第一次 registry 重启后即不可复现。更深一层是演进位:目录层把存储形态焊死在 Map 上,后续接 sqlite/文件持久化需要重写整个类而非注入存储适配器——与 M1 阶段 checkpoint/store 的抽象先行形成反差。
- **依据**:02 §10(注册中心 = 事实 CA 的定性)、D29;impl §1 A1(真机入网验收);impl §2(持久化选型)。
- **建议**:① 最小改造:抽出 `RegistryStore` 接口(快照加载 + 变更落盘),缺省提供 `MemoryStore`,进程内可换 `JsonFileStore`(v0.1 足够)——接口先立,避免后续 breaking;② 或在文档显式声明「M2 registry 为易失实例,重启 = 全网重新 enroll」并把该限制写进部署前提;③ enroll token 消费记录(consumed_at/used_by)至少要随持久化落地,它是 02 §4.3 的审计凭证。

### ARCH-11|major|outbox 实现缺口:缺省 MemoryOutbox、无持久化实现、无周期退避重发——R11 的三个组成缺了两半

- **位置**:`packages/node/src/outbox.ts:16-33`(仅 `MemoryOutbox`,无 sqlite/file 实现);`packages/node/src/gateway-client.ts:40`(`opts.outbox ?? new MemoryOutbox()` 缺省)、`gateway-client.ts:103-108`(`flush` 仅在 auth_ok 与手动调用时执行)、`gateway-client.ts:87-100`(`send` 超时后信封滞留 outbox,无任何定时重发)。
- **问题**:① 01 R11/D26 明文「关键消息发送方本地**持久化**(outbox)」——当前唯一实现是内存版,进程重启即丢 result/fail/cancel,恰是 R11 要保护的消息类;`OutboxStore` 接口抽象是对的,但持久化实现缺位且缺省值选了最弱形态,与 02 §10「网关作恶/中心不可达」的威胁模型不匹配。② R11 的重发语义是「未获回执**按退避重发**」,当前实现只在重连成功(flush)时重发:连接保持但回执丢失(上行方向丢帧、网关回执被吞)的场景下,关键消息无限期滞留 outbox——直到下一次断线重连才有机会重发。trio 的「R11 outbox 重发」用例(重连触发)恰好只覆盖了实现有的那一半。
- **依据**:01 §6 R11、D26;02 §10(网关作恶:丢弃/延迟——回执丢失正是其子场景);impl M3.2(outbox 重发验收)。
- **建议**:① 提供持久化 `OutboxStore` 实现(可复用 node 包既有 JsonFileStore 形态),并在 GatewayClientOptions 文档声明「生产必须注入持久实现」;② 客户端增加周期性 flush 定时器(如 2s 起、指数退避、封顶 30s,仅在 authed 态生效、有 pending 时才跑),时钟可注入以便测试;③ 补「连接保活但回执丢失」用例:断言 outbox 条目按退避被重发且同 msg_id。

### ARCH-12|major|A4 入站验签缺省放行:v1 链路的签名防线(节点侧唯一执法点)缺省缺位

- **位置**:`packages/node/src/gateway-client.ts:16-17`(`verifyInbound` 可选钩子)、`gateway-client.ts:160-164`(`verify` 为 undefined 时直接 `onEnvelope(env)` 交付)。
- **问题**:02 §7 的执法分层是「网关管该不该路由(不验签),节点管是不是本人(验签 + 复核)」——D16/D11。v1 经网关链路中,**节点侧验签是签名体系的唯一现役执法点**;当前缺省配置(不传 verifyInbound)下,任何能建立连接的信封(同队被攻陷节点、伪造 body 的中间形态)都绕过签名直达 `onEnvelope` 回调。A0 钉扎只保证 from.node_id 与连接一致,不保证「消息确由该私钥签发」——责任归属(01 §3.3「信封签名解决节点间的责任归属」)在缺省链路上整体失效。trio 测试显式注入了验签钩子,掩盖了缺省行为;02 §10「团队内成员机器被攻陷 → 无(消息面)」的缓冲带之一 A4 也因此落空。
- **依据**:02 A4/D11/D16、P10(双重执法——主执法点 v1 不验签时,辅执法点是唯一防线)、01 §3.3。
- **建议**:① `verifyInbound` 缺省改为「未配置 → 不交付、计数 + 审计(或连接级告警)」,把「显式跳过验签」变成 opt-in(测试模式);② 或至少在 GatewayClientOptions TSDoc 与部署文档标注红色警告;③ M3 接线时按 ARCH-13 提供完整验签链实现,避免宿主因为「配不上」而长期走缺省。

### ARCH-13|major|M3(双机闭环)接口就绪度:gateway-client 与状态机世界之间的适配层整体缺失——具体缺口清单

- **位置**:`packages/node/src/gateway-client.ts`(只到 `onEnvelope`/`onAck` 裸回调为止)、`packages/node/src/local/harness.ts:1-5`(注释承诺「正式传输层替换 deliverTo* 实现,状态机不动」)、`packages/node/src/wire.ts`(Outbound 形态)、lead/executor 状态机入参(`lead.onMessage(type, fromNode, attempt, body, now)`、`executor.onOffer({from, task_id, attempt, msg_id, body, now, exp})`)。
- **问题**:M2 交付了「协议客户端」,但 M1 承诺的「换传输、状态机不动」缺的正是两者之间的**装配与接线层**,以下逐项当前不存在:
  1. **出站信封装配器**:`LeadAction/ExecAction` 的 `Outbound`(type/task_id/attempt/body)→ 完整 `EnvelopeV1`(msg_id/ts/exp/from{node_id, team_id, key_epoch}/to/trace/reply_to/sig)——节点身份、签名密钥、trace 上下文的注入点不存在;R11 关键消息(result/fail/cancel/accept/reject)自动入 outbox 的「关键发送」包装不存在。
  2. **入站适配器**:`EnvelopeV1` → 状态机入参的映射(含 `(task_id, attempt)` 关联,M1-20 的 `onStaleReject` 参数化若未随本轮修复则在此处撞墙);A5 复核(钉扎后跨队静默丢弃)的宿主侧落点。
  3. **节点密钥目录**:`(node_id, key_epoch) → pubkey` 本地缓存 + **TOFU 首连永久钉扎 + 变更告警**(02 §10,I-17②)+ **纪元现势校验**(02 §6.2:缓存命中且 epoch == 目录当前纪元才通过,否则回源 `GET /v1/nodes/{id}/pubkey`)+ 历史纪元查取(收件箱补投旧 epoch 消息验签)。trio 测试用 `registry.lookupPubkey` 每封回源,是性能与语义双重简化,不是可部署形态。
  4. **registry HTTP 客户端(node 侧)**:enroll(stdin token)、通讯录查询(派单候选,`?caps=` 过滤)、pubkey 查询、caps/load 上报(M4)——node 包目前只有 ws 客户端,HTTP 面零封装。
  5. **回执 → 改派触发**:`rejected(offline_not_stored)` → 牵头方即时改派(评审 I-11 的机制支撑):`GatewayClient.onAck` 与 `LeadTaskMachine` 之间没有「对端不可达」输入动作。
  6. **时钟统一**:GatewayClient 的重连退避/ack 超时用真实 `setTimeout`/`Date.now`,状态机用注入 `now`——M3.1 离散事件仿真要求两者可被同一虚拟时钟驱动,client 的时钟不可注入。
  7. **审计贯通**:client 入站静默丢弃只有 `rejectedInbound` 计数,无 01 §11 事件(`sig_verify_failed` 等),A8「仅凭日志 + trace_id 还原」在节点网络层断链。
- **依据**:01 P2(换通道不换语义的实现承诺)、§11;02 §6.2/§10;impl M3.1–M3.3;M1 评审 ARCH-9(harness 接缝承诺)。
- **建议**:把上述 7 项立为 M3.0「传输适配」前置工作包(总量有限,但不清单化就会散落进各验收项反复返工):先定 `TransportAdapter` 接口(出站装配 + 入站分发 + 时钟注入 + 密钥目录注入),harness 的 `deliverTo*` 与 GatewayClient 都退化为该接口的两个实现;1/2/5 属纯装配可在单测闭环,3/4 需要 registry 面配合(ARCH-3/ARCH-9),6/7 顺带完成。

### ARCH-14|minor|EnvelopeHeadLite 携带完整 body:网关读 `body.kind` 与 P3「中心只见头」的张力未被设计明文化

- **位置**:`packages/gateway/src/types.ts:24-33`(`EnvelopeHeadLite` 含 `body: Record<string, unknown>` 与整个 `envelope`,注释自称「设计明文允许的唯一 body 访问」)、`packages/gateway/src/core.ts:151-153`(`envelope.body.kind` 决定暂存与否)。
- **问题**:01 §9 同时写明「网关不解析 body(P3),只看头做钉扎/路由/ACL/审计」与「aid 类不暂存」——而 aid/project 的区分只在 `body.kind`(01 §4.2),信封头无此信息:两条条款在设计文本内部就是冲突的,实现被迫选了「读 body.kind」并自注为「设计明文允许」。行为本身安全且必要,但 P3 是安全边界声明(审计只记头摘要、中心不可读任务内容),实现层对 body 的访问面必须在设计文档里有精确的许可边界,否则未来贡献者无法判断「网关还能不能碰 body 的其他字段」。
- **依据**:01 P3、§9(两处冲突条款)、02 §8(aid 不暂存,评审 I-11/I-53)。
- **建议**:按 impl §5「偏离回写」原则二选一:① 回写 01 §9/P3,明文「网关对 body 的唯一许可访问 = `task.offer.body.kind` 的相等性判断,不得记录、转发或参与审计」;② 更彻底:信封头增加投递提示字段(暂存决策所需信息移回头部),恢复网关零 body 访问——作为 v1.x 演进项记录。

### ARCH-15|minor|join 换队后既有连接不重钉扎:连接身份滞留旧 team,A0 的目录归属半边失效

- **位置**:`packages/gateway/src/ws.ts:59`(`teamId: node.team_id` 在认证时定格,此后不更新)、`packages/gateway/src/acl.ts:25-33`(A0 只比对连接身份,不比对目录现值)。
- **问题**:节点 join 换队后目录 epoch 推进,但其 ws 连接不重认证:连接表里 `teamId` 仍是旧 team。A0 的设计语义是「自报值与连接身份**及目录归属**不一致 → 拒绝」(02 §7 A0),实现只实现了连接身份半边——换队窗口内节点继续自报旧 team 也能过 A0(靠 A1 的 sender/to 锚定兜底拦截跨队,最终行为安全),但:连接身份与目录长期不一致的状态无检测、无修复路径;suspend/revoke 有语义断连,join 没有,三种目录变更的连接处置不对称。
- **依据**:02 §4.2(join 后旧 team 立即不可达)、§7 A0、§7.1(epoch 机制应覆盖 join)。
- **建议**:syncRegistry 时对在线节点增加归属比对:目录中 `team_id ≠ conn.teamId` → 断开(可复用 4001 语义或新增 4004「重新认证」),客户端收到后自动重连即完成重钉扎;并补 acl-core 用例锁定「换队后旧连接不能再以旧 team 自报通过 A0」。

### ARCH-16|minor|registry HTTP 面健壮性三则:限流桶泄漏、name 无唯一性校验、caps 格式错误静默清空;新参数未入单一事实源

- **位置**:`packages/registry/src/http.ts:75、83-96`(rate Map 只增不清,IP 无上限增长);`http.ts:124-127`(PATCH name 任意字符串,无 team 内唯一校验);`http.ts:133-139`(`body.caps` 非数组时传 `[]` → putCaps 按空集替换,把格式错误当成「清空全部能力」);`packages/gateway/src/mailbox.ts:11`(inboxCapacity=200)、`ws.ts:103`(sync 50ms)——M2 新增运行参数散落各处,未进 `packages/core/src/params.ts` 单一事实源。
- **问题**:① 限流桶按 IP 永久累积是慢性内存泄漏(IPv6 下更快);② 02 §3.1 定义 name 为「team 内唯一别名(网关寻址的人读形式)」,当前可重名,人读寻址语义失真;③ caps 是派单能力的「搜索索引」,一个 content-type 正确但结构错误的请求就把节点从所有能力查询中隐身,应属 4xx 而非成功清空;④ 「参数是配置,协议只锁字段与语义」(01 §10)——容量/间隔类部署参数至少要有归档位置与缺省值文档,否则集群化调参时无处下手。
- **依据**:02 §3.1、§9(错误契约精神);01 §10;impl §2(参数单一事实源)。
- **建议**:① 限流桶加惰性过期(容量阈值或定期清扫);② PATCH name 校验 team 内唯一(冲突 409);③ `body.caps` 非数组 → 400 bad_request;④ M2 参数(收件箱容量/目录同步间隔/限流缺省/退避基数)集中到 params 或独立 config 模块并回写文档。

### ARCH-17|minor|ws 适配器健壮性三则:未认证连接无超时无上限、maxPayload 未设、auth 前非 auth 帧静默忽略

- **位置**:`packages/gateway/src/ws.ts:37-63`(connection 回调:无认证超时定时器;未认证时收到非 auth 帧仅 return)、`ws.ts:36`(`new WebSocketServer({ server })` 未设 maxPayload)。
- **问题**:① 未认证连接可永久悬挂(不发 auth 帧),叠加无连接数上限,构成廉价资源占用面;② ws 默认不限制单帧大小,已认证节点可发送超大帧消耗网关内存(信封 MAX_BODY_INLINE 256KB 的协议上限在传输层无对应约束);③ auth 前收到非 auth 帧静默忽略不如直接 4003 关闭——快速失败能减少无认证悬挂连接的存活时间,也与 A6「未认证场景静默」不冲突(close 是传输层动作,不是消息回声)。
- **依据**:02 §9 限流与配额(防滥用基线的传输层延伸)、01 §10(MAX_BODY_INLINE)。
- **建议**:连接建立起 5–10s 认证超时,超时 4003 关闭;全局并发连接数上限(可配);`maxPayload` 设为 256KB + 帧封装开销余量(如 320KB);auth 前非 auth 帧直接 4003。

### ARCH-18|minor|R-MATRIX 未随 M2 实现更新:ACL 行仍「全部 🔲 M2」、R11 行仍「🔲 M3」,追溯账本落后于代码

- **位置**:`docs/testing/R-MATRIX.md:24-26`(「ACL(A0–A6)全部 🔲 M2」)、`:21`(R11「🔲 M3」)、`:19`(R9「🔲 M2」)。
- **问题**:M2 已交付 acl-core.spec(12 项:A0×3/A1×4/A2+管理断连×3/epoch×1/回执与收件箱×3)与 trio 联调(A1 正负向、A4 坏签名静默、A6 4001、R11 重连重发、A3 入网),R9 的一对一也由网关 ACL 与信封校验共同保证——矩阵仍是 M1 时点的承诺态。矩阵是「01 §6 每条规则可追溯到测试用例」的唯一账本(M1 评审 QA-28 同款问题),落后会误导 M3 排期(R11 的「重连重发」半边已测、「周期退避重发」半边没有——ARCH-11,矩阵不更新就无从看出这个残差)。另外 A4/A5(节点侧)的 trio 覆盖是「坏签名静默」,缺 A5 跨队静默的节点侧用例,矩阵更新时应如实标注。
- **依据**:01 §6;impl §5(R-矩阵持续维护);M1 评审 QA-28 先例。
- **建议**:ACL 表逐条(A0–A6)标注测试位置与覆盖残差(A5 节点侧补用例或标 🔲 M3);R11 行改「✅(重连触发)/🔲 M3(周期退避)」;R9 行闭环。

### ARCH-19|minor|包边界与依赖声明:gateway 测试跨包深引 node 源码;三个包 package.json 未声明 @qlong/core 与 ws 依赖;packages/testing 缺位

- **位置**:`packages/gateway/test/trio.spec.ts:8`(`import ... from ../../node/src/gateway-client.js` 跨包相对路径);`packages/{gateway,registry,node}/package.json`(均无 dependencies;gateway/node 源码 import ws,registry/gateway import `@qlong/core`,实际由根 package.json 兜底);impl §2 规划的 `packages/testing`(仿真、黄金样本、走查剧本)未建。
- **问题**:① 三方联调测试天然属于跨包集成,塞在 gateway 包并以相对路径深引 node 源码,使 gateway 无法独立构建/发布(M1 评审 ARCH-15/API-16 对 cli→node 同款问题的重演);② 依赖声明缺失在 pnpm 严格隔离(或任一包单独发布)时即刻断裂,当前靠「根依赖提升」的巧合工作;③ packages/testing 是 impl 规划的联调与走查剧本宿主,M3.1 仿真层、M3.3 剧本即 e2e 都要以它为家——现在不立,M3 时会继续往 gateway/test 里堆。
- **依据**:impl §2(工程骨架)、§5(里程碑门);M1 评审 ARCH-15(包边界工程化,已判 minor 未修)。
- **建议**:① trio 移入 `packages/testing`(顺手补建该包,deps 声明 @qlong/registry、@qlong/gateway、@qlong/node);② 三个包补 dependencies(workspace 协议);③ 若 exFAT 折衷仍在(M1-16),在 README 记录退出条件,避免折衷永久化。

### ARCH-20|nit|杂项五则:internal_error 游离于错误码联合、InboxStore.offer 返回值死逻辑、GatewayCore 字段重复初始化、node index 重复导出、joinTeam 类型断言与 P12 伪测试

- **位置与问题**:① `http.ts:33` 用字面量 `internal_error`,不在 `errors.ts` 的 `ErrorCode` 联合中(应补入码表,错误码表是 02 §9 契约的一部分);② `mailbox.ts:23` `return box.length >= this.capacity ? stored : stored` 两分支同值,要么实现 dropped_oldest 信号要么删返回值;capacity=0 时行为是「存 1 条」而非「不存」;③ `core.ts:41、49` 字段初始化 `new InboxStore(0)` 后构造器再 new 一次,删一处;④ `packages/node/src/index.ts:6、11` 重复导出 `driver.js`、`local/harness.js`;⑤ `directory.ts:225` 返回值类型断言 hack(签名应直接写全 `{team_id: string; old_team_id: string}`),`http.spec.ts:111-118` 的 P12 用例断言的是 `createRegistryServer.length`(函数形参数量)而非 503 行为,属伪测试(配合 ARCH-8 修复补真用例)。

---

## 亮点

1. **GatewayCore 严格 IO-free,P2 在中心侧真实兑现**:core.ts 无任何 `node:*` 导入,时钟(`now`)、目录(`setDirectory`)、连接表全部注入,acl-core.spec 用假连接 + 虚拟时刻做确定性断言;ws 适配器薄(124 行)且只做 IO——「核心可仿真、适配器极薄」的分层正是 01 P2 要求的形态,也让 M3 离散事件仿真可以直接复用 core。
2. **ACL 裁决纯函数化 + 双路同判**:`evaluateUplink` 是纯函数,acl-core.spec 同时从 core 引擎与纯函数两条路径断言同一裁决(「纯 ACL 裁决函数同判」用例),防止引擎与裁决分叉——这是 P10 双重执法思想在测试架构上的正确表达。
3. **依赖方向干净,倒置注入到位**:`core ← {registry, gateway, node}` 无一反向、无循环;gateway 不依赖 registry——`RegistryLike`/`authenticate`/`statusOf` 全部接口注入,为「registry 可替换实现、网关可独立部署」保留了正确的缝。
4. **目录 epoch + 逐节点缓存落后即重查的核心不变式有确定性测试**(acl-core「epoch 落后的缓存条目自动重查:换队后旧 team 立即不可达」),02 §7.1 的机制语义在 core 层成立——缺的只是跨进程通道(ARCH-3),不是语义。
5. **错误契约纪律好**:统一错误信封 + 码表单一事实源(errors.ts),owner 端点缺省 503 失败关闭(P12 的教科书式落地),enroll token 全程仅存哈希、明文只出现一次。
6. **trio 三方联调的验收形态正确**:真实 ws + 真实 Ed25519 签名 + 真实 Registry 实例打通 A0/A1/A2/A6/R11 主链路,坏签名在 B 侧静默计数(网关不验签、P3 保持)、4001 推送、outbox 重发(重连触发)都有端到端断言——M2.3 的「双进程仿真」虽实为同进程双 server,但骨架可以直接平移到真双进程。
7. **A3 首帧认证形态符合 I-16**:token 走首帧 JSON 而非 URL/进程参数,认证前不处理任何其他帧。
8. **M1 P0 修复真实落地**:`SingleNodeHarness.adoptRestoredLead` 按 `pendingTimers` 重挂定时器、drafting 态恢复后补发改派意图(harness.ts:100-113),M1-ARCH-1 blocker 的修复方向与 M1 评审建议一致。

## 开放问题(提请设计/委员会裁决)

1. **M3 部署形态先定**:registry 与 gateway 在 M3 双机闭环中是同宿主单进程(共享 Registry 实例,现状可用)还是跨进程(HTTP 通道,需 ARCH-3)?建议 M3 开工前一次定案——它决定目录通道、presence 注入、管理断连三条线的实现方式。
2. **suspend 后的重连抑制策略**(配合 ARCH-6):被暂停节点是永久停连等 resume 推送(推送不可达时依赖人工),还是低频退避(如 5min)保活探测?涉及 A6「本地呈现」的 UX 与 runbook 语义,建议随 owner 控制台最小面(纪要 §8.7)一并定。
3. **网关单实例假设清单**(供 02 §12.1 集群化同场设计的输入,本文仅在缺省行为风险处指出、不重复开放问题本身):连接表/收件箱/套接字表均进程内单份;node_id→单连接不变量;目录同步为进程内引用(ARCH-3);管理断连只及本实例(ARCH-3/ARCH-15);registry 内存存储(ARCH-10)。集群化时这五处全部是横切改造点,建议在 §12.1 设计文档中逐项对照本清单。
4. **「registry 快照增量」的契约形状**(配合 ARCH-3):按 epoch 分段的增量流 vs 每节点 lastModified 游标 vs 纯全量 + ETag/304——规模目标(02 §12.1 的节点数/消息速率)定案前不必实现,但 `snapshot(sinceEpoch)` 的接口形状建议 v1 先留位,避免 M3 期间二次 breaking。
