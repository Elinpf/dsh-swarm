# JiuwenSwarm vs DSH/dsh-swarm「集群模式」默认提示词逐句比对

> 产出人：prompt-engineering-analyst ｜ 任务：P53-prompt-comparison ｜ 性质：**只读分析 + 新增一份文档，不改 `packages/*/src`**
> 触发：用户截图——demo 里用户说「收集一下最近最新的 AI 相关近况」→ **leader 自己去搜、没派成员**；追问后 leader 才补建看板/派成员。
> 约定：【事实】= 源码/文档可复核（附 文件:行）；【推断】= 基于命名/结构的推测，未端到端实测。
> 预算：本比对**真实模型 token = 0**（纯源码阅读）。未做实跑验证；若要实跑，另行报预算。

---

## 0. 结论速览（Top 3 关键差异）

1. **【事实】Jiuwen 有一句 DSH/dsh-swarm 完全没有的**「Leader 不执行任务」**负向强约束**，且出现在**进前缀的第一个段**里。
   - Jiuwen：`openjiuwen/agent_teams/prompts/cn/leader_bootstrap.md:1`「**你自己不执行任务**，只做规划、协调、裁决和向用户汇报。」+ `leader_policy.md:21`「**Leader 禁止承接和执行任务**……不要因为"顺手就做了"而亲自去查资料、读代码、写报告」。
   - DSH 原生 `tool-agent-team` 的团队政策（`team:policy`，`.runtime/deepseek-harness/packages/experimental/tool-agent-team/src/index.ts:34-42`）**通篇只讲机制**（target/任务流/wait 语义），**没有一句**「leader 不该自己做」。
   - dsh-swarm 自建 `team:role`（`packages/team-prompt/src/index.ts:82-83`）只有一句「你是团队的一员：与队友通过消息与共享任务看板协作」。**⇒ 缺失。**

2. **【事实】Jiuwen 有「先建成员 / 背景不清先调研（不要自己查）」的**前置动作指令**；DSH/dsh-swarm 两者皆缺。**
   - Jiuwen：`leader_workflow.md:6`「**先建成员，再规划任务**」、`:7`「**背景不清就先调研**……**不要自己去查**」、`leader_policy.md:22`「先创建一个专职调研成员」、`leader_policy.md:24`「没有合适的人就造一个……**不允许由你自己动手**」。
   - DSH/dsh-swarm：`spawn_teammate` 工具**存在**（原生 `tool-agent-team/src/index.ts:194`），但**没有任何提示句驱动 leader 主动建成员**（`team:policy`、`team:role`、`team:dispatch` 均无）。**⇒ 缺失。**

3. **【事实】两边的「起手动作」不同**：Jiuwen 强制 leader **第一步调 `build_team`**（`leader_bootstrap.md:4`），DSH 的团队能力是 **opt-in 且无 bootstrap 指令**——preset 里 leader 的 persona 还是**通用 coding agent**（`packages/bundle/presets/swarm.patch.yml:15`「You are a coding agent powered by the {{model}} model.」）。coding-agent persona 天然倾向「自己动手」。
   - **【推断】** 这三条叠加，是截图里「leader 自己去搜、不派成员」的提示词侧根因。

> 一句话：**Jiuwen 用「负向禁令 + 前置动作」把 leader 逼成"只调度不干活"；DSH/dsh-swarm 目前只给了"怎么协作"的机制手册，没给"必须协作、不许自己干"的行为约束。**

---

## 1. 取源与证据基线（文件:行）

### 1.1 JiuwenSwarm 侧（集群模式默认提示词）
| 资产 | 路径（权威源 `.../site-packages/openjiuwen/agent_teams/prompts/`） |
|---|---|
| LEADER 引导段 | `cn/leader_bootstrap.md`（8 行）/ `en/leader_bootstrap.md` |
| LEADER 角色政策 | `cn/leader_policy.md`（36 行）/ `en/leader_policy.md` |
| LEADER 工作流 | `cn/leader_workflow.md`（12 行） |
| 任务下发 | `cn/dispatch_autonomous_leader.md`（9 行） |
| 任务状态机 | `cn/task_state_autonomous.md`（18 行） |
| HITT 人类协作 | `cn/hitt_leader.md`（10 行） |
| 段优先级真源 | `prompts/sections.py:82-92`（`SECTION_PRIORITY`） |
| LEADER 只取两段 | `rails/team_policy_rail.py:385-435`（`_build_leader_sections`：bootstrap + extra） |
| 协作约定延后披露 | `prompts/sections.py:795-853`（`build_leader_policy_disclosure`） |

> 机制回顾（详见 T7 `prompt-engineering.md`）：Jiuwen 的 LEADER 系统提示词前缀**只放 `team_bootstrap`（priority 11）+ `team_extra`（17）**；`team_policy` 等协作约定**不在前缀**，而是随 `build_team` 工具结果一次性返回（progressive disclosure，F_76）。

### 1.2 DSH / dsh-swarm 侧
| 资产 | 路径（相对 `dsh-swarm/`） |
|---|---|
| 原生团队政策段 `team:policy`（order 600） | `.runtime/deepseek-harness/packages/experimental/tool-agent-team/src/index.ts:34-42`（`teamPolicy()`）、注册点 `:173-177` |
| 原生团队身份 context `team:identity`（order 125） | 同上 `:178-190` |
| 原生团队工具描述（spawn_teammate/send_message/list_agents/wait_agent/team_task_*） | 同上 `:192-400` |
| 原生 section 顺序表 | `.runtime/.../packages/core/system-prompt/src/index.ts:21-55`（`SECTION_ORDERS`，`TEAM_POLICY:600`）、`:60-69`（`CONTEXT_ORDERS`，`TEAM_IDENTITY:125`） |
| 我们自建稳定段 | `packages/team-prompt/src/index.ts:77-111`（`builtinSections`：`team:role`/`team:dispatch`/`team:task-state`/`team:inbound`），注册 `:129-140` |
| 渐进披露实现 | `packages/team-prompt/src/index.ts:150-155`（`teamBuilt` 前过滤掉 `['team:dispatch','team:task-state']`） |
| leader 等待模型 | `packages/team-prompt/src/index.ts:40-46`（`leaderWaitModel: 'event-wake'`） |
| swarm preset persona | `packages/bundle/presets/swarm.patch.yml:12-15`（`@deepseek-ai/dsh-persona`，prefix=「You are a coding agent…」） |
| swarm preset plan-mode 段 | `packages/bundle/presets/swarm.patch.yml:52-60`（inline `section:`） |
| dsh-swarm 组合层 | `packages/bundle/cordis.patch.yml`（团队域由 agent-team-profile 提供，本 bundle 不重复插入） |
| 原生团队 profile | `.runtime/.../packages/experimental/agent-team-profile/cordis.patch.yml:16-32` |

> 说明：**【事实】** dsh-swarm 的模型可见团队提示只有两处来源——原生 `tool-agent-team`（英文，机制手册）+ 自建 `team-prompt`（中英，4 稳定段 + 3 context）。团队工具（`tool-swarm` 的 broadcast/review/workspace_* 等，`packages/tool-swarm/src/index.ts`）只贡献**工具描述**，不贡献行为约束段。

---

## 2. 截图现象解释（提示词角度）

用户截图链条：**「收集最新 AI 近况」→ leader 自己 web_search → 被追问 → 才建看板/派成员**。

**【事实】从提示词看，DSH/dsh-swarm 侧存在三个"不阻止 leader 自己动手、也不驱动其先派活"的结构性缺口：**

1. **没有"leader 不许亲自执行"的负向约束**（第 0 节 §1）。DSH 的 `team:policy`（`tool-agent-team:37,39,41`）三句分别讲：共享文件系统与写作用域、read/edit/write 与 `FS_STALE_VERSION`、target/send_message/任务流/wait 语义——**全是"如何做"，没有"该不该自己做"**。
2. **persona 仍是通用编码代理**。swarm preset 的 persona prefix（`swarm.patch.yml:15`）是「You are a coding agent powered by the {{model}} model.」——一个"编码代理"的默认倾向就是**直接完成用户的请求**。Jiuwen 对应位置的 persona 是「你是 TeamLeader……**你自己不执行任务**」（`leader_bootstrap.md:1`）。
3. **缺"先建成员/先建任务"的起手指令**。dsh-swarm 的 `team:dispatch`（`team-prompt/src/index.ts:89-90`）说「**就绪任务**由调度器派发；你也可主动认领」——它**以"任务已存在"为前提**，但没有任何一句要求 leader 在动手前**先把任务建出来、把成员建出来**。Jiuwen 对应位置是 `leader_workflow.md:6-7`「先建成员，再规划任务」「背景不清就先调研……不要自己去查」。

**【推断】行为偏差的提示词归因**：在"没有负向禁令 + persona=编码代理 + 无起手动作"三者共同作用下，leader 面对一个**它自己有能力直接完成的请求**（web_search「AI 近况」）时，**最快路径 = 自己搜**；只有当用户把"你应该用成员"这条**外部约束**注入后，leader 才转向团队路径。这与 Jiuwen 形成对照——Jiuwen 把这条约束**内置进了 leader 的系统提示词前缀**。

> 对照补充：【事实】DSH 原生唯一接近"必须协作"的强制句是 `tool-agent-team:41` 末尾「**The Lead must wait for required teammates before giving the final answer.**」——但它**只在 teammate 已存在时**约束"收尾要等"，**不触发"去建 teammate / 去派活"**，因此无法阻止 leader 独自完成整件事。

---

## 3. 逐句比对表（核心交付）

> 列义：# ｜ JiuwenSwarm 原句（文件:行）｜ DSH/dsh-swarm 对应句（文件:行）或「缺失」｜ 语义对齐？｜ 差异/缺失要点 ｜ 建议（移植/改写 + 优先级）。
> Jiuwen 原句以 `cn` 为准（`en` 为镜像，必要处标注）；DSH 侧为英文原文。

### 3.1 LEADER 身份与"不执行任务"（★ 截图直接相关）

| # | JiuwenSwarm 原句（文件:行） | DSH/dsh-swarm 对应句（文件:行）或「缺失」 | 语义对齐？ | 差异/缺失要点 | 建议（移植/改写 + 优先级） |
|---|---|---|---|---|---|
| 1 | 「你是 TeamLeader，一个高水平的技术架构师和项目负责人。**你自己不执行任务**，只做规划、协调、裁决和向用户汇报。」 `cn/leader_bootstrap.md:1` | 原生 `team:identity`：「You are the Team Lead named \"lead\".」 `tool-agent-team/src/index.ts:184-186` | 否 | 只有身份标签，**无"不执行任务"约束**；persona 反而是「coding agent」(`swarm.patch.yml:15`) | **改写移植（高）**：在 `team:role` 增一句 leader 专属「你是团队 Lead：**不亲自执行任务**，只规划/协调/裁决/汇报」。防：leader 顺手自己搜/自己写 |
| 2 | 「**Leader 禁止承接和执行任务**：你只做规划、协调、裁决和向用户汇报结论。调研、执行、整合、总结、撰写产物一律交给成员……**也不要因为"顺手就做了"而亲自去查资料、读代码、写报告**」 `cn/leader_policy.md:21`（en 同义 `en/leader_policy.md:21`） | **缺失** | 否 | 这是全表**最关键的缺失**：Jiuwen 用"负面清单"点名了 leader 最容易犯的行为（查资料/读代码/写报告） | **改写移植（高）**：把三类行为（查资料 / 读代码 / 写报告）逐一点名禁止。防：截图原现象复发 |
| 3 | 「你的职责是**定义"做什么"和"为什么做"**，而非"怎么做"……微管理是对专家的侮辱。」 `cn/leader_policy.md:4` | **缺失**（原生 `team:policy` 无职责定位句） | 否 | 缺"职责边界"陈述 | 改写移植（中）：界定"定目标而非做细节"。防：leader 既当裁判又当运动员 |
| 4 | 原生 `team:identity`：「You are teammate …  To message your Team Lead, use send_message…」 `tool-agent-team/src/index.ts:186-188` | — | （仅 DSH 有） | DSH 有 teammate 侧身份，Jiuwen 侧对应 `team_identity`（本人身份块） | 无需移植（已在） |

### 3.2 起手动作 / 团队优先（★ 截图直接相关）

| # | JiuwenSwarm 原句（文件:行） | DSH/dsh-swarm 对应句（文件:行）或「缺失」 | 语义对齐？ | 差异/缺失要点 | 建议（移植/改写 + 优先级） |
|---|---|---|---|---|---|
| 5 | 「走 build_team 路径时，**第一步就调用 `build_team`，不要犹豫**；在此之前不要调用任何其他团队工具。」 `cn/leader_bootstrap.md:4` | **缺失**（DSH 无 `build_team`；团队是 opt-in，无 bootstrap 指令） | 否 | Jiuwen 强制"先建团队/接管团队"；DSH 让 leader 自行决定是否用团队 | **改写移植（高）**：DSH 无 build_team，改写为「收到需要多步/多领域的工作时，**先 `spawn_teammate` + `team_task_create` 起手**，再动手」。防：leader 跳过团队直接自己干 |
| 6 | 「**无论团队是否已经存在，都调这一次**……接管……不要重复创建已经在名册上的成员。」 `cn/leader_bootstrap.md:6` | **缺失** | 否 | 缺"接管已有团队"引导 | 改写移植（低）：DSH 用 `list_agents` 先看名册再决定 spawn。防：重复建成员 |
| 7 | 「**完整的协同准则会在 `build_team` 返回时给你**……在拿到它们之前，你唯一该做的就是这一步。」 `cn/leader_bootstrap.md:8` | **缺失**（原生 `team:policy` 是静态遂段，恒定在 system prompt，无"建队后才披露"） | 否 | Jiuwen 把协作准则做成**工具结果**（progressive disclosure）；DSH 是**静态段** | 不改（DSH 静态段等价可达；dsh-swarm 已有 `leaderProgressiveDisclosure` `team-prompt/src/index.ts:36-37,150-155`）。**但需注意**：DSH 的渐进披露只延后了 `team:dispatch`/`team:task-state`，**未延后/也从未提供"leader 不干活"这条** |

### 3.3 先建成员 / 背景调研（★ 截图直接相关）

| # | JiuwenSwarm 原句（文件:行） | DSH/dsh-swarm 对应句（文件:行）或「缺失」 | 语义对齐？ | 差异/缺失要点 | 建议（移植/改写 + 优先级） |
|---|---|---|---|---|---|
| 8 | 「**先建成员，再规划任务**：用 `spawn_teammate` 按领域创建专业成员……**成员必须先于任务存在**——任务要落到具体的人头上」 `cn/leader_workflow.md:6` | 原生 `spawn_teammate` 工具描述「Create one named, durable teammate. **Only the Team Lead may call this tool.**」 `tool-agent-team/src/index.ts:194` | 否 | 工具有、**但提示词不驱动其被主动调用** | **改写移植（高）**：加一句「成员必须先于任务存在」。防：leader 无成员可用时干脆自己做 |
| 9 | 「**背景不清就先调研**……此时只建一名专职调研成员……**不要自己去查**」 `cn/leader_workflow.md:7` | **缺失** | 否 | Jiuwen 明确"不熟就去建调研成员"；DSH 无对应 | **改写移植（高）**：把"自己查"改为"先建调研成员"。防：截图里"leader 自己去搜"的同类（自己读代码/自己搜） |
| 10 | 「**背景不清先建调研成员**……**不要自己去查**——先创建一个专职调研成员承担背景调研任务，让它把结论沉淀成文件」 `cn/leader_policy.md:22` | **缺失** | 否 | 同上，决策原则层复述 | 改写移植（高） |
| 11 | 「**没有合适的人就造一个**：任务找不到能力匹配的成员时，用 `spawn_teammate` 新建……任务不允许因为"没人适合"而停滞，**更不允许由你自己动手**」 `cn/leader_policy.md:24` | **缺失** | 否 | Jiuwen 堵死"没人就自己上"的退路；DSH 无此堵 | **改写移植（中）**：防"无人胜任 → leader 兜底自己做" |
| 12 | 「**复杂产物由独立汇总成员收口**：……单独创建一个汇总成员……**你只读结论并向用户汇报**」 `cn/leader_policy.md:25` | **缺失** | 否 | Jiuwen 要求整合也是成员活 | 改写移植（中）：防 leader 亲自写最终报告 |

### 3.4 任务创建 / 下发 / 状态流转

| # | JiuwenSwarm 原句（文件:行） | DSH/dsh-swarm 对应句（文件:行）或「缺失」 | 语义对齐？ | 差异/缺失要点 | 建议（移植/改写 + 优先级） |
|---|---|---|---|---|---|
| 13 | 「**目标拆解**：将目标分解为粗粒度的任务 DAG……用 `create_task` 创建任务并设置依赖」 `cn/leader_policy.md:7` | 原生 `team_task_create` 工具描述「Create one unowned pending task on the shared Team task board.」 `tool-agent-team/src/index.ts:300`；`team_task_update` 支持 `blocked_by` `:383` | 部分 | 工具对齐；**但无"先拆 DAG 再派"的提示驱动** | 改写移植（中）：加"拆 DAG 再动手"。防：leader 跳过拆解直接自做 |
| 14 | 「**创建任务前**先 `view_task` 看一遍当前看板……创建任务后再次 `view_task` 做任务自检」 `cn/leader_workflow.md:8-9` | 原生 `team_task_list` 工具描述 `tool-agent-team/src/index.ts:324` | 部分 | 工具有；无"自检"提示 | 改写移植（低） |
| 15 | 「`create_task` 创建任务时可以不指定 `assignee`……也可以指定已存在的**非 leader**成员作为 `assignee`，把任务直接预留给该成员」 `cn/dispatch_autonomous_leader.md:5` | 原生 `team_task_update(action='reassign'/'claim')` `tool-agent-team/src/index.ts:378-385` | 部分 | DSH 用 CAS+reassign 而非 create-time assignee | 不改（语义可达）；可在 `team:dispatch` 补一句"可创建时即认领/指派" |
| 16 | 「**成员由框架拉起，"启动"不需要你做任何事**：任务一落库，未启动的成员会被立即拉起」 `cn/dispatch_autonomous_leader.md:6` | 原生 `team:policy`「send_message … **starts or resumes an inactive target**」 `tool-agent-team/src/index.ts:41`；`team:dispatch`「成员的消息会唤醒你开新一轮」 `team-prompt/src/index.ts:90` | 部分 | 语义近似（消息唤醒）；但 Jiuwen 说"任务落库即拉起"，DSH 说"发消息才启动" | 【推断】可保留；差异属实现层，提示层可不强对齐 |
| 17 | 「状态: pending / blocked / planning / in_progress / completed / cancelled」+ 转换表 `cn/task_state_autonomous.md:2-17` | `team:task-state`：「关注任务状态流转（pending → in_progress → completed）。」 `team-prompt/src/index.ts:100`；原生 `TASK_VIEW_SCHEMA` enum `['pending','in_progress','completed','deleted']` `tool-agent-team/src/index.ts:82` | 部分 | Jiuwen 状态机更细（含 planning 计划闸 / blocked），DSH 无 planning/review 状态（原生） | 增强（中）：dsh-swarm 有 `team-review` 包（`cordis.patch.yml`），可把 review 闸写进 `team:task-state`。防：leader/成员误判状态 |
| 18 | 「质量把关靠两件事：任务 content 里写清验收标准，以及你在成员汇报成果时亲自审阅、必要时用 `send_message` 要求返工」 `cn/task_state_autonomous.md:18` | 原生「**The Lead must wait for required teammates before giving the final answer.**」 `tool-agent-team/src/index.ts:41` | 部分 | DSH 有"收尾要等"，**无"审阅/返工"** | 改写移植（中）：补"验收 + 返工"。防：leader 不验收直接转述 |

### 3.5 通信 / 广播 / 响应节奏

| # | JiuwenSwarm 原句（文件:行） | DSH/dsh-swarm 对应句（文件:行）或「缺失」 | 语义对齐？ | 差异/缺失要点 | 建议（移植/改写 + 优先级） |
|---|---|---|---|---|---|
| 19 | 「**信息枢纽**：通过 `send_message` 传递关键上下文和决策。……**优先单播定向沟通**；`to="*"` 广播会唤醒团队里每一个成员各跑一轮 LLM 交互，开销与团队规模成正比……务必慎用」 `cn/leader_policy.md:9` | 原生 `send_message` 工具描述 `tool-agent-team/src/index.ts:222-223`；dsh-swarm `broadcast`/`multicast` 工具 `packages/tool-swarm/src/index.ts:106-144`（`delivery: quiet|wakeup`） | 部分 | 工具有；**"广播慎用"的成本警示缺失** | 改写移植（低-中）：dsh-swarm 的 broadcast 有 `wakeup` 语义，建议补开销提示。防：无脑广播空转 |
| 20 | 「**事件驱动，不轮询**：新消息、任务状态变化……都会自动通知你——不要反复调用 `view_task`」 `cn/leader_policy.md:33` | `team:dispatch`（event-wake）：「**派发或发消息后请结束你的轮次**……**不要用 wait_agent 长阻塞等待**」 `team-prompt/src/index.ts:90` | ✅ 是 | **已对齐**（P45 成果，`leaderWaitModel: 'event-wake'`） | 不改（已覆盖） |
| 21 | 「**成员 idle 是正常状态**……idle ≠ 卡死，不要催促或重发启动消息」 `cn/leader_policy.md:34` | **缺失** | 否 | 无"idle 正常"提示 | 改写移植（低）：防 leader 催prompt/空转 |
| 22 | 「长时间停滞才介入：只有当成员明显长期无进展……必要时用 `shutdown_member(force=true)` 兜底」 `cn/leader_policy.md:35` | 原生 `interrupt_agent`（Lead only）`tool-agent-team/src/index.ts:287` | 部分 | 有 interrupt，无"何时介入"判据 | 改写移植（低） |

### 3.6 人类成员（HITT）

| # | JiuwenSwarm 原句（文件:行） | DSH/dsh-swarm 对应句（文件:行）或「缺失」 | 语义对齐？ | 差异/缺失要点 | 建议（移植/改写 + 优先级） |
|---|---|---|---|---|---|
| 23 | 「**禁止** 用 plain text 向任何人类成员发问……所有定向沟通必须调用 `send_message`」 `cn/hitt_leader.md:5` | dsh-swarm `team-human` 包存在（`cordis.patch.yml`）；**提示词段缺失**（team-prompt 未生成 human 段） | 否 | 有包、无提示 | 视 scope（低）：本项目未见 HITT 需求，暂不移植 |
| 24 | 「对每个需要特定人类成员完成的任务，你**必须**……`update_task(assignee=...)` 正式指派……人类成员不能自主认领」 `cn/hitt_leader.md:6` | **缺失** | 否 | 无 | 视 scope（低） |

### 3.7 工具/机制（机制层对照，供完整性）

| # | JiuwenSwarm 机制（文件:行） | DSH/dsh-swarm 对应（文件:行） | 语义对齐？ | 差异 | 建议 |
|---|---|---|---|---|---|
| 25 | LEADER 前缀只放 bootstrap+extra，policy 延后随 `build_team` 返回 `rails/team_policy_rail.py:385-435`、`prompts/sections.py:795-853` | 原生 `team:policy` 静态段 `tool-agent-team/src/index.ts:173-177`；dsh-swarm 渐进披露延后 `team:dispatch`/`team:task-state` `team-prompt/src/index.ts:150-155` | 部分 | 披露时机不同；**DSH 未把"leader 不干活"作为需披露的约定** | —— |
| 26 | 段优先级 `sections.py:82-92`（identity10/role11/hitt12/…/dispatch15/task-state16/extra17/inbound18） | 原生 `SECTION_ORDERS`：`DEPLOYMENT_PERSONA_PREFIX:0`→`PLAN_POLICY:500`→`TEAM_POLICY:600`→tools 1000+ `system-prompt/src/index.ts:21-55` | 部分 | 两套 order 刻度不同；DSH 的 `team:policy`(600) **在 persona(0) 之后** | —— |
| 27 | 工具 schema 走 API `tools`，提示词只放规则（见 T7） | 原生工具描述来自 `defineTool({description})`（如 `spawn_teammate` `tool-agent-team/src/index.ts:194`） | ✅ 是 | 同为"描述进工具、行为约束进 section" | —— |

---

## 4. 建议移植 / 改写清单（可执行，标优先级与"防什么行为偏差"）

> 边界：以下**仅建议**，**不改 `packages/*/src`**；经 team-leader 批准后另立实现任务。

| 优先级 | 建议（落到 dsh-swarm `team-prompt`，改写而非直译） | 目标段 | 防什么行为偏差 |
|---|---|---|---|
| **高** | 在 leader 专属段加入负向约束：「你是团队 Lead：**不亲自执行调研/执行/整合/撰写**；这些一律交给成员。**不要因为"顺手就做了"而自己搜资料、读代码、写报告。**」 | `team:role`（leader 变体，建议从 `builtinSections` 的 `team:role` 拆出 leader/teammate 两种文本；现为单文本 `team-prompt/src/index.ts:79-84`） | **截图原现象**：leader 自己 web_search |
| **高** | 增起手动作：「**先建成员、先建任务，再动手**：成员必须先于任务存在；需要多领域/多步工作时，先用 `spawn_teammate` + `team_task_create` 起手。」 | 新稳定段（建议 order 12，`team:role` 之后；仿 Jiuwen `team_bootstrap` priority 11） | leader 跳过团队直接自己干 |
| **高** | 增背景调研规则：「**背景不清先建专职调研成员，不要自己去查**；让它把结论沉淀成文件，你基于文件再规划。」 | 同上起手段内 | leader 自己读代码/搜资料 |
| **中** | 增兜底禁令：「**没有合适的人就造一个**——任务不允许因"没人适合"停滞，**更不允许由你自己动手**。」 | `team:role` | leader 无人可用时兜底自做 |
| **中** | 增汇总收口：「复杂产物由独立汇总成员整合成稿，**你只读结论并汇报**。」 | `team:role` | leader 亲自写最终报告 |
| **中** | 增强任务状态段：补 `planning`（计划闸）与 `review`（评审闸）语义，对齐 dsh-swarm 已有 `team-review` 包 | `team:task-state`（`team-prompt/src/index.ts:96-102`） | 成员/leader 误判状态、跳过评审 |
| **中** | 增验收规则：「成员汇报后**你亲自审阅**，必要时要求返工」（改写自 Jiuwen `task_state_autonomous.md:18` + 原生 "Lead must wait") | `team:task-state` / `team:dispatch` | leader 不验收直接转述 |
| **低-中** | 增广播成本警示：「优先单播定向；广播会唤醒全体成员各跑一轮，慎用」（对齐 dsh-swarm broadcast 的 `wakeup` 语义） | `team:dispatch` | 无脑广播空转 |
| **低** | 增响应节奏：「**成员 idle 是正常状态**，不要催促或重发启动消息；长期停滞才介入」 | `team:dispatch` | leader 催prompt/轮询 |
| **低** | 增"接管"引导：「先 `list_agents` 看名册，别重复建成员」 | 起手段内 | 重复 spawn |

**放置建议**：上述"高优先级"三条本质是 **leader 身份与行为边界**，建议集中成一个 **leader 专属段**（类似 Jiuwen 的 `team_bootstrap`，进前缀、order 靠前），而**不是**塞进 `team:dispatch`（后者当前会被 `leaderProgressiveDisclosure` 在"团队未建成前"过滤掉——`team-prompt/src/index.ts:69-70,150-155`，若把身份约束放那里，恰好在"还没建成员"时**不生效**，与目标相反）。

---

## 5. 【事实】/【推断】分离

**【事实】**
- F1 两侧提示词注入点与原文行号，均见 §1、§3（文件:行 已逐一给出）。
- F2 Jiuwen `leader_bootstrap.md:1` / `leader_policy.md:21,22,24` 明确"leader 不执行任务/不自己查/不许自己兜底"；DSH `team:policy`（`tool-agent-team/src/index.ts:34-42`）**无对应句**。
- F3 DSH 原生唯一强制"协作"的句子是 `:41` 末尾 "The Lead must wait for required teammates before giving the final answer."，且以 teammate 已存在为前提。
- F4 swarm preset 的 persona 是通用 coding agent（`swarm.patch.yml:15`）。
- F5 dsh-swarm `team-prompt` 稳定段 4 个（`team:role/dispatch/task-state/inbound`，`team-prompt/src/index.ts:60-65`），context 3 个（`team:identity/roster/info`，`:67`）；**无 leader 行为禁令段**。
- F6 dsh-swarm 已实现 `leaderWaitModel: event-wake`（`:40-46`）与渐进披露（`:150-155`）。

**【推断】**
- I1 截图"leader 自己搜"的**根因**是"无禁令 + persona=编码代理 + 无起手动作"三者叠加（未做 A/B 实跑，属提示词归因）。
- I2 `team:dispatch` 的渐进披露（团队建成前隐藏）会**连带隐藏**若放其中的"leader 行为约束"，因此建议单列 leader 专属段——属设计建议，未实测。
- I3 原生 `team:policy` 中"send_message starts/resumes inactive target"与 Jiuwen"任务落库即拉起"在**提示层**近似，实现层差异未追。

**【不得夸大】**：两侧**并非"几乎一样"**——机制类（工具、任务流、wait 语义、事件唤醒）**部分对齐**；但**行为约束类（leader 不干活 / 先建成员 / 背景调研 / 兜底禁令）DSH 侧基本全缺**，这是本次比对的核心结论。

---

## 6. 预算与复现

- **真实模型 token：0**（纯源码阅读 + 文档撰写）。
- 未做实跑验证。若需验证"移植后 leader 是否团队优先"，需真实 profile + 模型，**另行报预算**。
- 复现命令（只读）：
  ```console
  # Jiuwen 侧模板（带行号）
  cat -n /opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen/agent_teams/prompts/cn/leader_policy.md
  # DSH 原生团队政策
  sed -n '34,42p' .runtime/deepseek-harness/packages/experimental/tool-agent-team/src/index.ts
  # dsh-swarm 自建段
  sed -n '77,163p' packages/team-prompt/src/index.ts
  # swarm preset persona
  sed -n '12,15p' packages/bundle/presets/swarm.patch.yml
  ```

---

*（本文件由 prompt-engineering-analyst 产出，P53；所有行号对当前 checkout/安装版本实测。仅只读分析，未改任何 `packages/*/src`。）*
