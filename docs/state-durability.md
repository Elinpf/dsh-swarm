# 插件内存态与持久化审计（P23-state-durability）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm`
> 目标：把「插件内存态在重启 / 跨进程 / 崩溃恢复后丢失」当**一类缺陷**审计：逐包盘点 → 分类（天然短暂 / 必须持久）→ 修复「必须持久」项，或如实登记为已知限制。
> 结论表见 §1，能力边界见 `README.md`「跨重启状态」段。

> **【P52 更正 · 2026-10-27】durable 落盘通道的真实性**：经 P50 独立核实，本约定此前**只 `ctx.emit` 进程内广播、从未 append 到会话日志**
> （182 份真实会话日志中 `swarm/*` 0 条）⇒ **「可跨重启恢复」当时并不成立**（P23 的恢复验证是**模拟**：内存捕获 + 手动 recover）。
> 已由 **P52** 修为真持久：统一入口 `@elinpf/dsh-swarm-team-durable.emitDurable(session, name, payload)`
> → **`appendPluginRecord("plugin:swarm/…")`**（通道 A），并在 `@deepseek-ai/dsh-session` 落地 plugin record；
> `durableRecordOf(ev)` 供 replay fold。证据与逐类判定见 `docs/durability-findings.md`。
> 下文若与「已修复」相关表述冲突，**以本条为准**（历史叙述：曾为 emit-only 不可恢复 → P52 修为真持久）。


## 0. 定性：为什么整栈都是内存态

全仓**没有任何包声明 storage/durable 依赖**（`inject` 里无 `storage`；team-memory 注释自认「`ctx.storage` 作为可选持久化，缺失时仅存活于内存，告警」）。
项目一贯约定是「**durable 事件即真相**」：包 `emit('swarm/*')` → 经 session 日志落地 → 恢复时折叠。阶段 3 的 `team-distributed` 已按此实现 `recover()`（`packages/team-distributed/src/index.ts`，`DeliverJournal` 落 `queued`/`delivered`）。
**但阶段 0/1/2 的多数包只 emit、不 fold**，也没有在启动时订阅 replay——故重启即丢。

## 1. 内存态清单与分类（带文件行号）

> 备注：下表为**审计时（修复前）**的状态分类；「必须持久」6 项已于 P23 按 ADR-0002 修复（见 §3/§4）。

| 包 | 字段（行号） | 内容 | 分类 | 理由 |
|---|---|---|---|---|
| **team-core** | `reviewing: Set<taskId>`（`src/index.ts:129`） | 评审中任务集（`in_review` 叠加态） | **必须持久（缺陷）** | 丢 → `in_review` 退化为 `in_progress`：可能被**重复派发**、**绕过验证闸**直接被完成 |
| team-core | `seam / _backend / warnedUnavailable`（:120-123） | 后端挂接运行时 | 天然短暂 | 由响应式 `ctx.inject` 在重连后**自动重挂**（P22） |
| **team-review** | `states: Map<taskId, ReviewState>`（:96） | 评审轮次 / 票 / verdict | **必须持久（缺陷）** | 丢 → 恢复后 `in_review` 任务在 review 侧「`TEAMREVIEW_NOT_SUBMITTED`」**无法 settle**；票清零 |
| **team-bus** | `durable: BroadcastSnapshot[]`（:108）+ `seq`（:109） | 广播/多播记录（`history()` 的数据源） | **必须持久（缺陷）** | 丢 → 成员 `history()` 拉不到历史；`record-only` 扇出的消息**彻底丢** |
| **team-skills** | `docs: Map<teamId, SkillVisibility>`（:67） | 可见性声明文档 | **必须持久（缺陷）** | 丢 → 授权丢失：文档缺失=unrestricted → 可能**越权可见** |
| **team-skills** | `grants: Map<memberId, Set<skillName>>`（:68） | 成员授权增量 | **必须持久（缺陷）** | 丢 → 已授权技能变不可见（功能回退） |
| team-skills | `scoped / agentOf / pending / disposed`（:70-75） | 落层运行时 / 去重 | 天然短暂 | 由 `agent.ctx` 生命周期驱动；`reconcile` 幂等重建 |
| **team-memory** | `shared: MemoryRecord[]`（:40） | 共享团队记忆 | **必须持久（缺陷）** | 丢 → 团队记忆**丢失** |
| **team-memory** | `private: Map<memberId, MemoryRecord[]>`（:41） | 成员私有记忆 | **必须持久（缺陷）** | 丢 → 私有记忆丢失 |
| team-memory | `seq`（:42） | id 计数 | 必须持久（与上耦合） | 需与记录一起恢复，避免 id 冲突 |
| **team-completion** | `unread: number`（:53） | 未读消息台账 | **必须持久（或恢复时从 durable 折叠）** | 丢 → `unread=0`，`blockOnUnread=true` 时可能**提前判团队完成** |
| team-completion | `emitted / lastSnapshot`（:54-55） | 上升沿守卫 | 天然短暂 | 丢 → 至多**重复发一次** `swarm/team/completed`（下游应幂等） |
| **team-scheduler** | `reviewSince / reviewEscalated`（:88-90） | `review_stall` 计时 / 去重 | 天然短暂（可接受） | 丢 → 计时归零，**至多重升一次**，不会无限循环 |
| team-scheduler | `lastNudge / streak`（:84-86） | stale 催办节流 / 连续无果计数 | 天然短暂 | 丢了重置 → 至多早催/晚升级一次，非正确性 |
| team-scheduler | `_mode / timer / armedAgent / failures` | 运行态 | 天然短暂 | 由 `arm()` 重建 |
| **team-workspace** | `locks: Map<path, LockHandle>`（:80） | 写域锁（**带 TTL**） | 天然短暂（有意） | 带 TTL 的锁，重启即失效是**正确**语义（避免死锁）；跨进程锁由阶段 3 协调 |
| team-workspace | `worktrees: Map`（:81） | worktree 记录 | 天然短暂 | 可从磁盘/`ctx.worktrees` 重建 |
| **team-compaction** | `rounds / compactedForOverBudget / summaryErrors`（:46-49） | 压缩轮次 / 幂等守卫 | 天然短暂 | 幂等：重跑压缩安全；计数可从 `ctx.tokenMeter` 重算 |
| team-prompt / tool-swarm | — | 无自有内存态 | — | — |

（阶段 3 的 `team-transport` / `team-distributed` / `team-human` 由 `dsh-plugin-dev-2` 负责；`team-distributed` 已有 `recover()` 雏形，本表未越界审计。）

## 2. 「必须持久」项汇总（**已修复**：ADR-0002 emit durable + recover fold）

1. team-core `reviewing`（`in_review` 叠加态）—— P18 已登记。
2. team-review `states`（评审轮次/票/verdict）。
3. team-bus `durable` + `seq`（广播消息记录）。
4. team-skills `docs` + `grants`（可见性声明与授权）。
5. team-memory `shared` + `private` + `seq`（团队/成员记忆）。
6. team-completion `unread`（未读台账）。

## 3. 统一机制（**已采纳**，见 ADR-0002）

对齐既有约定「durable 事件即真相」：
- **emit**：每个「必须持久」变更发一条 `swarm/<domain>/*`（带 `version`）durable 事件；
- **fold**：包 `recover(events)` 用统一折叠助手 `foldDurableEvents`（`@elinpf/dsh-swarm-team-durable`）把历史事件折叠回内存态；运行时经 `ctx.on('session/event')` 叠加；
- **幂等**：折叠 + 实时事件共用同一 reducer，重复折叠安全。

> ✅ 该机制新增的跨包事件契约（事件名/schema）已由 **ADR-0002** 冻结并采纳（Leader 裁定方案 A + 四条护栏）。

## 4. 交付（全部落地）

- 审计（清单 + 分类 + 行号）✅
- **ADR-0002**（`docs/adr/0002-durable-state-convention.md`）+ 统一折叠助手包 `@elinpf/dsh-swarm-team-durable` ✅
- 6 个包逐个 emit durable + `recover` fold + **恢复测试**（未恢复失败、恢复成功）✅
- 能力边界表（README「跨重启状态」段）= 6 项「保持」✅
- 可执行诊断 `scripts/verify-durability.mjs`（`pnpm verify:durability`，**非发布门禁**）：置态 → 重建 → `recover` → 恢复，**绿**（见 `docs/verification.md` P23）。
