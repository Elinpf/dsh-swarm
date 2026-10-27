# Leader 等待模型核实（P45）

> 产出人：dsh-plugin-dev-2 ｜ 任务：P45-leader-wait-model ｜ 性质：**只核实 + 方案，不改代码**
> 触发：演示实例实测到 leader **阻塞等待**：`等待子智能体 {"timeout_ms":300000}`。
> 约定：【事实】=可复核的源码/实测；【推断】=未端到端实测。

---

## 1. 事实层（带源码位置）

### 1.1 DSH 原生 `wait_agent`：**阻塞原语**（非轮询）

- **工具定义**：`.runtime/deepseek-harness/packages/experimental/tool-agent-team/src/index.ts:250`（`name: 'wait_agent'`），
  参数 `timeout_ms`（`:253`，默认 30000，合法区间 **10s–1h**，`:264`），主体调 `ctx.agentTeams.waitForChange(caller, timeoutMs, signal)`（`:265/:280`）。
- **实现**：`agent-team/src/index.ts:199 waitForChange` → `activity.ts:24 TeamActivity.wait(...)`：
  返回一个 **Promise，靠 timer（timeoutMs）或 `waiter.resolve()` 结束**；`timeoutMs` 校验 10000–3600000（`activity.ts:27`）。**是阻塞等待，不是轮询**。
- **谁会唤醒它**：`TeamActivity.notify(id)`（`activity.ts:60` 起）在以下点调用——
  - `agent-team/src/index.ts:89`：`TeamJournal` 有变更（team 域写）；
  - `:96`：`ctx.on('agent/status')` 成员**状态变更**；
  - `:246`：**`sendMessage` 之后**（见 1.2）。
- **工具自带的语义约束**（原文，`tool-agent-team/src/index.ts:41`）：
  > "wait_agent observes only changes after that call starts, **never wakes a member**, and returns **noProgress immediately when no other member can produce a change**. ... **The Lead must wait for required teammates before giving the final answer.**"

  ⇒ 即：`wait_agent` **只观察、不唤醒别人**；没有其它成员在跑时**立即返回 noProgress**；且系统提示明确要求「**Lead 给最终答案前必须等**」——这正是演示里 leader 阻塞等的直接来源。

### 1.2 入站消息：**既唤醒阻塞 waits、也能启动/恢复 inactive 目标**

- `sendMessage`（`agent-team/src/index.ts:230-246`）：对 **lead** 用 `root.steer(userMessage)` 注入（`:241`）；对子成员 `steerHostSubagentPrompt(...)`（`:243`）；**随后 `this.activity.notify(membership.id)`（`:246`）**。
  ⇒ **同一条成员消息既会 `notify`（唤醒正在 `wait_agent` 的接收者），也会 steer/启动接收者的轮次**。
- 工具文档（`:41`）："`send_message` steers a running target at its nearest step boundary and **starts or resumes an inactive target**"。
- **我们侧实测（profile-e2e.md）**：`followup_task` 在 0.2.1-rc.3 **不存在**；等价能力是 `send_message`——"**an inactive target starts or resumes a turn**"（`docs/profile-e2e.md:23,244`）。**已验**。

### 1.3 我们 dsh-swarm 侧

- `team-core.waitForChange` **只委派原生 seam**（`packages/team-core/src/index.ts:525-530`）→ 与原生 `wait_agent` **同语义（阻塞）**。
- `team-bus` 的 `delivery:'wakeup'`：广播/多播/定向以 **DM 扇出**（`packages/team-bus/src/index.ts:41,48,202,240`），最终落 `ctx.teamCore.send` → 原生 `sendMessage`（1.2：steer + notify）。
- **已验 / 未验**：
  - **已验**：`send_message` 唤醒 **inactive 成员**并跑一轮（profile-e2e §6.1）。
  - **未验（【推断】）**：① **空闲 leader** 收到入站消息会**开新一轮**（由 `root.steer` 保证，但未在真实 profile 端到端测 leader 这一侧）；② **阻塞中的 `wait_agent` 收到入站消息会即时返回**（由 `:246 notify` 保证，未端到端测）。

### 1.4 JiuwenSwarm 的 leader 模型（历史调研）

`team-workspace/interaction-mechanisms.md §3.3`（【事实】）：
> **总线事件本身不唤醒任何 LLM；真正唤醒发生在 `_process_unread_messages` 把消息 `deliver_input` 进 harness 的那一刻**；用「DB 里是否有发给它的未读行」做收件人过滤。
> leader 在 `on_message_or_broadcast` 里观察团队流量（`event_listeners`），被**发给它的未读消息**喂 harness → 新一轮。

⇒ JiuwenSwarm 是**纯事件唤醒**：leader **派发后 turn 结束**，由**入站消息触发新一轮**；**没有**「阻塞等待」原语。

---

## 2. 判定：【不一致（表现层）】——能力不缺，缺的是「默认行为 / 提示」

| 维度 | DSH 原生（我们沿用） | JiuwenSwarm | 一致性 |
|---|---|---|---|
| 「空闲 + 入站消息唤醒新一轮」 | **具备**（steer 启动/恢复 inactive；`send_message` 已实测唤醒成员） | 具备（mailbox→harness） | ✅ 一致 |
| leader 默认行为 | **常阻塞** `wait_agent` 等（系统提示要求「final answer 前必须等」） | **不阻塞**，派发即结束轮次 | ❌ **不一致** |
| 阻塞原语 | 有 `wait_agent`（10s–1h，观察式） | 无 | 差异（原语存在性） |

- **差距定位**：不是能力缺失——**DSH 同样支持「派发后空闲 + 事件唤醒」**；演示里的阻塞是 leader 在**提示引导下主动选择** `wait_agent`。
  根因：① 原生系统提示 `tool-agent-team:41`「Lead must wait … before final answer」；② leader 倾向「同轮等待」而非「结束轮次等事件」。
- 关键细节：`wait_agent` **不唤醒成员**、且**无其它成员在跑时立即 noProgress** ⇒ 阻塞等**依赖有成员在跑**，成员都 inactive 时它并不能省事。

---

## 3. 对齐方案（**先报，未改码**）

- **A. 保留 `wait_agent`/`waitForChange` 为「可选」原语**（用于确实要「同轮聚合多个成员结果」的短场景），**不设为 leader 默认路径**。
- **B. leader 提示改为「事件唤醒优先」**：派发后**结束轮次**；由成员 **入站消息**触发新一轮（对齐 JiuwenSwarm）。仅在需要同轮聚合时才 wait。
- **C. 保证「入站消息定向唤醒 leader」**：DM/`@all`/`send` 到 leader 均走原生 `sendMessage`→`root.steer + notify`（**已具备**）；沿用源系统「DB 行过滤收件人 + 事件唤醒」思路，**避免 leader 被无关广播空转**。
- **D.（可选增强）** `wait_agent` 被**消息**唤醒时**返回并携带该消息**（当前仅返回 `boolean`，不区分「消息边沿 / 状态边沿」），减少 timeout 空转。
- **E. 未验项解锁条件**：需**真实 profile + 模型**（先报预算）验证：(1) **空闲 leader** 收到入站消息是否开新轮；(2) **阻塞中的 `wait_agent`** 被消息唤醒是否即时返回。

## 4. 预算

- 本核实：**真实模型 token = 0**（纯源码阅读 + 已有实测文档）。
- 方案 E 的真实 profile 验证需模型调用，另行报预算（≤0.5M 内）。

## 5. 附：可复现命令

```console
# 原生 wait_agent 定义与语义
sed -n '250,282p' .runtime/deepseek-harness/packages/experimental/tool-agent-team/src/index.ts
sed -n '24,75p'  .runtime/deepseek-harness/packages/experimental/agent-team/src/activity.ts
sed -n '85,100p;230,248p' .runtime/deepseek-harness/packages/experimental/agent-team/src/index.ts
# 我们侧委派
sed -n '525,531p' packages/team-core/src/index.ts
# JiuwenSwarm 唤醒语义
grep -n '唤醒' /root/.jiuwenswarm/.agent_teams/jiuwen_team_web_1a1765709a5_5ff0b15f4726/team-workspace/interaction-mechanisms.md
```


---

## 6. 阶段 1 实测（P46，真实 profile + 模型；先红后绿）

探针：`scripts/verify-leader-wake.mjs`（真实 `llm-pi-ai` overlay / DeepSeek-Flash；原始输出入 `.runtime/probe/p46-*.json`）。
判定只看**实际 `tool_call` / `turn` 事件**，不看文本措辞。

| 场景 | 时序 | turns | tool_calls | tokens | 结论 |
|---|---|---|---|---|---|
| R `nativeWait`（**红态**，不禁止等待） | 改前 | 1 | spawn_teammate,**wait_agent**,list_agents | 28188 | **【成立】** 原生默认下 leader **确实调用 `wait_agent` 挂等** |
| G1 `noWait`（显式要求派发后结束轮次） | — | 1 | spawn_teammate,send_message | 28696 | **【成立】** 不调 `wait_agent`、turn 1 结束 |
| W `wakeOnMember`（成员 @all，含 leader） | 改前 | **1,2** | spawn_teammate | 20900 | **【成立】** ②空闲 leader **被成员消息唤醒开 turn 2** |
| I `peerOnly`（成员 DM 另一成员，不含 leader） | 改前 | 1,2 | spawn_teammate,list_agents,send_message | 45207 | **【仍不可判定】** 见下「混淆项」 |
| G4 `regression`（spawn+DM+task 看板） | — | 1 | spawn/send/task_create/task_list/team_summary/list_agents | 52909 | **【成立】** ④主体行为不变（团队工具调用 6≥4） |

**总 token ≈ 175,900（0.176M）**，在批准预算（目标 ≤0.5M / 硬上限 1.0M）内。

### 6.1 判定汇总（阶段 1）
- **① 【成立】**（红态已复现）：原生默认下 leader 调 `wait_agent` 挂等；显式「派发后结束轮次」则不挂等。
- **② 【成立】**：空闲 leader 被成员消息（@all）**唤醒开新轮**（`turns=1,2`）——**能力确实具备**（印证 P45 §2）。
- **③ 【仍不可判定】**：本 setup 有**混淆项**——leader spawn 的子成员**完成结果必然回报 spawner(leader)**，因此无论消息是否「无关」，leader 都会开 turn 2。
  **解锁条件**：用**非 leader 派生**的既有成员，向**不含 leader** 的目标投递（需多成员/多轮驱动，或阶段 2 的「定向唤醒」实现后断言）。
- **④ 【成立】**：回归通过。

### 6.2 对阶段 2 的含义
- ②已证能力具备 ⇒ 阶段 2 只需改「**默认行为/提示**」（A/B），无需新增传输能力。
- ③需阶段 2 落地「定向唤醒」后再做**干净**断言；本脚本已把 ③ 标为 **INFO（不误判 FAIL）**。


---

## 7. 阶段 2 实现（P46，落点 `team-prompt` / `team-core`）

> 地盘：**只改 `team-prompt` 与 `team-core`**；不动 `tool-swarm`（P49/dev-1）、`packages/bundle/*`（P44/dev-1）。`wait_agent` 是上游 experimental 工具，**不**在 `tool-swarm` 内。

### 7.1 B（leader 提示：事件唤醒优先）— `team-prompt`
- 新增配置 **`leaderWaitModel: 'event-wake' | 'blocking-allowed'`（默认 `event-wake`）**。
- `team:dispatch` 段文本随该配置切换：
  - `event-wake`：**「派发或发消息后请结束你的轮次」**；成员消息唤醒新一轮；**不要用 `wait_agent` 长阻塞**（仅同轮必须聚合才用）；**只处理发给你的消息/含你的广播**。
  - `blocking-allowed`：保留旧口径（`wait_agent` 可选）。
- **防什么行为偏差**：防「leader 因原生提示默认挂 `wait_agent` 长阻塞」（P46 阶段 1 红态 R/`nativeWait` 已复现：tool_calls 含 `wait_agent`）。段数不变（仍 4 段），不增提示预算。
- 测试（`team-prompt` 现 7 条）：`event-wake` 文本含「结束你的轮次」；`blocking-allowed` 含「可选」且不含前者。

### 7.2 A（`wait_agent` 保留为可选、非默认）— 由 B 覆盖
- **不改工具层**：`wait_agent`（上游 experimental）**保留、随时可用**，只是**不再被引导为默认动作**（B 已达成）。
- **防什么行为偏差**：防「把『不阻塞』实现成禁用等待」而破坏「同轮聚合」合法用法。

### 7.3 C（定向唤醒 leader；无关广播不空转）
- **`team-core.send` 本就是「定向 DM」**：`req.range.kind !== 'dm'` 直接拒绝（`packages/team-core/src/index.ts` send 首行），**逐条只发一个 target**——已被既有测试覆盖（`team-core.spec:86-108`：`sendCalls[0].target==='w'`，broadcast 抛 `TEAMCORE_RANGE_UNSUPPORTED`）。
- 唤醒链路：`send` → 原生 `sendMessage` → **`root.steer`（启动/恢复轮次）+ `activity.notify`（唤醒 wait）**（P45 §1.2）⇒ **发给 leader 的 DM/@all 会唤醒 leader**。
- **无关广播不空转**属 **`team-bus` 扇出**语义（dev-1 地盘，P49 在改 multicast）——**本任务不动**，登记为跨任务项；提示侧已加「只处理发给你的消息/含你的广播」。
- **防什么行为偏差**：防「非定向消息把 leader 从静态唤醒」的放大；核心层已用「DM-only」收口。

### 7.4 D（可选）未做
- `wait` 被消息唤醒时「返回并携带该消息」需改**上游** `TeamActivity.wait` 返回形状（`boolean`→带负载）——**非我们包**，登记为可选上游项，未做。

### 7.5 E（回归）待跑
- 阶段 2 改后需**真实 profile 端到端**回归（预算先报 Leader）。确定性回归：`build`/`test`/`verify`/`verify:e2e`（无模型）。
