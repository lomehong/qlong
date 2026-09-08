# 群龙 M2 评审意见——接口与错误契约视角

> 评审对象:M2「中心三件」(packages/registry、packages/gateway、packages/node/src/gateway-client.ts + outbox.ts;registry/test 17 项、gateway/test 19 项全绿)
> 对照基线:`QLONG_DESIGN_NOTES.md`(纪要)、`QLONG_DESIGN_01_MSG_PROTOCOL.md`(01)、`QLONG_DESIGN_02_REGISTRY_TRUST.md`(02)、`QLONG_DESIGN_03_CAPABILITY.md`(03)、`QLONG_IMPL_PLAN.md`;并对照 `docs/review-m1/` 已决事项(M1 API-7 包边界问题在 M2 的再现单独指出,不重复 M1 已列条目)。
> 评审范围:仅接口与错误契约(02 §9 API 面逐端点、统一错误信封与错误码表、回执帧/routing.denied 契约、ws 帧协议演进口子、三方公共类型复用、客户端 outbox/ackWaiters/重连边界)。协议语义细则、安全渗透、测试充分性由其他视角队友评审。

## 结论 verdict

**有条件通过**。统一错误信封、enroll 原子消费与三态错误区分、ACL 纯函数裁决、回执帧形状与 01 §9 逐字对齐,契约测试断言 code 而非 message,质量扎实。但存在 1 项 blocker:ws 适配器连接关闭处理无身份核对,半开重连竞态下会误删新会话的路由表项(数据错乱级);另有 7 项 major 集中在「接缝契约」上——resume/join 有核心方法无 HTTP 端点、密钥轮换双因子在当前 API 形状下不可实现且缺省降级单因子、presence 回填通道缺失致 online 恒 false、load 过期语义未实现、回执终局性与「回执不参与可靠性」冲突、ws 帧协议无版本口子。这些接缝正是 M3 双机闭环要踩的地面,必须在 M3 接线前处置完毕。

## 摘要

M2 的「面」上契约(02 §9 端点清单、错误信封、回执帧)落地忠实,「缝」上契约缺失明显:①网关 ws 帧协议只存在于代码字符串里,无版本、无文档、AUTH_KEY 两处散写;②registry 的 resume/joinTeam 核心方法齐备却无 HTTP 端点,suspend 成为单向门,02 §4.2 的 join 前置确认在契约中无处表达;③密钥轮换请求体丢弃 ts/nonce,02 §6.1 的 `JCS({method,path,sha256(body),ts,nonce})` 签名要素无法装配,且校验器缺省关闭=双因子退化;④gateway 与 registry 之间只有「拉快照」没有「推 presence」,在线态字段恒 false;⑤客户端把一切 rejected 回执与 routing.denied 当终局清 outbox,与「回执仅诊断」的设计口径冲突。错误码表有两处语义过载与一处登记遗漏。

## 问题清单

### API-1|blocker|ws 连接关闭处理无身份核对:重连竞态下误删新会话,消息被静默丢弃或误入收件箱

- **位置**:`packages/gateway/src/ws.ts` L74-79(`ws.on('close')` 无条件 `this.sockets.delete(nodeId)` + `this.opts.core.disconnect(nodeId)`);L57-61(认证成功时 `core.connect`/`this.sockets.set(nodeId, ws)` 直接覆盖同 node_id 旧条目,旧 socket 未关闭);`packages/gateway/src/core.ts` L72-74(`connect` 同样按 nodeId 覆盖)。
- **问题**:同一节点先后建立两条连接(半开连接下客户端超时重连是 01 §9/纪要 §8.6 弱网场景的常态)时,新连接覆盖路由表,旧 socket 残留;旧 socket 此后 close,handler 删掉的是**新连接**的表项——新连接实际存活,但网关已认定节点离线:后续发往该节点的信封全部入收件箱而非在线投递,该节点自己的上行在 `core.ts` L106-111 命中「无认证连接」静默分支,**无任何回执**,发送方 outbox 重发永远等不到 ack,牵头方将误判 lost 并触发错误的回收/改派级联。属路由数据错乱 + 消息静默丢失。
- **建议**:①close handler 加身份核对:`if (this.sockets.get(nodeId) === ws)` 才执行删除;②新连接认证成功时主动关闭被替换的旧 socket(如 `close(4000, 'superseded')`),`GatewayCore.connect` 覆盖前返回旧 connId 供适配器收尾;③补「同 node 双连接 → 旧连接被替换后其 close 不得影响新会话」的确定性用例。

### API-2|major|GatewayClient 重连生命周期三处缺陷:双触发排程致重连风暴、close() 后幽灵重连、语义 close code 不终止

- **位置**:`packages/node/src/gateway-client.ts` L51-57(`ws.on('error')` 无条件 `scheduleReconnect()`)与 L71-79(`ws.on('close')` 同样无条件);L110-114(`close()` 不清除悬挂的重连定时器);L45(`open()` 把 `closedByUser` 重置为 `false`);L71-79(对 4001/4002/4003 不做区分)。
- **问题**:①ws 库在连接失败/异常断开时 `error` 与 `close` 相继触发,**每代失败排两个重连定时器**,各定时器再各自繁衍——网络中断期间连接尝试呈指数扩散,演化成对网关的自发型连接风暴(退避封顶 5s 只限单次间隔,不限并发定时器数量);②用户调用 `close()` 时悬挂的重连定时器未被取消,到点后 `open()` 把 `closedByUser` 重置为 false,**已主动关闭的节点被幽灵重连拉回在线**;③4001(suspended)/4002(revoked)/4003(认证失败)是管理语义码(02 §7 A6/D28:「复用连接做反馈信道,节点本地呈现『本机已被团队 owner 暂停』」),当前一律无限自动重连——被暂停节点以 5s 间隔持续撞网关认证面,既违背断连反馈语义,也在 suspend 大面积发生时(如 owner 清理失窃设备)放大为认证风暴。
- **建议**:①同一时刻只允许一个 pending 重连定时器(error/close 按连接实例判重去抖);②保存定时器句柄,`close()` 内清除,`open()` 不得重置 `closedByUser`(改为 close() 显式可 resume);③按 close code 分流:4001/4002/4003 终止自动重连并置显式状态(`'suspended'|'revoked'|'auth_rejected'`),交上层裁决是否重试。

### API-3|major|resume 与 join(换队)有核心方法无 HTTP 端点:suspend 成单向门,join 前置确认无契约位

- **位置**:`packages/registry/src/directory.ts` L285-291(`resume`)、L213-226(`joinTeam`);`packages/registry/src/http.ts` L190-203(仅 `suspend|revoke` 分支,无 resume、无 join);测试自证绕过:`packages/registry/test/http.spec.ts` L107 直接调 `registry.resume(nodeId)`。
- **问题**:①02 §5.2 节点状态机为 `active ⇄ suspended`(owner 手动**暂停/恢复**)→ `revoked`,resume 无端点意味着 suspended 是事实上的终态,owner 只能 revoke 了事,02 §6.1「设备丢失→suspend→重装 join→revoke 旧节点」的 runbook 前半段走不完整;②02 §4.2 定义 join(换队)「旧凭证 + 新 enroll token 双因子」且「join 前置检查:存在在途远端租约或未消费 offer 时要求**显式确认**」——`joinTeam` 无 HTTP 端点、函数签名亦无 confirm 参数,前置检查在 API 契约中无处表达;③02 §9 API 面表格本身也漏列 resume/join(设计表缺口),实现照表实现,缺口被原样继承。实现计划 §5 要求「实现偏离/设计缺陷回写文档」,此处两侧都要动。
- **建议**:①补 `POST /v1/nodes/{id}/resume`(owner 鉴权,触发 epoch 推进);②补 join 端点(如 `POST /v1/join`,Bearer 旧凭证 + 请求体 enroll token + `confirm?: boolean`),确认缺省 false;③同步回写 02 §9 API 表与 02 §4.2 的契约细节。

### API-4|major|密钥轮换的 §6.1 双因子在当前 API 形状下不可实现,且校验器缺省关闭=降级单因子(fail-open)

- **位置**:`packages/registry/src/http.ts` L14-15(`verifyRotationSig` 可选,注释自认「未配置 → 仅 token 认证放行」)、L148-163(请求体只解析 `pubkey`/`sig`,**丢弃 `ts`/`nonce`**,也不向校验器传 method/path/body 摘要);`packages/registry/src/directory.ts` L262-274(`rotateKeys`:`verifyRequestSig` 不传即整体跳过,且无 nonce 防重放存储)。
- **问题**:02 §6.1 明文轮换为「token 认证 + 当前私钥对请求签名」,签名要素 `signature_input = JCS({method, path, sha256(body), ts, nonce})`——当前端点请求形状根本没有承载 ts/nonce 的字段,校验回调也拿不到 method/path/body 摘要,**设计好的签名方案在这个 API 上装配不出来**;nonce 无服务端去重,同一签名请求可无限重放。更实质的是缺省行为:不配置 `verifyRotationSig` 时,node token 单因子即可替换身份公钥——token 泄露即被静默冒充,击穿 02 §10「密钥泄露」行依赖的双因子假设,与 P12「失败关闭」精神相反(安全端点缺省应拒绝而非放行)。
- **建议**:①把 `/v1/nodes/me/keys` 请求体契约钉死为 `{pubkey, sig, ts, nonce}`,http 层组装 `{method, path, sha256(body), ts, nonce}` 传入校验器(02 §6.1 要素逐项到位);②`verifyRotationSig` 未配置时缺省 403/503(fail-closed),如需过渡允许显式 `allowUnsignedRotation: true` 并打告警;③服务端对 nonce 做最小窗口去重;④测试同步补「带签名要素 + nonce 重放拒绝」用例。

### API-5|major|presence 回填通道缺失:网关连接态无处回流,目录 online 恒 false

- **位置**:`packages/registry/src/directory.ts` L109(`presence` 注释「由网关适配器注入」)、L334(`online: this.presence.get(...)`);`packages/gateway/src/ws.ts`(全文无任何 registry.presence 回写,`startRegistrySync` 只有 registry→网关单向拉取);`packages/gateway/src/core.ts` L71-74(`connect` 注释写「presence 置真」但无实现落点);唯一写入是测试直改:`packages/registry/test/directory.spec.ts` L136。
- **问题**:02 §8「在线权威 = 通讯网关连接态」、02 §9「目录 API 的 `online` 字段来自网关连接态」——但 gateway 与 registry 之间只实现了目录快照的**下行**同步,连接建立/断开的**上行** presence 通道完全没有(无回调、无 HTTP、无共享写入点)。真实部署中 `online` 恒 false,目录的在线态与 03 §5「online=false 的节点也返回」的派单判断、以及 v0.1 验收 A1「目录互相可见(**含在线态**、caps 摘要)」直接冲突;当前所有 online=true 的测试结论都建立在绕过生产代码路径的手工注入上。
- **建议**:最小契约:网关核心 `connect/disconnect/applyAdminEvent` 产生 presence 事件,适配器经宿主回调(`onPresence(nodeId, online)`)写回 `registry.presence`(单进程内闭环);跨进程推送形态留 02 §12.1 集群化开放问题,但「事件从网关核心发出」这个缝现在就该留,避免 M3 再拆一次。补一条「网关连上 → 目录 online=true」的三方联调断言。

### API-6|major|目录查询契约三处缺口:load 永不过期且未存判定基准、online 过滤被静默忽略、返回未按 node_id 稳定排序

- **位置**:`packages/registry/src/directory.ts` L316-319(`putLoad` 原样存快照,不记收到时刻)、L322-343(`listTeamNodes` 原样返回 `load`,无 ttl 判定;`for...this.nodes.values()` 按 enroll 插入序输出);`packages/registry/src/http.ts` L209-215(仅取 `caps` 参数,`online` 被忽略;L213 响应 `{nodes, next_cursor}`)。
- **问题**:①03 §3.3(D19)「过期 = 注册中心以**本地收到该快照的时刻** + ttl_ms 计时」、03 §5(P16)「动态档案过期时 `load` 返回 null」——当前接口把最后一份快照永远以新鲜形态返回,牵头方据此排序/派单即误判;且 receivedAt 未落存储,后续补 TTL 语义必须再改存储形状(接口形状现在就定型错);②03 §5 查询示例含 `online=true`,实现静默忽略未知参数,过滤悄悄失效,aid 单会持续打向离线节点制造 `rejected(offline_not_stored)` 抖动;③03 §5「返回按 node_id 稳定排序」未实现(现为插入序)——这不仅是展示问题:`next_cursor` 分页一旦启用,插入序随 enroll 顺序漂移,游标分页语义即被破坏;④响应形状 `{nodes, next_cursor}` 与 03 §5 示例(裸数组)不一致——包裹是对的(兑现 I-52 分页预留),但须回写 03 §5,否则下一份实现按裸数组来。
- **建议**:`putLoad` 记服务端 `receivedAt`,`listTeamNodes` 过期置 null;实现 `online` 过滤(或对未支持查询参数返回 400,拒绝静默吞);输出前按 node_id 排序并补排序断言;回写 03 §5 响应形状与 02 §9 的分页字段语义。

### API-7|major|一切 rejected 回执与 routing.denied 一律终局清 outbox,与「回执不参与可靠性」的设计口径冲突

- **位置**:`packages/node/src/gateway-client.ts` L130-139(任意 `ack` 即 `this.outbox.remove(ack.msg_id)`)、L141-151(routing.denied 注释「终局,不重发」并同样 remove);对照 01 §9(D26)「回执仅用于诊断与改派触发判定,**不参与可靠性**」、02 §7 A6(routing.denied「仅诊断与体验」)。
- **问题**:实现让诊断信号具备了终局丢弃可靠性语义的能力。具体丢失场景:节点 B 刚 enroll/join,网关目录快照尚未轮到(trio 默认 20-50ms,`ws.ts` L103-107),A 对 B 的首条消息命中 A1 `not_team_member` → rejected + routing.denied → 客户端清 outbox,**消息永久消失**且重发机制被回执短路;对 result/fail/cancel 这类 R11 关键消息,这意味着网关(或其滞后的目录)一句话就能终局否决端上可靠性。设计口径上 rejected 只有 `offline_not_stored` 被赋予「据此立即改派」的终局地位(01 §9,评审 I-11),其余 rejected/denied 未见终局授权;若实现有意收紧,按实现计划 §5 须回写 01 §9/A6 而非静默分叉。
- **建议**:①区分处置:`offline_not_stored` 终局(设计明文);`acl_rejected/not_team_member` 等建议保留在 outbox,由上层显式裁决(给 client 补 `dropFromOutbox(msgId)` 公开方法),或至少附 retryable 提示让上层可区分;②若坚持终局,回写 01 §9/A6 文档并在 trio 补「入网竞态窗口首消息」用例固化该行为取舍。

### API-8|major|ws 帧协议无契约载体:无版本字段、无协商、帧类型与 4003 只存在于代码,AUTH_KEY 两处散写

- **位置**:`packages/gateway/src/ws.ts` L12(`AUTH_KEY = 'node_' + 'token'`)、L40-80(帧类型 `'auth'/'auth_ok'/'envelope'/'ack'/'routing.denied'/'closing'` 与 close code 4003 全部内联字符串)、L64(非 envelope 帧静默落空);`packages/node/src/gateway-client.ts` L9(`AUTH_KEY` 第二份定义)、L116-174(同样的帧类型字符串第二套)。
- **问题**:ws 传输绑定是 M2 交付的核心接口,但其帧契约(帧型枚举、字段、错误行为、4003 语义)既不在设计文档(01 §9 只有信封与回执语义,无帧封装),也不在代码常量里,两端各写一份靠巧合对齐;`auth_ok` 不携带协议版本/能力位,01 §8「同主版本内新增字段必须被旧实现忽略、允许新增 type」的演进规则在传输帧层没有落点(旧端遇到新帧型静默忽略,连计数都没有);`AUTH_KEY`、`ack`/`routing.denied` 帧形状三处重复(与 API-9 同根)。v1.5 直连与未来任何第二实现都以这份不成文契约为准,现在是钉死它的最后时机。
- **建议**:在 `packages/core/src/frames.ts`(或新建 gateway-frames 模块)定义帧型联合 + 运行时守卫 + `AUTH_KEY` 常量 + `GATEWAY_FRAME_VERSION`,`auth`/`auth_ok` 携带 `v` 字段并做版本核对;网关对未知帧型回错误帧或至少计数审计;4003 连同 4001/4002 一起写进帧契约文档(建议 01 §9 增「帧封装」小节或独立 transport 契约文档)。

### API-9|minor|GatewayAck/RoutingDenied 三处重复定义,客户端帧解析零运行时校验

- **位置**:`packages/core/src/frames.ts` L7-25(GatewayAckFrame/RoutingDeniedFrame + `isGatewayAck`/`isRoutingDenied` 守卫)、`packages/gateway/src/types.ts` L35-44(GatewayAck/RoutingDenied 同形重复)、`packages/node/src/gateway-client.ts` L19-20 与 L131/L142(内联 `{ack_type: string; ...}` 弱类型 + `as unknown as` 强转,core 守卫零调用)。
- **问题**:同一 wire 契约三份定义必然漂移;客户端对入站帧不做任何形状校验,`msg_id` 缺失/非串时 `outbox.remove(ack.msg_id)` 以 `undefined` 调用(静默无操作),畸形帧无声吞掉。core 精心准备的守卫在唯一消费方处闲置,与 M1 评审 API-3/API-5「core 纯函数未被复用」是同一类病灶。
- **建议**:gateway/types.ts 改为从 core re-export(或类型别名),客户端解析先过 `isGatewayAck`/`isRoutingDenied`,不过则计数丢弃;onAck/onRoutingDenied 回调签名改用 core 类型。

### API-10|minor|收件箱容量溢出丢最旧无审计;`offer` 返回值 `'full'` 是死分支;queued 回执后溢出丢弃存在语义洞

- **位置**:`packages/gateway/src/mailbox.ts` L13-24(L23 `return box.length >= this.capacity ? 'stored' : 'stored'` 两分支同值,`'full'` 永不可达;L19-21 丢最旧无审计事件)、`packages/gateway/src/core.ts` L157(调用方不区分返回值)。
- **问题**:容量溢出是**静默消息丢弃**:发送方此前已获 `queued` 回执(R11 语义下获回执即停发),此后条目被挤掉,可靠性端上兜底(R11)与网关过期清理(01 §9「过期清理仅回收存储」)都不覆盖这种「已回执后丢弃」,而 01 §11 审计枚举亦无对应事件——丢得无声无息。注释「可靠性在端上 R11」对 post-ack 丢弃不成立。这是设计未定且 v1 缺省行为有风险的点,应显式裁决并留痕。
- **建议**:`offer` 返回类型收敛为 `'stored'`;溢出丢弃时产生审计事件(如 `inbox_overflow`,随实现扩展回写 01 §11 枚举)并计数;委员会裁决溢出语义:维持「丢最旧 + 审计」或改为对新条目回 `rejected(mailbox_full)`。

### API-11|minor|错误码登记与语义:`internal_error` 未入表、`bad_request` 兼职 404、`not_team_member` 兼职认证失败

- **位置**:`packages/registry/src/errors.ts` L2-14(表内无 `internal_error`);`packages/registry/src/http.ts` L33(`{ error: { code: 'internal_error', ...} }` 裸字面量绕过 `ErrorCode` 类型)、L98/L170/L186/L226 与 `directory.ts` L157/L361(`bad_request` + httpStatus 404 表达「not found」)、L116 与 `directory.ts` L234(`not_team_member` 用于「缺少凭证/凭证无效」401)、L236(owner 鉴权失败也复用 `not_team_member`)。
- **问题**:错误信封契约的消费方按 `code` 分流:①`internal_error` 表外行走,类型系统拦不住下一个表外码;②客户端无法区分「请求格式错」与「资源不存在」(都是 bad_request+404),也无法区分「token 失效需重新 enroll」与「不是本队成员/无权操作」(都是 not_team_member);③02 §9 错误码表为「初版」,实现扩充(`owner_auth_unconfigured`/`bad_request` 已入表,做得对)与语义挪用均未回写文档,「表外新增码须同步文档」没有规约。
- **建议**:登记 `internal_error`;404 场景引入 `not_found` 码;认证失败与成员越权拆为两码(如 `unauthorized` / `not_team_member`);在 02 §9 补一句规约「错误码表为封闭枚举,增码须同步修订本表」,并把本次实现新增的码正式入表。

### API-12|minor|outbox 边界:R11「按退避重发」未兑现(仅重连触发全量 flush)、attempts/lastAt 是死字段、默认 outbox 非持久且无上限、ackWaiters 超时不清理

- **位置**:`packages/node/src/outbox.ts` L4-8(`attempts`/`lastAt`)、L16-33(MemoryOutbox 无上限、非持久);`packages/node/src/gateway-client.ts` L90(每次 send 传 `attempts: 0, lastAt: 0`,lastAt 永为 0)、L103-108(`flush` 仅在 `state==='authed'` 时全量重发,无周期定时器、不维护退避)、L93-99(超时 resolve 后 `ackWaiters` 条目不删除)。
- **问题**:①R11「未获回执**按退避重发**」当前只有「重连后 auth_ok 全量 flush」一条触发路径:连接稳定但 `safeSend` 静默失败(gateway-client.ts L188-193 的 catch)时该消息在本次连接存续期内永不重试;②`attempts`/`lastAt` 字段在接口上承诺了退避调度的数据基础,实际是死字段(M3.2 才排期实现,R-MATRIX L21 已承认,不重复提缺口本身,只提**接口先行失真**);③R11 要求关键消息「本地持久化」,默认 `MemoryOutbox` 重启即失,若 M3 直接沿用默认值,R11 的持久化承诺落空;④`send` 超时返回 `'timeout'` 后 waiter 留在 map 里,长期运行节点缓慢泄漏,迟到 ack 还会触发已 resolve 的 waiter(无害但脏)。
- **建议**:flush 维护 `attempts`/`lastAt` 并加周期性 flush 定时器(退避参数进 QlongParams 或 client 选项);OutboxStore 注释钉死「持久化由实现负责,默认内存实现仅限测试」;`send` 超时分支同步 `ackWaiters.delete(env.msg_id)`。

### API-13|minor|enroll 限流缺省关闭、限流表无淘汰:公网缺省行为与 02 §9/I-16 要求相反

- **位置**:`packages/registry/src/http.ts` L16-17(`enrollRatePerMinPerIp?: number` 可选)、L83-96(未配置即完全不限流;`rate` Map 以 IP 为键只增不删)。
- **问题**:02 §9(评审 I-16)把「`/v1/enroll` 按 IP/ASN 限流」列为入网防滥用基线,属安全默认值;当前实现把限流做成纯可选,部署方忘配即裸奔——P12 精神下这类防护缺省应开。另外限流桶无淘汰,公网部署下 Map 随来源 IP 无界增长,限流器自身成为内存 DoS 面。
- **建议**:给出安全缺省(如 10/min/IP)并允许显式调大/关闭;窗口翻转时顺手清掉过期桶,或改 LRU。

### API-14|nit|http 层细节若干:死代码、条件绕、pubkey/epoch 输入校验松、name 唯一性缺位

- **位置与问题**:`packages/registry/src/http.ts` L133-140(`authByToken` 结果 `void node;` 死代码);L115(`seg[2] === 'me' || (seg[2] !== undefined && seg[2] !== 'me')` 等价于 `seg[2] !== undefined`,绕);L104-107(enroll `pubkey` 仅查非空串,不验 base64/32 字节 Ed25519 形状——注册中心是事实 CA(D29),垃圾公钥会污染目录并在 A4 才爆);L172-173(`epoch` 查询参数 `Number()` 松散解析,`1.5`/`1e3`/`abc` 都进 `lookupPubkey`,建议整数正则后 400);L126(PATCH name 无 02 §5.2「team 内唯一别名」查重);`packages/registry/src/directory.ts` L213-226(`joinTeam` 声明返回 `{team_id: string}`,实际 `as` 强转携带 `old_team_id`,类型谎报);L156-166(`issueEnrollToken` 响应不含 `expires_at`,控制台无法展示有效期,02 §4.3)。
- **建议**:逐项清理;pubkey 录入前做形状校验(非语义校验,不违反 P14);joinTeam 返回类型改实;enroll-tokens 响应补 `expires_at`。

### API-15|nit|包边界与追溯表:M2 交付物缺公共导出,R-MATRIX/02 §9 未回填

- **位置与问题**:`packages/gateway/src/index.ts` L1-4(未导出 `ws.js`——网关唯一的可部署件 `WsGateway` 不在包公共 API,消费者必须深引源码,M1 评审 API-7 指出的同类问题在 gateway 包原样重现);`packages/core/src/index.ts` L11-12(两条 export 挤同一行);`docs/testing/R-MATRIX.md` L24-26(ACL 段仍整体标「🔲 M2 网关实现时落」,M2 已交付 acl-core 13 项 + trio 6 项确定性断言,未回填 ✅;R9 标 🔲 M2 但 acl-core.spec 已有一对一投递断言);02 §9 API 表漏 resume/join 行(随 API-3 回写)。
- **建议**:gateway index 补导出;R-MATRIX 随 M2 收口如实回填(这也是 01 §6「规则可追溯到测试用例」的兑现动作);02 §9 表补行。

## 亮点

1. **统一错误信封执行到位**:`{error:{code,message,retryable?,details?}}` 与 02 §9 逐字段一致;enroll 三态码(invalid/expired/used)+ `enroll_token_in_flight` 预留与人话 message 落实了评审 I-23③ 的安装器呈现契约,directory.spec/http.spec 断言的是 `code` 而非 message 文案——错误契约测试的正确姿势。
2. **enroll 原子消费与并发语义实现干净**:同步单线程 + `consumed_at` 仅在成功响应时写入(02 §4.3/I-23②),重放 409 `enroll_token_used` 有确定性断言;无 token → self-owned team(I-48)路径完整。
3. **caps 重复参数与 RFC 3986 处理正确**:`url.searchParams.getAll('caps')` 天然支持 `?caps=a&caps=b`(02 §9/I-31),测试用 `encodeURIComponent` 编码 `:`/`@`,与 D31 的 AND 过滤语义在 directory.spec 有正断言。
4. **ACL 裁决与回声分级的契约测试质量高**:A0 静默无回执、A1 伪造 to.team_id 拒绝(I-13 的确定性断言原文落地)、A2 not_active、补投剔除过期 + exp_rejected 审计、4001 管理断连推送——acl-core.spec/trio.spec 的断言直接对着评审条款写,可追溯性是三个包里最好的。
5. **回执帧形状与 01 §9 逐字对齐**:`{ack_type: delivered|queued|rejected, msg_id, reason?}` 与 `routing.denied {rule, reason_code, msg_id}`(D26/D28),`offline_not_stored` 按设计只对 aid 类触发,core/frames.ts 还备好了运行时守卫(可惜客户端没用,见 API-9)。
6. **owner 接入点的「默认拒绝」方向正确**:未配置 `ownerAuth` 时 503 `owner_auth_unconfigured` 而非放行(P12),owner 鉴权以注入回调形式把产品侧会话代持(02 §3.2/I-21)的接缝留得干净——缺的只是这条路径的真实断言(现 http.spec L111-118 的 P12 用例是空转,建议随 API-4 一并补实)。

## 开放问题(建议委员会路由)

- **Q1 回执终局性的边界**:rejected(非 offline_not_stored)与 routing.denied 是否允许终止 outbox 重发(API-7)?裁决后须回写 01 §9/A6 并补竞态用例。
- **Q2 收件箱溢出语义**:丢最旧 + 审计,还是对新条目回 `rejected(mailbox_full)`(API-10)?影响 queued 回执的承诺强度,建议与 Q1 一并裁。
- **Q3 ws 帧契约的文档载体**:01 §9 扩「帧封装」小节,还是独立 transport 契约文档?版本字段(`GATEWAY_FRAME_VERSION`)与 4003 码的登记随载体一并定(API-8)。
- **Q4 presence 回填的归属**:网关核心发事件、宿主写 registry(单进程最小契约),还是 registry 暴露订阅接口由网关适配器推?跨进程形态留 02 §12.1,但事件缝的位置现在定(API-5)。
- **Q5 team 创建端点的缺位**:当前 `createTeam` 仅测试内直调,正式 team 只能靠 enroll 无 token 的 self-owned 路径;owner 控制台属纪要 §8.7 开放问题,v1 API-only 起步的等价操作路径(02 §3.2)建议在 M3 前给一句明确口径,避免 M3 双机剧本各自发明建队方式。

---
*评审人角色:接口与错误契约评审。本文件为委员会汇总输入之一;除本文件外未创建/修改/删除任何文件。*
