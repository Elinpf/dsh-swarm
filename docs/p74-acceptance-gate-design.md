# P74 验收闸一组（B1/B2/B4）实现方案

> 产出人：dsh-plugin-dev-2 ｜ 任务：P74-acceptance-gate-batch2 ｜ **阶段 1 = 方案（先报 team-leader 批准，再改码）**
> 权威输入：`docs/jiuwen-leader-behavior-migration.md`（§1.6/§2/§4-R3/R6、B1/B2/B4）。落点：`team-review`/`team-core`（必要时 `team-completion`）；**不动 `client/*`、`team-prompt`、`bundle`**。

## 0. 现状（代码级事实）

- `team-review`（`packages/team-review/src/index.ts`）：`ReviewPool{kind:'binary'|'score', rule, threshold, roles}`；`submitForReview` 只入 `in_review`；`vote`；`settle`；
  `maxRounds`（=3）存在但**未用于轮控升级**；`stallTimeoutMs` 未接调度。
- `team-core`：`reviewing` 集叠加 `in_review`；`updateTask` **在 in_review 时拒绝 claim/release/edit/assign，但允许 `complete`**（B2 缺口）。
- `team-completion`：仅未读闸（B5 另计，不在本批）。
- 既有：P18 `in_review` overlay、P30 计划闸/返工反馈（`reject_review` 带 feedback）、P31 `swarm/task/terminal` 解锁推送。

## 1. B1/B2/B4 **一起上**的解卡设计（核心）

**不卡死三支柱**（对应 R3）：
1. **B1 验收闸补全**：任务可带**结构化 reviewer**（`verifier`/`inspector`/`challenger`）；`inspector` 票**会计票**（score 池取均值/阈值）；三类共同决定 verdict。
2. **B2 `in_review` 阻止直接 `complete`**：`team-core.updateTask(action='complete')` 在 `reviewing` 时**被拒**（`TEAMCORE_REVIEW_REQUIRED`），必须经 `team-review.settle` 的 `pass` 落终态。
3. **B4 验收升级（有界解封）**：`in_review` 任务在 **轮数耗尽（`maxRounds`）** 或 **reviewer 超时（`stallTimeoutMs`）** 时 → 发 `swarm/review/escalated` + **DM leader（inbox）**，给出处置（retry / replan / reassign / override）。**这是 R3 兜底**：即便评审池无人投票，也会**有界时间内升级到 leader**，不会永久 `in_review`。

**终止性论证（对齐 `message-fallback-design.md §7.1`）**：
```
submit_review → in_review（B2 阻止直接 complete）
  ├─ 评审池 evaluate → settle(pass) → completed
  ├─ settle(fail) → reject_review(带 feedback) → in_progress（返工，round+1）
  └─ ① 轮数 ≥ maxRounds 或 ② reviewer 超 stallTimeoutMs
        → swarm/review/escalated + DM leader → leader 处置（retry/replan/reassign/override）
```
- 每步**有界**（`maxRounds` 与 `stallTimeoutMs` 均为有限配置），**必达** `completed` 或 `escalated→人裁决`——**无无限 `in_review`**。
- **默认不阻塞**：**无评审池**（`pools` 为空）时，`submit_review` 维持「**直接完成**」语义（现状）⇒ trivial 场景不因验收闸卡死。

## 2. 兼容与去重（不重复/不推翻）

| 既有 | 关系 |
|---|---|
| **P18 `in_review`** | 复用 overlay；B2 仅收紧「in_review 期间 `complete` 必须走 settle」，不新增状态。 |
| **P30 计划闸/返工反馈** | `reject_review` 已带 `feedback`（返工定向回流）；B1/B4 复用，不另造。 |
| **P31 解锁/可观事件** | `settle(pass)` 落 `completed` → 既有 `swarm/task/terminal` 触发解锁；B4 的 `escalated` 为**新增通知型**事件（走通道 A）。 |
| **P51 消息兜底（升级 leader）** | **两者独立、勿合并**：P51=**消息投递**兜底；B4=**验收闸**升级。可实现层共用 DM 机制，但事件/语义分开。 |
| **P42 assign 归属** | B4 的处置「reassign」**复用**既有 reassign，不加新归属。 |
| **P51-like override（未读 override）** | B4 的 leader override（`force_complete`/`reopen`）**独立**，不复用未读 override。 |

## 3. 新事件 → **通道 A**（强制）

- 新增：`swarm/review/escalated`（通知/durable 记录），payload `{ taskId, reason:'rounds'|'timeout', round, verdict }`。
- 既有 `swarm/review/{submitted,vote,settled,round}` 保持；全部经 **`team-durable.emitDurable(session, name, payload)` → `appendPluginRecord("plugin:swarm/…")`**（P52 通道 A）+ `recover()` fold（幂等）。
- **同步 `ADR-0002 §3` 事件表**（新增 `swarm/review/escalated` 行）。
- **恢复测试**：新增事件的 fold + 跨重启 replay（复用 P52 的 `scripts/verify-durable-channel.mjs` 思路做该事件的往返）。

## 4. 升级路径：可观测且不引入新停滞

- 事件 `swarm/review/escalated` 可观测；**升级走 leader inbox（DM）**，**不进用户主对话**（R6）。
- 有界解封（§1）保证不引入新停滞；与 P51 的「有界解封」同构但**独立事件/域**。

## 5. 可证伪验收（先红后绿）

| # | 场景 | 期望 |
|---|---|---|
| 1 | **有池**：任务 `in_review` 且未 settle | 直接 `complete` **被拒**（`TEAMCORE_REVIEW_REQUIRED`）【B2 红→绿】 |
| 2 | **inspector 计票** | score 池达标 → verdict `pass`；不达标 → `fail`【B1】 |
| 3 | **不卡死**：有池但 reviewer 不投票，超 `stallTimeoutMs` | 发 `swarm/review/escalated` + leader 收 DM；任务在 `maxRounds`/超时内**不再无限 in_review**【B4/R3 核心】 |
| 4 | **无池** | `submit_review` 维持**直接完成**（不阻塞）【防过度加固】 |
| 5 | 轮数耗尽 | 第 `maxRounds` 轮后升级，不再新增轮次 |
| 6 | **回归**：settle(pass) 仍触发 P31 解锁；`reject_review` feedback 仍回流 |

- 实现后：**多轮采样**（避免方差假绿，对齐 P46 教训）；真实 profile 回归**先报预算 + 先设上限**。

## 6. 风险与缓解（对齐 §4）

- **R3（核心）**：B1/B2/B4 **必须一起上** + 无池默认不阻塞 + 终止性论证（§1）⇒ 不永久 `in_review`。
- **R6**：升级消息走 leader inbox（DM），不进主对话。
- **R2**：保留「无成员/无 reviewer → 不阻塞」退路，避免 leader 卡死。

## 7. 落地步骤（批准后）

1. `team-review`：结构化 reviewer（任务→reviewer 类型）+ inspector 计票 + `escalated` 事件（通道 A）+ settle 收敛。
2. `team-core`：`in_review` 时 `complete` 拒绝（B2）。
3. 调度/超时：`stallTimeoutMs` 到期重催/升级（可落 `team-scheduler` 扫描，或 `team-review` 内部计时；**动 team-scheduler 先报**）。
4. 测试（§5）+ ADR-0002 §3 同步 + `docs/verification.md`。
5. **不动** `client/*` / `team-prompt` / `bundle` / `scripts/bench/*` / `verify-e2e.mjs` / `final-acceptance.md`。
