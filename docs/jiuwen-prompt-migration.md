# Jiuwen 团队提示词 → dsh-swarm `team-prompt` 迁移规格 + checklist

> 产出人：prompt-engineering-analyst（P69）
> 时间：2026-10-28
> 性质：**先规格、后实现**——**只读调研 + 新写本文档**；**未改 `packages/*/src`**。
> 约定：区分 **【事实】**（带 文件:行 核实）与 **【推断】**（未逐行验证）。
> 取源两侧：
> - Jiuwen 侧：`/opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen/agent_teams/prompts/{cn,en}/*.md`（~40 模板）+ `prompts/sections.py` + `rails/team_policy_rail.py`。下文行号均指 **cn** 版本。
> - 我们侧：`packages/team-prompt/src/index.ts`（行号为本文档撰写时的当前 `main`）。
> - 复用 P53 `docs/prompt-comparison-team-mode.md` 与 T7 `prompt-engineering.md`，但**已按行号重新核实**。

---

## 0. 结论速览：最大差距 Top5（详见 §3）

| # | 差距 | 我方现状 | 建议 | 优先级 |
|---|---|---|---|---|
| 1 | **Leader 起手动作 + 完整协同准则的"一次性下发"** | 我方把「不亲自执行」硬约束放常驻 `team:leader`（P54/P57），但**没有**"先 build_team、拿到准则再规划"的**起手序列** | 补一句「先建队/先建人再规划」的起手动作；准则是否集中下发见 §4 讨论 | **P1** |
| 2 | **任务状态机引导** | 我方 `team:task-state`（`index.ts:166-171`）只有一句「关注 pending→in_progress→completed」；**缺 in_review 验证闸、planning 计划闸、blocked 依赖、终态** | 直接移植 `task_state_*.md` 的转换清单（含 `in_review`） | **P1** |
| 3 | **任务下发（scheduled 指派模式）** | 我方 `team:dispatch`（`index.ts:155-164`）只讲"派发后结束轮次/事件唤醒"，**未讲 assignee 落定、reviewer 结构化、调度框架代交接** | 移植 `dispatch_scheduled_leader.md:5-13` 的**指派纪律**（改写，见 checklist） | **P1** |
| 4 | **收口/验收/升级** | 我方仅 P62 ⑥「收口期追问」；**缺**"复杂产物交独立汇总成员收口""验证卡死才介入/retry vs replan" | 移植 leader_policy `:5,:25` + dispatch_scheduled_leader `:108-126` | **P1** |
| 5 | **leader 决策原则的"细节护栏"** | 我方缺 **fork 继承**、**worktree 纪律**、**没人就造一个**、**独立汇总成员** | 移植 leader_policy `:22-27` 四条（改写工具名） | **P2** |

> 【事实】我方 `team:leader` 段**已覆盖** Jiuwen 最核心的「Leader 不亲自执行」：`index.ts:111`（cn 第 1 条）对应 `leader_policy.md:21` + `leader_bootstrap.md:1`。**这是 P54 的核心移植，已完成。**

---

## 1. 两侧结构对照（骨架）

**【事实】Jiuwen 侧**（`sections.py:82-92` `SECTION_PRIORITY`，`sections.py:62-75` `TeamSectionName`）：

| 优先级 | 段 | 模板来源（`sections.py` 构建器） | 适用角色 |
|---|---|---|---|
| 10 | `team_identity` | 内联（member_name+私有工作约定），仅外部 CLI | 全角色 |
| 11 | `team_role` | `leader_policy`/`teammate_policy`(+external)/`human_agent_policy` | 各角色 |
| 12 | `team_hitt` | `hitt_*` | 按 hitt_enabled |
| 12 | `team_bridge` | `bridge_agent` | BRIDGE_AGENT |
| 13 | `team_workflow` | `leader_workflow{,_predefined,_hybrid}` | LEADER |
| 14 | `team_lifecycle` | `lifecycle_persistent`/`lifecycle_temporary` | LEADER |
| 15 | `team_dispatch` | `dispatch_{autonomous,scheduled}_{leader,teammate}` | LEADER+TEAMMATE |
| 16 | `team_task_state` | `task_state_{autonomous,scheduled}` | LEADER |
| 17 | `team_extra` | 用户 base prompt | 全角色 |
| 18 | `team_inbound_tags` | `inbound_tags` | 全角色 |

- 【事实】LEADER 的系统提示词**只取两段**（`team_bootstrap`≈`leader_bootstrap`+`team_extra`），其余协作约定**延后到 `build_team` 工具结果披露**：`team_policy_rail.py:385-435`（`_build_leader_sections`）、`sections.py:795-853`（`build_leader_policy_disclosure`）。
- 【事实】`team_state`（身份/团队信息/roster）**不是段**，走会话历史消息（`sections.py:43-45`、`team_context.py`）。

**【事实】我们侧**（`packages/team-prompt/src/index.ts`）：
- 稳定段（进前缀）：`team:leader`(order 10, `:143`)、`team:role`(11, `:148`)、`team:dispatch`(15, `:155`)、`team:task-state`(16, `:166`)、`team:inbound`(18, `:173`)。
- cache-safe context（不进前缀）：`team:identity`/`team:roster`/`team:info`（`:71`, `apply` 内注册）。
- 渐进披露：`DEFERRED_BEFORE_TEAM = ['team:dispatch','team:task-state']`（`index.ts:79`），团队未建（无 `team/member` 事件）时过滤；`team:leader` **刻意不过滤**（`:9-10`,`:76-78`）。

> **对照结论**：我们侧**段数更少、更"精炼"**（把 Jiuwen 的 10 类段压成 5 段 + 3 context），**说明我方"更多"的是**：P54/P57/P62/P64 的**判据式硬约束**（等待模型、通道选择、显示名/@）——这些在 Jiuwen 里分散在 `leader_policy.md`/`teammate_policy.md` 长文里，我方做了**集中+硬化**。

---

## 2. 逐条对照表（按内容域；缺失显式标「缺失」）

> 列：Jiuwen 原句（文件:行） | 我方对应（文件:行）/缺失 | 对齐度 | 差异要点

### 2.1 Leader 身份 · 起手 · 不亲自执行

| # | Jiuwen（文件:行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.1.1 | `leader_bootstrap.md:1`「你是 TeamLeader…你自己不执行任务，只做规划、协调、裁决和向用户汇报」 | `index.ts:111`（cn 条 1） | ✅ 已覆盖 | 我方以条件主语+负向禁令硬化，且点名"查资料/读代码/写报告" |
| 2.1.2 | `leader_bootstrap.md:3-4`「起手动作：第一步就调 `build_team`，在此之前不调任何其他团队工具」 | **缺失** | ❌ | 我方无 build_team 概念（DSH 用 spawn/任务），**需改写**见 §3 |
| 2.1.3 | `leader_bootstrap.md:6`「无论团队是否已存在都调这一次；已存在则接管」 | **缺失** | ❌ | DSH 无"接管"语义——**不可迁移**（机制不存在） |
| 2.1.4 | `leader_bootstrap.md:8`「完整协同准则在 build_team 返回时一次性下发」 | **缺失**（我方准则常驻前缀） | ⚠️ 不同策略 | 我方选择**常驻前缀**（P57 教训：被过滤会藏掉约束）——**不建议改成延后下发**，见 §4 |

### 2.2 Leader 核心理念 · 决策原则（`leader_policy.md:3-30`）

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.2.1 | `:4`「你的职责是定义做什么/为什么做，而非怎么做」 | **缺失** | ❌ | **P2**：可移植一句"给目标+验收+约束，别微管理" |
| 2.2.2 | `:7` 目标拆解为**粗粒度任务 DAG**（用 `create_task`+依赖） | 部分（`index.ts:112` 条 2 讲先建人建任务，未讲 DAG/依赖） | ⚠️ 部分 | **P1**：补"拆 DAG + 依赖" |
| 2.2.3 | `:8` 用 `spawn_teammate` 按领域建成员，`desc` 写专业背景；plan/build 审批 | 部分（`index.ts:112` 有 spawn；desc 未提；mode 见 §2.7） | ⚠️ 部分 | **P1**：补"用 desc 写专业背景" |
| 2.2.4 | `:9` 信息枢纽 `send_message`；**广播唤醒全体、慎用**（模型：单播定向优先） | `index.ts:115`（P62 条 5，影响面判据）+ `:158`(dispatch) | ✅ **我方更多** | 我方给出**三类通道判据 + 少而重**，比 Jiuwen「慎用」更细 |
| 2.2.5 | `:12-18` 成果交接：**短内容直接发 / 成型产物走文件 / 落团队共享目录** | **缺失** | ❌ | **P2**：可移植（DSH 已有共享 workspace 概念） |
| 2.2.6 | `:21` **Leader 禁止承接和执行任务** | `index.ts:111` | ✅ 已覆盖 | — |
| 2.2.7 | `:22` **背景不清先建调研成员** | `index.ts:113`（条 3） | ✅ 已覆盖 | — |
| 2.2.8 | `:23` **成员共享理解时默认 fork 继承**（`checkpoint`+`fork_source`） | **缺失** | ❌ | **P2**，需改写——DSH fork 机制不同 |
| 2.2.9 | `:24` **没有合适的人就造一个**（`spawn_teammate`） | 部分（`index.ts:112` 间接） | ⚠️ | **P2**：补一句"缺能力就造人，不许自己上" |
| 2.2.10 | `:25` **复杂产物交独立汇总成员收口** | **缺失** | ❌ | **P1**：可移植（对"多成员产出整合"关键） |
| 2.2.11 | `:26` **Leader 禁止手工管理 worktree** | **缺失** | ❌ | **P2**：可移植（DSH 有 workspace_worktree 工具） |
| 2.2.12 | `:27` 谨慎用 worktree 隔离 | **缺失** | ❌ | **P2**：可移植 |
| 2.2.13 | `:32-36` **响应节奏**：事件驱动不轮询 / 成员 idle 正常 / 长停滞才介入 | 部分（`index.ts:114` 条 4 有"事件唤醒/不轮询"） | ⚠️ 部分 | **P1**：补"成员 idle 是正常态、别催" |

### 2.3 工作流程（`leader_workflow*.md`）

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.3.1 | `leader_workflow.md:4-9` 9 步：分析→建队→**先建人**→背景不清先调研→**建任务前先 view_task 查重**→创建 DAG→**创建后二次自检**→让成员开工→响应通知 | **缺失**（我方无逐步流程） | ❌ | **P1**：移植"建任务前查重 / 建后自检"两条纪律 |
| 2.3.2 | `leader_workflow.md:8` 末端"整合/总结/成稿"单独建末任务给独立汇总成员 | **缺失** | ❌ | **P1**（同 2.2.10） |
| 2.3.3 | `leader_workflow_predefined.md:3` 预定义团队**不能 spawn** | 缺失（DSH 无此模式） | ❌ | **不可迁移**（无预定义团队模式） |
| 2.3.4 | `leader_workflow_hybrid.md` 混合模式 | 缺失 | ❌ | **不可迁移** |

### 2.4 任务下发（`dispatch_*`）

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.4.1 | `dispatch_autonomous_leader.md:3-8` 自主认领：任务 pending 入池；**框架自动拉起成员**；human_agent 需显式指派 | `index.ts:158`(dispatch) 只讲轮次，**未讲认领/指派** | ⚠️ 部分 | **P1**：补自主/调度两模式的**派发纪律** |
| 2.4.2 | `dispatch_scheduled_leader.md:5` **create_task 必须指定 assignee** | **缺失** | ❌ | **P1**：可移植（我方已默认 scheduled，P19b） |
| 2.4.3 | `dispatch_scheduled_leader.md:6` **成员必须先于任务、且不能是 leader** | `index.ts:112`（"成员必须先于任务存在"） | ✅ 已覆盖 | 缺"不能是 leader"半句 |
| 2.4.4 | `dispatch_scheduled_leader.md:7` **调度框架代完成全部交接**（不要逐个通知开工） | **缺失** | ❌ | **P1**：可移植（防 leader 手工通知 = 刷屏） |
| 2.4.5 | `dispatch_scheduled_leader.md:8` **关键任务配 1~N reviewer，一票否决** | **缺失**（我方 team-review 机制存在但提示词未引导） | ❌ | **P1**：见 §2.6 |
| 2.4.6 | `dispatch_scheduled_leader.md:10,108-111` **升级处置**（验收轮数耗尽/停摆才介入） | **缺失** | ❌ | **P1**：可移植 |
| 2.4.7 | `dispatch_scheduled_teammate.md:5,8` 成员侧：调度框架通知开工、用 `member_complete_task` 完成 | 部分（`index.ts:92` role 段极简） | ❌ 弱 | **P2**：我方 teammate 段过于单薄 |

### 2.5 任务状态机（`task_state_*`）

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.5.1 | `task_state_scheduled.md:2-21` 完整状态 + 转换（含 `in_review` 验证闸、`planning` 计划闸、`blocked`、终态） | `index.ts:170`（一句话 pending→in_progress→completed） | ❌ **严重缺失** | **P1**：**移植整个转换清单** |
| 2.5.2 | `task_state_autonomous.md:6-17` 自主模式转换 | 同上 | ❌ | **P1**：按模式二选一 |
| 2.5.3 | `task_state_scheduled.md:21` **验证闸**（配 reviewer → 进 `in_review`，自动裁决，不手催） | 缺失 | ❌ | **P1** |

### 2.6 收口 · 验收 · 升级

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.6.1 | `leader_policy.md:10` 质量把关：审批计划、裁决冲突、验收成果 | 部分（P62 ⑥ 追问） | ⚠️ | **P1** |
| 2.6.2 | `dispatch_scheduled_leader.md:101-106` reviewer 不预 spawn、调度框架自动交接、**测试任务 bug 直发 leader** | **缺失** | ❌ | **P1** |
| 2.6.3 | `dispatch_scheduled_leader.md:113-126` **升级处置流程**（先等 inbox 总结→综合判断→retry vs replan） | **缺失** | ❌ | **P1** |
| 2.6.4 | `lifecycle_persistent.md:2-8` 长期团队：完成后**汇总+待命+广播总结、不关闭成员** | **缺失** | ❌ | **P1**：可移植（DSH 有持久团队） |
| 2.6.5 | `lifecycle_temporary.md:2-7` 临时团队：shutdown+clean_team 解散 | **缺失** | ❌ | **P2**：工具名需改写 |
| 2.6.6 | `teammate_policy.md:18` **汇报一次即结束，不回致谢** | 缺失 | ❌ | **P2**：可移植（防寒暄） |

### 2.7 执行模式（plan/build）

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.7.1 | 各 `*_policy`/`dispatch_*` 里 `plan_mode`（`approve_plan`）/`build_mode` | **缺失**（我方 `leaderWaitModel` 处理等待，但无 plan 闸） | ❌ | **P1/P2**：DSH 有 plan gate（P30 已实现），**提示词未引导** |
| 2.7.2 | `team_plan_mode.md:1-68` / `team_plan_agent.md:1-31` 团队 plan 模式 | 缺失 | ❌ | **P2**：DSH 无 team plan 模式 → **不可迁移**（或大幅改写） |

### 2.8 Teammate 政策（`teammate_policy.md:1-62`）

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.8.1 | `:38-40` **通信协议**：send_message 唯一通道；**严禁普通文本传递消息**；用户直接找你必须回 | 缺失（我方 `team:role` 仅一句） | ❌ | **P1**：**高价值可移植**（防"以为自己说了其实没说"） |
| 2.8.2 | `:44` **优先横向协调**（成员间直接联系，不走 leader 中转） | 缺失 | ❌ | **P2** |
| 2.8.3 | `:45-48` **通道由内容形态决定**（短内容直发/成型产物走文件） | 缺失 | ❌ | **P2**（同 2.2.5） |
| 2.8.4 | `:49-50` 方向性阻塞升级 leader | 缺失 | ❌ | **P2** |
| 2.8.5 | `:52-56` 代码/文件协作（worktree 边界、**共享文件写入先 lock**） | 缺失 | ❌ | **P2**：DSH 有 workspace_lock，**可移植** |
| 2.8.6 | `teammate_policy_external.md:47` 外部成员 workspace 措辞变体 | 缺失（我方无 external 变体） | ⚠️ | **P2**（我方 external_cli 由 profile 决定） |

### 2.9 HITT（人类成员）

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.9.1 | `hitt_leader.md:5-6` 禁止 plain text 对人类；**必须显式指派**（人类无 claim_task） | 缺失 | ❌ | **P1**：DSH team-human 已实现人类席位，**提示词未引导** |
| 2.9.2 | `hitt_leader.md:7` 人类持有任务时**不能取消/改派/改内容** | 缺失 | ❌ | **P2** |
| 2.9.3 | `hitt_leader.md:8` 人类可 shutdown；退出后锁解除 | 缺失 | ❌ | **P2** |
| 2.9.4 | `hitt_teammate.md:3` / `hitt_teammate_anonymous.md:3-6` 与人类协作（默认匿名） | 缺失 | ❌ | **P2** |
| 2.9.5 | `human_agent_policy.md:1-35` / `hitt_human_agent.md:1-18` avatar 自契约+静默约束 | 缺失 | ❌ | **P2**（DSH 人类席位语义不同） |
| 2.9.6 | `passive_task_assigned.md:1-11` 被动人类任务指派消息 | 缺失 | ❌ | **P2**（消息模板） |

### 2.10 入站标签 · 桥 · 验证者 · 调度器消息

| # | Jiuwen（行） | 我方对应 | 对齐 | 差异 |
|---|---|---|---|---|
| 2.10.1 | `inbound_tags.md`（`<team-inbound>`/`<team-note>`/`<team-event>`/`<team-context>`/`for="controller"`） | `index.ts:177`（团队段只一句"按来源区分"） | ⚠️ 极弱 | **P1**：DSH 侧实际也发 XML 标签（P60/P61 已证）→ **可移植说明文** |
| 2.10.2 | `bridge_agent.md:1-13` 桥接头像自契约 | 缺失 | ❌ | **不可迁移**（DSH 无 bridge 概念）/ 或 P2 |
| 2.10.3 | `reviewer_verifier.md:1-32`/`reviewer_inspector.md:1-40`/`reviewer_challenger.md:1-39` | 缺失（我方 team-review 有 pass/fail/score，提示词无角色契约） | ❌ | **P1**：**高价值可移植**（验证者角色契约） |
| 2.10.4 | `reviewer_dims_for_inspector.md`（默认打分维度） | 缺失 | ❌ | **P2** |
| 2.10.5 | `scheduler_task_start.md`/`scheduler_task_start_plan.md`/`scheduler_review_request.md`/`scheduler_review_renudge.md`/`scheduler_rework.md`/`scheduler_rework_summary.md`/`scheduler_verified_report.md` | 缺失（属**消息体**，非系统提示词） | n/a | **P2**：对应我方 team-scheduler 的消息模板，**不属 team-prompt** |
| 2.10.6 | `swarmflow_reviewer_*.md`（3 个） | 缺失 | n/a | **不可迁移**（DSH 无 swarmflow） |

---

## 3. 差距清单 + 可迁移 checklist

> 列：条目 | 状态 | 迁移方式 | 优先级 | **防什么行为偏差**

| ID | 条目（Jiuwen 出处） | 状态 | 迁移方式 | Pri | 防的偏差 |
|---|---|---|---|---|---|
| C1 | 任务状态机全量（`task_state_scheduled.md:2-21`） | 缺失 | **可直接移植**（去掉 Jiuwen 工具名，保留状态/转换/`in_review`） | **P0** | 防 leader 不知道 `in_review` 验证闸、误判"完成" |
| C2 | 验证闸 + reviewer 结构化（`dispatch_scheduled_leader.md:8,101-111`） | 缺失 | **需改写**（映射到我方 review_submit/review_vote） | **P0** | 防"关键任务无验证直接完成" |
| C3 | 升级处置流程（`dispatch_scheduled_leader.md:113-126`） | 缺失 | **需改写** | **P1** | 防"验收卡死无人处置" |
| C4 | Leader 起手 = 先建人再规划 + 建任务前查重/建后自检（`leader_workflow.md:6-9`） | 缺失 | **需改写**（`build_team`→`spawn_teammate`/`team_task_create`） | **P1** | 防"先建任务后建人 / 重复建任务" |
| C5 | 派发纪律：必须指定 assignee；调度框架代交接，别逐个通知（`dispatch_scheduled_leader.md:5,7`） | 缺失 | **可直接移植**（对 scheduled 模式） | **P1** | 防"手工逐个通知 = 刷屏" |
| C6 | 独立汇总成员收口（`leader_policy.md:25` + `leader_workflow.md:8`） | 缺失 | **可直接移植** | **P1** | 防"leader 自己整合产品"（与 P54 同向） |
| C7 | 生命周期收尾（`lifecycle_persistent.md:2-8`） | 缺失 | **可直接移植**（长期团队：汇总+待命+广播总结，不关闭成员） | **P1** | 防"完成后无收口 / 乱关成员" |
| C8 | 成员 idle 正常 + 长停滞才介入（`leader_policy.md:32-36`） | 部分 | **可直接移植** | **P1** | 防"催 idle 成员 / 频繁轮询" |
| C9 | 通信协议三件套（`teammate_policy.md:38-40`） | 缺失 | **可直接移植** | **P1** | 防"普通文本当已沟通 / 漏回 user" |
| C10 | 入站标签说明文（`inbound_tags.md`） | 极弱 | **需改写**（贴合我方实际标签集） | **P1** | 防"读不懂 `<team-event>` / 误把框架事件当指令" |
| C11 | 验证者角色契约（`reviewer_verifier/inspector/challenger.md`） | 缺失 | **需改写**（映射我方 verify_task 的 pass/fail/score） | **P1** | 防"验证者乱投 / 不按验收标准" |
| C12 | 核心理念"定做什么不定怎么做"（`leader_policy.md:4`） | 缺失 | 可直接移植 | **P2** | 防"微管理" |
| C13 | 成果交接：短内容直发/成型产物走文件（`:12-18`） | 缺失 | 可直接移植 | **P2** | 防"长正文塞消息 / 产物落私人目录" |
| C14 | 没人就造一个（`:24`） | 部分 | 可直接移植 | **P2** | 防"缺人导致任务停滞/leader 自己上" |
| C15 | worktree 纪律（`:26-27`） | 缺失 | **需改写**（映射 workspace_worktree） | **P2** | 防"手工 git worktree / 滥用隔离" |
| C16 | fork 继承（`:23`） | 缺失 | **需改写**（DSH fork 语义不同） | **P2** | 防"重复阅读同文件" |
| C17 | HITT 人类协作规则（`hitt_leader.md:5-8` 等） | 缺失 | **需改写**（映射我方 team-human） | **P2** | 防"对人类用 plain text / 任务不指派给人类" |
| C18 | teammate 横向协调/锁/升级（`teammate_policy.md:44-56`） | 缺失 | 可直接移植 | **P2** | 防"事事经 leader / 并发写冲突" |
| C19 | 汇报一次即结束（`teammate_policy.md:18`） | 缺失 | 可直接移植 | **P2** | 防"无意义寒暄来回" |
| C20 | plan 模式（`team_plan_mode.md`） | 缺失 | **不可迁移**（DSH 无 team plan 模式） | — | — |
| C21 | bridge / passive / swarmflow_reviewer / predefined/hybrid 工作流 | 缺失 | **不可迁移**（机制不存在） | — | — |

**checklist 统计**：可迁移 **19 条**（C1–C19）；另有 **2 条不可迁移**（C20 plan 模式、C21 bridge/passive/swarmflow/predefined/hybrid）。
- 按方式：**可直接移植 11**（C1,C5,C6,C7,C8,C9,C12,C13,C14,C18,C19）；**需改写 8**（C2,C3,C4,C10,C11,C15,C16,C17）。
- 按优先级：**P0×2**（C1,C2）；**P1×9**（C3,C4,C5,C6,C7,C8,C9,C10,C11）；**P2×8**（C12–C19）。

---

## 4. 放置位置建议（⚠️ 渐进披露陷阱）

**【事实】陷阱**：我方 `DEFERRED_BEFORE_TEAM = ['team:dispatch','team:task-state']`（`index.ts:79`）——团队未建（无 `team/member` 事件）时这两段**被过滤**。P57 已踩过：把等待约束放 `team:dispatch` 会在最需要的起手窗口恰好藏掉。

| 条目 | 建议落段 | 理由 |
|---|---|---|
| C4 起手纪律、C6 汇总成员、C8 响应节奏、C12 核心理念 | **`team:leader`**（常驻） | 起手窗口就要生效，**绝不能进 `team:dispatch`** |
| C1 状态机、C5 派发纪律、C7 生命周期、C3 升级处置 | `team:task-state` / `team:dispatch`（**被延迟**）| 这些是"团队已建成"后的协作约定；延迟是**合理**的（省单 agent 预算） |
| C9 通信协议、C18 横向协调、C19 汇报 | **`team:role`**（常驻，`:148`） | 对所有成员常态生效，且团队未建时也可能需要 |
| C10 入站标签、C11 验证者契约 | `team:inbound` / 新增 `team:reviewer` | 标签说明常驻；验证者契约可新段 |
| C17 HITT | 新增 `team:hitt`（gated by hitt 开关） | 与 Jiuwen 对齐（`hitt_enabled` 门控，`sections.py:583-625`） |

**【推断/建议】不要照搬 Jiuwen 的 "leader 只留 bootstrap+extra、其余延后到 build_team 结果"**（`team_policy_rail.py:385-435`）——DSH 的 leader 建队用 `spawn_teammate`，**没有一个天然的"一次性下发准则"的返回点**；我方保持**常驻前缀**更稳（P57 已验证常驻段是压住长轮询的关键）。

---

## 5. 预算与风险（与 P46/P54/P57/P62/P64 的冲突/叠加）

- **【事实】会叠加/冲突的现有引导**：
  - **P46/P57（等待模型）**：`index.ts:114`（条 4）与 `:158`(dispatch) 已讲"派发即结束轮次/默认禁止长阻塞"。**C5（调度框架代交接）与它同向**——不冲突；但**若把 C5 放进 `team:dispatch`，需与条 4 措辞去重**，避免同一段里两遍"别阻塞"。
  - **P54（不亲自执行）**：`index.ts:111`。C6（独立汇总成员）、C14（没人就造一个）**强化**它，不冲突。
  - **P62（通道判据）**：`index.ts:115`。C5/C9/C13 涉"通信/交接"——**必须与 ⑤ 的"少而重/三类通道"对齐口径**，否则出现两套通道说法。
  - **P64（显示名/@）**：`index.ts:117-118`。C5"调度框架代交接、别逐个通知"与 P64 的"@人可读"**不冲突**（一个讲机制投递、一个讲可读）。
- **【风险】提示词膨胀**：一次性移植 19 条会把常驻前缀显著拉长（Jiuwen 全文合计数千字）。**建议分批**：P0/P1 先落（约 9 条），P2 观察效果后再补；常驻段（`team:leader`/`team:role`）**尤其克制**——P57 证明它影响起手行为，但也**占用 KV 前缀预算**。
- **【风险】越权/机制不符**：C2/C5/C11/C15/C16/C17 涉及工具名映射（`create_task`→`team_task_create`、`verify_task`、`workspace_worktree`、fork 语义、人类指派）——**必须逐条对照我方真实工具契约**，否则提示词会指向不存在的工具（P49 类 bug 的提示词版）。
- **【事实】真实模型 0 token**：本任务纯读源码 + 写文档，**未跑任何模型**。迁移实现的验证需另立任务并**先报预算**。

---

## 6. 附：Jiuwen 40 模板清单与归类

> 【事实】`agent_teams/prompts/{cn,en}/` 共 40 个模板（cn/en 一一对应）。

| 类别 | 模板 | 归属（我方） |
|---|---|---|
| leader 身份/起手 | `leader_bootstrap` `leader_swarmflow` | `team:leader` |
| leader 政策 | `leader_policy` | `team:leader` + 待补 |
| leader 工作流 | `leader_workflow` `leader_workflow_predefined` `leader_workflow_hybrid` | `team:leader`（default）；predefined/hybrid 不可迁移 |
| 派发 | `dispatch_{autonomous,scheduled}_{leader,teammate}` | `team:dispatch` |
| 状态机 | `task_state_{autonomous,scheduled}` | `team:task-state` |
| 生命周期 | `lifecycle_{persistent,temporary}` | 待补（`team:dispatch` 或新段） |
| teammate 政策 | `teammate_policy` `teammate_policy_external` | `team:role` |
| HITT | `hitt_{leader,teammate,teammate_anonymous,human_agent}` `human_agent_policy` | 待补 `team:hitt` |
| 入站 | `inbound_tags` | `team:inbound` |
| bridge/passive | `bridge_agent` `passive_task_assigned` | 不可迁移 / 消息体 |
| 验证者契约 | `reviewer_{verifier,inspector,challenger,dims_for_inspector}` | 待补 `team:reviewer` |
| 调度器消息体 | `scheduler_{task_start,task_start_plan,review_request,review_renudge,rework,rework_summary,verified_report}` | 属 team-scheduler（非 team-prompt） |
| plan 模式 | `team_plan_mode` `team_plan_agent` | 不可迁移 |
| swarmflow 验证者 | `swarmflow_reviewer_{verifier,inspector,challenger}` | 不可迁移 |

---

## 7. 事实 / 推断 分离

**事实**：§1 段优先级与渐进披露（`sections.py:82-92`、`team_policy_rail.py:385-435`、`index.ts:79`）；§2 全部逐句对照（行号已核）；§5 现有引导位置（`index.ts:111/114/115/117-118/158`）；§6 模板清单（`ls`）。

**推断**：§0/§3 优先级排序（P0/P1/P2 为分析判断）；§4"不要照搬延后下发"为建议；§5 提示词膨胀的量级为估计。

---

*（本文件由 prompt-engineering-analyst 产出；Jiuwen 行号基于 openjiuwen 0.1.19 当前安装版，我方行号基于撰写时 main。）*
