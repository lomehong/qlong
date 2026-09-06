# 群龙 R-矩阵:规则 → 测试用例追溯

> 01 §6 要求「每条规则都应可追溯到测试用例」。本表随里程碑持续推进;✅=已有自动化测试,🔲=已排期(标注所属里程碑)。
> 测试位置:core = packages/core/test, node = packages/node/test。

## R 规则(01 §6,R0–R11)

| 规则 | 测试 | 状态 |
|---|---|---|
| R0 attempt 统一闸门 | core/semantics「R0 attempt 闸门」×5;node/lead「R0 迟到旧 attempt」;node/executor「R0③ 隐式取消」+ property 全序 | ✅ |
| R1 幂等去重 | core/semantics「R1 去重」×3 + property(同体 duplicate/异体 mismatch/progress 豁免/保留期逐出) | ✅ |
| R2 offer 有效期 | core/semantics「R2 offer_ttl 晚于才过期」;node/executor R2(补投 offered 态) | ✅ |
| R3 租约/心跳 | core/params(lost=230s/110s、心跳=lease/3、不变式断言);lead 心跳续租;executor 心跳 seq/回执续租/自超时暂停 | ✅ |
| R4 回收与改派顺序 | lead:fail→cancel 先入通道、drain 赛跑 result→done、expired 先撤销、验收失败归途;🔲 ack 提前收口用例排 M3 仿真 | ✅(部分) |
| R5 僵尸防护 | executor 赛跑 A/B 两例;lead reclaiming 收 result → done | ✅ |
| R6 NACK 优先 | executor 各拒绝路径即时回执(闸2/3/4/expired);沉默被状态机排除 | ✅ |
| R7 双预算 | lead:dispatch_rounds 耗尽 escalate(结构化摘要);fail_non_retryable 不烧 attempt;accepted 预算(A3 用例) | ✅ |
| R8 改派排除 | lead:busy(retry_after)不排除;持久失败记 excluded 表(过滤在 supervisor 选目标时执行,M2 集成) | ✅(部分) |
| R9 无广播 | 信封一对一由校验器+网关保证 | 🔲 M2 |
| R10 payload 解析基线 | 临时拉取器(M3.4)+ scheme 白名单/私网拒绝测试 | 🔲 M3 |
| R11 发送侧 outbox | 网关回执帧消费 + outbox 重发(M3.2) | 🔲 M3 |
| §7 委托链 | hops ≤ MAX_HOPS(envelope 校验);trace 透传与 parent_span(M3 双机联调验证) | ✅(部分) |

## ACL(02 §7 A0–A6)

全部 🔲 M2 网关实现时落确定性断言(A1 目录锚定、A6 回声分级、close code 4001/4002、伪造 to.team_id 拒绝等,清单见评审报告 I-13/I-14 修订)。

## 五道闸(03 §6)

| 闸 | 测试 | 状态 |
|---|---|---|
| 1 签名 | core/sig.spec ×6(含 alg 白名单/unknown_key/body 篡改) | ✅ |
| 2 策略 | node/executor 闸2(优先级:先于闸3) | ✅ |
| 3 能力 | node/caps.spec ×5(D31 匹配语义全集)+ executor 闸3 missing 明细 | ✅ |
| 4 负载 | node/executor 闸4(busy + retry_after_ms) | ✅ |
| 5 执行档案 | 沙箱与 requires 渲染(M4.2) | 🔲 M4 |

## 状态机转移

lead 9 例 / executor 11 例覆盖 §5.1/§5.2 关键转移(正常主路径、四类失败归途、赛跑、竞态、预算、取消)。完整 (状态 × 消息 × 定时器) 矩阵随双机纸面走查定稿(01 §6,评审 I-04 建议)。