# 群龙派单全矩阵:(状态 × 消息 × 定时器)

> 状态:**v1,与 `packages/node/src/lead|executor/machine.ts` 实现逐格对齐**(双机纸面走查回填件,评审 I-04)。
> 本矩阵是三样东西的唯一事实源:①状态机实现规格;②一致性测试的用例生成清单;
> ③双机联调的预期断言。改机器必须先改本表。
> 约定:**忽略** = 丢弃且不计审计;**丢弃+审计** = 静默丢弃 + 审计事件;回执按 A6 回声分级(02 §7)。

## 一、牵头方状态机(每个 task_id 一份,`lead/machine.ts`)

状态:`drafting → offered → running → reclaiming →(drafting 循环)→ done / failed / escalated / closed`
终态优先级(并发裁决):`done > closed > failed > escalated`。

### 1.1 消息 × 状态(attempt 已过 R0 闸:≠ 当前 attempt 走 §1.4)

| 状态 \ 入站 | task.accept | task.reject | task.progress | task.result | task.fail | task.cancel.ack |
|---|---|---|---|---|---|---|
| **drafting** | 忽略 | 忽略 | 忽略 | 忽略 | 忽略 | 忽略 |
| **offered** | 来自 target → **running**(停 offer_ttl,起 lease=now+2×interval+grace;记录 acceptedThisAttempt) | 来自 target → 记 history(rejected+code)→ R8 排除 → **预算判定**:耗尽→escalated;否则 → **drafting** + requestDispatch(attempt+1) | 忽略 | 忽略 | 忽略 | 忽略 |
| **running** | 忽略 | 忽略 | 来自 target → **续租**(重排 lease 定时器;心跳即续租,不驱动状态机) | 验收通过 → **done** ✅;验收失败 → cancel(acceptance_failed)→ **reclaiming**(R4) | retryable=false → **failed** ✅(R7 立即终态);retryable → cancel(reclaim)→ **reclaiming** | **忽略**(语义仅在 cancelling/reclaiming;I-07) |
| **reclaiming** | 忽略(R0:同 attempt 已决) | 忽略 | 忽略 | 赛跑窗口内:验收通过 → **done**(drain 命中,指标+1);验收失败 → 记 acceptance_failed,继续窗口 | retryable=false → **failed** ✅(R4,窗口立即关闭语义);retryable → 记 history,继续窗口 | **首个 ack → 提前收口**(drainClosed=true)→ 预算判定 → drafting+requestDispatch 或 escalated |
| **cancelling**(用户/上游取消) | 忽略 | 忽略 | 忽略 | **done**(竞态:完成交付优先,terminal 优先级最高;I-06) | **closed** | **closed** |
| **done / failed / escalated / closed**(终态) | 忽略 | 忽略 | 忽略 | 忽略 | 忽略 | 忽略 |

### 1.2 定时器 × 状态

| 定时器 \ 状态 | 触发条件与转移 |
|---|---|
| `offer_ttl` | offered 态到期 → history(expired)→ **reclaiming**(R4:先撤销后改派,评审 I-08) |
| `lease` | running 态到期(判定公式:2×(lease/3)+grace;**早于死线的泄漏触发按死线重排,不判 lost**)→ history(lost)→ cancel(reclaim)→ **reclaiming**(审计 reclaim/lease lost,指标 lost+1) |
| `drain` | reclaiming 态到期且未提前收口 → drainClosed=true → 预算判定 → drafting+requestDispatch 或 escalated |
| `cancel_wait` | cancelling 态到期 → 强制 **closed** + 审计(I-06 出口超时) |

### 1.3 预算判定(进入 drafting 前的最后闸,R7)

- 本次 attempt **已 accept** 且后续失败 → `acceptedFailedBudget+1`;
- 从未被接受(reject/expired/不可达)→ `dispatchRounds+1`;
- 任一预算 ≥ 上限(max_attempts / max_dispatch_rounds,默认各 3)→ **escalated**(结构化事件:attempts 历史 + final_reason);
- 否则 → **drafting** + requestDispatch(attempt+1) → 宿主经 pickTarget 提供下一目标(R8 排除表 + 03 §7 能力记忆软降权)。

### 1.4 R0 外来 attempt(一切 task.* 入站先于上表)

| 入站 attempt | 处置 |
|---|---|
| < 当前 | 回 `reject(stale_attempt)` + **审计 stale_attempt_rejected**(限已验签同队) |
| > 当前 | **丢弃 + 审计**(同 task 更高 attempt offer 的"隐式取消"特例在**执行方**侧,§2.1) |

### 1.5 用户取消(任一非终态)

→ 发 `task.cancel(reason=user)`(有 target 时)→ **cancelling**,起 `cancel_wait`。
出口三选一:任一终态消息(§1.1 cancelling 行)/ cancel_wait 超时强制 closed+审计 / 竞态 result→done。

## 二、执行方状态机(单执行位,`executor/machine.ts`)

状态:`idle → offered → running → result_sent / fail_sent / stopped / cleaned / rejected`;v1 单执行位:非 idle 时异任务 offer 一律 `reject(busy)`。

### 2.1 task.offer 入站(先 R0/R1 已决防重跑,后五道闸)

| 前置 | 处置 |
|---|---|
| 会话暂停开关(03 §6.3) | `reject(busy, retry_after 30s, detail=本地已暂停)` |
| per-source 限速超限(03 §6.3) | `reject(busy, retry_after 60s, detail=来源限速)` |
| 同 task 已交付/已终局且 attempt ≤ 本地 | **忽略**(R1/已决防重跑) |
| 同 task 在途 offered/running:attempt 相同 | **忽略**(重复 offer,R1) |
| 同 task 在途:attempt < 本地 | `reject(stale_attempt)` + 审计 |
| 同 task 在途:attempt > 本地 | **隐式取消旧态**(停驱动)→ `reject(stale_attempt)`+旧态摘要 → 按新 offer 重评(R0③/I-04③) |
| `exp` 已过期(D24) | `reject(expired)`(离线补投死单) |
| 异任务且执行位占用 | `reject(busy, detail=v1 单执行位)` |
| 五道闸(§6 03 篇) | 闸2 策略 → policy_denied;闸3 → unsupported_caps(+missing);闸4 → busy;闸5 → 确认或 policy_denied |
| 全过 | → **offered**,发 accept(lease_ms 确认),排 `ttl_check` / `heartbeat` / `lease_self` |

### 2.2 offered/running 态事件

| 事件 | 处置 |
|---|---|
| `task.cancel`(attempt 对齐) | running → 停驱动 → **stopped** + `cancel.ack`;已完成未交付 → 仍发 result+`completed_before_cancel`(R5 赛跑);result_sent → 仅 ack 带标记,不重发(I-39) |
| `ttl_check` 到期(offer_ttl 过) | `reject(expired)` |
| `heartbeat` 到期 | 发 `task.progress`(seq 单调,续租载体);**送达回执(网关 ack)→ 续租时钟推进**(R3,评审 M3-DIST-1) |
| `lease_self` 到期(R3 执行方对称计时器) | **暂停驱动**(不再产生新副作用;链路恢复后自动复活,M1-QA) |
| 驱动完成 | `result_sent` + result(status=done,summary=stdout 尾部,acceptance_results) |
| 驱动失败 | `fail_sent` + fail(码走 §4.3 登记表;missing_caps 触发 03 §7 自愈) |
| 更高 attempt 的同 task offer | 见 §2.1 隐式取消(R0③) |

### 2.3 心跳/租约参数(R3,默认)

心跳间隔 = `lease_ms/3`;连续错过 2 个心跳 + `grace_ms` → 牵头方判 lost;
**不变式:`grace_ms ≤ lease_ms − 2×(lease_ms/3)`**(执行方本地租约不早于牵头方判 lost)。

## 三、测试生成清单(每格至少一条用例)

- §1.1 十二个非平凡格(含竞态 result→done、cancel.ack 提前收口、retryable=false 窗口内 failed);
- §1.2 四定时器各一正例 + lease 泄漏触发重排一例;
- §1.3 双预算边界(acceptedFailedBudget = maxAttempts−1 再失败 → escalated)各一;
- §1.4 三分支 + 更高 attempt offer 的隐式取消特例;
- §2.1 暂停/限速/已决防重跑/隐式取消/exp 过期/单执行位 busy;
- §2.2 赛跑三态(完成先于 cancel / cancel 先于完成 / result 已发不重发)。
