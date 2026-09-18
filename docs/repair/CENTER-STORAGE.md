# 中心 SQLite 接线与当前验收边界

本说明对应系统性修复的阶段 2–3 及阶段 4 的单 authority 投递，**不是整套可靠任务系统的完成声明**。

## 已接通

- Node.js >=24，使用内置 `node:sqlite`，不新增外部依赖。
- `startQlongServer` 先取得独立 `ownership.sqlite` 生命周期锁，再打开 `center.sqlite`、迁移并验证 Registry/Auth，最后开放 HTTP/WS。
- 一个业务库保存团队、节点/公钥纪元/token 哈希、邀请码消费、grant、目录 epoch、审计、任务投影及 Auth 初始化状态/账号哈希/会话元数据。
- Registry 使用独立草稿执行原有同步业务操作，SQLite 短事务提交行差异，成功后替换缓存并通知网关。外部读取是分离副本，不能改 Map 绕过提交；同一 store 上落后的 Registry facade 拒绝读写。
- Auth 不保存原始 session cookie，只保存其哈希及必要会话元数据；会话重启可用，登出持久撤销。标记缺失、非法角色、数据关联损坏或存储失败时不重新开放 bootstrap。
- `PATCH /v1/nodes/me` 不再修改临时返回对象；caps 的认证 touch 与能力写入同事务。
- WebSocket presence 保留当前连接守卫：旧连接 close 不使新连接离线；管理断连与关闭清除在线态；从磁盘恢复的节点不标为 online。
- 本机网关已接上实时 `grantLookup`，保留原有双向 grant 判断，不暗改为单向授权。
- 监听失败会清理先启动的网关；关闭先停止接入、排空 HTTP/WS，再关业务库和释放所有权锁。WS 关闭有有界强制收尾。
- 存储 fault 后已有 WS 也不能继续靠缓存目录接收上行；下次帧触发关闭且不返回成功 ACK。
- `CENTER_SCHEMA` 追加 v2 custody 迁移，不改 v1 校验和。在线/离线同走持久 mailbox；票据绑定当前认证连接，receipt 提交后删 payload 并留 received 记录。严格 exp 过期留下 expired 记录。
- 持久中心拒绝旧握手（4004），`--ephemeral` 仍是仅回环地址的旧演示协议。v2 节点不能回落旧确认语义。见 [协议与节点事务边界](PROTOCOL-V2.md)。

## 显式启动配置（不自动执行）

仅在**新的专用数据目录**验证本批实现。现有部署不能以新建空库代替迁移。

| CLI 参数 | 环境变量 | 含义 |
|---|---|---|
| `--data-dir` | `QLONG_DATA_DIR` | 专用绝对路径，存放中心库与锁 |
| `--data-base` | `QLONG_DATA_BASE` | 已存在的准入父目录；默认 data-dir 的父目录 |
| `--storage-mode create` / `open` | `QLONG_STORAGE_MODE` | 必须明确选择；create 拒绝现有库，open 拒绝缺失库 |
| `--confirm-local-filesystem` | `QLONG_LOCAL_FS_CONFIRMED=1` | 运维已检查本机文件系统，排除 NFS/SMB/云同步/跨 VM 共享目录 |
| `--confirm-windows-acl` | `QLONG_WINDOWS_ACL_CONFIRMED=1` | Windows 运维已限制目录及父目录 ACL；不是 Node 自动证明 ACL 安全 |
| `--ephemeral` | 无 | 显式本地测试/演示，只绑定回环地址，不能同时配置 SQLite |

首次创建后，下次启动必须改为 `open`；数据库丢失、损坏、较新 schema 或迁移校验失败时，保留文件并进入恢复流程，不能改回 `create`“修复”。

容器部署：镜像内置入口 `docker/entrypoint.sh` 落位显式准入——`QLONG_DATA_DIR`（默认 `/data/qlong`，平台持久卷请对齐挂载）上 `QLONG_STORAGE_MODE` 缺省 `auto`（目录无 `center.sqlite` → create，已有 → open；可显式覆盖为 create/open）；`QLONG_LOCAL_FS_CONFIRMED` 缺省 1（容器 overlay/本地卷即本地盘；挂载 NFS/SMB/云同步盘必须置 0，服务将拒绝启动直至另行显式确认）。策略边界：卷被整体清空视为新部署（auto 重新 create）；主库缺失但 sidecar 尚存属损坏场景，由存储层拒绝，绝不静默重建。未挂持久卷时数据随容器生命周期，auto 每次全量重建都会得到全新中心——需要跨重建留存就必须挂卷。

生产持久模式拒绝同时配置 `QLONG_AUTH_DIR`、`QLONG_MAILBOX_FILE` 或旧 cluster 设置；旧文件仅供后续显式迁移。没有自动读取、覆盖、删除或重置已有账号、节点凭证及发行物。

## 任务投影 API（不是任务提交接口）

- `POST /v1/teams/:id/tasks`：必须为该团队当前 active lead 的 bearer，不能用 owner Cookie 伪装节点上报。
- 输入字段：`task_id`、`team_id`、`lead`、`type`、`exec`、`attempt`、`status`、`task_seq`。`kind` 可作为 `type` 的唯一别名，二者不可同时出现；只允许 aid/project。
- `exec` 可为 null 或省略；存在时须对应已登记节点。`attempt` 必须为正安全整数；`task_seq` 为不跨 attempt 重置的非负安全整数。
- 已有 task 的 team/lead/type 不可变；更小 revision 或回退 attempt 返回 409；同 revision、同规范化 JCS 哈希幂等，不改任务更新时间；同 revision 不同正文返回 409。
- `GET /v1/teams/:id/tasks/:taskId`：与列表相同的团队读取授权。
- 中心只保存 lead 声明的投影，不代替节点调度，不证明执行完成或 project 验收可信。
- 当前节点仅在终态 best-effort 上报，使用真实 kind、固定终态 revision 0，并提供 `onTaskReportError`；未派发的 attempt 0 不伪造为 1。中间状态、重启后的 revision、持久重试与 shutdown flush 待节点 runtime 事务实现。

## 验证范围

- `registry/test/durable.spec.ts`：恢复、提交失败、缓存/通知不领先提交、分离读取、关联与损坏验证、GC 墓碑。
- `registry/test/auth-sqlite.spec.ts`：初始化/登录/登出持久性，哈希索引，非法状态及写入失败关闭。
- `registry/test/task-projection.spec.ts`：真实 HTTP、授权竞态、修订冲突与恢复。
- `cli/test/server-durable.spec.ts`：复用正式启动工厂，真实 HTTP/WS，关闭再打开同一库，端口冲突/重叠启动/损坏/SQL 提交失败。
- `cli/test/server-custody.spec.ts`：正式中心 + GatewayClient/NodeRuntimeStore + Registry 真实验签，中心/节点重开、接管/收件 COMMIT 故障、重复/冲突与 v1 schema 追加迁移；不启动模型或执行任务。
- `gateway/test/presence-lifecycle.spec.ts`：实际回环 WS、旧 close 竞态、钩子故障、监听失败与有界关闭。
- `node/test/terminal-projection.spec.ts`：真实 Registry HTTP 与 SQLite 重开、终态回调替换 lead、HTTP/网络错误可见；使用 inert driver，不执行模型。
- storage 包另有 COMMIT 前后子进程强杀与 WAL 恢复测试；不能把本批工厂重开测试说成完整双机/掉电测试。

建议每次修改提交边界后，更新相应故障测试并运行，再执行根目录类型检查与排除真实模型 E2E 的全仓测试。

## 仍未完成 / 不允许的推论

- 连接登记 generation/TTL(D1 claim 注册表)与跨队节点能力范围执行(D2 grant caps)已实现:多 authority 共享同一中心库,经 `/internal/pump` 中继做定向泵通知(不搬 payload);legacy `QLONG_CLUSTER_*` 仅限 ephemeral 演示,持久模式拒绝。仍待实现:多中心 claim 一致性(§12.5)、Redis 传输替换。
- 单 authority v2 `stored/receipt` 及节点事务存储已接通；节点侧任务 pump 已由 `createDurableNode` + `FencedProcessDriver` 接通（单 executor aid 闭环，见 [协议与节点事务边界](PROTOCOL-V2.md)）；业务续租（多网关接续）、多 lead、产物验收与容器级恢复仍未完成。当前 v2 inbox 保留 pending，不能接旧会话直接执行。
- Docker/Podman 强隔离、模型 broker、RunHandle、产物采集/可信验收、IPC/owner command 与显式旧数据迁移仍在后续阶段。
- 当前验证覆盖中心目录/Auth/投影及单 authority 消息接管恢复，**不是任务与外部副作用均可恢复**；不要向不受信节点开放远端执行。tombstone 暂无 GC，计入容量上限，满时拒收而非淘汰。
- Registry 草稿克隆/校验扫描状态，Auth 查询校验全部认证记录。这是优先兑现单实例一致性的实现，不是容量基准；后续须测同步 SQLite 延迟、限制会话/任务数据规模，不能据单元测试声称大规模可用。
- 备份必须使用 SQLite backup API 或经验证的停机一致备份；禁止在线只复制主库、删除 WAL/SHM 或替换 ownership 文件。

