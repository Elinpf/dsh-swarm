# P31 设计：依赖解锁主动推送 + 定向可观测事件（待 P30 落地后填空）

> 产出人：dsh-plugin-dev-2 ｜ 任务：P31-unblock-push-events
> 状态：**设计与探针先行；代码填空待 dev-1 的 P30（计划闸/返工反馈）落地后**（共享工作树，避免与 `team-core`/`team-scheduler` 的 P30 改动互相覆盖）。
> 权威输入：`docs/event-alignment.md`（P28 审计，P1/P2/P3 条目）。

---

## 0. 事件名与撞名核对

已 `grep` 全仓：`swarm/task/unblocked|released|revoked|list-drained`、`swarm/member/status-changed` **代码中暂无同名**（仅 `docs/event-alignment.md` 建议）。
P30 计划闸预计用 `swarm/task/plan-request|plan-response` / `swarm/task/revision-requested`（P28 P0），**与本组不撞名**。
**落地前需再 grep 一次**，若 P30 也碰「终态/解锁路径」并引入 `swarm/task/unblocked`，则**合并语义而非并存**（谁先落谁定义，后落方复用）。

## 1. 性质与原则

- **P1 依赖解锁主动推送**：源 `TASK_UNBLOCKED`（`events.py:340`：上游终态→主动广播+nudge）。我方现状=**仅 `team-scheduler` 轮询重算 readiness**（`pollMs`），有 poll 延迟且依赖调度器存活。修复=**事件驱动即时推送**，**轮询兜底保留**（不互斥）。
- **P2**：`release`→回池通知；`reassign`→原 owner 定向撤回。
- **P3**：`member/status-changed`、`list-drained`（轻信号）补强可观测。
- **约定**：通知型事件（`released`/`revoked`/`terminal`/`unblocked`/`status-changed`/`list-drained`）走**非 durable** `ctx.emit`（同 `swarm/team/completed`）；**新 durable 状态**（若有）才遵守 ADR-0002（`emit` durable + fold + 恢复测试）。本设计不引入新 durable 状态。

## 2. 事件 schema（通知型，`ctx.emit(type, payload)`）

| 事件 | 触发点 | payload |
|---|---|---|
| `swarm/task/released` | `team-core.updateTask` action=`release` 成功后 | `{ taskId, previousOwner? }` |
| `swarm/task/revoked` | `team-core.updateTask` action=`assign`(=reassign) 且 owner 变化后 | `{ taskId, fromOwner }` + 定向 DM 原 owner |
| `swarm/task/terminal` | `team-core.updateTask` 后 `status ∈ {completed, cancelled}` | `{ taskId, status }` |
| `swarm/task/unblocked` | `team-scheduler` 收到 `terminal` 或扫描发现**新就绪** | `{ taskId, targets: string[] }` |
| `swarm/task/list-drained` | 扫描发现「全部任务终态」上升沿 | `{ count }` |
| `swarm/member/status-changed` | 扫描 diff 成员状态变化 | `{ memberId, name, status }` |

> 命名贴近源语义（P28 §建议），保留 ADR-0002 的 `swarm/*` 风格，不整体改名。

## 3. 填空点（P30 落地后改这两处，尽量小）

### 3.1 `packages/team-core/src/index.ts`（`updateTask` 尾部，P2/P1 触发）
- 变更前快照 `before = this.require().getTask(caller, taskId)`（reassign 需原 owner）。
- 成功后：
  - `action==='release'` → `emit('swarm/task/released', {taskId, previousOwner})`。
  - `action==='reassign' && before.ownerName!==after.ownerName` → `emit('swarm/task/revoked', {taskId, fromOwner})` + `send(dm→fromOwner, "任务已改派，你不用做了")`。
  - `after.status ∈ {completed, cancelled}` → `emit('swarm/task/terminal', {taskId, status})`。
- 助手 `emitEvent(type,payload)`（`ctx.emit?.()`，失败仅告警，仿 `team-completion`）。

### 3.2 `packages/team-scheduler/src/index.ts`（P1 push + P3）
- 构造订阅：`ctx.on?.('swarm/task/terminal', () => this.onTaskTerminal(this.armedAgent))`（armedAgent 由 `arm()` 设置）。
- `onTaskTerminal(agent)`：`listTasks` → 对**新就绪**（`ready && pending` 且未推过）的每个任务：
  - 目标 = `task.ownerName`（定向）或**空闲成员**（无 owner 时）；
  - `nudge(agent, target, "任务 X 已解锁就绪")`；`emit('swarm/task/unblocked', {taskId, targets})`。
  - `readyNudged:Set` 记录已推，任务离开就绪时清除（允许再次解锁再推）。
- `scan` 内附加：成员状态 diff → `emit('swarm/member/status-changed', …)`；全终态上升沿 → `emit('swarm/task/list-drained', {count})`。
- **保留** `arm()` 的 `pollMs` 轮询（兜底，P30 的计划态判定需合并进 `onePass` 的 busy 判定）。

## 4. 测试用例（每条一行为级）

| 用例 | 断言 |
|---|---|
| reassign 后原 owner 收到 revoked（**先红后绿**） | emit `swarm/task/revoked{fromOwner}` + 对 `fromOwner` 的 DM 内容含「不用做」 |
| release 后 emitted | emit `swarm/task/released{taskId}` |
| 终态触发 terminal | `complete` 后 emit `swarm/task/terminal` |
| **P1 解锁推送**：上游终态 → 下游 newly-ready 即时 nudge | 调 `onTaskTerminal` 后**同步/Microtask** 内出现 `nudge(owner)` 且 emit `swarm/task/unblocked`；**不依赖 poll** |
| 轮询兜底仍在 | 不触发 terminal 事件时，`pollMs` 到点仍 nudge |
| `member/status-changed` | 成员 idle→running 的扫描后 emit 一次（边沿，不重复） |
| `list-drained` | 全任务终态时 emit 一次（上升沿），恢复非终态后可再触发 |

## 5. 延迟探针（独立、不改 `scripts/e2e-profile.sh`）

`scripts/verify-unblock-latency.mjs`：起**真实 `team-scheduler` 服务**（编译产物）+ 可编程 fake `teamCore`，
测量「上游终态 → 下游归属人被 nudge」的延迟：
- **poll 模式**：不触发事件，仅靠 `pollMs` → 期望延迟 ≈ `pollMs`（测 baseline）。
- **push 模式**（P30 后）：调 `onTaskTerminal`（或 emit `swarm/task/terminal`）→ 期望延迟 ≈ 0。
- 输出两模式延迟对比；无 push 实现时标注 `SKIP: push not yet implemented`。
- 真实 profile 的头条数字（含模型 overlay）由 P20 的 profile 链路侧面支撑；本探针负责**机制级回归**（确定性）。

## 6. 边界与顺序

- **顺序**：等 dev-1 报 P30 完成 → 我 rebase 到最新 main → 改上述两处 → 再向 Leader 报**实际改动面**。
- **边界**：`swarm/task/terminal` 是否由 P30 的计划态路径一并发出需合并确认；`onTaskTerminal` 与 P30 对 `onePass` busy 判定的改动需同源（避免两处各判一次）。
- 通知型事件不参与 ADR-0002 折叠（无新 durable 状态），故**无需**恢复测试；若后续要 durable 化，另立 ADR 增补。
