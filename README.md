# 群龙 Qlong

> 「见群龙无首,吉。」——《周易·乾·用九》

**命名体系**

| 项 | 值 |
|----|----|
| 正式名 | 群龙(全面取代此前的全部临时标记) |
| 品牌 / 域名 | Qlong —— 拼音 Qunlong 的品牌缩写;当前使用临时子域 `qlong.qianji.io`,独立域名暂不注册 |
| 仓库 | `github.com/lomehong/qlong` |
| 命令行 / 代码 / 包名 | `qlong` |
| 节点实例称谓 | 一台设备运行一条"龙",组网即"群龙" |
| 中心服务 | `https://qlong.qianji.io` |
| 单机形态 | 群龙单机:无网独立工作,分布式能力是叠加层 |

## 一句话定位

让每一台设备的 AI 都是一条自治的"龙":多设备各掌调度之权,以笨中心相连,**群龙协作,无首而治**。

## 它是什么

群龙是一个**分布式 AI Agent 协作系统**,以群龙单机程序(`qlong`)为基座:多台设备各自运行一个群龙实例——一台设备一条"龙",实例之间互相通讯,作为一个整体协同完成项目与任务。

- **架构原则:中心做服务,边缘做决策。** 中心(qlong.qianji.io)只做三件"笨"事——节点注册、消息中转、安装分发,**永不介入任务调度**;调度的智能完全下沉到每个节点。每条"龙"都是自治的"老板":自己接任务、自己拆解、自己干,也可以把子任务派给其他设备上的"龙"。**没有全局调度器。**
- **两种协同,同一条通道:** 项目级协同(跨设备分工、回收、校验、整合)与日常互助(问问题、委托小事、借用对方独有的环境与算力)。
- **分布式的价值在独有资源:** 本地环境、文件系统、工具链、GPU、网络位置——分布的不是模型,是"agent 与它的本地世界"。
- **单机形态完全保留:** 分布式是叠加的一层,拔掉网线,一条"龙"还是一台能独立干活的单机。

## 为什么叫「群龙」

《周易·乾卦》六爻皆龙。到了用九——六阳皆变、群龙并见之时,爻辞说:

> **见群龙无首,吉。**

在现代成语里,"群龙无首"被读成贬义(没头儿的乌合之众)。但原文恰恰相反:群龙各有其德、各全其性,没有一条龙凌驾于众龙之上,《易》断之为**吉**。更妙的是《象传》的注脚:

> **「用九,天德不可为首也。」**——天的德性,是不做那个"头"。

这两句三千年前的判词,就是这个项目的全部架构:

| 《易》 | 本项目 |
|--------|--------|
| 群龙无首,吉 | 无全局调度器;每个节点都是完整的自治"老板"(纪要 D1;项目面内牵头方为"首"、可接管——纪要 §5) |
| 天德不可为首 | 中心只做基础设施服务,永不介入任务调度(纪要 §1) |
| 群龙各有田渊 | 各设备贡献独有资源:环境、工具、GPU、网络位置(纪要 §7) |

命名上这是主动"夺回"一个被误读两千年的词:当一条条龙都完整而自治时,无首不是混乱,是《易经》盖章的最高等级的吉。

### 六爻彩蛋:一条龙的成长(工程映射,仅作雅趣)

| 爻 | Agent 生命周期 |
|----|----------------|
| 潜龙勿用 | 安装完成,尚未入网 |
| 见龙在田 | 注册在线,进入目录 |
| 或跃在渊 | 试接互助小单 |
| 飞龙在天 | 满载执行任务 |
| 亢龙有悔 | 过载必败——限流与快速拒绝的自觉(01 篇 R6) |
| 群龙无首 | 组网协同——吉 |

## 子系统雅称(仅用于文档与注释,工程标识一律用英文)

| 系统 | 工程名 | 雅称 | 典故 |
|------|--------|------|------|
| 注册中心 | registry | 谱牒 | 古代谱局掌名册户籍——管"你是谁、在不在" |
| 通讯网关 | gateway | 驿传 | 驿站递铺:在线即递,离线留存待领 |
| 分发服务器 | distributor | 书坊 | 宋以来民间刻书卖书之所,即"应用商店" |
| 团队 | team | 社 | 结社之社:同社互信,社外不通 |
| 任务派发 | task | 流觞 | 曲水流觞:杯流至谁前,谁赋诗——消息随流而至,接者任之 |
| 能力档案 | capability | 山海经 | 众机异能之图谱 |

## 文档

| 文档 | 内容 |
|------|------|
| [docs/QLONG_DESIGN_NOTES.md](./docs/QLONG_DESIGN_NOTES.md) | 设计纪要:愿景、架构、决策 D1–D5 |
| [docs/QLONG_DESIGN_01_MSG_PROTOCOL.md](./docs/QLONG_DESIGN_01_MSG_PROTOCOL.md) | 消息信封与派单可靠性语义(D6–D26) |
| [docs/QLONG_DESIGN_02_REGISTRY_TRUST.md](./docs/QLONG_DESIGN_02_REGISTRY_TRUST.md) | 注册中心数据模型与信任边界(D27–D30) |
| [docs/QLONG_DESIGN_03_CAPABILITY.md](./docs/QLONG_DESIGN_03_CAPABILITY.md) | 能力声明、感知派单与远端任务执行档案(D31–D33) |
| [docs/QUNLONG_DESIGN_REVIEW_REPORT.md](./docs/QUNLONG_DESIGN_REVIEW_REPORT.md) | 评审委员会报告(60 条意见,全部处置) |

## 状态

架构方向已确定。01–03 篇详细设计已成,经**三轮评审修订**,评审委员会 60 条意见全部处置。实现现状:packages/core(协议/JCS 签名/新鲜性/R0 闸门)、packages/node(双状态机/五道闸/执行档案/驱动)、packages/registry(enroll/目录锚定/纪元现势/grant/审计)、packages/gateway(ACL A0–A6/收件箱/回执帧/语义断连)、packages/cli(join/run/server/status/tasks)、packages/console(控制台)。跨机端到端 lost/改派演练通过。

> 商用前请自查商标与域名占用。

## v0.2 新增

- FileOutbox 持久化(原子写+崩溃恢复)
- 跨队 grant(Registry CRUD + Gateway ACL)
- §8.4 WorkspaceManager + PayloadStore
- deepseek-harness 驱动 + 弱网增强
- §8.5 安装器(scripts/install.sh + ps1)
- 审计查询路由 + 控制台 React App(packages/console)

## v0.3 新增(设计落地收口)

- **rpc.* 问答族运行时**(01 §4.1):ask/answer 按 request_id 关联、重投去重、超时兜底;内置 caps.query / status.query 应答器,支持自定义 rpcHandler
- **牵头方能力记忆**(03 §7):reject.missing / fail.missing_caps → 节点画像,`capabilityMemory()` 供改派软降权
- **节点 caps/load 周期上报**(03 §4):启动即报 + 60s 动态刷新(factory 一站式)
- **真实身份存档**(02 §3.2):identity.json(0600)在 join/run 间同源恢复,替换 v0.2 的空私钥占位
- **CLI 运营面**:qlong join(入网写配置)/ run(常驻节点)/ server(单进程中心三件套:registry HTTP + 通讯网关 ws)
- 修复 gateway grant.spec 类型错误;全量 **180 测试全绿**,5 包 typecheck 干净

## v0.4 新增(设计收尾:残余缺口清零)

- **同队缓冲带**(03 §6.3):per-source offer 限速(超限 reject busy)、远端任务开始/结束本地通知、本地即时暂停接单开关(独立于 accepting 快照)
- **能力自愈两段式**(03 §7 / D32):CapsHealth——10 分钟窗 ≥3 次 caps_missing → 软摘(24h 无复发自动恢复);确定性复核确认缺失 → 硬摘;24h 滞回防抖;cap_tag_suspected/removed/recovered 审计事件
- **最小指标集**(01 §11):NodeMetrics——lost 计数、drain 命中、attempt 分布、reject/fail 直方图、心跳抖动、escalate 率;session 全链路埋点,`session.metrics.snapshot()` 读取
- **日志关联规范**(01 §11):makeJsonLogger + logTaskEvent——任务日志强制 trace_id/task_id/attempt/msg_id 四字段,缺失在调用点抛错
- **目录变更即时推送**(02 §7.1):registry.onDirectoryChange(join/suspend/revoke/轮换触发),CLI server 订阅即推,60s 全量同步降为兜底
- **配额与 GC**(02 §4.2/I-16):每 owner 节点数配额(超限 429 quota_exceeded)、零成员单机 team 到期删除、长期离线节点吊销+档案清理;server 启动即跑 + 6h 周期
- **发布物校验和**(02 §10/I-16):package.mjs 生成 SHA256SUMS.txt;install.sh(sha256sum/shasum)与 install.ps1(Get-FileHash)下载后强制校验
- **R10 重定向加固**:payload 拉取一律不跟随 3xx,堵住白名单主机借重定向探测私网的绕过路径
- 去重保留期接线 R1 公式(dedupRetentionMs);全量 **198 测试全绿**,5 包 typecheck 干净

**待办(v0.5)**:git bundle payload 存储、网关集群化(02 §12.1)、跨机 leader 接管(01 §4.4 开放问题)、双机纸面走查回填任务书模板与 (状态×消息×定时器) 全矩阵、真实 deepseek-harness 联调。
