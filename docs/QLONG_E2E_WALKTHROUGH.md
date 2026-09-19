# 群龙双机走查剧本(v2 持久架构)

> 状态:**剧本 v2 定稿(对应 transport v2 持久栈 + D1 claim 注册表 + 牵头生产链路);双机实物待执行**。
> 目的:把"拆解 → 派单 → 取码 → 执行 → 产物回传 → 校验整合"在真实设备上跑通一遍,
> 验证 `QLONG_STATE_MATRIX.md` 的预期转移、§8.4 文件协同链路与跨机接管。
> 历史:第一幕(npx 通道真实 dsh 联调,2026-09-08)已执行通过,见文末附录。

## 〇、环境准备(两台设备:A=牵头方,B=执行方)

| 步骤 | 设备 | 命令/动作 | 预期 |
|------|------|-----------|------|
| 0.1 | A、B | `node --version` | ≥ 24(v2 持久栈依赖内置 node:sqlite) |
| 0.1b | A、B | `node scripts/drill-check.mjs`(仓库 checkout;或 `qlong doctor` 快查) | 全部 ✓,exit 0——覆盖凭证/中心/网关握手/存储准入/产物仓/dsh 通道(加 `--dsh` 探测) |
| 0.2 | A | `node scripts/package.mjs` → 部署中心(或用线上 `lomehong-qlong.ms.show`) | 首启:`qlong server --storage-mode create --confirm-local-filesystem`;**之后必须 `open`** |
| 0.3 | 控制台 | 首次打开 → 创建管理员 → 登录;团队页/安装页生成邀请码 | 一次性 token(30 分钟 TTL) |
| 0.4 | A、B | 执行 /install 安装命令(token 走 stdin) | 下载→校验→enroll→入网;**持久节点自启仅在 open+本地盘确认下注册** |
| 0.5 | A | `qlong run --storage-mode create --confirm-local-filesystem`(首启)→ 之后 `--storage-mode open` | 节点持久 v2 启动;控制台 Agent 页 online |
| 0.6 | B | 同 0.5 | 同上 |
| 0.7 | 双方 | `qlong run` 追加 `--auto-select` | 启用目录驱动改派选择器(牵头方改派/接管续跑所需) |

> 铁律:数据库丢失/损坏走显式恢复,不能改回 `create` "修复"(CENTER-STORAGE.md);
> 数据目录必须在本地盘(NFS/SMB/云同步盘会拒绝启动)。

## 〇b、剧本 0:单机形态(一条龙独立干活,愿景基线)

> "单机形态完全保留:拔掉网线,一条'龙'还是一台能独立干活的单机。" 无第二台设备时,
> `--originate` 找不到其他可用目标会**自派单**(本进程 lead→executor 闭环),一条龙即可全链跑通。

```sh
qlong run --storage-mode open --confirm-local-filesystem --confirm-windows-acl --auto-select --originate task.json
# 日志:"无其他可用目标:自派单(单机形态,本机执行)" → 任务本机执行 → done
```

## 一、剧本 1:互助闭环(aid,任务书四要素)

牵头方 A 启动即发起(任务书文件 `task.json`):

```json
{ "kind": "aid", "summary": "【目标】在 /tmp/qlong-probe 写入一行 pong 并打印该行
【边界】仅允许写 /tmp/qlong-probe
【完成判据】stdout 出现 pong", "lease_ms": 300000, "offer_ttl_ms": 60000 }
```

```sh
# A(牵头方):发起并派给 B(显式 target),或省略 target 由选择器按 caps 挑选
qlong run --storage-mode open --confirm-local-filesystem --auto-select   --originate task.json            # task.json 可加 "target": "<B 的 node_id>"
```

| 步骤 | 预期消息(方向) | 对应断言 |
|------|------------------|----------|
| 1.1 | A→B `task.offer`(attempt=1) | B 闸2/闸3 全过 → offered;中心 custody `stored` |
| 1.2 | B→A `task.accept` | A offered→running;B 执行租约起算 |
| 1.3 | B→A `task.progress` ×N | 心跳续租;A(lead)回发 `task.lease.renew`(B2 业务续租) |
| 1.4 | B 侧真实执行 | dsh headless cwd=工作区,stdout=结果 |
| 1.5 | B→A `task.result` | A 验收(aid 兼容规则)→ done ✅;中心任务投影终态 |

观测:控制台 任务管理页(A 的 team)出现任务投影与状态流;`qlong tasks` 查询。

## 二、剧本 2:三个异常路径

- **2a 拒单改派**:B 无 `tool:ios-sign` 标签,A 的 task.json 带 `"required_caps": ["tool:ios-sign"]`
  → B `reject(unsupported_caps, missing)` → A 记录能力记忆 → 选择器避开 B 改派有标签节点 → done;
- **2b 执行中失败**:执行方 driver `fail(internal_error, retryable=true)`
  → A cancel(reclaim)→ drain 窗口 → attempt+1 改派(R8 排除表避开失败节点)→ done;
- **2c 验收失败**:project 任务 result 不符验收判据
  → A cancel(acceptance_failed)→ attempt+1 重做(R4/D25)。
  注:project 验收策略当前为机器默认(保守拒绝)——2c 天然可实测;自定义判据注入待 owner/IPC 阶段。

每条对照 `QLONG_STATE_MATRIX.md` §1.1/§2.1;失配即先改表再改码。

## 三、剧本 3:项目协同(§8.4 文件协同)

> 前置(硬性):**执行方 B 入网时必须携带产物仓** —— `qlong enroll --artifact-repo <git 路径>`
> (或环境变量 `QLONG_ARTIFACT_REPO`);未配置时 PROJECT offer 一律 `policy_denied`(e2d-2d),
> 这是有意的验收防线而非缺陷。牵头方 A 亦建议携带(牵头侧 collect/resolve 默认接线,e2d-3)。

1. A 的 task.json 用 `"kind": "project"` + workspace/deliverables 字段(§8.4);
2. B 接单:WorkspaceManager.clone(worktree)→ dsh 执行 → `pushArtifacts` 提交 `qlong/<task>` 分支;
3. B `task.result` 携 artifacts 引用;A 按默认验收策略判定(见 2c 注)。

## 四、剧本 4:多网关集群(D1 claim 注册表,v2 形态)

> v2 的集群语义 = **多网关 authority 共享同一中心 SQLite**(custody + claim 表)+ `/internal/pump` 中继。
> 旧 `QLONG_CLUSTER_SECRET/QLONG_CLUSTER_PEERS` 属 legacy 分片模型,持久模式下**拒绝配置**。
>
> **当前边界(诚实声明)**:双 authority 共享库已在网关/存储层完整验证
> (`gateway/test/custody-relay.spec.ts` 等以共享 SqliteStore 的双实例端到端覆盖);
> 但 CLI 级"两个 `qlong server` 进程开同一数据目录"会被中心**所有权独占锁**拒绝
> (`OWNERSHIP_BUSY`,单写者是设计而非缺陷)。解锁依赖 gateway-only 进程形态(中心持库、
> 网关进程经授权通道读写 custody/claim)——列入下一阶段。**实物演练本轮以单中心单网关为准**,
> 以下步骤保留为该形态落地后的验收清单。

| 步骤 | 动作 | 预期 |
|------|------|------|
| 4.1 | gateway-only 形态:中心持库,起 gw1、gw2 两个网关进程(`QLONG_RELAY_SECRET=<共享密钥>`、gw1 另设 `QLONG_RELAY_PEERS=http://127.0.0.1:<gw2端口>`,反之亦然) | 双 authority 共享 custody/claim 表 |
| 4.2 | a_node 连 gw1,b_node 连 gw2 | 控制台两节点均 online |
| 4.3 | a_node 给 b_node 发 project 单(b 离线先不入网) | ack=stored;pending 静置共享库 |
| 4.4 | b_node 连上 gw2 | 认证即补投(pump);再发一条 → gw1 查 claim 发现现主是 gw2 → `/internal/pump` 通知 → 即时推送 |
| 4.5 | 渗透自检 | 无密钥头 POST /internal/pump → 403;伪造 generation → `pumped:false`(fence 守卫);claim 库停用 → 500 fail-closed |
| 4.6 | 停 gw1 | 其上连接租约 30s 内过期;节点重连 gw2 → claim gen+1 → gw1 若复活,旧 claim renew 被拒(fence-drop 4000 'superseded') |

## 五、剧本 5:跨机接管(C2 + 运维命令,新)

前置:A 上有一个 running 牵头任务(剧本 1 发起后)。

| 步骤 | 设备 | 命令 | 预期 |
|------|------|------|------|
| 5.1 | A | Ctrl+C(等停机 flush 完成) | 在跑任务终态落中心;节点停机 |
| 5.2 | A | `qlong lead export --out bundle.json --key <操作员32字节hex种子> --data-dir <A数据目录> --storage-mode open --confirm-local-filesystem` | `已导出 N 个牵头任务(已签名)` |
| 5.3 | 运维 | 把 bundle.json 安全传给 B(scp 等) | — |
| 5.4 | B | `qlong run --storage-mode open --confirm-local-filesystem --auto-select --takeover bundle.json --takeover-key <同一种子hex>` | `跨机接管:重派 N | fenced M | 归档 K`;在途任务 attempt+1 重派新执行方 |
| 5.5 | 反向验证 | 把同一 bundle 再次 import 到 A(若 A 复活) | fenced(禁双主回退,attempt 高水位仲裁) |
| 5.6 | 渗透 | 篡改 bundle 中任一 attempt 后 import | 验签失败 bad_sig,拒绝接管 |

种子生成:`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`(操作员自持,勿提交)。

## 六、走查产出

### 6.0 同机三节点实物演练记录(2026-09-19,v2 持久栈,自建中心)

第一轮实物演练在同机以四进程形态执行(1 持久中心 + 3 节点,a/b/c/d 各独立 QLONG_HOME;
自建中心 3460 端口,`--storage-mode create` 起,Windows ACL 准入)。真实执行结果:

- **剧本 0/1 ✅**:a 以 `--originate` 发起 aid 单,目录选择器选中 b(排除自身),真实 dsh
  (npx @deepseek-ai/dsh 0.1.5-rc.2)执行,**done / attempt 1**;中心任务投影终态一致。
- **剧本 2a(变体)✅**:带 `required_caps:[tool:ios-sign]` 的单,选择器**首派即命中**带标签的 c
  (caps 过滤在派单层生效,未发生拒单)→ done / attempt 1;闸3 拒单路径由单测覆盖。
- **剧本 5 ✅(带两个真实发现)**:a 再发单后**硬杀**(模拟故障)→ `qlong lead export`
  导出 3 任务签名 bundle → 节点 d `run --takeover` 验签接管:
  `重派 1 | fenced(禁双主)0 | 归档 2`(终态归档不重跑、在途 attempt+1 重派,语义精确)。
  后续预算链如实暴露两个发现:
  1. **R8 排除缺口**:offer TTL 过期的目标不进排除表(`applyExclusion` 只挂 reject/fail 路径)
     → 死节点被反复选中直至预算耗尽 escalate(已登记 R-MATRIX §5 T6,待 TDD 修复);
  2. **接管撞单槽**:重派单被仍在执行原 attempt 的节点以 policy_denied 拒(单槽 + 租约未到期,
     行为正确)——接管操作节奏应避开原租约窗口,或先 cancel 原 attempt。
- 运维备注:身份 pinning 护栏真实生效——用错误 QLONG_HOME 对 a 库执行 lead export 被
  "Runtime database belongs to another node" 拒绝;`create` 对已存在库拒绝(生命周期纪律)。

### 6.1 待回填(第二台实体设备)

- [ ] 剧本 1 通过(记录消息时间线与 custody stored/receipt);
- [ ] 剧本 2a/2b/2c 通过;
- [ ] 剧本 3 通过(记录 git 分支与产物校验);
- [ ] 剧本 4 通过(记录 claim generation 序列与 pump 中继日志);
- [ ] 剧本 5 通过(记录 attempt 高水位变化与续跑证据);
- [ ] 仅凭双方日志 + trace_id 离线还原一次派单全生命周期(评审 I-34⑤);
- [ ] 发现的隐藏决策/偏差回填状态矩阵与本剧本。

## 附录:第一幕记录(历史,2026-09-08)

`npx @deepseek-ai/dsh@0.1.2-rc.1 --profile headless "reply with the single word: pong"` → 输出 `pong`,exit 0(31s);
同任务经 DeepSeekHarnessDriver 默认 npx 通道(零覆盖)→ complete 收到含 pong 的答案。
上游版本(2026-09-19 复核):npm dist-tags latest 0.1.5-rc.2 / **alpha 0.1.6-alpha.2**;用户 dsh-desktop 运行时已升级至 v0.1.6-alpha.2(与 alpha 线一致)。v2 生产驱动为 `FencedProcessDriver`(fence→pid 落盘,recover 据此判定孤儿)。
