# 群龙(Qlong)实现总体规划 v0.1

> 状态:**待批准**——主任已选定完成线(M0–M4 双机闭环),批准本计划即开工。
> 承接:README 状态行(基座 deepseek-harness,TypeScript;下一设计单元 §8.4+双机走查)、纪要 §8 待设计清单、01–03 篇定稿决策(D6–D33)、评审委员会报告(60 条意见已全部处置,见 `QUNLONG_DESIGN_REVIEW_REPORT.md`)。
> 执行方式:批准后以 create_goal 锁定 §0 总目标,按 §7 自驱循环推进;每个里程碑收口需主任确认后才进下一里程碑。

## 0. 总目标(届时 create_goal 的原文)

> 按 `docs/QLONG_DESIGN_*.md` 01–03 篇定稿设计,实现群龙(Qlong)v0.1:单机核心、中心三件(注册中心/通讯网关/分发占位)、双机端到端派单闭环、能力感知派单与远端任务执行档案,配套自动化测试、双机走查剧本与文档同步;完成标准 = §1 验收清单全部通过且经主任确认。§8.5 安装器、§8.6 弱网、跨团队 grant、控制台 UI 排 v0.2,不在本目标内。

## 1. 完成线:v0.1 验收清单(全部可测)

| # | 验收项 | 对应设计 |
|---|--------|----------|
| A1 | 真机 A、B 经 `/v1/enroll` 入网同队,目录互相可见(含在线态、caps 摘要) | 02 §4/§9 |
| A2 | A 派 aid 单 → B 五道闸评估 → accept → progress 心跳续租 → result 回流,A 校验整合 | 01 §5、03 §6 |
| A3 | A 派 project 单带结构化 contract → B 回 `acceptance_results[]`,校验不过走 `cancel(acceptance_failed)+attempt+1` | 01 §4.2/R4 |
| A4 | 杀掉 B 进程:A 在 lost 判定后 cancel→drain→attempt+1 改派;超 `max_attempts` → escalate | 01 R3/R4/R7 |
| A5 | 重放旧信封被 `exp`+漂移预算拒绝并留审计;迟到旧 attempt 消息被 R0 拒收 | 01 R0/R1、§3.1 exp |
| A6 | B 缺能力时 `reject(unsupported_caps)` 附 `missing[]`,A 据此改派并更新本地能力记忆 | 03 §3.2/§6/§7 |
| A7 | 远端任务默认低权执行档案:越工作区/越工具白名单/越网络出口被拒或转本地人确认;确认完成遇过期仍 `reject(expired)` | 03 §6.1/§6.2 |
| A8 | 审计事件(schema+枚举)与最小指标集可查;仅凭双机本地日志 + `trace_id` 离线还原一次派单全生命周期 | 01 §11 |
| A9 | ACL 全部拒绝路径(A0–A6)有确定性测试断言;伪造 `to.team_id` 被网关拒绝 | 02 §7 |
| A10 | 以上全部由自动化测试 + 双机走查剧本覆盖,剧本即 e2e 测试 | — |

## 2. 工程骨架与技术选型(M0 首轮定稿,均为建议值)

- **仓库**:pnpm + TypeScript(ESM、strict)monorepo:
  `packages/core`(协议与语义,零 IO 纯函数优先)/ `packages/registry` / `packages/gateway` / `packages/node`(单机龙)/ `packages/cli`(`qlong` 命令)/ `packages/testing`(仿真、黄金样本、走查剧本)。
- **关键依赖(候选,M0 定稿)**:ed25519 → `@noble/ed25519`;JCS → 采用经 RFC 8785 向量验证的实现,缺失则自实现+全量向量;ws → `ws`;registry HTTP → `fastify`;单机持久化 → `better-sqlite3`;测试 → `vitest` + fast-check(property-based)。
- **黄金样本库**(`packages/testing/golden/`):JCS 规范化向量(RFC 8785 附录 + 中文/浮点/大整数/嵌套自造向量)、签名/验签向量、信封样例全集——为将来 Go/Python 互操作预留。
- **CI**:GitHub Actions(仓库 `github.com/lomehong/qlong`):lint + test + 覆盖率门(core 包语句覆盖 ≥90%)。
- **参数单一事实源**:01 §10 默认参数表 + 02 §9 错误码表 + 01 §4.3 reason_code 登记表 → `packages/core/src/params.ts`、`reason-codes.ts` 常量模块,文档与代码同源。

## 3. 里程碑详表

### M0 协议核心(packages/core,约 3–5 轮)

| 工作包 | 内容 | 验收 |
|---|---|---|
| M0.1 信封与校验 | v1 信封全字段(含 `exp`)schema+校验器;四 ID 工具;`hops`/`attempt` 语义 | 合法/非法信封用例全集 |
| M0.2 签名 | JCS 规范化(`signature_input = JCS(信封剔除整个 sig 对象)`)+ ed25519 签验 + `alg` 白名单 + `from.key_epoch` 密钥查取 | 黄金样本全过;跨进程互验 |
| M0.3 语义纯函数 | R0 attempt 闸门、R1 去重(progress 豁免+`seq` 单调)、`exp` 过期判定(漂移预算)、reject/fail reason_code 码表 | property-based:乱序/重复/迟到/重放注入不变式 |
| M0.4 审计与追踪 | 审计事件 schema+枚举(01 §11)、trace 三元组透传规则、日志关联四字段规范 | 事件可拼回任务链路 |

### M1 单机核心(packages/node + cli,约 5–8 轮)

| 工作包 | 内容 | 验收 |
|---|---|---|
| M1.1 执行器接口 | 定义单机执行模型接口 + **脚本桩执行器**(真实 deepseek-harness 基座适配紧随其后,隔离风险) | 桩执行器跑通 A2 的单机版 |
| M1.2 牵头方状态机 | drafting→…→终态全矩阵(终态优先级 done>closed>failed>escalate)、本地图谱+sqlite 检查点、`cancel_wait_ms` 出口 | 状态×消息×定时器矩阵全转移覆盖 |
| M1.3 执行方状态机 | 五道闸(闸 1/2/3/4)、租约对称计时器+不变式 `grace_ms ≤ lease−2×(lease/3)`、R5 僵尸自检 | R1–R7 每条规则 ≥1 用例(R-矩阵建立) |
| M1.4 CLI 雏形 | `qlong` 本地任务发起/查看/取消;owner 操作的 API-only 等价命令(token 签发/suspend/revoke) | 断网单机全功能(A2 单机版) |

### M2 中心三件(packages/registry + gateway,约 5–8 轮)

| 工作包 | 内容 | 验收 |
|---|---|---|
| M2.1 registry | enroll(token 30min/stdin 传递/consumed 原子/并发恰好一端 200)、nodes/me、keys 轮换(纪元现势+历史公钥≥3)、teams/nodes 过滤查询、统一错误信封+错误码表、IP 限流 | 02 §9 API 面逐端点契约测试 |
| M2.2 gateway | ws 长连接+node token 握手、A0 钉扎/A1 目录锚定(directory epoch 推送,02 §7.1)/A2/A6 回声分级+close code 4001/4002、持久收件箱、per-msg 回执帧、aid 不暂存 | A9 全过;收件箱补投+`exp` 兜底 |
| M2.3 联调 | node⇄registry⇄gateway 三方联调;`caps` 查询参数编码、分页预留 | 双进程仿真跑通 A1 |

### M3 双机闭环(约 5–8 轮)

| 工作包 | 内容 | 验收 |
|---|---|---|
| M3.1 仿真层 | 单机双进程仿真(loopback+真实 ws+真实签名)→ 离散事件仿真(时钟可控,赛跑/超时确定性复现) | 故障注入清单全过 |
| M3.2 可靠性全景 | R4/R5 赛跑、R8 改派排除、断线重连计时暂停+drain 重开(I-09)、outbox 重发(R11)、回执帧驱动 aid 即时改派 | A3/A4/A5 过 |
| M3.3 双机走查 | **§8.4 纸面定稿 + 双机走查剧本定稿(并行设计工作包交付物)→ 剧本即 e2e**;可观测性验收(仅凭双机日志+trace_id 离线还原) | A8 过;剧本全绿 |
| M3.4 payload_ref 临时方案 | v0.1 临时:执行方本地 https 静态服务 + sha256/size 校验(严格遵守 01 R10 解析基线);§8.4 定稿后替换 | 大负载走引用、篡改被拒 |

### M4 能力+执行档案(约 5–8 轮)→ v0.1 收口

| 工作包 | 内容 | 验收 |
|---|---|---|
| M4.1 能力上报与查询 | PUT caps/load(全量替换,caps_rev 仅静态自增)、目录过滤、`accepting` 快照、两段式自愈(确定性检查/软摘/硬摘/滞回)、missing_caps 反馈闭环 | A6 过;误摘防护用例 |
| M4.2 执行档案沙箱 | 工作区(含 D33 缺省语义)/工具白名单/网络出口/凭证不注入/敏感操作本地确认;`requires` 渲染契约 | A7 过;注入任务书无法越档 |
| M4.3 v0.1 收口 | 全量验收清单复跑 + 评审团终审 + 文档同步回写 | §1 十项全过 + 主任确认 |

## 4. 并行设计工作包(不阻塞主线,占用 M2 时段)

1. **§8.4 文件协同与产物回传纸面定稿**(M3.3 前必须完成):工作区隔离/git 工作流/payload 存储选型;与双机走查剧本同场定稿。
2. **双机走查剧本**(M3.3 输入):即 §1 验收清单的剧本化。
3. **平台矩阵决策**(M4 前定):v0.1 首发平台(Windows/macOS/Linux 取舍)与执行档案的 OS 级隔离手段——安全关键件,单独出小节评审。

## 5. 质量门与治理

- **每道里程碑门**:评审团机器评审(复用本次 7 角色模式,输入=设计文档+当里程碑代码/测试)→ 修订 → **主任确认** → 下一里程碑。
- **R-矩阵**:`docs/testing/R-MATRIX.md` 随 M1.3 建立:R0–R11、A0–A6、五道闸逐条 → 测试用例编号,持续维护——这是 01 §6「每条规则可追溯到测试用例」的兑现。
- **文档回写**:实现中发现设计缺陷/偏离 → 不静默改代码,回写设计文档(决策记录续接 D 编号)或以修订提案过评审。
- **看板纪律**:批准后 create_goal 锁总目标(建议 max_goal_rounds=60);每里程碑一张任务卡(task_delegate),收口 task_report 请主任确认;执行以本会话为主,重型并行件派子代理,我做集成与评审。
- **不可逆动作**(对外发布、生产部署、域名/商标动作)一律先请示。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| deepseek-harness 基座适配不确定 | M1.1 先用脚本桩执行器隔离;基座适配单独工作包,失败不阻塞协议/网络主线 |
| §8.4 未定稿拖 M3 | payload_ref 临时方案隔离在适配层;§8.4 定稿只影响文件协同实现(v0.2),不影响 v0.1 验收 |
| 执行档案沙箱平台差异大 | 平台矩阵提前到 M4 前决策;沙箱独立验收,不与能力模块耦合 |
| 作者侧并行修订设计文档 | 每个里程碑开工前 re-read 基线;实现偏离一律走文档回写,不私下分叉 |
| 长任务 goal 轮次耗尽 | 每轮必有可验证产物;里程碑门即自然检查点,必要时主任续批轮次 |

## 7. 自驱循环(批准后的运转方式)

每轮:读 goal → 取最高优先任务卡 → 产出(代码+测试+简报)→ task_report/记录 → 自检下一轮入口;里程碑门暂停等主任确认;连续 3 轮同一阻塞才申报 blocked;主任任何时刻可改向(edit/pause goal)。

## 8. M0 首轮开工清单(说「开始」即执行)

1. create_goal(§0 原文,max_goal_rounds=60);
2. task_delegate 立卡:M0 协议核心(并行卡:§8.4 纸面定稿);
3. 定稿 §2 技术选型 → 搭 monorepo 骨架 + CI;
4. 交付 M0.1 信封校验器 + 黄金样本库首批向量,task_report 自报。