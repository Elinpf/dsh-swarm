# Jiuwen workflow/编排 → dsh-swarm 迁移规格（任务状态机 / 派发 / 闸门 对照 + checklist）

> 产出人：migration-architect ｜ 任务：P71-workflow-migration-spec ｜ 日期：2026-10-28
> 目标：把 Jiuwen 的 **workflow/编排机制**挖成规格，与我们的 `team-scheduler`/`team-core`/`team-completion`/`team-durable` 对照，产出**迁移规格 + 可迁移 checklist**（先规格，后实现）。
> 纪律：**只读调研 + 新写文档**；**未改 `packages/*/src`**；未改 `scripts/bench/*`、`verify-e2e.mjs`、`final-acceptance.md`。
> 约定：
> - `【事实】`：读到源码，附 `文件:行号`（Jiuwen 侧权威源 `/opt/openjiuwen/.../openjiuwen/agent_teams/` 与 `core/graph/`；我们侧 `dsh-swarm/packages/*`）。
> - `【推断】`：未实测的方向判断。
> - `【建议】`：迁移处置。
> - 历史 T1/T6（`cluster-architecture.md`/`workflow-automation.md`）仅作线索，**本文件所有引用均按当前源码行号重新核实**。

---

## 0. 结论速览（TL;DR）

- **【事实】Jiuwen 的「编排」是四层叠起来的**：① 单机 LLM 自主 todo（软规划）；② **团队任务 DAG = 声明式状态机 + 依赖解锁**（硬骨架）；③ **事件总线 + 周期轮询 + 幂等扫描**驱动自动推进（发动机，`event_bus.py`/`scheduler.py`）；④ 独立的 **PregelGraph / SwarmFlow 脚本引擎**（真正的通用工作流引擎，`core/graph`、`workflow/engine`）。
- **【事实】我们侧 = ② + ③ 的「事件驱动精简版」**：原生 DSH 任务板（4 态）+ `team-core` 叠加 `planned/in_review` 两个闸门 + `team-scheduler` 幂等扫描（`scan()`，默认 `scheduled`）+ `team-completion` 三条件判定。**没有** ④ 的图/脚本引擎（DSH 有独立的 `ctx.workflowEngine`，我方未接）。
- **★ 最大机制差距（Top5）**：
  1. **并行/分支原语缺失**：Jiuwen 有 PregelGraph 条件边 + SwarmFlow `parallel`/`pipeline`/`map_parallel`；我方**无任何并行/分支编排原语**（只有 DAG 依赖 + 串行扫描）。
  2. **脚本式可恢复编排缺失**：Jiuwen SwarmFlow 有 Journal/WAL + `resume` + cache-hit 短路；我方团队任务**无 run 级快照/续跑**（只有 durable 事件 fold 恢复内存态）。
  3. **并发治理缺失**：Jiuwen 有 per-Leader 并发治理（`max_workflows`/`agents_per_run`/`max_agents_total`）；我方**无全局并发/预算闸**（只有「一人一活跃任务」不变量）。
  4. **状态机粒度差距**：Jiuwen 任务 7 态 + 成员 10 态 + 执行 10 态 + 两个镜像闸门；我方 = 原生 4 态 + 2 overlay 闸门，**无 BLOCKED/CANCELLED 一等状态**（用 `ready`/`deleted` 逼近）。
  5. **恢复语义差距**：Jiuwen 靠 CAS + DB + `recover_team` 重建整队；我方靠通道 A durable 事件 fold——**已修但覆盖不全**（ADR-0002 P52 更正：`team-bus` 待接、`team-skills.visibility` 仅进程内）。

---

## 1. 机制对照（逐项 Jiuwen ↔ 我们 / 缺失）

### 1.1 任务状态机（状态集 / 跃迁 / 非法跃迁）

| 维度 | Jiuwen（事实·行号） | 我们（事实·包:行号） | 判定 |
|---|---|---|---|
| 状态集 | `TaskStatus`：`PENDING/BLOCKED/PLANNING/IN_PROGRESS/IN_REVIEW/COMPLETED/CANCELLED`（`schema/status.py:303-309`） | 原生 `pending/in_progress/completed/deleted` + team-core overlay `in_review`/`planned`（`team-core-contract/src/index.ts:53`） | **部分等价**（缺 BLOCKED/CANCELLED 一等状态） |
| 跃迁表 | `TASK_TRANSITIONS`（`status.py:318-351`）：PENDING→{PLANNING,IN_PROGRESS,BLOCKED,CANCELLED}；BLOCKED→{PENDING,CANCELLED}；PLANNING→{PLANNING,IN_PROGRESS,PENDING,BLOCKED,CANCELLED}；IN_PROGRESS→{IN_REVIEW,COMPLETED,PENDING,BLOCKED,CANCELLED}；IN_REVIEW→{COMPLETED,IN_PROGRESS,PENDING,CANCELLED}；COMPLETED/CANCELLED=∅ | 无显式跃迁表；用 **action 白名单 + 前置态校验**（`team-core/src/index.ts:390-445`）；非法跃迁抛 `TEAMCORE_INVALID_TRANSITION`（`:398,409,423,435,451,467,478,502`） | **等价（机制不同）**：源用表驱动，我们用守卫式 |
| 非法跃迁 | `is_valid_transition`（`status.py:378-395`）查表 | 守卫式：如「只允许 in_progress 进 review」（`:464-468`）、「评审态只允许 complete/reopen/delete」（`:499-505`）、「计划闸未批准不能执行」（`:445+`） | **等价** |
| 两镜像闸门 | `PLANNING`（执行前）与 `IN_REVIEW`（执行后）结构对偶，各带自环返工边（`status.py:279-282,329-348`） | `planned`（计划闸，`planning` set）与 `in_review`（`reviewing` set）同样对偶；各自返工自环 | **等价** |
| 双模式收敛 | autonomous 的 `claim` 与 scheduled 的 `start` **进同一 `IN_PROGRESS`**（`status.py:284-288`） | `scheduled` 的端口 `assign`→原生 `reassign`（P42，`team-scheduler` 派发）；`autonomous` nudge 后成员自 `claim` | **等价** |
| 可改派态 | `TASK_REASSIGNABLE_STATUSES = {PENDING,BLOCKED,IN_PROGRESS}`（闸门态被排除，`status.py:369-375`） | 评审态拒改派（`team-core/src/index.ts:499-505`）；其余经 `assign` | **部分等价**（闸门排除已实现） |
| 成员状态机 | `MemberStatus` 10 态 + `MEMBER_TRANSITIONS`（`status.py:38-147`）+ `MEMBER_SETTLED/QUIESCENT`（`:155-193`） | 原生 `provisioning/active/failed` + 派生 `running/idle/inactive`；**我们无自有成员状态机** | **缺失（有意）**：DSH 花名册更简单，见 §2 |
| 执行子状态 | `ExecutionStatus` 10 态（`status.py:196-271`） | 无 | **不可迁移**（DSH 派生状态足够） |
| 成员模式 | `MemberMode`：`BUILD_MODE`/`PLAN_MODE`（`status.py:223-231`） | 无显式模式；计划闸按 action 触发 | **部分等价** |

> **【事实】** 我们任务态的「BLOCKED」由 `ready`/`blockedBy` 计算（原生 `TeamTaskView.ready`）而非一等状态；「CANCELLED」由原生 `deleted`/`complete` 逼近。**【建议】** 保持现状（不引入 BLOCKED 一等状态），理由：DSH 原生任务板以 `blockedBy` 动态算 `ready`，引入 BLOCKED 需与原生状态同步，成本高、收益低。

### 1.2 派发与唤醒（谁能叫醒谁）

| 维度 | Jiuwen（事实·行号） | 我们（事实·包:行号） | 判定 |
|---|---|---|---|
| 驱动模型 | 事件总线（薄唤醒层，非决策引擎，`coordination/event_bus.py:6-12`）+ 周期轮询（`POLL_TASK` 30s）兜底 | `team-scheduler.scan()` 幂等扫描 + `pollMs` 30s 兜底（`team-scheduler/src/index.ts:70-71,311`） | **等价（同一范式）** |
| 派发模式 | `dispatch_mode ∈ {autonomous, scheduled}` 在装配期选 handler 变体（`coordination/dispatcher.py:188-195`） | `SchedulerMode` 默认 `scheduled`（`team-scheduler/src/index.ts:70`），`autonomous` 只 nudge（`:356-358`） | **等价** |
| scheduled 派发 | 调度器 `_reconcile_starts`/`start_task` + `_send_as_leader`（`scheduling/scheduler.py:197-287,622`） | `scan()` 有界 fixpoint（`MAX_SCAN_PASSES=4`，`:63,189`）；CAS `assign`（P42）后定向 nudge（`:360-378`） | **等价** |
| autonomous 唤醒 | `TaskBoardHandler` nudge（仅 CREATED/UNBLOCKED/RELEASED） | `autonomous` 分支 nudge 空闲成员（`:356-358`） | **等价** |
| 事件驱动 | transport 事件 `enqueue` → `_run_loop`（`event_bus.py:239,270`） | `onTeamEdge` 防抖 → `scan()`（`team-scheduler/src/index.ts:218-223`）；`swarm/task/terminal` 驱动即时 unlock 重算（`:229`） | **等价（我们更精简）** |
| 防自唤醒 | `_filter_self`（`coordination/kernel.py:590-611`） | 无（我们通过显式调用/事件，不订阅自发 bus） | **部分等价** |
| 唤醒语义 | 「DB 行决定是否消耗 LLM 轮」（T2 `interaction-mechanisms.md`） | `send(delivery:'wakeup')` 才唤醒；quiet 不唤醒 | **等价** |

### 1.3 验收 / 闸门 / 返工

| 维度 | Jiuwen（事实·行号） | 我们（事实·包:行号） | 判定 |
|---|---|---|---|
| **计划闸（执行前）** | `PLANNING`：`submit_plan`→`approve_plan`；事件 `TASK_PLAN_REQUEST`/`TASK_PLAN_RESPONSE`（`schema/events.py:139-140,291-307`） | `team-core`：`planning` set；`action submit_plan/approve_plan/reject_plan`；durable `swarm/task/plan-request`/`plan-response`（`team-core/src/index.ts:400-445`） | **等价**（P30 已迁） |
| **验证闸（执行后）** | `IN_REVIEW`：`submit_for_review`→`verify_task`；事件 `TASK_SUBMITTED_FOR_REVIEW`/`TASK_VERIFIED`/`TASK_REVISION_REQUESTED`/`TASK_REVIEW_VOTE`（`events.py:151-155,369-415`） | `team-review`：`submit_review/vote/settle`；durable `swarm/review/{submitted,vote,settled,round}`（`team-review/src/index.ts:126-182`） | **等价** |
| **裁决数学** | 二元池一票否决 + 打分池均值阈值（`scheduling/verdict.py`；SwarmFlow 同口径 `workflow/engine/verify.py:1-70`） | `team-review` 同口径（二元 veto + 打分阈值 + UNDECIDED） | **等价** |
| 不可自验 | 作者不得评审自己（`task_manager.py:264-265`） | `TEAMREVIEW_SELF_VOTE`（`team-review/src/index.ts:135-142`） | **等价** |
| **返工反馈** | `TASK_REVISION_REQUESTED` 带 `feedback`，定向 steer 作者（`events.py:389-397`） | durable `swarm/task/revision-requested`（`team-core/src/index.ts:440`）；`reject_review`/`reject_plan` 带 feedback | **等价**（P30 已迁） |
| 计划门与验证门对称 | 结构对偶（`status.py:279-282`） | 同样对偶（`planning`/`reviewing` 两 set + 两 durable 事件族） | **等价** |
| **完成判定** | 三条件（≥1 任务全终态 + 全成员 settled + 无未读），`events.py:202-212` | `team-completion.evaluate`：任务全终态 + 成员 idle + 无未读（`team-completion/src/index.ts:98-142`，`blockOnUnread` 默认 true） | **等价** |
| 看板排空 | `TASK_LIST_DRAINED`（`events.py:417-424`） | bus-only `swarm/task/list-drained`（`team-scheduler/src/index.ts:287`） | **等价**（P31 已补） |
| 计划审批事件（源 `PLAN_APPROVAL`） | `events.py:122,246` | 无独立事件（并入 `swarm/task/plan-response`） | **部分等价** |

### 1.4 索命（stale）/ 升级

| 维度 | Jiuwen（事实·行号） | 我们（事实·包:行号） | 判定 |
|---|---|---|---|
| stale 检测源 | autonomous：成员**进程内 idle 时钟**；scheduled：legacy `task.updated_at`（`handlers/stale_task.py:58,99,147`） | `staleSweep`（`team-scheduler/src/index.ts:388`）：对欠工成员按 `staleClaimIdleMs` 扫描 | **等价** |
| 阈值 | `stale_claim_idle_timeout` 默认 600s（`cluster-architecture.md` §4.3 / `stale_task.py`） | `staleClaimIdleMs` 默认 600000ms（`team-scheduler/src/index.ts:72`） | **等价** |
| 自催 | `_self_nudge_idle_claim`（`stale_task.py:201`） | `nudge(agent, …, '任务卡住已久')`（`team-scheduler/src/index.ts:388+`） | **等价** |
| 升级 | 连续 `_STALE_CLAIM_ESCALATE_STREAK=3` 无果 → **卡住者自己**给 leader 发消息（`stale_task.py:71,232`） | `staleEscalateStreak` 默认 3（`:73`）→ `escalateToLead` | **等价** |
| leader stale-pending 自提示 | leader 空闲 + 有未分配 PENDING + 有 READY 成员 → 自提示（`stale_task.py:269-339`） | 无显式分支（scheduled 下长 PENDING 属正常排队） | **部分等价** |

### 1.5 并行与分支（PregelGraph 条件边 / SwarmFlow `parallel`/`pipeline`）

| 维度 | Jiuwen（事实·行号） | 我们（事实·包:行号） | 判定 |
|---|---|---|---|
| 通用图引擎 | `PregelGraph`（`core/graph/graph.py:57`）：BSP 超步；条件边 `add_conditional_edges`（`:122`）、`branches`（`:64`）、`branch_targets`（`:65`）、`register_branch_targets`（`:134`）、`wait_for_all` barrier（`:86`）、`_resolve_barrier_groups`（`:180`） | **无**（我方无图引擎） | **★ 缺失** |
| 声明式并行（barrier） | SwarmFlow `parallel(thunks)`（`workflow/engine/primitives.py:1399`）：fork-join gather，失败 thunk→None | **无** | **★ 缺失** |
| 流式流水（无 barrier） | `pipeline(items, *stages)`（`primitives.py:1448`）：stage 间可并发流水 | **无** | **★ 缺失** |
| 映射扇出 | `map_parallel(items, fn)`（`primitives.py:1488`） | **无** | **★ 缺失** |
| 阶段/叙事 | `phase(title)`（`primitives.py:1506`）、`log(msg)`（`:1513`） | 无（DSH 有 `workflow/*` 原生事件，我方未接） | **缺失（可复用 DSH）** |
| 嵌套工作流 | `workflow(name_or_path, args)`（`primitives.py:1549`） | 无 | **缺失（可复用 DSH）** |
| 编排内评审 | `verify()`（`primitives.py:882`）+ `engine/verify.py`（二元 veto + 打分阈值） | `team-review`（任务级，非脚本级） | **部分等价**（我们无脚本级 verify） |
| 人在环 | `human_session()`（`primitives.py:1329`）、`agent_session()`（`:1312`） | `team-human.ask`（复用 `ctx.userQuestions`） | **部分等价** |
| run 级持久化/续跑 | `run_workflow(... resume, journal_path ...)`（`engine/runner.py:294`）+ Journal/WAL 边车（`:26,326-331`）+ cache-hit 重计费（`:138`） | 无 run 级快照；仅 durable 事件 fold（内存态恢复） | **★ 缺失** |
| 并发治理 | `ConcurrencyLimits`：`max_workflows=16`/`agents_per_run`/`max_agents_total=64`（`workflow/concurrency.py:19-25`） | 无全局并发/预算闸（仅「一人一活跃任务」） | **★ 缺失** |
| 预算账本 | `budget()` + ledger（`primitives.py:322-354`；`team-compaction` 侧有预算快照） | `team-compaction` 预算快照（局部） | **部分等价** |

> **【事实】** DSH **自带** `ctx.workflowEngine`（脚本 + `agent()` 扇出，worker-thread 引擎）与 `workflow/*` 事件——**并行/分支/脚本编排的正确落点是复用它，而非把 PregelGraph/ SwarmFlow 从 Python 移植到 TS**（见 §2）。

---

## 2. 可迁移 checklist（分类 + 优先级）

> 分类：**【仅提示词可移植】**（改提示词/模板即可）/ **【需代码】**（要写逻辑）/ **【不可迁移 + 原因】**。
> 优先级：P0（阻塞对齐）/ P1（值得做）/ P2（可选）/ P3（不做）。

### 2.1 【仅提示词可移植】
| 项 | 说明 | 优先级 |
|---|---|---|
| 角色/派发政策文本 | `dispatch_{mode}_{role}.md`、`task_state_*.md` 语义 → 我方 `team-prompt` 的 `team:dispatch`/`team:task-state` 段 | P2 |
| leader 工作流叙事 | `leader_workflow*.md`（build_team vs swarmflow 指引） | P2 |
| 评审者人格 | `reviewer_{verifier,challenger,inspector}.md` → 我方 `team-review` reviewer 提示 | P2 |
| 完成/未读提示 | 源完成三条件措辞 → 我方完成判定提示 | P3 |
| phase/log 叙事 | SwarmFlow phase 叙事 → 若接 DSH workflow，映射 `workflow/*` 事件文案 | P3 |

### 2.2 【需代码】
| 项 | 说明 | 现状 | 优先级 |
|---|---|---|---|
| 计划闸 | `submit_plan`/`approve_plan`/`reject_plan` + durable 事件 | **已有**（P30） | ✅ |
| 验证闸 + 返工反馈 | `submit_review`/`vote`/`settle` + `revision-requested` | **已有** | ✅ |
| 解锁推送 | `swarm/task/unblocked` 由 `swarm/task/terminal` 驱动 | **已有**（P31） | ✅ |
| 排空/成员状态/终态事件 | `list-drained`/`status-changed`/`terminal` | **已有**（P31，bus-only） | ✅ |
| 派发归属 | scheduled 用 `assign`→`reassign`，owner 落成员 | **已有**（P42） | ✅ |
| **并行/分支原语** | `parallel`/`pipeline`/`map_parallel`/条件分支 | **缺失** | **P1**（建议**接 DSH `ctx.workflowEngine`**，见下） |
| **脚本编排（可恢复）** | run 级 Journal/WAL + resume | **缺失** | **P2**（DSH workflowEngine 自带 worker + 事件；是否要 resume 视需求） |
| **并发/预算闸** | per-Leader `max_workflows`/`agents_per_run`/`max_agents_total` | **缺失** | **P1**（在 `team-scheduler`/`team-compaction` 加可配上限；或复用 `ctx.jobs`） |
| 图引擎（PregelGraph） | BSP 超步 + 条件边 + barrier | **缺失** | **P2**（**不建议自造**；DSH 无对应 TS 引擎，若需条件分支优先用 DSH workflow 或任务 DAG 逼近） |
| 执行子状态 | `ExecutionStatus` | 缺失 | P3 |

> **【建议】并行/分支的正确落点 = DSH `ctx.workflowEngine`**（DSH 自带脚本引擎 + `agent()` 扇出 + `workflow/*` 事件），而非把 PregelGraph/SwarmFlow 从 Python 移植。若需「团队任务级」并行，可扩展 `team-scheduler` 的「一人一活跃任务」为可配并发上限后由 DAG 自然并行（成员间并行，非单成员内并行）。

### 2.3 【不可迁移 + 原因】
| 项 | 原因 |
|---|---|
| `PregelGraph`（`core/graph/graph.py:57`） | 通用 BSP 图引擎；DSH 已有独立 `ctx.workflowEngine`，移植 Python Pregel 到 TS 属重复造轮子 |
| SwarmFlow 脚本引擎（`workflow/engine/*`） | 同上；DSH workflow 引擎已存在 |
| `MemberStatus` 10 态 + `ExecutionStatus` 10 态（`status.py:38-271`） | DSH 花名册以 `provisioning/active/failed` + 派生 `running/idle/inactive` 为够用；引入 10 态属过度工程，且与原生不兼容 |
| fork/checkpoint 命名协调（`CHECKPOINT_CREATED`） | 源特有 fork 语义；DSH `ctx.subagents` fork 不同 |
| 可靠性探测器（`ANOMALY_DETECTED`/`EXTERNAL_RUNTIME_RETRYING`） | 源针对 CLI 成员的可靠性；非本次迁移范围 |
| `team_standby` / persistent 轮次模型 | DSH headless 无对应轮次模型 |
| 分布式多成员并发上限的**实现**（源在 leader 侧集中治理） | 我方单进程默认；跨进程治理见阶段 3（`team-distributed`），且需先有并发原语 |

---

## 3. 与 ADR-0002（已修正）及事件体系的关系

**【事实·ADR-0002（P52 更正）】** durable 落盘走**通道 A**：统一入口 `@elinpf/dsh-swarm-team-durable.emitDurable(session, name, payload)` → **`appendPluginRecord("plugin:swarm/…")`**（`@deepseek-ai/dsh-session` 落地 plugin record），`durableRecordOf(ev)` 供 replay fold。

**【建议】迁移新事件/新持久化时的硬约束**：
1. **凡是「状态」必须 durable**：新增的计划/验证/解锁/派发等**状态**事件，走**通道 A**（`emitDurable` → `appendPluginRecord`），并满足 ADR-0002 的 **`emit + fold + 恢复测试`** 三件套（`team-durable.foldDurableEvents`）。
2. **纯通知可 bus-only**：如 `swarm/task/unblocked`/`list-drained`/`member/status-changed`（P31 已定为 bus-only，`docs/adr/0002 §3`）。**不得**据 bus-only 事件重建状态（ADR-0002 表注）。
3. **新增事件必须同步 ADR-0002 §3 事件表**（P41 已恢复该表为唯一权威清单）。
4. **命名**：`swarm/<domain>/<action>`；若新增「并行/分支/run 生命周期」事件，建议域 `swarm/run/*` 或复用 DSH `workflow/*`（后者非我方命名域）。
5. **不引入第二套持久化**（ADR-0002 §2：不引入 `ctx.storage` forms）。

**【事实】** 现有迁移相关 durable 事件（已在 ADR-0002 §3）：`swarm/task/plan-request`、`plan-response`、`revision-requested`（durable）；`swarm/task/{released,revoked,terminal,unblocked,list-drained}`、`swarm/member/status-changed`（bus-only）。

---

## 4. 风险（对 P42 / P51 / 稳定性）

| # | 风险 | 说明 | 缓解【建议】 |
|---|---|---|---|
| R1 | **P42（派发归属）回归** | 若新增「并行/分支」派发路径绕过端口 `assign`（→ 原生 `reassign`），`owner` 可能又落回 `lead`（P42 已修，`experiments-retest-p24.md §1.3`） | 任何新派发必须经 `team-core.assign`；给「owner≠lead」加断言测试 |
| R2 | **P51（未读兜底）缺口** | P51 已由「复用原生事件」改为「自建 durable 未读台账（通道 A）」（`docs/durability-findings.md §3`）；若新增任务生命周期事件走 `ctx.emit`-only（非通道 A），会重现「未落盘→重启丢失→未读不闭合」 | 新事件一律走 `emitDurable`；扩 `team-durable` 恢复测试 |
| R3 | **状态空间膨胀 / 不稳定** | 引入 BLOCKED/CANCELLED/执行子态等会扩大状态空间，易与原生 4 态漂移 | **不引入**一等 BLOCKED；保持 CAS（`expectedRevision`）+ 守卫式非法跃迁校验（`team-core`）；`scan()` 保持幂等（`MAX_SCAN_PASSES` 有界） |
| R4 | **双引擎混淆** | 我方「任务 DAG 编排」与 DSH `ctx.workflowEngine`「脚本编排」是两套；若并行原语自造会与 DSH 冲突 | 明确定位：**团队协作编排 = 任务 DAG + scheduler**；**脚本/并行/分支 = DSH `ctx.workflowEngine`**，不重复实现 |
| R5 | **并发无闸 → 资源放大** | 无全局并发上限时，大团队/大 DAG 可能同时唤醒过多成员（成员数×轮次×LLM 调用） | 在 `team-scheduler`/`team-compaction` 加**可配**并发/预算上限（对齐源 `ConcurrencyLimits`）；默认保守 |
| R6 | **恢复覆盖不全** | ADR-0002 P52 注明 `team-bus` 待接、`team-skills.visibility` 仅进程内 | 迁移收尾时补齐通道 A 接线 + profile 级端到端验证 |
| R7 | **stale 时钟语义** | 我方 `staleSweep` 用调度器内存时钟（重启重置），源 scheduled 用 `updated_at`（也承认缺陷） | 若需跨重启 stale 判定，把「最后活动时间」落通道 A durable |

---

## 5. 附录：证据索引

**Jiuwen（权威源 `/opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen/`）**
- 任务/成员状态机：`agent_teams/schema/status.py`（`MemberStatus` `:38-47`、`MEMBER_TRANSITIONS` `:83-147`、`MEMBER_SETTLED/QUIESCENT` `:155-193`、`ExecutionStatus` `:196-271`、`TaskStatus` `:274-309`、`TASK_TRANSITIONS` `:318-351`、`TASK_REASSIGNABLE_STATUSES` `:369-375`、`is_valid_transition` `:378-395`）
- 任务事件：`agent_teams/schema/events.py`（`TASK_PLAN_REQUEST/RESPONSE` `:139-140,291-307`；verify 三事件 `:151-155,369-415`；`TASK_LIST_DRAINED` `:417-424`）
- 调度器：`agent_teams/agent/scheduling/scheduler.py`（`_scan`/`_reconcile_starts`/`_reconcile_reviews`/`_send_as_leader` `:197-287,622`）
- 事件总线/分发/处理器：`agent_teams/agent/coordination/{event_bus.py,dispatcher.py,kernel.py,handlers/stale_task.py}`（`event_bus.py:6-12,239,270`；`dispatcher.py:188-195`；`kernel.py:590-611`；`stale_task.py:58,71,99,147,201,232,269`）
- 图引擎：`core/graph/graph.py`（`PregelGraph` `:57`、条件边 `:122`、`branches` `:64`、`branch_targets` `:65`、`register_branch_targets` `:134`、`wait_for_all` `:86`、`_resolve_barrier_groups` `:180`）
- SwarmFlow：`agent_teams/workflow/engine/primitives.py`（`agent()` `:511+`、`verify()` `:882`、`parallel` `:1399`、`pipeline` `:1448`、`map_parallel` `:1488`、`phase` `:1506`、`log` `:1513`、`workflow` `:1549`、`human_session` `:1329`）；`engine/verify.py:1-70`；`engine/runner.py:26,138,294,326-331`；`workflow/concurrency.py:19-25`；`workflow/review.py:1-60`

**我们（`dsh-swarm/packages/*`）**
- `team-core/src/index.ts`（action 白名单 `:355-366`；计划闸 `:400-445`；评审闸 `:456-505`；CAS `:390-395`；overlay 状态 `:742-744`；恢复 fold `:653-670`）
- `team-core-contract/src/index.ts:53`（`TaskView.status`）
- `team-scheduler/src/index.ts`（`SchedulerMode`/`pollMs` `:70-73`；`scan` `:176-215`；解锁推送 `:228-252`；成员状态 `:262-275`；排空 `:279-289`；autonomous/scheduled 分支 `:356-378`；stale `:388+`）
- `team-completion/src/index.ts`（`evaluate` 三条件 `:98-142`；未读 `:74-91,145-155`）
- `team-durable/src/index.ts`（`emitDurable`/`appendPluginRecord`/`foldDurableEvents`）
- `docs/adr/0002-durable-state-convention.md`（P52 更正 `:6-12`；§3 事件表）
- `docs/durability-findings.md §3`（P51 改自建 durable 未读台账）；`docs/experiments-retest-p24.md §1.3`（P42 归属）；`docs/final-acceptance.md`（P31/P33/P42/P51 状态）

## 6. 【事实】/【推断】/【建议】分界

- **【事实】**：§1 全部带 `文件:行号` 的对照、§3 的 ADR-0002 引用、§4 的 P42/P51 引文、§5 索引。
- **【推断】**：§1.5「DSH `ctx.workflowEngine` 可承载并行/分支」的可行性（未实测其在 team 场景的接入）、§4 各风险的发生概率。
- **【建议】**：§2 checklist 的处置与优先级、§1.1「不引入一等 BLOCKED」、§3 的硬约束、§4 缓解措施。

---

*（本文件由 migration-architect 产出；只读调研 + 新写文档，未改任何代码；Jiuwen/我方引用均按当前源码行号核实。）*
