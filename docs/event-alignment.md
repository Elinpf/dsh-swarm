# 事件体系对齐审计：我方 `swarm/*` × 源系统 `TeamEvent`

> 产出人：migration-architect ｜ 任务：P28-event-alignment
> 目标：对齐我方**自造事件体系**与源系统（JiuwenSwarm）**任务生命周期事件模型**，找出「源有、我无」的事件，并判定哪些缺失造成**真实协同能力缺失**。
> 只在只读审计，**不改任何代码**。
> 约定：
> - `【事实】`：读到源码/文档，附证据（源侧 `文件:行号`；我方侧 `包:文件:行号`）。
> - `【推断】`：基于结构的判断，未逐行验证。
> - `【建议】`：本审计的处置建议。
> 权威源：
> - 源事件：`/opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen/agent_teams/schema/events.py`（下称 `events.py`）
> - 源处理器订阅：团队调研 `cluster-architecture.md` §2.4（`handlers/*` 的 `EVENT_METHOD_MAP`）
> - 我方持久化约定：`dsh-swarm/docs/adr/0002-durable-state-convention.md`（ADR-0002）
> - 我方源码：`dsh-swarm/packages/*/src/*`（本次 grep 实测）

---

## 0. 结论速览（TL;DR）

**【事实】两套事件在「任务状态**存储**」上其实同源**：我方任务/成员/信箱的**状态**由 DSH 原生 `ctx.agentTeams` 的 durable 事件 `team/task`、`team/member`、`team/message/{queued,delivered}`（version 2）承载【事实·agent-team-spike §3】，我方 `swarm/*` 只承载**原生没覆盖的补充态**（评审、技能、记忆、完成、传输、分布式、人类）【事实·ADR-0002 §3 + 本次 grep】。

**【事实】我方**没有**任何 `TASK_*`/`MEMBER_*` 命名的生命周期事件**；事件命名域为 `swarm/{core,review,bus,skills,memory,completion,transport,distributed,human}`【事实·grep `packages/*/src`】。

**★ 关键发现（造成真实能力缺失的三项）**：
1. **计划闸完全缺失**：源有 `TASK_PLAN_REQUEST`/`TASK_PLAN_RESPONSE`（执行前审批门），我方只有**执行后**验证闸（`swarm/review/*`）——**没有执行前的计划审批能力**。
2. **返工无反馈与定向事件**：源 `TASK_REVISION_REQUESTED` 携带 `feedback` 并把作者「steer 回」返工；我方只有 `swarm/review/settled{verdict:'fail'}` + `swarm/core/review-left{outcome:'reopened'}`，**不含 reviewer 反馈字段**，也无专门事件。
3. **依赖解锁无推送**：源 `TASK_UNBLOCKED` 在上游终态时**主动广播**并 nudge 空闲成员；我方只靠**轮询**（`team-scheduler` 的 `pollMs`）重算 readiness——**解锁到唤醒存在延迟、且依赖调度器存活**。

**次要缺失（行为已有、但缺可观测/定向事件）**：`TASK_RELEASED`、`TASK_REVOKED`、`TASK_LIST_DRAINED`、`MemberStatusChangedEvent`。

**不应照搬**：`WORKFLOW_PROGRESS`/`WORKFLOW_HUMAN_REPLY`（swarmflow 特有；DSH 有 `ctx.workflowEngine`）、`ANOMALY_DETECTED`/`EXTERNAL_RUNTIME_RETRYING`（源可靠性，针对 CLI 成员）、`CHECKPOINT_CREATED`（fork 命名协调）、`TEAM_STANDBY`（persistent 队轮次空闲；DSH headless 无此模型）、`WORKSPACE_LOCK_REQUEST/RESPONSE`（源跨进程 leader 中介锁；我方为本地 fs-guard）。

---

## 1. 源系统全量事件清单（`events.py`）

**【事实】** `TeamEvent` 常量共 **41 个事件**（`events.py:107-170`），每个都有对应 `BaseEventMessage` 子类（`:185-597`）与类型映射（`:600-641`）。「谁发/谁订阅/干什么」综合 `events.py` docstring 与 `cluster-architecture.md` §2.4。

### 1.1 团队生命周期（`events.py:107-111`）
| 事件 | 谁发 | 谁订阅 | 干什么 |
|---|---|---|---|
| `team_created` (`:108`) | leader 建队 | 全体（TEAM topic） | 通告新队（`TeamCreatedEvent` `:185`） |
| `team_cleaned` (`:109`) | leader 清理 | AgentLifecycleHandler | 团队清理收尾 |
| `team_standby` (`:110`) | persistent 队回合末 | AgentLifecycleHandler | 队进入 standby（暂停轮询） |
| `team_completed` (`:111`) | leader 完成判定 | TeamCompletionHandler | 三条件满足宣告完成（`TeamCompletedEvent` `:202`，条件见 docstring） |

### 1.2 成员生命周期（`events.py:114-119`）
| 事件 | 谁发 | 谁订阅 | 干什么 |
|---|---|---|---|
| `member_spawned` (`:114`) | spawn 漏斗 | MemberHandler / leader 观察 | 成员拉起通告（`:215`） |
| `member_restarted` (`:115`) | recover 路径 | MemberHandler | 进程重启（`:219`，带 reason/restart_count） |
| `member_status_changed` (`:116`) | 成员状态写入 | MemberHandler/leader | 状态迁移（`:225`，old/new） |
| `member_execution_changed` (`:117`) | 执行状态写入 | MemberHandler | 执行子状态（`:231`） |
| `member_shutdown` (`:118`) | 显式离队 | MessageHandler（drain） | 关闭（`:237`，force） |
| `member_canceled` (`:119`) | 取消 | MessageHandler | 取消（`:242`） |

### 1.3 协作 / 可靠性（`events.py:122-131`）
| 事件 | 谁发 | 谁订阅 | 干什么 |
|---|---|---|---|
| `plan_approval` (`:122`) | leader | AgentLifecycleHandler | 计划审批结果（`:246`，approved） |
| `tool_approval_result` (`:123`) | leader | AgentLifecycleHandler | 工具调用审批（`:251`） |
| `checkpoint_created` (`:125`) | 成员存档 | CheckpointHandler | fork 命名协调（`:259`） |
| `anomaly_detected` (`:128`) | 可靠性探测 | ReliabilityHandler | 异常上报（`:557`） |
| `external_runtime_retrying` (`:131`) | 外部 CLI 运行时 | ExternalRuntimeHandler | CLI 自动重试进度（`:574`） |

### 1.4 消息（`events.py:134-135`）
| 事件 | 语义 |
|---|---|
| `message` (`:134`) | 点对点消息已落库（`MessageEvent` `:272`，含 message_id/from/to） |
| `broadcast` (`:135`) | 广播已落库（`BroadcastEvent` `:279`） |

### 1.5 任务生命周期（`events.py:138-155`）★
| 事件 | 谁发 | 谁订阅 | 干什么 | schema |
|---|---|---|---|---|
| `task_created` (`:138`) | 任意成员建任务 | TaskBoardHandler | 新任务；唤醒空闲成员认领 | `:285` |
| `task_plan_request` (`:139`) | 成员提交计划 | TaskBoardHandler/AgentLifecycleHandler | **计划闸**：请求审批 | `:291`（plan_id/plan_md/tool_call_id） |
| `task_plan_response` (`:140`) | leader | AgentLifecycleHandler | 计划审批结果（approved/feedback） | `:300` |
| `task_updated` (`:141`) | 任意更新 | TaskBoardHandler | 任务字段变更 | `:310` |
| `task_claimed` (`:142`) | 成员认领 | TaskBoardHandler | 认领（所有权） | `:315` |
| `task_started` (`:143`) | scheduler 派发 | TaskBoardHandler | **scheduled 模式**下开始执行（区别于 claim） | `:320`（docstring 明示差异） |
| `task_completed` (`:144`) | 成员完成 | TaskBoardHandler | 完成 | `:330` |
| `task_cancelled` (`:145`) | 取消 | TaskBoardHandler | 取消 | `:335` |
| `task_unblocked` (`:146`) | 上游终态刷新 | TaskBoardHandler | **解锁下游 + nudge 空闲成员** | `:340` |
| `task_released` (`:147`) | `reset` | TaskBoardHandler | 认领释放、任务回池、nudge | `:345`（docstring 明示） |
| `task_revoked` (`:148`) | `reassign` | 目标成员 dispatcher | **定向**告知**原**assignee 离开该活 | `:356`（docstring 明示） |
| `task_submitted_for_review` (`:151`) | `complete`（带 reviewer） | TaskBoardHandler | 进 IN_REVIEW、通知 reviewer | `:369`（reviewer 列表） |
| `task_verified` (`:152`) | reviewer 通过 | TaskBoardHandler | IN_REVIEW→COMPLETED + 解锁下游 | `:380` |
| `task_revision_requested` (`:153`) | reviewer 失败 | 作者 dispatcher | IN_REVIEW→IN_PROGRESS **返工**，**带 feedback** | `:389` |
| `task_review_vote` (`:155`) | reviewer 投票（scheduled） | scheduler | 记录选票（含计数快照） | `:399` |
| `task_list_drained` (`:149`) | 全任务终态 | TeamCompletionHandler | **全员无活**相位切换 | `:417` |

### 1.6 工作流 / 工作树 / 工作区（`events.py:157-170`）
| 事件 | 语义 |
|---|---|
| `workflow_progress` (`:158`) | swarmflow 进度（leader 旁观叙事，`:427`） |
| `workflow_human_reply` (`:160`) | 真人对 swarmflow human 轮次的回复 |
| `worktree_created` (`:163`) / `worktree_removed` (`:164`) | worktree 建/删（`:517`/`:524`） |
| `workspace_artifact_updated` (`:167`)、`workspace_conflict` (`:168`)、`workspace_lock_request` (`:169`)、`workspace_lock_response` (`:170`) | 工作区产物/冲突/锁（`:530-554`） |

---

## 2. 我方全量事件清单（grep 实测）

### 2.1 我方**发射**的 durable 事件（`swarm/*`，ADR-0002 命名）
| 事件 | 包 | 证据 | 语义 |
|---|---|---|---|
| `swarm/core/review-entered` / `review-left` | team-core | `team-core/src/index.ts:321,332,345,391,394` | 任务进/出评审态（outcome: completed/reopened/deleted） |
| `swarm/review/submitted` / `vote` / `settled` / `round` | team-review | `team-review/src/index.ts:126,143,153,179` | 提交评审/投票/裁决/轮次 |
| `swarm/bus/broadcast` | team-bus | `team-bus/src/index.ts:130,205,249` | 广播快照（含 topic/targets/text） |
| `swarm/skills/visibility` / `grant` | team-skills | `team-skills/src/index.ts:105,109,140,157` | 可见性声明/授权 |
| `swarm/memory/shared` / `private` | team-memory | `team-memory/src/index.ts:79,89,104,110` | 共享/私有记忆 |
| `swarm/completion/unread` | team-completion | `team-completion/src/index.ts:121` | 未读计数（+1/-1） |
| `swarm/team/completed` | team-completion | `team-completion/src/index.ts:158` | 团队完成（上升沿） |
| `swarm/transport/peer` | team-transport | `team-transport/src/index.ts:729` | peer 状态迁移 |
| `swarm/distributed/role` / `split-brain` | team-distributed | `team-distributed/src/index.ts:165,177,185` | 角色/脑裂 |
| `swarm/human/seat` / `inbound` / `delivered` | team-human | `team-human/src/index.ts:138,196,228` | 人类席位/入站/送达 |

**无 durable 事件的包**：`team-scheduler`（幂等扫描，无自有状态）、`team-prompt`（只注册 section/context）、`team-workspace`（`grep 'swarm/' team-workspace/src/index.ts` → 空；只订阅 `fs/write-intent`/`fs/edit-intent`，`team-workspace/src/index.ts:115-116`）。

### 2.2 我方**订阅/消费**的事件
| 事件 | 消费包 | 证据 |
|---|---|---|
| `session/event`（DSH durable 会话事件通道） | team-bus, team-core, team-completion, team-memory, team-prompt, team-skills | `team-core/src/index.ts:167`、`team-completion/src/index.ts:66`、`team-prompt/src/index.ts:104` 等 |
| `team/member`（原生，v2） | team-prompt | `team-prompt/src/index.ts:106` |
| `team/message/queued` / `delivered`（原生，v2） | team-completion | `team-completion/src/index.ts:68,71` |
| `system-prompt/assemble`（DSH waterfall） | team-prompt | `team-prompt/src/index.ts:123-124` |
| `fs/write-intent` / `fs/edit-intent`（DSH waterfall） | team-workspace | `team-workspace/src/index.ts:115-116` |

**【事实】关键缺口**：我方**没有任何包发射 `TASK_*`/`MEMBER_*` 事件**，也**不订阅**原生任务生命周期事件（只订阅了 `team/member`/`team/message/*`）；任务状态**存储**依赖原生 `team/task` durable 快照（由 DSH `agent-team` 写），但我方**没有人监听它做事件驱动反应**——反应靠 `team-scheduler` 轮询 + 显式调用。

---

## 3. 逐项映射表（源 → 我方）

> 四类：**等价** / **缺失但行为已用别的机制实现** / **缺失且造成真实协同能力缺失（★）** / **不应照搬**。

| # | 源事件 | 我方现状 | 分类 | 说明 |
|---|---|---|---|---|
| 1 | `message` / `broadcast` | 原生 `team/message/{queued,delivered}` + `swarm/bus/broadcast` + `ctx.teamCore.send` | **等价** | 落库 + 唤醒语义一致（native mailbox + bus 广播） |
| 2 | `task_created` | 原生 `team/task` 快照 | **等价** | 状态等价；但**无事件驱动 nudge**（见 #9） |
| 3 | `task_claimed` | `team/task` 快照 + `team-core` action `claim` | **等价** | 状态等价 |
| 4 | `task_started`（scheduled 派发） | `team-scheduler` CAS claim → in_progress | **缺失但行为已实现** | 行为在（scheduler `_reconcile_starts`），无独立事件 |
| 5 | `task_completed` | `team/task` 快照 + action `complete` | **等价** | |
| 6 | `task_updated` | `team/task` 快照 | **等价** | revision CAS |
| 7 | `task_cancelled` | action `delete` / `cancel` | **等价** | 状态等价 |
| 8 | `task_submitted_for_review` | `swarm/review/submitted` + `swarm/core/review-entered` | **等价** | 语义一致 |
| 9 | `task_unblocked` | **仅轮询重算 readiness**（`team-scheduler.scan`） | **★ 缺失且造成能力缺失** | 源「上游终态→主动广播→nudge 空闲成员」；我方**无推送**，靠 30s poll（`team-scheduler/src/index.ts` `pollMs`），延迟且依赖调度器存活 |
| 10 | `task_verified` | `swarm/review/settled{pass}` + `swarm/core/review-left{completed}` | **等价** | 语义一致 |
| 11 | `task_revision_requested`（带 feedback） | `swarm/review/settled{fail}` + `swarm/core/review-left{reopened}` | **★ 缺失且造成能力缺失** | 我方**无 feedback 字段**（`grep -i feedback */src` → 空），也无「steer 作者返工」的定向事件；返工质量控制弱化 |
| 12 | `task_review_vote` | `swarm/review/vote` | **等价** | 一致 |
| 13 | `task_released` | action `release`（`team-core`） | **缺失但行为已实现** | 行为在，但**无「回池→nudge 空闲成员」事件** |
| 14 | `task_revoked` | action `assign`（reassign） | **★ 缺失且造成能力缺失** | 源**定向**告知原 assignee 停手；我方无定向事件 → 原成员可能继续做「已不属于自己」的活 |
| 15 | `task_list_drained` | **无** | **缺失但行为部分实现** | 我方用 `swarm/team/completed`（三条件）替代「相位切换」；但 drained 是更轻的「全任务终态」信号（源用它做 leader 轮次收敛） |
| 16 | `plan_approval` + `task_plan_request` + `task_plan_response` | **无** | **★ 缺失且造成能力缺失** | 源**执行前**计划闸（PLAN_MODE→submit_plan→approve）；我方**只有执行后**验证闸（review）——**没有计划审批能力** |
| 17 | `member_spawned` | 原生 `team/member` 快照 | **等价** | |
| 18 | `member_status_changed` | 原生 `team/member` 快照 + 派生 status；`ctx.teamCore.waitForChange` | **缺失但行为已实现** | 状态可查、可等待；但**无变更事件**驱动（completion/观测靠轮询） |
| 19 | `member_execution_changed` | 原生仅 `running/idle/inactive`（无 execution 子状态） | **缺失但行为已实现**（弱） | DSH 无 execution 子状态（阶段 0/1 已记录） |
| 20 | `member_restarted/shutdown/canceled` | `ctx.subagents` 生命周期 + `interrupt` | **等价（DSH 原生）** | DSH 自有生命周期语义 |
| 21 | `tool_approval_result` | DSH `ctx.approval` seam | **等价（DSH 原生）** | 不进我方事件域；DSH 已覆盖 |
| 22 | `team_created` / `cleaned` | 隐式根（`TeamId=root SessionId`） | **部分等价** | DSH 无显式建队事件（隐式）；我方无 team lifecycle 事件 |
| 23 | `team_completed` | `swarm/team/completed` | **等价** | 三条件一致（native 完成判定 + 我方事件） |
| 24 | `team_standby` | **无** | **不应照搬** | persistent 队轮次空闲模型；DSH headless 无对应轮次 |
| 25 | `workflow_progress` / `workflow_human_reply` | DSH `ctx.workflowEngine` + `workflow/*` 原生事件 | **不应照搬** | swarmflow 特有；DSH 有独立工作流面 |
| 26 | `anomaly_detected` / `external_runtime_retrying` | DSH 自身 error recovery | **不应照搬** | 源可靠性针对 CLI 成员；非本次迁移范围 |
| 27 | `checkpoint_created` | DSH `ctx.subagents` fork | **不应照搬** | fork 命名协调为源特有；DSH fork 语义不同 |
| 28 | `worktree_created/removed` | team-workspace（复用 `ctx.worktrees`） | **缺失但行为已实现** | 行为在（`ctx.worktrees.create`），**我方不发可观测事件**（`team-workspace` 无 `swarm/*`） |
| 29 | `workspace_artifact_updated` / `conflict` | 无 | **不应照搬** | 源用 git 版本化工作区；DSH 无此工作区模型 |
| 30 | `workspace_lock_request/response` | team-workspace 本地 fs-guard | **部分等价** | 我方锁是**本地** `fs/write-intent` 守卫（`team-workspace/src/index.ts:115`）；源的跨进程 leader 中介锁（`events.py:542/550`）在单进程下不需要；跨进程锁见阶段 3（team-transport/distributed） |

---

## 4. 重点疑点逐个核实

> 全部基于本次源码/grep 实测。

| 疑点 | 结论 | 证据 |
|---|---|---|
| **计划闸** `TASK_PLAN_REQUEST`/`TASK_PLAN_RESPONSE` | ❌ **我方没有**（只有执行后验证闸） | 源 `events.py:139-140,291-307`；我方 `grep -i plan packages/*/src` → **空**；`team-review` 只做 `submit_review`（`team-review/src/index.ts:118-130`） |
| **返工** `TASK_REVISION_REQUESTED` | ⚠️ **部分**：有 reject 的事实（`settled{fail}` + `review-left{reopened}`），但**无 feedback 字段、无定向事件** | 源 `events.py:389`（含 feedback）；我方 `grep -i feedback packages/*/src` → **空**；`team-core/src/index.ts:322-345`（reject_review→reopened） |
| **任务释放/撤回** `TASK_RELEASED`/`TASK_REVOKED` | ⚠️ **行为在、事件无**：`release`/`assign` 动作存在，但无「回池 nudge」/「定向通知原 owner」 | 源 `events.py:345,356`；我方 `team-core-contract/src/index.ts:113`（action `release`）、`team-core/src/index.ts` updateTask |
| **看板排空** `TASK_LIST_DRAINED` | ❌ **无**（替换为 `swarm/team/completed` 三条件） | 源 `events.py:417`；我方 `team-completion/src/index.ts:158`（completed） |
| **成员状态变更** `MemberStatusChangedEvent` | ⚠️ **状态可查、事件无** | 源 `events.py:225`；我方只消费 `team/member`（team-prompt）与 `waitForChange` |
| **任务解锁** `TASK_UNBLOCKED` | ❌ **无推送**（靠轮询重算 readiness） | 源 `events.py:340`；我方 `team-scheduler/src/index.ts`（scan + pollMs，`_reconcile_starts`） |

---

## 5. 命名 / 语义对齐建议

**【事实·ADR-0002 §3】** durable 事件命名 `swarm/<domain>/<action>` 是我方**持久化约定**，可自命名；`domain ∈ {core, review, bus, skills, memory, completion}`。

**【建议】**（区分「应保留 / 应新增 / 不建议改」）：
- **应保留**：现有 `swarm/*` 名（ADR-0002 已冻结）；`swarm/team/completed` 与源 `TEAM_COMPLETED` 意图一致，保留。
- **应新增（按源语义命名，便于迁移可读性）**——补充缺失能力时用**贴近源语义**的名字（而非新造）：
  - `swarm/task/plan-request` / `swarm/task/plan-response`（计划闸）
  - `swarm/task/revision-requested`（**带 `feedback`**，返工）
  - `swarm/task/unblocked`（解锁推送）
  - `swarm/task/released` / `swarm/task/revoked`（回池/定向撤回）
  - `swarm/task/list-drained`（看板排空）
  - `swarm/member/status-changed`（成员状态）
- **应新增（吸收到现有域）**：`swarm/core/*` 已有 review 事件；**不建议**为计划闸另开域，建议归 `swarm/core/*` 或新 `swarm/plan/*`（二选一，见 §6）。
- **不建议改**：**不要**把 `swarm/*` 整体重命名为 `TASK_*`/`MEMBER_*`（破坏 ADR-0002 冻结契约、且中划线大小写风格不同）；一致性靠**映射文档**而非改名。
- **文档动作**：在 `docs/` 增一页「源↔我方事件映射表」（本文件 §3 可作种子），供迁移读者对照。

---

## 6. 差异表 + 优先修复建议

> 排序口径：**是否造成真实能力缺失 × 修复成本**。本审计**只出建议，不写实现**。

| 优先级 | 缺口 | 类型 | 造成的具体后果 | 修复成本 | 建议 |
|---|---|---|---|---|---|
| **P0** | **计划闸**（`plan-request`/`plan-response`） | ★能力缺失 | 无法「先报计划、批准后执行」；长/贵任务缺少执行前门禁，PLAN_MODE 语义无着落 | **中**（新增 plan 子态 + 2 事件 + leader 审批工具） | 新增 `swarm/task/plan-request|response`（或 `swarm/plan/*`）；`team-review` 旁建 `team-plan` 或并入 `team-core` review 态（二选一，建议**并入 team-core**，与 review 态对称） |
| **P0** | **返工反馈**（`revision-requested` 带 feedback） | ★能力缺失 | 返工无 reviewer guidance；作者只知 fail 不知改哪 → 返工质量/轮次恶化 | **低**（`settled{verdict}` 增 `feedback` 字段 + reject 时把 feedback 投给作者） | 扩展 `swarm/review/settled` payload 加 `feedback?`；reject 时经 `ctx.teamCore.send` 定向投作者 |
| **P1** | **解锁推送**（`task/unblocked`） | ★能力缺失 | 上游完成后下游解锁到唤醒存在 poll 延迟（`pollMs`），且依赖调度器存活 | **中**（订阅原生 `team/task`，上游终态时重算 newly-ready → nudge） | `team-scheduler` 增订阅：某任务转 completed → 重算 `ready` 且 owner 空闲 → 立即 nudge；事件 `swarm/task/unblocked` |
| **P2** | **撤回定向通知**（`task/revoked`） | ★能力缺失（reassign 场景） | reassign 后原 owner 可能继续做「已不属于自己」的活 | **低**（reassign 时定向 `send` 原 owner + 事件） | `team-core` reassign 分支加定向通知 + `swarm/task/revoked` |
| **P2** | **释放回池通知**（`task/released`） | 行为已有 | release 后空闲成员不被立即 nudge（靠 poll） | **低** | `team-core` release 分支 emit `swarm/task/released` + nudge |
| **P3** | **成员状态变更事件**（`member/status-changed`） | 行为已有 | completion/观测靠轮询，成员迁移可观测性弱 | **低** | 订阅原生 `team/member` 变化 → emit `swarm/member/status-changed`（可选） |
| **P3** | **看板排空**（`task/list-drained`） | 行为部分替代 | leader 轮次收敛依赖较重的完成判定 | **低** | 可选项；若需要「全任务终态」轻信号，补 emit |
| **—** | **命名映射文档** | 可读性 | 两套命名无对照，迁移读者困惑 | **极低** | 落 `docs/` 一页映射表（本文件 §3） |

**总结**：**必须补** 计划闸 + 返工反馈（P0）；**强烈建议补** 解锁推送（P1）；其余（P2/P3）为完整性/可观测性补强。**不应**为对齐而照搬 24/25/26/27/29 等源特有事件。

---

## 7. 附录：证据索引

- 源事件：`openjiuwen/agent_teams/schema/events.py`（`TeamEvent` `:107-170`；schema `:185-597`；类型映射 `:600-641`；`EventMessage` `:648-695`）
- 源处理器订阅：团队调研 `cluster-architecture.md` §2.4（`handlers/*` 映射表，`:180-193`）
- 我方持久化约定：`docs/adr/0002-durable-state-convention.md` §3（事件清单冻结）
- 我方事件（本次 grep）：`packages/{team-core,team-review,team-bus,team-skills,team-memory,team-completion,team-transport,team-distributed,team-human,team-prompt,team-workspace,team-scheduler}/src/index.ts`
- 原生事件：`docs/agent-team-spike.md` §3（`team/member`/`team/task`/`team/message/*`，version 2）
- 完成判定三条件：源 `events.py:202-212`；我方 `team-completion/src/index.ts`

## 8. 【事实】/【推断】/【建议】分界

- **【事实】**：§1、§2、§3 各「证据」栏、§4 全部结论、§5 的 ADR-0002 引用。
- **【推断】**：§0「依赖轮询的后果」的量化说法、§6「修复成本」评级（相对）。
- **【建议】**：§5 命名建议、§6 优先修复清单。

---

*（本文件由 migration-architect 产出；两侧事件均为源码/grep 实测，只读审计，未改任何代码。）*
