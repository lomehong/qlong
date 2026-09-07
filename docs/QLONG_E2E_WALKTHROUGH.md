# 群龙双机走查剧本(含真实 dsh 联调记录)

> 状态:**剧本定稿 v1;第一幕(npx 通道真实联调)已执行通过,第二幕(双机实物)待执行**。
> 目的:把"拆解 → 派单 → 取码 → 执行 → 产物回传 → 校验整合"在真实设备上跑通一遍,
> 验证 `QLONG_STATE_MATRIX.md` 的全部预期转移与 §8.4 的文件协同链路。

## 〇、环境准备(两台设备,下称 A=牵头方, B=执行方)

| 步骤 | 设备 | 命令/动作 | 预期 |
|------|------|-----------|------|
| 0.1 | 任一 | `node scripts/package.mjs` | dist-release/<版本>/ + latest/ 生成,SHA256SUMS 就绪 |
| 0.2 | A | `qlong server --dist-dir dist-release/latest --registry-port 3200 --gateway-port 3100` | registry :3200 + 网关 :3100 + 书坊分发就绪 |
| 0.3 | 控制台 | 团队页 → 生成邀请码(或 Install 页) | 一次性 token(30 分钟 TTL) |
| 0.4 | A、B | 执行 /install 页对应平台命令(token 走 stdin) | 下载→校验→enroll→自启;`qlong status` 显示已入网 |
| 0.5 | 控制台 | Agent 管理页 | A、B 均可见且 online=true(I-22 验收清单 ✓) |

> 已执行的**第一幕记录**(2026-09-08,本机冒烟):`npx @deepseek-ai/dsh@0.1.2-rc.1 --profile headless "reply with the single word: pong"` → 输出 `pong`,exit 0(31s);
> 同任务经 `DeepSeekHarnessDriver` 默认 npx 通道(零覆盖)→ complete 收到含 pong 的答案。
> 上游版本:latest 0.1.2-rc.1 / alpha 0.1.3-alpha.2(npm registry 核实)。

## 一、剧本 1:互助闭环(aid,任务书四要素)

```json
{ "kind": "aid", "summary": "【目标】在 /tmp/qlong-probe 写入一行 pong 并打印该行\n【边界】仅允许写 /tmp/qlong-probe\n【完成判据】stdout 出现 pong", "lease_ms": 300000, "offer_ttl_ms": 60000 }
```

| 步骤 | 预期消息(方向) | 对应矩阵断言 |
|------|------------------|--------------|
| 1.1 | A→B `task.offer`(attempt=1) | §2.1 五道闸全过 → offered |
| 1.2 | B→A `task.accept` | §1.1 offered→running,起 lease |
| 1.3 | B→A `task.progress` ×N | 续租;心跳间隔 ≈ lease/3 |
| 1.4 | B 侧真实执行 | dsh headless cwd=工作区,stdout=结果 |
| 1.5 | B→A `task.result` | 验收通过 → done ✅ |

## 二、剧本 2:三个异常路径

- **2a 拒单改派**:B 无 `tool:ios-sign` 标签,A 派 `required_caps:["tool:ios-sign"]` 单
  → `reject(unsupported_caps, missing)` → A 能力记忆记录 → 改派有标签节点 → done;
- **2b 执行中失败**:driver 以 `fail(internal_error, retryable=true)` 报错
  → cancel(reclaim)→ drain 窗口(或 cancel.ack 提前收口)→ attempt+1 改派 → done;
- **2c 验收失败**:result 的 `acceptance_results` 不符
  → cancel(acceptance_failed)→ attempt+1 重做(R4/D25)。

每条均对照 `QLONG_STATE_MATRIX.md` §1.1/§2.1 的对应格;失败即矩阵与实现失配,先改表再改码。

## 三、剧本 3:项目协同(§8.4 文件协同全链)

1. A 生成 offer:`workspace:{repo, base_ref}` + `contract.deliverables:[{path:"dist/report.md"}]`
   + `acceptance` + `payload_ref`(若需发数据:GitPayloadStore.store → refs/payload/<sha>);
2. B 接单:WorkspaceManager.clone(worktree)→ fetchPayloadGit 取负载(sha256 校验)→ dsh 执行;
3. B 完成:`pushArtifacts` 提交 `qlong/<task>` 分支 → result.artifacts 携带引用;
4. A 校验 acceptance_results → `collectArtifacts` 收取 → done。

## 四、走查产出(执行后回填本节)

- [ ] 剧本 1 通过(记录消息时间线);
- [ ] 剧本 2a/2b/2c 通过;
- [ ] 剧本 3 通过(记录 git 分支与产物校验);
- [ ] 仅凭双方日志 + trace_id 离线还原一次派单全生命周期(可观测性验收,评审 I-34⑤);
- [ ] 发现的隐藏决策/偏差回填:`(状态×消息×定时器)矩阵` 与本剧本。

## 五、故障注入清单(可选加深)

offer_ttl 过期(执行方长离线后补投 → reject(expired) 批量场景)/
租约停跳(执行方休眠 5 分钟 → lost → reclaim → 改派)/
牵头方断线(执行方 lease_self 暂停 → 恢复续跑)/
中心不可达(outbox 保留,重连补发)/
吊销节点(B 侧 suspend → 网关 4001 断连)。
