# ADR-0002：内存态持久化约定（durable 事件 + 折叠）

- 状态：已采纳（Accepted）
- 日期：2026-10-27

> **【P52 更正 · 2026-10-27】durable 落盘通道的真实性**：经 P50 独立核实，本约定此前**只 `ctx.emit` 进程内广播、从未 append 到会话日志**
> （182 份真实会话日志中 `swarm/*` 0 条）⇒ **「可跨重启恢复」当时并不成立**（P23 的恢复验证是**模拟**：内存捕获 + 手动 recover）。
> 已由 **P52** 修为真持久：统一入口 `@elinpf/dsh-swarm-team-durable.emitDurable(session, name, payload)`
> → **`appendPluginRecord("plugin:swarm/…")`**（通道 A），并在 `@deepseek-ai/dsh-session` 落地 plugin record；
> `durableRecordOf(ev)` 供 replay fold。证据与逐类判定见 `docs/durability-findings.md`。
> 下文若与「已修复」相关表述冲突，**以本条为准**（历史叙述：曾为 emit-only 不可恢复 → P52 修为真持久）。

- 决策人：team-leader（裁定方案 A + 四条护栏）；提出人：dsh-plugin-dev
- 相关：`docs/state-durability.md`（审计）、任务 P23-state-durability、`docs/adr/0001-team-core-contract-package.md`
- 修订：P41-adr-event-table-sync（同步 §3 事件表，补阶段 3 / P31 新增事件；起因：P40 跨包审计发现 §3 与实现不一致）

---

## 1. 背景与问题

阶段 0/1/2 的插件把关键协作状态放在**内存**里。逐包审计（`docs/state-durability.md`）发现 6 项「必须持久」状态在**重启 / 跨进程 / 崩溃恢复后丢失**，会导致错误行为（如 `in_review` 退化 → 绕过验证闸；`team-skills` 授权丢失 → 越权可见）。全仓此前**没有任何包声明 storage/durable 依赖**。

## 2. 决策

**采用方案 A**：所有「必须持久」状态统一走**既有约定「durable 事件即真相」**——变更时 `emit('swarm/<domain>/<action>')`（durable），恢复时**折叠（fold）**回内存态。**不引入 `ctx.storage` forms 这第二套持久化风格**（一致性优先；B 方案会让团队长期同时理解两种机制）。

顺序：**先 `team-core`（`reviewing`），再依赖它的包**（`team-review` / `team-completion` 建立在 core 语义上）。

## 3. 事件命名与 schema 约定（冻结）

- **命名**：`swarm/<domain>/<action>`；`domain ∈ {core, review, bus, skills, memory, completion, task, member, team, transport, distributed, human}`。
- **payload**：`readonly { version: 1; ... }`（**durable 事件必须带 `version`**；`bus-only` 通知事件**豁免**——见下）。
- **版本/兼容**：fold **只认 `version === 1`**；未知 version 或未知事件名 → **跳过 + 告警**（前向兼容：新增事件不破坏旧读者）。
- **顺序**：durable 事件按 session 日志**有序**；fold 按序应用。
- **两类事件（本 ADR 的权威区分）**：
  - **durable**（`emit` + `fold` + 恢复测试）：变更即 emit 一条带 `version` 的事件；状态归属方在自己的 `recover()` 里 fold 重建。**必须带 `version`**。
  - **bus-only**（仅 emit，不上 fold）：**纯通知 / 信号**，不重建任何内存状态，故**无 fold、无恢复测试**。task 域的 bus-only 事件**不带 `version`**；其余域（team/transport/distributed/human）报文虽带 `version: 1`，但**全仓无任何包 fold 这些前缀** → 仍属 bus-only，**不得**据其重建状态。

> **表完整性 = SSOT**：下表为 `swarm/*` 事件契约的**唯一权威清单**；P41 已把阶段 3 / P31 新增事件补入（不再以“见各阶段文档”代替）。新增事件须同步本表。

| domain | 事件 | 类型 | payload（durable 除 `version`） | 证据（emit / fold） |
|---|---|---|---|---|
| core | `swarm/core/review-entered` | durable | `{ taskId }` | emit `team-core/src/index.ts:425`；fold `:547` |
| core | `swarm/core/review-left` | durable | `{ taskId, outcome: 'completed' \| 'reopened' \| 'deleted' }` | emit `:436,:457`；fold `:550` |
| review | `swarm/review/submitted` | durable | `{ taskId, round }` | emit `team-review/src/index.ts:126`；fold `:222` |
| review | `swarm/review/vote` | durable | `{ taskId, reviewer, vote }` | emit `:143`；fold `:228` |
| review | `swarm/review/settled` | durable | `{ taskId, verdict }` | emit `:153`；fold `:236` |
| review | `swarm/review/round` | durable | `{ taskId, round }` | emit `:182`；fold `:232` |
| bus | `swarm/bus/broadcast` | durable | `BroadcastSnapshot`（id/from/topic/targets/text/ts） | emit `team-bus/src/index.ts:205,:249`；fold `:130` |
| skills | `swarm/skills/visibility` | durable | `{ teamId, map }` | emit `team-skills/src/index.ts:140`；fold `:105` |
| skills | `swarm/skills/grant` | durable | `{ memberId, names }` | emit `:157`；fold `:109` |
| memory | `swarm/memory/shared` | durable | `{ record: MemoryRecord }` | emit `team-memory/src/index.ts:79`；fold `:104` |
| memory | `swarm/memory/private` | durable | `{ memberId, record: MemoryRecord }` | emit `:89`；fold `:110` |
| completion | `swarm/completion/unread` | durable | `{ delta }`（+1 入队 / -1 投递） | emit `team-completion/src/index.ts:70,:73`；fold `:121` |
| task | `swarm/task/plan-request` | durable | `{ taskId, plan? }`（P30 计划闸：入闸 / 提交计划） | emit `team-core/src/index.ts:359,:370`；fold `:553` |
| task | `swarm/task/plan-response` | durable | `{ taskId, approved, feedback? }`（P30 计划闸：批准 / 驳回+理由） | emit `:382,:394`；fold `:558` |
| task | `swarm/task/revision-requested` | durable | `{ taskId, feedback }`（P30 返工反馈，定向回流作者） | emit `:440`；fold `:569` |
| task | `swarm/task/released` | bus-only | `{ taskId, previousOwner }`（回池通知） | emit `team-core/src/index.ts:493`（`emitEvent`，无 version） |
| task | `swarm/task/revoked` | bus-only | `{ taskId, fromOwner }`（reassign 定向通知原 owner） | emit `:499`（`emitEvent`，无 version） |
| task | `swarm/task/terminal` | bus-only | `{ taskId, status }`（终态 → 驱动 scheduler 重算 unlock） | emit `:512`（`emitEvent`，无 version） |
| task | `swarm/task/unblocked` | bus-only | `{ taskId, targets }`（P31 解锁推送） | emit `team-scheduler/src/index.ts:248`（`emitEvent`，无 version） |
| task | `swarm/task/list-drained` | bus-only | `{ count }`（P31 看板全终态上升沿） | emit `team-scheduler/src/index.ts:287`（`emitEvent`，无 version） |
| member | `swarm/member/status-changed` | bus-only | `{ memberId, name, status, previous }`（P31 成员状态边沿） | emit `team-scheduler/src/index.ts:270`（`emitEvent`，无 version） |
| team | `swarm/team/completed` | bus-only | `{ teamId, snapshot }`（团队完成上升沿；带 `version` 但无 fold） | emit `team-completion/src/index.ts:158`（`emitCompleted`） |
| transport | `swarm/transport/peer` | bus-only | `{ peerId, backend, state }`（peer 状态迁移观测；带 `version` 但无 fold） | emit `team-transport/src/index.ts:1023` |
| distributed | `swarm/distributed/role` | bus-only | `{ teamId, role: 'lead' \| 'follower' }`（带 `version` 但无 fold） | emit `team-distributed/src/index.ts:198,:206` |
| distributed | `swarm/distributed/split-brain` | bus-only | `{ teamId, existingOwner, owner }`（带 `version` 但无 fold） | emit `team-distributed/src/index.ts:186` |
| distributed | `swarm/distributed/inbound` | bus-only | `{ targetId, content }`（带 `version` 但无 fold） | emit `team-distributed/src/index.ts:334` |
| human | `swarm/human/seat` | bus-only | `{ seat }`（带 `version` 但无 fold） | emit `team-human/src/index.ts:138` |
| human | `swarm/human/inbound` | bus-only | `{ seatId, kind, target, origin }`（带 `version` 但无 fold） | emit `team-human/src/index.ts:196` |
| human | `swarm/human/delivered` | bus-only | `{ seatId }`（带 `version` 但无 fold） | emit `team-human/src/index.ts:228` |

> **P30** 新增 `task` 域（贴近源 `TASK_*` 语义，保留 `swarm/*` 命名）；**P31** 新增 `task` 域 bus-only（unblocked/list-drained）与 `member` 域（status-changed）；**阶段 3** 新增 `team`/`transport`/`distributed`/`human` 域；**P41** 把上述阶段 3 / P31 事件并入本表（此前仅列到 P30），使本表恢复 SSOT 完整性。
> **fold 归属**：durable 事件由**状态归属方** fold（core/review/bus/skills/memory/completion 各自 `recover()`）；bus-only 事件**无 fold**。`team-core` 的 `recover()` 只对 `swarm/core/*` 与 `swarm/task/{plan-request,plan-response,revision-requested}` 生效（`team-core/src/index.ts:186-187,543-569`），task 域其余 bus-only 事件（无 `version`）被 fold 跳过。

## 4. 折叠助手（统一实现，禁止各包手写）

新增极小运行时包 **`@elinpf/dsh-swarm-team-durable`**，导出：
- `DURABLE_VERSION = 1`
- `foldDurableEvents(state, events, reducers)`：按序折叠；跳过未知事件名/版本并回调告警；返回折叠后的 state。
- `isDurableEvent(ev)`：形状守卫。

各包在自己的 `recover(events)` 里调用它；**运行时**在启动/恢复时把历史 durable 事件喂给 `recover`。**禁止**各包自写 fold（避免乱序/告警处理发散）。
> 该助手是**抽象**，独立于任何上游实现——**不依赖 `team-distributed` 的具体 journal 实现**（dev-2 正在改那块）。

## 5. 职责边界

- **谁 emit**：状态变更的那一方（如 `team-core` 在 `submit_review` 时 emit）。
- **谁 fold**：状态归属方（自己的 `recover`）。
- **不持久**：天然短暂/可接受项（TTL 锁、`review_stall` 计时、上升沿 `emitted`、stale 计数）——见审计表，**有意不持久**。

## 6. 后果

- 新增包 `@elinpf/dsh-swarm-team-durable`（运行时助手，非插件，无 bundle row）。
- 6 个包各加 `recover(events)` + emit + **恢复测试**（未修复时失败、修复后转绿）。
- 能力边界表（README / `docs/verification.md`）随之由「不保持（缺陷）」改为「保持」。
