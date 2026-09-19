# 产物可信验收设计（E2 / 01 §4.2·§5.2 验收归途 · 03 §6 闸4 · PROTOCOL-V2 同场设计）

> 本文兑现计划 E2「产物回传的可信验收（contract.deliverables 校验、签名/哈希链、验收方独立复核），
> 而非执行方自证」。**E1（容器 network-none 强隔离 + 模型 broker）已由用户确认跳过**——容器仅用于
> ModelScope 部署中心，节点为**受信自托管**。故 E2 **解耦 E1 重定义**为「产物**完整性**验收」：价值从
> 「防恶意执行方伪造产物」转为「**查损坏 / 契约不符 / 传输篡改**」，验收方（牵头节点）独立复核执行方
> 交付的产物字节，而非采信执行方自报的 `acceptance_results[].pass`。
>
> 用户选定的三项设计分叉（本文据此定稿）：
> - **范围**：完整性验收核心（清单 + 执行方产清单 + 牵头方真实验收器 + 契约线入 + 端到端接线 + 篡改/损坏拒绝测试）。
> - **防篡改信任根**：**额外单独签名 manifest 入 git 产物分支**（复用 `core signBytes` ed25519，即使信封被剥离/产物离线搬运仍可独立验签）。
> - **验收方位置**：**牵头节点本地验收**（复用既有验收闸 `validateAcceptance`，牵头方天然独立于执行方）。
>
> 本文是**设计**，不是计划文件；实施按 §6 分片走 TDD（RED→GREEN→变异检验 + 独立提交）。

## 0. 实施状态（历史基线 vs 当前能力）

> §2「现状（证据）」与 §3「缺口」表记录的是**设计定稿时**（E2a 之前）的基线，用于说明动机，不表示当前仍缺。
> 截至当前工作树（HEAD `959f3fc` = e2d-1/2/3 已提交 + 未提交 e2d-4 端到端收口）：
> - **已落地**：e2a 清单/签名/摘要原语、e2b git 集成（pushSignedArtifacts/collectArtifacts）、e2c 牵头验收器
>   （verifyArtifactDelivery 完整性判定 + LeadRecord.contract 持久化 + per-task 同步判定缓存 + stageArtifactVerification 异步预置）。
> - **P0 复核加固（已提交 `761b48a`/`9cc6117`）**：清单绑定 task/attempt/署名者 + 结构准入（validSignedManifest）；成功缓存改为**每任务一份**
>   「完整信封摘要 + 持久验收上下文 + 判定/在途令牌」，杜绝跨任务/attempt/契约/签名上下文误复用；取消/改派/接管/终态/消费
>   即回收，异步 I/O 完成后重读持久状态复核上下文；派发/改派对非法契约**改状态前**拒绝（不闭锁节点）；artifact-only 声明
>   当前无字节映射端口 → 明确判 false（不静默跳过）。
> - **e2d-1 已落地（已提交 `3918709`）**：durable per-fence 工作区生命周期——执行器新增 `workspace` 端口（`prepare`→解析 cwd 于 `'starting'` 提交前、事务外；结果/失败密封后 `release`；`unknown`/`recovery_required` 绝不 release），`FencedProcessDriver` 消费 `ctx.cwd`（优先于静态 workdir），`FencedWorkspace` 按精确 fence 派生隔离目录（跨 attempt/generation/run 不串产物、路径越界与非法 fence 拒绝、os.tmpdir 缺省根），`createDurableNode` 透传 + CLI 移除静态 `workdir: home`。
> - **e2d-2 已落地（已提交 `71c502e`）**：执行侧产物发布——执行器新增 `ArtifactPublisher` 端口，完成路径经 `publishAndFinish` 在 **SQL 事务外**调用 `publish(fence,offer,ctx,outcome)`（门控 `result + publisher + 同 fence + 无 stopReason`；发布抛错/返回非法 outcome → 干净 `task.fail(artifact_publish_failed)`，取消优先不发布）；`GitArtifactPublisher`（collab/artifact-publisher.ts）读契约声明文件（路径严格限定工作区内、缺件不入清单不伪造）、`buildManifest`+`signManifest`、异步 `publishSignedArtifacts` 发布到**每-attempt 分支** `qlong/<task>/a<attempt>`（绝不 force、`AbortSignal.timeout` + 字节预算），注入 `body.artifacts=[{repo,manifest,branch}]`；PROJECT 准入以**节点级 `artifactRepo` 配置**门控（未配置 → `policy_denied` fail-closed，aid 不受影响），`createDurableNode` 装配 + CLI `--artifact-repo`/config 接线。
> - **e2d-3 已落地（已提交 `959f3fc`）**：牵头侧默认接线——`collectSignedArtifacts`（payload-git，异步按**每-attempt 分支** `qlong/<task>/a<attempt>` 收取，branch 缺省回落单分支）+ `createGitArtifactCollector`（collab/artifact-collector.ts，git→字节端口适配，派生唯一 scratch 读完即清、传输失败/超时/预算超限 → `{ok:false,reason}` 绝不抛到 drain）+ `createPubkeyResolver`（registry-verifier.ts，`GET /v1/nodes/{id}/pubkey?epoch=N` 回源执行方登记公钥，守卫 node_id/key_epoch/status，失败一律 `undefined` fail-closed）；`DurableLead` 装配 collect/resolve 端口，`node.ts` **无条件默认接线**（`?? createGitArtifactCollector()` / `?? createPubkeyResolver(opts, me)`，不 gate on `artifactRepo`——纯牵头节点仍需验收），drain `ledByUs` 分支在 `lead.consume` 前 `await lead.stageArtifactVerification(env)`。
> - **e2d-4 已落地（本轮，未提交）**：E2 端到端收口——真实 git bare 仓 + registry HTTP 桩，**不注入端口走默认装配**，PROJECT 正向（完整签名产物四道防线全过 → `done`）与反向（产物被掉包/重新哈希不符 → 验收拒绝 → `reclaiming` + `task.cancel(acceptance_failed)`，绝不误判 done）；`keyRequests` 断言证明 collect+resolve 管线跑通（区别于端口缺席短路——短路则 keyRequests 空）。
> - **验证（e2d-4）**：durable-node.spec.ts e2d-4 描述块 2 测绿（正向 done / 反向 reclaiming+cancel）；2 靶点变异（M1 移 `?? createGitArtifactCollector()` / M2 移 `?? createPubkeyResolver(opts,me)`）均捕获（正+反向 RED：正向 done→reclaiming、反向 keyRequests 空），node.ts 字节还原（sha256 `35586B82…D0D0B` 匹配基线）；七包 typecheck 绿；
>   node 全量独立运行 **42 文件 864 passed、0 skip、exit 0**；全仓 cli 130、console 36、core 205、gateway 170、node 864、registry 243、storage 36|2skip（合计 **1684 passed**；各包独立运行全绿；
>   `pnpm -r` 串行合并运行触发 tinypool `ERR_IPC_CHANNEL_CLOSED`——pnpm→vitest→tinypool 嵌套 worker 拆卸 IPC 竞态，Windows/Node24 环境级 flake 非代码，崩溃落在未改动的 gateway 包，逐包独立运行 exit 0 规避）。

## 1. 约束（不可违背）

1. **验收方 ≠ 执行方自证**：牵头方对 `contract.deliverables` 独立复核——**重新哈希**收取到的产物字节、
   比对执行方签名清单、核对契约完整性。执行方 `acceptance_results[].pass` 仅作诊断，**绝不**单独决定验收
   （machine.ts:90-96 既有立场：PROJECT 缺省拒绝执行方自报 pass）。
2. **防篡改 = 单独签名清单**：产物清单（逐 deliverable `sha256+size`）以执行方 **ed25519 私钥单独签名**
   （`core signBytes` over JCS 规范化字节，复用 D23 同一信任根与算法白名单），签名清单 **commit 进
   `qlong/<task>` 产物分支**。清单声明 `node_id + key_epoch`，牵头方按注册中心 `GET /v1/nodes/{id}/pubkey?epoch={n}`
   取执行方**登记公钥**验签（同 createRegistryVerifier 的入站验签路径，registry-verifier.ts:96-103）。
3. **纯同步状态机不可破**：`LeadTaskMachine` 是纯同步状态机，`validateAcceptance(resultBody)=>boolean`
   在 `runEvent`→`onMessage` 内**同步**调用于 CAS 事务 runner 中（lead.ts:205-208/407-411）。产物的重 I/O
   （git collect）与异步 I/O（HTTP 查公钥）**绝不**在机器回调内做——须在 **drain 异步消费路径预置**
   （node.ts:307-331，`lead.consume` 前），机器回调只**同步读取预置判定**。
4. **契约线入验收器**：核对完整性需 `contract.deliverables`，但 `validateAcceptance(resultBody)` 只收 body。
   故 `LeadRecord` 须持久化本任务 `contract`（派发时从 `offerBody.contract` 落存），`DurableLead.machine(task)`
   按任务重建机器时以**闭包捕获 task**注入 per-task 验收器——机器签名不变（仍 `(resultBody)=>boolean`）。
5. **验收失败归途不变**：清单验签失败 / 哈希不符 / 契约不完整 → 验收器返回 false → 既有
   `acceptance_failed`→`beginReclaim`→改派归途（machine.ts:242-247/327-331，R4/I-24，已充分测试）。**E2 不新造归途**。
6. **fail-closed**：PROJECT 无预置判定（未产清单 / 预置失败 / 清单缺失）→ 验收器 false（既有缺省语义），
   绝不让缺清单的产物蒙混过关；aid 保留 v1 `acceptance_results` 兼容规则（machine.ts:94-96），**不回归**。
7. **零新增外部依赖**：签名复用 `@noble/ed25519`（经 `core signBytes/verifyBytes`）、规范化复用 `core jcs`、
   哈希复用 `node:crypto createHash('sha256')`（同 payload-git.ts:94/175）、传输复用 `pushArtifacts/collectArtifacts`
   的 git 子进程（`execFileSync`，已存在）。**不引入任何新 npm 包**（沿用假设 line 144）。
8. **存储铁律**：产物清单/判定为**运行时派生**，不入中心 schema；牵头侧 `contract` 存入既有 lead 运行时状态
   （RuntimeJson，非 SQL 表），追加可选字段 + `validTask` 容错，**不改 v1/v4 迁移校验和**（假设 line 145）。
   产物 git 分支的 GC 只回收**终态且过保留窗口**的任务分支，**绝不删除在途/未验收产物**。

## 2. 现状（证据）

- **入站 payload 已内容寻址校验**：`GitPayloadStore.store`（payload-git.ts:89）以 sha256 命名 blob；
  `fetchPayloadGit`（payload-git.ts:143）fetch 后**校验 sha256+size**，篡改 sha→ref 不存在→拒（payload-git.spec.ts:35-51）。
  **出站产物无此校验**——这是 E2 核心缺口。
- **产物 git 传输已在但未接线**：`pushArtifacts`（payload-git.ts:191，执行方 commit 到 `qlong/<task>` 分支）
  + `collectArtifacts`（payload-git.ts:218，牵头方 fetch 分支导出到本地）。**全仓仅 payload-git.ts 与其 spec 引用**，
  未接入 executor/lead 运行时；且**产物侧无逐文件哈希、无清单、无签名**。
- **验收闸机制已建且测试充分**：`validateAcceptance` 注入点（machine.ts:75/85-97、lead.ts:81/165/250、node.ts:96/274）；
  PROJECT 缺省 fail-closed（machine.ts:93）；acceptance_failed→reclaim→改派（machine.ts:242-247）；
  machine-safety.spec.ts:102-156 `lead acceptance safety` 5 组固化（缺 validator fail-closed / 仅经 validator 放行 /
  validator 否决自报 pass / 撤销期验收失败不 done / aid 兼容）。**但 `validateAcceptance` 生产从未注入真实实现**
  （测试都填 `()=>true` / `body.summary==='ok'`）——真实 PROJECT 任务当前恒 acceptance_failed→escalate（潜在断裂）。
- **result body 不含产物**：`ExecutorMachine.onDriverCompleted(resultBody)`（executor/machine.ts:342-365）透传驱动
  body 为 `task.result`；`FencedProcessDriver` 产出仅 `{summary, exit_code, stderr_tail?}`（fenced-driver.ts:135-139），
  **从不填 `artifacts[]`/`files[]`**（协议 01:111 定义但运行时空置）。`ExecRecord.offerBody`（executor/machine.ts:27）
  存了 offer body（含 contract）——执行侧有契约可取。
- **契约不可达牵头机器**：`LeadRecord`（machine.ts:44-57）不存 `contract`；`dispatchTo(target, offerBody, now)`
  （machine.ts:132-148）发 offer 但**不持久化 contract**；`validateAcceptance(resultBody)` 拿不到 deliverables。
- **签名/公钥原语齐备**：`core` 导出 `signBytes/verifyBytes`（sig.ts:56-63，裸 ed25519，"takeover bundle 等非信封
  载荷复用同一信任根"）、`jcs`（index.ts:5）、`publicKeyFromPrivate`；`createDurableNode` 域内持有 `opts.privKey`
  （node.ts:54/157-163/206）；公钥按 `GET /v1/nodes/{id}/pubkey?epoch={n}` 查（registry-verifier.ts:96-103，同队认证/拒 inactive）。
- **drain 是异步预置点**：`drain()`（node.ts:307-331）逐条 `await verifySafely(env)`（已取执行方公钥）后
  `ledByUs ? lead.consume(env,true) : executor.consume`——`lead.consume` 前是**天然异步产物验证注入点**。

## 3. 缺口与范围

| 能力 | 现状 | E2 范围 |
| --- | --- | --- |
| 入站 payload sha256 校验 | ✅ 完整（fetchPayloadGit） | 不重做 |
| 验收闸机制（fail-closed/归途） | ✅ 完整（machine + 5 组测试） | 不重做，仅**注入真实验收器** |
| 信封级 ed25519 签名（D23） | ✅ 完整 | 不重做（产物清单**另**单独签名，§1.2） |
| **产物清单 + 单独签名** | ❌ 无 | **做**：manifest 模型 + JCS + signBytes + 入 git 分支 |
| **执行侧产清单** | ❌ 驱动不产 artifacts | **做**：驱动完成后算逐 deliverable sha256 + 签名 + pushArtifacts + 填 result.artifacts |
| **牵头侧真实验收** | ❌ 仅测试 stub | **做**：drain 预置（collect+验签+重新哈希+契约核对）→ 同步判定 → validateAcceptance |
| **契约线入验收器** | ❌ LeadRecord 不存 contract | **做**：dispatchTo 持久化 contract + per-task 闭包注入 |
| **PROJECT 缺省断裂修正** | ❌ 恒 acceptance_failed | **做**：接线真实验收器后 PROJECT 可经复核 done |
| machine_checkable 验收项执行器 | ❌ 无 | **不做**（YAGNI，§8） |
| owner 复核签字 / 独立验收角色 | ❌ 无 | **不做**（YAGNI，§8） |

## 4. 核心设计

### 4.1 产物清单模型与签名（node/src/collab/artifact-manifest.ts，纯原语）

```ts
interface ArtifactEntry { path: string; sha256: string; size: number }   // 逐 deliverable 内容寻址
interface ArtifactManifest {
  task_id: string; attempt: number;
  node_id: string; key_epoch: number;          // 签名钥标识(须 == task.result 信封 from)
  deliverables: ArtifactEntry[];               // 按 path 升序(JCS 稳定)
}
interface SignedManifest { alg: 'ed25519'; manifest: ArtifactManifest; sig: string }  // sig = base64(signBytes(JCS(manifest)))
```

- `buildManifest(taskId, attempt, nodeId, keyEpoch, files: {path, bytes}[]): ArtifactManifest`
  —— 逐文件 `createHash('sha256')` + size，deliverables 按 path 升序（JCS 规范化前稳定排序）。
- `signManifest(manifest, privKey): SignedManifest` —— `signBytes(te.encode(jcs(manifest)), privKey)`（core，同步）。
- `verifyManifest(signed, pub): boolean` —— `verifyBytes(fromBase64(sig), te.encode(jcs(manifest)), pub)`（core，同步）。
  JCS 保证跨序列化字节一致（D23 同一规范化）。
- 纯函数、无 I/O（除 buildManifest 接收已读字节）→ e2a 单测直接覆盖（含篡改/错钥/哈希不符）。

### 4.2 执行侧：产清单 + 签名 + 入 git 分支（payload-git.ts 扩展 + ArtifactPublisher 端口 + executor 接线）

> **e2d-2 落地形态**（与本节初版设计的差异已按实现校正）：发布接缝抽为 `ArtifactPublisher` 端口，git I/O 全异步、
> 走**每-attempt 分支**，PROJECT 准入以节点级 `artifactRepo` 门控。

- **`pushSignedArtifacts`（同步，e2b）**：接收 `SignedManifest`，把 `qlong-manifest.json`（= `SignedManifest` 的 JSON）连同
  deliverable 一并 commit/push 进**单分支** `qlong/<task>` —— 保留供既有测试与向后兼容。
- **`publishSignedArtifacts`（异步，e2d-2c）**：`(worktree, repo, signed, taskId, attempt, opts?)`，全程 `execFile` promisify +
  `AbortSignal.timeout`（默认 120s，不阻塞事件循环——租约续租/取消轮询在发布期间继续），推到**每-attempt 分支**
  `qlong/<task>/a<attempt>`（多 attempt 互不覆写、可审计），**绝不 force**（远端同分支历史分叉 → 非快进被拒并抛错），
  字节预算（清单声明 deliverable 总字节超 `maxBytes`，默认 256MB → 先于任何 git I/O fail-fast）。失败一律抛错。
- **`collectArtifacts`**：导出树时一并读回 `qlong-manifest.json`，返回 `{ ok, files, manifest?: SignedManifest, reason? }`
  （**仍用单分支 `qlong/<task>`**；e2d-3 须扩展按 `artifacts[0].branch` 收取每-attempt 分支）。
- **`ArtifactPublisher` 端口 + `publishAndFinish`（executor）**：执行器完成路径在 **SQL 事务外**调用
  `publish(fence, offer, ctx, outcome) → Promise<RunOutcome>`（返回注入 `body.artifacts` 的新 outcome）。门控
  `outcome.kind==='result' && publisher && 同 fence && !slot.stopReason`（取消/超时优先，绝不发布）；publish 抛错或返回非法
  outcome → `failed('artifact_publish_failed')`。`ctx` 由 `start()` 事务外 `prepare` 解析并经 `LiveRun.ctx` 线程化到完成路径；
  `finish()` 的 CAS 仍复核 fence/cancel/lease（陈旧完成不改变新任务）。执行器保持通用（可用 Fake 测试）。
- **`GitArtifactPublisher`（collab/artifact-publisher.ts，e2d-2d）**：`ArtifactPublisher` 的 git 适配器，构造携
  `{ repo, privKey, nodeId, keyEpoch, gitBin?/timeoutMs?/maxBytes? }`。`publish`：
  1. `offer.kind!=='project'` → 原样返回 outcome（aid 绝不触碰 git）；`ctx.cwd` 缺失 → 抛错（拒绝发布，不伪造成功）。
  2. 从 `offer.contract.deliverables[].path` 取声明路径，**严格限定工作区内**（`../`/绝对路径越界拒读，防契约诱导读工作区外文件）；
     逐条读字节，**缺件不入清单**（由牵头方核契约完整性时判缺，绝不伪造）。
  3. `buildManifest(task_id, attempt, nodeId, keyEpoch, files)` → `signManifest(_, privKey)`（nodeId/keyEpoch 与信封 from 同源）。
  4. 工作区未 init 为 git 仓时异步 `git init`（`FencedWorkspace` 只保证目录存在），再 `publishSignedArtifacts(...)`。
  5. 返回 `{ kind: outcome.kind, body: { ...outcome.body, artifacts: [{ repo, manifest: signed, branch }] } }`。
- **PROJECT 准入门控（executor + node）**：`supportedKind` 要求 project 携 `contract.deliverables` 数组；`offer()` 运行时门控
  `body.kind==='project'` 仅当 `publisher` 存在时准入，否则 `policy_denied` fail-closed（aid 恒可）。`createDurableNode` 据节点级
  `artifactRepo` 配置装配 `GitArtifactPublisher`（携 `opts.privKey` + `me.node_id/key_epoch`）并透传执行器；未配置 → 无 publisher → PROJECT 被拒。

### 4.3 牵头侧：真实验收器（drain 异步预置 + 机器同步读判定）

**预置（异步，node.ts drain，`lead.consume` 前）** —— `stageArtifactVerification(envelope)`（单参：从信封自足取 task_id/attempt/from/body，事务外重读持久 task 复核上下文）：
1. 仅对 `envelope.type==='task.result'` 且本节点牵头且 `task.kind==='project'` 触发；aid 跳过（走 v1 兼容）。
2. 从 `envelope.body.artifacts[0]` 取内联 `SignedManifest`（`inlineSignedManifest`）+ repo（`inlineRepo`）+ branch（`inlineBranch`）；`collectArtifacts(repo, taskId, branch)` 收取产物字节（branch 缺省回落单分支 `qlong/<task>`）。
3. 校验 `manifest.node_id===envelope.from.node_id && manifest.key_epoch===envelope.from.key_epoch`（清单钥 == 信封署名者，否则拒）。
4. `resolvePubkey(node_id, key_epoch)`（异步 HTTP，复用 registry-verifier 端点；drain 已 `verifySafely` 取过 → 可缓存）
   → `verifyManifest(signed, pub)`；false → 判定 false（篡改/伪造清单）。
5. **重新哈希**收取到的每个 deliverable 文件字节，比对 manifest 的 `sha256+size`；任一不符 → false（传输损坏/掉包）。
6. **契约完整性**：`task.contract.deliverables` 每条声明产物都在 manifest 且收取成功；缺 → false（契约不符）。
7. 判定存**每任务至多一份**的同步缓存条目 `verdicts[task_id] = { context, delivery, verdict? }`：`context = sha256(jcs(task_id/attempt/target/kind/state/task_seq/drainClosed/contract))`（持久验收上下文），`delivery = envelopeDigest(信封)`（含内外层签名/repo/msg_id），`verdict` 为布尔判定；无 `verdict` 的条目是异步**在途令牌**。异步 I/O 完成后**重读持久状态并复核 context**，令牌被撤销或上下文变化则丢弃，旧快照绝不回写。

**机器内（同步）** —— `DurableLead.machine(task, envelope?)` 注入 per-task 验收器（闭包捕获 task + 本次 consume 的信封，机器签名不变）：
```
validateAcceptance: (body) => {
  if (task.kind !== 'project') {                                        // aid 兼容(machine.ts:94-96 语义，不查缓存)
    const arr = body.acceptance_results;
    return !Array.isArray(arr) || arr.every((x) => x?.pass !== false);
  }
  if (!envelope) return false;                                          // 派发/定时器路径无信封 → 不放行
  const c = this.verdicts.get(task.task_id);
  return c?.context === acceptanceContext(task)                         // 持久验收上下文一致
    && c.delivery === envelopeDigest(envelope)                          // 完整信封一致（防换签名/纪元/repo 借用）
    && c.verdict === true;                                              // 无预置判定 → fail-closed false
}
```
—— 纯同步读缓存，重 I/O 全在 drain 预置完成（§1.3）。缓存按 `acceptanceContext` 回收：任一 context 字段（含 contract/state/drainClosed）变化、取消/改派/接管/终态提交、或 task.result 被消费即清理；仅更新 leaseDeadline/renewalSeq 的 progress 心跳**不**使既有判定失效。

### 4.4 契约线入（machine.ts / lead.ts）

- `LeadRecord` 增可选 `contract?: { deliverables: Array<{path?: string; artifact?: string; desc?: string}>; acceptance?: unknown[] }`。
- **共用结构准入 `isLeadContract`**（machine.ts）：`undefined`/`{}`/`deliverables:[]` 视为零交付兼容；`deliverables` 若在须为数组，
  每项须为对象且至少有非空 `path` 或 `artifact`，`path`/`artifact` 若给须非空字符串、`desc` 若给须字符串，`acceptance` 若给须数组。
- `dispatchTo`/`redispatchTo`：在**任何状态修改前**先 `if (!isLeadContract(offerBody.contract)) return []`——非法契约 → 空动作，
  durable dispatch 返回 false，不发 offer、不污染持久状态、不闭锁节点；非法自动改派目标保留 `drafting`，选择器纠正后下一次 tick 可推进。
  合法时 `this.rec.contract = structuredClone(offerBody.contract)`（仅 project 有意义）持久化入 lead 状态。
- `validTask` 与派发共用 `isLeadContract`（旧状态无 contract → undefined，不判损坏）；接管 bundle（exportTasks/importTasks）
  原样携带（contract 随 LeadRecord 序列化，无额外 fence 语义）。
- 该字段仅牵头侧持久（执行侧已有 `ExecRecord.offerBody`，无需新增）。

### 4.5 PROJECT 缺省断裂修正

接线真实验收器后，PROJECT 任务经「执行方产签名清单 → 牵头方 collect+验签+重新哈希+契约核对 → 判定 true」
可正常 `done`（此前恒 acceptance_failed）。**缺省 fail-closed 语义保留**：未注入验收器 / 无预置判定时，
machine.ts:93 的 `project→false` 仍是安全底线（machine-safety.spec.ts:103-112 不回归）。

## 5. 装配（node.ts / lead.ts / payload-git.ts）

- **执行侧（e2d-2，已落地）**：`DurableExecutor` 增 `publisher?: ArtifactPublisher` 端口，完成路径经 `publishAndFinish` 在事务外
  调用（驱动 settle → publish 产清单/签名/push → 注入 result.artifacts → `finishAndRelease` 密封）。`createDurableNode` 域内
  `opts.privKey` + `me.{node_id,key_epoch}` 装配 `GitArtifactPublisher`（以节点级 `artifactRepo` 选项为开关，与 driver/workspace 同解析时机），
  透传执行器；CLI `run` 读 `cfg.artifact_repo`（`qlong join/enroll --artifact-repo` 或 `QLONG_ARTIFACT_REPO` 写入 config）并传 `artifactRepo`。工作区根接线见下条（e2d-1 已落地）。
- **durable 工作区（e2d-1，已落地）**：`DurableExecutor` 增 `workspace?: ExecutorWorkspace` 端口，生命周期归执行器——
  `start()` 在 `'starting'`/`mayHaveStarted` 提交**之前**于事务外 `prepare(fence,offer)` 解析 `ctx.cwd` 传驱动（mkdir 是纯磁盘 I/O，
  崩溃重启可幂等重 prepare，不误升级 recovery_required；prepare 失败即干净 `task.fail(workspace_prepare_failed)` 并 release）；
  所有异步终态路径（settle/stop/recover(stopped)/start late-path）经 `finishAndRelease` 在结果密封**之后**事务外 `release`；
  `unknown`/`recovery_required` 与取消在途未证静默时**绝不** release（保留在途产物）。release 由 fence 派生路径（纯函数），
  故重启后新进程可清理上一进程遗留工作区。`FencedWorkspace`（collab/workspace.ts）实现该端口；`createDurableNode` 以 `workspace`
  选项（值或 `(runtime)=>` 工厂，与 driver 同解析时机）透传；CLI `run` 装配 `new FencedWorkspace()` 并移除静态 `workdir: home`。
- **牵头侧**：`DurableLead` 增 `resolvePubkey?` 端口（缺省用 registry-verifier 同款 HTTP 查询）+ 内部 `verdicts` 同步缓存
  + `stageArtifactVerification` 预置方法；`machine(task)` 注入 per-task 验收器（§4.3）。
- **drain**：node.ts:358 `ledByUs` 分支在 `lead.consume(env,true)` 前 `await lead.stageArtifactVerification(env)`
  （仅 project + task.result；best-effort：预置异常 → 判定缺席 → 机器 fail-closed，绝不放大为节点 fault）。
- **validateAcceptance 注入优先级**：`createDurableNode` 若显式传入 `opts.validateAcceptance` 仍优先（测试/替代信任根）；
  缺省时用 E2 真实验收器（此前缺省 = machine 的 project→false）。

## 6. TDD 分片（每片 RED→GREEN→变异检验 + 独立提交）

| 片 | 内容 | 测试入口 | 变异检验要点 |
| --- | --- | --- | --- |
| **e2a** | 产物清单原语：`buildManifest`（逐 deliverable sha256+size，path 升序）+ `signManifest`/`verifyManifest`（JCS + core signBytes/verifyBytes） | `node/test/artifact-manifest.spec.ts`（新） | 移除验签 → 篡改清单通过（RED）；错公钥 → 应拒未拒（RED）；改一个 deliverable 字节 → sha 不符未检出（RED） |
| **e2b** | git 集成：`pushSignedArtifacts`（含 qlong-manifest.json）+ `collectArtifacts` 读回 manifest | `node/test/payload-git.spec.ts` 扩展 | collect 不读回 manifest → 无法验签（RED）；篡改分支内产物文件 → 重新哈希不符未检出（RED） |
| **e2c** | 牵头验收器 + 契约线入：LeadRecord.contract（dispatchTo 持久化）+ per-task 闭包注入 + 同步判定缓存 + 契约完整性核对 | `node/test/durable-lead.spec.ts`、`machine-safety.spec.ts` 扩展 | 验收器忽略判定缓存 → 无清单也 done（RED）；契约缺 deliverable 未判不完整（RED）；aid 回归 v1 兼容被破坏（RED） |
| **e2d** | 执行侧产清单 + drain 异步预置 + 工作区接线 + e2e（执行产→牵头 collect→验签→done；篡改→acceptance_failed→改派）+ 全量验证 + 文档回填 + 独立提交 | `node/test/durable-node.spec.ts` 扩展、`cli/test/server-*.spec.ts`、全仓 7 包 test + typecheck | drain 移除预置 → PROJECT 恒 acceptance_failed 或未验即 done（RED）；执行侧不产清单 → 牵头无 manifest 可验（RED） |

**验证基线**：
- 历史（E3，HEAD `9321967`）：全仓 1543 passed | 3 skipped；7 包 typecheck 绿。
- P0（复核修复后，HEAD `6bbda76`）：全仓 1621 passed | 2 skipped（cli130/console36/core205/
  gateway170/node801/registry243/storage36|2skip）；7 包 typecheck 绿；node 定向 100 测 + 七靶点变异全捕获并字节还原。
- e2d-3（HEAD `959f3fc`）：全仓 1682 passed | 2 skipped（cli130/console36/core205/gateway170/node862/registry243/storage36|2skip）；
  7 包 typecheck 绿；3c 七靶点 + 3d 三靶点 + 3e 三靶点变异全捕获并字节还原。
- 当前（e2d-4，HEAD `959f3fc` + 未提交 e2d-4）：全仓 **1684 passed | 2 skipped**（cli130/console36/core205/gateway170/
  node**864**/registry243/storage36|2skip）；7 包 typecheck 绿；durable-node e2d-4 描述块 2 测（真实 git bare 仓 + registry HTTP 桩、
  默认装配正/反向）+ M1/M2 变异全捕获并字节还原（node.ts sha256 `35586B82…D0D0B`）。node 全量独立运行 **42 文件 864 passed、0 skip、exit 0**；
  各包独立运行 exit 0；`pnpm -r` 串行因 tinypool `ERR_IPC_CHANNEL_CLOSED` 环境级 worker 拆卸竞态崩溃（落在未改动的 gateway），逐包独立运行规避。
- 命令：`pnpm -r --if-present run typecheck`；`pnpm -r --workspace-concurrency=1 --if-present run test --exclude '**/dsh-e2e.spec.ts' --retry 0 --maxWorkers=2`。

## 7. 风险与开放

- **工作区接线（最大风险）**：durable 执行路径当前无 per-task 工作区（FencedProcessDriver 静态 workdir），
  产物字节无处定位。e2d 须接 `WorkspaceManager`（或等价）到 durable executor，且 `offer.workspace` 缺省时
  D33 一次性临时目录的产物如何回传需明确（临时目录内产文件 → push → destroy 前完成）。
- **同步/异步边界**：机器纯同步（§1.3）；预置在 drain 异步完成。判定缓存**每任务一份**，命中须同时满足
  `acceptanceContext`（含 contract/state/attempt/target/task_seq/drainClosed）与 `envelopeDigest`（完整信封）——仅 manifest
  摘要相同不足以复用（防换签名/纪元/repo/契约借用成功判定）。缓存缺失/预置失败 → fail-closed（不误判 done）。
- **公钥现势性**：manifest 声明 `key_epoch` 须与信封 from 一致；historical 纪元公钥可验签（registry-verifier.ts:100
  允许 current|historical），但改钥窗口内旧 attempt 产物的验签语义须与信封验签一致（复用同一端点即自然一致）。
- **git 可用性 / 大产物**：collectArtifacts 依赖 git 子进程（payload-git.ts:218）；大产物 fetch 耗时在 drain 异步
  预置内，不阻塞机器事务，但可能拖慢 pump 批处理——保留 `maxBytes` 上限（payload-git.ts:65）+ 判定缓存去重。
- **判定缓存生命周期**：按 `acceptanceContext` 回收（context 任一字段变化即失效），并在取消/改派/接管/终态提交与 task.result
  消费后清理；`failClosed` 时整表清空。接管/重启后缓存为空 → result 重投由 drain 重新预置。**幂等仅限**同信封、同上下文的
  已完成判定；I/O（collect/公钥）暂不可用时**不写判定**，可在 consume 前重新预置；一旦 result 已 consume，R1 去重决议
  **不因依赖恢复自动重试**（同 attempt 的同 msg_id 或新 msg_id 重投仍受去重/冲突规则约束）——「不缓存失败」不等于「具备收件重试保证」。
- **多中心 / 跨队**：本设计假定单中心 + 同队验收（同 D1/E3）；跨队 grant（D2）产物的验收公钥解析沿用 registry-verifier 同队约束。

## 8. 不做（YAGNI 边界）

- **machine_checkable 验收项执行器**（跑 `contract.acceptance[].machine_checkable` 命令/断言）——用户选定范围为
  完整性验收核心；语义级机器可检验收列为后续（须先定 check DSL 与沙箱，且与已跳过的 E1 隔离强相关）。
- **owner 复核签字 / 带外确认**（复用 E3 owner 命令通道做最终验收）——范围为牵头节点本地验收；owner 终验列为后续。
- **独立验收角色 / 第三方复核节点**——与「解耦 E1、受信自托管节点」收敛意图相悖；牵头方本地验收即满足「验收方 ≠ 执行方」。
- **Merkle 树 / 跨 attempt 哈希链**——逐 deliverable sha256 + 单签名已满足完整性；链式结构在受信模型下无增量价值。
- **产物加密 / 机密性**——E2 只管完整性与契约符合，不涉及产物保密（另有传输 TLS + 信封签名）。
- **中心侧产物存储 / 投影产物字节**——中心投影只读（同 E3 §1.4），产物走 git 共享仓库点对点，中心不搬产物字节。
