# 消息兜底设计（P51：未读参与完成判定 + 超时重投/升级）

> 产出人：dsh-plugin-dev-2 ｜ 任务：P51-message-fallback（**先方案，报 Leader 批准后再实现**）
> 硬依赖：**P50-durability-truth**（`swarm/*` durable 是否**真落会话日志 + 可跨重启恢复**）。**P50 未出结论前，不得声称兜底“可靠”。**
> 现状事实：`team-completion` **已**有未读闸（见 §1）。

---

## 0. 现状事实（实现前基线）

- `team-completion`（`packages/team-completion/src/index.ts`）已：
  - 监听 `session/event` 的 `team/message/queued`（unread+1）/`team/message/delivered`（unread-1），台账为**内存** `this.unread`（`:55`）；
  - 完成判定 `evaluate()` 三条件合取含 `noUnread = !blockOnUnread || unread===0`（`:98-100`），**默认 `blockOnUnread=true`** ⇒「有未读不得完成」**部分已存在**；
  - 另 emit `swarm/completion/unread{delta}` durable（`:70,73`）+ `recover()` 折叠（`:115`）——**其是否真持久，取决于 P50**。
- **缺**：① 未读台账**持久性未证**；② 无**显式 override 例外**；③ **无超时重投/升级**；④ 无「未读阻塞」可观测事件。

---

## 1. 未读台账：载体与持久化（方案项 1）

- **载体**：`team-completion`（收方视角台账）保持 `unread` 计数；**真源**=上游 `team/message/{queued,delivered}` 会话事件；本包映身 `swarm/completion/unread` durable。
- **写/读**：**收方**（收到 queued/delivered 时写）、**完成闸**（evaluate 时读）；**发方不写未读**（只写「待处理」台账，见 §3）。
- **怎么持久（关键，取决于 P50）**：
  - 若 **P50 结论=durable 成立（真 append + 可 replay）**：`swarm/completion/unread` 即可跨重启恢复，直接复用。
  - 若 **P50 结论=有缺口（仅 emit 未 append）**：**先修持久化**（把 `swarm/*` 真写会话日志 / 走 `ctx.session` append 或在 `session/event` 落库路径确认），再实现兜底；**否则未读台账重启即失真，兜底建在沙地**。
- **切忌**：再出现「命名 durable 实为内存」（P50 已怀疑此点）。

## 2. 完成判定接入点（方案项 2）

- 落点：`team-completion.evaluate()`（**已含** `noUnread`）。
- **加固**：
  - 新增可观测事件 `swarm/completion/unread-blocked{unread}`（unread>0 且其它条件都满足时发一次，上升沿），让「因未读未完成」**可观测**而非静默 false。
  - **显式 override 例外**：`evaluate(agent, { overrideUnread?: boolean })`（或 Config `allowUnreadOverride`，默认 false）——仅在**显式**要求时可越过未读闸，并在事件里标注 `overridden:true`。
- **防什么偏差**：防「未读被静默吞掉却判完成」导致**丢消息不可察觉**。

## 3. 超时重投 / 升级（方案项 3；我们比 Jiuwen 强）

- **载体**：发送侧「待处理」台账（`messageId → { target, sentAt, retried }`），落 `team-core.send` 侧（DM 发送点）**包一层**；若必须动 `team-bus`（扇出侧）**先报 Leader**（P47/P49 可能在动）。
- **策略**：
  - **超时阈值** `ackTimeoutMs`（可配，默认如 30s；“处理”= 收到 `team/message/delivered` 或目标 `in_progress/完成` 边沿）。
  - **重投次数上限** `maxRedeliver=1`（**单次**，采纳“重投一次”）。
  - **防重复刺激风暴**：**幂等键 `messageId`**（重投复用同 id → 目标侧按 id 去重，沿用既有 at-least-once+去重）；**指数退避**（仅 1 次，退避避免与 P46 唤醒叠加成风暴）；**去重集持久**（与 §1 同源，依赖 P50）。
  - **升级**：仍无处理 → emit `swarm/message/undelivered{messageId,target,retried}` → **通知 leader**（DM，走原生 `steer+notify`）**+ 标 stale**（若成员仍欠该活）。
  - **可观测**：`swarm/message/redelivered{messageId,target,attempt}`、`swarm/message/undelivered{...}`。
- **防什么偏差**：防「消息被吞/目标无响应」**无人察觉**；同时防「无界重投」把目标打爆。

## 4. 与既有能力的边界（方案项 4）

- **不破坏**：autonomous/scheduled 派发（`team-scheduler`、`team-core` DM-only）、**P42 `assign` 归属**、**P46 leader 事件唤醒**（升级通知走 DM→`steer+notify`，是**事件唤醒**而非阻塞 wait；**不得**让 leader 回到 `wait_agent` 长阻塞）。
- **与 Jiuwen 差异（显式）**：Jiuwen=「落库先行 + 未读闸 + **关闭时排空**」，**无硬 ack / 无超时重投**；我们**新增**「限时未处理→重投一次+升级」，是其**增强**。
- **落点**：优先 `team-completion` / `team-core`；**不动 `packages/bundle/*`（P44）、不动 `tool-swarm`（P49）**。

## 5. 可证伪验收（方案项 5）

- **真实 profile + 完整栈**（先报预算）：
  1. **成员不读消息 → 任务不被判完成【成立】**（构造 unread>0 + 任务全终态 → `evaluate` 返回 `completed:false`，且 `swarm/completion/unread-blocked` 可观测）。
  2. **消息限时未处理 → 发生重投+升级且可观测**（发后 T 内无 delivered → 重投 1 次 + `swarm/message/undelivered` + leader 收到通知）。
  3. **无刺激风暴**（重投**至多 1 次**、幂等 by id、目标侧去重 → 目标不重复刺激）。
- **确定性**：单测先红后绿覆盖上述三条（不需模型）。

## 6. 风险与解锁

- **头号风险 = P50**：若 durable 有缺口 → 未读/去重台账重启失真 ⇒ **先修持久化再实现**。本方案在 P50 出结论前**不实现、不声称可靠**。
- 次要：超时判定的「处理」定义需与 P42 `assign`/P46 唤醒边界对齐（避免把「leader 已空闲等事件」误判为未处理）。
- **实现顺序**：P50 结论 → 本方案批准 → 先红后绿实现（`team-completion`/`team-core`）→ 真实 profile 回归（报预算）。
