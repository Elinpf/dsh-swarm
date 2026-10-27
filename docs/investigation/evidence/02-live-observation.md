# evidence/02：本次会话的活体观察（**旁证，非源码证据**）

> 按任务要求：本会话自身是一个运行中的 team，观察到的行为只作旁证，不得当主证据。
> 所有源码结论仍在正文中带 `path:line`。

## O1. 我实际可用的 team 工具面（观察）

本次会话（teammate `tools-messaging`）模型侧可见的 team 相关工具：

```
spawn_teammate, send_message, list_agents, wait_agent, interrupt_agent,
team_task_create, team_task_list, team_task_get, team_task_update,
broadcast, multicast, team_summary
```

**未见** `review_submit` / `review_vote` / `workspace_lock` / `workspace_unlock` /
`workspace_worktree` / `skills_visible` / `memory_recall`。

与 E3 的配置推断（bundle 只开 enableBroadcast，enableReview=false，其余默认 false）一致，
也与仓内既有观测 `docs/profile-e2e.md:134-137` 一致。

## O2. `multicast` 按成员**名**寻址失败（活体探针）

1. `list_agents({})` 返回（观察）：`lead`(running)、`core-model`(running)、`tools-messaging`(running)、
   `wiring-ui`(running)、`auditor`(inactive) —— 每行只有 `target`（= 成员名），**没有 id 字段**。
2. 调用：`multicast({ targets: "auditor", content: "[probe] ..." })`
3. 返回：

```
Error: TEAMBUS_UNKNOWN_TARGET: unknown target auditor
```

该错误在 `team-bus/src/index.ts:230` 抛出，位于任何 `durable.push`（`:247`）与 `fanout`（`:256`）**之前**，
因此本次探针**无任何落库、无任何投递、未唤醒任何成员**（零副作用）。

结论（源码 + 探针一致）：`multicast` 的 targets 按 `listMembers().id`（SessionId/UUID）匹配
（`team-bus:224,228-230,319`），而工具描述与 `list_agents` 只提供**成员名**
（`tool-swarm:138,141`；`[H] tool-agent-team/src/index.ts:68-71`）。模型无法拿到 id，
故该工具在真实拓扑下不可用。

## O3. 我被 spawn 的体验（观察）

我是被 `spawn_teammate({ context: 'fresh' })` 创建的：初始 prompt 里没有 Lead 的历史轮次，
只有任务描述 + 会话约定。与 `[H] tool-agent-team/src/index.ts:202`（`fresh starts without Lead history`）
和 `:214`（`context === 'fork' ? forkProvider : freshProvider`）的描述一致。

## O4. 未做的实验（避免破坏他人任务）

- 未对 `broadcast` 做活体投递（会给全部队友发 DM）。
- 未对 `delivery: 'quiet'` 做活体对照（需要投递到真人）。
- 未 claim / complete 任何他人的 task，未 interrupt 任何成员。
