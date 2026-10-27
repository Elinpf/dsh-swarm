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


---

## 8. 阶段 2 实测：前后对比（P46，真实 profile + 模型）

同一 `nativeWait` 提示（含「use wait_agent as needed」），**改前 vs 改后**：

| 时序 | 场景 | tool_calls | wait_agent | 结论 |
|---|---|---|---|---|
| **改前**（阶段1，§6） | `nativeWait` | spawn,**wait_agent**,list | **调用了** | 红态：默认挂等 |
| **改后**（阶段2） | `nativeWait` | spawn,list | **未调用** | 绿态：我们提示已覆盖「鼓励等待」 |
| 改后 | `neutralDispatch`（中立，无等/别等指示） | spawn,list | **未调用** | 绿态主证据 |
| 改后 | `wakeOnMember`（@all 含 leader） | spawn | — | ②**成立**：开 turn 2（turns=1,2） |
| 改后 | `noWait` | spawn,send_message | 未调用 | G1 成立 |
| 改后 | `regression` | 6 类团队工具 | — | ④**成立** |

**总 token ≈ 173,980（0.174M）**（阶段2）。两阶段合计 ≈ **0.35M**，在批准上限 0.5M 内。

### 8.1 判定

> ⚠️ **【P57 更正 — 以下 P46 阶段2 结论已推翻，保留原文仅作历史痕迹】**
> §9.6/§9.7（P56 复核）证明：承载 P46 提示的 `team:dispatch` **因渐进披露判定 bug 被永久过滤、从未进入 prompt**；
> 且同提示同代码多轮采样 `wait_agent` 时有时无 ⇒ 下方「改后不再调 `wait_agent`」= **运行间方差（假绿）**，
> **不能**作为「已把默认改成不等待」的证据。**待 P57 修复 + 多轮重验后**再给结论。
- **B【已验证】**：`team-prompt` 默认 `event-wake` 后，leader 在「鼓励等待」与「中立派发」两类提示下**均不调用 `wait_agent`**、正常结束轮次。
- **A【成立】**：工具未禁用；等待仅在需要时由模型自行使用（本组未触发）。
- **②【成立】**：成员消息唤醒空闲 leader 开新轮。
- **③【仍不可判定】**：混淆项（spawned 成员完成回报 spawner）未变；解锁条件同 §6.1。
- **④【成立】**：回归通过。

### 8.2 原始输出
- 改前：`.runtime/probe/p46-nativeWait.json`（阶段1 版本，含 `wait_agent`）
- 改后：`.runtime/probe/p46-neutralDispatch.json`、`.runtime/probe/p46-nativeWait.json`（阶段2 版本，无 `wait_agent`）


### 8.3 断言变更留痕（诚实说明）

- 探针 `scripts/verify-leader-wake.mjs` 的 **R 断言由「期望调用 `wait_agent`」改为「期望不调用 `wait_agent`」**，
  原因=**默认行为已变更**（P46-B 落地 `event-wake`）。**这是事后改断言**，特此留痕，避免被误读为「先绿后绿」。
- **改前红态原始输出保留**：`.runtime/probe/p46-nativeWait.json`（阶段1 版本，含 `wait_agent`）。
- **时序**：红 = **改前**（阶段1，§6：tool_calls 含 `wait_agent`）；绿 = **改后**（阶段2，§8：同提示 tool_calls 不含）。
- 三条独立信号：①改前红态原始输出；②改后**同一提示**不调；③改后**中立提示**也不调。


---

## 9. P56 复查：P54 探针里的高频 `wait_agent` —— 是否回归/是否覆盖不到（事实/推断分离）

**结论：判定为 (b) —— 带着 P46 的新提示仍高频 `wait_agent`**（非「headless 未装配提示」）。原因=**P46 提示在真实聚合场景下强度不足 + 渐进披露使起手窗口无此指引**；**不是** P46 代码回归。

### 9.1 事实层（静态取证 + P54 tool_call 证据）

- **headless 确实装配了我们的 bundle 与 team-prompt**：`$DSH_HOME/profiles/headless/package.json` 含 `@elinpf/dsh-swarm-bundle`（link 到 `packages/bundle`）；team-prompt 构建产物含 P46 文本「结束你的轮次」。
- **P46 文本仍在**：`packages/team-prompt/src/index.ts:131-140` 的 `team:dispatch` 在 `leaderWaitModel='event-wake'`（bundle 未传 → 默认）下明写「**派发或发消息后请结束你的轮次**……**不要用 wait_agent 长阻塞**（仅当同一轮必须聚合多个成员结果时才用）」。
- **P54 真实会话证据**（`.runtime/probe/p54-behavior-headless.json`，profile=headless，真实模型）：tool_call 序列 `spawn_teammate` 首现 idx3 → … → **`wait_agent` 首现 idx17**，随后 wait/task_list/list_agents **轮询到 idx44**，之后才是成员执行的 web_fetch。⇒ **派发后仍长时间 `wait_agent` 轮询**。

### 9.2 关键结构性事实（为何「新提示仍没压住」）

- **【事实】`team:dispatch` 被渐进披露延迟**：`DEFERRED_BEFORE_TEAM=['team:dispatch','team:task-state']`（`src/index.ts:80`）——**在「团队未建」前会从 prompt 摘掉**（`:198`）。⇒ **leader 起手阶段（尚未 spawn 成员时）看不到「事件唤醒/别长阻塞」**；而**起手恰是最容易自己动手或起手等待的窗口**。
- **【事实】P46 的 wait 口径只挂在 `team:dispatch`**：新增的 `team:leader`（P54，order 10）**不含**任何等待/轮次措辞（grep 未见 wait/等待/聚合）。⇒ 承载「不默认等待」的只有**被延迟**的那一段。
- **【事实】上游强句仍在**：`tool-agent-team/src/index.ts:41` 末尾「**The Lead must wait for required teammates before giving the final answer.**」——与「别长阻塞」**方向相反**，且**不在我们的可延迟段内**（原生段常驻）。
- **【推断】提示留了「合法口子」被当作许可**：`team:dispatch` 写「**仅当同一轮必须同步聚合多个成员结果时才用 wait_agent**」；真实任务（出简报）本就需聚合结果 → 模型判为「必须聚合」而 wait，并表现为**长时间轮询**（远超「一次短 wait」）。⇒ **提示是「有例外的软约束」，非「默认禁止」**。
- **【事实】P54 headless 未加载 persona**（`preset-swarm` pending `agentPresets`；见 `verification.md §E`），故本次**无**「You are a coding agent…」persona 参与；但 web 集群 preset **会**加载它。

### 9.3 判定与差异定位

- **不是回归**：P46 代码/文本在；P46 阶段2 的「不再调 `wait_agent`」结论**只覆盖 trivial 场景**（spawn+报告），**未覆盖「真实聚合」场景**。
- **是覆盖/强度不足**：(i) 承载指引的段被渐进披露延迟；(ii) 上游常驻「必须 wait」句与之冲突；(iii) 指引以「有例外」表述，真实任务自然踩进例外并长轮询。
- **未实测点（诚实登记）**：P54 产物只存 tool_call/status，**未存 system prompt 文本**，故「idx17 那一刻 `team:dispatch` 是否已在 prompt」属**推断**（按 `teamBuilt` 于 idx3 起为真，推断「在」）。**免模型复核法**：下次探针落盘时把 `system-prompt` 文本一并存下即可判定。

### 9.4 persona 是否应改（建议，未自行改；属 bundle → 先报 Leader）

- **建议改**：web 集群 preset 的 persona（`packages/bundle/presets/swarm.patch.yml:15`「You are a coding agent powered by the {{model}} model.」）与「leader 不亲自执行 + 不默认等待」**均冲突**（编码代理默认倾向「直接做完」）。
- 对照 Jiuwen：其 leader persona 明写「你是 TeamLeader……**你自己不执行任务**」。
- **建议**：把集群 preset 的 persona prefix 改为 leader 语义（或按角色分流），**但属 `bundle`，改前先报 Leader**（本次不动）。

### 9.5 修复方向（建议，未改码）

1. **把「不默认等待/事件唤醒」从被延迟的 `team:dispatch` 提升到常驻的 `team:leader`**（起手即见）——最小、最直接。
2. 措辞由「有例外的软约束」改「**默认禁止长阻塞；聚合也用『短 wait_agent（单次、有上限）』，绝不轮询**」，压低被当许可的空间。
3. 与上游 `tool-agent-team:41`「Lead must wait…」**做显式调和**（我们的段里点明：wait 只用于短暂聚合，收尾靠事件唤醒）。
4. persona 同步（§9.4）。


### 9.6 【更正 §9 判定】实为 (a)——`team:dispatch` **从未进入 prompt**（P46 未覆盖该环境）

**§9 的 (b) 判定被本节的直接证据推翻。** 用「prompt 落盘探针」（`scripts/xproc/prompt-dump-plugin.mjs` + `run-headless.sh --patch <overlay> --json …`，**免模型额外开销由现探针承担**）在**真实会话**里落盘每次 `system-prompt/assemble` 的**段落名与文本**：

**事实**（一次 `spawn_teammate zed + send_message` 的真实会话，6 次装配全量）：
```
sectionNames = [harness:identity, deployment:persona-prefix, team:leader, team:role, team:inbound,
                plan:policy, team:policy, tool:*…, deployment:persona-suffix]
hasDispatch = false ×6   ；team:dispatch 出现次数 = 0   ；hasEventWake = 0
```
⇒ **`team:dispatch` / `team:task-state` 在整个会话都未进入 leader 的 prompt**（含 spawn 之后）——**P46 的「事件唤醒/别长阻塞」指引从未生效**。

**根因（事实+推断）**：
- **【事实】渐进披露判定字段错配**：`team-prompt` 以 `ctx.on('session/event')` 观察 `team/member`，判 `e.data?.role === 'teammate'` 才置 `teamBuilt=true`（`packages/team-prompt/src/index.ts:190-193`）。
  但原生 `team/member` 事件 data 形状是 `{ version, teamId, member: TeamMemberSnapshot }`，**`member` 里只有 `phase`（`provisioning`/`active`…），没有 `role`**（`agent-team/src/projection.ts:100-105` + `types.ts` `TeamMemberSnapshot`）。
  ⇒ **`e.data.role` 恒为 undefined，`teamBuilt` 永不置真** ⇒ `DEFERRED_BEFORE_TEAM=['team:dispatch','team:task-state']` **永久被过滤**。
- **【推断】** 这正是 P54 高频 `wait_agent` 的**直接根因**：leader 全程**看不到**我们的「事件唤醒优先/不默认等待」指引；它只看到常驻的 `team:leader`（P54 段，无等待措辞）与上游 `team:policy`（含「Lead must wait…」）。
- P54 的 `verification §D` 只验证了「**建团队前** dispatch 被摘（过滤在工作）」，**未验证「建团队后是否释放」**——本缺陷正落在未覆盖的那半。

**判定更正**：**是 (a)：P46 未覆盖该环境/会话**（提示从未呈现），**非 (b) 提示强度不足**。§9 的 §9.2 三条「强度」分析仍可作为**修好披露后的次级风险**保留，但**首要修复 = 修正 `teamBuilt` 判定**。

**修复建议（未改码；属 `team-prompt`，先报 Leader）**：
- 把 `teamBuilt` 判定从 `e.data?.role==='teammate'` 改为**按真实事件形状**：`e.type==='team/member' && e.data?.member`（可用 `member.phase !== 'provisioning'` 更严），或干脆**对 leader 不延迟** `team:dispatch`（leader 起手即需此指引）。
- 加**单测**：模拟 `team/member` 事件（真实形状）→ 断言 `team:dispatch` 被释放；并模拟未建→被摘。
- 复核探针：用本 `prompt-dump` 能力在真实会话断言 **spawn 后某次装配 `hasDispatch=true`**。

**附：prompt 落盘探针**（已入库）：`scripts/xproc/prompt-dump-plugin.mjs`；用法
`P56_PROMPT_DUMP=<file> bash scripts/run-headless.sh --patch <overlay·insert 该插件> --json "<prompt>"`（`--patch` 须在 `--json` **之前**）。


### 9.7 澄清：P46 阶段2 的「不再调 `wait_agent`」结论**不成立**（方差假绿）

**问题**：P46 阶段2 断言「改后 leader 不再调 `wait_agent`」，但 §9.6 已证 **`team:dispatch`（P46 唯一受 `leaderWaitModel` 影响的段）从未进入 prompt**。⇒ 该「绿」不可能来自 P46 改动，必须定位真因。

**可复用 prompt 落盘能力的直接实验**（同一 `nativeWait` 提示、同一代码，各跑 2 次；免额外模型预算，2 次共 ≈44k token）：
```
run1: wait_agent 调用=1  ; hasDispatch=true 次数=0
run2: wait_agent 调用=0  ; hasDispatch=true 次数=0
```
⇒ **同一提示、同一代码，`wait_agent` 时有时无；且 `team:dispatch` 两次都不在 prompt。**

**结论（事实）**：
1. **P46 的提示改动对 leader 行为无因果**——它要影响的 `team:dispatch` **被渐进披露永久过滤**（§9.6 根因），**从未生效**。
2. **P46 阶段2「不再调 `wait_agent`」= 运行间方差（假绿）**；阶段1「红」与阶段2「绿」是**两次独立采样**，非「改动前后」。⇒ **P46 结论【推翻】**（不可作为「已把默认改成不等待」的证据）。
3. 排除其它可能：`leaderWaitModel` **只**被 `team:dispatch` 使用（`src/index.ts`），无其它段受影响 ⇒ 无「①其它段」路径；「②场景无 spawn」不成立（nativeWait 场景**确有** spawn_teammate）。

**含义**：
- 「leader 默认事件唤醒」**目前既未生效（§9.6）也未被可靠验证（§9.7）**；P46 结论文档需按「未生效/待重做」更正。
- **修复顺序**：P57 修 `teamBuilt` 判定（让 `team:dispatch` 真正进入 prompt）→ 再**用 `prompt-dump` 断言 `hasDispatch=true`** → 然后**多轮重复**测「长轮询是否被治住」（单次不足，须多采样，防方差假绿）。


---

## 10. P57 独立复核（prompt-dump 探针，真实会话 ≥3 轮；预算 ≈0.108M ≤0.3M）

对 P57（`team-prompt` c6bd762：修 `teamBuilt` 判定 + 等待硬约束进常驻 `team:leader`）的**独立复核**（非作者自证；用我新增的 `scripts/xproc/prompt-dump-plugin.mjs`）。

**方法**：`pnpm -r build` 后用真实 headless（含 prompt-dump overlay）跑 **3 轮** `spawn_teammate + send_message`，逐次装配落盘段落名/文本，统计。

**结果**：
```
round1: assemblies=7  hasDispatch_true=6  false=1  hasEventWake_true=7  wait_agent_calls=1
round2: assemblies=8  hasDispatch_true=7  false=1  hasEventWake_true=8  wait_agent_calls=0
round3: assemblies=7  hasDispatch_true=6  false=1  hasEventWake_true=7  wait_agent_calls=0
TOTAL ≈ 107,772 tokens（≤0.3M）
```
**逐条判定**：
- ✅ **渐进披露两半环都对**：每轮**恰好第 1 次装配 `hasDispatch=false`（建团队前摘掉），其后全部 `true`（spawn 后释放）**。证据（round1）：line1 无 `team:dispatch`/`team:task-state`；line2+ 都在。**对照修前（§9.6）：恒 false ×6** ⇒ **bug 已修**。
- ✅ **`team:leader` 常驻**：每轮**全部装配**都含 `team:leader`，且 `hasEventWake=true` 全轮命中（含建团队前）⇒ 等待硬约束**起手即生效**。
- ✅ **长轮询未再出现**：`wait_agent` 调用 **1 / 0 / 0**；**P54 的「idx17→idx44 多次轮询」不再复现**。**诚实保留**：round1 仍有**单次** `wait_agent`（1 次，非轮询）——属正常方差；**「单次 ≠ 长轮询」**，但说明「彻底不 wait」并非绝对（也与设计一致：允许单次短 wait）。
- 口径：**【真实 profile 级 已验证】本轮**（修复生效 + 无长轮询）；仍建议在最终回归里保持**多轮采样**。

**P57 结论**：独立复核**通过**。P46 更正（§9.6/§9.7）仍成立——即「曾声称生效实为方差假绿 + 提示从未进 prompt」，**本次 P57 修复后该指引才真正进入 prompt 并抑制长轮询**。
