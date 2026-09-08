# 测试与可观测性专家评审意见（群龙 Qlong 设计 01–03 篇）

> 评审对象：`docs/QLONG_DESIGN_01_MSG_PROTOCOL.md`（下称 01）、`docs/QLONG_DESIGN_02_REGISTRY_TRUST.md`（下称 02）、`docs/QLONG_DESIGN_03_CAPABILITY.md`（下称 03），并参照 `QLONG_DESIGN_NOTES.md`（纪要）与根 `README.md`。
> 评审视角：仅限规则可测试性、状态机转移覆盖、可观测性与验证策略；协议/信任/能力模型本身的设计取舍交给其他评委。

## 结论

**verdict：需重大修订。**

架构方向与工程直觉优秀，但可靠性核心章节（01 §5/§6）存在 blocker 级语义缺口：attempt 一致性没有成为所有入站 task.* 消息的统一前置闸门，多处状态转移未定义（迟到 accept/reject、终态后收消息、cancelling 无出口），照稿实现会在多节点间产生分歧行为乃至双执行。好消息是：所有缺陷都是**可增量补齐的规则缺失**，不动信封结构、不推翻任何决策 D1–D22。建议按问题清单补齐后再冻结信封与语义（P1 的"一次定死"应包含状态机全矩阵，而不只是字段表）。

## 摘要

01–03 篇的可测性意识在同类设计中属上乘：相对时长（P5/D10）、四 ID 分工、NACK 拒绝码枚举、失败关闭都可直接落成断言。但 §5/§6 存在 blocker 级缺口：attempt 校验只散落在 R1 去重键与 R5 单点规则中，未上升为统一闸门；迟到 accept、progress 晚于 cancel、执行方终态后收消息、用户取消路径收到 result、cancelling 出口等转移全部未定义。可观测性方面，trace 之外的断言锚点整体缺位：审计事件格式、指标、日志关联规范、escalate 事件四项全无；02 的 API 错误形状未定义使契约测试无从落笔；03 §7 自愈摘标签既无误摘防护、也无任何恢复路径，误报一次即永久损失真实能力。文中给出了四层测试策略（单机双进程仿真 / 离散事件仿真 / 故障注入清单 / 状态机模型检查）作为修订后的验收基线建议。

## 问题清单

### QA-1 ｜ blocker ｜ 01 §5.1/§5.2 + §6 R1/R4/R5 —— attempt 前置闸门缺失，多处状态转移未定义

**问题与依据：**
1. 「attempt 一致性」目前只是两处零散规则：R1 去重键 `(task_id, attempt, type)` 的一部分，以及 R5 对**迟到的旧 attempt result** 的单点处理。它没有被定为**所有入站 task.\* 消息的统一前置闸门**。R1 去重解决的是"同一条消息重投"，不解决"同一 attempt 的**不同**消息在错误状态下到达"。
2. 具体未定义转移（逐条给出场景）：
   - **迟到 accept（最危险）**：offer(attempt=1) 超时未应答 → 牵头方按 R2 判 rejected(expired)、attempt+1 改派 → 此刻迟到的 accept(attempt=1) 到达。牵头方此前从未收到过 accept(attempt=1)，R1 去重拦不住它；若实现按 task_id 匹配状态，它会被误认作**对新 offer 的接受**——于是旧执行方与新候选同时认为任务在手，双执行。R5 只覆盖了 result/fail 的迟到场景。
   - **迟到 reject**：同上时序，reject(attempt=1) 在改派后到达，处置未定义。
   - **progress 晚于 cancel**：牵头方已进 cancelling/closed 后收到 progress（心跳续租），转移缺失——cancelling 态续租无意义，必须显式定义忽略。
   - **用户取消路径收到 result**：`cancelling`（用户取消）路径不增 attempt；执行方按 §4.2 cancel.ack 行的约定发来 `result(completed_before_cancel)`，但牵头方状态机中 cancelling → 收到 result 的转移未画（R4 的 drain 窗口只覆盖 reclaim 路径，不覆盖 user 路径）。
   - **执行方终态后收到消息**：result_sent/fail_sent 之后收到 cancel（R5 只规定了发送 result 前的自检，没规定终态后的入站处置）、收到重投 offer（R1 的"已 accept 则忽略"只写到 accept 时点）。
   - **running 态收到未经 cancel 触发的 cancel.ack**（场景与成因见 QA-2）。
   - **终态优先级**：§5.1 写"任一态 ── attempt > max_attempts ──▶ escalate"，"任一态"与 cancelling/closed 重叠时（drain 末期同时满足升级与用户取消），escalate 与 closed 谁赢未定义——模型检查的第一步就卡在这。

**修改建议：**
在 §6 新增一条规则（建议编号 R0，置于 R1 之前）：「入站 task.\* 一律先做 attempt 判定：`attempt < 本地当前 attempt` → 拒收（可回则回 reject(stale_attempt)）+ 审计；`attempt = 当前` → 交状态机；`attempt > 当前` → 丢弃 + 审计」。同时补一张 **(状态 × 消息 × 定时器) 全覆盖矩阵**（牵头方、执行方各一张），每一格写明「转移 / 忽略+审计」，明确包含上述七处；终态优先级必须唯一（建议：已完成交付的 done > 用户取消的 closed > escalate，并写明判定顺序）。这张矩阵同时就是一致性测试的用例生成源。

### QA-2 ｜ major ｜ 01 §6 R5 + §10 —— 租约判定两侧不对称，有效结果可被强制丢弃且产生未定义的主动 cancel.ack

**问题与依据：**
R5 规定执行方"本地租约已超时不发 result，回 cancel.ack"，而牵头方判 lost 需"连续错过 2 心跳 + grace_ms"。按默认参数：lost 时刻 = 上次心跳 + 2×(lease/3) + grace = 上次 + 200s + 30s = 230s，**早于**执行方本地租约的 300s，两者相安无事。但"判 lost 时刻 ≤ 执行方本地租约到期"这一不变式没有被写成约束——`grace_ms > lease_ms − 2×(lease_ms/3)`（默认即 grace > 100s）时不变式即破。破坏后的连锁：执行方已完成的**有效结果被 R5 强制丢弃**、不发 fail，执行方侧任务无终态；同时它会向**仍处于 running 态**的牵头方发出未经 cancel 触发的 cancel.ack——该转移未定义（QA-1 已列）。执行方白干且无回执，牵头方只能靠自己的超时单方面回收。

**修改建议：**
①在 §10 参数表加显式不变式 `grace_ms ≤ lease_ms − 2×(lease_ms/3)`，或给执行方对称宽限：本地租约过期 ≤ grace 内完成的结果仍允许发出（复用 `completed_before_cancel` 标记语义）；②定义 running 态收到 cancel.ack 的转移（建议：忽略 + 审计，cancel.ack 仅在 cancelling/reclaiming 态有语义）；③给该场景命名测试用例：「执行方本地租约刚过期、牵头方仍在宽限内完成」。

### QA-3 ｜ major ｜ 01 §5.1 + §6 R4/R5 —— cancelling 状态无出口条件，cancel.ack 丢失路径无界

**问题与依据：**
§5.1 图中 `cancelling ──▶ closed` 没有标注触发条件。用户/上游取消后，若 cancel.ack 丢失或执行方早已死亡，牵头方在 cancelling 停留多久、凭何转 closed，全文无定义。对比之下 reclaiming 至少有 drain 窗口这个显式定时出口。出口无界直接导致：①「每个 task 有限时间内到达终态」这一最基本的活性性质无法成立，超时类测试与状态机模型检查都写不出来；②实际实现会各自发明等待上限。

**修改建议：**
给 cancelling 定义截止：如 `max(drain_ms, grace_ms)` 窗口内未收 cancel.ack 即转 closed 并写审计事件；同时明确 cancel 是否重发、重发几次（与 R1 幂等兼容）。在状态机图上把这条定时边画出来。

### QA-4 ｜ major ｜ 01 §4.2 + §6 R4/R5/R6 —— reject 方向矛盾、drain 内 fail 语义缺失、completed_before_cancel 未进字段表

**问题与依据：**
三处契约不自洽，均直接影响一致性断言：
1. R5 要求牵头方"直接拒收并回 reject(stale_attempt)"，但 §4.2 消息表中 `task.reject` 方向仅为**执行→牵头**；执行方状态机也没有"收到 reject"的转移。同一条消息两个方向、两种语义，表却只登记了一个方向。
2. R4 规定 drain 窗口内"同 attempt 的 result/fail 仍接受"，但接受 fail 之后做什么未定义：`fail(retryable=false)` 时窗口应否立即关闭？其后走 attempt+1 改派还是按 R7 升级？retryable 如何参与改派决策，全文只字未提。
3. `completed_before_cancel` 只出现在 §4.2 cancel.ack 行的括号注记里，result body 字段表 `{status:"done", summary, artifacts[], files[]}` 中没有该字段——字面实现时它无处安放。

**修改建议：**
①把 reject 声明为双向消息类型，给执行方补「收到 reject(stale_attempt) → 本地记账/清理 → 终态」转移；②定义 drain 内 fail 语义（建议：retryable=false 立即关闭窗口进 escalate；retryable=true 按 R7/R8 继续）；③result body 表补 `completed_before_cancel: bool`（缺省 false），并注明它同时也是 QA-2 中宽限补交的标记。

### QA-5 ｜ major ｜ 01 §6 R1 —— 去重键生命周期与"同键异体"处置未定义

**问题与依据：**
至少一次投递（P4）意味着重投可能迟到任意久，而 R1 只给了去重键、没给去重**表的生命周期**：随 task 终态释放还是带 TTL？窗口过期后的重投会被当新消息重新进状态机（若按 QA-1 加了 attempt 闸门则有兜底，但这一兜底依赖关系应写明，否则实现者意识不到去重表可以不永久保留）。另一未定义点：**同键不同 body** 的重投（牵头方重发 offer 时 summary 已被修改）——按键忽略？还是视为协议违规？不同实现必然分叉，幂等测试无法写死预期。

**修改建议：**
定义去重表生命周期（建议：task 终态后保留 ≥ max(offer_ttl_ms, lease_ms) + drain_ms）；明确「同键异体 → 丢弃 + 审计事件 `dedup_mismatch`」。配套测试：重放 offer 并篡改一个 body 字段，断言丢弃行为与审计事件。

### QA-6 ｜ major ｜ 01 §4.2/§6 R6/R10 + 03 §7 —— fail 的 reason_code 全集从未枚举

**问题与依据：**
R6 只枚举了 **reject** 的八种拒绝码；**fail** 的码表全文缺失，散落出现的有 `deadline_exceeded`（01 R2）、`env_missing`（03 §7）。R10 的负载解析失败——sha256 不匹配、ref 不可达、仓库被删、size 不符——该用什么码、retryable 与否，完全没有定义。而 R7/R8 的改派决策恰恰依赖 retryable 与 reason；03 §7 的自愈闭环更是以 `env_missing` 这个未定义精确语义的码为触发器（见 QA-11）。没有 fail 码表，"该场景必须回什么码"的一致性断言无从写起。

**修改建议：**
在 §6 增设与 R6 同格式的 fail reason_code 枚举表，至少含：`deadline_exceeded`、`env_missing`、`payload_unavailable`、`payload_corrupt`、`internal_error`、`cancelled_by_executor`，每个码标建议 retryable 值；明确「未知 fail 码按 `other` 归类 + 审计」（另见 QA-14）。

### QA-7 ｜ major ｜ 01 §9 + 02 §8 —— 网关投递回执/错误帧未定义，aid 类"离线即改派"没有触发信号

**问题与依据：**
01 §9 规定 aid 类 offer"目标离线即按不可达处理，牵头方立即改派"。但协议中不存在任何投递回执或错误帧：ws 通道上"已送达对端 / 已入收件箱 / 目标离线拒收（aid 类）"对发送方分别是什么信号、什么形状，均未定义。02 §8 说 presence 权威 = 网关连接态，但这个权威状态对牵头方**没有协议面的可观测出口**。没有该契约，"立即改派"的触发只能靠各实现自行发明（ws 发送异常？本地超时？），确定性测试写不出来；这也是 01 §3.1 信封没有回执类消息的明显缺口。

**修改建议：**
在 §9 定义网关层最小回执帧，例如 `{ack_type: delivered|queued|rejected, msg_id, reason?}`（rejected 含 `offline_not_stored`、`acl_rejected` 等）；并显式声明回执**仅用于诊断与改派触发判定，不参与可靠性**（可靠性仍由 P4/R1 端上兜底），避免与端上语义产生第二套真相。

### QA-8 ｜ major ｜ 02 §9 —— API 错误形状未定义，契约测试无法断言

**问题与依据：**
七个端点只定义了 happy path。错误 body 结构、错误码枚举、401/403/404/409/410 的使用语义全部缺失。两个必须可断言的并发场景没有答案：①两台设备同时用同一个单次使用 enroll token 调 `POST /v1/enroll`，谁 200、谁得什么错、原子性由什么保证；②`PATCH /v1/nodes/me` 携带过期 caps_rev 时的冲突语义。错误形状不定，客户端无法区分可重试与不可重试，注册中心的契约测试一条都写不了。

**修改建议：**
给出统一错误信封 `{code, message, retryable?, details?}` 与错误码表（如 `enroll_token_invalid / enroll_token_expired / enroll_token_used / not_team_member / node_revoked / key_epoch_conflict`）；把并发 enroll 钉死为可测断言（"恰好一端 200，另一端 409 `enroll_token_used`"）。

### QA-9 ｜ major ｜ 01 §3.3（第 4 条）+ 02 §7 A0/A1/A2、§5.3 —— 审计事件被多处引用，格式从未定义

**问题与依据：**
「审计」在至少五处出现（01 验签失败、02 A0 钉扎失配、A1 跨队拒绝、A2 目录缺失、§5.3 token 用后留痕），但审计事件的 schema、字段、时间基准、事件枚举、留存与查询方式全篇为零。A0/A1/A2 是安全执法点，审计是它们唯一的旁证输出——格式不定，安全验收测试（"伪造 from 被拒**且留痕**"）只能断言一半。与 trace/task_id 的关联方式也没有约定，事后无法把安全事件拼回任务链路。

**修改建议：**
定义统一审计事件 schema（建议 `{event, ts, node_id, reason, envelope_head_digest, trace_id?, task_id?, attempt?}`），给出 v1 事件枚举：`acl_rejected_from_pin / acl_rejected_cross_team / acl_rejected_not_active / sig_verify_failed / dedup_mismatch / stale_attempt_rejected / reclaim / escalate / cap_tag_suspected / cap_tag_removed` 等；强调遵守 P3：只记信封头摘要，不记 body。

### QA-10 ｜ major ｜ 01 §5.1/§6 R7 + 全文 —— trace 之外的可观测性基线整体缺位（指标、日志关联、escalate 事件）

**问题与依据：**
§7 的 trace 三元组是好的起点，但只有 trace 无法运维一个租约制派单系统：
1. **指标零定义**。调 §10 参数表（grace/drain/max_attempts 的取值是否合理）完全依赖这些数据：判 lost 次数、drain 窗口命中率（`completed_before_cancel` 的频率直接反映 drain_ms 设 30s 够不够）、attempt 分布、reject reason 直方图、心跳到达间隔抖动、escalate 率。
2. **日志关联规范缺失**。§7.2 只要求 progress 携带 trace；没有"每条与任务相关的日志必须含 `trace_id/task_id/attempt/msg_id`（外加 `key_epoch`）"的强制规范，跨机还原全链路会因字段不齐而拼不起来。
3. **escalate 没有事件定义**。R7 只说"交回上层/用户"——没有结构化 escalate 事件，就没有聚合视图，"多少任务、停在哪个状态、因何种原因升级"不可知；而 escalate 是系统对用户可见的失败终态，恰是最需要聚合的信号。

**修改建议：**
①把上述六项列为 v1 必发指标最小集；②立「日志关联规范」小节，强制至少四字段（trace_id/task_id/attempt/msg_id）；③定义 escalate 结构化事件（含 final_attempt、last_state、reason 链、耗时）与按 reason/目标节点的聚合视图；④把"双机走查后，仅凭双方本地日志 + trace_id 离线还原一次派单全生命周期"立为可观测性的验收测试（与纪要 §8 评审注记的双机纸面走查同场进行）。

### QA-11 ｜ major ｜ 03 §7（反馈闭环）+ §6（五道闸）—— 自愈摘标签存在误摘风险且无任何恢复路径

**问题与依据：**
03 §7 的自愈规则是"同一标签被多次 `env_missing` 命中（阈值本地定）→ 自动从静态档案摘除并上报"。三个叠加缺陷：
1. **`env_missing` 判定标准未定义**：docker daemon 此刻没起、磁盘瞬时写满、拉镜像时网络闪断，都可能被任务失败路径归因为"能力缺失"。闪断误报即计入命中。
2. **阈值无时间窗、无冷却、无复核要求**："多次命中"可以是三天内两次，也可以是十分钟内三次，语义完全不同。
3. **摘除后零恢复路径**：probe 已明确不做（§7），静态标签又是"检测到变更（装了新工具）才上报"——被误摘的真实能力**永远不会自动回来**，该节点对这类任务永久出局，且无审计事件、无对外可观测信号，人工都难以发现。对一个以"能力档案是搜索索引"为定位的系统（03 §1），这是索引静默劣化。

**修改建议：**
①收紧 env_missing 语义：必须来自本地**确定性检查**（二进制/服务存在性、许可证文件等一次性轻量验证，属失败时复核，不是被否掉的周期性 probe），禁止仅凭任务失败推断；失败码先按 QA-6 区分 transient（`internal_error`/`payload_unavailable`）与能力缺失；②摘除改两段式：先 `cap_tag_suspected` 软摘除（档案保留、默认排除出候选），TTL 内未复发自动恢复，复发或本地复核失败才 `cap_tag_removed` 硬摘；③阈值带时间窗（如 10 分钟内 ≥3 次）+ 冷却期；④两个事件均进 QA-9 的审计枚举并计数上报（进 QA-10 指标）。

### QA-12 ｜ minor ｜ 03 §3.1/§3.2 —— 匹配语义两处含混

**问题与依据：**
①"无 `@` = 前缀匹配"若按字面字符串前缀理解，`tool:node` 会命中 `tool:node-foo`，而 `env:python` 与 `env:python3`、`tool:node` 与 `tool:nodejs` 这类现实近似名会互相误配/漏配——匹配是系统的"搜索索引"核心算子，语义必须无歧义。②§3.1"未知类不参与匹配"若同样适用于注册中心的目录过滤，则老中心遇到新节点上报的新类能力（如 `ml:tpu`）时，`caps=ml:tpu` 过滤结果恒空——中央索引永远查不到新类能力，版本倒退成能力黑洞。

**修改建议：**
①匹配算法定义为：取值段（去掉 `@` 及其后内容）做**全等**比较，带 `@` 时再比版本段；②未知类改为"按整串精确匹配"而非"不参与匹配"，为向前兼容留出正确路径。

### QA-13 ｜ minor ｜ 01 §6 R2/R3/R8 + §10 —— 边界与判定公式未钉死

**问题与依据：**
边界值是超时类测试的全部价值所在，但四处不可断言：①"收到时已过期"是 `>` 还是 `≥` TTL，未写；②project 类 offer 经收件箱暂存后补投，TTL 自发送时刻起算早已流逝——离线一天的节点上线后收件箱内 project offer 会整批 `reject(expired)`（行为符合 R2 兜底设计，但这一批量场景应进测试清单）；③R3"连续错过 2 个心跳 + 宽限"未给精确公式（应为 `t_last_progress + 2×interval + grace`？），lost 判定时刻无法断言；④R8"排除最近一次失败节点"中，`reject(busy)`、`reject(expired)`、判 lost 是否都算"失败"未定义——决定改派候选池的构成。

**修改建议：**
统一写明比较符与 lost 公式；把"长期离线节点上线后的收件箱过期潮"列为离散事件仿真的必测场景；R8 明确失败的定义（建议：fail(任意 retryable) 与判 lost 排除，带 `retry_after_ms` 的 reject(busy) 不排除）。

### QA-14 ｜ minor ｜ 01 §8 —— 未知枚举值的处理未定义

**问题与依据：**
版本演进规则只覆盖未知 `type`（回 reject(unsupported_version)），未覆盖**未知枚举值**：收到枚举外的 reason_code（reject 或 fail 的）如何处理没有约定。这正是"新增字段必须被旧实现忽略"照不进的地方——枚举值不是字段，旧实现既不认识也不忽略它。混版本运行时，新增的拒绝/失败码会让旧节点行为不可预测。

**修改建议：**
补一条：「未知 reason_code 一律按 `other` 归类处理 + 审计」，与 fail/reject 码表（QA-6）同场发布。

### QA-15 ｜ minor ｜ 02 §8 + 01 §9 —— presence 权威与 v1.5 局域网直连的误判应列为已知场景

**问题与依据：**
在线权威 = 网关连接态（02 §8/D17），而 01 §9 把局域网直连列为 v1.5 里程碑：两节点直连可达但均未连网关时，目录查询显示双方 offline → 按现行规则 aid 类 offer 直接改派，而实际可直连投递。v1 可接受，但该误判必须进已知限制清单——否则 v1.5 落地时 R2 与改派路径的全部测试预言要推翻重写。

**修改建议：**
在 02 §8 或 01 §9 的 v1.5 段补一句「直连可达但网关离线的节点，v1 一律按离线处理」，并列入测试策略的已知限制与 v1.5 回归范围。

### QA-16 ｜ nit ｜ 01 §4.1 —— rpc.answer 的 request_id 应答时应必填

`rpc.answer` body 的 `request_id` 标为可选。应答类消息应强制回带 `request_id`（与 `reply_to` 双保险），否则"超时重发、同 request_id 去重"场景的关联测试少一个可断言锚点。

## 建议的测试策略

修订落定后，建议按四层建立回归基线，从下至上，每层只补上层覆盖不到的东西：

1. **第一层：单机双进程仿真。** 同机拉起两个 qlong 实例，loopback + 真实 ws + 真实签名。验证信封结构、验签（含"静默丢弃不回声"的零字节断言）、A0 钉扎、R1 去重、03 §6 五道闸次序。01 §6 开篇"每条规则应可追溯到测试用例"的要求，先在这层逐条落成 `R1-用例-1…R10-用例-n` 的映射表。
2. **第二层：离散事件仿真（虚拟时钟）。** 事件队列驱动 + 可编程的时延/丢失/乱序，把 R2/R3/R4/R5 的全部边界（TTL ±1ms、drain 关闭前 1ms 的 result、宽限最后一毫秒的心跳）做成确定性用例；同 seed 可复现，进 CI。铁律：所有超时类规则禁止墙钟 sleep 测试——这正是 P5 相对时长设计买来的能力。
3. **第三层：故障注入清单**（逐项给断言）：消息丢失/重复/乱序/任意延迟；单向分区（执行方发得出、牵头方收不到，及反向）；进程在每次状态转移处 kill -9 后重启（检查点恢复）；网关重启（收件箱补投 + QA-7 回执）；时钟注入（`ts` ±10 年、本地单调钟跳变——专验 P5/D10 时钟无关性：ts 值不得影响任何判定）；任务中途 key_epoch +1 轮换（R 系列与 02 §6.2 负缓存的相互作用）。
4. **第四层：状态机模型检查。** 把 §5 两张状态机 + QA-1 的 R0 闸门形式化（TLA+/Spin 或表驱动检查器即可，不必重型），至少四条性质：a) **attempt 隔离**——任意时刻至多一个 attempt 被视为在执行；b) **终可达性**——每个 task 有限步进入终态（依赖 QA-3 的出口定义）；c) **R4 顺序不变式**——attempt+1 前必已发出 cancel；d) **终态唯一性**——escalate 与 done/closed 不共存。状态转移全矩阵（QA-1）若有未定义格，模型检查前就该被规格评审拦下。
5. **观测性验收**（随双机走查执行）：断开一切仪表后，仅凭双方本地日志 + trace_id 离线还原一次派单全生命周期（QA-10 ④）；安全事件按 QA-9 schema 断言可查。

## 亮点

1. **P5/D10 相对时长 + 四 ID 分工（01 §3.1）**：时钟无关性从第一天起就是一个可测性质（注入任意 `ts` 行为不变），`trace_id/task_id/attempt/msg_id` 各司其职——多数同类设计要返工一轮才能达到的测试友好度，这里写在了原则里。
2. **R6 拒绝码枚举 + 03 §6 五道闸按序评估 + `missing` 明细回执**：NACK 契约具体到可以直接写一致性断言；闸的次序即断言的优先级。
3. **01 §6 开篇"实现时每条都应可追溯到测试用例"的自我要求**，以及 R4"先撤销、后改派"、drain 赛跑窗口这类以可判定形式书写的规则——规则天然长成了测试的形状，这在初稿里罕见。
4. **02 P12 失败关闭 + A4 静默丢弃不回声 + 负缓存 TTL 明确（10 分钟）**：安全面每条拒绝路径都可写成确定性断言，包括"断言无任何响应字节"这类负向测试。

## 开放问题

1. 状态机 (状态 × 消息 × 定时器) 全矩阵何时给出？终态优先级（escalate 与 closed/done 重叠时）定哪个？
2. `cancelling` 的出口条件与 cancel.ack 的重发策略是什么？
3. drain 窗口内收到 `fail(retryable=false)` 的确切语义：立即升级还是照常改派？
4. fail 的 reason_code 全集与 retryable 约定，能否与 R6 同格式随下一版给出？
5. 网关回执/错误帧（delivered/queued/rejected）的最小契约，何时补进 01 §9？
6. `env_missing` 的本地判定标准与"软摘除 + 自动恢复"机制（QA-11），是否纳入 03 下一版？
7. 审计事件 schema、最小指标集、日志关联字段规范——是增设"观测篇"，还是作为 01 附录与 §10 参数表同场维护？
