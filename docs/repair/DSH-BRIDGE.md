# qlong ↔ dsh 桥接插件设计(F2,参照 dsh-TUI 的 cordis patch 机制)

> 状态:**设计定稿 + 实现骨架待排**。目标:让 dsh 运行时的 agent loop 事件流
> (thinking/tool/answer)经 qlong 桥接插件转发到 qlong 中心——
> 同时解决两个已知问题:① ms.show 托管形态 Bearer HTTP 通道受限(6c820ec 发现);
> ② qlong 多机协同的节点侧事件可见性。

## 1. 为什么走 cordis patch 插件(参考 dsh-TUI,2026-09-19 研究)

dsh-TUI(3113★,官方收录)证明的机制:
- dsh profile 是 **cordis 插件树**;npm 包携带 `dsh.bundle.patch` 清单
  (`cordis.patch.yml`),`dsh plugin --profile X add <包>` 后 patch 按 id
  覆盖/注入插件行的 config——零核心改动、卸载无残留;
- **进程内挂载天然拥有 agent loop 事件流**(adapter/channel/kernel 分层直接
  消费 llm/agent 层),这是 headless `--json`(阶段批量、无逐 token)拿不到的。

→ qlong 桥接插件 = 同一机制:注入一个"qlong-forwarder"服务行,
  把 agent loop 事件转发到 qlong 中心的自有通道。

## 2. 桥接插件结构(qlong-dsh-bridge)

```
@qlong/dsh-bridge/
├── package.json          # dsh 字段: { "bundle": { "patch": "./cordis.patch.yml" } }
├── cordis.patch.yml      # 注入 qlong-forwarder 服务行(base 层之上)
├── lib/
│   ├── index.js          # cordis 插件入口:读取 QLONG_BRIDGE_URL,启动转发泵
│   └── forwarder.js      # 批量/限速转发 agent loop 事件 → qlong 中心
```

- **注入点**:`cordis.patch.yml` 在 base 层之上追加 `qlong-forwarder` 服务,
  消费 dsh-agent-loop 的事件流(与 dsh-TUI 的 adapter/channel 同一来源);
- **转发通道**:QLONG_BRIDGE_URL 指向 qlong 中心(自建或局域网),批量+限速
  (同 qlong reporter 语义:传输失败留 pending 重试,绝不伪造成功);
- **Bearer 问题绕开**:桥接走 qlong 自己的通道(节点令牌或预共享密钥),
  不经 ModelScope 平台网关。

## 3. 中心侧(qlong server)配套

- 新路由 `POST /v1/nodes/me/loop-events`(Bearer node token,同 deliveries API 鉴权):
  接收 agent loop 事件快照,入库审计/控制台展示;
- 事件模型:thinking/text/tool_call/tool_result/session_id/task_id 可映射到
  任务投影与审计(复用 §11 audit 头摘要原则,不存 body 全文)。

## 4. 不做(边界)

- 不桥接模型凭证(密钥始终留在 dsh 运行时侧);
- 不做双向控制(取消/改派仍走 E3 owner 命令通道,单一权威);
- 不承诺逐 token 实时(批量+限速,带宽优先给任务协议本体)。

## 5. 里程碑

| 切片 | 内容 | 依赖 |
|---|---|---|
| F2a | 插件骨架 + cordis.patch.yml + 事件采样(dsh-test profile 验证注入) | 无 |
| F2b | forwarder 转发泵(批量/限速/重试)+ 中心路由入库 | 中心可达 |
| F2c | 控制台展示 agent loop 活动流 | F2b |
