# ADR-0002：内存态持久化约定（durable 事件 + 折叠）

- 状态：已采纳（Accepted）
- 日期：2026-10-27
- 决策人：team-leader（裁定方案 A + 四条护栏）；提出人：dsh-plugin-dev
- 相关：`docs/state-durability.md`（审计）、任务 P23-state-durability、`docs/adr/0001-team-core-contract-package.md`

---

## 1. 背景与问题

阶段 0/1/2 的插件把关键协作状态放在**内存**里。逐包审计（`docs/state-durability.md`）发现 6 项「必须持久」状态在**重启 / 跨进程 / 崩溃恢复后丢失**，会导致错误行为（如 `in_review` 退化 → 绕过验证闸；`team-skills` 授权丢失 → 越权可见）。全仓此前**没有任何包声明 storage/durable 依赖**。

## 2. 决策

**采用方案 A**：所有「必须持久」状态统一走**既有约定「durable 事件即真相」**——变更时 `emit('swarm/<domain>/<action>')`（durable），恢复时**折叠（fold）**回内存态。**不引入 `ctx.storage` forms 这第二套持久化风格**（一致性优先；B 方案会让团队长期同时理解两种机制）。

顺序：**先 `team-core`（`reviewing`），再依赖它的包**（`team-review` / `team-completion` 建立在 core 语义上）。

## 3. 事件命名与 schema 约定（冻结）

- **命名**：`swarm/<domain>/<action>`；`domain ∈ {core, review, bus, skills, memory, completion}`。
- **payload**：`readonly { version: 1; ... }`（**必须带 `version`**）。
- **版本/兼容**：fold **只认 `version === 1`**；未知 version 或未知事件名 → **跳过 + 告警**（前向兼容：新增事件不破坏旧读者）。
- **顺序**：durable 事件按 session 日志**有序**；fold 按序应用。

| domain | 事件 | payload（除 version） |
|---|---|---|
| core | `swarm/core/review-entered` | `{ taskId }` |
| core | `swarm/core/review-left` | `{ taskId, outcome: 'completed' \| 'reopened' \| 'deleted' }` |
| review | `swarm/review/submitted` | `{ taskId, round }` |
| review | `swarm/review/vote` | `{ taskId, reviewer, vote }` |
| review | `swarm/review/settled` | `{ taskId, verdict }` |
| review | `swarm/review/round` | `{ taskId, round }` |
| bus | `swarm/bus/broadcast` | `BroadcastSnapshot`（id/from/topic/targets/text/ts） |
| skills | `swarm/skills/visibility` | `{ teamId, map }` |
| skills | `swarm/skills/grant` | `{ memberId, names }` |
| memory | `swarm/memory/shared` | `{ record: MemoryRecord }` |
| memory | `swarm/memory/private` | `{ memberId, record: MemoryRecord }` |
| completion | `swarm/completion/unread` | `{ delta }`（+1 入队 / -1 投递） |
| task | `swarm/task/plan-request` | `{ taskId, plan? }`（P30 计划闸：入闸 / 提交计划） |
| task | `swarm/task/plan-response` | `{ taskId, approved, feedback? }`（P30 计划闸：批准 / 驳回+理由） |
| task | `swarm/task/revision-requested` | `{ taskId, feedback }`（P30 返工反馈，定向回流作者） |

> P30 新增 `task` 域（贴近源 `TASK_*` 语义，保留 `swarm/*` 命名）；`domain ∈ {core, review, bus, skills, memory, completion, task}`。

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
