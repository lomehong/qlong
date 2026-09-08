# 群龙双机走查剧本(WALKTHROUGH-2NODE)

> 对应:实现总体规划 §1 验收清单 A1–A10;双机 = 同 team 的节点 A(牵头)与 B(执行)。
> 运行形态:registry(HTTP)+ gateway(ws)+ 两个 qlong 节点进程;自动化对应 packages/gateway/test/cross-machine.spec.ts 与 lost-redelivery.spec.ts。

## 前置

1. registry 与 gateway 已启动,目录同步 < 50ms。
2. team X 已创建;A、B 分别持有效 enroll token 入网(token 单次、TTL 30 分钟)。
3. B 具备能力标签 tool:node@20(闸3 匹配输入)。

## 剧本

| # | 步骤 | 预期 | 验收项 |
|---|------|------|--------|
| W1 | A、B 入网 | 各得 node_id/team_id/node_token;通讯录互见(online=true) | A1 |
| W2 | A 派 aid 单 → B 五道闸通过 → accept → 驱动执行 → result | A 侧 done(attempt=1) | A2 |
| W3 | A 派 project 单(带 contract.acceptance)→ B 回 acceptance_results 全过 → done;验收失败 → cancel(acceptance_failed)+attempt+1 | A 侧 done / 重做 | A3 |
| W4 | B 执行中心跳停止 → A 判 lost(≈2×lease/3+grace)→ cancel(reclaim)→ drain → 改派 C(attempt+1)续跑 | done(attempt=2)或 escalate | A4 |
| W5 | 重放旧 offer → B 去重忽略;exp 过期信封 → 静默丢弃 + exp_rejected 审计 | 无二次执行;审计留痕 | A5 |
| W6 | 派 required_caps 给无标签节点 → reject(unsupported_caps)+missing → 改派有标签节点 → done | A6 |
| W7 | 注入越权任务书(读 SSH key/写工作区外)→ 执行档案拒绝或转本地人确认 | A7 |
| W8 | 仅凭双机本地日志 + trace_id 还原一次派单全生命周期 | 关联五字段齐备 | A8 |
| W9 | 网关注入:伪造 from / 伪造 to.team_id / 非 active 发送 / 未认证连接 | 全部拒绝且审计正确(A0–A2/A6) | A9 |
| W10 | 以上全部由自动化测试覆盖并通过 | 回归绿 | A10 |

## 判定

- 全部步骤通过 = 双机走查通过(验收 A1–A10 闭环)。
- 失败处理:记录偏差 → 回写设计文档或修实现 → 重跑本剧本。

## 当前状态

- W1/W2/W4(改派段)/W5/W9 已由 cross-machine.spec、lost-redelivery.spec、ws-hardening.spec 及 core/node 单测覆盖(✅)。
- W3 acceptance_results 链路、W6 能力反馈链路、W7 执行档案沙箱 → M4;W8 日志还原 → M3 收口核验。