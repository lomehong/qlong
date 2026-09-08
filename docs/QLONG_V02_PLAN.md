# 群龙(Qlong)v0.2 实现规划

> 前置:v0.1 已完成(157 测试全绿,提交 4c15cfb)
> 主任指令:系统性完成 §8.4 文件协同、deepseek-harness 基座适配、§8.5 安装器、§8.6 弱网、跨队 grant、控制台 UI、FileOutbox 持久化
> FileOutbox 持久化已在 v0.1 收口后完成(05ad9d8)

## 交付项与依赖

| # | 交付项 | 依赖 | 优先级 |
|---|--------|------|--------|
| D1 | 跨队 grant 模型(设计+实现) | 无 | P0 |
| D2 | §8.4 文件协同(设计定稿+实现) | D1(跨队可见性) | P0 |
| D3 | deepseek-harness 真实基座适配 | M1 驱动接口 ✅ | P0 |
| D4 | §8.6 弱网(重连协议+消息持久化策略) | R11 outbox ✅ | P1 |
| D5 | §8.5 安装器(install.sh + install.ps1) | enrollment ✅ | P1 |
| D6 | 控制台最小面(API 路由 + CLI 增强) | 全部 API 稳定 | P2 |

## 实现顺序

Phase 1: D1 跨队 grant → D2 §8.4 文件协同(设计→实现)
Phase 2: D3 deepseek-harness 适配 → D4 §8.6 弱网
Phase 3: D5 §8.5 安装器 → D6 控制台最小面

## 1. D1 跨队 grant 模型

### 设计(02 §12.1 兑现)

- Grant 表:`{grant_id, from_team, to_team, caps_visible: string[], expires_at?, created_by, created_at}`
- 信封:`to.team_id` 已预留(01 §3.1);A1 锚定后检查 grant 表
- API:`POST /v1/teams/{id}/grants`(owner)+ `GET /v1/teams/{id}/grants`(owner)+ `DELETE /v1/teams/{id}/grants/{gid}`(owner)
- ACL 变更:A1 锚定后,若 from_team ≠ to_team,查 grant 表;有授权 → 放行(限制 caps 可见性);无 → 拒绝(现状)
- 网关:目录快照携带 grants 列表

### 实现(packages/registry + packages/gateway)

- Registry:grants Map + CRUD + snapshot 携带 grants
- Gateway:evaluateUplink 增加 grant 检查分支
- 测试:授权后跨队投递通过;过期/撤销后拒绝;能力可见性限制

## 2. D2 §8.4 文件协同

### 设计定稿(纪要 §8.4 兑现)

- **工作区隔离**:每 task 一个 git worktree(基于 offer.workspace.repo + base_ref)
- **payload 存储**:v0.1 临时方案(本地 https + sha256)升级为「git 仓库内对象」——payload 打包为 git bundle 推送到共享 repo,执行方通过 git fetch 拉取
- **产物回传**:执行方将产物写入 worktree → git commit → push → 牵头方通过 git pull 收取;payload_ref 的 ref_uri 指向 git 仓库中的 blob SHA
- **冲突预防**:contract.deliverables 声明文件路径,A 侧检查无重叠(幂等信任)

### 实现

- packages/node/src/collab/workspace.ts:WorkspaceManager(git worktree 生命周期)
- packages/node/src/collab/payload-git.ts:GitPayloadStore(打包/拉取,替换 R10 临时 https 方案)
- 集成:闸5 工作区检查引用 WorkspaceManager;驱动通过 workspace 路径访问文件

## 3. D3 deepseek-harness 适配

### 设计

- DeepSeekHarnessDriver 实现 ExecutorDriver 接口
- 内部:spawn deepseek-harness CLI 进程 → 注入 offer.summary 为系统提示 → 监听输出 → 超时终止
- 会话映射:harness 会话 ID ↔ task_id;结果提取:末次输出

### 实现

- packages/node/src/driver/harness-driver.ts
- 环境变量 DSH_HARNESS_CMD 可配置命令路径
- 优雅终止:SIGTERM → 等待 → SIGKILL

## 4. D4 §8.6 弱网

- 重连:指数退避加抖动(已有);断线期间入站任务的 lost 计时暂停(已实现 I-09)
- 新增:消息持久化阈值(offline > N 分钟 → 降级为本地缓存,不删)
- 新增:网关收件箱过期清理周期(当前仅在补投时过滤)

## 5. D5 §8.5 安装器

- install.sh(Linux/macOS):下载 qlong 二进制 → systemd/launchd 注册 → 交互式 enroll
- install.ps1(Windows):下载 qlong.exe → Windows 服务注册 → enroll
- 两个脚本均从 stdin 读 enrollment token(评审 I-16②)

## 6. D6 控制台最小面

- registry HTTP 新增 owner 路由:GET /v1/teams/{id}/overview、POST /v1/teams/{id}/nodes/{nid}/actions
- CLI 增强:qlong status / qlong tasks / qlong team list
- v1 以 CLI + API-only 兑现(设计明确允许,评审 I-21)