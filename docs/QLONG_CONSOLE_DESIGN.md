# 群龙(Qlong)控制台 Web UI 详细设计

> 状态:**设计稿,供评审**。
> 对应:02 篇 §8.7(评审 I-21/I-22)、02 §9 API 面、纪要 §8.7。
> 范围:本文只设计 **owner 控制台 Web UI**;节点本地 CLI 不在本文范围。
> 技术栈:React + TypeScript + Vite(与 monorepo 一致);不引入重型框架。

## 1. 设计原则

1. **最小面**(评审 I-21):控制台只做「人必须手动做的事」,其余由 CLI/API 兜底。
2. **P12 失败关闭**:所有 owner 操作需二次确认(不可逆:revoke、token 撤销);未登录 → 重定向。
3. **实时性**:在线状态用 ws 推送(复用 gateway 连接),其余轮询(30s)。
4. **P3 投射**:控制台永不读取信封 body;只展示注册中心与审计头摘要。
5. **权限模型**:控制台前端不含任何密钥;全部操作经产品侧用户会话代理。

## 2. 页面路由

```
/login                      <- 产品侧登录(重定向目标)
/                           <- 团队概览
/nodes                      <- 节点列表(默认页)
/nodes/:nodeId              <- 节点详情
/tokens                     <- enrollment token 管理
/grants                     <- 跨队授权管理
/audit                      <- 审计事件查看器
/settings                   <- 团队设置
```

## 3. 页面设计

### 3.1 团队概览(/)

数据源: GET /v1/teams/{id}/overview(已实现)

| 区域 | 内容 | 交互 |
|------|------|------|
| 统计卡 | 总节点/在线/审计事件/活跃任务 | 点击跳转 |
| 节点状态表 | node_id短/别名/在线/平台/版本/状态/最近活跃 | 行点击→详情 |
| 最近审计 | 最近10条(event/时间/原因) | 查看全部 |
| 团队信息 | team_id/名称/owner/创建时间 | 只读 |

### 3.2 节点列表(/nodes)

数据源: GET /v1/teams/{id}/nodes

| 列 | 说明 |
|----|------|
| 状态 | 在线绿/离线灰/suspended红 |
| 别名 | 可编辑(PATCH) |
| 平台/版本 | 漂移可见(I-52) |
| key_epoch | 密钥纪元 |
| 最近活跃 | 相对时间 |
| 操作 | suspend/resume/revoke(下拉+二次确认) |

筛选:状态/平台/搜索;操作确认弹窗(suspend/revoke 不可逆二次确认)。

### 3.3 节点详情(/nodes/:nodeId)

基本信息 + 密钥信息(pubkey指纹/epoch/历史) + 能力标签chip + 负载快照(ttl倒计时) + 审计时间线 + 操作。

### 3.4 Token 管理(/tokens)

签发表单(TTL选择) + 活跃token(倒计时/复制/二维码/作废) + 已消费列表。
明文只显示一次;过期倒计时<5min变红;作废需二次确认。

### 3.5 跨队授权(/grants)

现有授权列表(from/to/caps_visible/expires/状态) + 创建表单(to_team下拉/caps_visible多选/TTL) + 撤销(二次确认)。

### 3.6 审计查看器(/audit)

时间/事件(颜色标记)/节点/原因/头摘要(展开详情)/关联(trace_id/task_id)。
筛选:事件类型/时间范围/节点;分页:cursor-based(v1全量上限1000)。

### 3.7 团队设置(/settings)

基本信息(name编辑) + owner(只读) + danger zone(v0.3占位)。

## 4. 状态管理(zustand)

auth(loggedIn/user) / team(id/name/state) / nodes(NodeRecord[]) / tokens / grants / audits / ws

## 5. 安全模型

1. 认证:产品侧登录 → 会话cookie;无 API key/PAT。
2. CSRF:SameSite=Strict + X-Requested-With 头。
3. XSS:React 默认转义;用户可控字段禁 dangerouslySetInnerHTML。
4. 密钥零暴露:前端不含私钥/node token/enrollment token。
5. 操作审计:写操作带 X-Qlong-Console-Action 头,后端记入审计。

## 6. 错误处理

401→重定向登录;403→Toast权限不足;409→展示服务端消息;429→倒计时;5xx→重试按钮;断网→全局banner。

## 7. v0.2 vs v0.3+

v0.2 交付:节点列表/详情、token管理、suspend/resume/revoke、grant CRUD、审计基础、团队概览。
v0.3+: 性能图表、批量操作、告警规则、多team切换、移动端适配、token二维码。

## 8. 文件结构(packages/console/)

src/main.tsx → App.tsx(路由+状态) → api/(fetch封装) → store/(zustand) → pages/(8页面) → components/(通用组件)

## 9. 实现排期

Phase 1: 路由 + 认证 + 团队概览 + 节点列表(核心)
Phase 2: token管理 + grant管理 + 审计查看器
Phase 3: 节点详情 + 设置 + polish
