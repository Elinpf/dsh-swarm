# 01 · DSH Team Mode 核心模型（roster / lifecycle / task board）

> **证据范围**（所有 `path:line` 均相对 harness checkout 根目录 `.runtime/deepseek-harness`，行号已逐条 `read` 核对）：
> 主源为 `packages/experimental/agent-team/`；引用工具层 / 客户端包时写完整包路径。凡源码或测试无法证实者标 `UNVERIFIED` 并写明原因。
> 本轮更正清单见 §7，开放问题状态变更见 §8。

## 0. 测试运行状态（可运行性说明）

尝试用工作区 `node_modules/vitest` 跑 harness 的 agent-team 单测：

```
.runtime/deepseek-harness$ ../../node_modules/.bin/vitest run --config vitest.config.ts \
  packages/experimental/agent-team/tests/projection-events.spec.ts
```

**结论：跑不通**，退出码 1，原因是 harness 的 `vitest.config.ts:3` 依赖 `vite-tsconfig-paths`（以及 `vitest.shared.ts` 等），而工作区 `node_modules` 既没有该包也没有 pnpm 的 `.pnpm` 虚拟存储（已确认 `node_modules` 下无 `vite-tsconfig-paths`）。这两点可直接复核：`sed -n '3p' .runtime/deepseek-harness/vitest.config.ts` 与 `ls node_modules/vite-tsconfig-paths`。

> 证据归属更正（verifier 检查 B）：早前引用的 `docs/investigation/evidence/01-vitest-attempt.log` 位于**共享目录**，而同一工作区还有另一支并发调查组在写 `docs/investigation/`，该文件的作者无法归属给本组，故不作为本组证据。
> 按任务约束未安装依赖，故本文的测试证据全部来自**阅读测试源码**（tests/\*.spec.ts），而非本轮实际执行结果；下文凡引测试处均已注明是"测试断言"。

## 1. 实体模型（TypeScript 形状）

### 1.1 Team 是隐式的，不是被创建的实体

- `TeamId(id: SessionId | string)` 直接返回同一个字符串，只做 brand（`packages/experimental/agent-team/src/types.ts:16-18`）。
- 因此不存在"Team 创建事件"：`TeamState.id` 的类型是 `TeamId`（`packages/experimental/agent-team/src/types.ts` 中无 TeamState；实际在 `packages/experimental/agent-team/src/projection.ts:131-138`），空态由根 Session id 构造：`emptyTeamState(rootId)` 写 `id: toTeamId(rootId)`（`packages/experimental/agent-team/src/projection.ts:145-153`），投影 `init: header => emptyTeamState(header.id)`（`packages/experimental/agent-team/src/projection.ts:391`）。
- README 同述："Every ordinary runtime root is the implicit Lead of a Team whose `TeamId` equals its `SessionId`; there is no creation event"（`packages/experimental/agent-team/README.md:126`）。

### 1.2 成员：durable snapshot / runtime view / wire projection 三层

| 层                        | 类型                   | 位置                                                    | 关键字段                                                                                                                                                               |
| ------------------------- | ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| durable（写入事件）       | `TeamMemberSnapshot`   | `packages/experimental/agent-team/src/types.ts:48-56`   | `id: SessionId`、`name`、`description`、`provider`、`context: 'fresh'\|'fork'`、`phase`、可选 `error`                                                                  |
| runtime view（工具/宿主） | `TeamMemberView`       | `packages/experimental/agent-team/src/types.ts:59-69`   | `id/name/role: 'lead'\|'teammate'`、`status: 'running'\|'inactive'\|'provisioning'\|'failed'`、可选 `description/provider/context/model`、必填 `diagnostics: string[]` |
| wire projection（浏览器） | `TeamMemberProjection` | `packages/experimental/agent-team/src/types.ts:101-108` | `id/name/role/phase`、可选 `error`；注释明确 Lead 行恒为 `active`、"Turn activity comes from Session status"（`:105`）                                                 |

- `TeamMemberPhase` 只有三个值：`'provisioning' | 'active' | 'failed'`（`packages/experimental/agent-team/src/types.ts:45`），**没有 `inactive` durable 状态**。
- `TeamProjection = { members, tasks, failure? }` 是整体 wire 值（`packages/experimental/agent-team/src/types.ts:115-119`，成员数组与任务数组类型见 `:116-117`）。

### 1.3 任务：snapshot 与 view

- `TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'`（`packages/experimental/agent-team/src/types.ts:72`）。
- `TeamTaskSnapshot`：`id: TeamTaskId`、`revision: number`、`subject`、`description`、`status`、可选 `ownerId`、`blockedBy`、`writeScopes`（`packages/experimental/agent-team/src/types.ts:75-84`）。
- `TeamTaskView`：在 snapshot 的 `id/revision/subject/description/status/blockedBy/writeScopes` 之上补 `ownerName?`、`ready: boolean`、`writeScopeWarnings: string[]`；**view 不暴露 `ownerId`**（`packages/experimental/agent-team/src/types.ts:87-98`）。测试断言 release 后 view 中无 `ownerId`：`expect('ownerId' in released).toBe(false)`（`packages/experimental/agent-team/tests/team.spec.ts:675`；同断言亦见 `:861`）。
- 任务 id 形如 `task-${n}`，由 `TeamTaskId(...)` brand：`const id = TeamTaskId(\`task-${state.nextTaskNumber}\`)`（`packages/experimental/agent-team/src/task-board.ts:52`）；brand 函数在 `packages/experimental/agent-team/src/types.ts:28-30`。

### 1.4 消息：durable mailbox 类型仍在，但已不是活跃投递路径

- `TeamMessageSnapshot`（`packages/experimental/agent-team/src/types.ts:129-135`）、`TeamMessageSource`（`packages/experimental/agent-team/src/types.ts:138-144`）。
- `SessionEventMap['team/message/queued']` 的注释写明 "Historical mailbox enqueue; new sends use the target Agent inbox."（`packages/experimental/agent-team/src/types.ts:233`）。
- 实际发送路径：`const source = { kind: 'agent-message', form: 'relay', senderSessionId: caller.id }`，Lead 目标走 `root.steer()`、队友目标走 `steerHostSubagentPrompt(...)`（`packages/experimental/agent-team/src/index.ts:237-245`）；返回值是普通 `MessageId`（`SendTeamMessageResult`，`packages/experimental/agent-team/src/types.ts:186-189`）。
- durable 事件：`SessionEventMap` 合并 4 个 `version: 2` 事件（`packages/experimental/agent-team/src/types.ts:227-242`）。**更正（verifier 检查 1/2）**：只有 `team/member`（`:230`）与 `team/task`（`:232`）的注释写 "stored only in the Team Lead Session"；`team/message/queued`（`:233`）写的是 "Historical mailbox enqueue; new sends use the target Agent inbox."，`team/message/delivered`（`:235-241`）只带 `messageId` + `targetId`，**不是**整体快照。承载整体快照的是 `team/member` / `team/task` / `team/message/queued` 三者；`team/message/delivered` 只带 `messageId` + `targetId`，是投递确认而非快照，且两者均已废弃。

## 2. Roster 与成员生命周期

### 2.1 身份判定

- Lead 是隐式的：`resolveActiveMember` 把名字 `'lead'` 直接映射到根 Agent（`packages/experimental/agent-team/src/roster.ts:47-48`）。
- `tryMembership(agent)` 的判定链（`packages/experimental/agent-team/src/roster.ts:89-119`）：
  1. 必须是 registry 中的同一个 live 对象：`this.ctx.agents.get(agent.id) !== agent` 即返回 undefined（`:90`）。
  2. 有 `parentSession` 且父是 live 根时，若根日志 roster 中该 id 的 `phase` 为 `active` **或 `provisioning`**，即为 teammate（`:92-99`，判定在 `:97`）。
  3. 有 subagent descriptor 的 provider worker 明确不获得 Team 身份（`:100-104` 的注释与 `:103`）。
  4. 其余普通根返回 `{ root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }`（`:104`、`:112`）。
- **注意（本轮新增）**：teammate 身份只要求 durable `phase ∈ {active, provisioning}`，与 Agent 是否 running 无关。因此 `inactive` 的队友仍是 Team 成员、仍会被 `tool-agent-team` 安装工具（`packages/experimental/tool-agent-team/src/index.ts:419` 以 `tryMembership !== undefined` 为安装门槛）。
- 名字规则：`MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u`（`packages/experimental/agent-team/src/roster.ts:25`），`memberName()` 追加"`length > 64` 或等于 `'lead'` 即拒绝"（`packages/experimental/agent-team/src/roster.ts:436-444`）。测试覆盖非法名 `['Lead','lead','-bad','bad-','bad_name','x'.repeat(65)]` → `TEAM_INVALID_MEMBER_NAME`（`packages/experimental/agent-team/tests/team.spec.ts:434-436`）。
- 名字一经首次 provisioning 记录即被占用且禁止复用：roster 侧 `TEAM_MEMBER_NAME_TAKEN`（`packages/experimental/agent-team/src/roster.ts:254-256`），投影侧重放同样拒绝 `name reused`（`packages/experimental/agent-team/src/projection.ts:255-257`）。测试：`packages/experimental/agent-team/tests/team.spec.ts:341-342`（failed 后同名再报 `TEAM_MEMBER_NAME_TAKEN`）、`:234`（成功成员同名复报）。

### 2.2 durable 状态机（只有 provisioning → active | failed）

投影应用 `team/member` 时强制校验（`packages/experimental/agent-team/src/projection.ts:250-268`）：

- 新成员首条记录必须是 `provisioning`，否则 `teammate "…" must begin provisioning`（`packages/experimental/agent-team/src/projection.ts:258-259`）。
- `name`/`provider`/`context` immutable，变更即 `changed immutable identity fields`（`packages/experimental/agent-team/src/projection.ts:261-263`）。
- 合法转移只有 `provisioning → active` 与 `provisioning → failed`：旧值非 provisioning、或新值仍是 provisioning 都被拒绝（`packages/experimental/agent-team/src/projection.ts:264-266`）。**不存在 `active → failed` 或 `failed → active`。**
- roster 源码注释确认不会"发明"一次不可能的 active→failed：`Once the continuation accepted its first prompt, it is a real child. If this checkpoint fails, keep the in-memory active edge instead of inventing an impossible active -> failed transition`（`packages/experimental/agent-team/src/roster.ts:301-304`）。
- 测试断言：非首条 provisioning、改名、active→failed、名字复用分别抛 `/must begin provisioning/`、`/immutable identity/`、`/invalid active -> failed/`、`/name .* reused/`（`packages/experimental/agent-team/tests/projection-events.spec.ts:135-163`）。
- 每个 Lead 的 Team 状态按 `selector.teamId !== state.id` 过滤（`packages/experimental/agent-team/src/projection.ts:229-230`）。

### 2.3 `inactive` 的精确含义

`inactive` 不是 durable phase，而是运行时由 live Agent 状态派生的展示值：

```ts
/** Turn availability is independent of whether the Agent is loaded. */
function availability(agent: Agent | undefined): 'running' | 'inactive' {
  return agent?.status === 'running' ? 'running' : 'inactive'
}
```

（`packages/experimental/agent-team/src/roster.ts:474-477`，函数体在 `:475-477`；`:474` 是 JSDoc。）

- `list()` 的派生优先级：`phase === 'failed'` → `'failed'`；`phase === 'provisioning'` → `'provisioning'`；否则 `availability(live)`（`packages/experimental/agent-team/src/roster.ts:144-148`）。Lead 行直接用 `availability(root)`（`:133`）。
- 因此 `inactive` = "Agent 未加载，或已加载但其 `status !== 'running'`（当前没有 running turn）"，与任务是否完成、是否失败无关。测试证据：Lead 行初始为 `inactive`（`packages/experimental/agent-team/tests/team.spec.ts:186-189`）；spawn + `waitNoAgent` 之后 fork/fresh 两名成员均为 `inactive`（`:230-232`）；spawn 返回行可为 `inactive`（`:407`）。
- `interrupt()` 的 `previousStatus` 用同一个 `availability`：目标不在 Agent registry 时直接返回 `{ previousStatus: 'inactive' }`（`packages/experimental/agent-team/src/roster.ts:193-194`）；否则先采样再 interrupt（`:195-197`）。测试：running worker → `{ previousStatus: 'running' }`，drain 后 → `{ previousStatus: 'inactive' }`（`packages/experimental/agent-team/tests/team.spec.ts:441-443`）。

### 2.4 谁创建成员、创建流程

只有 Lead 能创建队友：`spawnAdmitted` 先取 membership，非 lead 抛 `TEAM_LEAD_REQUIRED`（`packages/experimental/agent-team/src/roster.ts:233-236`）。`interrupt` 同样 Lead-only（`packages/experimental/agent-team/src/roster.ts:189`）。流程（`packages/experimental/agent-team/src/roster.ts:239-320`）：

1. 预生成 `childId`（`randomUUID`）并构造 `phase: 'provisioning'` 的 `TeamMemberSnapshot`——**成员 id 在子 Session 存在前就已预留**（`packages/experimental/agent-team/src/roster.ts:242-250`）。
2. 在 `journal.transact` 内检查名字占用与 `maxMembers` 上限，再 `appendAndFlush` 写入 `team/member`（`packages/experimental/agent-team/src/roster.ts:252-261`）。失败记录同样计入上限（`state.members.length >= maxMembers` 不过滤 phase，`:257-258`）。测试：`maxMembers: 1` 下一个 failed 成员后，新名字报 `TEAM_MEMBER_NAME_TAKEN`、别的名字报 `TEAM_MEMBER_LIMIT`（`packages/experimental/agent-team/tests/team.spec.ts:331-342`）。
3. 调 `ctx.subagents.startActivation({ delivery: 'parent', childId, ... })`（`packages/experimental/agent-team/src/roster.ts:263-275`），再用 `checkpointInitialPrompt` 确认首条 prompt 已 durable 接受（`packages/experimental/agent-team/src/roster.ts:275`；实现 `:323-372`）。
4. 成功写入 `phase: 'active'` 并调 `settleProvisioning`（`packages/experimental/agent-team/src/roster.ts:297-305`）；`settleProvisioning` 只在当前仍为 provisioning 时追加终态（`packages/experimental/agent-team/src/roster.ts:447-465`，早退在 `:457`）。若恢复流程已先判定 failed，则抛 `TEAM_PROVISIONING_CONFLICT` 并 drain 子 Agent（`packages/experimental/agent-team/src/roster.ts:306-318`）。
5. 创建失败则 `settleProvisioning(root, failed)`，记录 `phase: 'failed'` + `error` 并 drain（`packages/experimental/agent-team/src/roster.ts:276-296`）。测试：checkpoint 失败后 durable `{ phase: 'failed', error: 'checkpoint failed' }`（`packages/experimental/agent-team/tests/team.spec.ts:320-329`）。

### 2.5 启动恢复（reconcile）

- 每次 Agent 创建/启动后异步排队恢复：`ctx.on('agent/created', ({ agent }) => this.scheduleRecovery(agent))`（`packages/experimental/agent-team/src/index.ts:93`）、构造末尾对既有 Agent 遍历 `for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)`（`:108`）；`scheduleRecovery` 走 `queueMicrotask` + `roster.recoverFor(...).catch(...)`（`:251-259`）。`recoverFor` 只在 membership 为 lead 时调 `reconcileProvisioning`（`packages/experimental/agent-team/src/roster.ts:175-179`）。
- `reconcileProvisioning`（`packages/experimental/agent-team/src/roster.ts:375-417`）：只处理根 roster 中仍为 `provisioning` 且当前无 live child 的记录（`:376`、`:381`）；读取子 Session 持久化前缀（`readPersistedSession`，`:385-386`），要求**同时**满足 `header.parentSession === root.id`（`:389`）、存在 `mode === 'continuable'` 且 `descriptor.provider === member.provider` 的 subagent descriptor（`:390-391`）、且已有被接受的初始 user message（`:388`、`:392`），才置 `active`，否则置 `failed` 并写原因（`:394-399`）；写回前二次确认仍为 provisioning（`:403-404`）。测试：可恢复子 → `active`、缺失子 → durable `failed` 且 error 含 "child Session recovery failed"（`packages/experimental/agent-team/tests/persistence.spec.ts:198-273`）；durable-pending 的初始 prompt 也能恢复为 `active`（`:274-314`）。

### 2.6 停止与中断

- `interrupt` 委托 `ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller })`，不清 inbox、不释放任务所有权（`packages/experimental/agent-team/src/roster.ts:196`）；README 明确 "cancels only a live teammate's current turn with `keepInbox`; it neither releases task ownership nor deletes durable mail"（`packages/experimental/agent-team/README.md:140`）。**更正（verifier 检查 4）**：`targetName === 'lead'` 时 `resolveActiveMember` 先把它解析为 root（`packages/experimental/agent-team/src/roster.ts:48`），随后命中 `target.id === root.id` 的自中断检查，抛 `TEAM_INVALID_TARGET`（`:192`）；只有"名字存在但 durable phase 不为 `active` 的队友"才抛 `TEAM_MEMBER_NOT_FOUND`（`resolveActiveMember`，`:50-52`）。
- `liveChildrenByRoot()` 把 registry 中真正的 roster 子 Agent 按根分组用于卸载 drain（`packages/experimental/agent-team/src/roster.ts:204-217`），`stopTeammates` 走 `drainChildren` 且受 `withTimeout` 约束（`packages/experimental/agent-team/src/roster.ts:224-226`）。disposal 路径见 `packages/experimental/agent-team/src/index.ts:262-276`。

## 3. 任务板（TeamTaskBoard）

### 3.1 创建与上限

- `create` 在 `journal.transact` 内统计**非 deleted** 任务数并对照 `maxTasks`（`packages/experimental/agent-team/src/task-board.ts:47-51`）；默认 256：`DEFAULT_MAX_TASKS = 256`（`packages/experimental/agent-team/src/index.ts:43`）。因此 deleted 墓碑不占 `maxTasks`（与 `packages/experimental/agent-team/README.md:136` 一致）。
- 快照构造：`revision: 1`、`status: 'pending'`、无 `ownerId`、`blockedBy`/`writeScopes` 经校验去重（`packages/experimental/agent-team/src/task-board.ts:56-64`）；id 取 `task-${state.nextTaskNumber}` 并显式防碰撞（`:52-55`）。
- **任何 Team 成员都可创建任务**：`TeamService.createTask` 只做 `this.roster.membership(caller)`，无角色判断（`packages/experimental/agent-team/src/index.ts:159-161`）。
- 文本上限：`subject ≤ 200`、`description ≤ 16384`（`packages/experimental/agent-team/src/task-board.ts:59-60`），由 `requiredText` 实施（`packages/experimental/agent-team/src/validation.ts:12-19`）。

### 3.2 状态转移表（switch 的完整分支，行号均指 `packages/experimental/agent-team/src/task-board.ts`）

| 动作               | 授权/前置                                                                                                                                                                             | 结果                                                        | 依据       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| `claim`            | 无 owner 或 owner 是自己（`:130-132`）；`status === 'pending'` 且 `taskReady`（`:133-135`）                                                                                           | `in_progress` + `ownerId = caller.id`（`:136`）             | `:129-137` |
| `release`          | owner 或 Lead（`:139`）；`status === 'in_progress'`（`:140`）                                                                                                                         | `pending` 并删 `ownerId`（`:141`）                          | `:138-142` |
| `edit`             | owner 或 Lead（`:144`）；至少给 subject/description/writeScopes 之一（`:145-147`）                                                                                                    | 字段更新，status 不变（`:148-155`）                         | `:143-156` |
| `set_dependencies` | owner 或 Lead（`:158`）；必须给 `blockedBy`（`:159`）                                                                                                                                 | 替换 `blockedBy`（`:160`）                                  | `:157-161` |
| `complete`         | owner 或 Lead（`:163`）；`status === 'in_progress'`（`:164`）                                                                                                                         | `completed`（`:165`）                                       | `:162-166` |
| `reopen`           | owner 或 Lead（`:168`）；`status === 'completed'`（`:169`）                                                                                                                           | `pending` 并删 `ownerId`（`:170`）                          | `:167-171` |
| `reassign`         | **仅 Lead**（`:173`）；`pending`/`in_progress`（`:174-179`）；`owner` 空/空白 → 直接 unassign 回 `pending`，**不检查 ready**（`:180-183`）；给具体 owner 时必须 `taskReady`（`:184`） | `in_progress` + `resolveActiveMember(...).id`（`:185-186`） | `:172-188` |
| `delete`           | owner 或 Lead（`:190`）；没有任何非 deleted 任务把它当 blocker（`:191-195`）                                                                                                          | `deleted` 墓碑（`:196`）                                    | `:189-198` |

- 授权判定：`const lead = membership.role === 'lead'; const owner = current.ownerId === caller.id`，`authorizeOwner()` 在两者皆否时抛 `TEAM_TASK_UNAUTHORIZED`（`packages/experimental/agent-team/src/task-board.ts:122-126`）。
- **`claim` 不调用 `authorizeOwner`**，所以任何成员都能抢 pending 且 ready 的无主任务；一旦被他人 owner，只有 owner 或 Lead 能改动（`:129-137`）。测试：alpha claim 后 beta 再 claim 报 `TEAM_TASK_ALREADY_CLAIMED`（`packages/experimental/agent-team/tests/team.spec.ts:640`）、beta edit 报 `TEAM_TASK_UNAUTHORIZED`（`:650`）。
- `reassign` 的两个易错点：unassign 分支**跳过** `taskReady`（`:180-183`），因此 blocked 任务也能被 Lead 交回 unowned；已有 owner 的任务只要 `pending|in_progress` 即可被 Lead 直接改派，不做原 owner 校验（`:172-188`）。
- 相关错误码：`TEAM_TASK_ALREADY_CLAIMED`、`TEAM_TASK_BLOCKED`、`TEAM_TASK_UNAUTHORIZED`、`TEAM_LEAD_REQUIRED`、`TEAM_TASK_INVALID_TRANSITION`、`TEAM_TASK_HAS_DEPENDENTS`、`TEAM_INVALID_ARGUMENT`（`packages/experimental/agent-team/src/task-board.ts:131,134,125,173,140,194,146`）。
- 删除后的任务仍是 `state.tasks` 中的墓碑：`get()` 可读（`packages/experimental/agent-team/src/task-board.ts:77-83`），`list()` 过滤 deleted（`:90-96`），wire 投影也过滤 deleted（`packages/experimental/agent-team/src/projection.ts:356-358`）。测试：`listTasks(lead)` 为空但 `updateTask` 报 `TEAM_TASK_DELETED`（`packages/experimental/agent-team/tests/team.spec.ts:797-805`）。

### 3.3 revision 与 CAS

- 每次 create/update 追加的都是完整快照，`revision` 由 `current.revision + 1` 得到（`packages/experimental/agent-team/src/task-board.ts:203-206`），随后 `assertTaskGraph` + `appendAndFlush`（`:207-208`）。
- 投影侧重放校验：首版必须为 1、后续 revision 必须连续（`packages/experimental/agent-team/src/projection.ts:274-279`）。测试 `/begin at revision 1/`、`/revision is not contiguous/`（`packages/experimental/agent-team/tests/projection-events.spec.ts:165-177`）。
- **CAS 顺序（本轮更正）**：`update` 先判存在（`packages/experimental/agent-team/src/task-board.ts:114`），**然后**判 `current.revision !== request.expectedRevision` → `TEAM_TASK_STALE_REVISION`（`:115-120`），**最后**才判 `current.status === 'deleted'` → `TEAM_TASK_DELETED`（`:121`）。即：对已删除任务，只有传当前（删除态）revision 才会拿到 `TEAM_TASK_DELETED`；传旧 revision 得到的是 `TEAM_TASK_STALE_REVISION`。测试正好覆盖前者：`expectedRevision: deleted.revision` → `TEAM_TASK_DELETED`（`packages/experimental/agent-team/tests/team.spec.ts:797-805`），以及 stale complete → `TEAM_TASK_STALE_REVISION`（`:653-655`）。
- 原子性来源：`TeamJournal.transact(rootId, ...)` 按 Lead Session id 维护 promise 链，把"读—检查—追加"整体串行化（`packages/experimental/agent-team/src/journal.ts:42-52`，队列 `tails` 在 `:13`）；`appendAndFlush` 先 `session.append` 再 `sessions.flush`，flush 成功后才 `onCommit` 通知（`packages/experimental/agent-team/src/journal.ts:60-72`，通知在 `:71`）。因此**同一进程内**读写检查是原子的；跨进程并发不在本包保证范围内。

### 3.4 `blockedBy` 与 `ready`

- `taskReady(state, task) = task.blockedBy.every(id => state.tasks.find(c => c.id === id)?.status === 'completed')`（`packages/experimental/agent-team/src/task-view.ts:24-26`）。只有 `completed` 满足 blocker；deleted/缺失都不算完成。
- view 的 `ready` 还要求任务自身 `status === 'pending'`：`ready: task.status === 'pending' && taskReady(state, task)`（`packages/experimental/agent-team/src/task-view.ts:59`），所以 `in_progress`/`completed` 任务的 `ready` 恒为 false。
- `dependencies()` 写入前校验：不能自阻塞（`TEAM_TASK_DEPENDENCY_CYCLE`）、不能重复（`TEAM_INVALID_ARGUMENT`）、blocker 必须存在且非 deleted（`TEAM_TASK_NOT_FOUND`）（`packages/experimental/agent-team/src/task-board.ts:214-232`）。
- `claim` 与 `reassign` 都用同一 `taskReady` 作为门禁（`packages/experimental/agent-team/src/task-board.ts:133`、`:184`）。

### 3.5 writeScopes

- 规范化 `writeScope()`：反斜杠转 `/`、去掉开头 `./` 与结尾 `/`，拒绝空串、绝对路径、盘符、以及含空段/`.`/`..` 的路径（`packages/experimental/agent-team/src/validation.ts:26-33`），错误码 `TEAM_INVALID_WRITE_SCOPE`（`:31`）。
- `create`/`edit` 都用 `[...new Set(values.map(writeScope))]` 去重（`packages/experimental/agent-team/src/task-board.ts:235-237`，调用点 `:63`、`:154`）。
- 重叠告警是**纯派生、非锁**：`projectTaskView` 只与其他 `in_progress` 任务比较（`packages/experimental/agent-team/src/task-view.ts:44-45`），前缀按路径段判断包含关系（`scopesOverlap`，`:14-16`），生成 `write scopes overlap with ${other.id}`（`:47`）。测试：`['src']` 与 `['src/nested']` 互相告警、`['docs']` 不告警（`packages/experimental/agent-team/tests/team.spec.ts:863-883`），投影侧同断言（`packages/experimental/agent-team/tests/projection-events.spec.ts:508`）。
- JSDoc 明确 "without treating it as a lock"（`packages/experimental/agent-team/src/validation.ts:22`），README 亦述 "never block claim or authorize writes"（`packages/experimental/agent-team/README.md:136`）。

## 4. 任务图（task-graph.ts）提供的保证

`assertTaskGraphCandidate(current, candidate)` 把候选快照并入后对**整个图**做全量校验（`packages/experimental/agent-team/src/task-graph.ts:26-52`）：

- 违规分类只有 `'missing' | 'duplicate' | 'cycle'`（`packages/experimental/agent-team/src/task-graph.ts:6`）。
- 跳过 `status === 'deleted'` 节点（`:34`、`:44`、`:62`——分别为每任务循环、blocker 查询、DFS 访问）。
- 自阻塞报 `cycle`（`:37-39`）、重复 blocker 报 `duplicate`（`:40-42`）、blocker 缺失或已删除报 `missing`（`:43-49`）。
- 环检测用标准三色 DFS（`visiting`/`visited`），遇到回边即 `cycle`（`:54-68`）。
- 调用点两处：命令写入前（`packages/experimental/agent-team/src/task-board.ts:240-248`，经 `assertTaskGraph` 映射错误码）与投影回放时（`packages/experimental/agent-team/src/projection.ts:280`），因此损坏的持久化图会被投影拒绝而非静默接受。测试覆盖全部非法关系（`packages/experimental/agent-team/tests/projection-events.spec.ts:179-235`）。

**图保证的精确表述（本轮收紧）**：非 deleted 任务构成"blocker 全部存在且非 deleted、无重复、无环"的有向图。它**不**提供拓扑排序输出、调度队列或"必然可完成的可行性"证明；"拓扑序"只体现为 blocker 完成（`completed`）后 `ready` 才为 true（`packages/experimental/agent-team/src/task-view.ts:24-26`、`:59`）。违反类别 → 命令错误码映射在 `packages/experimental/agent-team/src/task-board.ts:21-25`。

## 5. 哪些是内存态，哪些是持久态

**持久化（写在 Team Lead Session 日志 + 投影 checkpoint）：**

- 成员与任务的完整快照事件 `team/member` / `team/task`（`packages/experimental/agent-team/src/types.ts:229-232`）。
- 投影状态：基础字段 `{ id, members, tasks, messages, delivered, nextTaskNumber }` 在 `TeamState`（`packages/experimental/agent-team/src/projection.ts:131-138`），`failure?` 由 `TeamProjectionState extends TeamState` 追加（`:157-159`）。注册为 `key: 'agentTeam'`、`stateVersion: 4`，带 `stateSchema` 与 `wire` 视图（`packages/experimental/agent-team/src/projection.ts:386-394`）。
- `nextTaskNumber` 从最大数字任务 id 递推，非 `task-<n>` 的 brand id 不参与分配（`packages/experimental/agent-team/src/projection.ts:281-289`；测试 `packages/experimental/agent-team/tests/projection-events.spec.ts:236-244`）。
- 队友 Session 是独立持久化的：`readPersistedSession` 打开短生命周期读句柄（`packages/experimental/agent-team/src/persisted.ts:22-34`），用于 `checkpointInitialPrompt`（`packages/experimental/agent-team/src/roster.ts:332`）与 `reconcileProvisioning`（`:385`）。

**仅内存：**

- `TeamActivity.waiters`（一次性 wait 的等待者集合，`packages/experimental/agent-team/src/activity.ts:12`），dispose 时全部唤醒并清空（`packages/experimental/agent-team/src/activity.ts:79-86`），不入日志。
- `TeamRuntimeLifecycle.operations` 与 `AbortController`（`packages/experimental/agent-team/src/lifecycle.ts:7-8`）。
- `TeamJournal.tails` 的每 Lead 串行队列（`packages/experimental/agent-team/src/journal.ts:13`）。
- `teamProjectionViews` 这个 `WeakMap` 客户端视图缓存（`packages/experimental/agent-team/src/projection.ts:340`）。
- 成员的 `running`/`inactive` 状态：只来自 live Agent registry，不落库（`packages/experimental/agent-team/src/roster.ts:475-477`）。

**失败是终止性的：** 投影遇到无效持久记录时，`applyProjectionEvent` 之后所有事件都返回同一个（含 `failure` 的）状态引用、不再重投影（`packages/experimental/agent-team/src/projection.ts:226` 早退；测试 `packages/experimental/agent-team/tests/projection-events.spec.ts:476` 断言 `apply(failed, queuedEvent) === failed`）；`teamProjectionView` 在此态返回上一份有效 members/tasks + `failure`（`packages/experimental/agent-team/src/projection.ts:372`、`:342-361`）；`TeamJournal.state()` 读到 `failure` 直接抛错（`packages/experimental/agent-team/src/journal.ts:32`）。

> 细节（本轮新增，源码级观察，无测试断言）：`failure` 态下 `teamProjectionView` **未走** `teamProjectionViews` 缓存，每次调用都会 `buildTeamProjection` 新建对象（`packages/experimental/agent-team/src/projection.ts:372` 对比 `:373-383`）。发布不重复的原因是**状态引用**不变、驱动只在状态变化时取 view，而不是 view 对象本身被缓存。

## 6. 文档 / 代码漂移与观察

1. **消息模型已换代但类型名未变**：`types.ts` 仍保留 `TeamMessageSnapshot` 与 `team/message/queued`/`delivered`，注释自认 "Historical mailbox enqueue"（`packages/experimental/agent-team/src/types.ts:233`；delivered 注释 `:235`），实际发送走 target Agent inbox（`packages/experimental/agent-team/src/index.ts:237-245`）。README 与子系统文档表述一致（`packages/experimental/agent-team/README.md:12` 的 Summary、`docs/subsystems/agent-team.md:28`），但只读 `types.ts` 容易误以为 Team 自己有出站队列。
2. **README 的恢复条件比代码弱**：README 只说 "a matching direct-parent and continuable descriptor plus a recorded initial user message produces `active`"（`packages/experimental/agent-team/README.md:126`），代码还要求 `descriptor.provider === member.provider`（`packages/experimental/agent-team/src/roster.ts:389-392`）。README 未提 provider 匹配，属可读性偏差而非行为冲突。
3. **`model` 标签来源：已可证实，且服务端与客户端是两条不同路径**（原草稿标 UNVERIFIED，本轮解决）：
   - Web 客户端确实取成员自身 Session 的 `modelSelection` 投影：`useSessions(state => state.projectionsBySession[member.id]?.values.modelSelection?.next?.model)`（`packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx:81`），与 `docs/subsystems/agent-team.md:80` 一致。
   - 服务端 `list_agents` 的 `TeamMemberView.model` 另走 Agent options（**更正（verifier 检查 3）**：不存在 `list_members` 工具，工具名为 `list_agents`，`packages/experimental/tool-agent-team/src/index.ts:239`；服务方法为 `listMembers`，`packages/experimental/agent-team/src/roster.ts:126`）：Lead 行取 `root.options.model`（`packages/experimental/agent-team/src/roster.ts:134`），队友行取 `live?.options.model ?? root.options.model`（`:139`）。
   - **子项更正**：`memberView()`（`spawn_teammate` 的返回值）只用 `live?.options.model`，**没有** root fallback（`packages/experimental/agent-team/src/roster.ts:430`），与 `list()` 的 `:139` 不完全对称。
4. **"inactive" 措辞无漂移**：工具策略文案 "inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents"（`packages/experimental/tool-agent-team/src/index.ts:41`）与 `availability()` 实现一致（`packages/experimental/agent-team/src/roster.ts:475-477`）；`docs/subsystems/agent-team.md:24` 也明确 "Roster `running`/`inactive` status is derived separately and never rewrites this record"。
5. **`createTask` 的 JSDoc 说 "in the Team Lead log"**（`packages/experimental/agent-team/src/task-board.ts:39`）指**存储位置**在 Lead 日志；调用者可为任意成员（`packages/experimental/agent-team/src/index.ts:159-161`），不构成权限漂移，但字面易误读为 Lead-only。`TeamService.createTask` 自己的 JSDoc 已写 "exact live Team member creating the task"（`:155`）。

## 7. 本轮更正清单

对上一轮 01 草稿中**行号不精确或表述有误**的断言逐条更正（"原"→"改"）：

| #   | 原断言                                                                                            | 核对结果                                                                                                | 更正                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `TeamState.id` 依据 `projection.ts:131-138`                                                       | 131-138 是 `TeamState` 接口（含 `id: TeamId`），但"等于根 Session id"的构造在别处                       | 补 `projection.ts:145-153`（`emptyTeamState`）与 `:391`（`init: header => emptyTeamState(header.id)`）      |
| 2   | `availability` 在 `roster.ts:474-477`                                                             | `:474` 是 JSDoc，函数体为 475-477                                                                       | 改为 `roster.ts:475-477`（引用整体时注明 474 为注释）                                                       |
| 3   | `list()` 状态派生 `roster.ts:143-148`                                                             | `:143` 是 `role:` 字段，分支在 144-148                                                                  | 改为 `roster.ts:144-148`                                                                                    |
| 4   | `checkpointInitialPrompt` 在 `roster.ts:322-372`                                                  | `:322` 是 JSDoc，函数体 323-372                                                                         | 改为 `roster.ts:323-372`                                                                                    |
| 5   | `settleProvisioning` 在 `roster.ts:446-465`                                                       | `:446` 是 JSDoc，函数体 447-465                                                                         | 改为 `roster.ts:447-465`                                                                                    |
| 6   | `reconcileProvisioning` 在 `roster.ts:375-416`                                                    | 函数收尾 `}` 在 417                                                                                     | 改为 `roster.ts:375-417`                                                                                    |
| 7   | `memberName` 在 `roster.ts:435-444`                                                               | `:435` 是 JSDoc，函数体 436-444                                                                         | 改为 `roster.ts:436-444`                                                                                    |
| 8   | `task-board.create` 快照在 `task-board.ts:44-64`                                                  | `create` 整个方法 44-69；快照构造在 56-64                                                               | 拆分引用：方法 `:44-69`、快照 `:56-64`                                                                      |
| 9   | 投影 deleted 过滤 `projection.ts:354-358`                                                         | 过滤/映射在 356-358；354-355 是 return 起始与 `members`                                                 | 改为 `projection.ts:356-358`                                                                                |
| 10  | `TeamProjectionState` 在 `projection.ts:156-159`                                                  | `:156` 是 JSDoc，接口 157-159                                                                           | 改为 `projection.ts:157-159`                                                                                |
| 11  | CAS "对 deleted 任务先抛 `TEAM_TASK_DELETED`"（`task-board.ts:113-121`）                          | 实际顺序是 存在 →revision CAS→deleted                                                                   | 更正为：`TEAM_TASK_STALE_REVISION` 先于 `TEAM_TASK_DELETED`；只有传删除态 revision 才得 `TEAM_TASK_DELETED` |
| 12  | `TeamMemberView.model` 取 `live?.options.model ?? root.options.model`，引 `roster.ts:134,139,430` | `:430`（`memberView`）只有 live model、无 root fallback                                                 | 更正：fallback 仅存在于 `list()` 的 `:139`；`memberView` 见 `:430`                                          |
| 13  | `model` 标签来源标 `UNVERIFIED`（`docs:80` vs `roster.ts`）                                       | `packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx:81` 证实客户端取 `modelSelection` | 由 UNVERIFIED 改为**已解决**（服务端/客户端两条路径）                                                       |
| 14  | §4 "blocker 均存在且可满足的 DAG"                                                                 | "可满足/可行性"非该函数保证                                                                             | 收紧为"存在且非 deleted、无重复、无环"；不提供拓扑序/调度/可行性保证                                        |
| 15  | 测试引用 `team.spec.ts:636-650`                                                                   | claim 相关断言在 640/643/650；606 才是测试起点                                                          | 建议引 `team.spec.ts:640-650`（测试标题在 `:606`）                                                          |

另有 3 处**草稿正确**但证据可加强：README 行号 `packages/experimental/agent-team/README.md:126`、`packages/experimental/agent-team/README.md:140`、`docs:28` 均核对无误；`packages/experimental/agent-team/README.md:12` 亦确为 Summary 段。

## 8. 已解决 / 仍开放的开放问题

**已解决（草稿 §7 的 3/5）：**

1. **模型层权限（原 §7-3，草稿标 UNVERIFIED）— 已解决。** `tool-agent-team` 的工具安装按 Team 身份门控：只有 `ctx.agentTeams.tryMembership(agent) !== undefined` 的 Agent 才安装（`packages/experimental/tool-agent-team/src/index.ts:419`；`maybeInstall` 定义在 `:418-421`，注册/清理在 `:422-427`，effect 在 `:428-431`）。工具 schema **不做 action 级角色过滤**：`spawn_teammate`（`:193-207`）、`interrupt_agent`（`:284-293`，可配置关闭，`:18`、`:28`）、`update_task` 的 `action` 枚举含 `reassign`（`:378`）对任意已安装成员都可见/可调。角色约束一律在服务端执行：`spawn` 非 Lead → `TEAM_LEAD_REQUIRED`（`packages/experimental/agent-team/src/roster.ts:234-236`）、`interrupt` 非 Lead → `TEAM_LEAD_REQUIRED`（`:189`）、`reassign` 非 Lead → `TEAM_LEAD_REQUIRED`（`packages/experimental/agent-team/src/task-board.ts:173`）。
2. **`maxMembers` 名额回收（原 §7-2）— 已解决：不存在回收路径。** `TeamService` 公开面只有 `membership/listMembers/spawnTeammate/sendMessage/createTask/getTask/listTasks/updateTask/waitForChange/interrupt/tryMembership`，**没有任何删除/回收成员的方法**（`packages/experimental/agent-team/src/index.ts:116-221`）；上限判定使用 `state.members.length`（含 failed，`packages/experimental/agent-team/src/roster.ts:257`）。测试确认 failed 成员占名额且名字不可复用（`packages/experimental/agent-team/tests/team.spec.ts:331-342`）。README 亦述 "Names are reserved by the first provisioning record and never reused"（`packages/experimental/agent-team/README.md:126`）。回收属有意缺席，不是遗漏的实现细节。
3. **Lead 作为 owner 的表示一致性（原 §7-5）— 已解决且有断言。** `claim` 直接写 `ownerId = caller.id`（`packages/experimental/agent-team/src/task-board.ts:136`），Lead 即 `root.id`；`projectTaskView` 把 `ownerId === state.id` 映射为 `'lead'`（`packages/experimental/agent-team/src/task-view.ts:38-42`，判断在 `:40-41`）。测试 `expect(leadClaim.ownerName).toBe('lead')`（`packages/experimental/agent-team/tests/team.spec.ts:829`）已锁定该一致性。

**仍开放：**

1. **跨进程并发（原 §7-1）— `UNVERIFIED`。** 仍开放。CAS + `TeamJournal.transact` 只保证**单进程**内按 Lead id 串行（`packages/experimental/agent-team/src/journal.ts:42-52`）；多进程同时向同一 Lead Session 追加 Team 事件的冲突语义（Session 日志本身的并发 append 语义、flush 交错）在本包源码与测试中均无描述。已有测试只覆盖单进程内 task 提交与直发消息的并发交错（`packages/experimental/agent-team/tests/team.spec.ts:1005`）。**为何不能回答**：这属于 dsh-session/session-persistence 的写入语义，超出 agent-team 包；本包未声明该保证。
2. **`ownerName` 缺失情形（原 §7-4）— 部分 `UNVERIFIED`。** 部分开放。可证实的部分：`projectTaskView` 用 `state.members.find(...)?.name`，找不到时 `ownerName` 为 undefined 且 view **静默省略**该字段（`packages/experimental/agent-team/src/task-view.ts:42`、`:58`）；而投影反序列化对 `ownerId` 只要求"非空字符串"（`packages/experimental/agent-team/src/projection.ts:83` 的 `sessionIdSchema.optional()`），并不校验它一定指向 roster 成员。因此**重放外部/损坏日志时**该情形可合法出现。仍开放的是：是否存在测试或契约明确排除它——没有；测试已断言 `ownerName: 'lead'` 与 worker 名两条正路径（`packages/experimental/agent-team/tests/projection-events.spec.ts:504`、`packages/experimental/agent-team/tests/team.spec.ts:829`），**没有任何 ownerId 悬空的用例**。**为何不能回答**：源码未定义这是被支持的合法状态还是仅未设防的退化输入。
3. **`failure` 态 view 未缓存（本轮新增，源码级观察）。** `teamProjectionView` 在 `failure` 态每次调用重建视图（`packages/experimental/agent-team/src/projection.ts:372`），未复用 `teamProjectionViews` 缓存；现有测试只断言事件层状态引用不变（`packages/experimental/agent-team/tests/projection-events.spec.ts:476`），未断言 view 对象同一性。是否属于有意的"失败态每次重新派生"尚无注释说明 → 保留为开放观察。
