# JiuwenSwarm 集群互动质量深挖 —— 四维度（群聊/@、消息-任务、追问/复用、无回应兜底）

> 产出人：interaction-analyst ｜ 任务：P60-jiuwen-cluster-deepdive ｜ 时间：2026-10-27
> 性质：**只调研与建议，不改任何 `packages/*/src`**。
> 权威源（Jiuwen）：`/opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen/agent_teams/`（下称 `…/agent_teams/`）
> 产品侧旁证：`/root/repo/jiuwenswarm/jiuwenswarm/server/runtime/agent_adapter/team_helpers.py`
> 我方现状基线：`dsh-swarm/docs/{investigation/00-overview.md, investigation/02-tools-and-messaging.md, leader-wait-model.md, experiments-idle-wakeup.md, message-fallback-design.md}`
> 约定：**【事实】**=读到源码/文档；**【推断】**=由命名/结构合理推出，未逐行验证；**【观察】**=来自截图/运行态，非源码；**【仍不可推断】**=需额外条件才能判定。

---

## 0. 结论速览

**Jiuwen 关键可用机制 Top3（可移植）**
1. **「落库先行 + 事件唤醒 + 收件人过滤」双轨消息模型**：内容先写 DB（`message_manager.py:60-162`），总线只发轻量 `MessageEvent/BroadcastEvent`，成员收到信号后**只读「发给自己的」未读行**（`handlers/message.py:572-582`）。→ 一次广播 = 1 入库 + 1 扇出，与「谁消耗 LLM 轮」解耦。
2. **看板变更的「最小唤醒集」**：teammate 只在 `TASK_CREATED/UNBLOCKED/RELEASED`（可能扩大可认领池）时被唤醒；leader 例外观察全部（`task_board.py:73-75,457-463`）——**用「是否可能产生可认领工作」做唤醒门控**，而非「有事件就唤醒」。
3. **完成闸 + 关闭排空 + 伪成员 ack 的「消息不丢」三件套**：未读 direct 阻塞团队完成（`message_dao.py:390-470`）、成员关闭时在 steer 模式再排空一次邮箱（`handlers/message.py:98-123`）、`user` 伪成员与 passive human 的未读由 leader 代 ack（`handlers/message.py:551-570,514-527`）。

**我方最大差距**：**「状态噪音」与「唤醒粒度」**——Jiuwen 用「收件人过滤 + 最小唤醒集」把「状态事件」和「是否耗轮」精确解耦；我方（dsh-swarm）当前是**广播 = 逐人 DM（唤醒全体）**、**任务/成员状态以独立条目进入对外事件流**，缺少 Jiuwen 那种「只叫相关人 + 状态进侧栏不进主对话」的收口。

**三句话摘要**：① Jiuwen 无「群聊频道」概念，用户侧 `#`/`$`/`@`/`@all` 是**运行时输入路由语法**（非模型工具），成员间只用 `send_message` 工具；② Jiuwen 的状态变更**在 agent 侧**是 `<team-event>` 上下文事件、且有最小唤醒集去噪，**在 UI 侧**仍以细粒度事件下发（截图所示噪音的根因在「客户端把 raw 状态事件当对话条目渲染」，Jiuwen 服务端未做合并/折叠）；③ 追问/多轮靠 mailbox + 事件唤醒天然支持，成员复用由「roster 稳定 + 单活跃任务不变量 + assignee」保证，无回应由「未读闸 + 排空 + 伪成员 ack」兜底。

---

## 维度 1：群聊 / @ 机制

### 1.A Jiuwen 机制（带行号）

**【事实】(1) 入口是「运行时输入路由语法」，不是模型工具。** 顶层唯一解析点 `…/agent_teams/interaction/router.py`：
- 语法定义在模块 docstring（`router.py:10-31`）：`input := channel? recipients? body`；`channel := "# " | "$" name (" " | "@")`；`recipients := ("@" name " ")*`。
  - `# body` → god-view，正文进 **leader 的 DeepAgent**；
  - `$<name> body` → 驱动 `<name>` 的 human-agent 化身；
  - `@<member> body` → 从当前 channel 发送者 **点对点** 发给 `<member>`；
  - `@all` / `@*` → **广播**；`@<m1> @<m2> body` → **多播**（每收件人一条）；
  - 裸文本 → 默认 `# `（发给 leader）。
- 实现：`parse_mention`（`router.py:64-78`）、`parse_interact_str`（`router.py:120-217`）、广播判定 `BROADCAST_TARGETS`（`router.py:60`、`router.py:192-198`）、roster 解析 `resolve_targets`（`router.py:273-307`）、点对点落地 `deliver_direct`（`router.py:310-336`）。

**【事实】(2) 三种 channel 落地到三种消费端**：
- `#`/`@member`/`@all` 经 `UserInbox`（`interaction/user_inbox.py:35-88`）：`direct()` = 点对点 from "user"（`:41-56`）；`broadcast()` = 团队广播 from "user"（`:58-71`）；`deliver_to_leader()` = 直接喂 leader DeepAgent、**不落库**（`:73-87`）。
- `$<name>` 经 `HumanAgentInbox`（`interaction/human_agent_inbox.py:85-106` 契约）：`to=None` → 入该化身自己的协调（`agent.interact` → USER_INPUT，`:229-255`）；`to=@all` → 化身身份广播（`:205-212`）；`to=<m>` → 化身身份 DM（`:213-219`）。

**【事实】(3) 成员间的「群聊/@」不是同一套工具。** 成员用 `send_message` 工具（`tools/tool_message.py`），三形态由参数决定：
- `to="*"` → `_broadcast`（`:140-152`）；`targets=[...]` → `_multicast`（`:178-264`）；`to=<member>` → `_send`（`:154-176`）。
- 语义都是「写库 + 发事件」（见 §维度2的 `message_manager.py`）。**没有任何「# 频道」或「@ 提及某人强制入参」的模型工具**。
- 「@某人会触发什么」= 作为**用户/控制器输入**时，`@member` → 点对点消息（唤醒该 member）；`@all` → 广播（唤醒全体非发送者）。**作为成员**时没有 `@` 语法，只有 `send_message(to=<name>)`。

**【事实】(4) 「什么时候群聊、什么时候 DM」= 提示词约束，非工具强制。** `prompts/cn/leader_policy.md:9` 明写：「**优先单播定向沟通；`to="*"` 广播会唤醒团队里每一个成员各跑一轮 LLM 交互，开销与团队规模成正比…务必慎用，仅用于全局决策、约束变更或必须所有人知晓的公告**」。即：**入口是工具，纪律靠提示词**。

**【事实】(5) 广播的「自过滤」**：`kernel.py:590-611` `_filter_self` 丢弃 `sender_id==本成员` 的事件；DB 广播查询也排除 `from_member_name==本成员`（`message_dao.py:351`）。→ 发送者不会被自己的广播唤醒。

**【推断】** 因此 Jiuwen 的「群聊」在实现上更像「**团队级 topic 的事件通知广播**」（`TeamTopic.MESSAGE` pub-sub，`schema/events.py:30-47` + `messager/inprocess.py:36-54`），而不是「持久化的群聊频道/成员列表 @ 提醒」。**真正的群聊 UI 语义由客户端渲染层承担，服务端只给事件。**

### 1.B 与我们现状对照（dsh-swarm）

- **我方无 channel/`#`/`@`/mention 概念**（`[S]` 全仓无此语法）。成员间消息工具：native `send_message(target, message)`（`[H] tool-agent-team/src/index.ts:221-237`）+ 产品层 `broadcast`（`[S] tool-swarm:102-131`）。**无用户侧 `@member` 定向路由语法**。
- **广播语义已对齐**（P27，`experiments-idle-wakeup.md:336-346`）：源系统「广播唤醒全体非发送者」，我方 `broadcast` = 1 落库 + 逐人 DM，**唤醒语义一致**。
- **quiet/wakeup 是空转**：产品层暴露 `delivery:'quiet|wakeup'`，但 `team-core.send` 收下 `delivery` 后**完全不用**，永远 `steer`（唤醒）（`02-tools-and-messaging.md §2.3`，`:273,283-287`；`§2.9 A`）。→ **我方缺失「静默投递/定向唤醒」这一 Jiuwen 靠 `use_steer` 与收件人过滤实现的能力**。
- **multicast 实际不可用**：按 `listMembers().id`（UUID）寻址，模型侧只有 `name` → 实测 `TEAMBUS_UNKNOWN_TARGET`（`02-tools-and-messaging.md §2.9 B`）。

### 1.C 差距

| 项 | Jiuwen | 我方 | 差距性质 |
|---|---|---|---|
| 用户侧定向/广播路由语法 `#/$/@/@all` | 有（`interaction/router.py`） | **无** | 能力缺失 |
| 成员间「群聊」与「DM」区分 | 靠提示词纪律（`leader_policy.md:9`） | 有 broadcast/DM 工具，但**提示纪律弱**（P46/P57 才把「不默认等待」写进常驻段） | 提示/默认行为 |
| 定向静默投递（quiet） | 有（收件人过滤 + `use_steer` 分流） | **无**（quiet 空转） | 实现缺陷 |
| 多播 | 逐人独立 DM（真可用） | 工具注册但**按 id 寻址不可用** | 实现缺陷 |

### 1.D 可移植改进项

- **[P1｜低] 修复 `quiet` 语义**：把 `delivery:'quiet'` 翻译为「投递但不唤醒」（native `send(..., wakeup=false)`，见 `02-tools-and-messaging.md §2.3` 的 `inject` 段 `runtime-types.ts:233-240`）。估算：`team-core.send` 单点改，~0.5d，单测可覆盖。
- **[P2｜中] 修复 `multicast` 寻址**：由 name→id 解析（复用 `listMembers` 的 name 映射），或直接在 `send_message` 补 `targets`。估算：`team-bus` 一层，~1d。
- **[P3｜低] 补「成员侧 @ 路由」薄封装（可选）**：若产品需要 `@member` 体验，在 `team-prompt` 注入「@name = DM、@all = 广播」的语法说明 + 一个解析前置，而非新增运行时语法。估算：~1d，**需先确认产品是否要此交互**（见【仍不可推断】）。
- **[P4｜中] 广播写放大治理**：Jiuwen 广播 = 1 记录 + 读水位线（O(1) 写）；我方 = 1 落库 + 逐人 DM（O(N)）（`experiments-idle-wakeup.md:377`）。可评估「单条广播行 + 每人水位线」的对齐。估算：涉及 mailbox 语义，~2–3d，**待 P21 后再评估**。

**【仍不可推断 + 解锁条件】**：Jiuwen「群聊」到底有没有**持久化的频道实体/成员列表**——本仓库只见 `TeamTopic` 事件 topic 与 `#` 语法，未见「channel 表/频道成员表」。若确需结论，解锁条件=审阅 JiuwenSwarm **前端**工程（不在本仓）与 `interaction/payload.py` 的 `GodViewMessage/HumanAgentMessage` 消费端。

---

## 维度 2：消息与任务的关系 / 状态噪音

### 2.A Jiuwen 机制（带行号）

**【事实】(1) 任务派发**：任务行落库（`tools/task_manager.py`）+ 事件发 `TeamTopic.TASK`；派发的「启动信号」是**框架自动拉起成员**，而**不是靠消息**（`prompts/cn/dispatch_autonomous_leader.md:6`：「成员由框架拉起，'启动'不需要你做任何事…`send_message` 只用来传达任务正文之外的额外上下文，**不是启动开关**」）。→ **派发本身不必然伴随一条消息**。

**【事实】(2) 状态变更进哪里：agent 侧是 `<team-event>` 上下文事件，不产生对话气泡。**
- 任务看板事件由 `TaskBoardHandler` 处理（`handlers/task_board.py:32-58`），对**目标成员**用 `deliver_input(render_event(kind="task-..."))` 喂 harness（如 `task-assigned` `:145-157`、`task-review-request` `:357-371`、`task-revision` `:389-403`）；对**leader** 用 `_nudge_idle_agent` 喂「任务看板摘要」（`:487-551`，且 `use_steer=False` 走 follow-up 队列，**不打断当前轮** `:548-551`）。
- 这些是**投进 agent 上下文的 `<team-event>` 块**（`prompts/cn/inbound_tags.md:8` 定义 `<team-event>` 为「框架投递的团队事件通知…任务指派、计划审批、催促、完成通知、任务看板…」），**不是**用户可见的独立对话条目。用户看到的只有 **leader 的 LLM 输出**（`schema/stream.py:19-73`：teammate 输出用 `source_member/role` 打标，`is_team_event_marker` 把 `team.*` 标记块识别为「非 agent 内容」）。

**【事实】(3) 「避免状态噪音刷屏」的核心机制 = 最小唤醒集（去噪在 agent 侧）。**
- teammate 只在 `_TEAMMATE_NUDGE_EVENTS = {TASK_CREATED, TASK_UNBLOCKED, TASK_RELEASED}`（可能**扩大可认领池**）时被唤醒；其余看板 churn（编辑/完成/取消/他人认领）**不唤醒**（`task_board.py:60-75,457-463`）。注释明写：唤醒别的成员「just burns a round」（`:67-72`）。
- leader 例外：拥有看板级决策，**观察每一次转换**（`:70-72,448-449`）。
- `from_poll and leader and not incomplete` → 静默返回（`:510-511`），避免轮询重复喂「全完成」提示。

**【事实】(4) 但对外事件流仍是细粒度**：Jiuwen 的 monitor 层把 team/member/task/message 事件**原样**暴露（`monitor/models.py:154-196` 的 `MonitorEventType`；`from_event_message` `:266-286`），只**排除**内部事件（计划审批/工具审批/worktree/锁等，`:157-160`）。产品侧 `team_helpers.py` 再把它们**逐条广播给前端**：
- 成员状态快照 → `event_type:"team.member"`，`type:"team.member.status_changed"`（`team_helpers.py:1666-1677`）；
- 任务状态快照 → `event_type:"team.task"`，`type:"team.task.status_snapshot"`（`:1686-1704`）；
- 并 `_persist_team_history_event` 落历史（`:1679,1701`）。

**【观察】** 附图中的主对话流被「子任务状态更新 / **收到任务消息** / **已完成，用时 X 秒**」刷屏。**【推断】** 这是**客户端把上述细粒度 `team.member/team.task/team.message` 事件直接渲染为对话条目**所致——Jiuwen **服务端**只提供了「事件」与「agent 上下文注入」两条通道，**没有**做「状态事件合并/折叠/侧栏化」的收口；是否成噪音取决于客户端渲染策略（前端工程不在本仓，无法取证）。
- 注意：Jiuwen 的**运行期**侧把状态与「是否耗轮」解耦（最小唤醒集），但**没有**把「状态事件」从「对外事件流」里去掉。→ **「不耗轮」≠「不刷屏」**，二者是不同层的问题。

### 2.B 与我们现状对照（dsh-swarm）

- **我方状态事件同样进对外流**：`team/member`（provisioning→active|failed）与 `team/task`（revision）写入 **Lead Session 日志**并驱动 `agentTeam` 投影 → **Web 面板**（`00-overview.md §1 K12-13`、`02-tools-and-messaging.md §2.6`）；帧里另有 `subagent-settled` inbox notice（`00-overview.md §3-⑦`）。**面板是上游原生能力，dsh-swarm 无自己的 UI**（`00-overview.md §1.6`）。
- **我方没有 Jiuwen 的「最小唤醒集」**：`team-bus.broadcast` = 逐人 DM（P24：3/3 成员各 +1 轮，`experiments-idle-wakeup.md §7.3`）；**广播不省轮**，与源系统一致（`§9`）。
- **我方派发 + 消息耦合度**：`send_message` 是独立工具；任务 `team_task_create` 与消息**无原子绑定**（`02-tools-and-messaging.md §2.1`）。Jiuwen 有「派发不靠消息、框架自动拉起」的清晰分层（`dispatch_autonomous_leader.md:6`）。

### 2.C 差距

| 项 | Jiuwen | 我方 | 差距性质 |
|---|---|---|---|
| 状态事件是否进「用户主对话流」 | 服务端**不进**（只进 agent 上下文 `<team-event>` + 对外**事件流**；是否成气泡由客户端定） | 服务端下发 `team.member/team.task` 事件 + `subagent-settled`；**面板/主对话渲染策略未收口** | 渲染层收口缺失 |
| 去噪/最小唤醒集 | **有**（`task_board.py:73-75`） | 无（广播唤醒全体） | 机制缺失 |
| 「状态事件合并/折叠」 | **服务端未做**，UI 自主 | 无 | 双方都缺（可作差异化改进） |
| 派发是否绑定消息 | 不绑定（自动拉起） | 解耦 | 已对齐 |

### 2.D 可移植改进项

- **[P0｜中，最高优先] 把「状态/事件」与「主对话」解耦**：明确区分三类通道——① **agent 上下文**（`<team-event>` 注入，Jiuwen 式）；② **侧栏/面板**（roster + 任务板，来自投影）；③ **主对话**（**只放 leader/人员的自然语言**）。落地：在客户端渲染层把 `team.member/team.task` 事件路由到侧栏、对主对话**只放「有语义的」状态**（如「已完成」折叠为一行可展开）。估算：前端为主 ~2–3d，**需先定位 dsh-swarm/DSH 前端渲染点**（见下【解锁】）。
- **[P1｜低] 状态事件「合并 + 上升沿」**：同一 `(member|task, status)` 的连续快照只保留**最新一条**（coalesce），并在事件里带 `revision/status`（我方 `team/task` 已自带 revision，天然可合并，`02-tools-and-messaging.md §2.6`）。估算：事件消费端 ~0.5d。
- **[P2｜中] 引入「最小唤醒集」**：把「看板变更唤醒空闲成员」从「任何 board churn」收窄到「可能扩大可认领池」的子集（对齐 `task_board.py:73-75`），并把 leader 除外。估算：`team-scheduler` 一处，~1d + 单测。
- **[P3｜低] 派发语义显式化（提示）**：在 `team-prompt` 明写「任务派发由框架自动拉起成员；`send_message` 不是启动开关」（对齐 `dispatch_autonomous_leader.md:6`），避免 leader 用消息当开关。

**【解锁条件】**：截图噪音的**修复落点**需先确认「哪套前端渲染主对话」（dsh-swarm 无自有 UI，`00-overview.md §1.6`；`subagent-settled` 属上游）。解锁=定位上游 web 面板/会话视图的渲染代码（`[H] packages/experimental/client-ui-agent-team`）。

---

## 维度 3：追问 / 多轮往返 / 成员复用

### 3.A Jiuwen 机制（带行号）

**【事实】(1) 多轮追加互动 = 「邮箱 + 事件唤醒」天然支持，无「一次任务一次往返」限制。**
- leader 可对同一成员**多次** `send_message`（每次 = 一行 direct 消息 + 一个 `MessageEvent`）；成员每轮结束若邮箱有新行，会被再次唤醒（`handlers/message.py:181-279` 的 `_process_unread_messages` **循环**读未读，`while True` `:205`）。
- 成员可在执行中收到「追加」：`deliver_input` 有两种模式——`use_steer=True`（steer 进当前轮）与 `use_steer=False`（follow-up 队列，轮末读）（`dispatcher.py:99-101`、`team_agent.py:436-441`）。看板提醒用 follow-up 不打断（`task_board.py:548-551`）。
- 无需阻塞等待：leader 派发后**结束轮次**，由入站消息唤醒新一轮（对照我方 `leader-wait-model.md §1.4`）。

**【事实】(2) 成员复用的保证 = roster 稳定 + 单活跃任务不变量 + assignee。**
- 成员是**持久 roster 行**，没有「用完即删」；`prompts/cn/dispatch_autonomous_leader.md:5` 允许 `create_task(assignee=<已存在成员>)` 直接预留；任务完成 → 成员回到 idle，可被**再次派活**（同一 `member_name`）。
- **单活跃任务不变量**：`prompts/cn/teammate_policy.md:11`「**同一时刻只能有一个进行中（in_progress）的任务**」→ 成员完成当前任务后才接下一个，天然形成「同一成员承接后续任务」的复用模型。
- **复用触发点**：`_nudge_idle_agent` 给 teammate 呈现「**可认领（pending+无主）+ 明确指派给本人**」的任务（`task_board.py:526-537`），使同一成员能在空闲后接到新活。
- **无成员删除**（对照我方 `00-overview.md §4 K3`：`failed` 占名额、名字永不复用）。

**【事实】(3) 任务状态推进靠事件**：`TASK_CLAIMED/STARTED/COMPLETED/UNBLOCKED/RELEASED`（`schema/events.py:137-155`）；验证闸 `TASK_SUBMITTED_FOR_REVIEW/TASK_VERIFIED/TASK_REVISION_REQUESTED`（`:150-155`），reviewer 被定向唤醒（`task_board.py:338-371`），返工把作者 steer 回（`:373-403`）。

### 3.B 与我们现状对照（dsh-swarm）

- **多轮**：我方 native `send_message` 对 running 目标在**最近 step 边界**投递、对 inactive 目标 **coldResume 启动/恢复**（`02-tools-and-messaging.md §2.2`；`leader-wait-model.md §1.2`）→ **多轮能力具备**。
- **但 leader 默认行为不一致**：原生提示「Lead must wait…before final answer」（`leader-wait-model.md §1.1`）诱导 leader **同轮阻塞 wait**（P46 红态复现；P57 才修好渐进披露让「事件唤醒优先」进 prompt，`leader-wait-model.md §9.6-§10`）。
- **成员复用**：`ownerId` 归属（`00-overview.md §3-③`），任务 complete 后 `owner` 保留（`§3-⑦`），**无成员删除 API、名字永不复用**（`§4 K3`）→ 复用语义与 Jiuwen 对齐（`assignee`↔`ownerId`）。

### 3.C 差距

| 项 | Jiuwen | 我方 | 差距性质 |
|---|---|---|---|
| 多轮追加互动 | 邮箱循环 + 事件唤醒 | 具备（step 边界/coldResume） | 已对齐 |
| leader 默认「派发后结束轮次」 | 是 | **默认常阻塞 wait**（P57 前），修复中 | 提示/默认行为 |
| 成员复用 | roster 稳定 + 单活跃 + assignee | roster 稳定 + ownerId | 已对齐 |
| 定向唤醒粒度 | 只唤醒相关人（收件人过滤） | DM-only（`team-core` 拒绝非 dm range，`leader-wait-model.md §7.3`） | 基本对齐 |

### 3.D 可移植改进项

- **[P1｜低] 固化「默认事件唤醒」（P57 已完成，补回归）**：确保 `team:dispatch`/`team:leader` 常驻含「派发后结束轮次、别长阻塞」（`leader-wait-model.md §7.1,§10`）。建议加**多轮采样回归**（防方差假绿，`§9.7`）。
- **[P2｜低] 追问的「定向唤醒」可观测**：`wait_agent` 被**消息**唤醒时返回并携带消息（当前只返回 boolean，`leader-wait-model.md §7.4`）——属上游项，登记。
- **[P3｜低] 复用率可观测**：新增「同一 member 承接任务数 / 空闲→认领时延」埋点（对齐 Jiuwen `_nudge_idle_agent` 的「指派给本人」可见性，`task_board.py:530-534`）。估算：~0.5d。

---

## 维度 4：「无回应」的兜底

### 4.A Jiuwen 机制（带行号）

**【事实】四层兜底，确保「用户/leader 的消息不会石沉大海」：**

1. **落库先行**：任何消息先写 `message_dao`（`message_manager.py:85-95`），即使订阅方不在线，消息也在 DB；成员重启后由**启动邮箱扫描**补投（`kernel.py:653-665` `enqueue_initial_mailbox_poll`）。
2. **未读台账参与完成闸**：`message_dao.has_unread_messages`（`message_dao.py:390-470`）——direct 消息存在未读且收件人未 SHUTDOWN 即真；团队完成判定要求「无未读 direct 消息」（`schema/events.py:202-213` `TeamCompletedEvent` docstring 明写 unread check）。
3. **关闭时排空邮箱**：`MessageHandler.on_member_shutdown_drain`（`handlers/message.py:98-123`）在成员关闭时以 **steer 模式**再排空一次邮箱，让「最后的消息」在 teardown 前到达；且 `_harness_input_blocked`（`:129-179`）保证**不会为一条告别消息唤醒一轮 LLM**（关闭中且无 in-flight → 直接落 SHUTDOWN）。
4. **伪成员/无消费者 ack**：
   - `user` 伪成员没有进程轮询邮箱 → **leader 代 ack**（`handlers/message.py:551-570` `_ack_user_bound_message`）；
   - human-agent 广播/定向投递时，passive human **由 leader 标记已读**（`:514-527`），否则完成闸的未读检查永远阻塞（注释 `:459-466`）。
5. **主动补投（定向）**：`_notify_passive_assignment`（`task_board.py:159-209`）把「发给 passive human 的认领」转为一条消息，避免静默消失。
6. **启动看板扫描**（F_69）：成员启动时一次性扫描看板，捞回「下线期间被指派的任务」（`task_board.py:467-485`）。

**【事实】Jiuwen 没有的**：**无硬 ack、无超时重投/升级**（由我方 `message-fallback-design.md §4` 显式指出：「Jiuwen=落库先行 + 未读闸 + 关闭时排空，无硬 ack / 无超时重投」）。

### 4.B 与我们现状对照（dsh-swarm）

- **已完成**：`team-completion` **已有未读闸**（`message-fallback-design.md §0`：监听 `team/message/{queued,delivered}`，`blockOnUnread` 默认 true，`evaluate()` 含 `noUnread`）。
- **我方缺失（Jiuwen 也没有）**：未读台账**持久性未证**、无显式 override、**无超时重投/升级**、无「未读阻塞」可观测事件（`message-fallback-design.md §0`）。
- **我方新增（超出 Jiuwen）**：P51 设计「限时未处理 → 重投一次（幂等 messageId）→ 升级 leader（人）裁决」+ `swarm/completion/unread-blocked` 可观测事件 + `overrideUnread`（`message-fallback-design.md §3,§7.1,§9`）。**这是对 Jiuwen 的增强**。
- **残余**：P51 实现后真实 profile **pending=0**（默认 `send_message` 走原生工具、不经 `ctx.teamCore.send`），即超时重投在真实路径**未生效**，待 P49（`message-fallback-design.md §9`）。

### 4.C 差距

| 兜底层 | Jiuwen | 我方 | 差距 |
|---|---|---|---|
| 落库先行 | 有 | 有（session append，`02-tools-and-messaging.md §2.6`） | 已对齐 |
| 未读闸 | 有（`message_dao.has_unread`） | 有（`team-completion`） | 已对齐（但持久性待证） |
| 关闭排空 | 有（steer 排空） | 未见等价「关闭排空」 | **可能缺失**（【仍不可推断】） |
| 伪成员/无消费者 ack | 有（leader 代 ack） | 未见明确等价 | **可能缺失**（【仍不可推断】） |
| 超时重投/升级 | **无** | **设计有（P51），真实路径未生效** | 我方领先但未落地 |
| 启动补投 | 有（邮箱扫描 + 看板扫描 F_69） | 有（coldResume + 初始 prompt 注入，`00-overview.md §3-②`） | 基本对齐 |

### 4.D 可移植改进项

- **[P0｜中] 补「关闭排空 + 伪成员 ack」**：Jiuwen 有、我方文档未见。先取证我方是否有等价物（`team-completion`/`team-core`），无则补。估算：~1–2d。
- **[P1｜中] 把 P51 的超时重投/升级真正接进真实路径**（默认 `send_message` 不走 `ctx.teamCore.send`，`message-fallback-design.md §9`）——否则兜底只在单测成立。估算：`team-core`/工具路径 ~1–2d（待 P49）。
- **[P2｜低] 未读台账持久化（依赖 P50）**：`swarm/completion/unread` 跨重启正确性（`message-fallback-design.md §7.3`）。
- **[P3｜低] 完成闸「有界解封」单测**（对齐 `message-fallback-design.md §7.1` 的终止性论证），防「未读闸把团队锁死」。

**【仍不可推断 + 解锁条件】**：我方是否有「成员关闭前排空邮箱」「user/passive 伪成员代 ack」的等价实现——本任务只读源码/文档，未在 `packages/*/src` 逐一验证；解锁=在 `packages/team-{core,completion,bus}/src` grep `drain|drainMailbox|onShutdown|ack`。

---

## 附 A：四维度对照总表

| 维度 | Jiuwen 机制（带行号） | 我方现状 | 差距 | 最高优先改进 |
|---|---|---|---|---|
| 1 群聊/@ | 运行时语法 `#/$/@/@all`（`router.py:10-31`）+ 提示纪律（`leader_policy.md:9`）；成员用 `send_message` | 无 channel/@；broadcast 已对齐；quiet 空转、multicast 不可用 | 语法缺失 + 2 处实现缺陷 | P1 修 quiet；P2 修 multicast |
| 2 消息-任务/噪音 | 派发不绑消息（`dispatch_autonomous_leader.md:6`）；状态进 `<team-event>` 上下文；最小唤醒集（`task_board.py:73-75`）；对外事件细粒度（`team_helpers.py:1666-1704`） | 状态事件进对外流/面板；无最小唤醒集；广播唤醒全体 | 渲染收口缺失 + 机制缺失 | **P0 状态↔主对话解耦**；P2 最小唤醒集 |
| 3 追问/复用 | 邮箱循环（`message.py:205`）+ 事件唤醒；roster 稳定 + 单活跃任务（`teammate_policy.md:11`）+ assignee | 多轮具备；默认常阻塞 wait（修复中）；复用对齐 | 默认行为 + 可观测 | P1 固化事件唤醒 + 回归 |
| 4 无回应兜底 | 落库 + 未读闸（`message_dao.py:390`）+ 关闭排空（`message.py:98-123`）+ 伪成员 ack（`:551-570`） | 有未读闸；无重投/升级（Jiuwen 也无）；P51 设计未生效 | 关闭排空/ack 待取证；P51 未落地 | P0 补排空+ack；P1 落地重投 |

## 附 B：关键证据索引（Jiuwen）

- 路由语法：`…/agent_teams/interaction/router.py:10-31,60,64-78,120-217,273-336`
- 收件箱：`interaction/user_inbox.py:35-88`；`interaction/human_agent_inbox.py:85-106,153-255`
- 消息工具：`tools/tool_message.py:140-264,326-387,390-457`
- 消息管理器：`tools/message_manager.py:60-162,164-225`
- 事件模型：`schema/events.py:30-47,137-155,202-213,272-283,648-695`
- 进程内总线：`messager/inprocess.py:21-54`
- 订阅/自过滤：`agent/coordination/kernel.py:579-617（含 590-611）`
- 消息/关闭/ack：`agent/coordination/handlers/message.py:73-89,98-123,129-179,181-279,551-570`
- 看板最小唤醒集/派发：`agent/coordination/handlers/task_board.py:60-75,159-209,338-403,434-465,467-551`
- 提示词：`prompts/cn/leader_policy.md:9,21`；`prompts/cn/teammate_policy.md:11`；`prompts/cn/dispatch_autonomous_leader.md:5-6`；`prompts/cn/inbound_tags.md:8`
- monitor：`monitor/models.py:154-196,266-286`
- 持久化：`tools/database/message_dao.py:390-470`
- 流模型：`schema/stream.py:19-73`
- 产品侧事件下发：`jiuwenswarm/server/runtime/agent_adapter/team_helpers.py:563-600,1666-1704`

## 附 C：关键证据索引（dsh-swarm 现状）

- `docs/investigation/00-overview.md`：§1 TL;DR、§3 生命周期、§4 K1-K14、§5 缺口
- `docs/investigation/02-tools-and-messaging.md`：§2.2 投递、§2.3 quiet 空转、§2.4 自过滤/无队列、§2.5 wait_agent、§2.6 事件与投影、§2.9 描述-实现出入
- `docs/leader-wait-model.md`：§1 事实、§7 阶段2、§9.6/§9.7 更正、§10 P57 复核
- `docs/experiments-idle-wakeup.md`：§7 P24 重测、§9 P27 对齐（广播唤醒全体）
- `docs/message-fallback-design.md`：§0 未读闸现状、§3 重投/升级、§7.1 终止性、§9 P51 实现
