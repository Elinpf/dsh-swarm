# 2. Team 模式：工具面与消息投递语义（源码实证）

> 证据约定：本次调查涉及**两个代码根**，正文用前缀区分，`:line` 为文件内行号。
>
> - `[H]` = harness checkout `.runtime/deepseek-harness`（上游、只读）。
> - `[S]` = 工作区根 `dsh-swarm`（实际运行的产品插件；harness checkout 中不存在）。
>
> 我自己的模型侧工具说明**不作为证据**；下面每条结论都给出实现行号，并在 §5 列出与
> 模型侧描述的出入。

## 2.0 两个工具层：harness 基础层 vs 运行产品层

- `[H] packages/experimental/tool-agent-team/src/index.ts` 只注册 9 个工具：
  `spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、
  `team_task_{create,list,get,update}`（`:192-400`）。源码全文无 `multicast`、`broadcast`、
  `team_summary`。
- 我在本会话看到的 `multicast` / `broadcast` / `team_summary` / `review_*` / `workspace_*`
  来自产品层 `[S] packages/tool-swarm/src/index.ts:102-320`（受 `enableBroadcast` 等
  Config 开关控制，`:102,165,243`；**更正（verifier 检查 5）**：`:217` 是 `if (core)` 的 service 可用性判断，不是 Config 开关），消息扇出由 `[S] packages/team-bus/src/index.ts` 提供。
- 因此“Team 工具面”是**组合的**：harness 提供 roster/task/等待原语，产品层在其上叠加总线类工具。
  只读 harness 会得出错误的工具清单（§5 第 1 条）。

## 2.1 工具清单（参数 → 实际动作 → 变更的状态）

harness 基础层（`[H] tool-agent-team/src/index.ts`）：

| 工具                          | 参数（source）                                                                       | 实际动作                                                      | 变更状态                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `spawn_teammate` `:192-219`   | name/description/prompt/context(`fresh`\|`fork`)                                     | `agentTeams.spawnTeammate`，`context` 决定 provider（`:214`） | Lead Session 追加 `team/member`（provisioning→active/failed） |
| `send_message` `:221-237`     | target/message                                                                       | `agentTeams.sendMessage`（sender 由 `exec.agent` 提供）       | 目标 Agent inbox（splice 事件），非 Team 事件                 |
| `list_agents` `:239-247`      | 无                                                                                   | `roster.list(membership)`，`id` 改名为 `target`（`:68-71`）   | 只读；status 由实时 Agent 状态派生                            |
| `wait_agent` `:249-282`       | timeout_ms（默认 30000）                                                             | 活跃 peer 短路，否则 `waitForChange`                          | 只注册内存 waiter                                             |
| `interrupt_agent` `:284-296`  | target                                                                               | `roster.interrupt`（Lead-only，`:189`）                       | 取消目标当前 turn，保留 inbox                                 |
| `team_task_create` `:298-320` | subject/description/blocked_by/write_scopes                                          | `tasks.create`                                                | Lead Session `team/task` rev1                                 |
| `team_task_list` `:322-352`   | status/owner/ready/cursor/limit                                                      | 内存过滤 + 分页                                               | 只读                                                          |
| `team_task_get` `:354-367`    | task_id                                                                              | 读取（含删除墓碑）                                            | 只读                                                          |
| `team_task_update` `:369-400` | task_id/expected_revision/action(+subject/description/blocked_by/write_scopes/owner) | CAS 事务                                                      | Lead Session `team/task` rev+1                                |

产品层新增（`[S] tool-swarm/src/index.ts`）：`broadcast`（`:106-129`，topic/delivery/fanout）、
`multicast`（`:135-159`，targets 逗号分隔 + delivery）、`review_submit`/`review_vote`
（`:169-214`）、`team_summary`（`:221-240`，成员数 + 任务状态直方图）、`workspace_lock/unlock/worktree`、
`skills_visible`、`memory_recall`（`:243-320`，均带各自的 Config 开关）。

## 2.2 一条消息到底怎么走

入口 `[H] agent-team/src/index.ts:145-151`：`sendMessage` 只做“运行期是否已处置”检查，
然后 `lifecycle.track(sendAdmitted(...))`（`lifecycle.ts:55-59` 把操作记入内存集合，供卸载时结算）。
核心是 `sendAdmitted`（`:224-248`）：

1. 解析调用者 membership，再 `resolveActiveMember(root, journal.state(root), target)`
   （`roster.ts:42-54`）。`lead` 恒解析为 root（`:48`）；队友必须 `phase === 'active'`，
   否则抛 `TEAM_MEMBER_NOT_FOUND`（`:50-52`）。**provisioning 的目标无法发送**。
2. 自投递拒绝：`target.id === caller.id` → `TEAM_SELF_MESSAGE`（`:229`）。
3. 正文加前缀 `Team message from <name>:`（`:231`），按 `JSON.stringify` 的 UTF-8 字节数
   限长（`:234-236`，默认 65536，`index.ts:62`）。
4. 固定 source：`{ kind:'agent-message', form:'relay', senderSessionId: caller.id }`（`:237`）。

投递分两条支路：

- **目标是 Lead**：`root.steer(createUserMessage(...))`（`:240-242`）。
  `steer` = `send(msg, 'next-step', wakeup=true)`（`[H] core/agent-loop/src/agent.ts:167-169`，
  以及 `core/agent/src/runtime-types.ts:224-231` 的契约注释）。
- **目标是队友**：`steerHostSubagentPrompt`（`:244`）→ `[H] subagent/subagent/src/internal.ts:94-109`
  以 `delivery:'steer'` 进入 manager → `steerPrompt`（`manager.ts:604-612`）→
  `deliverToChild`（`:1230-1244`）。

“最近 step 边界”的代码含义：`agent.ts:154-161` 把消息 splice 进 `next-step` 列表并唤醒 driver；
driver 在每个 step 前调用 `claim`（`inbox.ts:109-114`）**一次性取走全部 next-step**（外加至多 1 条
next-turn）；`agent.ts:361-366` 显示 step 结束后若 `nextStep` 非空则不结束 turn，而是把
`target` 改成 `next-step` 继续下一 step。也就是说：**运行中的目标在自己的下一个 step 边界收到它，
不会打断当前 step**。

**inactive 目标**：`deliverFollowup` 先查 resident Activation（`manager.ts:1254-1256`），
不在则 `coldResume`（`:1329-1384`）：读取持久化 Session → 要求 `foldSubagentDescriptor` 为
`continuable`（`:1349-1355`）→ `materialize` 重建 Agent → `submitAdmitted` 投递。
这正是“inactive 会 start/resume”。`submitAdmitted`（`:1418-1437`）在投递后 `wake(activation)`
（`:1434`），resident 分支最终落到 `agent.steer`（`:626`）。

**provisioning**：`roster.list` 把 `phase==='provisioning'` 映射为 status `provisioning`
（`roster.ts:144-148`），但投递解析要求 `active`，所以“运行期创建中”是可见但不可达的状态。

## 2.3 `delivery: quiet | wakeup` 的真实差异

- harness 的 `send_message` **没有** `delivery` 参数（`[H] tool-agent-team/src/index.ts:224-227`），
  永远走 `steer`，即 `wakeup=true`。
- 唤醒位确实存在于 Agent 层：`send(message, target, wakeup)`（`runtime-types.ts:215`），
  `steer`/`followup` 传 `true`，`inject` 传 `false`（`agent.ts:163-173`）。`wakeup=false` 只把
  内容放进 `next-step`，不唤醒 driver；idle 的 driver 会一直留着它，直到别的 followup/steer 唤醒。
- 产品层把 `delivery` 暴露成工具参数（`[S] team-bus/src/index.ts:41,63,70`；
  `[S] tool-swarm/src/index.ts:111,144,156`），但 `team-core.send` 的签名收了 `delivery`
  却**完全没用它**，直接调 `seam.sendMessage`（`[S] team-core/src/index.ts:271-289`），
  而 seam 就是 §2.2 的 harness `sendMessage`。因此**当前 quiet 与 wakeup 行为完全相同，始终唤醒**。
  这是本次调查最实质的一处“描述与实现不符”（§5 第 2 条）。

## 2.4 顺序、并发与自过滤

- **投递顺序**：同一队友的投递由 per-child 锁串行（`manager.ts:1254` `this.locks.run(childId, …)`）；
  Lead 的 inbox 是单线程 splice 追加（`agent.ts:159` splice 到末尾），调用先后即 inbox 顺序。
- **Team 不做队列**：`team.spec.ts:931-958`“passes concurrent attempts to the lower delivery owner
  without a Team queue”明确记录：并发 `sendMessage` 不经过 Team 级队列，直接下发给 subagent 层；
  被 mock 的 deliverer 阻塞第一次后，第二次仍被立即受理。
- **Team 域事务**：只有 roster/task 的读-改-写走 `TeamJournal.transact`，按 Lead SessionId 串行
  （`journal.ts:42-52`）。
- **自过滤**：harness 层拒绝自投递（`:229`）。总线层 `broadcast` 显式 `filter(m => m.id !== sender.id)`
  （`[S] team-bus/src/index.ts:188`），`history` 也跳过自己发的（`:312`）。
  **但 `multicast` 的 `assertTargets` 不排除调用者**（`:364-389`），若 targets 含自己，
  会一路走到 harness `TEAM_SELF_MESSAGE`；而 `deliver` 把异常吞成 warn（`:327-334`），
  结果 multicast 仍返回成功，只是自己那条**静默丢失**。
- **发送即返回**：`SendTeamMessageResult` 注释写明“no Team retry or deduplication”，
  收到的是 inbox 身份，不代表已处理（`[H] agent-team/src/types.ts:186-189`；
  `index.ts:143`）。发送路径也**不 flush 目标 Session**；测试必须显式 `ctx.sessions.flush`
  才能读回持久化消息（`team.spec.ts:922-928`）。所以存在窗口：`sent:true` 之后、目标持久化或
  读取之前崩溃/卸载，消息可能丢失；接收方也只在下一个 step 边界才真正看到它。

## 2.5 `wait_agent`：注册什么、何时返回、为何立即 `noProgress`

- 工具实现 `[H] tool-agent-team/src/index.ts:249-282`：先算 `hasActivePeer` ——
  `listMembers(caller)` 中 `id !== caller.id` 且 status ∈ {running, provisioning}（`:44,269-271`）。
  没有活跃 peer 就**不注册**，直接返回 `{timedOut:false, noProgress:{reason:'no-active-peer'}}`（`:271-279`）。
- 有 peer 才调 `waitForChange` → `TeamActivity.wait`（`activity.ts:22-66`）：
  在 `Map<TeamId, Set<Waiter>>` 注册一个一次性的 waiter，配 `setTimeout` 与 abort 监听；
  超时 resolve(false) → `{timedOut:true}`；abort 抛 `TEAM_WAIT_ABORTED`；`closed` 时立即
  `{timedOut:false}`（`:27`）。timeout 越界抛 `TEAM_INVALID_TIMEOUT`（`:23-25`）。
- **什么唤醒它**（`notify(teamId)` 的三个来源）：
  1. 任一 Team 事件提交并 flush 成功后（`index.ts:89` 的 `onCommit`，覆盖 `team/member`、`team/task`）；
  2. 任一 Team 成员的 `agent/status` 迁移（`:94-97`）；
  3. 任一成功 `sendMessage` 结束后（`:246`，notify 的是**发送者所属 Team**，即 root id）。
     注意粒度是**整个 Team**：不区分“谁变了”，同一 Team 所有 waiter 一起被唤醒。
- **为什么能立即 `noProgress`**：wait 只能观察事件/状态边沿，且从不唤醒任何人；当除自己外没人
  running/provisioning 时，没有任何合法来源会产生新边沿，等待必然超时，所以短路省掉一次长等待。
- **等待中的 Lead 被谁唤醒**：队友 `send_message(target:"lead")` → `root.steer` + `notify`（`:240-246`），
  或队友状态迁移（`:94-97`）。这也解释了“消息先落 inbox，wait 先返回，Lead 下个 step 才消费”。
- **边沿触发**：注册前发生的变化不算数（`team.spec.ts:1124-1128` 用 fake timer 断言
  注册前的 createTask 不让 wait 提前返回）。HMR/卸载时 `close()` 唤醒全部 waiter（`activity.ts:79-86`，
  `team.spec.ts:1131-1133`）。

## 2.6 事件日志与投影：什么被记、什么只在内存

**被写入 Lead Session 日志（可重放）**：

- `team/member`：整条成员快照（name/provider/context 不可变，phase 只允许
  provisioning→active|failed，`projection.ts:250-268`）。
- `team/task`：整条任务快照，revision 必须连续 +1（`projection.ts:270-291`）。
- 两者是 `TeamJournal` 允许的**唯一** Team 事件类型（`journal.ts:9`），先 `session.append`
  再 `sessions.flush`，之后才 `onCommit` 通知 waiter（`journal.ts:60-72`）——即“提交点之后才发布”。

**已废弃的日志事件**：`team/message/queued` / `team/message/delivered` 的类型与投影规则仍在
（`types.ts:233-241`，`projection.ts:292-305`），注释直接写“Historical mailbox enqueue;
new sends use the target Agent inbox”；生产代码不再 emit，测试断言 Lead 日志里
`team/message/*` 为空（`team.spec.ts:907`）。旧的 `delivery:'quiet'` 只出现在 Session 格式
迁移的校验/测试里（`[H] session/session-format-v0-to-v1/src/payload-validation.ts:1031`）。

**投影**：`teamProjectionDefinition`（`projection.ts:387-394`，key `agentTeam`，stateVersion 4）
按 `teamId` 选择事件、要求 `version === 2`（`:229-234`）；校验失败会写入终态 `failure`
并冻结后续事件（`:226,235-238`）。对外 wire view 只有 roster + 非删除任务
（`:342-361`）；mailbox 类状态变化复用旧 view 引用（`:363-384`）。

**重启后重放**：Lead Session 日志重放即可重建 roster/task。`provisioning` 的悬挂项在
`agent/created` 后由 `scheduleRecovery`→`reconcileProvisioning`（`index.ts:251-259`，
`roster.ts:375-417`）单独收敛：读取持久化子 Session，要求 `continuable` 描述符且
初始 prompt 已被接受（`session-message.ts:25-31` 折叠 `agent/inbox/spliced` 判定），
否则标记 failed。

**只在内存**：`TeamActivity.waiters`（`activity.ts:12`）、`TeamRuntimeLifecycle.operations`
（`lifecycle.ts:7`）、`team-bus` 的 `durable[]`/`seq`/订阅表（`[S] team-bus/src/index.ts:108-111,268-272`）。
`team-bus` 的“落库”是 push 到内存数组再 `ctx.emit('swarm/bus/broadcast', …)`
（`:142-155,204-205`），而它的 `recover()` 监听的是 `session/event`（`:118-120`）。
在 `[S]` 工作区内我没有找到任何把 `swarm/*` emit 写进 Session 日志的桥接代码，
因此该“durable 事件”能否跨重启真正重放，取决于工作区之外的宿主桥（残留不确定项，见 §5）。

## 2.7 已知缺口与竞态（代码/测试可见）

1. **工具清单不等于源码清单**：模型侧同时看到 harness 与产品层工具；只读 harness 会漏掉
   `multicast/broadcast/team_summary/review_*`，且这些工具随 Config 开关出现/消失。
2. **`quiet` 是空转**：产品层暴露 `delivery`，`team-core.send` 丢弃它，最终永远 `steer`
   （唤醒）。
3. **provisioning 不可寻址**：`wait_agent` 把 provisioning 当作活跃 peer，`send_message`
   却拒绝它（`TEAM_MEMBER_NOT_FOUND`），两者对同一状态的处理不一致。
4. **multicast 无自过滤**：targets 含自己时静默丢一条，且整体仍报成功。
5. **发送先于处理/持久化返回**：`sent:true` 只代表 inbox splice 已入内存投影；
   崩溃窗口与“下个 step 才可见”都由接收方时序决定。
6. **`noProgress` 是预测而非保证**：检查活跃 peer 与注册 waiter 之间虽在同一同步片段内
   （`:267-280` 注释明确要求如此），但若第三方在返回后唤醒某个 inactive 成员，
   调用者已拿到 `noProgress` 且不会再被通知，必须按工具描述重新 `list_agents`。
7. **Team 级唤醒过宽**：任何成员的状态边沿或任何一次 send 都会唤醒该 Team 的所有 waiter，
   与“等待某个特定队友”的直觉不符。
8. **投影 schema 保留死事件**：`team/message/*` 的校验/投影仍在，但无人 emit；读代码容易误判
   消息仍走 mailbox。

## 2.8 残留不确定 / 未覆盖

- `swarm/*` durable 事件到 Session 日志的桥接层不在本次读取范围内，无法用源码证明其可重放。
- `[H] subagent/.../manager.ts` 的 `locks.run` 实现未展开（只确认了调用点），
  跨进程/多实例场景下的顺序保证未验证。
- 产品层 `team-transport` / `team-distributed` / `team-human` 的跨进程投递未纳入本次调查。
