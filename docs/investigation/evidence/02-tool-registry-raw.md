# evidence/02：工具面注册原始证据（复核用）

> 本文件只放**可复核的原文摘录 + 行号**，结论写在 `../02-tools-and-messaging.md`。
> 复核方式：`read <path>` 后核对行号；长文件用 offset/limit 定位。

## E1. harness 基础层：`[H] packages/experimental/tool-agent-team/src/index.ts`

9 个 `defineTool` 注册点（`grep -n "name: '"` 结果，逐条 read 确认）：

| 工具             | `name:` 行 | defineTool 块 | execute 行 |
| ---------------- | ---------- | ------------- | ---------- |
| spawn_teammate   | 193        | 192-219       | 206-218    |
| send_message     | 222        | 221-237       | 229-236    |
| list_agents      | 240        | 239-247       | 244-246    |
| wait_agent       | 250        | 249-282       | 259-281    |
| interrupt_agent  | 286        | 285-295       | 292-294    |
| team_task_create | 299        | 298-320       | 312-319    |
| team_task_list   | 323        | 322-352       | 337-351    |
| team_task_get    | 355        | 354-367       | 361-366    |
| team_task_update | 370        | 369-400       | 388-399    |

配置开关（`:27-31`）：

```
27: export const Config: z<Config> = z.object({
28:   interrupt: z.boolean().default(true),
29:   freshProvider: z.string().default('spawn'),
30:   forkProvider: z.string().default('fork'),
31: })
```

无条件注册的唯一开关点（`:284`）：`if (config.interrupt) {` 包住 interrupt_agent。

`wait_agent` 的 noProgress 短路（`:264-280`）：

```
264: if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
265:   return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
266: }
267: // The active-peer read and waiter registration must remain one synchronous
268: // span; awaiting between them can lose the only peer-status edge.
269: const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
270:   member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))
271: if (!hasActivePeer) {
272:   return { timedOut: false, noProgress: { reason: 'no-active-peer' as const, message: NO_ACTIVE_PEER_MESSAGE } }
279: }
280: return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
```

`ACTIVE_WAIT_STATUSES`（`:44`）：`new Set(['running', 'provisioning'])`。

模型侧 roster 投影：`modelMember` 丢弃 `id` 只留 `name` 作 `target`（`:67-71`）：

```
68: function modelMember(member: TeamMemberView): InferValue<typeof MEMBER_VIEW_SCHEMA> {
69:   const { id: _id, name, ...details } = member
70:   return { target: name, ...details }
71: }
```

`enum` 用于参数约束的样例（`:326-330`、`:375-379`）。

## E2. 产品层：`[S] packages/tool-swarm/src/index.ts`（**唯一**注册模型工具的产品包）

`grep -rn "name: '" packages/tool-swarm/src/index.ts`：

| 工具               | `name:` 行 | 生效条件                                     | 依赖服务读取                        |
| ------------------ | ---------- | -------------------------------------------- | ----------------------------------- |
| broadcast          | 106        | `config.enableBroadcast && bus`（`:102`）    | `ctx.get('teamBus')`（`:79`）       |
| multicast          | 135        | 同上                                         | 同上                                |
| review_submit      | 169        | `config.enableReview && review`（`:165`）    | `ctx.get('teamReview')`（`:82`）    |
| review_vote        | 183        | 同上                                         | 同上                                |
| team_summary       | 221        | **仅 `if (core)`（`:217`），无 Config 开关** | `ctx.get('teamCore')`（`:85`）      |
| workspace_lock     | 247        | `config.enableWorkspace && ws`（`:243`）     | `ctx.get('teamWorkspace')`（`:88`） |
| workspace_unlock   | 268        | 同上                                         | 同上                                |
| workspace_worktree | 284        | 同上                                         | 同上                                |
| skills_visible     | 301        | `config.enableSkills && skills`（`:297`）    | `ctx.get('teamSkills')`（`:95`）    |
| memory_recall      | 319        | `config.enableMemory && mem`（`:315`）       | `ctx.get('teamMemory')`（`:98`）    |

Config 默认值（`:47-53`）：enableBroadcast=true，enableReview/enableWorkspace/enableSkills/enableMemory=**false**。

硬 `inject`（`:25-32`）含 `teamReview`：

```
25: export const inject = [
26:   'agents', 'teamCore', 'teamBus', 'teamReview', 'tools', 'systemPrompt',
27: ] as const
```

`multicast` 参数声明（`:136-145`）——**描述说是 name，实现按 id 匹配**：

```
136: description: 'Send a message to specific teammates (comma-separated names).'
138: targets: { type: 'string', required: true, description: 'Comma-separated member names.' }
144: delivery: { type: 'string', description: 'quiet | wakeup' }
```

`delivery`/`topic`/`fanout`/`mode`/`decision`/`role` 均为裸 `type: 'string'`，**无 `enum`**，
仅把取值写进 description（`:110-116,144,188-194,251`）。

`workspace_lock` 的 mode 静默强制（`:258`）：`mode: String(args.mode) === 'shared' ? 'shared' : 'exclusive'`。

## E3. 组合层：`[S] packages/bundle/cordis.patch.yml`（bundle patch 是运行时配置的唯一来源）

> 快照：本文件在本次核查时共 112 行，`md5 = 146e6d533af3c641cbf8923eec2aed1d`。
> 该文件在会话期间被其他任务改动过（`git status` 显示 M，注释行插入在 `:19-23`）；
> 下列行号对**该快照**成立。若文件再变，需以 grep 重新定位而非沿用行号。

被 demo profile 引用方式（`.runtime/dsh-home/profiles/dsh-swarm-demo/package.json`）：

```json
"dsh": { "profile": { "bundles": [ ... "@elinpf/dsh-swarm-bundle", ... ] } }
```

且 `node_modules/@elinpf/dsh-swarm-bundle -> ../../../../../../packages/bundle`（符号链接，config 即上面那份）。

`tool-swarm` 行（`:66-70`）**只设了两个开关**：

```
66:     - id: tool-swarm
67:       name: '@elinpf/dsh-swarm-tool-swarm'
68:       config:
69:         enableBroadcast: true
70:         enableReview: false
```

阶段 2 的供给服务均已插入（`:73-88`：team-workspace / team-skills / team-memory），
但**没有**打开 `enableWorkspace/enableSkills/enableMemory`。

## E4. 各工具背后的服务提供包（均无自己的模型工具注册）

`grep -rn "ctx.tools.register" packages/*/src/` 只命中 `tool-swarm`（与 example-plugin）：

- broadcast/multicast → `packages/team-bus/src/index.ts`（`TeamBusService`，default export）。
- team_summary → `packages/team-core/src/index.ts`（`listTasks`/`listMembers`）。
- review_submit/review_vote → `packages/team-review/src/index.ts`（`submitForReview:109`、`vote:130`）。
- workspace\_\* → `packages/team-workspace/src/index.ts`（`acquireLock:156`、`releaseLock:181`、`createWorktree:132`；`enforceWriteGuard:49,203`）。
- skills_visible → `packages/team-skills/src/index.ts`（`visibleTo:166`）。
- memory_recall → `packages/team-memory/src/index.ts`（`recall:93`）。

`team_task_*` / `spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent`
→ **只有 harness** `tool-agent-team` 注册（`[H] .../tool-agent-team/src/index.ts`），产品层不重复注册。

## E5. 仓内既有「模型侧工具面」观测（旁证，非本次实验）

`docs/profile-e2e.md:134-137` 记录的真实模型自报工具列表：

```json
[
  "broadcast",
  "interrupt_agent",
  "list_agents",
  "multicast",
  "send_message",
  "spawn_teammate",
  "team_summary",
  "team_task_create",
  "team_task_get",
  "team_task_list",
  "team_task_update",
  "wait_agent",
  "workflow"
]
```

无 `review_*`、`workspace_*`、`skills_visible`、`memory_recall` —— 与 E3 的配置推断一致。
