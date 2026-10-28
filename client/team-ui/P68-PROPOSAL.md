# P68 composer（输入框 + `@` 候选下拉）—— 方案（**先方案，未实现**）

> 产出人：dsh-target-analyst　时间：2026-10-28　任务：P68（依赖 P66/P67）
> 依据：`docs/jiuwen-chat-ui-spec.md` §输入框（`InputArea.tsx` 行号）；本机 DSH 0.2.1-rc.3 源码实测。
> ⚠️ 本功能让面板**从只读变可发送**，属**功能扩展**——**待 team-leader 批准后再实现**。

## 0. 结论先行（可达性是关键）

本插件是**纯客户端**插件（`dsh.client`），**不能直接调用**服务端能力 `team-core.send` / `team-bus` / `ctx.teamHumanBridge`（均服务端注册；**当前无客户端 remote**）。⇒ 面板要"能发送"，**只有两条路**：

- **A（本轮可落地、零后端改动）**：复用**会话提示通道** —— 客户端 `@deepseek-ai/dsh-api-session-controller/client` 的 prompt/seam（**主 composer 用的同一条**）→ 面板把输入作为**一条 user 消息注入 Lead 会话**。
- **B（全保真、需后端）**：**新增服务端 remote**（暴露 `team-core.send` / `team-bus` / `team-human` seat）→ 结构化 `range/targets`、以 **human seat / lead** 身份发。**超出「只改 `client/team-ui/`」边界 → 归属需 leader 定。**

## 1. 发送通道：可达性与限制

| 通道 | 可达性（客户端） | 能发什么 | 限制（**写清**） |
|---|---|---|---|
| **A 会话提示**（session-controller client seam） | ✅ 可达（主 composer 同源） | 一条 **user 消息进 Lead 会话**（可带 `@名字` 文本） | **不是**"人类→某成员直发"；**不经我们 `team-bus`/`team-core`**；**不覆盖**未读/兜底台账（**P51 边界：原生直发不经本栈**）；**会触发 Lead 一轮**（计费/轮次） |
| **B 新服务端 remote** | ⚠️ 需**新增**（服务端插件 + typert wire 代码生成） | 结构化 DM/多播/广播（`targets`）、以 human/lead 身份 | 需后端改动 + 归属裁决；落地较重 |
| 原生 `send_message`（模型工具） | ❌ 客户端**调不到**（那是模型工具，非 client API） | — | — |

> **实测**：`client-ui-agent-team`（0.2.1）**只用投影读**，**无 `remote.agentTeams`**；`@deepseek-ai/dsh-api-session-controller/client` 存在（prompt/session-control seam）；`team-human` 的 `ctx.teamHumanBridge.send(seatId, outbound)` 是**服务端推给前端**的桥（反方向），非客户端发送入口。

**推荐**：本轮先做 **A**（零后端、用户能"发"），把 **B 列为"全保真（需后端）"待批**。

## 2. 权限 / 身份（请裁决）

- 浏览器用户是**人类观察者**，**不是 Agent**；而 `team-core.send(caller: Agent, …)` **要求 exact live Agent**。
- ⇒ 若走 B 需二选一：**(b1) 人类席位**（`team-human` `addHumanMember`，caller=human seat；语义=人类作为 roster 成员）或 **(b2) send-as-lead**（以 lead 身份代发）。
- 走 A 时，身份=**用户消息**（无 Agent 概念），无此问题。
- **请拍板**：目标身份是 **人类座席** 还是 **leader 代发**？影响接口与可见范围。

## 3. `@` 语义

- 候选来源：成员名册（`agentTeam` 投影，排除 user）——`{name/显示名, id, 状态}`。
- 选中后：**插入 chip 文本** `@<name>`；**同时设置 `multicast targets`**（机制照 P62/P64 口径：leader 用 broadcast/multicast、`@` 落到 `targets`）。
  - **仅 B 能"结构化设置 targets"**；**A 只能落文本** `@<name>`，靠 leader 侧（P62/P64 提示词约定）解析路由。

## 4. UI（照 spec 数值；**纯 UI 可迁移**）

- **候选下拉** `chat-composer-suggestion`：`position:absolute; left:16px; bottom:calc(100%+8px)`；宽 `min(360px, 100%-32px)`；圆角 **14px**；`header` 高 **34px**/12px/650；`list` `max-height:266px`；`item` gap10/**高 44px**/圆角 9px/padding 0 10px/hover `rgba(37,99,235,.08)`；`avatar` **26×26**/圆角 9px/`#2563eb`；`label` 13px；`meta` 11px/`@member_id`。
- **inline chip** `chat-input-chip-inline--member`：高 **24px**/圆角 **6px**/`margin 0 2px`/`padding 0 8px 0 6px`/字号 12px；蓝渐变底 `rgba(37,99,235,.12)`/色 `#2563eb`；前缀 `@` **700**；`__label` `max-width:200px` ellipsis；`__remove` **14×14**。
- **触发**：光标前正则 `/([@$])([\p{L}\p{N}_\-\u4e00-\u9fa5]*)$/u`（`@`→成员、`$`→角色）；提交时 chip **展开为 `@<member_id>`**——但 **DSH id 是 UUID、不可读** ⇒ 需决定用 **name** 还是引入可读 handle（**需适配**）。

## 5. 风险

- **自激循环**：发送 → 触发 Lead 一轮 → 若 Lead/成员再自动发 → 可能成环。**缓解**：仅**用户显式提交**触发、**turn 进行中禁用发送**、去重/限速、**不自动发送**。
- **计费/轮次**：A 会消耗真实模型轮；面板发送需**显式用户动作**。
- **干扰 leader 编排**：人类消息进 Lead 会话可能改变其调度；建议**明确"人类插话"语义**并由提示词约定处理。

## 6. 工作量 / 预算估计

- **A（会话提示，零后端）**：**~40–70k token / ≤0.5 人日**（composer UI + 接 session-controller prompt seam + `@` 候选/chip + 单测 + 原型自证）。
- **B（新服务端 remote）**：**A 之上再 +服务端 remote（typert wire + 身份接入）**，属**后端改动**，需另立/归属。

## 7. 待你拍板

1. 走 **A（先落地）** 还是直接 **B（全保真需后端）**？
2. 身份：**人类座席** vs **leader 代发**？（B 必须；A 不涉及）
3. 是否接受 A 的语义限制：**非"直发某成员"、不覆盖未读/兜底（P51）、会触发 Lead 一轮**？
