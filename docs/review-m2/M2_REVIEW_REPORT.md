# 群龙 M2 里程碑评审报告

> 评审委员会汇总文件。本报告仅依据 docs/review-m2/ 下五份角色评审意见(REVIEW_SEC / REVIEW_DIST / REVIEW_API / REVIEW_QA / REVIEW_ARCH)汇总合并而成,不引入新论断;行号与代码事实均以各评审文件评审时点为准。

## 一、评审信息

- **评审对象**:M2「中心三件」——`packages/registry`(directory.ts / errors.ts / http.ts)、`packages/gateway`(types / acl / mailbox / core / ws)、`packages/node` 客户端(gateway-client.ts + outbox.ts),及其测试(registry/test 17 项、gateway/test 19 项含 trio 三方联调 6 项)。
- **对照基线**:QLONG_DESIGN_NOTES(纪要)、QLONG_DESIGN_01_MSG_PROTOCOL(01)、QLONG_DESIGN_02_REGISTRY_TRUST(02)、QLONG_DESIGN_03_CAPABILITY(03)、QLONG_IMPL_PLAN,并对照 docs/testing/R-MATRIX.md 与 docs/review-m1/ 已决事项(M1 已决不重复)。
- **评审团构成**(预定五个角色全部到场,**无缺失角色**):

| 角色 | 评审文件 | 结论 | 意见数(blocker/major/minor/nit) |
|---|---|---|---|
| 信任边界与安全 | REVIEW_SEC.md | 需重大修订 | 19(2/7/8/2) |
| 分布式语义与一致性 | REVIEW_DIST.md | 需重大修订 | 14(1/8/3/2) |
| 接口与错误契约 | REVIEW_API.md | 有条件通过 | 15(1/7/5/2) |
| 测试充分性 | REVIEW_QA.md | 有条件通过 | 15(1/10/3/1) |
| 架构与演进 | REVIEW_ARCH.md | 有条件通过 | 20(2/11/6/1) |
| **合计** | 5 份 | — | **83 条(7/43/25/8)** |

- **汇总口径**:同题意见跨角色合并后共 **34 条**(blocker 3、major 19、minor 9、nit 3);合并条目严重度取各来源最高,提出角色逐条标注。

## 二、总体结论与执行摘要

五视角合并判定:**修订后进入 M3**(委员会综合裁定「有条件通过」;其中安全、分布式两视角单独判为「需重大修订」,测试视角明确「修订意见落实并补齐用例后方可收口」)。核心语义层质量获全员认可:ACL 纯函数裁决与 02 §7 逐条吻合、目录 epoch 缓存失效正确、enroll 原子消费干净、GatewayCore 严格 IO-free、依赖方向无一反向;83 条意见集中指向**传输适配层与集成接缝的系统性断裂**,多数是「接线缺口而非方向错误」,修复面有限。但三组 blocker 全部位于 M3 双机真实链路「第一天就会踩中」的路径上,且五份意见均以不同口径要求「进入 M3 前修毕并复验」,故不得带 blocker 收口。

**三个关键风险**:

1. **中心网关可用性面失守**:ws 适配器对上行信封零结构校验,已认证节点一帧畸形信封即可触发未捕获异常击穿整个网关进程(开放入网下「认证≠信任」);叠加连接表按 nodeId 键控的重连竞态,可致在线节点上行被静默黑洞、presence 失真,且无自愈路径。
2. **消息可靠性契约被静默击穿**:收件箱补投从未在生产路径接线、`delivered` 回执先于真实投递发出、`routing.denied`/rejected 被终局化清 outbox、outbox 缺省非持久且无周期重发——多条路径共同构成「发送方已获回执、消息实际永久丢失」的静默丢失面,发送方与牵头方均无感知。
3. **「安全控制缺省关闭」模式蔓延**:密钥轮换缺省单因子(token 泄露即可替换节点公钥,注册中心=事实 CA 的信任根被单因子打穿)、enroll 限流/节点配额缺省不限、A4 入站验签缺省直通——开放入网设计所依赖的资源防线与身份防线在缺省配置下双双缺位。

## 三、问题清单(同题合并,blocker > major > minor > nit)

### Blocker(3 条)

**M2-01|blocker|网关上行入口零信封校验,畸形信封一帧击穿网关进程**
- 位置:`gateway/src/ws.ts:64-72`(`frame.envelope as EnvelopeV1` 直传)、`core.ts:101/113-121/152`、`acl.ts:26/56` 裸解引用;全包未 import `validateEnvelope`(core 已有该函数且仅客户端在用)。
- 问题:认证后信封不经任何形状校验进入 uplink,缺 `from`/`to`/`body` 即抛 TypeError,异常沿 ws message 监听器成 uncaughtException,网关进程整体退出;开放入网下任何已认证节点可一发帧打死全网消息面,执法点必须失败关闭而非失败崩溃;畸形帧负路径测试为零(全部用例用工厂构造合法信封),客户端反而有 `validateEnvelope` 防线,攻守不对称。
- 建议:适配器或 uplink 入口先过 `validateEnvelope`(允许缺 `sig`、要求头字段齐备),不合格静默丢弃+计数+审计;uplink 包 try/catch 兜底审计;补缺 from/to/body、null、数组、垃圾 JSON、超长帧等负例集与 fuzz 变体,逐例断言「连接存活+网关存活+无投递」。
- 提出角色:SEC-1、QA-1、ARCH-2(SEC/QA/ARCH)

**M2-02|blocker|收件箱补投从未接线:`queued` 回执已清空发送方 outbox,离线消息永久丢失**
- 位置:`gateway/src/ws.ts:47-62`(auth 成功分支无 `takeInbox` 调用)、`core.ts:164-175`;全仓 grep 证实 `takeInbox` 唯一调用方是单元测试直调。
- 问题:目标离线→信封入箱→网关回 `queued`→发送方视为回执清空 outbox→此后无任何机制补投给重连节点:主路径上的静默永久丢消息,且发送方持有「已受理」假象;IMPL_PLAN M2.2 验收「收件箱补投+exp 兜底」实际未交付;trio 联调无「离线→上线」场景,缺口被掩盖;与 M1「offered 态不可达」blocker 同型(语义函数存在、单测可过、生产路径进不去)。
- 建议:ws 认证成功分支调用 `takeInbox(nodeId, now)`,deliveries 逐帧推送、audits 落审计;trio 补「B 离线→A 发 offer(queued)→B 重连→收到同一 msg_id」端到端用例及批量过期剔除变体;R-MATRIX 增补投行。
- 提出角色:SEC-2、DIST-1、QA-2、ARCH-4(SEC/DIST/QA/ARCH)

**M2-03|blocker|连接表按 nodeId 键控无身份守卫,重连竞态旧 close 误删新连接——在线节点上行被静默黑洞**
- 位置:`gateway/src/ws.ts:59-60`(覆盖写入)、`ws.ts:74-79`(close 无条件 delete+disconnect)、`core.ts:72-78`(按 nodeId 单键,connId 字段存在却全程未参与注销判定)。
- 问题:同 nodeId 二次连接(半开重连常态)直接覆盖,旧 socket 迟到 close 把新连接从 sockets/connections 双表剔除;此后该节点上行全部命中「无认证连接」静默分支(无回执),下行误入收件箱,节点自认在线、系统无自愈,直到下次完整重连;客户端 error+close 双排程使双连接成为常态;presence 随之失真;亦可被同 token 反复建连挤压目标节点。
- 建议:socket 与连接绑定 connId,close 与 `core.disconnect` 均带 connId/实例比对;新连接认证成功时以语义码(如 4000 replaced)主动关闭旧 socket,显式化「一节点一连接」不变量;客户端加单飞守卫;补「先连 A 后连 B、A 关闭后 B 仍可收发且 presence 在线」确定性用例。
- 提出角色:API-1、ARCH-1、SEC-3、DIST-4、QA-3④(API/ARCH/SEC/DIST/QA)

### Major(19 条)

**M2-04|major|`delivered` 回执先于真实投递、失败静默吞掉,半开连接无 keepalive——至少一次投递在在线路径被打破**
- 位置:`gateway/src/ws.ts:66-71`(先回执后投递)、`ws.ts:109-115`(safeSend 静默吞错)、`core.ts:144-149`(仅凭 connections.has 即断定 delivered);全文件无 ping/pong。
- 问题:目标恰在断开中(readyState=CLOSING)、两表分歧、send 抛错三种情况下发送方都拿到 `delivered` 并清 outbox,接收方实际未收到——R11「回执=可停发的真相」被假回执击穿;TCP 半开不产生 close,连接表假在线使 presence 虚高、消息沉入死 socket;safeSend 注释把兜底推给「对端 outbox」,但 outbox 是发送方机制,接收方无从兜底。
- 建议:以 ws.send 回调确认成功为准再回 `delivered`,失败/目标缺失即时回退 `inbox.offer` 改回 `queued`;加 ping/pong 心跳(如 30s+两次失活判死),死连接走与 close 相同清理路径;补「目标断开边缘」赛跑用例与假死 socket 用例。
- 提出角色:DIST-3、ARCH-7、QA-4(DIST/ARCH/QA)

**M2-05|major|客户端重连生命周期三处缺陷:双触发排程风暴、`close()` 幽灵复活、语义 close code 不终止**
- 位置:`node/src/gateway-client.ts:44-46`(`open()` 重置 closedByUser)、`51-57/71-79`(error 与 close 均无条件排程重连)、`110-114`(close 不清定时器)、`176-186`(退避无抖动,封顶声称 5s 实际 1600ms 不可达)。
- 问题:网络异常时 error+close 相继触发,每代失败排两个重连定时器呈指数扩散,形成对网关的自发型连接风暴;用户 `close()` 后悬挂定时器到点执行 `open()` 把 closedByUser 重置,幽灵客户端脱离用户控制复活;4001/4002/4003 一律无限自动重连——吊销节点(终态)以秒级间隔永久敲门,D28「节点本地呈现『本机已被暂停/吊销』」无承载;退避公式、超时、竞态零单测。
- 建议:同一时刻仅允许一个 pending 重连定时器(按连接实例判重);保存定时器句柄,`close()` 清除,`open()` 不重置 closedByUser(拆分 open/resume 语义);4001/4002/4003 终止自动重连并置语义状态(suspended/revoked/auth_rejected)交上层裁决;退避加 ±20-50% 抖动,抽出 `nextBackoffMs` 纯函数补单测。
- 提出角色:API-2、ARCH-6、DIST-5、QA-5、SEC-11(API/ARCH/DIST/QA/SEC)

**M2-06|major|`routing.denied`/rejected 一律终局清 outbox,与「回执仅诊断不参与可靠性」冲突,目录滞后误拒变永久丢消息**
- 位置:`node/src/gateway-client.ts:130-151`(任意 ack 与 routing.denied 均 remove)、`gateway/src/acl.ts:56-65`、`ws.ts:103-107`(50ms 快照滞后窗口)。
- 问题:收件人刚 enroll、网关快照未轮到时,首条合法消息命中 `not_team_member`→rejected+routing.denied→清 outbox→永久消失且重发被短路;设计仅 `offline_not_stored` 有「据此改派」的终局地位,01 §9/D26/A6 明文回执不参与可靠性;若有意收紧,须按「偏离回写」规约回写文档而非静默分叉。
- 建议:分级处置:`acl_rejected_cross_team` 终局删除;`not_team_member`/`not_active` 保留 outbox 并触发目录重同步后有限次重发;或回写 01 §9/A6 并补「入网竞态窗口首消息」用例固化取舍;给 client 补 `dropFromOutbox(msgId)` 供上层显式裁决。
- 提出角色:DIST-6、API-7(DIST/API)

**M2-07|major|join 换队后连接钉扎不更新:`conn.teamId` 停留旧队,携 from.team_id 的上行被 A0 永久静默丢弃**
- 位置:`gateway/src/ws.ts:90-101`(syncRegistry 只扫 status 不扫 team 变更)、`acl.ts:29-31`、`core.ts:72-74`(connect 一次性钉扎)、`registry/src/directory.ts:213-226`。
- 问题:目录快照与逐节点缓存正确推进(旧队不可达有专测),但换队节点既有连接的钉扎值不随目录刷新:此后所有携带新队 `from.team_id` 的上行命中 A0 失配→静默丢弃、无回执、无断连信号;节点自认在线、没有重连理由,构成无诊断线索的黑洞。
- 建议:syncRegistry 比对每连接 `conn.teamId` 与快照现值,不一致即重钉或语义断连(建议 4004 team-changed)强制重握手;或 A0 失配降级为 routing.denied(stale_connection)给出可见信号;补「在线 joinTeam 后携新 team 上行可达」用例。
- 提出角色:SEC-4、DIST-8、ARCH-15(SEC/DIST/ARCH)

**M2-08|major|presence 权威从未回写:目录 `online` 恒 false,02 §8 在线权威与 A1 验收在线态半句不成立**
- 位置:`registry/src/directory.ts:109/334`(生产代码仅 false 写入)、`gateway/src/core.ts:71-74`(注释声称置真但无落点)、`gateway/src/ws.ts` 全文无回写通道;唯一置真是测试手工注入。
- 问题:网关→registry 的 presence 上行通道完全缺失(无回调、无 HTTP、无共享写入点),真实部署通讯录全员永显示离线,派单/选目标决策失真;core.connect 注释与实现不符恰证遗漏;当前 online=true 的测试结论全部建立在绕过生产路径的手工注入上。
- 建议:最小契约:网关核心 connect/disconnect/applyAdminEvent 发 presence 事件,经 `onPresence(nodeId, online)` 回调写回 registry.presence(单进程闭环);跨进程形态留集群化议题但事件缝现在就留;trio 补真实 HTTP 断言 online=true/false;顺带定 ws 保活周期(联动 M2-04)。
- 提出角色:DIST-2、API-5、QA-10、SEC-17(DIST/API/QA/SEC)

**M2-09|major|R11 outbox 三缺两:缺省 MemoryOutbox 非持久、无周期退避重发、ackWaiters 超时泄漏**
- 位置:`node/src/outbox.ts:16-33`(唯一实现为内存 Map)、`gateway-client.ts:40`(缺省注入)、`103-108`(flush 仅重连触发)、`93-99`(超时不删 waiter);`attempts/lastAt` 为死字段。
- 问题:R11 要求关键消息「本地持久化」,现实现进程重启即丢 result/fail/cancel(恰是最不该丢的消息类);R11「按退避重发」仅有重连 flush 一条触发路径,连接存活但回执丢失时消息无限期滞留;超时后 waiter 条目常驻,长期运行节点慢性泄漏;R-MATRIX R11 行「🔲 M3」与已实现半边账实不符。
- 建议:提供 `FileOutbox`(复用 JsonFileStore tmp+rename 原子写先例),文档声明生产必须注入持久实现;增加周期 flush 定时器(按 entry 退避、时钟可注入),超时分支删除 waiter;R11 行拆「已实现/未实现」如实回填。
- 提出角色:DIST-7、ARCH-11、API-12、SEC-13(DIST/ARCH/API/SEC)

**M2-10|major|Registry 零持久化 + epoch 跨重启回退被网关单调卫兵永久拒收**
- 位置:`registry/src/directory.ts:103-110`(全部状态内存 Map,无存储抽象)、`gateway/src/core.ts:53-57`(`epoch < current` 纯单调卫兵,无实例身份概念)。
- 问题:注册中心=事实 CA,重启即全部 token 哈希/归属/enroll 审计蒸发,唯一出路是全员重新 enroll、节点身份不连续(trace、TOFU 钉扎、在途消息全部指向旧身份);跨进程形态下重启后 epoch 归 0,网关卫兵永远拒收新快照,目录分裂无告警;存储形态焊死在 Map 上,后续接持久化需重写整个类,演进位缺失。
- 建议:快照携带 `registryInstanceId`:「epoch 回退+实例变更」重置缓存并告警,「回退+同实例」拒绝;或将 nodes/tokens/epoch 持久化;抽 `RegistryStore` 接口(缺省 MemoryStore);至少在部署注记明文「v1 registry 与网关须同生命周期」;补 registry 重建后网关行为有定义的用例。
- 提出角色:DIST-9、ARCH-10(DIST/ARCH)

**M2-11|major|密钥轮换双因子缺省降级单因子,且当前 API 形状装配不出 §6.1 设计签名要素**
- 位置:`registry/src/http.ts:14-15/148-163`(verifyRotationSig 可选,请求体丢弃 ts/nonce)、`directory.ts:262-274`(verifier 不传即整体跳过,无 nonce 去重)。
- 问题:缺省形态下仅 node token 即可 `POST /v1/nodes/me/keys` 替换节点公钥——token 泄露即被静默冒充身份,击穿 02 §10 密钥泄露缓解的前提,与 P12 失败关闭精神相反;请求体无 ts/nonce 字段、verifier 拿不到 method/path/body 摘要,`JCS({method,path,sha256(body),ts,nonce})` 方案在此 API 上装配不出来,同一签名可无限重放;pubkey 无格式校验(任意非空串入库);测试全走无签名旁路,双因子契约零锁定,现有「无 sig 轮换成功」用例方向反了。
- 建议:未配置即 503/403 fail-closed(比照 owner 面 P12),显式 opt-in 才降级;请求体钉死 `{pubkey,sig,ts,nonce}`,http 层组装签名要素传入校验器;core 提供 `verifyRequestSignature` 共享实现+黄金样本;nonce 最小窗口去重;pubkey 校验 base64+32 字节;补「签名不符→401、重放→拒、旧 epoch 验签窗口」契约用例。
- 提出角色:SEC-6、API-4、QA-9、ARCH-8①(SEC/API/QA/ARCH)

**M2-12|major|enroll 限流/节点配额缺省关闭、限流桶无界增长,且零行为测试**
- 位置:`registry/src/http.ts:16-17/83-96`(不传参数即无限流;rate Map 按 IP 只增不删;`Date.now()` 硬编码)、`directory.ts:169-186`(无 token 即建 self-owned team+node,无配额检查)。
- 问题:02 §9/I-16/D30 定为开放注册强制基线的限流+配额+orphan GC 三者皆未落地且限流缺省关;叠加开放建队路径,攻击者可低成本灌入无限 team/node(目录、快照与 50ms 全量同步压力线性放大);限流桶永久驻留成为内存放大器;唯一沾边用例 `enrollRatePerMinPerIp: 1000` 形同关闭、无任何 429 断言,时钟不可注入致边界不可测。
- 建议:给安全缺省值(如 10/min/IP,显式 0 才关闭);限流器抽为可注入时钟纯类并单测(429+retryable、窗口边界、IP 隔离、仅 enroll 计数);桶定期清扫或 LRU;落每 team/owner 节点数上限;orphan team GC 至少留接口与策略占位并文档声明 v1 未实现。
- 提出角色:SEC-7、QA-6、ARCH-8②、API-13、ARCH-16①(SEC/QA/ARCH/API)

**M2-13|major|A4 入站验签缺省放行:双重执法的「辅」层整体缺席**
- 位置:`node/src/gateway-client.ts:17/160-164`(verifyInbound 可选,未配置直接 `onEnvelope(env)`)。
- 问题:02 P10 定案网关主执法+节点侧复核(验签+team 复核+策略);v1 网关不验签,节点侧验签是签名体系唯一现役执法点,缺省直通使责任归属在缺省链路整体失效;仓库无生产接线示例(trio 是唯一范本且在测试里),M3 极易以缺省形态跑在无验签状态;v1.5 直连路径落地后更是唯一防线;A4 静默丢弃只计数不留 `sig_verify_failed` 审计(联动 M2-14)。
- 建议:未配置时对 `task.*`/`rpc.*` 一律静默丢弃+计数(失败关闭),或以 `allowUnverifiedInbound: true` 显式开洞并留审计;把「目录查 key+verifyEnvelopeSig」下沉为包内默认实现(`directoryLookupVerify`)一行接入;补「未配置 verify→信封不达 onEnvelope」测试。
- 提出角色:SEC-5、ARCH-12(SEC/ARCH)

**M2-14|major|网关审计事件被整体丢弃、缺 §11 关联字段,客户端侧仅剩计数器**
- 位置:`gateway/src/ws.ts:65-72`(uplink 结果仅消费 ack/denied/deliveries,`r.audits` 弃置)、`core.ts:102/109/129/133/168-170`(五处 makeAudit 未提取信封现成的 trace_id/task_id/attempt)、`node/src/gateway-client.ts:157-171`(A4 验签失败仅计数)。
- 问题:伪造探测、跨队穿透尝试、exp 剔除在网关侧零留痕,A8「仅凭日志还原链路」对网关半边落空;审计记录缺关联字段、测试只断言 event 名(digest/六字段零断言);`envelope_head_digest` 的 P3 承诺无测试;客户端坏签名无 `sig_verify_failed` 事件。
- 建议:`WsGatewayOptions` 增 `onAudit(records)` sink(文件/SQLite 形态与 A8 验收口径同场定),uplink/takeInbox/syncRegistry 审计统一回调;core 五处补传关联字段;每类事件补字段集断言与 digest 性质用例;客户端验签失败接审计回调,trio 坏签名用例改断言审计字段。
- 提出角色:SEC-8、SEC-12、QA-8(SEC/QA;ARCH-13 第 7 项关联)

**M2-15|major|ws 面资源防护缺失:无帧上限、无连接上限、无认证超时,生命周期负路径零测试**
- 位置:`gateway/src/ws.ts:36-37`(未设 maxPayload,ws 库缺省 100MiB)、`37-63`(无认证超时、无每 IP/全局连接上限);auth 后重复 auth 帧静默落空。
- 问题:未认证连接即可发百 MB 级巨帧触发字符串化+解析的内存/CPU 尖峰,建连无速率约束;未认证连接可无限挂起占满连接面;HTTP 面 1MiB 上限与 ws 面不对称;错 token/非 active 认证/认证前发 envelope 三个 4003 分支已实现但零测试,重复 auth 帧语义无定义。
- 建议:maxPayload 设 1MiB 量级(≥MAX_BODY_INLINE 256KB 加帧封装余量);5-10s 认证超时(客户端 open 对称加);每 IP/全局并发连接上限;auth 前非 auth 帧直接 4003 快速失败;补巨帧 1009、三个 4003 负例、重复 auth 帧语义钉死用例。
- 提出角色:SEC-9、ARCH-17、QA-3①②③(SEC/ARCH/QA)

**M2-16|major|resume 与 join 有核心方法无 HTTP 端点:suspend 成单向门,join 前置确认无契约位**
- 位置:`registry/src/http.ts:190-203`(仅 suspend/revoke 分支)、`directory.ts:285-291/213-226`(resume/joinTeam 已实现);测试只能直调 `registry.resume` 绕过 HTTP。
- 问题:resume 无端点使 suspended 成为事实终态(owner 只能 revoke 了事),02 §6.1 runbook 前半段走不完整,接持久化后将永久卡死;join 无端点、签名无 confirm 参数,02 §4.2「旧凭证+新 enroll token 双因子」与「在途租约/未消费 offer 需显式确认」无处表达;02 §9 API 表本身漏列 resume/join(设计缺口被实现原样继承)。
- 建议:补 `POST /v1/nodes/{id}/resume`(owner 鉴权,触发 epoch 推进);补 join 端点(旧凭证+enroll token+`confirm?`,缺省 false);同步回写 02 §9 端点表与 02 §4.2 契约细节。
- 提出角色:API-3、ARCH-9、QA-13③、SEC-18④(API/ARCH/QA/SEC)

**M2-17|major|目录-网关一致性未跨进程化:同进程对象引用+50ms 全量轮询,「推送/回源」双缺位**
- 位置:`gateway/src/ws.ts:20-23/103-107`(RegistryLike 进程内接口,50ms 全量 snapshot)、`registry/src/http.ts` 全文(无快照/增量/订阅端点)、`core.ts:53-69`(setDirectory 每次清缓存形同虚设,lookup O(n))。
- 问题:02 §7.1 定案「bump epoch 主动推送、缓存落后即回源」,实现为同进程轮询:网关不会发现自身快照落后(唯一可知时机正是 M2-10 的死局);滞后窗口内新 enroll 节点不可寻址(与 M2-06 叠加成永久后果);snapshot 携带全部节点全部历史公钥,万级节点×每秒 20 次全量序列化不可持续;M2.3「双进程仿真」验收所需的 registry HTTP 集成面一项不存在,trio 实为单进程直连对象引用。
- 建议:registry HTTP 面补 `GET /v1/directory?since_epoch`(304/增量,回退全量)、`PUT /v1/gateway/presence`、管理事件推送或长轮询;网关 lookup miss 按 snapshotEpoch 回源一次再裁决(失败关闭不变);`setDirectory` 支持合并式更新、lookup 改 Map 索引;ws.ts 头注明确「startRegistrySync 为同进程测试形态」;`snapshot(sinceEpoch)` 接口形状 v1 先留位。
- 提出角色:ARCH-3、DIST-12(ARCH/DIST)

**M2-18|major|ws authenticate 错误契约与 registry.authByToken 抛错风格不匹配,直连注入即崩连接/进程**
- 位置:`gateway/src/ws.ts:16-18/52-56`(契约「无效=返回 undefined」,调用点无 try/catch)、`registry/src/directory.ts:231-239`(authByToken 对无效/suspended/revoked 一律抛 ApiError)。
- 问题:宿主把 `authByToken` 直接注入 `authenticate`(最自然接线)时,suspended 节点重连抛 ApiError,在 message 监听器里成为未捕获异常(同 M2-01 崩溃路径);trio 测试自行包装掩盖了契约断裂,把防御责任转嫁给每个未来宿主。
- 建议:authenticate 调用点 try/catch,任何抛错按「无效凭证」→close(4003);或契约改为「返回 `{ok:true|false, reason}`」兼容两种风格;`WsGatewayOptions` TSDoc 钉死错误语义;补「注入抛错 authenticate」断言网关存活、连接被 4003 拒绝。
- 提出角色:ARCH-5(ARCH)

**M2-19|major|目录查询契约三处缺口:load 永不过期且未存判定基准、online 过滤被静默忽略、返回无稳定排序**
- 位置:`registry/src/directory.ts:316-319/322-343`、`http.ts:209-215`。
- 问题:`putLoad` 原样存快照不记 receivedAt,03 §3.3/§5 的「过期置 null」语义缺失,接口形状现在定型错(补 TTL 必须再改存储);`?online=true` 被静默忽略,过滤悄悄失效,aid 持续打向离线节点制造 rejected 抖动;返回按 enroll 插入序,`next_cursor` 分页一旦启用游标语义即被破坏;响应包裹形状与 03 §5 示例不一致未回写。
- 建议:`putLoad` 记服务端 receivedAt、过期置 null;实现 online 过滤(或对未支持查询参数返回 400,拒绝静默吞);输出前按 node_id 排序并补断言;回写 03 §5 响应形状与 02 §9 分页字段语义。
- 提出角色:API-6(API)

**M2-20|major|M3「传输适配层」整体缺失:状态机与 gateway-client 之间七项接线件不存在**
- 位置:`node/src/gateway-client.ts`(止于裸回调)、`local/harness.ts`(承诺「换传输、状态机不动」但无装配层)。
- 问题:出站信封装配器(身份/签名/trace 注入+关键消息自动入 outbox)、入站适配器(含 (task_id,attempt) 关联与 A5 复核落点)、节点密钥目录(TOFU 钉扎+纪元现势校验+历史纪元查取)、registry HTTP 客户端、回执→改派触发、时钟统一(client 用真实 setTimeout,状态机用注入 now)、审计贯通——七项均不存在;trio 里每封回源查 pubkey 是性能与语义双重简化,非可部署形态。
- 建议:立 M3.0「传输适配」前置工作包:先定 `TransportAdapter` 接口(出站装配+入站分发+时钟注入+密钥目录注入),harness 的 deliverTo* 与 GatewayClient 退化为该接口的两个实现;装配类项单测闭环,密钥目录/HTTP 客户端需 registry 面配合(联动 M2-17/M2-16)。
- 提出角色:ARCH-13(ARCH)

**M2-21|major|ws 帧协议无契约载体:无版本字段、帧型与 close code 只存在于代码、同一 wire 契约多处重复且客户端解析零校验**
- 位置:`gateway/src/ws.ts:12/40-80`(AUTH_KEY 散写、帧型内联字符串、未知帧静默落空)、`node/src/gateway-client.ts:9/19-20/131/142`(第二份 AUTH_KEY、内联弱类型+强转,core 守卫零调用)、`gateway/src/types.ts:35-44`(GatewayAck/RoutingDenied 同形重复)。
- 问题:ws 传输绑定是 M2 核心接口,但帧契约(帧型枚举、字段、错误行为、4001/4002/4003 语义)既不在设计文档也不在代码常量,两端各写一份靠巧合对齐;auth_ok 不带版本/能力位,01 §8 演进规则在传输帧层无落点;三份重复定义必然漂移;客户端对入站帧零形状校验,畸形帧以 undefined 静默吞掉。
- 建议:在 core 定义帧型联合+运行时守卫+AUTH_KEY 常量+`GATEWAY_FRAME_VERSION`,auth/auth_ok 携带 `v` 字段并核对;gateway/types 改从 core re-export,客户端解析先过 `isGatewayAck/isRoutingDenied`,不过则计数丢弃;未知帧型回错误帧或至少计数审计;4003 连同 4001/4002 写进帧契约文档(01 §9 增「帧封装」小节或独立 transport 契约)。
- 提出角色:API-8、API-9、QA-15③(API/QA)

**M2-22|major|P12「owner 面缺省拒绝」测试空转:断言函数元数而非行为,owner/节点权限隔离与 revoke HTTP 契约零覆盖**
- 位置:`registry/test/http.spec.ts:111-118`(P12 用例最终断言 `createRegistryServer.length`——函数参数个数)、`97-109`(owner 用例在 `ownerAuth: () => true` 下用节点 bearer 调 suspend 即通过);`http.spec.ts` 无 revoke→4002 契约。
- 问题:P12 失败关闭是 owner 面安全底线,当前 guarded by 空转用例——实现若回归为「未配置即放行」测试依然全绿;节点 bearer 调 owner 端点成功反而演示了越权放行;revoke 端点与 4002 语义推送无 HTTP 级断言。
- 建议:重写 P12 用例:未配置 ownerAuth 的服务真实监听,断言 suspend/enroll-tokens 返回 503+`owner_auth_unconfigured`;补 ownerAuth 拒绝→403、节点 token 调 owner 端点被拒的权限隔离用例;补 revoke HTTP 契约(4002)及「revoke 后 token 立即 403」;清理 `void s2`/`void noAuth` 死代码。
- 提出角色:QA-7、ARCH-20⑤(部分)(QA/ARCH)

### Minor(9 条)

**M2-23|minor|「网关停路由」对非 active 目标不生效:revoked/suspended 节点仍可被投递/暂存,revoked 收件箱成死存储**
- 位置:`gateway/src/acl.ts:56-83`(A1 只锚定存在与归属,不查 status)、`core.ts:144-160`、`directory.ts:293-300`(revoke 后节点仍在快照,收件箱不清理)。
- 问题:02 §6.1 明文 revoke「+网关停路由」;实现里目标 revoked/suspended 时在线窗口照常 delivered、离线持续入箱,revoked 节点永不上线即死存储,`queued` 回执对「永不可达」目标构成误导性可靠性信号;revoked 增量暂存行为无测试亦无文档口径。
- 建议:路由裁决前校验目标 status(至少 `!== 'revoked'`),失败按 A1 口径回 routing.denied 不入箱(suspended 可保留 queued);revoke 时清空收件箱并审计;补吊销目标终局用例。
- 提出角色:SEC-10、DIST-10、QA-14②(SEC/DIST/QA)

**M2-24|minor|收件箱溢出丢最旧无审计、`'full'` 返回值死分支、drain 先清后发、core 字段重复初始化**
- 位置:`gateway/src/mailbox.ts:13-24/27-37`、`core.ts:41/49`。
- 问题:已回 `queued` 的消息此后被溢出挤掉属于「已回执后静默丢弃」,可靠性端上兜底与网关过期清理都不覆盖,却无 `inbox_overflow` 类审计,`'full'` 死分支又使调用方无从感知;drain 清空后若 ws 发送失败,这批消息既不在箱也未送达;字段初始化两处属代码卫生。
- 建议:溢出记审计事件(枚举随 01 §11 演进回写)并计数;offer 返回类型收敛;takeInbox 改「确认发送后移除」或失败回填;委员会裁决溢出语义(维持「丢最旧+审计」或改回 `rejected(mailbox_full)`,与回执终局性问题一并裁);删死分支与重复初始化。
- 提出角色:DIST-11、API-10、QA-14①③、SEC-18③、ARCH-20②③(DIST/API/QA/SEC/ARCH)

**M2-25|minor|registry 输入与格式边界缺失:token TTL 无上界、caps/load 无形状体量约束、pubkey 漂白入库、caps 非数组静默清空、name 无唯一性、运行参数散落**
- 位置:`registry/src/http.ts:216-222/105/136/124-127`、`directory.ts:156-166/304-319`、`gateway/src/mailbox.ts:11`、`ws.ts:103` 等。
- 问题:owner 可签发 TTL=十年的一次性 token;已认证节点可写 1MiB 垃圾进 load、无界标签撑大目录;数字/对象 pubkey 经 `String()` 漂白通过非空校验入库(TOFU 信任根被污染,验签时才爆);caps 非数组被当 `[]` 全量清空能力档案且 caps_rev 自增(畸形 body 静默改写数据);PATCH name 无 team 内唯一校验;收件箱容量/同步间隔/限流缺省/退避基数等新参数未进单一事实源。
- 建议:ttl 钳制(如 ≤24h);caps ≤200 条×128 字符、load 按字段白名单归一化超限 400;pubkey 非字符串/非合法 base64/长度不符 400;caps 非数组 400;name 冲突 409;epoch 参数整数校验;参数收口到 params/config 模块并回写文档;补 405/413/非法 JSON/404 各一例锁定统一错误信封形状。
- 提出角色:SEC-15、QA-13①②④、API-14③④⑤、ARCH-16②③④(SEC/QA/API/ARCH)

**M2-26|minor|revoke 未清除 caps/load 档案(03 §8 隐私要求未兑现)**
- 位置:`registry/src/directory.ts:293-300`(revoke 仅置状态/离线/epoch)。
- 问题:03 §8 要求「节点 revoked 后注册中心即删除其 caps/load 档案」;现档案随 NodeRecord 永久保留,一旦被后续接口(审计导出、目录回放)带出即成违约(keys 保留供历史验签是另一回事)。
- 建议:`revoke()` 中 `node.caps = []`、`node.load = null`,keys 保留。
- 提出角色:SEC-16(SEC)

**M2-27|minor|错误码登记与语义:`internal_error` 未入表、`bad_request` 兼职 404、`not_team_member` 兼职认证失败**
- 位置:`registry/src/errors.ts:2-14`、`http.ts:33/98/116/170/186/226`、`directory.ts:157/234/361`。
- 问题:消费方按 code 分流:表外码类型系统拦不住;「请求格式错」与「资源不存在」不可区分;「token 失效需重新 enroll」与「不是本队成员/无权操作」不可区分;实现新增码与语义挪用均未回写 02 §9,「增码须同步修订码表」无规约。
- 建议:登记 `internal_error`;404 引入 `not_found`;认证失败与成员越权拆两码(unauthorized / not_team_member);02 §9 补「错误码表为封闭枚举,增码须同步修订」规约并把本次新增码正式入表。
- 提出角色:API-11、ARCH-20①(API/ARCH)

**M2-28|minor|ACL 分支断言缺口与回执归因缺失(对照 02 §7 逐条与 A9 验收)**
- 位置:`gateway/test/acl-core.spec.ts`、`trio.spec.ts`。
- 问题:A0/A1 的「留空合法」分支、A1 回程锚定(D27)、A6 routing.denied 归因(共享数组无法区分谁收到 denied)、`setDirectory` 旧 epoch 拒绝、offline_not_stored 端到端(trio 无对应)均无用例。
- 建议:每条补一例;归因问题给 routingDeniedSeen 加 client 标记;回程锚定按 01 §4.3 方向约束构造「执行方 reject 回牵头方」信封。
- 提出角色:QA-12(QA)

**M2-29|minor|R-MATRIX 未随 M2 更新,追溯账本落后于实现**
- 位置:`docs/testing/R-MATRIX.md:19-26`(ACL A0–A6 仍全部 🔲 M2,R9/R11 状态未更新)。
- 问题:M2 已交付 acl-core 13 项+trio 6 项确定性断言,矩阵零回填使 A9 验收无法对账核验、下版排期误判(R11 的「重连重发」半边已测、「周期退避」半边没有,矩阵不更新无从看出残差);违背 01 §6「每条规则可追溯到测试用例」的维护承诺(M1 QA-28 同款问题重演)。
- 建议:A0–A6 逐条映射用例编号、缺口如实标 🔲(A4/A5 节点侧注明归属包);R11 拆「✅(重连触发)/🔲 M3(周期退避)」;R9 补命名用例或注明由校验器+网关结构保证。
- 提出角色:SEC-19、QA-11、ARCH-18、API-15②(SEC/QA/ARCH/API)

**M2-30|minor|包边界与依赖声明:gateway 不导出 ws 适配器、node 重复导出、trio 跨包深引源码、三个包 dependencies 未声明、packages/testing 缺位**
- 位置:`gateway/src/index.ts:1-4`、`node/src/index.ts:6/11`、`gateway/test/trio.spec.ts:8`、三个包 package.json。
- 问题:组合根按正规包入口拿不到 `WsGateway` 与接管组件(M1 API-7 同类问题在 gateway 包重现);trio 深引 node 源码使 gateway 无法独立构建/发布;依赖靠根提升的巧合工作;impl 规划的 packages/testing 未建,M3 仿真层与走查剧本将继续堆进 gateway/test。
- 建议:gateway index 补导出;node 补 lead/checkpoint、lead/supervisor、lead/store 三模块并去重;trio 移入 packages/testing 并补建该包;三包补 workspace 依赖声明。
- 提出角色:DIST-13、ARCH-19、API-15①、ARCH-20④(DIST/ARCH/API)

**M2-31|minor|网关读 `body.kind` 与 P3「中心只见头」的张力未按偏离回写明文化**
- 位置:`gateway/src/types.ts:24-33`、`core.ts:151-153`;对照 01 P3/§9。
- 问题:「网关不解析 body」与「aid 类不暂存(区分字段仅在 body.kind)」在设计文本内部即冲突,实现选了读 body.kind 并自注「设计明文允许」——言过其实;P3 是安全边界声明,实现层对 body 的访问面必须在设计文档中有精确许可边界,否则未来贡献者无从判断网关还能碰 body 的哪些字段。
- 建议:按 impl §5 回写 01 §9/P3:「网关对 body 的唯一许可访问=`body.kind` 相等性判断,不作信任依据、不记录、不参与路由/安全裁决」;或将投递提示字段上移信封头(设计变更,另议)。
- 提出角色:DIST-14、ARCH-14(DIST/ARCH)

### Nit(3 条)

**M2-32|nit|HTTP 层细节杂项:Bearer scheme 大小写敏感、死代码、条件绕、enroll-tokens 缺 expires_at、joinTeam 返回类型谎报、/nodes/me 回显 keys 全史**
- 位置:`registry/src/http.ts:66-71/133-140/115/126/172-173`、`directory.ts:213-226`、`gateway-client.ts`(GET /nodes/me 响应)。
- 问题:Bearer 大小写敏感与 RFC 7235 不符,严格客户端被 401;`void node;` 死代码与等价于 `seg[2] !== undefined` 的条件绕;issueEnrollToken 响应不含 expires_at,控制台无法展示有效期;joinTeam 声明返回 `{team_id}` 实际 `as` 强转携带 old_team_id;/nodes/me 返回完整 NodeRecord(含 keys 全史),测试只断言无 tokenHash 对 keys 泄露无感知。
- 建议:逐项清理;pubkey/epoch 录入前做形状校验;响应改白名单裁剪;joinTeam 返回类型改实。
- 提出角色:SEC-18①、API-14①②⑥⑦、ARCH-20⑤(部分)、QA-15④(SEC/API/ARCH/QA)

**M2-33|nit|测试杂项:`enroll_token_in_flight` 死字母未标注预留口径、`void gw.close()` 未 await、目录同步轮询口径未回写设计**
- 位置:`errors.ts:6`、`gateway/test/trio.spec.ts:49`。
- 问题:该错误码在单进程同步实现下不可达,应注明「预留给集群化」防止被误删或误判已实现;悬挂句柄可能跨文件泄漏;50ms 轮询为 v1 形态,与 02 §7.1「主动推送」口径差未回写,M3 换事件推送时测试需同步改。
- 建议:TSDoc 注明预留口径;补 await;回写轮询为 v1 形态的口径。
- 提出角色:QA-15①②(QA)

**M2-34|nit|审计事件语义失真:「无认证连接」分支复用 `acl_rejected_from_pin`**
- 位置:`gateway/src/core.ts:107-110`。
- 问题:该分支并非钉扎失败,复用事件名使 SEC-3 类竞态现场难以甄别(审计里只见「钉扎拒绝」)。
- 建议:改用独立事件(如 `unauthenticated_uplink`),便于竞态与伪造场景区分。
- 提出角色:SEC-18②(SEC)

> 合并说明:原始 83 条意见全部落入上表 34 条;另有多条开放问题(网关多副本边界、回执终局性 Q1、收件箱溢出语义 Q2、ws 帧契约载体 Q3、presence 回填归属 Q4、team 创建端点口径 Q5、M3 部署形态、suspend 后重连抑制策略、ws 保活与 presence 僵尸、registry 快照增量契约形状等)系各评审提请委员会裁决事项,非缺陷,不列入问题清单,建议随 M3 开工前专项定案。

## 四、亮点(合并去重)

1. **ACL 语义层质量高,全员认可**:纯函数裁决+引擎「双路同判」测试,A0 钉扎(含 from.team_id 可选语义)/A1 目录锚定+回程同规则/A2/A6 回声分级与 02 §7、D27/D28 逐字吻合;「伪造 to.team_id 跨队穿透必拒」(I-13)有确定性配对用例,可追溯性是三个包里最好的。
2. **目录 epoch 核心机制正确且被测试钉住**:setDirectory 单调卫兵+逐节点缓存携带快照 epoch、换代即重扫,「换队后旧 team 立即不可达」有专测;registry 侧全部变更操作均按 §7.1 触发清单 bump epoch。
3. **enroll 全链路干净**:token 仅存 sha256、明文单次出现、CSPRNG 位数合规、同步单线程下消费原子、invalid/expired/used 三态码与人话呈现契约(I-23③)齐备,重放 409 有确定性断言;无 token→self-owned team 路径完整。
4. **错误信封统一且无泄露**:`{error:{code,message,retryable?,details?}}` 与 02 §9 逐字段一致,500 通用化不带栈/内部信息;API 无 CORS、凭证仅走 Authorization 头;契约测试断言 code 而非 message 文案。
5. **owner 面缺省拒绝方向正确**:未配置 ownerAuth 时 503 `owner_auth_unconfigured`(P12 教科书式落地);suspend/revoke 返回语义 close code 且 4001 管理断连推送端到端打通。
6. **trio 三方联调真实有效**:真实 ws+真实 Ed25519 签名+真实 Registry 实例,全程 waitFor 无固定 sleep,坏签名静默、outbox 同 msg_id 重发、aid 不暂存等关键路径均有行为级断言,为 M3 离散事件仿真打了正确底子。
7. **GatewayCore 严格 IO-free、分层形态正确**:无 node:* 依赖、时钟/目录/连接表全部注入,ws 适配器薄且只做 IO——P2「核心可仿真、适配器极薄」在中心侧忠实兑现,依赖方向 core←{registry,gateway,node} 无一反向,gateway 不依赖 registry(接口注入倒置)。
8. **纪元现势三态齐备**:`lookupPubkey` current/historical/unknown_epoch+非 active 回源拒绝,「查无此 epoch ≠ 已吊销」错误码分离,且未引入负缓存(规避吊销抑制类缓存污染)。
9. **细节纪律**:caps 重复参数按 RFC 3986 正确处理并与 D31 AND 过滤语义有正断言;A3 首帧认证形态符合 I-16(token 走首帧 JSON 而非 URL/进程参数);回声分级「静默无回执」半边在 core 层显式断言 ack===undefined;补投「过期剔除+exp_rejected 审计」与 exp 虚拟时钟判向用例完整。
10. **M1 三项 blocker 修复真实落地**:`adoptRestoredLead` 按 pendingTimers 重挂定时器、drafting 态恢复后补发改派意图,修复方向与 M1 评审建议一致。

## 五、修订清单(按优先级,≤10 条)

| # | 优先级 | 修订项 | 对应问题 |
|---|---|---|---|
| 1 | P0(收口前必修) | 网关上行接入 `validateEnvelope`+uplink try/catch 兜底审计,补畸形帧负例集与 fuzz 用例,断言网关/连接存活 | M2-01 |
| 2 | P0(收口前必修) | ws 认证成功分支接线 `takeInbox` 补投,补「离线→重连→补投同一 msg_id」端到端用例(含过期剔除变体) | M2-02 |
| 3 | P0(收口前必修) | 连接表/socket 绑定改 connId 守卫+新连接语义踢旧+客户端单飞,补重连竞态确定性用例 | M2-03 |
| 4 | P0(收口前必修) | P12 用例重写为真实行为断言(503/403/权限隔离/revoke→4002),清理伪测试 | M2-22 |
| 5 | P1(M3 接线前必修) | `delivered` 改以 send 回调确认为准、失败回退入箱改 `queued`;ws 加 ping/pong 保活,死连接走统一清理 | M2-04 |
| 6 | P1(M3 接线前必修) | 客户端重连生命周期:单一定时器+单飞守护、close() 清句柄、4001/4002/4003 终止自动重连并置语义状态、退避加抖动并修文档 | M2-05 |
| 7 | P1(M3 接线前必修) | 密钥轮换缺省 fail-closed+请求体补 ts/nonce+core 共享 `verifyRequestSignature`(JCS 要素)+nonce 去重+pubkey 形状校验 | M2-11 |
| 8 | P1(M3 接线前必修) | 安全缺省关闭三处转正:enroll 限流给非零缺省+可注入时钟+行为测试与节点配额;A4 验签缺省拒绝/包内默认实现;限流桶清扫 | M2-12、M2-13 |
| 9 | P1(M3 接线前必修) | 回执与 outbox 语义修正:routing.denied/rejected 分级处置(或回写设计)、FileOutbox 持久化、周期退避重发、ackWaiters 泄漏修复 | M2-06、M2-09 |
| 10 | P1(M3 接线前必修) | 集成面补线:presence 回写最小契约+端到端断言、registry 持久化/实例身份与 epoch 回退处置、resume/join HTTP 端点、authenticate 错误契约对齐 | M2-08、M2-10、M2-16、M2-18 |

> P2 随批修订(不占上表名额):审计 onAudit sink 与关联字段贯通(M2-14)、ws 资源防护上限与认证超时(M2-15)、目录跨进程端点(M2-17)、目录查询 TTL/online/排序契约(M2-19)、minor/nit 全部(M2-23 ~ M2-34)、R-MATRIX 回填与 02 §9/03 §5/01 §9 偏离回写(M2-29、M2-31)。

## 六、M2 收口判定建议

**判定:修订后进入 M3(不宜以现状收口,亦无需重大返工)。**

**理由**:

- **不构成返工**:核心语义层(ACL 裁决、目录 epoch、收件箱语义、enroll 原子消费)与架构骨架(IO-free core、依赖方向、错误契约、三方联调形态)获五视角一致认可,83 条意见绝大多数是「适配器接线缺口、缺省配置错误、测试口径缺口」,修复面有限、方向不错。
- **不得带 blocker 收口**:三组 blocker(M2-01/02/03)分别由安全、测试、接口、架构视角独立判为 blocker,且全部位于 M3 双机真实链路的常态路径(任意入网帧、半开重连、离线重连);SEC/DIST 两视角单独判「需重大修订」,QA 明言「修订意见落实并补齐用例后方可收口」,ARCH 要求「M3 接线前修毕并复验」。
- **收口前置条件**:
  1. P0 四项(修订清单 1–4)完成并通过针对性复验:网关存活负例集、补投端到端、重连竞态用例、P12 真实断言;
  2. P1 六项(修订清单 5–10)在 M3 传输接线开工前完成,重点是安全缺省关闭三处与回执真实性;
  3. R-MATRIX 按实际覆盖回填,恢复「01 §6 规则可追溯到测试用例」的账本可信(M2-29);
  4. 各评审提出的开放问题(回执终局性边界、收件箱溢出语义、ws 帧契约载体、presence 回填归属、M3 部署形态同进程/跨进程、suspend 后重连抑制、ws 保活周期、registry 快照增量形状)随 M3.0 工作包一并裁决,避免双机剧本各自发明口径;
  5. M3 立项时将 ARCH-13 七项「传输适配」清单立为 M3.0 前置工作包,防止散落进各验收项反复返工。

---

## 修订记录(评审后)

- P0 四项修毕(提交见 git log):M2-01 ws 上行接入 validateEnvelope + 全程 try/catch + null/原始类型帧守卫 + 畸形帧负例集与存活断言;M2-02 认证成功即接线 takeInbox 补投 + 「离线→重连→补投同一 msg_id」端到端用例;M2-03 连接表 connId 守卫 + 同节点新连接踢旧 + 客户端单飞 open/单一重连定时器 + 重连竞态用例;M2-22 P12 伪测试重写为真实行为断言(503/403 双形态)。
- P1 部分前置:M2-18(非 active 节点连不开)已随 A3 落地。
- 复验:gateway 23 + registry 17 + node 45 + core 42 全绿,typecheck 0 错。遗留 P1(回执语义分级、outbox 持久化、presence 回写契约、resume/join 端点等)随 M3 接线批次处理。
