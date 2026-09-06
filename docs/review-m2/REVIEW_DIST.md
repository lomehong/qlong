# M2 评审意见:分布式语义与一致性(DIST)

> 评审对象:M2「中心三件」`packages/registry`、`packages/gateway`、`packages/node/src/gateway-client.ts`、`packages/node/src/outbox.ts` 全部源码与测试(registry 17 项 / gateway 19 项,含 trio 三方联调 6 项)。
> 对照基线:`QLONG_DESIGN_01_MSG_PROTOCOL.md`(下称 01)、`QLONG_DESIGN_02_REGISTRY_TRUST.md`(下称 02)、`QLONG_DESIGN_03_CAPABILITY.md`(下称 03)、`QLONG_DESIGN_NOTES.md`、`QLONG_IMPL_PLAN.md`、`docs/testing/R-MATRIX.md`;并对照 `docs/review-m1/` 已决事项。
> 评审视角:目录 epoch 机制(02 §7.1)、presence 权威一致性(02 §8/D17)、收件箱语义(01 §9/02 §8)、回执帧与 R11 outbox(01 §9/D26)、enroll 消费原子(02 §4.3/I-31)、ws 重连与退避、网关多副本边界(02 §12.1 的 v1 假设)。其余视角(安全/接口/架构/测试)归队友。行号以本次评审时点文件内容为准。

## 结论(verdict)

**需重大修订。**

核心语义层(`acl.ts`/`mailbox.ts`/`core.ts`/`directory.ts`)与设计条款对齐良好、测试真实;但**传输适配层与集成面存在系统性断裂**:收件箱补投在唯一的生产适配器 `WsGateway` 中从未被调用(离线暂存成为只写黑洞,blocker),presence 从未被注入、`delivered` 回执先于真实投递发出、连接表按 nodeId 无守卫覆盖、重连路径丢失 A6 语义 close code、`routing.denied` 被终局化、outbox 无持久化、join 换队后存留连接无自愈信号、注册中心重启 epoch 回退被网关单调卫兵永久拒收。这些缺陷与 M1 三项 blocker 同型——「M3 接上双机真实时序即爆发」,当前 trio 6 项联调恰好全部绕开这些路径。

## 摘要

- **blocker ×1**:收件箱补投(`takeInbox`)生产路径零调用,离线暂存「重连即补投」(01 §9)端到端不成立,trio 联调未覆盖离线→上线场景。
- **major ×8**:presence 权威从未注入(在线态恒 false,违反 D17/M2.3 验收);`delivered` 回执先于真实投递且投递失败无补偿;连接表按 nodeId 覆盖、迟到 close 踢除新连接;重连机械丢失 A6 反馈(4001/4002 与凭证错不可分辨、吊销节点无限重连、退避无抖动);`routing.denied` 一律删 outbox(与「回执不参与可靠性」冲突,目录滞后误拒变永久丢失);R11 outbox 无持久化、在线期间无退避重发;join 换队后存留连接成黑洞无重握手信号;registry 零持久化 + epoch 回退被网关单调卫兵死锁。
- **minor ×3 / nit ×2**:非 active 目标不停路由、收件箱溢出无审计与 drain 先清后发、目录同步为 50ms 同进程全量轮询且无跨进程端点;包导出缺口、`body.kind` 读取的 P3 张力。

## 问题清单(按严重度排序)

---

### DIST-1|blocker|收件箱补投从未接入生产路径,离线暂存是「只写黑洞」

- **位置**:`packages/gateway/src/ws.ts` L47-62(握手认证成功后仅 `core.connect` + `auth_ok`,无任何 `takeInbox` 调用)、L89-107(`syncRegistry`/`startRegistrySync` 只做目录同步与管理断连);`packages/gateway/src/core.ts` L164-175(`takeInbox` 定义);全仓 grep 证实 `takeInbox` 唯一调用方是单元测试 `packages/gateway/test/acl-core.spec.ts` L178;`packages/gateway/test/trio.spec.ts` 全文(6 项联调)无「目标离线 → 暂存 → 上线补投」场景。
- **问题**:网关侧离线暂存的全部价值在「重连即补投」(01 §9 离线暂存:「信封进入其收件箱,**重连即补投**」;IMPL_PLAN M2.2 验收明列「持久收件箱……**收件箱补投**+exp 兜底」,L60)。实现中 `InboxStore.drain`/`GatewayCore.takeInbox` 语义正确且有单元测试,但**没有任何生产代码在 A3 握手成功后调用它**:`WsGateway` 的 auth 分支发完 `auth_ok` 即返回。后果:节点离线期间收到的 project 类 offer/result/cancel 全部滞留收件箱,节点重连后永远收不到——离线暂存从「至少一次的存储腿」退化为纯存储泄漏;牵头方只能等 offer_ttl/租约超时兜底,01 §9 承诺的补投路径整体不可达。这与 M1 评审中「offered 态不可达」(merged 报告 blocker #1)完全同型:语义函数存在、单元测试可过、生产路径进不去。trio 6 项联调恰好全部是「双方先在线再通信」或「outbox 方向」的剧本,未暴露此缺口。
- **依据**:01 §9(离线暂存/重连即补投);02 §8(离线暂存范围,I-53);`QLONG_IMPL_PLAN.md` M2.2 验收行。
- **建议**:① `WsGateway` 在 `core.connect(...)` 之后、发送 `auth_ok` 前后调用 `const t = this.opts.core.takeInbox(nodeId, Date.now())`,将 `t.deliveries` 逐条 `safeSend` envelope 帧(注意与 DIST-3 的投递确认顺序一并处理),`t.audits` 交宿主审计汇;② trio 补一项:B 断开 → A 发 project offer(断言 ack=queued)→ B `open()` → `waitFor` 断言 B 收到该 offer;再补「长期离线批量过期 → 补投时剔除 + exp_rejected 审计」的端到端版(R2 必测场景的 M2 半边);③ R-MATRIX 增补投行。

---

### DIST-2|major|presence 权威从未注入:通讯录 `online` 恒为 false

- **位置**:`packages/registry/src/directory.ts` L109(`readonly presence = new Map<string, boolean>()`,注释「由网关适配器注入」)、L334(`online: this.presence.get(...) ?? false`);`packages/gateway/src/core.ts` L71-74(`connect` 注释声称「presence 置真(02 §8 在线权威)」,但核心无注册中心引用,函数体只写连接表);全仓 grep 证实生产代码对 `presence` **只有初始化 false 与 revoke 置 false,从无置真路径**;唯一写 true 的是测试 `packages/registry/test/directory.spec.ts` L136 手工注入。
- **问题**:02 §8/D17:「在线权威 = 通讯网关的连接态」;02 §9:「目录 API 的 `online` 字段来自网关连接态」;IMPL_PLAN A1 验收:「目录互相可见(**含在线态**、caps 摘要)」。当前实现里 `listTeamNodes` 返回的 `online` **永远 false**,牵头方(M3 的选目标、03 §5 的 `online=true` 过滤)将看不到任何在线节点——A1 验收项实际不成立。`core.connect` 的注释与实现不符恰说明这是遗漏而非裁剪:网关核心与注册中心之间不存在 presence 回写通道(同进程组合也没有)。
- **依据**:02 §8、D17、02 §9「目录-网关系」行;IMPL_PLAN §1 A1。
- **建议**:① 最小修:组合根/测试装配处把连接事件回写——`core.connect`/`disconnect`/`applyAdminEvent` 后调 `registry.presence.set(nodeId, bool)`(或给 GatewayCore 加 `onPresenceChange` 回调);② 与 DIST-12 一并给出跨进程形态的 presence 上报端点;③ trio 补断言:节点 `open()` 后 `GET /v1/teams/{id}/nodes` 该节点 `online=true`,`close()` 后 false。另注:两侧均无 ws 保活(ping/pong),半开连接下「连接态」本身会长期失真,建议随 M3 定保活周期(见开放问题 3)。

---

### DIST-3|major|`delivered` 回执先于真实投递发出,投递失败静默丢弃且无补偿

- **位置**:`packages/gateway/src/ws.ts` L66(先发 ack)与 L68-71(后投递:`const target = this.sockets.get(d.toNodeId); if (target) this.safeSend(target, …)`,目标缺失或 `safeSend` 内 `readyState !== OPEN`/send 抛错均静默吞掉,L109-115);`packages/gateway/src/core.ts` L145-148(核心仅凭 `connections.has(toNodeId)` 即断定 delivered)。
- **问题**:回执帧语义(01 §9):`delivered` = 已投递到目标连接。实现顺序是**先回执、后投递**,且投递这步可无痕失败:目标恰在断开中(readyState=CLOSING,C2S 关闭竞态)、`sockets` 与 `core.connections` 两表分歧(即 DIST-4 的场景)、send 抛错——三种情况下发送方都拿到 `delivered` 并**从 outbox 删除该消息**(gateway-client.ts L132),而接收方实际什么都没收到。R11 的全部可靠性建立在「回执 = 可停止重发的真相」之上,假 delivered 直接击穿它:对 result/cancel 这类关键消息,发送方以为送达、接收方永远等不到,只能靠租约超时回收。这不是理论竞态——每个优雅断开的窗口都会命中(收到 close 前的最后一次投递)。
- **依据**:01 §9 回执帧(`delivered|queued|rejected` 语义、I-11/D26);R11(回执是重发的终止条件);P4(至少一次由端上兜底——前提是回执不撒谎)。
- **建议**:① 以「实际写 socket 成功」为准:`ws.send(data, cb)` 回调确认后再回 `delivered`;失败或目标缺失 → `inbox.offer` 兜底改回 `queued`(消息不丢,回执不失真);② 核心与 ws 层职责相应调整:`UplinkResult.deliveries` 改为投递结果回调,或 ws 层投递失败时调用核心的补偿入箱方法;③ trio 补用例:注入目标 readyState=CLOSING / sockets 缺席 → 断言发送方收到 `queued` 且消息可补投。

---

### DIST-4|major|连接表按 nodeId 无守卫覆盖,旧连接迟到 close 踢除新连接

- **位置**:`packages/gateway/src/ws.ts` L59-60(`core.connect({connId: newId(), nodeId, …})` + `this.sockets.set(nodeId, ws)`——同 nodeId 二次连接直接覆盖,旧 socket 不关闭)、L74-79(close 处理:`this.sockets.delete(nodeId); this.opts.core.disconnect(nodeId)`——**不比对 connId**);`packages/gateway/src/core.ts` L72-78(connect/disconnect 均按 nodeId 键控)。
- **问题**:经典重连竞态:旧 TCP 半开,客户端重连先到,服务端 maps 已指向新连接;旧 socket 的 close 事件随后才触发(服务端感知滞后/写失败),`delete(nodeId)` 把**新连接**从 `sockets` 与 `connections` 双表剔除。此后该节点在服务端「无认证连接」:上行一律走 core.uplink 的防御分支被**静默丢弃且无任何回执**(core.ts L106-111),下行被当成离线入箱/拒存——节点自己认为在线,客户端 ws 正常,只有审计里 `acl_rejected_from_pin: 无认证连接`。消息黑洞持续到节点下一次重连。触发面被客户端放大:`gateway-client.ts` 的 `ws.on('error')`(L56)与 `ws.on('close')`(L78)都会 `scheduleReconnect()`,网络异常通常两者齐发 → **双定时器并发 open()**,同节点双连接成为常态而非意外。`GatewayConnection.connId` 字段存在却全程未参与注销判定,证明防护缺失。
- **依据**:01 §9(连接态是 presence 权威,连接表错乱即 presence 与路由全部失真);02 §8;本评审重点「连接表」条目。
- **建议**:① close 注销加身份守卫:`if (this.sockets.get(nodeId) === ws) { delete; core.disconnect(conn.connId) }`;`core.disconnect` 改按 connId;② `connect` 时若已存在同 nodeId 旧连接,先以语义码关闭旧 socket(服务端裁决「后到为准」),消除双活;③ 客户端加「连接进行中」守卫(单一定时器/状态机),error 分支不再独立排程重连;④ 补确定性用例:同节点先连 A 后连 B,A 关闭 → 断言 B 仍可收发。

---

### DIST-5|major|重连路径丢失 A6 反馈语义:4001/4002 不可分辨、吊销节点无限重连、退避无抖动

- **位置**:`packages/gateway/src/ws.ts` L52-55(握手时 `!node || node.status !== 'active'` 一律 `ws.close(4003, 'unauthorized')`——suspend/revoked 与 token 错误不可分辨);`packages/node/src/gateway-client.ts` L71-79(close 后无条件 `scheduleReconnect`)、L176-186(退避 `min(25ms × 2^min(n,6), 5s)`,无抖动、无终态停止、error+close 双路径重复排程)。
- **问题**:A6/D28 的核心设计是「**复用连接做反馈信道**,节点本地呈现『本机已被团队 owner 暂停/吊销』」。实现里语义 close code(4001/4002)只送达「suspend/revoke 发生时恰好在线」的连接(`syncRegistry` L92-100 扫描);一旦节点在暂停后重连(常态:suspend 断连 → 客户端自动重连),握手被拒走 4003 'unauthorized',客户端**无法区分「凭证配错」「被暂停」「被吊销」**,于是:① suspended 节点以 5s 一次无限敲门直到 resume,合理但无任何本地呈现;② **revoked 节点(终态)以 5s 一次永久敲门**,A6 反馈完全失效;③ 三种情况用户面均为「连不上网关」,与设计明文相悖。退避无随机抖动 + 封顶 5s:网关重启后 N 个节点同步重连(雷群),与「重连风暴」评审重点直接对应;收到 4002 语义码后客户端也没有停机分支(L152 对 `closing` 帧直接忽略,随后 close 触发的仍是无差别重连)。
- **依据**:02 §7 A6、D28;02 §6.1(suspend/revoke 语义);本评审重点「ws 重连风暴与退避」。
- **建议**:① ws 握手对 suspended/revoked 改发语义 close 4001/4002(或 auth_ok 前先发 `closing` 帧),仅真凭证错误用 4003;② 客户端:onClose(4002) → 停机 + 呈现「本机已被吊销」;4001 → 长退避(如 30s+)+ 呈现「已被暂停」;4003 → 常规退避并告警;③ 退避加 ±20-50% 随机抖动,重连定时器单一化;④ trio 补用例:suspend 后重连 → 断言收到 4001(而非 4003)且客户端停止风暴。

---

### DIST-6|major|`routing.denied` 一律终局化删除 outbox:把目录同步滞后的瞬时误拒变成永久丢消息

- **位置**:`packages/node/src/gateway-client.ts` L141-151(`routing.denied` → `this.outbox.remove(d.msg_id) // 终局,不重发`);`packages/gateway/src/acl.ts` L56-65(目标不在目录 → `not_team_member` 拒绝);`packages/gateway/src/ws.ts` L103-107(目录快照靠 50ms 轮询,新 enroll 节点在快照推进前必然「不在目录」)。
- **问题**:设计对回执的定位是「**仅诊断与体验,不参与可靠性**」(01 §9;02 §7 A6 对 routing.denied 同口径)。实现把 routing.denied 提升为可靠性终局(删 outbox、不再重发),对 `acl_rejected_cross_team`(伪造信号,重试确无意义)尚可辩护;但对 `not_team_member` / `not_active`,存在**必然发生的误拒窗口**:收件人刚 enroll、网关快照尚未轮询到(跨进程部署下轮询间隔只会更大),或发送节点状态同步短暂滞后——此时合法消息被拒、被删、永不再发,且发送方拿到的是终局回执,连「改派触发」都会据此错误触发。01 §9 给 aid 定义的「rejected → 立即改派」之所以成立,是因为 aid 的 TTL 只有 10s 且改派是新决策;把同一逻辑无差别套到所有 routing.denied 上,等于让「诊断回执」接管了「可靠性真相」,正是 D26 要防的「第二套真相」。
- **依据**:01 §9(回执仅诊断/不参与可靠性,D26);02 §7 A6(routing.denied 仅诊断与体验);02 §7.1(目录缓存「落后即回源」——实现无回源,见 DIST-12)。
- **建议**:① `routing.denied` 分级处理:`acl_rejected_cross_team` 终局删除;`not_team_member`/`not_active` 保留 outbox 并触发目录重同步(向注册中心拉新快照/重连),同步后有限次重发,仍拒再终局 + 审计;② 若坚持全部终局,必须回写 01 §9/A6 明示「routing.denied 参与可靠性终止」并论证误拒窗口的补偿(当前没有补偿);③ trio 补用例:快照滞后窗口发送 → 同步 → 断言消息最终送达。

---

### DIST-7|major|R11 outbox 无持久化实现,且连接存活期间无退避重发

- **位置**:`packages/node/src/outbox.ts` L16-33(仅 `MemoryOutbox`,全仓无其他 `OutboxStore` 实现);`packages/node/src/gateway-client.ts` L103-108(`flush()` 仅在 `auth_ok`(L126)或调用方手动触发,无周期/退避定时器;L27 `attempts` 只增无人读)。
- **问题**:两处与 R11 字面不符。① 01 §6 R11:「关键消息(result/fail/cancel/accept/reject)发送方**本地持久化**(outbox)」——现唯一实现是内存 Map,进程重启即丢:执行方算完 result 未及发送即崩溃,结果永久丢失,牵头方只能走租约超时回收(白烧一个 attempt);「中心不可达 → 结果入 outbox 重连补发」的降级面声明(R11)对崩溃场景不成立。② R11:「未获回执**按退避重发**」——重发唯一触发点是重连成功的 flush;连接长存而某条 ack 丢失(回执帧同样走不可靠通道)时,该消息**永远不再重发**,`attempts` 字段无任何消费方。R-MATRIX L21 仍标「R11 …… 🔲 M3」,与「M2 已实现 outbox + 回执消费」的账实不符(账实问题归 QA 视角,此处只记语义缺口)。
- **依据**:01 §6 R11、D26;`QLONG_IMPL_PLAN.md` M2.2。
- **建议**:① 提供 `FileOutbox`(或 sqlite),复用 node 包 `JsonFileStore` 的 tmp+rename 写入先例,启动时加载重发;② 增加 flush 定时器(建议 `min(30s, backoff(attempts))`,按 entry 的 `lastAt` 逐条退避),auth_ok 时照旧立即 flush;③ R-MATRIX R11 行按实际覆盖改写。

---

### DIST-8|major|join 换队后存留连接成为黑洞:连接身份不随目录刷新,无重握手信号

- **位置**:`packages/registry/src/directory.ts` L213-226(`joinTeam` 仅改归属 + bump epoch,无任何断连/通知动作);`packages/gateway/src/acl.ts` L29-31(A0 以握手时钉死的 `conn.teamId` 核对 `from.team_id`,失配 → **静默丢弃**);`packages/gateway/src/ws.ts` L90-101(`syncRegistry` 只扫 status 变化做断连,不扫 `conn.teamId ≠ 目录 team_id`)。
- **问题**:节点 join 换队后:目录快照与逐节点缓存正确推进(旧队不可达 ✓,有专测 acl-core L146-157),但该节点**既存 ws 连接的 `conn.teamId` 仍是旧队**。此后它对新队友发包:若出站信封按惯例携带 `from.team_id = 新队`(trio/信封示例均携带),A0 判 `from.team_id ≠ conn.teamId` → **静默丢弃,无回执、无断连、除审计外无任何信号**;客户端 ackWaiter 超时、消息滞留 outbox,直到某次偶然重连才自愈——而节点完全没有重连的理由(它认为自己在线)。02 §4.2/§7.1 只声明了「换队后**旧 team** 立即不可达」,未定义节点自身连接的处置;实现选择了「什么都不发生」,恰好落在最差的缝里。
- **依据**:02 §4.2(join 换队)、§7.1(换队 bump epoch)、§7 A0;01 §9(回声分级——静默仅适用于「未认证/伪造」,诚实节点换队后的正常消息被静默属误伤面)。
- **建议**:① `syncRegistry` 增加扫查:`conn.teamId ≠ 目录 entry.team_id` → 语义 close(建议 4004 'team-changed/reauth',回写 02 A6 码表)强制重握手,重握手后 `authenticate` 返回新 team,连接身份自然刷新;② 或 A0 命中 team 失配时降级为 `routing.denied`(rule A0,reason_code 'stale_connection')给客户端一个可见信号;③ trio 补用例:join 后旧连接发包 → 断言被语义断连 → 重连后投递成功。

---

### DIST-9|major|注册中心零持久化 + epoch 跨重启回退,被网关单调卫兵永久拒收

- **位置**:`packages/registry/src/directory.ts` L103-110(全部状态为内存 Map,`directoryEpoch = 0` 起步;文件头 L3-4 仅承认「跨进程并发」为开放问题,未提持久化/重启);`packages/gateway/src/core.ts` L53-57(`setDirectory`:`if (snapshot.epoch < this.directory.epoch) return`——纯单调卫兵,无实例身份概念)。
- **问题**:目录多副本/高可用是 02 §12.2 承认的开放问题,本条不重复;要指出的是**单实例重启**这一 v1 缺省行为的后果无人承认:① `Registry` 无任何持久化,重启后全部 node token 哈希丢失 → 全网节点对注册中心与网关 A3 同时 401/4003,唯一出路是 owner 重新签发 enroll token 全员重入网,**节点身份(node_id)全部不连续**——trace、TOFU 首连钉扎的 node_id→pubkey、outbox 里的在途消息全部指向旧身份;② 若网关进程与注册中心不同生命周期(跨进程形态,M2.3 双进程仿真正是该形态),重启后的 registry epoch 归 0,网关的 `epoch < current` 卫兵将**永远拒绝**新注册中心的快照——目录分裂为「网关持有旧真相、注册中心另起炉灶」,且无任何告警。02 §7.1 的 epoch 单调性以「epoch 永不回退」为隐含前提,这个前提在唯一 shipped 的实现里不被保证。
- **依据**:02 §7.1(epoch 单调)、§12.2(开放问题仅承认多副本,未承认单实例重启语义);P12(失败关闭不应等于「失败即全网重置」)。
- **建议**:① v1 最小修:快照携带 `registryInstanceId`,`setDirectory` 对「epoch 回退 + 实例变更」重置缓存并告警,对「epoch 回退 + 同实例」拒绝(状态错乱);② 或将 nodes/tokens/epoch 持久化(仓库已有 JsonFileStore/tmp+rename 先例,sqlite 也在选型清单);③ 至少在部署注记/README 明文:「v1 注册中心与网关须同生命周期,单独重启注册中心 = 全网重入网」;④ 补用例:registry 重建(epoch 0)后网关行为有定义。

---

### DIST-10|minor|「网关停路由」对非 active 目标不生效:revoked/suspended 节点仍可被投递/暂存

- **位置**:`packages/gateway/src/acl.ts` L56-83(A1 锚定只查目标**存在与归属**,不查 `status`);`packages/gateway/src/core.ts` L144-149(在线即 delivered)、L157(离线即入箱);`directory.ts` L293-300(revoke 后节点仍在快照中,收件箱不清理)。
- **问题**:02 §6.1 明文「revoke:…… + **网关停路由** + 主动断连(4002)」「suspend:停用 token 与**网关路由**」。实现里 A2 只拦**发送方**,目标为 revoked/suspended 时:同步滞后的在线窗口内照常 `delivered`;离线则 project 消息持续入箱——revoked 节点的收件箱永无补投(重连被 A3 拒),变成纯死存储,而发送方拿到的 `queued` 回执对「永不可达」的目标构成误导性的可靠性信号。
- **依据**:02 §6.1(suspend/revoke 语义)、§10 威胁表「被吊销节点残留作恶」行(缓解含网关拒路由)。
- **建议**:路由裁决前校验目标 `status === 'active'`(至少 `!== 'revoked'`),失败按 A1 口径回 routing.denied(`not_active`);revoke 时清空其收件箱并审计;补确定性用例。

---

### DIST-11|minor|收件箱语义三小疵:溢出丢弃无审计、drain 先清后发、构造期重复初始化

- **位置**:`packages/gateway/src/mailbox.ts` L13-24(`offer()` 返回类型 `'stored' | 'full'`,L23 两支同值——`'full'` 为死分支;容量满丢最旧无任何审计);L27-37(`drain()` 先整体清空再返回,投递失败不回填);`packages/gateway/src/core.ts` L41 与 L49(`inbox` 字段初始化 capacity 0 后又在构造器重建,首初始化无意义)。
- **问题**:① 容量溢出丢最旧本身符合设计(容量是存储保护),但 01 §11 的精神是「静默丢弃应可观测」:溢出丢的可能正是未达的关键消息,却无 `inbox_overflow` 类审计事件,返回值死分支又使调用方无从感知;② `drain` 清空后若 ws 发送失败(连接又断),这批消息既不在箱也未送达——「至少一次」的网关存储腿全靠端上 TTL/R11 兜底,设计虽容忍,但一行「发送失败回填 `offer`」即可消除该损失面;③ 重复初始化属代码卫生。
- **依据**:01 §9(投递语义:至少一次)、01 §11(审计基线精神);`mailbox.ts` L20 注释自述「容量上限是存储保护,不是可靠性机制」。
- **建议**:溢出时记审计事件(事件枚举随 01 §11 演进);`takeInbox` 改为「确认发送后移除」或失败回填;删死分支与重复初始化。

---

### DIST-12|minor|目录同步是 50ms 同进程全量轮询:§7.1 的「推送/回源」均未落实,跨进程无集成面

- **位置**:`packages/gateway/src/ws.ts` L103-107(`startRegistrySync(registry, 50)`:`RegistryLike` 要求**进程内对象引用**,每 50ms 全量 `snapshot()` + 逐 socket 状态查询);`packages/registry/src/http.ts` 全文(无任何面向网关的端点:无目录快照拉取、无 presence 上报、无管理事件推送);`packages/gateway/src/acl.ts` L8-11(`DirectoryLookup.snapshotEpoch` 字段声明了「回源」形态,实现从未使用)。
- **问题**:02 §7.1:「bump 并**主动推送**到各网关实例(网关为目录变更的**订户**)」;缓存条款是「落后即**回源**」。实现是同进程轮询:① 推送=宿主自觉起定时器(trio 里 20ms 手写一行,L44),没有任何订阅机制;② 「回源」实为「快照换代即重扫内存」,网关**不会**发现「自己的快照落后于注册中心」(唯一可知的时机是收到更小 epoch 的快照,而这正是 DIST-9 的死局);③ 滞后窗口内新 enroll 节点无法被寻址(配合 DIST-5/6 放大成永久后果);④ 跨进程部署(M2.3 验收明列「**双进程仿真**跑通 A1」)所需的注册中心 HTTP 面——目录快照、presence、管理事件——一项都不存在,当前 trio 实为单进程内直连对象引用,与验收口径有距离。50ms 全量快照的 O(nodes) 开销在 v1 无害,仅注记。
- **依据**:02 §7.1、§9(目录-网关系行);`QLONG_IMPL_PLAN.md` M2.3。
- **建议**:registry HTTP 面补三个网关端点:`GET /v1/directory?since_epoch`(304 表示无更新,替代全量轮询)、`PUT /v1/gateway/presence`(批量连接态上报)、suspend/revoke 的推送或网关长轮询;网关侧 lookup miss 时按 `snapshotEpoch` 回源一次再裁决(失败关闭不变);在 ws.ts 头注明确「startRegistrySync 为同进程测试形态」。

---

### DIST-13|nit|包导出面缺口:gateway 不导出 ws 适配器,node 仍缺 M1 指出的三个 lead 模块且存在重复导出

- **位置**:`packages/gateway/src/index.ts` L1-4(仅 types/acl/mailbox/core,`WsGateway` 只能深路径引用);`packages/node/src/index.ts` L1-11(无 `lead/checkpoint`、`lead/supervisor`、`lead/store`;`driver.js` L3/L6、`local/harness.js` L9/L11 重复导出)。
- **问题**:与 M1 评审 DIST-14 同型且部分未修:M2/M3 的组合根(网关宿主、cli serve)按正规包入口拿不到 ws 适配器与接管组件;重复导出行暴露合并残留。
- **依据**:`docs/review-m1/REVIEW_DIST.md` DIST-14;IMPL_PLAN §2 包骨架约定。
- **建议**:`gateway/index.ts` 补 `export * from './ws.js'`;node 补三模块并去重;CLI 深路径引用一并改包入口(M1 已提)。

---

### DIST-14|nit|aid 判定读 `body.kind`:与 P3「中心不读 body」存在未回写的张力

- **位置**:`packages/gateway/src/types.ts` L24-25(注释称「01 §9 aid 不暂存是设计明文允许的唯一 body 访问」)、`core.ts` L152(`envelope.body.kind`)。
- **问题**:01 §9 只写了「aid 类不暂存」的**行为**,未写网关以何种字段判别 aid;`kind` 在签名的 body 内,网关不验签、无法核实,发方误报仅影响暂存决策(后果有界:误报 aid → 少暂存、发送方立即改派;误报 project → 多暂存、R2 端上兜底)。实现的选择合理,但「设计明文允许」言过其实——按 IMPL_PLAN §5「实现偏离一律走文档回写」,应补一句设计授权,而非让代码注释代行解释。
- **依据**:01 P3、01 §9(aid 类不暂存)、IMPL_PLAN §5。
- **建议**:回写 01 §9 一句:「网关可为 aid 不暂存读 `body.kind`,该读取不作信任依据、不参与任何路由/安全裁决」;或演进时把 `kind` 上移信封头(属设计变更,另议)。

---

## 亮点

- **ACL 语义层质量高**:`acl.ts` 纯函数 + `core.ts` 引擎分层干净,A0 钉扎/A1 目录锚定/A2/A6 回声分级与 02 §7、D27/D28 逐字吻合;「伪造 to.team_id 必须被网关拒绝」的 I-13 确定性测试到位(acl-core L85-94),A0 伪造静默无回执、A1/A2 rejected+routing.denied 双帧的回声分级精确。
- **目录 epoch 的核心机制正确**:`setDirectory` 单调卫兵 + 逐节点缓存携带快照 epoch、换代重扫(core.ts L53-69),「换队后旧 team 立即不可达」有专测(acl-core L146-157);registry 侧 join/suspend/resume/revoke/轮换/enroll 全部 bump epoch(directory.ts L134-137),与 §7.1 的触发清单一致。
- **收件箱核心语义完整**:aid 不暂存回 `offline_not_stored`、project queued、补投时 `exp` 剔除 + `exp_rejected` 审计(acl-core L160-182),与 01 §9/I-11/I-53 对齐;「容量是存储保护、不是可靠性机制」的定位注释准确。
- **enroll 消费原子在单进程成立且边界诚实**:`enroll()` 的 consumed 写入与入网在同一同步块(directory.ts L176-186),HTTP 层异步间隙不破坏原子性;「恰好一端 200/409 used」有测试;`directory.ts` 头注对「跨进程并发属开放问题」的声明态度端正(但持久化缺口另见 DIST-9)。
- **纪元现势三态齐备**:`lookupPubkey` 的 current/historical/unknown_epoch + 非 active 回源拒绝(directory.ts L248-259、http.ts L179-187),「查无此 epoch ≠ 已吊销」错误码分离,兑现 §6.2。
- **trio 三方联调是真实 ws + 真实签名**的端到端(非 mock),outbox 未获回执保留、重连后同 msg_id 重发并清理的 R11 主链路有真实断言(trio L156-163)。

## 开放问题(非缺陷,提请后续里程碑注意)

1. **网关多副本下的连接表/收件箱边界(02 §12.1 已承认,不另立意见)**:本版 `connections`/`inbox` 均为单实例内存态,节点重连到另一副本即丢失连接上下文与暂存。建议在 `GatewayCore` 接口注释**显式钉死「单实例假设」**,防止 M3 双机剧本把它当分布式组件直接扩展;v1 若允许网关多端口/多进程共存,close code 与收件箱行为需先定义。
2. **ackTimeoutMs 与「慢」的区分**:客户端 5s 超时仅是调用方观感,消息仍留 outbox(正确);但上层(M3 牵头方)如何区分「慢」与「丢」、何时依据 `offline_not_stored` 触发 aid 即时改派(01 §9),需要 M3.2 定一页判定规则。
3. **ws 保活与 presence 僵尸**:两侧均无 ping/pong,半开连接下「连接即在线」会长期失真(影响 DIST-2 的权威性与 aid 即时改派的前提)。建议 M3 双机走查定保活周期与死亡判定(如 30s pong 超时断连),并纳入 presence 语义。
4. **`enroll_token_in_flight` 错误码当前不可达**:单进程同步处理下并发 enroll 直接串行化为 200/409 used(I-31 契约满足);该码为多进程形态预留,建议注释标明,避免被误判为死代码删除。