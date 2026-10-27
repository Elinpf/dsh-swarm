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
