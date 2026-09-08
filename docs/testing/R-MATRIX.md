# 群龙 R-矩阵:规则 → 测试用例追溯

> 01 §6 要求「每条规则都应可追溯到测试用例」。✅=已有自动化测试;🔲=已排期(标注里程碑)。
> 位置:core/node/registry/gateway 各自 test 目录。M2 评审修订后更新(2026-09)。

## R 规则(01 §6,R0–R11)

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
| R10 payload 基线 | 临时拉取器 scheme 白名单/私网拒绝 | 🔲 M3 尾 |
| R11 发送侧 outbox | trio/lost-redelivery 重发清理;🔲 FileOutbox 持久化(M3 收口前) | ✅(部分) |
| §7 委托链 | hops 校验;trace 透传(session seal/cross-machine) | ✅ |

## ACL(02 §7 A0–A6)

A0 钉扎 ×2、A1 锚定+伪造 to 拒绝(I-13)、A2 非 active、A3 缺/坏 token 4003、A4 坏签名静默、A5 防御兜底、A6 回声分级+4001/4002 → gateway/acl-core + trio + ws-hardening 全覆盖 ✅。

## 五道闸(03 §6)

闸1 core/sig ×6+trio A4 ✅;闸2 ✅;闸3 caps ×5+missing ✅;闸4 ✅;闸5 执行档案 🔲 M4。

## 注册中心(02 §9)

enroll 原子/过期/无效、join epoch、轮换三态、suspend/revoke 错误码、caps/load、通讯录过滤、错误信封、P12 失败关闭 → registry ×17 ✅(跨进程并发留集群化议题)。