# DSH Team 模式工作方式调查报告

> **调查对象**：DeepSeek Harness（DSH）的 Agent Teams（“team 模式”）。
> **证据基线**：上游 checkout `.runtime/deepseek-harness`（对应发布版 `@deepseek-ai/dsh@0.2.1-rc.3`）+ 本工作区产品层 `dsh-swarm`。
> **分节证据**：`docs/investigation/dsh-team-mode/{01-core-model,02-tools-and-messaging,03-ui-wiring-and-docs,04-verification}.md`。
> **验证结论**：独立验证闸 verdict = **PASS-WITH-CORRECTIONS**；抽样 39 条断言（31 VERIFIED / 4 WRONG / 3 CITATION-MISMATCH / 1 UNSUPPORTED），7 处更正 + 1 处来源标注已全部应用到分节文件与本报告。
> 引用约定：`[H]` = 上游 checkout 根目录；`[S]` = 本工作区根目录。行号均为文件内行号。

---

## 0. 调查小组与分工

本次调查本身由 5 名成员（1 Lead + 4 teammate）按 team 模式执行，任务板 `task-1..task-5`：

| 成员 | 任务 | 产出 | 写域 |
|---|---|---|---|
| `lead` | task-5 终稿合并 + 终检 | 本报告 | `docs/dsh-team-mode-investigation.md` |
| `arch-core` | task-1 核心模型（roster/lifecycle/task board） | `01-core-model.md` | `docs/investigation/01-core-model.md` |
| `bus-messaging` | task-2 工具面 + 消息投递 + 事件日志 | `02-tools-and-messaging.md` | `docs/investigation/02-tools-and-messaging.md` |
| `ui-wiring` | task-3 UI 投影 + 启用接线 + 文档核验 | `03-ui-wiring-and-docs.md` | `docs/investigation/03-ui-wiring-and-docs.md` |
| `verifier` | task-4 独立验证（blocked_by 1/2/3） | `04-verification.md` | `docs/investigation/dsh-team-mode/04-verification.md` |

---

## 1. 一页速览（TL;DR）

1. **Team 不是一个被创建的对象**：`TeamId` 就是根 Session 的 `SessionId`（brand 而已），没有“创建团队”事件；Lead 是隐式的，名字固定为 `lead`。
2. **成员是 continuable 子 Session**，有独立 SessionId 与独立日志；durable 生命周期只有 `provisioning → active | failed` 三种 phase，**`inactive` 不是持久态**，而是由 live Agent 的 `status` 实时派生。
3. **任务板**：`pending | in_progress | completed | deleted`，任意成员可创建任务；`claim` 不需要角色，任何成员都能抢“pending 且 ready 且无主”的任务；一旦有主，只有 owner 或 Lead 能改。
4. **revision + CAS**：每次写入追加完整快照并 `revision+1`；`team_task_update` 必须带 `expected_revision`；同进程内由 `TeamJournal.transact` 按 Lead id 串行化，跨进程不保证。
5. **依赖门禁只有一种语义**：`ready = 自身 pending 且所有 blockedBy 都 completed`。图校验只保证“blocker 存在且非 deleted、无重复、无环”，**不产出拓扑序，也不保证可完成**。
6. **`write_scopes` 是建议，不是锁**：只做路径规范化、去重与重叠告警，源码明确 “without treating it as a lock”。
7. **持久化的只有两件事**：`team/member` 与 `team/task`（整快照事件）写进 **Lead Session 日志**，再由 `agentTeam` 投影（`stateVersion: 4`）重放；`team/message/queued|delivered` 是已废弃的历史 mailbox 类型。
8. **发消息不经过 Team 队列**：目标是 Lead → `root.steer`；目标是队友 → `steerHostSubagentPrompt`。运行中的目标在**自己的下一个 step 边界**收到，不打断当前 step；inactive 的目标会被 cold-resume 唤醒。
9. **`send_message` 的“成功”只代表 inbox 已受理**：源码注释写明 “no Team retry or deduplication”，发送路径不 flush 目标 Session，接收方要到下一个 step 才真正看到。
10. **`wait_agent` 是边沿触发的一次性等待**：没有任何 peer 处于 `running/provisioning` 时立即返回 `noProgress`（不注册 waiter）；被唤醒的粒度是**整个 Team**（任一 Team 事件提交、任一成员状态迁移、任一成功 send）。
11. **工具面是组合出来的**：上游只注册 9 个工具（`spawn_teammate`/`send_message`/`list_agents`/`wait_agent`/`interrupt_agent`/`team_task_{create,list,get,update}`）；`broadcast`/`multicast`/`team_summary`/`review_*` 等来自本工作区产品层 `[S] packages/tool-swarm`。
12. **启用 = 一个 opt-in bundle**：`@deepseek-ai/dsh-experimental-agent-team-profile`，默认关闭，装上它会**禁用 4 个 legacy 直属 subagent 委派工具**；Web 面板是上游原生能力，dsh-swarm 没有自己的 UI。

---

## 2. 调查方法与验证强度

- **只认源码**：三节分节报告的所有结构性断言都带 `path:line`；模型侧工具描述只用来做“描述 vs 实现”的对照，不作为证据。
- **两个代码根分开标注**：`[H]` 上游 harness（实验包）与 `[S]` 本工作区产品层插件，避免把产品层行为误记为上游行为。
- **独立验证闸**：`verifier` 在**未读分节报告前**先独立通读源码，再抽样 39 条断言逐条打开被引行核对，判定 VERIFIED / WRONG / UNSUPPORTED / CITATION-MISMATCH。
- **测试未执行**：工作区 `node_modules` 缺 `vite-tsconfig-paths`（harness `vitest.config.ts:3` 依赖它），harness 单测跑不起来；分节中所有“测试断言”均为**读测试源码**所得，已逐处注明。
- **未做运行时 UI 复验**：没有启动 http://127.0.0.1:3099 做浏览器验证，UI 行为是源码级结论（标 UNVERIFIED）。

---

## 3. 架构总览

```
            模型可见工具（随装配变化）
 spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent
 team_task_{create,list,get,update}          ← [H] tool-agent-team（9 个）
 broadcast / multicast / review_* / team_summary / workspace_* / skills_* / memory_*  ← [S] tool-swarm（叠加层）
        │
        ▼
┌──────────────────── Lead Session ＝ Team 本体（TeamId = 根 SessionId）────────────────────┐
│  TeamService  ctx.agentTeams                        [H] agent-team/src/index.ts:56-109   │
│   ├─ TeamRoster          身份判定 / spawn / interrupt / 启动恢复   roster.ts             │
│   ├─ TeamTaskBoard       任务 CRUD + CAS + 依赖图校验              task-board.ts         │
│   ├─ TeamJournal         按 Lead 串行事务：append → flush → onCommit  journal.ts         │
│   ├─ TeamActivity        一次性内存 waiter（wait_agent 的实现）      activity.ts          │
│   └─ TeamRuntimeLifecycle 操作结算 / 卸载                            lifecycle.ts         │
└───────────────┬─────────────────────────────────────────────────────────────────────────┘
                │ session.append（整快照事件，version:2）
                ▼
     Lead Session 日志 ──重放──▶ agentTeam 投影（stateVersion 4，wire.view）──snapshot 通道──▶ Web GUI 面板
                │
                ▼
     队友 = continuable 子 Session（独立 SessionId、独立日志、独立 inbox）
     投递：root.steer / steerHostSubagentPrompt → next-step inbox → step 边界一次性取走
```

---

## 4. 实体与生命周期

### 4.1 三层成员表示（不要混用）

| 层 | 类型 | 位置 | 要点 |
|---|---|---|---|
| durable | `TeamMemberSnapshot` | `[H] agent-team/src/types.ts:48-56` | `id/name/description/provider/context/phase`，`phase ∈ {provisioning, active, failed}`（`:45`） |
| runtime view | `TeamMemberView` | `[H] agent-team/src/types.ts:59-69` | 增加 `role: lead\|teammate`、`status: running\|inactive\|provisioning\|failed`、`model`、`diagnostics` |
| wire | `TeamMemberProjection` | `[H] agent-team/src/types.ts:101-108` | 只带 `phase`；注释明确 Lead 行恒为 `active`，turn 活动来自 Session status |

### 4.2 状态机

- 合法 durable 转移**只有** `provisioning → active` 与 `provisioning → failed`，由投影重放强制校验（`[H] agent-team/src/projection.ts:250-268`）；`name/provider/context` 不可变。
- **`inactive` 是派生的**：`availability(agent) = agent?.status === 'running' ? 'running' : 'inactive'`（`[H] agent-team/src/roster.ts:475-477`），优先级为 `failed > provisioning > availability`（`:144-148`）。
- 成员名 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、≤64、禁用 `lead`（`[H] agent-team/src/roster.ts:25,436-444`）；**首条 provisioning 即占名，永不复用**，`maxMembers` 连 failed 成员一起计数，且没有成员回收 API。
- 只有 Lead 能 `spawn_teammate` / `interrupt_agent` / `reassign`；非 Lead 在服务端报 `TEAM_LEAD_REQUIRED`（工具 schema 不做角色过滤）。

### 4.3 启动恢复

`agent/created` → `scheduleRecovery`（microtask）→ `reconcileProvisioning`：读取持久化子 Session，要求 `header.parentSession === root.id`、存在 `mode === 'continuable'` 且 `provider` 与成员记录一致的 descriptor、且初始 user message 已被接受，才补 `active`，否则记 `failed`（`[H] agent-team/src/roster.ts:375-417`，关键判定 `:389-392`）。

---

## 5. 任务板与依赖图

### 5.1 转移表（`[H] agent-team/src/task-board.ts`）

| 动作 | 前置/授权 | 结果 |
|---|---|---|
| `claim` | 无主或自己是 owner；`pending` 且 `ready` | `in_progress`，`ownerId = caller.id`（`:129-137`） |
| `release` | owner 或 Lead；`in_progress` | `pending` 且清 owner（`:138-142`） |
| `edit` | owner 或 Lead | 改 subject/description/writeScopes，status 不变（`:143-156`） |
| `set_dependencies` | owner 或 Lead | 替换 `blockedBy`（`:157-161`） |
| `complete` | owner 或 Lead；`in_progress` | `completed`（`:162-166`） |
| `reopen` | owner 或 Lead；`completed` | `pending` 且清 owner（`:167-171`） |
| `reassign` | **仅 Lead**；`pending/in_progress` | 给 owner 时要求 `ready`；**清 owner 分支不检查 ready**（`:172-188`） |
| `delete` | owner 或 Lead；无其他任务依赖它 | `deleted` 墓碑（`:189-198`） |

- 删除后仍是墓碑：`get` 可读、`list` 与 wire 投影过滤（`task-board.ts:77-96`、`projection.ts:356-358`）。
- 错误码：`TEAM_TASK_ALREADY_CLAIMED` / `TEAM_TASK_BLOCKED` / `TEAM_TASK_UNAUTHORIZED` / `TEAM_TASK_STALE_REVISION` / `TEAM_TASK_DELETED` / `TEAM_TASK_HAS_DEPENDENTS` / `TEAM_LEAD_REQUIRED`。

### 5.2 CAS 顺序（易错）

`update` 的判定顺序是 **存在 → revision → deleted**（`[H] agent-team/src/task-board.ts:113-121`）。因此对已删除任务传**旧** revision 得到的是 `TEAM_TASK_STALE_REVISION`，只有传删除态的当前 revision 才得到 `TEAM_TASK_DELETED`。

### 5.3 `ready` 与图校验

- `taskReady = blockedBy.every(id => 该任务 status === 'completed')`（`[H] agent-team/src/task-view.ts:24-26`）；view 的 `ready` 还要求自身 `pending`（`:59`）。
- `assertTaskGraphCandidate` 全量校验候选图：违规类别仅 `missing | duplicate | cycle`，跳过 deleted 节点，三色 DFS 检环（`[H] agent-team/src/task-graph.ts:26-68`）；命令路径与投影重放都会调用它。
- **不提供**：拓扑排序输出、调度队列、可行性证明。

### 5.4 write scopes

规范化（反斜杠转 `/`、去 `./` 与前导 `/`、拒绝绝对路径与 `..`）后去重（`[H] agent-team/src/validation.ts:22-33`、`task-board.ts:235-237`）。重叠告警只与其他 `in_progress` 任务比较并按路径段判定（`task-view.ts:14-16,44-47`），**不阻止 claim、不阻止写入**。

---

## 6. 消息投递

### 6.1 一条消息的完整路径（`[H] agent-team/src/index.ts:224-248`）

1. 解析调用者与目标：`resolveActiveMember` 把 `lead` 解析为根；具名队友必须 `phase === 'active'`，否则 `TEAM_MEMBER_NOT_FOUND`（`roster.ts:42-54`）。→ **provisioning 的队友可见但不可寻址**。
2. 自投递拒绝（`TEAM_SELF_MESSAGE`，`index.ts:229`）。
3. 正文前缀 `Team message from <name>:`，按 `JSON.stringify` UTF-8 字节数限长（默认 65536）。
4. 固定 source `{ kind: 'agent-message', form: 'relay', senderSessionId }`。
5. 投递：目标是 Lead → `root.steer(...)`（`index.ts:240-242`）；目标是队友 → `steerHostSubagentPrompt`（`:244`）→ manager `steerPrompt` → per-child 锁 → 驻留者 `agent.steer`，非驻留者 `coldResume`（读持久化 Session → materialize → 投递 → wake）。
6. 投递完成后 `activity.notify(teamId)`（`:246`）——这也是等待中的 Lead 被“队友消息”唤醒的路径。

### 6.2 “最近 step 边界”的含义

- `steer` = `send(msg, 'next-step', wakeup = true)`；消息 splice 进 `next-step` inbox 并唤醒 driver。
- driver 在每个 step 前 `claim` 一次性取走全部 `next-step`（外加至多 1 条 `next-turn`）；step 结束后若 `next-step` 非空则继续下一个 step，而不是结束 turn。→ 运行中的目标**不被打断**，只在下一个 step 边界消费。

### 6.3 `delivery: quiet | wakeup` 的真相（本报告最重要的一处“描述 ≠ 实现”）

- harness 的 `send_message` **没有** `delivery` 参数，永远 `wakeup = true`。
- Agent 层确实有 `wakeup` 位（`steer`/`followup` 传 true、`inject` 传 false），`wakeup=false` 只入队不唤醒。
- 产品层把 `delivery` 暴露成工具参数（`[S] tool-swarm/src/index.ts:111,144`），但 `[S] packages/team-core/src/index.ts:271-289` 收了 `delivery` **完全没有使用**，直接调 harness `sendMessage`。
- **结论：当前 `quiet` 与 `wakeup` 行为完全相同，始终唤醒。**

### 6.4 顺序、自过滤与“发送即返回”

- 同一队友的投递由 per-child 锁串行；Lead 的 inbox 是单线程 splice 追加。
- Team **不做队列**：并发 send 直接下发 subagent 层（测试标题即 “without a Team queue”）。
- 自过滤：harness 层拒绝自投递；总线层 `broadcast` 显式跳过自己；**`multicast` 不排除调用者**，自己那条会撞 `TEAM_SELF_MESSAGE` 并被吞成 warn，整体仍返回成功 → 静默丢一条。
- `SendTeamMessageResult` 注释： “no Team retry or deduplication”；发送不 flush 目标 Session。→ `sent: true` ≠ 对方已处理。

---

## 7. `wait_agent` 与唤醒模型

- 工具先算 `hasActivePeer`：除自己外是否有 `running/provisioning` 成员；没有就**不注册 waiter**，立即返回 `{ timedOut: false, noProgress: { reason: 'no-active-peer', … } }`（`[H] tool-agent-team/src/index.ts:44,269-279`）。
- 有 peer 才进 `TeamActivity.wait`（`[H] agent-team/src/activity.ts:22-66`）：一次性 waiter + `setTimeout` + abort 监听；超时 `{timedOut:true}`，abort 抛 `TEAM_WAIT_ABORTED`，`close()` 时全部唤醒。
- 唤醒来源（`notify(teamId)`）三类：Team 事件提交并 flush 成功（`index.ts:89`）、任一 Team 成员 `agent/status` 迁移（`:94-97`）、任一成功 send（`:246`）。粒度是**整个 Team**。
- 边沿触发：注册之前发生的变化不算（测试用 fake timer 断言）。
- `noProgress` 是**预测**而非保证：检查与注册虽在同一同步片段，但第三方随后唤醒某个 inactive 成员时，调用者不会收到通知——必须重新 `list_agents`。

---

## 8. 持久化与重启恢复

**写入 Lead Session 日志（可重放）**

- `team/member`、`team/task`：整快照 + `version: 2`；`TeamJournal` 只允许这两种类型，顺序是 `session.append` → `sessions.flush` → `onCommit`（`[H] agent-team/src/journal.ts:9,60-72`）。
- 投影：`key: 'agentTeam'`、`stateVersion: 4`、`wire.view`（`[H] agent-team/src/projection.ts:387-394`）；`failure` 是终态，之后所有事件返回同一状态引用不再重投影。

**已废弃（仅类型/投影规则残留）**

- `team/message/queued` / `team/message/delivered`：注释写明 “Historical mailbox enqueue; new sends use the target Agent inbox.”；生产路径不再 emit，测试断言 Lead 日志里 `team/message/*` 为空。

**只在内存**

- `TeamActivity.waiters`、`TeamRuntimeLifecycle.operations`、`TeamJournal.tails`（每 Lead 串行队列）、投影 view 的 WeakMap 缓存、成员的 `running/inactive` 派生值。
- `[S]` 侧 `team-bus` 的 `durable[]`/`seq` 也在内存；其 `swarm/*` 事件能否跨重启重放取决于工作区之外的宿主桥 —— **UNVERIFIED**。

---

## 9. UI 与启用

- **状态到 GUI 没有独立通道**：`agent-team` 注册 `agentTeam` 投影（带 `wire.view`），与其它 Session projection 共用 snapshot 通道；客户端从 `projectionsBySession[lead].values.agentTeam` 取值（`[H] client-ui-agent-team/src/client/TeamAction.tsx:193`）。
- 客户端插件通过 `package.json` 的 `dsh.client`（`platform: 'web'`）+ `exports["./client"]` 被发现，`mount.ts` 注册字典与 `conversation.session.header.actions` slot；Host 半边 `apply()` 为空。
- 用户可见：会话头部「智能体团队」面板（成员状态/模型/错误、点击打开成员 continuable 子会话）+ **只读**共享任务看板（owner/ready/blockedBy/writeScopes/冲突告警）+ `failure` 错误条。面板不发任何 Team RPC。
- **启用**：`@deepseek-ai/dsh-experimental-agent-team-profile`（在 `OPTIONAL_BUNDLES`，默认关闭）。patch 做三件事：disabled 4 个 legacy `tool-subagent*` 行、insert `agent-team`（`maxMembers: 8 / maxTasks: 256 / maxMessageBytes: 65536 / disposalTimeoutMs: 5000`）、insert `tool-agent-team` 与 `ui-agent-team`。
- 已核验的 5 条文档断言中 4 条一致，1 条 **DRIFT**：本工作区 `README.md`「任务派发模式」说默认已是 `scheduled`（与代码一致），而「当前阶段状态」末段仍说默认是 `autonomous`（过时，代码为 `.default('scheduled')`，`[S] packages/team-scheduler/src/index.ts:70,519`）。

---

## 10. native 与 dsh-swarm 的边界

| 关注点 | 归属 |
|---|---|
| `ctx.agentTeams` 服务、roster/task DAG/子会话生命周期、`team/*` 事件与投影 | native（`[H] packages/experimental/agent-team`） |
| 9 个团队工具、Web 面板、一键启用 bundle | native（`tool-agent-team` / `client-ui-agent-team` / `agent-team-profile`） |
| 端口类型 SSOT、native seam 适配 | dsh-swarm（`team-core-contract` / `team-core`） |
| `in_review`/`planned` 叠加态、评审闸、计划闸、调度派发、durable `swarm/*` 事件 | dsh-swarm |
| `broadcast`/`multicast`/`team_summary`/`review_*`/`workspace_*`/`skills_*`/`memory_*` 工具 | dsh-swarm（`tool-swarm` + 各能力包） |
| **Web 面板显示 dsh-swarm 的叠加态** | **不显示**：面板只 switch 原生 4 态；dsh-swarm 无自己的 projection/UI 包 |

---

## 11. 操作手册（怎么用 team 模式）

1. **启用**：`dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-team-profile`（profile 需已含 `dsh-base`）；注意它会关掉原生直属 subagent 委派工具。
2. **Lead 先建任务再建人**：`team_task_create` 写清 subject/description/验收标准，并给 `blocked_by` 与 `write_scopes`。写域要**真正互斥**（见 §12）。
3. **派活/招人**：`spawn_teammate`（`fresh` 不带 Lead 历史，`fork` 继承已完成回合）。每个成员的 prompt 必须自包含：环境、任务 id、写域、证据规范、完成回报格式。
4. **成员循环**：`team_task_list` → `team_task_get` → 用当前 revision `claim` → 干活 → `complete`。被阻塞的任务不要抢。
5. **Lead 循环**：`wait_agent` 之前先 `list_agents` 确认有 peer 在 running/provisioning，否则会立刻 `noProgress`；等待返回后**重新 list/get**，不要连续轮询。
6. **消息**：`send_message` 会 steers 到对方下一个 step 边界；发了不等于对方读到了，别在同一 step 内假设状态已变。
7. **验证闸**：把验证交给一个**没写过这些文件**的成员，用独立抽样核验（本次 39 条抽样）而不是“读一遍说没问题”。
8. **收尾**：Lead 汇总前确认所有阻塞任务的 owner 已释放/完成；终稿由 Lead 自己跑一遍引用抽查。

---

## 12. 已知限制与陷阱（对照表）

| # | 陷阱 | 证据 | 后果 / 规避 |
|---|---|---|---|
| 1 | `quiet` 是空转 | `[S] team-core/src/index.ts:271-289` | 别指望 quiet 广播不打扰成员 |
| 2 | provisioning 不可寻址，但 `wait_agent` 视其为活跃 peer | `roster.ts:50-52` vs `tool-agent-team:44` | 刚 spawn 完立刻 send 会失败；等 `active` |
| 3 | `multicast` 不排除自己且吞异常 | `[S] team-bus/src/index.ts:327-334,364-389` | targets 含自己会静默丢一条但仍报成功 |
| 4 | `sent:true` ≠ 已处理 | `types.ts:186-189`；发送不 flush | 关键指令后要等对方的任务/消息回声 |
| 5 | `write_scopes` 非锁 | `validation.ts:22`、`team.spec.ts:863-883` | 写域重叠必须靠人协调；并发写会互相覆盖（本次调查亲身踩到，见 §13） |
| 6 | 阻塞任务的 claim 不会被自动释放 | 本次实测（task-4 停在 owner=arch-core） | owner 停下后要显式 `release`/`reassign` |
| 7 | `maxMembers` 含 failed 且无回收 API | `roster.ts:257`；服务公开面无删除成员方法 | 名额被失败成员永久占用 |
| 8 | 投影 `failure` 是终态 | `projection.ts:226,372` | 一旦持久记录损坏，members/tasks 冻结在最后有效值 |
| 9 | 名字一旦占用永不复用 | `roster.ts:254-256`、`projection.ts:255-257` | 重建同名成员会直接报错 |
| 10 | CAS 顺序：stale 先于 deleted | `task-board.ts:113-121` | 对墓碑任务只会拿到 STALE，容易误判 |
| 11 | 等待粒度是整个 Team | `index.ts:89,94-97,246` | 别的成员动一下也会把你唤醒 |
| 12 | `assigned dep` 与调度派发是产品层能力 | `[S] team-scheduler` | 上游原生只有任务板，没有自动派发 |

---

## 13. 一次真实的“team 模式”事故（现场实证）

本次调查过程中，工作区里**同时存在两支调查小组**（本组 Lead `session-a4df6b40-…`，成员 `arch-core/bus-messaging/ui-wiring/verifier`；另一组 Lead `session-4e0b08f3-…`，成员 `core-model/tools-messaging/wiring-ui/auditor`），两支队伍共享同一个文件系统与 `docs/investigation/` 目录：

- 另一组把 `docs/investigation/01-core-model.md` 先写成别名路径版本，本组 `arch-core` 写作期间遭遇并发改写；
- `docs/investigation/04-live-session-evidence.md`（212 行，自称“本会话活证据”）实际记录的是**另一组**的会话（已解压 `session-4e0b08f3` 的日志核对：`team/member` 名字恰为 core-model / tools-messaging / wiring-ui / auditor，`teamId = session-4e0b08f3`），本组 Lead 因此未将其作为证据，并把三节冻结到 `docs/investigation/dsh-team-mode/`。

这正面印证了团队策略里的那句话——“写域重叠只是建议，不是锁”：**Team 模式不提供文件锁、不提供跨 Team 的隔离，也不阻止两个 Team 写同一个路径**。相关流程缺陷也已记录：被阻塞任务（task-4）的 claim 在 owner 停止后不会自动释放，看板会停在 “已认领但无进展”。

---

## 14. 引用索引（按主题）

- 服务门面与内存/持久化边界：`[H] agent-team/src/index.ts:56-109,116-221,240-276`
- 类型与事件：`[H] agent-team/src/types.ts:9-56,72-98,129-144,153-241`
- 身份/生命周期/恢复：`[H] agent-team/src/roster.ts:25,42-54,89-119,144-148,175-179,189-197,233-320,375-417,436-444,470-477`
- 任务板/CAS/依赖：`[H] agent-team/src/task-board.ts:44-69,113-121,122-198,203-248`
- 视图/ready/重叠告警：`[H] agent-team/src/task-view.ts:14-16,24-26,38-59`
- 图校验：`[H] agent-team/src/task-graph.ts:26-68`
- 事务与提交点：`[H] agent-team/src/journal.ts:9,42-72`
- 投影与 wire：`[H] agent-team/src/projection.ts:226,250-305,342-394`
- 等待器：`[H] agent-team/src/activity.ts:12,22-66,79-86`
- 工具面：`[H] tool-agent-team/src/index.ts:44,192-400`
- UI：`[H] client-ui-agent-team/src/{client/mount.ts,client/TeamAction.tsx,index.ts}`
- 启用：`[H] agent-team-profile/cordis.patch.yml:4-32`、`[H] boot/app-boot/src/profile.ts:223-236`
- 产品层叠加：`[S] packages/tool-swarm/src/index.ts`、`[S] packages/team-core/src/index.ts`、`[S] packages/team-bus/src/index.ts`、`[S] packages/team-scheduler/src/index.ts`

---

## 15. Lead 终检记录（合并后抽查）

对**本报告**用到的 12 条引用逐条打开核对（命令：`sed -n` 直接读被引行）：

| # | 引用 | 抽查结果 |
|---|---|---|
| 1 | `types.ts:45` | ✅ `TeamMemberPhase = 'provisioning' \| 'active' \| 'failed'` |
| 2 | `types.ts:72` | ✅ `TeamTaskStatus = 'pending' \| 'in_progress' \| 'completed' \| 'deleted'` |
| 3 | `roster.ts:475-477` | ✅ `availability()` 仅由 live `status` 派生 |
| 4 | `task-view.ts:59` | ✅ `ready: task.status === 'pending' && taskReady(...)` |
| 5 | `task-board.ts:113-121` | ✅ 顺序为 找不到 → revision CAS → deleted |
| 6 | `journal.ts:60-71` | ✅ `append` → `flush` → `onCommit` |
| 7 | `tool-agent-team/src/index.ts:271-279` | ✅ `noProgress` 短路分支 |
| 8 | `projection.ts:387-394` | ✅ `key:'agentTeam'`、`stateVersion:4`、`wire.view` |
| 9 | `roster.ts:389-392` | ✅ 恢复要求 continuable + provider 匹配 |
| 10 | `TeamAction.tsx:193` | ✅ 从 `projectionsBySession[...].values.agentTeam` 取值 |
| 11 | `cordis.patch.yml:17-23` | ✅ `agent-team` 行与四项 Config |
| 12 | `agent-team/src/index.ts:240-246` | ✅ `root.steer` / `steerHostSubagentPrompt` + `notify` |

同时确认：验证闸列出的 7 处更正（M1–M7）与 1 处来源标注（M0）已全部写入分节文件；`list_members` 这一不存在的标识符已不再被当作真实工具/方法引用（仅作为更正说明与验证记录中的被更正项出现）。

---

## 16. 仍未解决的问题（UNVERIFIED）

1. **跨进程/多实例并发**：`TeamJournal.transact` 只保证单进程内按 Lead id 串行；多进程向同一 Lead Session 追加 Team 事件的冲突语义未定义。
2. **产品层 `swarm/*` 事件跨重启重放**：`team-bus` 的 `emitDurable` 用 `ctx.emit`，其到 Session 日志的宿主桥不在本次读取范围。
3. **subagent manager 的 per-child 锁实现**未展开，跨进程顺序保证未证。
4. **运行时 UI 行为**未做浏览器复验（未启动 3099）。
5. **所有测试均为读源码**，本轮未实际执行 harness 单测（缺 `vite-tsconfig-paths`）。
6. **`ownerId` 悬空**（指向不存在成员）时 `ownerName` 缺失是否属受支持状态，源码无定论。
