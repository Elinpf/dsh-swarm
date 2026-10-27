# 2. Team 模式：工具面与消息投递语义（源码实证 · 复核版）

> 证据约定：本次调查涉及**两个代码根**，正文用前缀区分，`:line` 为文件内行号。
>
> - `[H]` = harness checkout `.runtime/deepseek-harness`（上游、只读）。
> - `[S]` = 工作区根 `dsh-swarm`（实际运行的产品插件；harness checkout 中不存在）。
>
> 规则：每条结论带 `path:line`；无法证实的标 `UNVERIFIED`。
> 本会话自身的 team 体验（被 spawn / list_agents / multicast 探针）集中放在
> `evidence/02-live-observation.md`，正文引用时一律标「**观察**」，只作旁证。
> 原始摘录见 `evidence/02-tool-registry-raw.md`、`evidence/02-delivery-and-wait-raw.md`。

---

## 2.0 两个工具层：harness 基础层 vs 运行产品层

- `[H] packages/experimental/tool-agent-team/src/index.ts` 注册 **9 个**工具，全部在
  同一 `install()`（`:168`）内、按 Agent scope 注册：`spawn_teammate`(`:192-219`)、
  `send_message`(`:221-237`)、`list_agents`(`:239-247`)、`wait_agent`(`:249-282`)、
  `interrupt_agent`(`:285-295`)、`team_task_create`(`:298-320`)、`team_task_list`(`:322-352`)、
  `team_task_get`(`:354-367`)、`team_task_update`(`:369-400`)。源码全文无 `multicast`、
  `broadcast`、`team_summary`。唯一开关是 `Config.interrupt`（`:27-31`，默认 true），
  只控制 `interrupt_agent`（`:284`）。
- `[S] packages/tool-swarm/src/index.ts` 是**产品层唯一注册模型工具的包**
  （全仓 `grep "ctx.tools.register" packages/*/src/` 只命中它与 example-plugin）。
  它注册 **10 个**工具，`broadcast/multicast`(`:102-163`)、`review_submit/review_vote`(`:165-215`)、
  `team_summary`(`:217-241`)、`workspace_lock/unlock/worktree`(`:243-295`)、
  `skills_visible`(`:297-313`)、`memory_recall`(`:315-331`)，均由各自开关 + 服务在场决定
  （`:47-53` 默认值）。

> **更正**：草稿称产品层工具「均带各自的 Config 开关」，**错误**。`team_summary` 只判断
> `if (core)`（`:217`），**没有 Config 开关**；`enableBroadcast` 只覆盖 broadcast/multicast。
>
> **更正**：草稿把开关位置写成 `:102,165,217,243`（缺 `:297,:315`），且把 `:217` 当作开关；
> 真实开关点是 `:102`(`enableBroadcast`)、`:165`(`enableReview`)、`:243`(`enableWorkspace`)、
> `:297`(`enableSkills`)、`:315`(`enableMemory`)，`:217` 是**无开关**的 `if (core)`。

因此「Team 工具面」是**组合的**：harness 提供 roster/task/等待原语，产品层在其上叠加总线/评审/
工作区/技能/记忆工具。**并集 19 个，交集为空**（两层无同名工具）。

---

## 2.1 工具清单（参数 → 实际动作 → 变更的状态）

### 2.1.1 harness 基础层（`[H] tool-agent-team/src/index.ts`）

| 工具               | 参数（source）                                                                       | 实际动作                                                          | 变更状态                                                       | 证据                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `spawn_teammate`   | name/description/prompt/context(`fresh`\|`fork`)                                     | `agentTeams.spawnTeammate`；`context` 决定 provider               | Lead Session 追加 `team/member`（provisioning→active\|failed） | `:192-219`，`:208-216`；`roster.ts:243-261,297-320`                                         |
| `send_message`     | target/message                                                                       | `agentTeams.sendMessage`（sender 由 `exec.agent` 提供）           | 目标 Agent inbox（`agent/inbox/spliced`），**非 Team 事件**    | `:221-237`；`index.ts:224-248`                                                              |
| `list_agents`      | 无                                                                                   | `listMembers(caller)`，`id` 丢弃、`name` 改名为 `target`          | 只读；status 由实时 Agent 状态派生                             | `:239-247`，`:68-71`；`roster.ts:126-157`                                                   |
| `wait_agent`       | timeout_ms（默认 30000）                                                             | **无活跃 peer → 直接 noProgress（不注册）**；否则 `waitForChange` | 只在内存注册一次性 waiter                                      | `:249-282`，`:264-280`；`activity.ts:22-66`                                                 |
| `interrupt_agent`  | target                                                                               | `roster.interrupt`（Lead-only），保留 inbox                       | 取消目标当前 turn                                              | `:285-295`；`roster.ts:187-198`；开关 `Config.interrupt`(`:27-31,284`)                      |
| `team_task_create` | subject/description/blocked_by/write_scopes                                          | `tasks.create`                                                    | Lead Session `team/task` rev1                                  | `:298-320`                                                                                  |
| `team_task_list`   | status/owner/ready/cursor/limit                                                      | 内存过滤 + 分页（limit 1..100，默认 50）                          | 只读                                                           | `:322-352`，`:343-350`                                                                      |
| `team_task_get`    | task_id                                                                              | 读取（**含删除墓碑**）                                            | 只读                                                           | `:354-367`；`[H] agent-team/src/index.ts:164`（"including a deleted tombstone"）            |
| `team_task_update` | task_id/expected_revision/action(+subject/description/blocked_by/write_scopes/owner) | CAS 事务；`reassign` Lead-only                                    | Lead Session `team/task` rev+1                                 | `:369-400`；`task-board.ts:105-213`（陈旧 revision 在 `:116-120`，Lead-only 在 `:172-173`） |

> **更正**：草稿表格把 `wait_agent` 写成「活跃 peer 短路，否则 waitForChange」——**语义反了**。
> 真实逻辑是「**没有**活跃 peer 才短路返回 `noProgress`」，有活跃 peer 才注册 waiter
> （`:269-280`）。§2.5 正文写对了，表格写反了。

### 2.1.2 产品层（`[S] tool-swarm/src/index.ts`，服务在各自包内）

| 工具                 | 参数（source）                     | 实际动作                                                                    | 变更状态                                                                  | 证据                                 |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `broadcast`          | content/topic/delivery/fanout      | `teamBus.broadcast`：1 次落库 + 逐人 DM（或 record-only 仅订阅者）          | **内存** `durable[]` + `ctx.emit('swarm/bus/broadcast')` + N 个目标 inbox | `:102-131`；`team-bus:177-214`       |
| `multicast`          | targets(逗号分隔)/content/delivery | `teamBus.multicast`：N 条落库 + 逐目标 DM                                   | 同上（N 条）                                                              | `:132-162`；`team-bus:216-266`       |
| `review_submit`      | task_id                            | `teamReview.submitForReview`：入 `in_review`；**无评审池时直接 `complete`** | `team-core.reviewing` + durable `swarm/review/submitted`                  | `:165-180`；`team-review:109-128`    |
| `review_vote`        | task_id/role/decision/value        | `teamReview.vote`（不可自验）                                               | `ReviewState.votes` + durable `swarm/review/vote`                         | `:181-215`；`team-review:130-144`    |
| `team_summary`       | 无                                 | `core.listTasks` + `core.listMembers` 计数                                  | 只读                                                                      | `:217-241`                           |
| `workspace_lock`     | path/mode                          | `teamWorkspace.acquireLock`                                                 | 内存锁表（TTL）                                                           | `:243-264`；`team-workspace:156-179` |
| `workspace_unlock`   | lock_id                            | `teamWorkspace.releaseLock`                                                 | 释放锁                                                                    | `:265-279`；`team-workspace:181`     |
| `workspace_worktree` | 无                                 | `teamWorkspace.createWorktree`                                              | 建/切 git worktree                                                        | `:280-294`；`team-workspace:132`     |
| `skills_visible`     | 无                                 | `teamSkills.visibleTo`                                                      | 只读（并触发 scope 落层 reconcile）                                       | `:297-313`；`team-skills:166-171`    |
| `memory_recall`      | 无                                 | `teamMemory.recall`（共享 + 本人私有）                                      | 只读                                                                      | `:315-331`；`team-memory:93-96`      |

**生效条件的两点补充**（草稿未提，影响「工具在不在」的判断）：

1. `tool-swarm` 的 `inject` **硬依赖 `teamBus` 与 `teamReview`**（`:25-32`）。按 cordis 约定，
   `inject` 未全部就绪时插件整体不 apply —— 于是缺 `teamBus` 或 `teamReview` 会连
   `team_summary` 一起消失（而它本身并不需要这两个服务）。
2. 出厂 bundle `[S] packages/bundle/cordis.patch.yml:66-70` **只设** `enableBroadcast: true`、
   `enableReview: false`；`enableWorkspace/enableSkills/enableMemory` **未设 → 默认 false**
   （`:47-53`）。（该文件在会话期间被其他任务改动过，行号对 `md5=146e6d53…`（112 行）的快照成立，
   复核前请以 `grep -n "enableBroadcast\|enableReview" packages/bundle/cordis.patch.yml` 重新定位。）
   所以阶段 2 的三个供给服务虽然都插进了组合（`:73-88`），
   但 `workspace_*`/`skills_visible`/`memory_recall` **在生产组合中并不注册**。
   旁证：`docs/profile-e2e.md:134-137` 记录的真实模型工具面不含它们；
   **观察**：本会话模型侧同样看不到它们（`evidence/02-live-observation.md` O1）。

---

## 2.2 一条消息到底怎么走

入口 `[H] agent-team/src/index.ts:145-151`：`sendMessage` 只做「运行期是否已处置」检查，
然后 `lifecycle.track(sendAdmitted(...))`（`lifecycle.ts:55-59` 记入内存 `operations` 集合）。
核心是 `sendAdmitted`（`index.ts:224-248`）：

1. 解析调用者 membership，再 `resolveActiveMember(root, journal.state(root), target)`
   （`roster.ts:42-54`）。`lead` 恒解析为 root（`:48`）；队友必须 `phase === 'active'`，
   否则抛 `TEAM_MEMBER_NOT_FOUND`（`:50-52`）。**provisioning / failed 的目标无法发送**。
2. 自投递拒绝：`target.id === caller.id` → `TEAM_SELF_MESSAGE`（`:229`）。
3. 正文加前缀 `Team message from <name>:`（`:231`），再按 `JSON.stringify` 的 UTF-8 字节数
   限长（`:234-236`；默认 65536，`index.ts:44,62`）。
4. 固定 source：`{ kind:'agent-message', form:'relay', senderSessionId: caller.id }`（`:237`）。

投递分两条支路：

- **目标是 Lead**：`root.steer(createUserMessage(...))`（`:239-242`）。
  `steer` = `send(msg, 'next-step', wakeup=true)`（`[H] core/agent-loop/src/agent.ts:167-169`；
  契约注释 `core/agent/src/runtime-types.ts:224-231`；`send` 签名 `:215`）。
- **目标是队友**：`steerHostSubagentPrompt`（`:244`）→ `[H] subagent/subagent/src/internal.ts:94-109`
  以 `delivery:'steer'` 进入 manager（`:108`）→ `steerPrompt`（`manager.ts:604-611`）→
  `deliverToChild`（`:1230-1244`）→ `deliverFollowup`（`:1247-1281`）。

「最近 step 边界」的代码含义：`agent.ts:154-161` 把消息 `splice` 进 `next-step` 列表
（`Inbox.splice`，`inbox.ts:167-174`）并唤醒 driver；driver 在每个 step 前 `claim`
（`inbox.ts:109-114`）**一次性取走全部 next-step**（外加至多 1 条 next-turn）；
`agent.ts:361-366` 显示 step 结束后若 `next-step` 非空则把 `target` 改成 `next-step` 继续下一 step，
不结束 turn。即：**运行中的目标在自己的下一个 step 边界收到它，不打断当前 step**。

**inactive 目标**：`deliverFollowup` 先在 per-child 锁内查 resident Activation（`manager.ts:1254-1256`），
不在则 `coldResume`（`:1329-1384`）：`observeSession` 读持久化 → 要求 `foldSubagentDescriptor`
为 `continuable`（`:1349-1355`）→ `materialize` 重建 Agent → `submitMaterialized` →
`submitAdmitted` 投递（`:1401`）。`submitAdmitted`（`:1418-1437`）在 `deliver` 后
`wake(activation)`（`:1434`，在 `finally` 中）；resident 分支最终落到 `agent.steer`
（`deliver` → `manager.ts:626`）。这正是「inactive 会 start/resume」。

**provisioning**：`roster.list` 把 `phase==='provisioning'` 映射为 status `provisioning`
（`roster.ts:144-148`），但投递解析要求 `active`（`:50-52`），所以「创建中」是**可见但不可寻址**的状态。

---

## 2.3 `delivery: quiet | wakeup` 的真实差异：**为零**

- harness 的 `send_message` **没有** `delivery` 参数（`[H] tool-agent-team/src/index.ts:224-227`），
  永远走 `steer`，即 `wakeup=true`。
- 唤醒位确实存在于 Agent 层：`send(message, target, wakeup)`（`runtime-types.ts:215`），
  `steer`/`followup` 传 `true`，`inject` 传 `false`（`agent.ts:163-173`）。`wakeup=false` 只把
  内容放进 `next-step`，不唤醒 driver；idle 的 driver 会一直留着它，直到别的 followup/steer 唤醒
  （契约注释 `runtime-types.ts:224-231` 与 `inject` 段 `:233-240`）。
- 产品层把 `delivery` 暴露成工具参数（`[S] tool-swarm/src/index.ts:111,124,144,156`；
  `[S] team-bus/src/index.ts:41,63,70`），`team-bus` 也把它一路带到 `teamCore.send`
  （`team-bus:325`）——但 `team-core.send` 的签名收了 `delivery`（`:273`）后**完全没有使用它**，
  直接调 `seam.sendMessage`（`team-core:283-287`），而 seam 就是 §2.2 的 harness `sendMessage`。
- 全仓源码**没有任何一处**把 `'quiet'` 翻译成 `wakeup=false`；其余内部调用点全部硬编码
  `'wakeup'`（`team-core:508`、`team-review:201,304`、`team-scheduler:428,449,504`、
  `team-distributed:379`、`team-human:205,211`）。

**结论**：当前 `quiet` 与 `wakeup` 行为完全相同，**始终唤醒**。这是本次调查最实质的一处
「描述与实现不符」（§2.9 第 A 条）。

---

## 2.4 顺序、并发与自过滤

- **投递顺序**：同一队友的投递由 per-child 锁串行（`manager.ts:1254` `this.locks.run(childId, …)`，
  锁实现未展开，见 §2.8）；Lead 的 inbox 是 splice 追加到末尾（`agent.ts:159`），调用先后即 inbox 顺序。
- **Team 不做队列**：`[H] agent-team/tests/team.spec.ts:931-958`「passes concurrent attempts to the
  lower delivery owner without a Team queue」：并发 `sendMessage` 不经 Team 级队列，直接下发 subagent 层；
  被 mock 的 deliverer 阻塞第一次后，第二次仍被立即受理（`admitted === ['first','second']`，`:951`）。
- **Team 域事务**：只有 roster/task 的读-改-写走 `TeamJournal.transact`，按 Lead SessionId 串行
  （`journal.ts:42-52`）。
- **自过滤**：
  - harness 层拒绝自投递（`:229`）。
  - 总线层 `broadcast` 显式 `filter(m => m.id !== sender.id)`（`team-bus:188`），`history` 也跳过自己发的（`:312`）。
  - **`multicast` 的 `assertTargets` 不排除调用者**（`team-bus:364-389`）。若 targets 含自己（**用 id**），
    会走到 `deliver`（`:318-335`）→ `teamCore.send` → harness `TEAM_SELF_MESSAGE`；而 `deliver`
    把异常吞成 warn（`:327-334`），结果 multicast 仍返回成功，自己那条**静默丢失**（但已落库）。
    注：该场景在当前模型侧不可达——模型给不出 id，见 §2.9 第 B 条。
- **发送即返回**：`SendTeamMessageResult` 注释写明「no Team retry or deduplication」，
  返回的是 inbox 身份，不代表已处理（`[H] agent-team/src/types.ts:186-189`；`index.ts:143`）。
  发送路径不 flush 目标 Session：`inbox.splice` 会 `session.append('agent/inbox/spliced', …)`
  （`inbox.ts:167-174,198-229`，`durable:true`），但不等待 flush；测试必须显式 `ctx.sessions.flush`
  才能读回持久化消息（`team.spec.ts:922-928`）。
  所以存在窗口：`sent:true` 之后、目标日志落盘之前崩溃，消息可能丢失；接收方也只在下一个 step 边界才看到它。

> **更正（措辞）**：草稿说 `sent:true`「只代表 inbox splice 已入**内存投影**」。更准确：
> 它是**已 append 到目标 Session 日志（内存态）**、但**未 await flush**，也不代表已被模型处理。

---

## 2.5 `wait_agent`：注册什么、何时返回、为何立即 `noProgress`

- 工具实现 `[H] tool-agent-team/src/index.ts:249-282`：
  1. 先做区间校验；越界**不自行报错**，而是转交 `waitForChange`（`:264-266`），由
     `activity.ts:23-25` 抛 `TEAM_INVALID_TIMEOUT` —— 与描述给的范围一致。
  2. 计算 `hasActivePeer`：`listMembers(caller)` 中 `id !== caller.id` 且 status ∈
     {running, provisioning}（`:44,269-270`）。
  3. **没有**活跃 peer 就**不注册** waiter，直接返回
     `{timedOut:false, noProgress:{reason:'no-active-peer', message}}`（`:271-279`）。
- 有 peer 才调 `waitForChange` → `TeamActivity.wait`（`activity.ts:22-66`）：
  在 `Map<TeamId, Set<Waiter>>`（`:12`）注册一个一次性 waiter，配 `setTimeout` 与 abort 监听；
  `closed` 时立即 `{timedOut:false}`（`:27`）；abort 抛 `TEAM_WAIT_ABORTED`（`:50`）；
  超时 resolve(false) → `{timedOut:true}`（`:59,65`）。`notify` 一次清空该 Team 全部 waiter（`:72-77`）。
- **什么唤醒它**（`TeamActivity.notify(teamId)` 的三个来源）：
  1. 任一 Team 事件提交并 flush 成功后（`index.ts:89` 的 onCommit；`journal.ts:71`），
     覆盖 `team/member`、`team/task`；
  2. 任一 Team 成员的 `agent/status` 迁移（`index.ts:94-97`）；
  3. 任一**成功**的 `sendMessage` 结束后（`index.ts:246`）。notify 的是**发送者所属 Team**
     （`membership.id`，即 root id）。
     粒度是**整个 Team**：不区分「谁变了」，同一 Team 的所有 waiter 一起被唤醒。
- **为什么能立即 `noProgress`**：wait 只能观察事件/状态边沿，且从不唤醒任何人；当除自己外没人
  running/provisioning 时，没有任何合法来源会产生新边沿，等待必然超时，所以短路省掉一次长等待
  （`:267-268` 注释要求「活跃 peer 读取与 waiter 注册必须在同一同步片段」，否则会丢掉唯一的边沿）。
- **等待中的 Lead 被谁唤醒**：队友 `send_message(target:"lead")` → `root.steer` + `notify`（`:239-246`），
  或队友状态迁移（`:94-97`）。这也解释了「消息先落 inbox，wait 先返回，Lead 下个 step 才消费」。
- **边沿触发**：注册前发生的变化不算数（`team.spec.ts:1124-1128` 用 fake timer 断言注册前的
  `createTask` 不让 wait 提前返回，仍 `timedOut:true`）。
  HMR/卸载时 `close()` 唤醒全部 waiter（`activity.ts:79-86`；`team.spec.ts:1131-1133`）。

---

## 2.6 事件日志与投影：什么被记、什么只在内存

**被写入 Lead Session 日志（可重放）**：

- `team/member`：整条成员快照；`name/provider/context` 不可变，`phase` 只允许
  provisioning→active|failed（`projection.ts:250-268`，校验在 `:261-266`）。
- `team/task`：整条任务快照，revision 必须连续 +1（`projection.ts:270-291`，`:274-279`）。
- 两者是 `TeamJournal` 允许的**唯一** Team 事件类型（`journal.ts:9`）；先 `session.append`
  再 `sessions.flush`，**之后**才 `onCommit` 通知 waiter（`journal.ts:60-72`）——提交点之后才发布。

**已废弃的日志事件**：`team/message/queued` / `team/message/delivered` 的类型与投影规则仍在
（`types.ts:227-242`；`projection.ts:292-305`），注释直接写「Historical mailbox enqueue;
new sends use the target Agent inbox」（`types.ts:233`）。生产代码不再 emit：
全 harness `grep` 只命中类型/投影/format 迁移/旧日志渲染与测试；
`team.spec.ts:907` 断言 Lead 日志里 `team/message/*` 为空。
旧的 `delivery:'quiet'` 只出现在 Session 格式迁移的校验/测试里
（`[H] session/session-format-v0-to-v1/src/payload-validation.ts:1031`）。

**投影**：`teamProjectionDefinition`（`projection.ts:387-394`，key `agentTeam`，`stateVersion: 4`）
按 `teamId` 选择事件（`:229-230`）、要求 `version === 2`（`:231-233`）；校验失败写入终态 `failure`
并冻结后续事件（`:226`、`:235-238`）。对外 wire view 只有 roster + 非删除任务（`:342-361`）；
mailbox 类状态变化复用旧 view 引用（`:371-384`，`WeakMap` 缓存 `:340`）。

**重启后重放**：Lead Session 日志重放即可重建 roster/task（`journal.ts:29-34` 从 `agentTeam` 投影读）。
`provisioning` 悬挂项在 `agent/created` 后由 `scheduleRecovery`→`reconcileProvisioning`
（`index.ts:93,108,251-259`；`roster.ts:375-417`）单独收敛：要求 `continuable` 描述符且初始 prompt
已被接受（`roster.ts:387-392`；`session-message.ts:25-31` 用 `agent/inbox/spliced` 折叠判定），
否则标记 failed。

**只在内存**：`TeamActivity.waiters`（`activity.ts:12`）、`TeamRuntimeLifecycle.operations`
（`lifecycle.ts:7`）、`team-bus` 的 `durable[]`/`seq`/订阅表（`team-bus:108-111`）、
`team-core` 的 `reviewing/planning/plans/...`（`team-core:134-142`）。

### 2.6.1 「durable 事件」链路：本仓缺的是**事件生产端**，恢复端已接好

> **本节结论已于独立核验后更正**（依据 `docs/investigation/05-verification.md` §2 FIX-1，
> 核验员 `auditor`）。原结论「出厂组合下 `recover()` 是不可达代码」**不成立**，见下方「更正」。

- 生产端（**缺失**）：产品层所有 `emitDurable` 都只调 `ctx.emit('swarm/...')`
  （`team-bus:142-155`、`team-core:592-605`、`team-review:245`、`team-skills:123`、
  `team-memory:128`、`team-completion:130`）；`packages/*/src` 中
  `session.append` 与 `sessions.flush` **零命中**。
- 恢复端（**已接好**）：以下都是**生产构造器**里的监听，且都在回调内调用了 `this.recover([ev])`：
  - `team-bus/src/index.ts:118-120`（`this.recover` 在 `:119`）
  - `team-core/src/index.ts:184-190`（`:189`）
  - `team-memory/src/index.ts:51-53`（`:52`）
  - `team-skills/src/index.ts:84-86`（`:85`）
  - `team-completion/src/index.ts:66-75` **只监听、不 recover**（它监听 `team/message/*` 维护未读台账
    并转发 `swarm/completion/unread`；而 `team/message/*` 已无生产 emit，见 §2.6）。
- 约定文档声称的链路：`docs/state-durability.md:10`
  「包 `emit('swarm/*')` → **经 session 日志落地** → 恢复时折叠」、`:54`
  「**运行时**经 `ctx.on('session/event')` 叠加」；`docs/adr/0002-...md:75` 同。
  文档描述的恢复端与代码一致，文档缺的是对「谁来把 emit 写成 session 事件」的归属说明。
- 验证脚本是自己直接调用 `recover`：`scripts/verify-durability.mjs:79` `c2.recover(captured)`，
  因此它证明的是**折叠逻辑正确**，不能证明生产链路连通。

**更正后的结论**（取代原结论）：

> 本仓内缺少的是这条链的**事件生产端**：`packages/*/src` 中 `session.append` 与 `sessions.flush`
> **零命中**，`emitDurable` 只调用 `ctx.emit('swarm/*')`。恢复端在生产路径上**已经接好**——
> `team-bus/src/index.ts:119`、`team-core/src/index.ts:189`、`team-memory/src/index.ts:52`、
> `team-skills/src/index.ts:85` 均在 `ctx.on('session/event')` 内调用 `this.recover([ev])`
> （`team-completion/src/index.ts:66-75` 只监听、不 recover）——因此 `recover()` **不是不可达代码**，
> 只要宿主桥把 `swarm/*` 事件写进 Session 日志即可折叠。宿主是否存在该桥仍 `UNVERIFIED`。

---

## 2.7 已知缺口与竞态（代码/测试可见）

1. **工具清单 ≠ 源码清单**：模型侧同时看到 harness 与产品层工具；只读 harness 会漏掉
   `broadcast/multicast/team_summary/review_*/workspace_*/skills_visible/memory_recall`，
   后三组还随 Config 开关出现/消失。
2. **`quiet` 是空转**：产品层暴露 `delivery`，`team-core.send` 丢弃它，最终永远 `steer`（唤醒）。
3. **provisioning 状态语义不一致**：`wait_agent` 把 provisioning 当活跃 peer（`:44,269-270`），
   `send_message` 却拒绝它（`roster.ts:50-52`）；而 `list_agents` 仍把它列为可寻址 target
   （`roster.ts:144-148`）。
4. **multicast 无自过滤**：targets 含自己（用 id）时静默丢一条，整体仍报成功。
5. **发送先于处理/持久化返回**：`sent:true` 只代表 `agent/inbox/spliced` 已 append、未 flush。
6. **`noProgress` 是预测而非保证**：检查活跃 peer 与注册 waiter 在同一同步片段内（`:267-280` 注释），
   但若第三方在返回后唤醒某个 inactive 成员，调用者已拿到 `noProgress` 且不会再被通知。
7. **Team 级唤醒过宽**：任何成员的状态边沿或任何一次 send 都会唤醒该 Team 的所有 waiter。
8. **投影 schema 保留死事件**：`team/message/*` 的校验/投影仍在但无人 emit，读代码易误判消息仍走 mailbox。
9. **阶段 2 工具在出厂组合中不可达**：`enableWorkspace/enableSkills/enableMemory` 默认 false 且
   bundle 未打开（`tool-swarm:47-53`；`bundle/cordis.patch.yml:66-70`），
   而三个供给服务却已加载（`:73-88`）——能力接好了但模型看不到。
10. **`tool-swarm` 的硬 `inject` 过宽**：`inject` 含 `teamBus`/`teamReview`（`:25-32`），
    缺任一则整个插件（含与之无关的 `team_summary`）不加载；与源码里「依赖缺失只降级掉对应工具」
    的设计（`:79-100`）不一致。
11. **durable 事件链缺的是「生产端」**：`emitDurable` 只 `ctx.emit('swarm/*')`，
    `packages/*/src` 中 `session.append`/`sessions.flush` 零命中；恢复端已在生产构造器内接好
    （`ctx.on('session/event')` → `recover`）。详见 §2.6.1。

---

## 2.8 残留不确定 / 未覆盖

- 宿主是否在某处把 `ctx.emit('swarm/*')` 桥接进 Session 日志：`UNVERIFIED`（不在 `[S]` 与
  本次读取的 `[H]` 范围内）。本仓内**恢复端已接好**（`team-bus:119`、`team-core:189`、
  `team-memory:52`、`team-skills:85`），缺的是**生产端**，见 §2.6.1。
- `[H] subagent/.../manager.ts` 的 `locks.run` 实现未展开（只确认调用点 `:1254`），
  跨进程/多实例下的顺序保证未验证。
- `tool-swarm` 的 `callerOf` 在 `exec.agent` 缺失时**静默退化**为 `agents.list()[0]`（`:67-74`），
  可能错误归属发送者。`[H] core/agent/src/runtime-types.ts:21` 与 `core/tools/src/index.ts:340,376`
  都把 `agent` 声明为**可选**，而 harness 的 `callingAgent` 注释（`tool-agent-team:161-165`）
  只保证「Agent scope 注册」场景有值。tool-swarm 是**全局注册**（`ctx.tools.register`，非 `agent.ctx`），
  实际是否恒有值未实测：`UNVERIFIED`。
- 产品层 `team-transport` / `team-distributed` / `team-human` 的跨进程投递未纳入本次调查。

---

## 2.9 模型侧工具描述文本 vs 实现：全部出入

> 逐条比对「模型看到的字符串」（工具 `description` / 参数 `description`）与实现语义。
> 严重度：🔴 会导致模型做出错误决策；🟡 描述不完整/易误解；⚪ 文案瑕疵。

| #   | 严重度 | 工具                                          | 描述文本（source）                                                                                    | 实现事实                                                                                                                                                                                                       | 证据                                                                                        |
| --- | ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A   | 🔴     | `broadcast` / `multicast`                     | `delivery: 'quiet \| wakeup (default wakeup)'`、`'quiet \| wakeup'`                                   | `delivery` 全链路无效果，`quiet` 与 `wakeup` 行为相同（永远唤醒）                                                                                                                                              | `tool-swarm:111,124,144,156`；`team-bus:325`；`team-core:273,283-287`                       |
| B   | 🔴     | `multicast`                                   | `'Send a message to specific teammates (comma-separated names).'` / `'Comma-separated member names.'` | 实现按 `listMembers().id`（SessionId/UUID）匹配；模型侧 `list_agents` 只暴露 `target`=name，拿不到 id。**实测按 name 必然 `TEAMBUS_UNKNOWN_TARGET`**                                                           | `tool-swarm:136,141`；`team-bus:224,228-230,319`；`tool-agent-team:68-71`；**观察** 探针    |
| C   | 🔴     | `review_submit`                               | `'Submit a task for review (blocks direct completion).'`                                              | ①**无评审池时直接 `complete`**，与「提交评审」相反；② 任务处于 `in_review` 时 `complete` 仍被允许（`team-core:449-455`），「blocks direct completion」并非强制                                                 | `tool-swarm:170`；`team-review:110-117`；`team-core:449-455`                                |
| D   | 🟡     | `broadcast`                                   | `fanout: "…'record-only' = 仅落库、不逐人唤醒，成员按需拉取（公告类）"`                               | 模型侧**没有任何工具暴露 `TeamBus.history`**（产品层只注册了上表 10 个），`record-only` 的内容模型永远拉不回来                                                                                                 | `tool-swarm:112-116`；`team-bus:76,207-209`                                                 |
| E   | 🟡     | `review_vote`                                 | `role: 'verifier \| challenger \| inspector'`；`value: '0..1 score (inspector)'`                      | `role` 不做校验、`value` 不做 0..1 校验；票按 `pool.roles` 过滤（bundle 池只有 `[verifier, challenger]`），**`inspector` 票入库但永不计票**；binary 池忽略 `kind:'score'` 的票；`decision` 省略时**默认 pass** | `tool-swarm:188-208`；`team-review:130-143,268-289`；`bundle/cordis.patch.yml:51`           |
| F   | 🟡     | 全部产品层工具                                | `topic/delivery/fanout/role/mode/decision` 写成 `type:'string'` + 文案枚举                            | 参数**无 `enum` 约束**，非法值被 `as` 静默接受（对比 harness 用 `enum`）；`workspace_lock` 的 `mode` 非 `'shared'` 一律当 `'exclusive'`                                                                        | `tool-swarm:110-116,144,188-194,251,258`；对比 `tool-agent-team:326-330,375-379`            |
| G   | 🟡     | `wait_agent` / `send_message` / `list_agents` | `send_message` 只说「running 在最近 step 边界收到；inactive 会 start/resume」                         | 未说明 **provisioning/failed 目标会被拒**（`TEAM_MEMBER_NOT_FOUND`），而 `list_agents` 仍把它们列为可用 target                                                                                                 | `tool-agent-team:223,241`；`roster.ts:50-52,144-148`                                        |
| H   | ⚪     | `team_summary`                                | `'Summarize the team: members and task board.'`                                                       | 输出只有 `members=N; tasks=M (status=k)` 计数，没有成员明细/任务明细                                                                                                                                           | `tool-swarm:222,236`                                                                        |
| I   | ⚪     | `team_task_get`                               | `'Read the complete latest value of one shared task…'`                                                | 也会返回**已删除任务的墓碑**，描述未提                                                                                                                                                                         | `tool-agent-team:356`；`[H] agent-team/src/index.ts:164`（"including a deleted tombstone"） |
| J   | ⚪     | `team_task_update` 的 `owner`                 | `'…for Lead-only reassign; omit to unassign.'`                                                        | 与实现一致（`task-board.ts:172-173`），但 `subject/description/write_scopes` 只对 `edit` 生效、`blocked_by` 只对 `set_dependencies` 生效，描述未点明                                                           | `tool-agent-team:381-385`；`task-board.ts:105-213`                                          |
| K   | ⚪     | `broadcast` 的 `maxFanout`                    | 描述未提                                                                                              | 成员数 > `maxFanout`(默认 64) 时抛 `TEAMBUS_FANOUT_EXCEEDED`；`multicast` targets 恰为全体时抛 `TEAMBUS_REDUNDANT_BROADCAST`，含 `*`/`user` 抛 `TEAMBUS_INVALID_TARGET`                                        | `team-bus:189-194,364-389`                                                                  |

**未见出入**（核对通过）：`spawn_teammate` 的 Lead-only 与 `context` 默认、`list_agents` 的四种 status、
`team_task_*` 的 action 枚举与 CAS 语义、`team_task_list` 的 limit 1..100、
`wait_agent` 的 10000..3600000 与 noProgress 语义、`workspace_*`、`skills_visible`、`memory_recall` 的主语义。

---

## 2.10 附：harness vs 产品层 —— 并集与差集

- **交集**：∅（两层工具名互不重叠）。
- **并集**：19 个。
- **差集**：
  - **仅 harness（9）**：`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、
    `interrupt_agent`、`team_task_create/list/get/update`。
  - **仅产品层（10）**：`broadcast`、`multicast`、`review_submit`、`review_vote`、`team_summary`、
    `workspace_lock`、`workspace_unlock`、`workspace_worktree`、`skills_visible`、`memory_recall`。
- **实际出厂组合下模型可见的 team 工具（12）** = harness 9 + `broadcast` + `multicast` + `team_summary`
  （`bundle/cordis.patch.yml:66-70` 只开 `enableBroadcast`）。
- 非 team 工具（`subagent`/`subagent_fork`/`workflow`/`todo_write`…）来自 harness 其他插件，
  不属本调查范围。

---

## 本轮更正清单

> 对照上一轮 `02` 草稿（revision 1）逐条列出。除标注外，行号均已 read 复核。

| #   | 位置            | 草稿说法                                                                                                                                            | 复核结果                                                                                                                                                                                   |
| --- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | §2.0            | 产品层工具「受 `enableBroadcast` 等 Config 开关控制」，开关点 `:102,165,217,243`                                                                    | **部分错误**。`team_summary` 由 `if (core)`（`:217`）把关，**无 Config 开关**；开关点应为 `:102,:165,:243,:297,:315`（`:217` 不是开关）                                                    |
| 2   | §2.1 harness 表 | `wait_agent`「活跃 peer 短路，否则 `waitForChange`」                                                                                                | **反了**。真实为「**无**活跃 peer 才短路返回 `noProgress`」，有才注册 waiter（`:269-280`）                                                                                                 |
| 3   | §2.1 产品层     | `broadcast`(`:106-129`)/`multicast`(`:135-159`)/`review_*`(`:169-214`)/`team_summary`(`:221-240`)/`workspace_*…`(`:243-320`)                        | 行号系统性偏移 1–11 行；已改为 `:102-131`、`:132-162`、`:165-215`、`:217-241`、`:243-295`、`:297-313`、`:315-331`                                                                          |
| 4   | §2.1 产品层     | 「`team_summary`（…成员数 + 任务状态直方图）」并归入「均带各自 Config 开关」                                                                        | 描述正确，归属错误（见 #1）。另：输出**只有计数**，无成员/任务明细（`:236`）                                                                                                               |
| 5   | §2.4            | 「`sent:true` …只代表 inbox splice 已入**内存投影**」                                                                                               | 措辞不准确。应为：已 `session.append('agent/inbox/spliced')`（内存日志）但**未 await flush**，且不代表已处理（`inbox.ts:167-174,198-229`；`team.spec.ts:922-928`）                         |
| 6   | §2.6            | `swarm/*` durable 能否重放「取决于工作区之外的宿主桥」                                                                                              | **加强（后经核验更正，见 #19）**：`[S]` 内 `grep "session.append\|sessions.flush"` 零命中 → 缺的是**事件生产端**；恢复端已在生产构造器内接好（`team-bus:119`、`team-core:189`、`team-memory:52`、`team-skills:85` 在 `ctx.on('session/event')` 内调 `this.recover([ev])`）。宿主桥仍 `UNVERIFIED` |
| 7   | §2.6            | `types.ts:233-241` + `projection.ts:292-305` 记录死事件                                                                                             | 确认（`types.ts:227-242` 为事件表，`:233` 为「Historical mailbox enqueue」注释）                                                                                                           |
| 8   | §2.5            | `activity.ts:22-66`、`:23-25`、`:27`、`:50`、`:59`、`:79-86`                                                                                        | 全部确认                                                                                                                                                                                   |
| 9   | §2.2            | `sendAdmitted:224-248`、`:229,:231,:234-236,:237,:239-245,:246`；`roster.ts:42-54,48,50-52`；`agent.ts:154-161,167-169,361-366`；`inbox.ts:109-114` | 全部确认                                                                                                                                                                                   |
| 10  | §2.3            | `team-core.send`(`:271-289`) 收 `delivery` 却不用；seam 即 harness `sendMessage`                                                                    | 确认（`:273` 收参，`:283-287` 未用；`team-bus:325` 透传）                                                                                                                                  |
| 10b | §2.1.1 / §2.9   | 引 `task-board.ts:118`、`:114-200`                                                                                                                  | 精确化：陈旧 revision 抛错在 `:116-120`；`update()` 整体跨度 `:105-213`                                                                                                                    |
| 11  | —               | 草稿缺                                                                                                                                              | **新增重大发现**：`multicast` 描述按 name、实现按 id，且模型拿不到 id → 工具不可用（§2.9 B，已实测）                                                                                       |
| 12  | —               | 草稿缺                                                                                                                                              | **新增**：`review_submit` 在无评审池时**直接完成任务**；`in_review` 期间 `complete` 未被阻止（§2.9 C）                                                                                     |
| 13  | —               | 草稿缺                                                                                                                                              | **新增**：`fanout:'record-only'` 说的「按需拉取」无对应模型工具（§2.9 D）                                                                                                                  |
| 14  | —               | 草稿缺                                                                                                                                              | **新增**：阶段 2 的 `workspace_*`/`skills_visible`/`memory_recall` 在出厂 bundle 中**未启用**（§2.7 #9）                                                                                   |
| 15  | —               | 草稿缺                                                                                                                                              | **新增**：`tool-swarm` 硬 `inject teamBus+teamReview`，缺任一则连 `team_summary` 一起消失（§2.7 #10）                                                                                      |
| 16  | —               | 草稿缺                                                                                                                                              | **新增**：产品层参数无 `enum`，非法值静默接受（§2.9 F）                                                                                                                                    |
| 17  | —               | 草稿缺                                                                                                                                              | **新增**：`review_vote` 的 `role`/`value` 不校验，`inspector` 票在 bundle 池中永不计票（§2.9 E）                                                                                           |
| 18  | §2.4            | 「`multicast` 若 targets 含自己…静默丢失」                                                                                                          | 语义成立，但需补前提：需传 **id**；当前模型侧不可达（见 #11）                                                                                                                              |
| 19  | §2.6.1 / §2.7 #11 / §2.8 | 结论「在出厂组合下 `recover()` 是**不可达代码**」                                                                                          | **推翻**（依据 `docs/investigation/05-verification.md` §2 FIX-1，核验员 `auditor`）：恢复端在生产构造器内已接好——`team-bus/src/index.ts:119`、`team-core/src/index.ts:189`、`team-memory/src/index.ts:52`、`team-skills/src/index.ts:85` 均在 `ctx.on('session/event')` 内调 `this.recover([ev])`（`team-completion:66-75` 只监听、不 recover）。本仓缺的是**事件生产端**（`session.append`/`sessions.flush` 零命中，`emitDurable` 只 `ctx.emit('swarm/*')`）。宿主是否存在该桥仍 `UNVERIFIED` |

---

## 工具面权威清单表格

> 口径：`工具名 → 来源包 → 开关 → 作用`。「默认可见」按出厂 bundle
> `[S] packages/bundle/cordis.patch.yml:66-70` 判定。
> 行号：`TS` = `[S] packages/tool-swarm/src/index.ts`，`TA` = `[H] packages/experimental/tool-agent-team/src/index.ts`。

### A. harness 基础层（`@deepseek-ai/dsh-experimental-tool-agent-team`）

| 工具名             | 来源包                                              | 开关                                | 默认可见 | 作用                                                     | 证据                                                                             |
| ------------------ | --------------------------------------------------- | ----------------------------------- | -------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `spawn_teammate`   | tool-agent-team（服务 `agentTeams`）                | 无（恒注册）                        | ✅       | Lead 创建 durable 队友；`context` 选 fresh/fork provider | `TA:192-219`；`Config` 的 `freshProvider/forkProvider` 只改 provider（`:27-31`） |
| `send_message`     | tool-agent-team                                     | 无                                  | ✅       | 向 lead/active 队友 steer 一条带发送者前缀的消息         | `TA:221-237`                                                                     |
| `list_agents`      | tool-agent-team                                     | 无                                  | ✅       | 列 roster（name→target、role、status、diagnostics）      | `TA:239-247`                                                                     |
| `wait_agent`       | tool-agent-team（服务 `agentTeams`+`TeamActivity`） | 无                                  | ✅       | 等下一次 Team 事件/状态边沿；无活跃 peer 立即 noProgress | `TA:249-282`；`activity.ts:22-66`                                                |
| `interrupt_agent`  | tool-agent-team                                     | **`Config.interrupt`**（默认 true） | ✅       | Lead 打断某队友当前 turn，保留 inbox                     | `TA:27-31,284-295`；`roster.ts:187-198`                                          |
| `team_task_create` | tool-agent-team（`TeamTaskBoard`）                  | 无                                  | ✅       | 建无主 pending 任务                                      | `TA:298-320`                                                                     |
| `team_task_list`   | tool-agent-team                                     | 无                                  | ✅       | 过滤/分页列任务（limit 1..100）                          | `TA:322-352`                                                                     |
| `team_task_get`    | tool-agent-team                                     | 无                                  | ✅       | 读单任务（含删除墓碑）                                   | `TA:354-367`                                                                     |
| `team_task_update` | tool-agent-team                                     | 无                                  | ✅       | CAS 任务动作（8 种 action）                              | `TA:369-400`；`task-board.ts:105-213`                                            |

### B. 产品层（`@elinpf/dsh-swarm-tool-swarm`，唯一注册模型工具的产品包）

| 工具名               | 来源包（服务提供方）            | 开关                                                    | 默认可见                                             | 作用                                     | 证据                                     |
| -------------------- | ------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `broadcast`          | **tool-swarm** ← team-bus       | `enableBroadcast`（默认 **true**）+ 需 `teamBus`        | ✅                                                   | 1 次落库 + 除自己外逐人 DM / record-only | `TS:102-131`；`team-bus:177-214`         |
| `multicast`          | **tool-swarm** ← team-bus       | `enableBroadcast` + 需 `teamBus`                        | ⚠️ 注册但**实际不可用**（按 id 寻址，模型只有 name） | 一次事务写 N 个目标                      | `TS:132-162`；`team-bus:216-266`；§2.9 B |
| `review_submit`      | **tool-swarm** ← team-review    | `enableReview`（默认 **false**）+ 需 `teamReview`       | ❌                                                   | 送任务进评审态（无池时直接完成）         | `TS:165-180`；`team-review:109-128`      |
| `review_vote`        | **tool-swarm** ← team-review    | `enableReview` + 需 `teamReview`                        | ❌                                                   | 投评审票（二元/打分，不可自验）          | `TS:181-215`；`team-review:130-144`      |
| `team_summary`       | **tool-swarm** ← team-core      | **无开关**（仅 `if (core)`）                            | ✅                                                   | 成员数 + 任务状态直方图                  | `TS:217-241`                             |
| `workspace_lock`     | **tool-swarm** ← team-workspace | `enableWorkspace`（默认 **false**）+ 需 `teamWorkspace` | ❌                                                   | 取写域锁（exclusive/shared，带 TTL）     | `TS:243-264`；`team-workspace:156-179`   |
| `workspace_unlock`   | **tool-swarm** ← team-workspace | `enableWorkspace` + 需 `teamWorkspace`                  | ❌                                                   | 释放写域锁                               | `TS:265-279`；`team-workspace:181`       |
| `workspace_worktree` | **tool-swarm** ← team-workspace | `enableWorkspace` + 需 `teamWorkspace`                  | ❌                                                   | 为调用者建/切隔离 worktree               | `TS:280-294`；`team-workspace:132`       |
| `skills_visible`     | **tool-swarm** ← team-skills    | `enableSkills`（默认 **false**）+ 需 `teamSkills`       | ❌                                                   | 列调用者可见技能名                       | `TS:297-313`；`team-skills:166-171`      |
| `memory_recall`      | **tool-swarm** ← team-memory    | `enableMemory`（默认 **false**）+ 需 `teamMemory`       | ❌                                                   | 召回共享记忆 + 本人私有记录              | `TS:315-331`；`team-memory:93-96`        |

> **统一前置**：以上 10 个都要求 `tool-swarm` 插件本身 apply；其 `inject` 硬含
> `teamBus` 与 `teamReview`（`TS:25-32`），二者缺一则**整包工具全不注册**（§2.7 #10）。
> **默认可见计数**：harness 9 + 产品层 3 = **12**。
