# Jiuwen team-leader 行为逻辑 → dsh-swarm 迁移规格（逐环节对照 + checklist）

> 产出人：interaction-analyst ｜ 任务：P70-leader-behavior-spec ｜ 时间：2026-10-28
> 性质：**只读调研 + 新写一份文档，不改 `packages/*/src`**（先规格、后实现）。
> Jiuwen 权威源：`/opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen/agent_teams/`（下称 `…/agent_teams/`）
> dsh-swarm 现状源：`packages/team-prompt/src/index.ts`、`docs/{prompt-comparison-team-mode.md, leader-wait-model.md, message-fallback-design.md, investigation/02-tools-and-messaging.md, dsh-team-mode-investigation.md}`
> 约定：**【事实】**=读到源码/文档；**【推断】**=合理推出未实测。
> **去重声明**：提示词逐句比对已由 **P53 `docs/prompt-comparison-team-mode.md`** 完成（26 行对照表），且 **P54/P57/P62/P64 已落地多段 leader 约束**。本文**不重复**这些，只做「**行为环节（loop）级** 对照 + 剩余缺口 + prompt/code 分流 + 边界 + 风险」。

---

## 0. 结论速览（最大行为差距 Top5）

1. **【事实·代码级】验收闸不完整**：Jiuwen 有 **verifier / inspector / challenger 三型验证者 + 调度框架自动交接 + 轮数上限**（`dispatch_scheduled_leader.md:8,15-27,101-112`）；dsh-swarm 的 `team-review` **无评审池时直接完成**、`in_review` 期间可被 `complete`、`inspector` 票**永不计票**（`investigation/02 §2.9 C/E`）。→ **leader 的「验收」环节基本是空壳**。
2. **【事实·代码级】「升级」环节缺失**：Jiuwen 在「验收轮数耗尽 / reviewer 超时未投票」时**自动升级给 leader**，leader 按「等 inbox 返工总结 → 综合判断 → retry vs replan」处置（`dispatch_scheduled_leader.md:108-126`）。dsh-swarm **无验收升级路径**（`investigation/02` 未列；`message-fallback-design.md` 的「升级 leader」是**消息兜底**，不是验收升级）。
3. **【事实·提示词级】「起手先建成员再建任务」仍靠 leader 自觉**：已在 `team-prompt` 的 `team:leader` 段落地（P54，`team-prompt/src/index.ts:114`），但**无「完成判定」层的强制**；Jiuwen 用 `build_team` 强制起手（`leader_bootstrap.md:4`）+ 工作流「先建成员，再规划任务」（`leader_workflow.md:6`）。→ 提示已补，**机制未兜底**。
4. **【事实·代码级】「收口」判定条件不对齐**：Jiuwen 团队完成需**三条件同真**（任务全终态 + 成员 settled + **无未读 direct**，`team_completion.py:119`、`events.py:202-213`）；dsh-swarm `team-completion` 只有**未读闸**（`message-fallback-design.md §0`），缺「成员 settled」的显式条件。
5. **【事实·提示词级】「闲时」判据缺失**：Jiuwen 明写「事件驱动不轮询 / 成员 idle 是正常状态 / 长期停滞才介入」（`leader_policy.md:33-36`）；dsh-swarm 已对齐「事件唤醒」（P46/P57），但**缺「idle 正常、不要催」与「何时介入」的判据**。

> 一句话：**dsh-swarm 已在「提示词层」把 leader 的「不干活 + 先建成员 + 事件唤醒 + 广播/追问」补得七七八八（P54/P57/P62/P64）；真正的差距集中在「代码层」的验收闸、返工轮控、升级处置、完成判定——这些提示词解决不了。**

---

## 1. 行为环节对照（逐条带行号）

> 每环节：**Jiuwen 怎么做（prompt / runtime 行号）↔ 我们怎么做 / 缺失**。已由 P53/P54/P57/P62/P64 覆盖的，标 `[已对齐]` 并简述，不展开。

### 1.1 起手（bootstrap）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 第一步先组队 | `leader_bootstrap.md:4`「第一步就调用 `build_team`，不要犹豫」 | 无 `build_team`；`team:leader` 段「先 spawn_teammate + team_task_create 再动手」（`team-prompt/src/index.ts:114`） | **[已对齐·提示词]**（P54 改写移植） |
| leader 前缀只放最小段、其余延后披露 | `team_policy_rail.py:385-435` `_build_leader_sections`（仅 bootstrap + extra）；协作约定随 `build_team` 结果下发 | 渐进披露 `DEFERRED_BEFORE_TEAM=['team:dispatch','team:task-state']`（`team-prompt/src/index.ts:80`）；`team:leader` 常驻不延后（`:76-79`） | **[已对齐]**（P57 修 `teamBuilt` 判定 bug 后生效） |
| 「不执行任务」负向约束 | `leader_bootstrap.md:1`；`leader_policy.md:21` | `team:leader` 段 1（`team-prompt/src/index.ts:113`） | **[已对齐·提示词]** |
| 起手 persona | 「你是 TeamLeader…」（`leader_bootstrap.md:1`） | swarm preset persona 仍是「You are a coding agent…」（`bundle/presets/swarm.patch.yml:15`） | **[需适配·代码]** bundle persona 未改（P53 §9.4 已提，属 bundle 地盘） |

### 1.2 派发（dispatch）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 拆 DAG 再派 | `leader_policy.md:7`「将目标分解为粗粒度任务 DAG…设置依赖」 | `team:task-state` 只讲状态流转（`:170`）；无「先拆 DAG」句 | **[需适配·提示词]** |
| 成员先于任务 | `leader_workflow.md:6`「成员必须先于任务存在」 | `team:leader` 段 2（`:114`） | **[已对齐·提示词]** |
| 派发方式（认领 vs 指派） | 自主模式：`dispatch_autonomous_leader.md:5-9`；调度模式：`dispatch_scheduled_leader.md:2-13`（`create_task` 必带 `assignee`；调度框架代交接） | `team:dispatch` 段（`:160`）「就绪任务由调度器派发；你也可主动认领」；`team-scheduler` 默认 scheduled（`team-scheduler/src/index.ts:70,519`，见 `dsh-team-mode-investigation.md:203`） | **[部分对齐]**：派发机制有；**缺「必须指定 assignee」的强制提示**（调度模式下无 assignee 任务永不执行，`dispatch_scheduled_leader.md:11`） |
| 任务 API | `tools/tool_task.py`（`create_task`/`update_task`/`claim_task`/`complete_task`） | 原生 `team_task_create/list/get/update`（`tool-agent-team/src/index.ts:298-400`） | **[已对齐]** |

### 1.3 追问（follow-up / 多轮）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 用 DM 传递上下文/追问 | `leader_policy.md:9`「信息枢纽…优先单播定向」；`handlers/message.py` leader 观察流量 | `team:leader` 段 6「收口期 DM 追问，不自己重做」（`:118`） | **[已对齐·提示词]**（P62） |
| 广播慎用（成本警示） | `leader_policy.md:9` | `team:leader` 段 5（`:117`）「广播唤醒全体、少而重」 | **[已对齐·提示词]**（P62） |
| 多轮追加互动 | 邮箱 + 事件唤醒（`handlers/message.py:181-279` 循环读未读） | DM 在最近 step 边界投递 / inactive coldResume（`leader-wait-model.md §1.2`） | **[已对齐]** |
| 通道选择（DM/多播/广播） | `leader_policy.md:16-18`（内容形态决定通道） | `team:leader` 段 5 按「影响面」选（`:117`） | **[已对齐·提示词]** |

### 1.4 收口（close-out / completion）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 完成判定条件 | `team_completion.py:96-129` `on_poll_task` → `is_team_completed()`：**三条件同真**（任务全终态 + 成员 settled + 无未读 direct，`events.py:202-213`） | `team-completion`：仅**未读闸** `blockOnUnread=true`（`message-fallback-design.md §0`） | **[需代码]**：缺「成员 settled」显式条件 |
| 判定时机 | leader 空闲 tick（`team_completion.py:96-104`，rising-edge guard `:124-129`） | 未明确 | **[需代码/待核实]** |
| 长期团队收尾 | `lifecycle_persistent.md:1-8`：完成所有任务 → 汇总 + `send_message(to="*")` 一次广播 + 不关成员，转待命 | dsh-swarm 无「长期/临时」生命周期语义（`team-prompt` 无 lifecycle 段） | **[需代码/提示词]** |
| 临时团队收尾 | `lifecycle_temporary`（leader `clean_team`） | — | **[需代码]** |
| 全局完成事件 | `TeamCompletedEvent`（`events.py:202-213`）+ `TASK_LIST_DRAINED`（`:417-424`） | 有 `team-completion` 但事件面不同 | **[部分对齐]** |

### 1.5 验收（review / verification gate）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 验证者三型 | **verifier / inspector / challenger**（`dispatch_scheduled_leader.md:23-27`） | `team-review` 有 `review_submit`/`review_vote`，但**无类型语义**（`investigation/02 §2.1.2`） | **[需代码]** |
| 结构化 reviewer 分配 | `create_task(reviewer=[{type,instruction}])`（`dispatch_scheduled_leader.md:8,17-27,88-99`） | 无结构化 reviewer；`review_submit(task_id)` 只入 `in_review` | **[需代码]** |
| 自动交接（派发验证请求/收齐/翻转） | `dispatch_scheduled_leader.md:105`「调度框架代你完成全部验收交接」；`scheduler_review_request.md` 授权验证者 | 无；`review_submit` **无评审池时直接完成**、`in_review` 期间 `complete` 不被阻止（`investigation/02 §2.9 C`） | **[需代码·核心缺口]** |
| 一票否决 / 打分通过线 | 任一 verifier fail 即打回（`:25`）；inspector 平均 ≥0.85（`:26`） | 无 | **[需代码]** |
| leader 何时介入验收 | 仅「卡死时」（`:108-112`） | — | **[需代码]** |
| inspector 计票 | 计票 | **`inspector` 票永不计票**（bundle 池只有 verifier/challenger，`investigation/02 §2.9 E`） | **[需代码·缺陷]** |

### 1.6 返工（rework）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 打回并给反馈 | `scheduler_rework.md:1-11`（含轮数上限 `max_rounds` + `feedback`） | `review_vote(decision=fail)` 有反馈文本，但**无轮数上限** | **[需代码]** |
| 状态翻转 | `in_review → in_progress`（`task_state_scheduled.md:15`） | `team-review` 有 `in_review` overlay（`team-core` 读侧） | **[部分对齐]** |
| 超时重催 | `scheduler_review_renudge.md`（reviewer 超时未投票重催） | 无 | **[需代码]** |
| 验证通过派发汇报 | `scheduler_verified_report.md:1-3`（通知 author 向 leader 汇报） | 无 | **[需代码]** |

### 1.7 升级（escalation）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 触发条件 | 验收轮数耗尽 / reviewer 超时未投票（`dispatch_scheduled_leader.md:108-112`） | **无** | **[需代码·缺失]** |
| 处置流程 | 「**等 inbox** 收承担者返工总结 → 综合 reviewer 反馈 + 总结判断根因 → retry（放宽轮数/重置）vs replan（换人/调 reviewer/改内容）」（`:113-126`） | 无 | **[需代码·缺失]** |
| 升级消息载体 | 调度器 → leader inbox（`scheduler_rework_summary.md`） | `message-fallback-design.md` 有「undelivered→DM 升级 leader」，但那是**消息投递兜底**，与验收无关 | **[边界]**（勿混） |

### 1.8 闲时（idle / 响应节奏）

| 子行为 | Jiuwen | dsh-swarm | 状态 |
|---|---|---|---|
| 事件驱动不轮询 | `leader_policy.md:33` | `team:dispatch`（event-wake，`:160`） | **[已对齐·提示词]**（P46/P57） |
| 成员 idle 正常、不要催 | `leader_policy.md:34`「idle ≠ 卡死，不要催促或重发启动消息」 | 无此句 | **[需适配·提示词]** |
| 长期停滞才介入 | `leader_policy.md:35`「长期无进展…必要时 `shutdown_member(force=true)`」 | 无判据；工具 `interrupt_agent` 存在（Lead-only） | **[需适配·提示词]** |
| leader 独占的输入处理 | `TeamPolicyRail.before_steering_drain` leader exempt（`team_policy_rail.py:247-256`）、`_drop_superseded` leader 不剪枝（`:267-273`） | 无对应 | **[不可迁移·原因见 §3]**（Jiuwen 特有，DSH 输入队列模型不同） |

---

## 2. 可迁移 checklist

> 标记：**【可移植·提示词】**=改 `team-prompt` 段即可；**【需代码】**=改/新增 `packages/team-*` 能力；**【不可迁移·原因】**。
> 优先级 P0/P1/P2。**与 P53 §4 的建议清单合并去重**（P53 的提示词项多数已由 P54/P57/P62/P64 落地，下表只列**尚未落地**的）。

### 2.1 提示词层（改 `team-prompt` 段）

| # | 行为 | 建议 | 目标段 | 优先级 | 状态 |
|---|---|---|---|---|---|
| A1 | 派发前拆 DAG | 在 `team:task-state` 补「派发前先 `team_task_list` 看清板、用 `team_task_create` 拆粗粒度 DAG、写清 content 验收标准」 | `team:task-state` | P1 | **未做**（P53 建议中，未落地） |
| A2 | 调度模式必带 assignee | 在 `team:dispatch` 明写「**每个任务必须有 assignee**，无 assignee 的任务永不执行」 | `team:dispatch` | **P0** | **未做**（防 DAG 僵死） |
| A3 | 成员 idle 正常、不要催 | 在 `team:dispatch` 补「成员 idle 是正常状态，不要催促/重发启动消息」 | `team:dispatch` | P2 | **未做** |
| A4 | 长期停滞才介入 | 补「仅当成员长期无进展且未汇报阻塞时才介入；必要时 `interrupt_agent`」 | `team:dispatch` | P2 | **未做** |
| A5 | 验收/返工措辞 | `team:task-state` 补 `in_review` 语义 + 「成员汇报后你亲自审阅、必要时要求返工」 | `team:task-state` | P1 | **未做**（P53 建议，未落地） |
| A6 | persona 改 leader 语义 | swarm preset persona prefix 由「coding agent」改 leader 语义 | `bundle/presets/swarm.patch.yml`（**属 bundle 地盘，先报 leader**） | P1 | **未做**（P53 §9.4） |

> 已落地（**不重复**）：leader 不执行（`team:leader` 段 1）、先建成员再建任务（段 2）、背景不清先建调研成员（段 3）、事件唤醒/禁长阻塞（段 4）、广播/多播发起协同（段 5）、收口期 DM 追问（段 6）、中文显示名（段 7）、@约定（段 8）——见 `team-prompt/src/index.ts:109-135`。

### 2.2 代码层（改/新增 `packages/team-*`）

| # | 行为 | 建议 | 落点 | 优先级 | 风险 |
|---|---|---|---|---|---|
| B1 | **验收闸补全**：三型 reviewer + 类型计票 | `team-review` 引入 `verifier/inspector/challenger`；inspector 平均分阈值；修复「inspector 不计票」 | `team-review` | **P0** | 见 §4-R3 |
| B2 | **`in_review` 期间阻止直接 `complete`** | 修复「`review_submit` 无池直接完成」「in_review 可 complete」 | `team-review`/`team-core` | **P0** | 若强制 in_review 但无交接 → 永不完成（§4-R3） |
| B3 | **轮数上限 + 超时重催** | `max_review_rounds` + reviewer 超时重催 | `team-review`/`team-scheduler` | P1 | — |
| B4 | **验收升级 → leader** | 轮数耗尽/超时未投 → 升级消息进 leader inbox，含「等返工总结→retry/replan」处置 | `team-scheduler`/`team-review` | **P0** | 需与 B1/B2 一起上，否则升级无意义 |
| B5 | **完成判定加「成员 settled」** | `team-completion` 完成条件由「仅未读闸」+「成员 settled」同真 | `team-completion` | P1 | 与 B1 联动 |
| B6 | **长期/临时生命周期** | 引入 lifecycle（persistent 收尾广播待命 vs temporary clean） | `team-completion`/`team-prompt` | P2 | — |
| B7 | **persona/段与 bundle 解耦** | 若 A6 需要，改 `bundle`（先报 leader） | `bundle` | P2 | — |

### 2.3 不可迁移（含原因）

| # | 行为 | 原因 |
|---|---|---|
| C1 | **leader 对输入队列的特权**（`before_steering_drain` leader exempt / `_drop_superseded` leader 不剪枝，`team_policy_rail.py:247-273`） | Jiuwen 特有：其「任务看板快照」是**队列输入**、leader 读**序列**（哪条出现/移动）来决策；DSH 看板是状态投影而非队列输入，模型不同。**【需适配·非等价】** |
| C2 | **`build_team` 起手工具**（`leader_bootstrap.md:4`） | DSH 无「建队」原语，团队是根会话视图（`investigation/00 §1`）。已用「先 spawn+task_create」改写（P54），**非直迁**。 |
| C3 | **精确的「三条件完成判定」中的未读 direct 语义** | DSH 消息**不进 mailbox**（`team/message/*` 已废，`investigation/01 §1.4`），「无未读 direct」无直接对应物 → 需重定义（归 B5）。 |

---

## 3. 与既有结论的边界（不重复 / 不推翻）

| 既有结论 | 出处 | 本文立场 |
|---|---|---|
| **`wait_agent` 假绿**：P46「改后不再调 wait_agent」是方差假绿，根因是 `team:dispatch` 被渐进披露永久过滤（`teamBuilt` 判定 bug） | `leader-wait-model.md §9.6-§9.7` | **不重复**；P57 已修 bug 并独立复核通过（`§10`）。本文的「闲时」环节**默认这些成立**。 |
| **广播语义 = 唤醒全体非发送者**（与源系统一致，非缺陷、无省轮空间） | `experiments-idle-wakeup.md §9`（P27） | **不重复**；本文 A/段 5 的「广播慎用」是**成本引导**，不是说广播本身该改。 |
| **派发归属（assign/ownerId）** | P42 | **不重复**；本文 B4 的「升级→改派」复用既有 reassign，不加新归属机制。 |
| **消息兜底（未读闸 + 超时重投 + 升级 leader）** | `message-fallback-design.md`（P51） | **不重复**；明确区分：P51 的「升级」是**消息投递**兜底，本文 B4 的「升级」是**验收闸**升级，**两者独立、勿合并**。 |
| **leader 提示词约束（不执行/先建成员/事件唤醒/广播/追问/@）** | P53 建议 + P54/P57/P62/P64 落地 | **不重复**；本文只列**尚未落地**的 A1-A6。 |
| **状态消息噪音 / 群聊数据流** | P60/P65 | **不相关**；本文不涉及 UI。 |

---

## 4. 风险（可能引入新停滞 / 新噪声）

- **R1【新停滞】强制「先建成员再建任务」**（A2/B5）：对 **trivial 一次性请求**（如「查个时间」）也强制建队 → leader 过度建成员、成本上升。**缓解**：措辞用「需要多步/多领域时」而非「一律」，保留「直接答」出口。
- **R2【新停滞】「leader 不执行」禁令过强**（已落地，勿再加码）：若某能力无对应成员且不允许自做，leader 卡住。**缓解**：保留「没人就造一个」退路（已在段 2/3）。
- **R3【核心·新停滞】验收闸补全若只做一半**（B1+B2 不同步）：若把 `in_review` 设成**强制**（B2）但**无自动交接/升级**（B4），任务会**永久停在 in_review**——这正是 Jiuwen 用「调度框架自动交接 + 升级 leader」兜住的地方。**缓解**：B1/B2/B4 **必须一起上**，且要有「无 reviewer 则不阻塞直接完成」的默认；上之前先做**终止性论证**（对齐 `message-fallback-design.md §7.1`）。
- **R4【新停滞】未读闸死锁**（P51 已识别）：`blockOnUnread=true` + 某成员永不读 → 任务永不完成。**缓解**：沿用 P51「超时→重投→升级→override」有界解封（`§7.1`）；B5 加「成员 settled」条件时**同样要有界**。
- **R5【新噪声】广播引导（段 5/P62）若被过度使用** → 广播刷屏（唤醒全体）。**缓解**：段 5 已写「少而重、绝不能当刷屏用」（`team-prompt/src/index.ts:117`）；不要再加「多发广播」类引导。
- **R6【新噪声】验收升级消息若直推主对话** → 与 P60/P65 已识别的「状态噪音」叠加。**缓解**：升级消息走 leader inbox（DM），**不进用户主对话**（对齐 `dispatch_scheduled_leader.md:113-117`「等在 inbox」）。
- **R7【回归】改 persona（A6）触及 bundle** → 可能影响非团队场景。**缓解**：先报 leader、限定 preset（P53 §9.4 已提）。

---

## 附 A：源码锚点速查

**Jiuwen（`…/agent_teams/`）**
- 起手：`prompts/cn/leader_bootstrap.md:1,4,6,8`；`rails/team_policy_rail.py:385-435`
- 工作流：`prompts/cn/leader_workflow.md:4-9`；`prompts/cn/leader_workflow_predefined.md:1-11`
- 角色政策：`prompts/cn/leader_policy.md:4,7,9,21-25,33-36`
- 派发：`prompts/cn/dispatch_autonomous_leader.md:5-9`；`prompts/cn/dispatch_scheduled_leader.md:2-17,88-99,101-126`
- 状态：`prompts/cn/task_state_autonomous.md:2-18`；`prompts/cn/task_state_scheduled.md:2-21`
- 验收/返工/升级：`prompts/cn/scheduler_{review_request,review_renudge,rework,rework_summary,verified_report,task_start}.md`
- 收口：`agent/coordination/handlers/team_completion.py:96-205`；`prompts/cn/lifecycle_persistent.md:1-8`；`schema/events.py:202-213,417-424`
- 输入特权：`rails/team_policy_rail.py:236-285`

**dsh-swarm**
- 段与落地：`packages/team-prompt/src/index.ts:109-135`（leader 段）、`:137-181`（其它段）、`:200-234`（渐进披露）
- 既有结论：`docs/prompt-comparison-team-mode.md`（P53）、`docs/leader-wait-model.md`（P45/P46/P57）、`docs/message-fallback-design.md`（P51）、`docs/experiments-idle-wakeup.md`（P24/P27）、`docs/investigation/{00-overview,01-core-model,02-tools-and-messaging}.md`、`docs/dsh-team-mode-investigation.md`
- 能力包：`packages/{team-review,team-scheduler,team-completion,team-core,tool-swarm}`

## 附 B：最大行为差距 Top5（供汇报）

1. **验收闸空壳**：无三型 reviewer / 无自动交接 / inspector 不计票 / in_review 不阻塞（B1/B2）。
2. **升级缺失**：验收轮数耗尽与 reviewer 超时无升级路径（B4）。
3. **返工无轮控**：无 `max_review_rounds`、无超时重催（B3）。
4. **完成判定不对齐**：只有未读闸，缺「成员 settled」（B5）。
5. **派发提示缺硬约束**：调度模式下「必须带 assignee」未写明（A2）。
