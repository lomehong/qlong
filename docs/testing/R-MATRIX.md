# 全链故障矩阵(P3 / R-MATRIX)

> 状态:v2 全链版(2026-09-19,取代文末 v1 时代追溯表——那份对应 M2 评审时点,v2 持久重构后以本表为准)。
> 本文是系统可靠性的**单一对照表**:每行 = 一条规则/不变量 × 故障注入 × 预期行为 × 自动化覆盖。
> 用法:① 演练故障注入(走查剧本二/五)前对照本表选取注入点;② 新增故障回归先在本表登记行再写测试;
> ③ 标 ⚠️ 的行 = **无自动化覆盖**,依赖演练人工注入——这是演练的核心任务清单。
> 覆盖列只列代表用例(全量见各 spec);发现表与实现失配,先改本表再改码(与走查剧本同一纪律)。

## 1. 端上任务可靠性(01 篇 R0–R11 / D 系)

| # | 规则/不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| R0 | attempt 闸门:陈旧 attempt 的 accept/progress/result 一律拒 | 旧 lead 迟到 accept(接管后 attempt 已 +1) | R0 stale_attempt 拒,状态不回退 | durable-lead-takeover.spec • fence 后旧执行方迟到 accept 被 R0 拒;durable-executor.spec • stale_attempt 守卫 |
| R1 | 幂等:同 (发送方,msg_id) 重发不重复执行;同 ID 不同正文拒绝 | 同 ID 重发/重签名变体 | 幂等消化或 409,绝不复活 payload | runtime-store.spec • JCS 去重含签名字节;server-custody.spec • 拒绝同 ID 变体且不删源 |
| R2/R9 | offer TTL 双端独立判过期;严格到期不投 | offer 过期后才送达;custody exp 到期 | reject(expired)/expired 墓碑,重试不延长寿命 | custody-store.spec • exp 精确到期留墓碑;transport-v2.spec • strictly expired nack |
| R3 | 租约与心跳:progress 即续租;lost = 2×(lease/3)+grace | 执行方停跳 | lead reclaim→drain→attempt+1 改派 | durable-executor.spec • 心跳序号持久;durable-lead.spec • lease 定时器 |
| R3b | 业务续租(lease-renewal):progress 回绑 renew,fence 绑定 | 陈旧/伪造 renew | 执行方拒续(fence 不符),死线不变 | durable-lease-loop.spec • progress→renew 互操作;跨重开持久 |
| R4 | 终态优先与赛跑窗口:reclaiming 收 result → done;验收失败 cancel+attempt+1 | result 与 reclaim 竞态;验收判 false | done / acceptance_failed 改派;撤销期不得翻 done | durable-lead.spec • result/fail 终态;machine • reclaiming/cancelling 分支 |
| R5/R6 | 快速拒绝与限流:policy_denied/caps 不匹配即 reject,不占槽 | 无 driver/无产物仓/caps 缺失 | reject(原因码),slot 不动 | durable-node.spec • 无 driver 拒单、PROJECT 无产物仓 policy_denied |
| R7 | 预算与升级:max_attempts 耗尽 → escalate,不无限改派 | 连续 retryable fail | escalated 终态 | durable-lead.spec • 改派预算/升级 |
| R8 | 排除表:失败节点 once/permanent 避开 | 改派时选择器遇到被排除节点 | 不再派给它 | target-select.spec • 排除表;takeover fence 重派 |
| R10 | payload 拉取不跟随 3xx;私网/scheme 白名单 | 重定向与私网探测 | redirect: error 拒绝 | registry-verifier 及 join fetch(redirect: 'error');payload-git 拉取白名单 |
| R11 | 发送侧 outbox:未获 stored 不清账;stored 丢失可对账 | stored 回执丢失/乱序 ACK | 重发同 msg_id;旧/假 ACK/NACK 不清 outbox | gateway-custody.spec • 仅匹配 stored 释放 custody;server-custody.spec • stored 丢失重开后对账 |
| D24 | 新鲜性:exp + 漂移预算 | 过期信封 | 静默丢弃 + 审计,无回执 | core freshness;gateway exp 分支 |
| D26 | 关键消息签名(JCS) | 重签名/篡改 | 验签失败拒入 | runtime-store • 含签名字节去重;server-custody • 他钥签名不回执 |

## 2. custody 传输(v2 三个持久边界 + 有界行为)

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| C1 | store-then-push:payload 先落库再推送;在线/离线同路 | 推送前崩溃 | 重开补投,顺序不变 | custody-store.spec • stores before returning, never shifts;server-custody • 离线 custody 跨重启 |
| C2 | 票据绑定当前连接(发送者/消息/摘要/目标/connId) | 伪造/过时票据/换连接重放 | 不释放 payload;重复票据无害 | transport-v2.spec • 票据绑定与重复无害 |
| C3 | 背压有界:每连接 ≤16 在投、退避重投、bufferedAmount 停写 | 接收端不回执/写阻塞 | 窗口封顶,共享定时器恢复续推 | transport-v2.spec • 16 上限与 backpressure |
| C4 | DB 故障不伪装成功:COMMIT 失败 → 1011/停接入,保留现场 | offer/收件 COMMIT 注入失败 | 发送方 payload 保留,修复后补投;绝不发 stored/ACK | server-custody • 中心/收件 COMMIT 故障两用例;transport-v2 • SQLite offer 失败 |
| C5 | 限额与配额:身份数/payload 字节/每目标 pending 封顶,满则拒收 | 超限 | FULL/CONFLICT 可解释拒绝(非磁盘损坏) | custody-store • 配额 SQL 不变量 |
| C6 | 过期留痕:expired 墓碑持久,重复接管不延长 | 重试/reopen | 墓碑保留,寿命不续 | custody-store • exp 用例 |
| C7 | 保留窗口 GC 只回收终态墓碑,绝不删 pending | retention 到期 | received/stored 墓碑回收,pending 完好 | server-custody • retention GC 用例 |

## 3. 中心存储与恢复(SQLite 层)

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| S1 | 所有权独占:一数据目录单写者;锁损坏进 recovery | 双进程争用/锁库损坏 | OWNERSHIP_BUSY / 拒绝而非删锁 | storage lock.spec • 双冷竞争者/损坏锁 |
| S2 | schema 追加迁移:checksum 校验,绝不重写既有版本 | v1 库上开新中心 | 追加 v2..v4,v1 数据与校验和原样 | server-custody • v1→v4 迁移用例 |
| S3 | 缓存不领先提交:COMMIT 失败全回滚且不发布缓存/通知 | mutator 抛错 | 读旧缓存,epoch/presence 不动 | registry durable.spec • 回滚用例;server-durable • COMMIT 故障停接入后恢复 |
| S4 | 注册中心恢复:teams/keys/invites/grants/tasks/audit 全量重开 | 停机重开 | 数据完整;presence 恢复为 offline | registry durable.spec • reopen 用例 |
| S5 | 投影权威在牵头方:中心只存 lead 声明,修订单调 | 乱序/降修订/伪造 lead 上报 | 409/401,绝不覆盖 | task-projection.spec • 修订单调与鉴权 |

## 4. 节点事务存储与恢复

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| N1 | 身份 pinning:一库一节点,绝不重新 pin | 换 node_id 开同一库 | 拒绝 | runtime-store.spec • identity pin |
| N2 | 事务原子性:inbox 决议+状态 CAS+outbox+意图同事务;回调不得 IO | consume 中抛错 | 全回滚,无半状态 | runtime-store • CAS 回滚;durable-node • COMMIT 故障 fail-closed |
| N3 | 重启 pending 重授权:验签失败留 pending 定时重试 | registry 瞬断 | 不放大为永久拒绝,恢复后补消费 | durable-node.spec • 重启 pending 用例 |
| N4 | 损坏 fail-closed:状态/句柄/墓碑损坏 → recovery,绝不静默重建 | 篡改 lead:v2 / runhandle 值 | 抛错 fail-closed | durable-lead • 损坏拒恢复;run-handle-store • 损坏 undefined |
| N5 | 孤儿可判定:持久 PID ESRCH → stopped;存活/不可证 → unknown | 跨重开的已退出/存活孤儿 | stopped(settle 不重放 start)/recovery_required | fenced-driver.spec • recover 矩阵;run-handle-store • 跨重开两向 |
| N6 | 驱动围栏:精确 fence(start 恰一次;超时 SIGTERM→SIGKILL;spawn 失败不重试) | 重复 start/超时/spawn 失败 | 恰一次执行 + failed(原因码) | fenced-driver.spec • 全组 |
| N7 | 关停收口:静默在跑 run + 有界 flush 终态入 outbox | stop 时在跑任务 | 终态落库再断连,不伪造成功 | durable-node • stop flush 用例 |

## 5. 牵头/接管/单机归属(C2 + 单机形态)

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| T1 | attempt 高水位仲裁:本地 ≥ 导入 → fenced;终态 → archived | 双主回退尝试/终态 bundle 导入 | 跳过/归档,本地状态不被覆盖 | durable-lead-takeover.spec • 全组 |
| T2 | 接管续接:在途 → attempt+1 归位 drafting,task_seq/renewalSeq 单调续接 | 接管后重派 | 新 offer attempt+1,投影序号续接 | durable-lead-takeover • fence 重派;C2d takeover e2e |
| T3 | 单 exec 归属:stale_attempt 守卫 + lead+attempt 身份匹配 + busy 串行 | 双 lead 竞争同一执行方 | 只认高水位,单槽不双跑 | durable-executor • C2b 组 |
| T4 | 单机自洽:自派单 offer/renew/cancel 路由进本机执行半 | 单龙 originate→self | 全链 done,不滞留 | durable-node.spec • 单机形态自派单闭环 |
| ⚠️ T5 | 活孤儿安全接管(依赖 E1 进程身份证据;E1 已跳过) | 存活孤儿 + 接管 | 现状 unknown/recovery_required(安全但不可自动接管) | 无——演练人工注入项 |
| T6 | R8 排除:offer TTL 过期 / 租约 lost 的静默目标进排除表('once')✅ 已修(2026-09-19 同机演练发现,TDD) | 死节点目标过期/失联 | excluded[target]='once',重派避开死节点 | lead.spec • expired/lost 静默目标进排除表;演练实录(走查 §6.0) |
| T7 | 接管撞单槽:重派单被仍在执行原 attempt 的节点 policy_denied(单槽 + 租约未到期,行为正确) | 接管窗口与原租约重叠 | 拒单不双跑;接管节奏应避开原租约或先 cancel | 演练实录(走查 §6.0);durable-executor • busy 串行 |

## 6. 集群归属(D1 claim 注册表 + 中继)

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| K1 | generation 单调 fencing:跨进程/跨重启绝不复用 | 重连/抢占/重启 | 高 generation 恒胜;renew 被超越 → fence-drop 4000 | claim.spec • 单调组;cluster-claim.spec • 跨进程收敛 |
| K2 | TTL authority-liveness:节点零额外帧;死 authority 租约到期 reap | 停 authority | ≤TTL 内归属可判定,他 authority 可 claim | claim.spec • TTL;presence-lifecycle • 续租/fence-drop |
| K3 | 中继 best-effort:通知丢失靠周期泵兜底;fence 守卫拒绝非现主泵 | peer 不可达/伪造 generation | stored 不受影响;pumped:false;交付仍达 | custody-relay.spec • 全组 |
| K4 | 中继端点失败关闭:错密钥 403/畸形 400/claim 库故障 500 | 无头攻击/存储故障 | 不伪装成非现主 | custody-relay • 鉴权;relay-pump.spec • 500 语义 |
| K5 | claim 库损坏 → recovery,绝不静默重建 | 篡改 gateway_claim | StorageError fail-closed | claim-store.spec • 损坏用例 |
| ⚠️ K6 | 双 authority 实物部署(CLI gateway-only 形态) | 真实双进程 + 真实网络 | — | 无自动化(所有权锁限制);演练暂以单中心为准,形态落地后启用剧本 4 |

## 7. 产物验收(E2)

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| A1 | 清单绑定 fence:task/attempt/署名者,缺一不验 | 换任务重放清单 | 验收判 false → acceptance_failed | ARTIFACT-ACCEPTANCE §0(P0 加固组) |
| A2 | 无产物仓 → PROJECT policy_denied(验收防线) | 执行方未配 artifactRepo | 拒单不执行 | durable-node.spec • e2d-2d |
| A3 | 真实 git 端到端:发布签名产物 → collect+验签+契约核对 → done | 篡改产物/契约不符 | 验收失败改派 | e2d-4 真实 git 端到端(正/反向) |

## 8. owner 命令(E3)

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| O1 | 越权隔离:节点只见 lead=自己的命令 | 他节点 PULL | 空集 | command-store.spec • lead 过滤 |
| O2 | at-least-once + 幂等:ack 前崩溃 → 重拉重应用 | 崩溃注入/重复拉 | cancel 对终态 no-op,redispatch 幂等 | OWNER-COMMAND §5;command-route.spec |
| O3 | owner 鉴权:会话 CSRF / QLONG_OWNER_TOKEN,节点 token 不可创建 | 伪造创建者 | 401/403 | command-route.spec • 鉴权组 |

## 9. 旧数据迁移(F1/P2)

| # | 不变量 | 故障注入 | 预期 | 自动化覆盖 |
|---|---|---|---|---|
| M1 | 离线只读预检:inspect 不写任何源 | inspect 期间 | 源文件零改动 | migrate-read.spec(slice1) |
| M2 | 事务化导入:全成全败,绝不半迁移 | 导入中途失败 | 回滚,目标库无损 | migrate-import(slice2) |
| ⚠️ M3 | 导入后复核:verify 对账源/目标计数与摘要 | slice3 未实现 | — | 待 slice3;真实旧数据迁移须另行授权(计划 line114) |

## 10. 无自动化覆盖、依赖演练人工注入的空白清单

以下注入点没有(或无法有)自动化等价物,是**双机实物演练的核心任务**(对照走查剧本二/五):

1. ⚠️ 物理断网/弱网:中心不可达期间执行方跑完当前 attempt、结果入 outbox 重连补发(R11 降级面);
2. ⚠️ 进程强杀/掉电:节点与中心在 I/O 任意点被 kill -9 / 断电(storage 子进程强杀测试是抽样,非全链);
3. ⚠️ 真实模型超时:dsh 真实任务的 30 分钟硬上限、stdout 尾部截断、模型凭证缺失路径;
4. ⚠️ 时钟漂移:双机时钟差逼近 exp 漂移预算(10 分钟)时的行为;
5. ⚠️ 物理磁盘压力:真实磁盘满(注意 S 层已有受控 SQLITE_FULL 注入);
6. ⚠️ 双机接管全人工流程:lead export → 人工传输 → run --takeover,含篡改 bundle 的渗透自检(剧本 5);
7. ⚠️ 长时运行:GC 后容量、WAL 增长、内存稳定性(≥24h);
8. ⚠️ K6 双 authority 实物形态(待 gateway-only CLI 落地)。

> 维护纪律:每笔提交边界新增故障回归时,同步在本表登记;发现表与实现失配,先改表再改码(与走查剧本同一纪律)。

---

## 附录:v1 时代追溯基线(M2 评审时点,历史保留)

> 下表对应 v1 演示栈时点;v2 持久重构后以上方全链矩阵为准。保留作审计线索。

| 规则 | 测试 | 状态 |
|---|---|---|
| R0 attempt 闸门 | core/semantics ×5+property;node/lead 迟到旧 attempt;executor R0③ 隐式取消;gateway lost-redelivery 竞态 | ✅ |
| R1 幂等去重 | core/semantics ×3+property(同体/异体/progress 豁免/保留期) | ✅ |
| R2 offer 有效期 | core/freshness 晚于边界;gateway lost-redelivery 过期链路 | ✅ |
| R3 租约/心跳 | core/params lost 公式+不变式;lead 续租+定时器泄漏回归;executor seq/回执续租/暂停;gateway lost-redelivery 真实时序判 lost | ✅ |
| R4 回收与改派顺序 | lead cancel 先入通道/drain 赛跑/ack 提前收口/expired 先撤销;gateway lost-redelivery 端到端 | ✅ |
| R5 僵尸防护 | executor 赛跑 A/B;lead reclaiming 收 result 过验收 | ✅ |
| R6 NACK 优先 | executor 拒绝即时回执;ws 硬化坏帧 rejected | ✅ |
| R7 双预算 | lead escalate 结构化摘要;fatal 不烧 attempt;跨机连败场景 | ✅ |
| R8 改派排除 | lead excluded 表 + lost-redelivery 排除后选 C | ✅ |
| R9 无广播 | 信封一对一(校验器+网关) | ✅ |
| R10 payload 基线 | 临时拉取器 scheme 白名单/私网拒绝 | ✅(v0.7 已落地) |
| R11 发送侧 outbox | trio/lost-redelivery 重发清理;v2 custody outbox 全量替代 FileOutbox | ✅ |
| §7 委托链 | hops 校验;trace 透传(session seal/cross-machine) | ✅ |

ACL(02 §7 A0–A6):A0 钉扎、A1 锚定+伪造 to 拒绝、A2 非 active、A3 缺/坏 token 4003、A4 坏签名静默、A5 防御兜底、A6 回声分级+4001/4002 → gateway/acl-core + trio + ws-hardening 全覆盖 ✅(v2 下由 custody admit 复用)。
五道闸(03 §6):闸1 sig ✅;闸2 policy ✅;闸3 caps ✅(D2 后与网关 grant 执法单一实现);闸4 ✅;闸5 执行档案 → v2 由 DurableRun/RunHandle + 产物清单承接 ✅。
注册中心(02 §9):enroll/epoch/轮换/suspend/revoke/caps/load/错误信封/P12 → registry 全覆盖 ✅。
