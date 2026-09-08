---
title: 群龙 Qlong
short_description: 分布式 AI Agent 协作系统——每台设备一条自治的"龙"
---

# 群龙 Qlong

> 「见群龙无首,吉。」——《周易·乾·用九》

**命名体系**

| 项 | 值 |
|----|----|
| 正式名 | 群龙(全面取代此前的全部临时标记) |
| 品牌 / 域名 | Qlong —— 拼音 Qunlong 的品牌缩写;当前使用临时子域 `lomehong-qlong.ms.show`,独立域名暂不注册 |
| 仓库 | `github.com/lomehong/qlong` |
| 命令行 / 代码 / 包名 | `qlong` |
| 节点实例称谓 | 一台设备运行一条"龙",组网即"群龙" |
| 中心服务 | `https://lomehong-qlong.ms.show` |
| 单机形态 | 群龙单机:无网独立工作,分布式能力是叠加层 |

## 一句话定位

让每一台设备的 AI 都是一条自治的"龙":多设备各掌调度之权,以笨中心相连,**群龙协作,无首而治**。

## 它是什么

群龙是一个**分布式 AI Agent 协作系统**,以群龙单机程序(`qlong`)为基座:多台设备各自运行一个群龙实例——一台设备一条"龙",实例之间互相通讯,作为一个整体协同完成项目与任务。

- **架构原则:中心做服务,边缘做决策。** 中心(lomehong-qlong.ms.show)只做三件"笨"事——节点注册、消息中转、安装分发,**永不介入任务调度**;调度的智能完全下沉到每个节点。每条"龙"都是自治的"老板":自己接任务、自己拆解、自己干,也可以把子任务派给其他设备上的"龙"。**没有全局调度器。**
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

## v0.6 新增(deepseek-harness 真实契约 + 书坊 + 多版本安装)

- **上游真实事实落地**(github.com/deepseek-ai/deepseek-harness):npm 包 `@deepseek-ai/dsh`,入口 `dsh`;
  无人值守模式 `dsh --profile headless "<job>"` —— 一次性持久会话,stdout 打印最终答案后退出;
  调用目录即默认工作区。据此重写 DeepSeekHarnessDriver:
  默认 `npx --yes @deepseek-ai/dsh --profile headless <任务书>`(Windows 经 shell);
  `DSH_HARNESS_CMD` 可覆盖为全局安装/源码 checkout 的 dsh;`DSH_HARNESS_PKG` 换包名;
  cwd = §8.4 工作区(DriverTask.workdir 贯通 WorkspaceManager);
  任务书 = summary + contract 交付物/验收判据 + 时限提示(composeTaskPrompt);
  退出码 0 → result(stdout 尾部为答案),非零 → fail(retryable);
  任务级硬上限默认 30 分钟(SIGTERM→宽限→SIGKILL);真实 spawn 集成测试经 commandLine 覆盖钩子
- **书坊分发落地**(纪要 §3 第三服务):registry HTTP 增加 `--dist-dir` 静态托管——
  `/install.sh`、`/install.ps1`、`/install`(入口页)、`/releases/<版本>/<文件>`,
  路径穿越防护(P12);CLI `qlong server --dist-dir` 一键启用
- **多版本安装**:package.mjs 产出到 `dist-release/<版本>/` 并镜像 `latest/`,
  安装脚本支持 `--version vX.Y.Z` / 环境变量 `QLONG_VERSION`;携带脚本与产物严格同源
- **Console 节点安装页**:生成一次性邀请码 → 按平台给出可复制安装命令,支持选择版本

## v0.8 新增(收件箱落盘 · 网关跨进程总线 · 控制台 URL 路由 · 双机演练支撑)

- **FileMailboxStore(网关收件箱落盘,v0.8-1)**:InboxStore 可选 `persistFile` ——
  每次变更原子写(tmp+rename),构造时自动恢复;网关重启离线 project 单不丢。
  CLI/服务器经 `QLONG_MAILBOX_FILE` 启用;落盘失败不阻断投递(端上 R1/R2 兜底正确性)。
- **网关跨进程总线(02 §12.1,v0.8-2)**:`GatewayCluster.routeAsync` 三级路由 ——
  ①in-process 成员直投 → ②总线转投远端实例(在线 delivered / 离线 queued)→ ③home 分片兜底入箱;
  内置 `HttpClusterBus`(POST /internal/envelope,`x-qlong-cluster-secret` 共享密钥,
  信任域内仍过 validateEnvelope;Redis pub/sub 按同接口替换)。
  双端口形态由网关自暴露中继;单端口形态由 registry http 承载同名路由。
  服务器环境变量:`QLONG_CLUSTER_SECRET` / `QLONG_CLUSTER_PEERS` / `QLONG_CLUSTER_NAME`。
  集成测试:双网关实例跨总线在线直投全任务闭环、离线落彼收件箱补投、错密钥 403 → 本地兜底。
- **控制台 URL 路由化(v0.8-3)**:hash ↔ 页面双向同步 —— `#/install` 等深链接直达对应页,
  刷新/分享可恢复;401 → `#/login`,登录后回续登录前想去的页面;导航不再重发会话探测。
- **双机演练支撑(v0.8-4)**:走查剧本新增"剧本 4:双网关集群"——
  集群环境变量起双实例、跨实例派单/补投、收件箱落盘重启恢复、中继端点渗透自检,七步命令级清单。
- 全量 **240 测试全绿**(新增总线端点鉴权/跨进程直投/落箱补投/兜底、服务器集群接线 8 用例),5 包 typecheck 干净。

**待办(v0.9)**:双机实物演练执行与走查产出回填、Redis 总线传输替换验证、真单文件二进制(Node SEA)评估、控制台 E2E 自动化。

## v0.7 新增(v0.6 待办五件全部兑现)

- **真实 deepseek-harness 联调 ✅**:上游事实经仓库核实(npm `@deepseek-ai/dsh`,latest 0.1.2-rc.1;
  `dsh --profile headless "<job>"` 一次性会话,stdout 输出最终答案后退出;调用目录即工作区)。
  `DeepSeekHarnessDriver` 默认 npx 通道**零覆盖**实测:真实模型任务 31s 返回,complete 收到含答案的 result;
  门控测试 `QLONG_DSH_E2E=1` 可复跑;新增 `qlong doctor` 联调前检查(node/凭证/registry 可达性)
- **GitPayloadStore(§8.4)**:共享 bare 仓内对象分发——每负载一个 blob 挂 `refs/payload/<sha256>`
  (独立根提交,fetch --depth 1 精确自足,多负载互不影响);store 走 plumbing(hash-object→mktree→
  commit-tree→update-ref),https 远端走临时 worktree;`fetchPayloadGit` sha256/size 校验 + R10 基线
  (非 https repo 须节点放行);产物回传 `pushArtifacts`(执行方推 `qlong/<task>` 分支)+
  `collectArtifacts`(牵头方收取产物树)
- **网关集群化 v1(02 §12.1)**:`GatewayCluster`——连接注册(member.has)在线直投;
  FNV-1a 稳定分片,离线 project 单落 home 分片网关收件箱(节点连回 home 即补投);
  `GatewayCore` deferOffline 语义;同进程多实例 + 外部 LB 为 v1 形态,跨进程总线列 v0.8
- **跨机 leader 接管(01 §4.4 导出/导入候选)**:`exportCheckpoints/importCheckpoints`——
  bundle 携带 attempt 高水位与在途清单;导入 fence(在途 attempt+1 归位 drafting,
  原执行方迟到消息即刻 R0 拒收;本地高水位 ≥ 导入 → 跳过,禁双主回退;终态归档)
- **双机走查文档三件套**:`QLONG_TASK_BRIEF_TEMPLATE.md`(任务书四要素模板 + 注入防线)、
  `QLONG_STATE_MATRIX.md`((状态×消息×定时器)全矩阵,与实现逐格对齐 + 测试生成清单)、
  `QLONG_E2E_WALKTHROUGH.md`(双机剧本 + 第一幕 npx 联调记录 + 故障注入清单)
- `qlong doctor` 联调前检查;全量 **225 测试全绿**(含门控真实联调 1 项),5 包 typecheck 干净

**待办(v0.8)**:网关跨进程总线(Redis pub/sub,route 接口已可替换)、双机实物演练执行(剧本已备)、
控制台 URL 路由化(/install 直达 React 页)、FileMailboxStore(收件箱重启存活)。
—— **v0.8 已兑现,见上**;Redis 传输替换验证移入 v0.9。

## v0.5 新增(安装器完整化:真实联调前置件)

- **CLI `enroll --stdin` 子命令**:修复安装脚本调用了不存在命令的断裂;token 经 stdin 传入(评审 I-16),无效邀请码输出人话 + 重新生成指引(I-23③)
- **`qlong service install/uninstall`**:三平台自启注册——Linux systemd user unit(Restart=on-failure)/ macOS LaunchAgent(RunAtLoad+KeepAlive)/ Windows 计划任务(ONLOGON,免外部依赖);纯函数生成注册物,单测覆盖
- **安装脚本接通全链**:下载 → SHA256 校验 → enroll(stdin)→ 服务化自启 → `qlong status` 验收入网状态(I-22"装完即在线/重启自动在线"清单);`--uninstall` / `-Uninstall` 一键解除自启 + 删除二进制 + 清除凭证 ~/.qlong
- **平台产物补齐**:package.mjs 现产出 qlong-{linux,darwin}-{x64,arm64}(shebang 单文件,目标机需 node ≥20)+ qlong-win-x64.cmd 垫片;安装脚本增加 node ≥20 检测
- 注:真单文件二进制(Node SEA/bun compile)列为 v0.6 可选,当前为"bundle + node 运行时"形态

**待办(v0.6)已全部由 v0.7 兑现**(git bundle/集群化/跨机接管/走查文档/真实联调)。
