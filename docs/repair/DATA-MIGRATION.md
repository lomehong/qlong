# 旧数据显式迁移设计（F1 / P2）

> 状态：**设计定稿，slice1 未实现**。本文固化 P2「旧数据显式迁移」的源/目标映射、信任铁律、
> 四个已核实的陷阱、`qlong migrate <inspect|import|verify>` CLI 与三切片分解 + 测试矩阵。
> 对应计划 P2（line102-116）。P3「全链故障矩阵」另见 `docs/testing/R-MATRIX.md`（slice 后建）。

## 0. 目标与范围

**目标**：提供**可预检、可验证、幂等**的离线导入；**不把既有 SQL schema 升级误称为旧数据迁移**
（schema 升级 v1→v4 由 `storage/migrations.ts` 的 append-only checksum 框架负责，与本工具正交）。

**本阶段只实现工具 + 测试**；处理真实旧数据、切换现有部署**另行授权**（计划 line114）。

**在范围（三类旧文件数据）**：
1. 旧 Auth 文件 `QLONG_AUTH_DIR/users.json`（人类账号 `UserRecord[]`）。
2. 初始化标记 `QLONG_AUTH_DIR/initialized`（`'initialized-v1\n'`）。
3. 旧 mailbox JSON `QLONG_MAILBOX_FILE`（`InboxStore` 落盘，离线 project 单）。

**非范围**：
- 节点侧 `identity.json`（节点自持身份，中心只引用 registry 登记公钥；不迁移、不代生成）。
- registry/center 的 SQL schema 升级（`CENTER_SCHEMA` v1→v4，`migrations.ts` 负责）。
- E1 容器强隔离 / 模型 broker（已跳过）；活孤儿自动接管、多中心、语义级验收 DSL。

## 1. 源 → 目标映射

目标库 = v2 中心 `center.sqlite`（`CENTER_SCHEMA`，当前 v4；`qlong.center`）。

| 旧数据（源，只读） | 实际格式 | 目标（v2 SQLite） |
| --- | --- | --- |
| `users.json` | `UserRecord[]` = `{username(≥3), role('global_owner'\|'user'), salt(32hex), hash(128hex scrypt), created_at(canonical ISO)}` | `auth_users(username PK, role, salt, hash, created_at)` |
| `initialized` | 文本标记 `'initialized-v1\n'` | `auth_meta(id=1, initialized=1, user_count, session_count)` |
| mailbox 文件 | `{v:1, savedAt:number, boxes:[{nodeId, entries:[{msgId, envelope:EnvelopeV1, enqueuedAt:number}]}]}` | `gateway_custody`（**受限**，见 §3 陷阱 3 / §6） |

**校验原语（全部复用，不新造）**：
- `parseUserRecord(value, allowLegacyOwner)`（`registry/auth-store.ts:35`）：字段/正则校验 + **仅旧文件**可推断单管理员缺省 role=`global_owner`。
- `validateEnvelope(raw)`（`core/envelope.ts:95`）、`verifyEnvelopeSig(env, resolve)`（`core/sig.ts:39`）、`envelopeDigest(env)`（`core/transport.ts:18`）。
- `SqliteStore.open/transaction`、`StorageError`（`storage/src`）。

## 2. 信任模型与铁律

1. **独立解析，绝不用 legacy loader**：`AuthService.loadUsers()` 与 `InboxStore.load()` 都把损坏吞成
   「无历史/通用 503」，且 `loadUsers()` 缺 marker 时会 `writeExclusive('initialized')` **写源目录**。
   迁移工具必须自建只读解析（复用 §1 纯函数），才能报告**具体**不可迁原因且 dry-run **不改源**。
2. **dry-run 只读**：`inspect` 不创建/修改/删除任何源文件或目标库；输出**数量、摘要、冲突、不可迁原因**。
3. **不输出凭据**：`salt`/`hash` 是 scrypt 凭据；摘要只覆盖**非凭据**字段（见 §4），控制台/JSON 绝不打印 salt/hash/私钥。
4. **旧消息四不**：不重新签名、不延长 `exp`、不伪造身份、不确认状态（导入 mailbox 只落 `pending`，绝不 `received`）。
5. **缺身份/公钥 → 阻断**：mailbox 签名者公钥不在目标 registry（`node_id`+`key_epoch`）→ 该条**列为阻断不导入**，
   **不自动生成替代身份**（对齐 `identity.ts:15` 与计划 line110）。
6. **事务化 + 独占准入**：`import` 打开**专用目标库**、取独占准入（`storage/lock.ts` ownership），在**单事务**内
   追加数据 + **追加迁移记录**（§5 slice2），**不修改既有 schema 校验和**（v1–v4 checksum 不变，仅 append v5）。
7. **幂等 / 冲突拒绝**：**相同来源摘要**重跑幂等（无副作用）；**不同来源/内容冲突**（同 PK 异体）拒绝并回滚。
8. **源数据保留**：`verify` 后不删源；失败不破坏原数据（回滚，绝不静默重建/删库/淘汰已接管记录）。
9. **fail-closed**：malformed/损坏/冲突/COMMIT 失败/中途崩溃 → 抛出可解释错误、目标库回滚到导入前，绝不部分发布。

## 3. 四个已核实的陷阱（来自代码）

1. **legacy auth loader 吞损坏 + 写源**：`auth.ts:215 loadUsers()` `catch → failStorage()`（通用 503，丢失具体原因）；
   `auth.ts:234-241` 缺 marker 时 `writeExclusive(join(persistDir,'initialized'), …)` **写源**。→ 迁移独立解析、只读。
2. **legacy mailbox loader 吞损坏**：`mailbox.ts:92 load()` `catch → 视为无历史`；且 `entries as InboxEntry<E>[]`
   **不校验** envelope 结构，坏信封直接透传。→ 迁移独立解析 + 逐条 `validateEnvelope`。
3. **custody CHECK 使过期 mailbox 不可迁**：`gateway_custody` 要求 `expires_at > stored_at` 且
   `expires_at - stored_at ≤ 86400000`（24h），且 `status='expired'` 行 `payload IS NULL`（**过期即丢载荷**）。
   `SqliteCustodyStore.offer(env, now)` 用**信封原 `exp`** 作 `expires_at`、`stored_at=now`；`now ≥ exp` → 返回
   `'expired'` **且不插入任何行**。⟹ **旧消息若 `exp` 已过，物理上无法进 `gateway_custody`**（不能延 exp）。
   **只有仍有效（`exp` 在未来且 ≤ import+24h）且可验签**的消息才可迁为 `pending`；其余按原因列为不可迁（§6）。
4. **凭据外泄面**：`salt`(32hex)/`hash`(128hex scrypt) 与节点私钥是敏感凭据。→ 摘要/日志/JSON 只含非凭据字段。

## 4. 摘要与「不可迁原因」分类（inspect 输出契约）

**摘要（不含凭据）**：
- 每源文件：`sha256(文件原始字节)` → 幂等/冲突判定的**来源摘要**（slice2 记录用）。
- 每条 user：`sha256(JCS({username, role, created_at}))`（**排除 salt/hash**）。
- 每条 mailbox entry：`envelopeDigest(envelope)`（= `sha256(jcs(envelope))`，本就是公开摘要，不含私钥）。

**分类（每条记录归一类 + 机器可读 reason）**：
- `migratable`：通过全部校验、（mailbox）可验签且未过期、目标无冲突。
- `conflict`：目标已存在同 PK 但内容异体（`username` 已存在且 hash/role/created_at 不符；mailbox `(from_node,msg_id)` 已存在且 digest 不符）。
- `blocked`：mailbox 签名者公钥缺失/纪元不符/跨队/inactive（身份关联失败）。
- `non_migratable`：mailbox `exp` 已过（`expired`）或 `exp - import > 24h`（`invalid`）。
- `invalid`：结构/字段校验失败（malformed JSON、NUL 字节、`v≠1`、重复 `username`/`msgId` 异体、坏 salt/hash 正则、坏 ISO、坏信封/签名格式）。

**inspect 输出**：人类可读摘要（各类计数 + 逐条 reason，**不含凭据**）；`--json` 输出结构化
`{sources:[{path, sha256, kind}], users:{counts, records:[{username, role, created_at, digest, class, reason}]}, mailbox:{counts, entries:[{from_node, msg_id, digest, class, reason}]}, target:{path, schema_id, version, initialized, existing_users, existing_custody}}`。

## 5. 切片分解（每片 TDD：失败测试 → 最小实现 → 定向回归 → 变异 → 还原 → typecheck）

### slice1 — `qlong migrate inspect`（dry-run 只读盘点）
- **纯函数** `inspectMigration(sources, targetSnapshot, now) → Inventory`（新模块 `packages/cli/src/migrate/inspect.ts`
  或 `packages/registry/src/migrate-inspect.ts`；main.ts 仅粘合，惯例不单测粘合层）。
- 独立只读解析 auth 目录 + mailbox 文件；对目标库**只读**快照（`auth_meta`/`auth_users` 计数、`gateway_custody` 现有键、
  registry 节点公钥表）；逐条分类 + 摘要（§4）。**不写任何文件/库**。
- **测试**（`cli/test/migrate-inspect.spec.ts` 新）：malformed JSON、NUL 字节、`v≠1`、重复 `username`/`msgId` 异体、
  坏 salt/hash 正则、坏 ISO、坏信封、缺 marker、缺 pubkey→blocked、过期→non_migratable、目标已存在→conflict；
  **不改源断言**（源文件 mtime/bytes 前后一致、无 `initialized` 被写）；**不输出凭据断言**（JSON/文本不含 salt/hash 值）。
- **变异**：移除「独立解析」改调 `loadUsers()`→ 写源/吞损坏被断言捕获；移除某校验类→ 对应分类 RED；摘要含 salt→ 泄凭据断言 RED。

### slice2 — `qlong migrate import`（事务化导入）
- 打开**专用目标库**（`SqliteStore.open(schema: CENTER_SCHEMA')`）+ 独占准入锁；**单事务**内：
  - users：`INSERT auth_users`（`migratable` 子集）+ `UPDATE auth_meta SET initialized=1, user_count=N`（若目标未初始化）。
  - mailbox：对 `migratable` 子集先 `verifyEnvelopeSig`（离线 registry 公钥）再 `custody.offer(env, importNow)`
    （复用其原-exp/幂等/冲突/过期语义）；`blocked/non_migratable/invalid` **不导入**，写入迁移记录供审计。
  - **追加迁移记录**：`CENTER_SCHEMA` **v5** append（`data-import-ledger`，新片段 `IMPORT_LEDGER_SQL`，
    同 `CUSTODY_SQL`/`CLAIM_SQL`/`COMMAND_SQL` 模式，**不改 v1–v4 checksum**）：表 `import_ledger(source_sha256, kind, imported_at, migratable, blocked, non_migratable, invalid)`。
  - **幂等**：`source_sha256` 已在 ledger 且内容一致 → 无副作用返回；同 PK 异体 → `conflict` 拒绝回滚。
- **测试**（`cli/test/migrate-import.spec.ts` 新，复用 `server-custody-helpers.ts:failCommit`）：正常导入、
  重跑幂等（同摘要无新增）、不同源冲突拒绝、COMMIT 失败→回滚不破坏原库、中途崩溃（子进程 kill）→重跑一致、
  mailbox 不延 exp（导入后 `expires_at === 原 exp`）、缺 pubkey→blocked 不导入、v5 append 后 v1–v4 checksum 不变。
- **变异**：移除独占准入→并发双写 RED；不走单事务→COMMIT 失败留半量 RED；改 `stored_at/expires_at`→延 exp RED；
  ledger 幂等键移除→重跑翻倍 RED。

### slice3 — `qlong migrate verify`（导入后复核 + 切换说明）
- 只读复核：目标 `auth_users` 数量/逐条摘要 == inspect 预期；`auth_meta.initialized`/`user_count` 一致；
  mailbox `migratable` 子集在 `gateway_custody` 为 `pending` 且 `envelopeDigest` 匹配；**身份关联**（username↔team owner_user_id、
  envelope.from_node↔registry 节点）；**认证状态**（ imported owner 可登录路径不破坏）；**待投消息**计数。
- **源数据保留**断言；**缺身份/公钥 → 阻断**（verify 报告 blocked 清单，不代生成）。
- 输出**切换说明**（人工步骤：停旧服务 → 备份 → 迁移 → verify → 起 v2 服务；不自动切换现有部署）。
- **测试**（`cli/test/migrate-verify.spec.ts` 新）：导入后 verify 全绿；篡改目标某行→verify RED；
  删源→仍可读目标但报源缺失；缺 pubkey 条目→verify 列 blocked。
- **变异**：移除身份关联核对→错配 RED；移除源保留断言→删源 RED。

## 6. mailbox 身份关联与验证（离线）

- 迁移**离线**运行，不走 registry HTTP；直接**只读**目标 `center.sqlite` 的 registry 节点公钥表
  （`REGISTRY_SQL` 节点表，`node_id`+`key_epoch`→`pubkey`，含历史纪元）构造 `resolve(sender, epoch)`，
  喂 `verifyEnvelopeSig(env, resolve)`（同 E2 `createPubkeyResolver` 的校验语义：node_id/key_epoch/status/team）。
- 判定：验签通过 + `exp` 未来 + `exp - import ≤ 24h` → `migratable`（`offer` 落 `pending`）；
  公钥缺/纪元不符/跨队/inactive → `blocked`；`exp` 已过 → `non_migratable(expired)`；结构/签名格式坏 → `invalid`。
- `stored_at = import now`（v2 真正取得 custody 的时刻，诚实）；**原 `enqueuedAt` 记入 `import_ledger`/报告**，
  `gateway_custody` 无该列，不伪造。原 `exp` 由 `offer` 原样保留（`expires_at = 原 exp`）。

## 7. CLI 接线（`packages/cli/src/main.ts`）

- 新增 `if (cmd === 'migrate')` 块：`const sub = process.argv[3] ?? ''`；`sub ∉ {inspect,import,verify}` → 打印用法 + `exit 2`
  （镜像 `task`/`lead` 子命令风格，`main.ts:297/441`）。
- 标志（`--name value` 解析同 `join.ts:120`）：`--auth-dir <dir>`、`--mailbox <file>`、`--to <center.sqlite>`、
  `--data-dir`/`--storage-mode`（复用 `server-storage-options.ts`）、`--json`（inspect）、`--confirm-migration`（import 显式确认）。
- `KNOWN_COMMANDS`（`main.ts:502`）加 `'migrate'`；usage 串加 `migrate`。
- 逻辑全抽到 `migrate/` 模块（inspect/import/verify 纯函数 + 事务编排），main.ts 只解析参数 + 调用 + 打印（惯例：粘合层不单测）。

## 8. 出口（计划 line116）

迁移**可演练**（inspect dry-run）、**可核验**（verify 复核）、**失败不破坏原数据**（事务回滚 + 源保留）；
不再要求以新建空库代替升级。七包 typecheck + 全仓测试绿；malformed/NUL/重复 ID 异体/目标冲突/COMMIT 失败/中途崩溃/重跑均有自动化测试。
**处理真实旧数据与切换现有部署另行授权**——本阶段交付工具与测试即达 P2 出口。
