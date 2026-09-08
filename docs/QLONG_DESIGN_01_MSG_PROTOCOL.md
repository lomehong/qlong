# 群龙详细设计 01:消息信封与派单可靠性语义

> 状态:**v2,已整合评审委员会修订**(60 条意见,行内以「评审 I-xx」标注来源,见 `QUNLONG_DESIGN_REVIEW_REPORT.md`)。
> 本文承接《群龙(Qlong)系统设计纪要》(`QLONG_DESIGN_NOTES.md`,下称"纪要")§8 第 1 项,并把第 2 项(身份/信任)中与信封咬合的最小部分一并定下。
> 传输绑定 v0 已定(自建通讯网关,D12);最终选型的关闭条件见纪要 D3 回填。

## 1. 范围

**本文确定:**

- v1 消息信封的全部字段,含新鲜性与签名规范(§3);
- 消息类型族与 **reason_code 登记表**(§4);
- 派单生命周期、双方状态机与**(状态 × 消息)关键转移**(§5);
- 可靠性规则 R0–R11:attempt 闸门、投递假设、幂等与去重保留期、租约、超时回收、撤销、NACK、重试改派、**发送侧可靠性**(§6);
- 委托链与环防护(§7)、版本演进(§8)、传输绑定(§9)、默认参数与不变式(§10)、**审计与可观测性基线**(§11)。

**本文不定**(留给后续篇目):注册中心数据模型与 ACL 策略(02 篇)、能力声明格式(03 篇)、文件协同与 payload 存储选型(纪要 §8.4)、单机执行模型(§13.7)、owner 控制台(纪要 §8.7)。

## 2. 设计原则

- **P1 信封一次定死**。身份、追踪、幂等、租约、版本、**新鲜性**字段必须进 v1 信封。事后给协议补鉴权与追踪是著名的痛苦工程;字段之间互相咬合,拆开设计必然返工。评审 I-02/I-03 正是本原则的自我印证。
- **P2 传输无关**。信封是自包含的 JSON 对象,不依赖底层通道提供顺序、去重或可靠性——这些由 §6 规则在端上保证。换通道不换语义。
- **P3 中心只见头,不读 body**。信封头对中心可见,用于路由、ACL 与审计;body 对中心不透明。审计只记头摘要(§11)。
- **P4 一切消息至少一次、执行必须幂等**。不做恰好一次——离线暂存意味着重投是常态。去重靠 ID 体系,不在传输层解决。
- **P5 相对时长,不依赖跨机时钟**。所有超时/租约/有效期用相对毫秒数,由接收方收到时换算为本地绝对时刻。`ts` 仅为诊断字段,不参与任何顺序或过期判断。**唯一显式豁免**:§3.1 的 `exp` 新鲜性字段(发送方本地钟换算的绝对时刻),漂移预算见 §3.3.4——评审 I-02 定案。
- **P6 传引用不传负载**。大负载一律以引用传递;引用的**解析安全基线**随结构一并锁定(§6 R10),存储选型留纪要 §8.4。

## 3. 消息信封 v1

### 3.1 字段表

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `v` | int | ✅ | 协议主版本,当前 `1` |
| `type` | string | ✅ | 消息类型,点分命名 `族.动作`(§4) |
| `msg_id` | uuid | ✅ | 本条消息唯一 ID。传输层去重与审计用;发送侧重发**沿用同一 `msg_id`**(R11) |
| `ts` | RFC3339 | ✅ | 发送时刻,**仅诊断**,见 P5 |
| `exp` | RFC3339 | task.* 必填(rpc.* 建议) | **新鲜性**:接收方按「接收时刻 ≤ `exp` + 漂移预算(§10)」判废弃,过期静默丢弃 + 审计。发送方取 `exp = ts + exp_horizon`(§10)——它只是防重放的地平线,**有效期判定仍由 body 内相对时长承担**(R2 等);P5 的唯一豁免(评审 I-02/D24) |
| `from` | obj | ✅ | `{node_id, team_id?, agent_id?, key_epoch}`。发送方节点;`agent_id` 标识本地哪个子代理发起;`key_epoch` 为签名密钥纪元。**网关按连接身份钉扎 `from`(02 §7 A0),自报值仅作一致性核对** |
| `to` | obj | ✅ | `{node_id, team_id?}`。任务面禁止广播,一对一必填。`to.team_id` 的真伪由网关按目录锚定(02 §7 A1),自报值仅作一致性核对 |
| `reply_to` | uuid | — | 消息级关联,逐类型规则见 §4.4;缺失不构成协议错误 |
| `trace` | obj | ✅ | `{trace_id, parent_span, origin_node}`。随委托链透传(§7);**发起消息(hops=0)的 `parent_span` 取 `null`**(评审 I-43) |
| `hops` | int | task.* 必填 | 委托深度。发起为 0,每转派 +1,上限 `MAX_HOPS`(§7) |
| `task_id` | uuid | task.* 必填 | **逻辑任务实例** ID,跨重投、跨改派稳定 |
| `attempt` | int | task.* 必填 | 执行权纪元,默认 1。每次重试/改派/回收重派 +1;**所有入站 task.* 的第一道闸门**(§6 R0) |
| `sig` | obj | task.* / rpc.* 必填 | `{alg, value}`——对头+body 规范序列化(JCS,§3.3)的签名。**不再携带 `key_id`**:密钥一律按被签名的 `from.key_epoch` 查取,`sig.key_id` 与之重叠且可能不一致(评审 I-36/D23) |
| `body` | obj | ✅ | 类型相关负载,**中心不透明** |

四个 ID 的分工——全文最容易混的一处,先钉死:

| ID | 粒度 | 谁生成 | 用途 |
|----|------|--------|------|
| `trace_id` | 一次用户任务的全链路 | 最初发起节点 | 跨节点排障、日志聚合(§11) |
| `task_id` | 一个逻辑子任务 | 牵头方 | 幂等去重、状态机主键 |
| `attempt` | 该任务的一次派发执行 | 牵头方递增 | 重投去重、改派隔离、僵尸结果拒收 |
| `msg_id` | 一条消息 | 发送方 | 传输去重、`reply_to` 关联 |

### 3.2 示例

```json
{
  "v": 1,
  "type": "task.offer",
  "msg_id": "9f1c...-a2",
  "ts": "2026-09-06T12:00:00+08:00",
  "exp": "2026-09-06T12:05:00+08:00",
  "from": { "node_id": "node-a", "team_id": "t-lab", "key_epoch": 3 },
  "to":   { "node_id": "node-b" },
  "trace": { "trace_id": "7b0e...", "parent_span": null, "origin_node": "node-a" },
  "hops": 1,
  "task_id": "d41a...",
  "attempt": 1,
  "sig": { "alg": "ed25519", "value": "base64..." },
  "body": { "...": "类型相关,见 §4" }
}
```

### 3.3 身份与签名

1. **签名**:每个节点入网时生成 Ed25519 密钥对;**所有业务消息(`task.*` 与 `rpc.*`)均由发送方私钥**对"头+body 的规范序列化"签名。**body 必签**——派单的内容就是 body;rpc 必签让绕过网关的直连路径(v1.5)在节点侧仍有完整防线。
2. **规范序列化 = JCS(RFC 8785)**(评审 I-03/D23)。签名输入精确定义为:`signature_input = JCS(envelope \ {sig})`——按 JCS 规则(UTF-8、属性名字典序、无空白、数字与转义按 RFC 8785 钉死)序列化**剔除整个 `sig` 对象**后的信封。配套约束:
   - **算法白名单**:v1 仅 `alg: "ed25519"`,验证方拒绝白名单外的 `alg`(防算法混淆);
   - **密钥选择**只依赖被签名的 `from.key_epoch`,不依赖任何自报密钥标识;
   - **字段设计约束**:v1 信封与 body 中的数值一律为整数(毫秒/计数),**禁止浮点**;整数绝对值 ≤ 2^53(JS 安全整数),为将来 TS 实现保精度;
   - **跨语言测试向量**:实现仓库必须携带 JCS 黄金样本(含中文、嵌套对象、边界整数),签名/验签测试以此为准——跨实现字节级一致是互操作的生命线。
3. **传输层认证**:节点对中心(注册中心 API、通讯网关握手)使用注册中心自签的 node token(02 §3.2);信封签名解决节点间的责任归属,两者并存不互替。
4. **回声分级**(评审 I-14,执法点细则见 02 §7 A6):**静默丢弃 + 审计**——验签失败、`exp` 过期、`to.node_id ≠ 本机`、钉扎后跨队;**结构化回执**——验签通过且同 team 的一切拒绝走 R6 reject;`unsupported_type / unsupported_version` 回执**必须排在验签 + 同 team 复核之后**(不让未认证探测者榨取版本信息)。
5. `enc` 字段**预留未用**,加密次序现在定案:**sign-then-encrypt**——`sig` 覆盖明文 body,`enc` 启用后签名随密文同传,接收方解密后验签;网关可见面不变(仅头)(评审 I-44)。

## 4. 消息类型族

纪要 §7 的两种协同模式塌缩为一族任务消息:日常互助 = 单跳、无项目上下文、短租约的 `task.offer`;项目级协同 = 带 `project` 上下文的同一族消息。唯一独立的是无副作用的问答。

### 4.1 rpc.* —— 问答(轻量、只读、无副作用)

| 类型 | 方向 | body 概要 |
|------|------|-----------|
| `rpc.ask` | → | `{request_id, question, context_ref?, timeout_ms}` |
| `rpc.answer` | ← | `{request_id, answer, refs[]}` —— **`request_id` 必填**(评审 I-58) |

超时即弃,可重发(新 `msg_id`,同 `request_id`);同样必签(§3.3),验签失败静默丢弃。**提问方按 `request_id` 关联应答,`reply_to` 仅辅助排障**——重发后的应答可能指向旧 `msg_id`,按 `reply_to` 匹配会漏收。凡"让对端做事"一律走 `task.*`,不借道 rpc。

### 4.2 task.* —— 派单生命周期

| 类型 | 方向 | 时机 | body 概要 |
|------|------|------|-----------|
| `task.offer` | 牵头→执行 | 派单/改派 | 见下表 |
| `task.accept` | 执行→牵头 | 接单 | `{lease_ms(执行方确认值), started_at}`;`started_at` 仅诊断,不参与租约判断(P5) |
| `task.reject` | **双向**(评审 I-10) | 拒单/通知性拒绝 | `{reason_code, retryable?, retry_after_ms?, detail?, supported_v?:[min,max]?}`;码的方向约束见 §4.3 |
| `task.progress` | 执行→牵头 | 周期心跳 | `{state, pct?, seq?, note?, logs_ref?}`;**心跳即续租,每条均处理(R1 豁免去重)**;`state ∈ {starting, working, finalizing}`(评审 I-43);`seq` 单调递增可选,用于乱序丢弃;**progress 不驱动状态机,`state/pct` 仅展示与诊断** |
| `task.result` | 执行→牵头 | 完成 | `{status:"done", summary, acceptance_results?, artifacts[], files[], completed_before_cancel?:bool}`;`acceptance_results[]` 逐条回填 contract.acceptance 的通过情况(评审 I-24);`completed_before_cancel` 语义见 R5 |
| `task.fail` | 执行→牵头 | 失败 | `{reason_code(→§4.3), retryable, summary, diagnostics_ref?, missing_caps[]?}` |
| `task.cancel` | 牵头→执行 | 撤销 | `{reason: reclaim\|user\|project_aborted\|acceptance_failed}`;`acceptance_failed` 为验收失败归途(R4,评审 I-04⑥/I-24) |
| `task.cancel.ack` | 执行→牵头 | 确认停止 | `{completed_before_cancel?:bool}`(评审 I-39) |

**`task.offer` body 字段**:

| 字段 | 必填 | 说明 |
|------|------|------|
| `kind` | ✅ | `aid`(日常互助)/ `project`(项目协同) |
| `summary` | ✅ | 人可读的任务描述(给对端 LLM 的任务书正文);写作规范模板随 §8.4 双机走查定稿(评审 I-24) |
| `contract` | kind=project 必填,aid 推荐选填 | **结构化接口契约**(评审 I-24):`{deliverables:[{path|artifact, desc}], acceptance:[{check, machine_checkable?}]}`——语义冲突防线与验收判据 |
| `offer_ttl_ms` | ✅(缺省取 §10) | 接单时限,执行方按 R2 独立判过期。**属 body 而非信封**——签名覆盖它,网关不可见(P3;评审 I-26) |
| `required_caps` | — | 能力自评清单(如 `tool:ios-sign`)。不满足 → `reject(unsupported_caps)` |
| `requires` | — | 超出执行方默认执行档案的权限声明,`[{class: tool\|net\|confirm, value, reason}]`,**`reason` 必填且面向本地人**(→ 03 §6.2;评审 I-25) |
| `workspace` | — | git 引用 `{repo, base_ref}`。**未携带时的缺省工作区语义见 03 §6.1**(评审 I-32) |
| `deadline_ms` | — | 相对时限(P5),超期执行方自行放弃并 `fail(deadline_exceeded)` |
| `lease_ms` | ✅ | 牵头方建议的租约时长;执行方在 accept 里可确认或下调 |
| `project` | kind=project | `{project_id, lead_node}`;图谱本身不上网,留在牵头方(§4.4) |
| `payload` / `payload_ref` | 二选一 | ≤`MAX_BODY_INLINE` 内联;超出用引用 `{ref_uri?, repo?, path?, sha256, size}`(R10) |

### 4.3 reason_code 登记表(评审 I-28)

**reject 码**(方向约束:`stale_attempt` 仅牵头→执行,其余仅执行→牵头;双向类型见 §4.2):

| 码 | 含义 | 方向 | retryable 建议 |
|----|------|------|----------------|
| `busy` | 负载满 | 执行→牵头 | ✅(带 `retry_after_ms` 时不排除该节点,R8) |
| `policy_denied` | 本地策略拒绝 | 执行→牵头 | ❌(持久,R8 永久排除) |
| `unsupported_caps` | 接单期能力不符 | 执行→牵头 | ❌(持久) |
| `unsupported_version` | `v` 超出支持区间 | 双向 | ❌ |
| `unsupported_type` | 未知消息类型(§8) | 双向 | ❌ |
| `expired` | offer 已过期 | 执行→牵头 | ✅(换目标) |
| `refused_loop` | hops 超限 | 执行→牵头 | ❌(持久) |
| `stale_attempt` | 非当前执行权 | **双向**(牵头→执行:拒收迟到旧 attempt 消息;执行→牵头:旧 attempt 隐式取消回执,R0 特别则) | — |
| `other` | 兜底 | 双向 | 实现自定 |

**fail 码**(执行→牵头):

| 码 | 含义 | retryable 建议 |
|----|------|----------------|
| `deadline_exceeded` | 超过 `deadline_ms` | ✅ |
| `caps_missing` | 执行期**确定性检查**发现声明能力缺失(与 `unsupported_caps` 的边界:接单期声明不符 vs 执行期发现缺失;仅允许来自本地确定性检查,→ 03 §7) | ✅(换目标) |
| `payload_unavailable` | payload_ref 不可达/仓库被删 | ✅ |
| `payload_corrupt` | sha256/size 校验失败 | ✅(重取一次后升级) |
| `internal_error` | 执行方内部错误 | ✅(同节点最多一次) |
| `cancelled_by_peer` | 收到 cancel 后终止 | — |
| `other` | 兜底 | 实现自定 |

**元规则**:未知码一律按 `other` 处理,不得报错;私有扩展码用 `x-` 前缀;新增标准码按同主版本兼容演进(§8)。

### 4.4 项目图谱的归属与接管边界

任务图谱(分工图、依赖边、状态)只存在于牵头方的内存+本地持久化,不上中心、不进消息。**v1 的 leader 接管 = 同一物理节点上的进程重启 + 本地检查点重放**——图谱不出节点,与"不上中心"自洽(评审 I-35)。**跨机接管为显式开放问题**(§13.2),候选口子:同 team 内指定的检查点备份节点(端到端加密,不经过中心)、用户手动导出/导入。接管前置条件(为跨机预留):检查点必须含 attempt 高水位与在途 `(task_id, attempt, 执行方)` 清单;接管方将所有在途任务 attempt 提到高水位之上再重派(fence);旧 lead 恢复后凭检查点纪元检测让位,禁止双主。

### 4.5 reply_to 逐类型规则(评审 I-57)

| 消息 | `reply_to` 指向 |
|------|------------------|
| `rpc.answer` | 对应 `rpc.ask` 的 `msg_id`(关联仍以 `request_id` 为准) |
| `task.accept / reject` | 所应答 offer 的 `msg_id` |
| `task.progress / result / fail` | 对应 offer 的 `msg_id`(改派后指向新 offer) |
| `task.cancel.ack` | 对应 cancel 的 `msg_id` |

任务级关联一律以 `(task_id, attempt)` 为准;`reply_to` 仅消息级排障用。

## 5. 派单生命周期

### 5.1 牵头方状态机(每个 `task_id` 一份)

```
              offer ──── accept ────▶ running ──── result(验收通过)───▶ done ✅
  drafting ──▶
              └── reject ──┐
  offered ── offer_ttl 到期 ┤(全部改派路径均先 cancel 后 offer,R4)
                           ▼
                     改派判定(R7/R8)── attempt+1 ──▶ 重新 offer
                           │
  running ── fail(retryable)─┤
  running ── fail(retryable=false)──▶ failed ❌(立即终态,R7)
  running ── 租约超时 ──▶ reclaiming ── drain 窗口/首个 cancel.ack ──┘
  running ── result(验收失败)──▶ cancel(acceptance_failed)── 改派判定
  任一态 ── 重试预算耗尽 ──▶ escalate ❌(结构化事件,§11)
  任一态 ── 用户/上游取消 ──▶ cancelling ──▶ closed
                              │◀── 出口:任一终态消息,或 cancel_wait_ms 超时强制 closed + 审计(I-06)
  竞态:cancelling/reclaiming 收到 result ──▶ done;收到 fail ──▶ closed(I-06)
```

**终态优先级**(并发裁决,评审 I-04):`done`(已交付)> `closed`(用户取消)> `failed`(判定不可成)> `escalate`(重试预算耗尽交回上层)。`failed` 与 `escalate` 的区别:failed = 任务被判定不可成(retryable=false 等);escalate = 预算耗尽,交回项目图谱/用户。

### 5.2 执行方状态机

```
  offered ── accept ──▶ running ──▶ result_sent ✅
     │ reject(按 §4.3 码表,立拒)──▶ 终态
     └ 本地 offer_ttl 过期 ──▶ reject(expired)
  running ── fail ──▶ fail_sent
  running ── 收到 cancel ──▶ 停止 ──▶ cancel.ack(或 R5 赛跑)
  offered/running(旧 attempt)── 收到更高 attempt 的同 task offer ──▶ 隐式取消旧态,回 reject(stale_attempt)
                              + 旧 attempt 状态摘要,再按新 offer 评估(I-04③;R0 特别则)
  任一态 ── 收到 reject(stale_attempt)──▶ 本地记账/清理 ──▶ 终态
  running ── 收到 cancel.ack ──▶ 忽略 + 审计(cancel.ack 仅在牵头方 cancelling/reclaiming 有语义,I-07)
  任一已决状态 ── 任何重复消息 ──▶ 忽略 + 审计(R0)
```

### 5.3 正常时序

```
牵头方(设备A)                              执行方(设备B)
  │ task.offer(attempt=1, lease_ms=300s)      │
  │──────────────────────────────────────────▶│ 五道闸自评(03 §6)
  │◀──────────────────────────────────────────│ task.accept(lease_ms=300s)
  │           ◀──── task.progress(renew, seq++) 周期(≈lease/3)────▶ 执行中
  │◀──────────────────────────────────────────│ task.result(acceptance_results + artifacts 引用)
  │ 校验、整合(lead 本地;图谱更新)
```

## 6. 可靠性规则(R0–R11)

> 状态机的语义细则,实现时每条都应可追溯到测试用例。完整 (状态 × 消息 × 定时器) 全矩阵随 §8.4 双机纸面走查定稿(评审 I-04 的建议),本节已覆盖全部已知转移。

- **R0 attempt 统一闸门**(评审 I-04/D25):所有入站 task.* 消息,**先于一切其他检查**判 attempt:`<` 本地当前 → 拒收 `reject(stale_attempt)`(已验签同 team 时)+ 审计;`=` 当前 → 交状态机;`>` 当前 → **分两种**:同 task_id 的 `task.offer` = **对本地旧 attempt 的隐式取消**(终止旧态、回 `reject(stale_attempt)` + 旧状态摘要,再按新 offer 进入接单评估——改派回原节点的取消信号,评审 I-04③);其余类型 → 丢弃 + 审计。任何已决状态(已 accept/reject/终态)下的重复消息一律忽略 + 审计。
- **R1 投递假设与幂等**(修订,I-01/I-02):底层通道至少一次、不保序。**除 `task.progress` 外**的 task.* 以 `(task_id, attempt, type)` 去重;progress 每条均处理(续租动作本身幂等),可选 `seq` 用于乱序丢弃与展示去重。**去重状态保留期 ≥ `max(offer_ttl, lease) × max_attempts + drain_ms`**;同键不同 body → 丢弃 + 审计事件 `dedup_mismatch`。
- **R2 offer 有效期**(修订):offer_ttl_ms 在 body;执行方以「**晚于**」TTL 判过期(评审 I-38);过期 → 回 `reject(expired)`;牵头方本地计时同步判定。**expired 改派同样走 R4:先撤销、后改派**(评审 I-08——僵尸入口对一切改派路径关闭)。长期离线节点上线后收件箱批量过期 offer → 整批 `reject(expired)`(必测场景)。
- **R3 租约与心跳**(修订,I-07/I-09/I-38):**lost 判定公式**:自最后一个应收心跳的预计时刻起,经 `2×(lease_ms/3) + grace_ms` 仍无心跳 → 判 lost。**停跳可能来自两端中的任何一端**,计时器以各自连接态为准:**ws 断线期间,本节点全部入站任务的 lost 计时暂停,重连后从最后一条(含补投的)心跳重新起算;drain 窗口随重连重新打开**(改派决策延迟语义,评审 I-09)。执行方侧对称计时器:自**最后一条成功送达(获网关 ACK,R11)的心跳**起算 `lease_ms`,超时立即暂停产生新副作用(不强求杀进程);无法发出心跳持续超过 `grace_ms` 亦暂停。**不变式:`grace_ms ≤ lease_ms − 2×(lease_ms/3)`**(默认参数下 230s ≤ 300s),保证执行方本地租约到期不早于牵头方判 lost。
- **R4 超时回收与改派顺序**(修订,I-08):**一切改派路径(expired / retryable / lost)统一先撤销、后改派**——对旧 attempt 发 `task.cancel`,经 drain 窗口(或首个 `cancel.ack` 提前收口,评审 I-39)后再发新 offer;cancel 必须先于新 offer 进入通道。drain 窗口 `drain_ms` 内同 attempt 的 result/fail 仍接受(赛跑窗口);**窗口内收到 `retryable=false` 的 fail → 不改派,直接终态 failed**。窗口关闭即 attempt+1 改派。**验收失败归途**:牵头方校验 `result.acceptance_results` 不符 → `cancel(reason=acceptance_failed)` + attempt+1 重做(评审 I-04⑥/I-24)。
- **R5 僵尸防护**:执行方发送 result 前自检——已收到 cancel 或本地租约已超时(R3 执行方计时器)→ 不发 result,回 `cancel.ack`;已完成但尚未交付时收到 cancel → 仍发 result 并标 `completed_before_cancel`(赌赛跑窗口)。改派后迟到的旧 attempt 结果由 R0 拒收并回 `reject(stale_attempt)`。执行方已发 result 后收到 cancel → 回 ack 带标记,**不重发 result**,牵头方以 drain 窗口内的 result 为准(评审 I-39)。
- **R6 快速拒绝(NACK 优先)**:执行方不接受就必须立刻 reject,禁止沉默等超时;码表与方向约束见 §4.3。
- **R7 重试与升级**(修订,I-40):`retryable=false` 的失败 → **立即终态 failed,不烧 attempt**。attempt 计数仅累计**已 accept 之后**的失败改派;从未被接受的改派(reject/expired/不可达)单独计 `dispatch_round`,上限同为 `max_attempts`。两者任一耗尽 → escalate(结构化事件见 §11)。
- **R8 改派约束**(修订,I-37):按失败性质区分——`unsupported_caps / policy_denied / refused_loop` 等持久失败:本 task 生命周期内**永久排除**该节点;`busy`(带 `retry_after_ms`)不排除;其余瞬时 retryable 仅排除一次;判 lost 节点的排除按 R4 取消衔接处理。协议层排除是硬约束;03 §7 的"节点-能力记忆"只是牵头方侧软降权,两者不互替。
- **R9 广播禁令**(修订,I-52):**v1 全部信封一对一,无广播类型**;广播许可保留为未来"发现类消息族"的扩展位(届时须新增类型命名空间并同步修订 ACL)。版本可见性经目录(02 §5.2)与 03 §5 查询获得。
- **R10 负载引用与解析安全基线**(修订,I-18):body 超过 `MAX_BODY_INLINE` 必须走 `payload_ref`;执行方按 sha256/size 校验。**解析基线**:scheme 白名单(初始仅 https 与系统 git);默认禁止环回、link-local(169.254.0.0/16 等)与私有网段目标,例外须节点策略显式白名单;下载前按 `size` 上限预检,超限拒绝不预取;重定向不得越出白名单;**payload 拉取行为纳入远端执行档案的网络出口约束**(03 §6.1)。
- **R11 发送侧可靠性**(新,评审 I-05/D26):网关对上行信封回 per-msg 回执帧(§9,仅看头,与 P3 不冲突)。**关键消息(result/fail/cancel/accept/reject)发送方本地持久化(outbox)**,未获回执按退避重发,**重发沿用同一 `msg_id`**(由 R1 幂等消化)。**降级面声明**:中心整体不可达时,跨网任务面停摆;单机与(v1.5 后)局域网直连不受影响;执行方进行中的租约——本地继续跑完当前 attempt,结果入 outbox 重连补发,期间不再接受新单。

## 7. 委托链与环防护

1. `hops` 每转派 +1;收到 `hops > MAX_HOPS` 的 offer → `reject(refused_loop)`。默认 `MAX_HOPS = 8`。
2. `trace` 三元组原样透传,不得改写;执行方本地日志、进度消息均携带,使任一任务的跨机全链路可在一处还原(§11)。
3. 转派时,新任务的 `trace.parent_span` = 触发转派的上游消息 `msg_id`;发起消息(hops=0)取 `null`。

## 8. 版本与演进

- `v` 为主版本整数。同主版本内:**新增字段必须被旧实现忽略;允许新增 type**(评审 I-27);删字段、改语义、改必填性 → 升主版本。
- 收到未知 `type` → 回 `reject(unsupported_type)`(验签+同 team 复核之后,§3.3.4);收到 `v` 超出支持区间 → `reject(unsupported_version)`,body 可选带 `supported_v:[min,max]`(v1 即定义该字段,评审 I-27)。**禁止静默丢弃**。
- 未知**枚举值**(reason_code 等)按 §4.3 元规则处理,不得报错。
- 节点版本/能力可见性经目录(02 §5.2)与 03 §5 查询获得,不经信封协商。

## 9. 传输绑定

信封与语义传输无关(P2);承载它的是纪要 §3 的**通讯网关**(自建,部署于 `qlong.qianji.io`):

- **连接**:节点 ⇄ 网关 ws 长连接;握手以 node token 认证(02 §3.2)。
- **在线投递**:网关按信封头 `to.node_id` 直接推送。
- **离线暂存**:目标不在线时,信封进入其**收件箱**(网关侧队列),重连即补投;正确性不依赖暂存——`exp` 与 body 内相对有效期由端上独立判过期(R2),网关过期清理仅回收存储。
- **网关回执帧**(评审 I-11/D26):网关对每条上行信封回 `{ack_type: delivered|queued|rejected, msg_id, reason?}`(`rejected.reason ∈ {offline_not_stored, acl_rejected, expired, …}`);同族另有 `routing.denied {rule, reason_code, msg_id}`(02 §7 A6,向已认证发送方本人回送消息级路由拒绝)。**回执仅用于诊断与改派触发判定,不参与可靠性**——可靠性仍由 P4/R1 端上兜底,回执不构成第二套真相。
- **aid 类不暂存**:10s TTL 走暂存必是死信;目标离线时网关直接回 `rejected(offline_not_stored)`,牵头方**据此立即改派**(机制支撑评审 I-11;不再依赖 offer_ttl 到期)。
- **已知限制**(评审 I-42):v1 的 presence/「不可达」判定一律以网关连接态为准——直连可达但网关离线的节点按离线处理;v1.5 直连落地时需重定义,列入回归范围。
- **投递语义**:至少一次、不保序(P4);网关不解析 body(P3),只看头做 **from 钉扎**(02 §7 A0)、路由、ACL 与审计。
- **演进**:**局域网/同网段直连为 v1.5 里程碑**——身份与签名体系与传输无关,直投不削弱安全模型(签名验签按公钥,不按通道);公网 NAT 打洞仍为远期优化。网关始终是跨网保底路径与离线队列——"全经中心转发"在广域上成立,局域内不必。

## 10. 默认参数表

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `offer_ttl_ms` | project 60 000 / aid 10 000 | 接单时限,offer body 字段(§4.2) |
| `lease_ms` | project 300 000 / **aid 120 000**(评审 I-40) | 单次租约;长任务靠心跳续 |
| 心跳间隔 | `lease_ms/3` | R3 |
| `grace_ms` | 30 000 | 判 lost 宽限;**不变式 `grace_ms ≤ lease_ms − 2×(lease_ms/3)`**(评审 I-07) |
| `drain_ms` | 30 000 | 回收后的赛跑窗口;重连后重新打开(R3/R4) |
| `cancel_wait_ms` | 30 000 | cancelling 出口超时,到期强制 closed + 审计(评审 I-06) |
| `exp` 漂移预算 | 10 分钟 | 接收时刻 ≤ exp + 预算判有效(评审 I-02) |
| `exp_horizon` | 24 小时 | 发送方计算 `exp = ts + exp_horizon`;防重放地平线,非调度参数 |
| 去重保留期 | ≥ `max(offer_ttl, lease) × max_attempts + drain_ms` | R1 下限 |
| `max_attempts` / `max_dispatch_rounds` | 3 / 3 | 已接受后失败 / 未接受过的改派,各自独立计数(评审 I-40) |
| `MAX_HOPS` | 8 | 委托深度上限 |
| `MAX_BODY_INLINE` | 256 KB | 超出走 payload_ref |

原则:参数是配置,协议只锁**字段与语义**;offer 可携带覆盖值,默认值仅是实现缺省。

## 11. 审计与可观测性基线(新,评审 I-33/I-34)

**统一审计事件 schema**(网关与节点通用):

```json
{ "event": "…", "ts": "…(诊断)", "node_id": "…", "reason": "…",
  "envelope_head_digest": "…", "trace_id": "…?", "task_id": "…?", "attempt": 0 }
```

只记信封头摘要,不记 body(P3)。**v1 事件枚举**:`sig_verify_failed` / `exp_rejected` / `to_mismatch` / `not_active` / `acl_rejected_from_pin` / `acl_rejected_cross_team` / `dedup_mismatch` / `stale_attempt_rejected` / `reclaim` / `escalate` / `cap_tag_suspected` / `cap_tag_removed`。

**日志关联规范**:每条与任务相关的日志必须含 `trace_id / task_id / attempt / msg_id`(外加 `key_epoch`)——缺字段视为日志缺陷。

**v1 最小指标集**(调参依据):判 lost 次数、drain 命中率(`completed_before_cancel` 频率,直接检验 `drain_ms=30s` 是否够)、attempt/dispatch_round 分布、reject reason 直方图、心跳到达间隔抖动、escalate 率。

**escalate 结构化事件**:`{task_id, trace_id, attempts:[{node, outcome, reason_code, missing?|summary?}], final_reason, diagnostics_ref}`。用户面呈现(本地会话卡片四要素:托了什么事/试过谁/为何放弃/建议动作)留产品篇。

## 12. 决策记录(接续纪要 D1–D5)

| # | 决策 | 结论 |
|---|------|------|
| D6 | 信封字段 | 身份/追踪/幂等/租约/版本/**新鲜性**六类字段一次进 v1(P1) |
| D7 | 模式塌缩 | 互助与项目统一为 `task.*` 一族;问答独立为 `rpc.ask`;图谱留在牵头方本地 |
| D8 | 投递语义 | 至少一次 + 端上幂等,不追求恰好一次(四 ID 分工,§3.1) |
| D9 | 派单模型 | 租约制:accept/心跳续租/超时回收/显式撤销/NACK 快速路径 |
| D10 | 时钟 | 全协议相对时长,`ts` 仅诊断;唯一豁免 `exp`(D24) |
| D11 | 安全 | Ed25519 签头+body;中心只见头;连接认证用 node token(02 §3.2) |
| D12 | 传输(v0) | 自建通讯网关:ws 长连接在线推送 + 离线收件箱;至少一次投递,端上幂等 |
| **D23** | **规范序列化** | **JCS(RFC 8785);`signature_input = JCS(信封剔除整个 sig 对象)`;密钥按 `from.key_epoch` 查取,`sig={alg,value}`;alg 白名单;跨语言黄金样本随实现仓库**(评审 I-03/I-36) |
| **D24** | **新鲜性** | **信封 `exp` 字段 + 漂移预算 10 分钟;P5 显式豁免;去重状态保留期下限入 R1**(评审 I-02) |
| **D25** | **attempt 闸门与终态** | **R0 统一前置闸门;`failed` 终态(retryable=false 立即);终态优先级 done>closed>failed>escalate;验收失败 = cancel(acceptance_failed)+attempt+1;reject 双向 + 码方向约束**(评审 I-04/I-10) |
| **D26** | **发送侧** | **关键消息本地 outbox + 网关 per-msg 回执帧;回执仅诊断与改派触发,不参与可靠性;重发沿用同 msg_id**(评审 I-05/I-11) |

## 13. 开放问题

1. ~~ACL 与信任策略~~ → 02 篇(已含两轮评审修订)。
2. **跨机 leader 接管**(评审 I-35):v1 已钉死为同机进程重启;跨机方案(检查点备份节点 vs 手动导出)待 §8.4 走查后定。
3. ~~payload_ref 解析~~ → 结构与安全基线已定(R10);存储选型仍属纪要 §8.4。
4. ~~能力报错标准化~~ → 已由 03 篇关闭(reject 附 `missing`)。
5. **网关集群化**(评审 I-12):规模目标(节点数/消息速率)、连接注册、node_id 分片路由、收件箱共享存储——网关是**有状态**组件,横扩是核心架构件而非"保持无状态";与 02 §12 同场设计。
6. **单机执行模型**(纪要 §8.4 同场):`offer.summary` 如何实例化为本地会话(基座为原版 deepseek-harness,TypeScript;映射层接口随走查定稿)。
7. **任务书写作规范模板**(评审 I-24):随 §8.4 双机走查定稿,作为 03 §6.1 注入防线的第一道工程化措施。
