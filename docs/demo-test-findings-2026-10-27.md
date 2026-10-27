# Demo 实测四现象诊断（2026-10-27）

> 任务：P59 ｜ 作者：bench-qa-engineer ｜ 方法：**会话日志取证 + 源码核对**（真实模型 0 token）
> 样本：用户 2026-10-27 在 demo（web / `集群模式` / 7 子智能体）实测「收集一下最近最新的 AI 相关近况」（后又追加「还有DeepInfer 的内容」「时间都扩大到1年」「而且要包括产业链的全部」「如何？」「？」）。
> 纪律：**事实 / 推断分离**，每条附证据（日志事件 / 代码 / i18n key / 行号）。

---

## 0. 结论速览

| # | 现象 | 定性 | 归属 | 一句话根因 |
|---|---|---|---|---|
| ① | 群聊/广播/@ 没被用起来 | **用法+引导缺口（非 bug）** | 我们的提示 + DSH 平台无 `@` 原语 | 本轮 `broadcast=0`、`multicast=2`、`send_message=13`；leader 以 **DM 为主**；DSH **没有 `@`/`mention` 工具**；提示词只提「只处理含你的广播」，未引导用广播发起协同 |
| ② | 「子任务状态更新 / 收到任务消息 / 已完成，用时X秒」占屏 | **呈现缺口（非我们插件的 emit）** | **上游 web chat 客户端**（native 会话层） | 文案来自 `@deepseek-ai/dsh-client-ui-chat` 的 i18n（`message.trigger.{agent,subagent}`、`message.turnProcess.took`）；每条入站**触发**渲染一个可展开 `turn-trigger` 节点、每轮渲染一个 `turn-process` 节点，**无聚合** |
| ③ | 「如何？」后无可见回应 | **非卡死；呈现层问题【待 1 次 web 复现确认】** | 倾向上游呈现；**不是** P51 兜底例证 | 日志显示 leader **确实**在第 19 轮产出了文本答复（`总体评价：可用…`）并正常 `turn/end`；**没有**卡在 `wait_agent`、**没有**未处理用户消息；用户可见层只见到折叠的「已完成，用时 11 秒」 |
| ④ | 成员复用率低 / 只下发一条 | **部分成立（设计/用法）** | 我们的 leader 行为 + 提示 | 7 名成员 turn 数多为 **1–2**；leader 以「派发 DM + 收口期再 DM」为主，**全程无广播/群聊**；收口阶段确有追加（13 条 DM / 2 条多播），但**无「群聊式」多轮往返** |

> 最接近「真 bug」的是 **③**，但它**不是 runtime 卡死**，而是「有动作、有 durable 输出、用户却看不到可见回复」——本报告给出证据与待确认的复现步骤（§4）。

---

## 1. 取源与样本（可复现）

demo 实例的会话根目录：

```
.runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm-.runtime-home-test_swarm--/
```

| 角色 | session id | 备注 |
|---|---|---|
| **root（lead）** | `session-29558dd1-2aab-4fc5-8d6e-db7757f56dc6` | 555 事件、**20 turn**、70 tool/call |
| teammate ×7 | `db77acef…`=researcher-models、`c29b7592…`=researcher-industry、`c1064590…`=researcher-research、`914b935e…`=synthesizer、`bd126f85…`=researcher-deepinfer、`90b69e35…`=researcher-upstream、`14fea750…`=researcher-downstream | 均 `parentSession=session-29558dd1…`（`subagent/catalog=7`，与「7 个子智能体」一致） |

复现命令（多帧 zstd，`zstd -dc` 全量解）：

```bash
cd <项目>/dsh-swarm
D=.runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm-.runtime-home-test_swarm--
# 根会话事件类型分布 + 工具调用计数
zstd -dc "$D/session-29558dd1-2aab-4fc5-8d6e-db7757f56dc6/session.v4.jsonl.zstd" \
  | node -e 'let a=[];require("readline").createInterface({input:process.stdin}).on("line",l=>{try{a.push(JSON.parse(l))}catch{}}).on("close",()=>{const t={},tc={};for(const e of a){t[e.type]=(t[e.type]||0)+1;if(e.type==="tool/call")tc[e.data?.name]=(tc[e.data?.name]||0)+1}console.log(t);console.log(tc)})'
```

---

## 2. 现象①：群聊 / 广播 / `@` 没被用起来

**事实（日志计数，root 会话 `tool/call`）**：

| 工具 | 次数 |
|---|---|
| `send_message`（DM，单目标） | **13** |
| `multicast`（多目标） | **2** |
| `broadcast`（广播） | **0** |
| `spawn_teammate` | 7 |
| `team_task_create` | 7 |
| `team_task_update` | 17 |
| `wait_agent` | 1 |

- 投递目标：13 条 DM 里，5 条是**首次派活**（逐成员）、其余为**口径变更/收口**再联系；2 条 `multicast` 分别是「口径变更：时间窗扩到 1 年，发给 3 名 researcher」与「环境提示：web_search 可能不可用，发给多名 researcher」。
- **`@` / mention**：DSH 侧**没有 `@`/`mention` 工具**（root 工具面里不存在该名字；`@all` 是 JiuwenSwarm 的**用户级 interact 语法**，DSH 未实现）。
- **提示词引导**：`packages/team-prompt/src/index.ts:142` 对 leader 的指引是「派发或发消息后请结束轮次…**只处理发给你的消息/含你的广播**」——这是**接收侧**规则，**没有**引导 leader「用一个广播/群聊来发起协同」。

**定性**：**用法 + 引导缺口（非 bug）**。群聊/广播并非不可用（`broadcast`/`multicast` 工具都在），只是：① leader 自然选择 DM（点对点派活更精准）；② 平台没有 `@` 原语；③ 提示词未把「全局公告/口径变更」场景**显式指向广播**。

**建议**：
- 在 `team-prompt` 的 leader 指引里**显式**写清「**全局公告 / 口径变更 / 环境提示** → 用 `broadcast`（或 `multicast`）而非 N 条 DM」，并说明广播的**唤醒全体**语义（与源系统一致，见 `experiments-idle-wakeup.md §9`）。
- 若要 `@` 语义，属**上游/产品**面（DSH 无 mention 解析）；我们可在 prompt 层用「`@name` → 用 DM，`@all` → 用 broadcast」的**约定映射**做软引导。

---

## 3. 现象②：「子任务状态更新 / 收到任务消息 / 已完成，用时X秒」占屏

**证据（文案来源 = 上游 i18n）**：在 web chat 客户端包
`@deepseek-ai/dsh-client-ui-chat@0.2.1-rc.3`（`lib/client.js`）中，三条文案精确对应：

| 用户看到的文案 | i18n key |
|---|---|
| 子任务状态更新 | `message.trigger.subagent` |
| 收到任务消息 | `message.trigger.agent` |
| 已完成，用时 X | `message.turnProcess.took`（"已完成，用时 "）|

同文件还可读到渲染逻辑：`return chatNode(context, waking ? "turn-trigger" : …)`（即**每个「唤醒该轮」的入站消息渲染成一个 `turn-trigger` 节点**）与 `turnProcesses` / `turnProcessOpen` / `turnProcessAlwaysOpen`（**每轮一个 `turn-process` 节点**，可展开 `⌄`）。截图里每条右侧的 **`⌄` 展开箭头 + 图标**正是这类**结构化 envelope/card**（不是纯文本消息）。

**代码位置（上游 `@deepseek-ai/dsh-client-ui-chat@0.2.1-rc.3` `lib/client.js`）**：
- `turn-trigger` 标题赋值：`:7035`（`title = "message.trigger.agent"`）、`:7043`（`title = "message.trigger.subagent"`）；
- `turn-process` 徽标：`message.turnProcess.took` 于 `:5776 / :5970 / :6629`，折叠状态 `turnProcessOpen`/`turnProcessAlwaysOpen` 于 `:3644/3670/3719/3722/4161/6624`。
⇒ 两者均为**上游会话/客户端 UI 的轮次徽标与触发节点**，**不是**我们插件 `emit` 的文本。

**这些条目由谁产生？→ 上游原生会话/客户端层，不是我们的插件**：
- `收到任务消息`（trigger=agent）由 **native agent-team 的入站 relay** 触发——对应 durable 里 `user/message` 且 `source.kind==='agent-message'`（如「Team message from researcher-research:」）。
- `子任务状态更新`（trigger=subagent）由 **native subagent 层**触发——对应 `source.kind==='subagent-settled'`（「Background subagent … finished」）。
- `已完成，用时X秒` 由 **turn 生命周期**（`turn/process`）触发。
- 我们的插件（`team-bus`/`team-core`/…）**没有** emit 这些文案；它们由**上游 chat 客户端**依据 native 的入站消息种类与轮次**渲染成独立节点**。

**为何逐条进主对话流、且无聚合**：客户端把**每一个入站触发**渲染为一个 `turn-trigger` 节点、**每一轮**渲染一个 `turn-process` 节点——二者**都不与相邻项聚合**。本轮 leader 有 **20 个 turn**，其中相当多是被 teammate 消息**唤醒**的短轮（每次成员完成→relay→leader 起一轮），于是在主对话流里就形成截图那种 **「收到任务消息 → 已完成，用时X秒」成对反复**。

**定性**：**呈现缺口，属上游 web chat 客户端**（native 会话层），**非我们插件的 emit 问题**。

**建议（落点）**：
- **UI 侧折叠/聚合**（首选）：把「同一批次的 `turn-trigger` + 其 `turn-process`」折叠为一条摘要（如「N 条成员更新 · 用时合计」），或把被唤醒的**过程轮**默认折叠、只在有**用户可见文本**时展开。属**上游 chat 客户端**（可向上游提；或在我们的 client 集成层包一层）。
- **减少过程轮的可见度**：让 leader 的「被成员消息唤醒、仅内部推进」的轮次**不产生可见条目**（只在与用户对话的轮次留痕）。这需要在会话/客户端层区分「用户轮」与「事件唤醒轮」。
- 不改我们的 `emit`（`swarm/*` 与这些节点无关）。

---

## 4. 现象③：「如何？」后无可见回应（**最优先**）

**事实（durable 日志，root 会话尾段）**：

```
21:37:14  turn 19 start；user/message(user) = "如何？"
21:37:25  assistant/message[turn 19] blocks = ["reasoning: The user asks \"如何?\" …", "text: 总体评价：**可用，属于…**"]  ← 有文本答复
21:37:25  turn/end 19  reason={"kind":"completed"}                          ← 正常结束，未阻塞
21:38:02  turn 20 start；user/message(user) = "？"
21:38:07  assistant/message[turn 20] = reasoning + tool-call(ask_user_question)
21:38:33  assistant/message[turn 20] = "## 这一年 AI 的一句话总结…"          ← 第 20 轮再次给出文本
21:38:33  turn/end 20
```

即：
- leader **没有**卡在 `wait_agent` / `in_progress`（第 19 轮 11 秒内正常 `turn/end completed`）；
- **没有**未处理的用户消息（「如何？」进入了第 19 轮并产出了文本答复）；
- 因此**不是**「P51 消息兜底不覆盖原生直发路径」的例证——那条针对**未被处理的用户消息**，而这里消息**被处理了**。

**但用户可见层（截图）**：「如何？」气泡之后**只有**一条折叠的 `已完成，用时 11 秒`（可展开 `⌄`），**看不到**第 19 轮那段「总体评价…」文本。

**推断（需确认）**：这是**呈现层**问题——很可能 leader 的答复文本被**折叠进了该轮的 `turn-process` 节点**（或该文本未被渲染为独立气泡），用户只看到折叠标题行，**误以为「无反应」**。**非 runtime 卡死**。

**待确认的复现（1 次 web 端，零/低 token）**：
1. 在 demo web 端发一句会触发 leader **单轮文本答复**的消息（无子智能体）；
2. 观察该答复是否渲染为独立气泡，还是被收进 `已完成，用时X秒 ⌄`；
3. 展开该 `⌄`，看答复是否在里面 → 若是，则定性为**「turn-process 折叠吞掉可见答复」**（上游呈现）；若答复**完全不存在**，则升级为**上游渲染 bug**。

**建议**：在确认前**不要**归因到我们的 runtime；先按上面复现；若确认是折叠所致，落点是**上游 chat 客户端**（或我们做一层「被事件唤醒的过程轮不吞用户答复」的呈现约定）。

### 4.1 补充取证（回应「是否空跑一轮」的追问）

**结论：不是空跑——leader 在第 19 轮有 committed 的可见正文。** durable 原文（`usage=true` ⇒ 已提交，非半截流）：

| turn | step | blocks（类型） | 正文节选 |
|---|---|---|---|
| 18 | 3 | `text` | 「完成。最终报告已通过我的独立复核（"第八节"残留 0…）」 |
| **19** | 1 | `reasoning` + **`text`** | 「**总体评价：可用，属于"结构扎实、诚实度高、但覆盖有已知盲区"的成果**。分开说。…」（**正是对「如何？」的答复**） |
| 20 | 2 | `reasoning` + **`text`** | 「## 这一年 AI 的一句话总结…」 |

`turn/end 18/19/20` 均为 `{"kind":"completed"}`；**没有** `wait_agent` 阻塞、**没有**未消费的用户消息（「如何？」进了 19 轮、「？」进了 20 轮并各自产出正文）。

⇒ **驳回「leader 只打完成徽标/空跑一轮」的假设**：正文确实产出且已落库。因此现象③的异常点在**「已提交的正文未被用户可见层展示」**——属**呈现层**（折叠/渲染），**非** runtime 空轮、**非**卡死、**非 P51**。会话标题 `session/title="收集最新AI相关近况"` 与截图一致，确认是**同一会话**。

**待 1 次 web 复现**（零/低 token）分辨这两种呈现子因：
- (a) 正文被**折叠进该轮 `turn-process` 节点**（展开 `⌄` 可见）→ 上游呈现约定；
- (b) 正文**根本没渲染**（展开也没有）→ 上游渲染 bug（升级给上游）。

---

## 5. 现象④：成员复用率低 / 只下发一条、无追加互动

**事实（逐成员统计，durable）**：

| 成员 | turn 数 | 收到 relay（agent-message） | 备注 |
|---|---|---|---|
| researcher-models | 1 | 6 | 曾二次收口（回补窗口） |
| researcher-industry | 2 | 7 | 二次收口 |
| researcher-research | 2 | 6 | 二次收口 |
| synthesizer | 3 | 2 | 整合 + 最小修订 |
| researcher-deepinfer | 1 | 2 | 专项 |
| researcher-upstream | 1 | 3 | 产业链上游 |
| researcher-downstream | 1 | 2 | 产业链下游 |

**事实（leader 侧）**：`send_message=13`、`multicast=2`、`broadcast=0`。首次派活 5 条 DM；随后因用户新增要求（DeepInfer / 1 年 / 全产业链）与收口，**确有追加 DM**（如「请回补一轮」「已把 task-2 重新打开」）。

**定性**：**部分成立**。
- 「**只下发一条、无追加互动**」→ **不成立**：leader 对部分成员（models/industry/research/synthesizer）进行了**收口级追加联系**。
- 「**成员复用率低**」→ **成立**：7 名成员多为 **1–2 轮**，多数**单轮完成**；**没有**「群聊式」多轮往返/头脑风暴。
- 根因：① leader 的默认策略是「派活→成员各自跑→完成即 relay 唤醒 leader 收口」，**点对点**；② 全程**无广播/群聊**（现象①）；③ DSH 侧成员的「被再次联系」靠 DM（`send_message`），没有 topic 群聊把多人拉进同一讨论。

**建议**：
- 对**协作密集**的任务，提示 leader 用 **`multicast`/群聊**做「多方对齐」，而非逐人 DM；
- 与现象①同源：补 `team-prompt` 的**广播/群聊使用引导**是共同落点。

---

## 6. 事实 / 推断 分离

**事实（日志/代码可证）**：
- root：20 turn、`broadcast=0`、`multicast=2`、`send_message=13`、7 成员；
- 三条噪音文案的归属 i18n key（`dsh-client-ui-chat`）；
- `turn-trigger`/`turn-process` 节点由客户端按入站种类与轮次渲染；
- 第 19 轮 leader 有文本答复且正常结束、无未处理消息；
- 逐成员 turn/relay 计数。

**推断（未完全证实）**：
- 现象③的「无可见回复」系**呈现层折叠**所致（**待 1 次 web 复现确认**）；
- 现象②的「为何无聚合」为客户端**逐节点渲染、不聚合**的**设计**（已由 client 代码结构支持，但未逐行确认聚合策略）。

---

## 7. 复现命令（零 token）

```bash
cd <项目>/dsh-swarm
D=.runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm-.runtime-home-test_swarm--
ROOT="$D/session-29558dd1-2aab-4fc5-8d6e-db7757f56dc6/session.v4.jsonl.zstd"

# ①工具计数 + ②③时间线（上面 §1/§4 的脚本即取自此）
# ③ 第19/20轮内容块类型：
zstd -dc "$ROOT" | node -e 'let a=[];require("readline").createInterface({input:process.stdin}).on("line",l=>{try{a.push(JSON.parse(l))}catch{}}).on("close",()=>{for(const e of a) if(e.type==="assistant/message"&&(e.data?.turn===19||e.data?.turn===20)) console.log(e.data.turn,(e.data.message?.content||[]).map(b=>b.type).join("+"))})'
# ④ 逐成员：对每个 teammate 会话 zstd -dc 后统计 turn/start 次数与 source.kind==='agent-message'

# ② 文案归属（上游 i18n）：
grep -o '"message.trigger.[a-z]*": "[^"]*"' \
  .runtime/dsh-cli-npm/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-chat@*/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js | sort -u
```

---

## 8. 改进落点小结

| 现象 | 落点 | 动作 |
|---|---|---|
| ① 群聊/广播未用 | **我们**（提示词） + 上游（`@` 原语） | `team-prompt` 增加广播/群聊场景引导；`@` 属上游 |
| ② 噪音占屏 | **上游**（web chat 客户端） | 折叠/聚合 `turn-trigger`+`turn-process`；我们不改 emit |
| ③ 无可见回复 | **待确认**（倾向上游呈现） | 先做 §4 的 1 次 web 复现；确认后归上游折叠问题；**非 runtime 卡死、非 P51** |
| ④ 复用率低 | **我们**（提示词/leader 行为） | 协作密集任务引导用群聊/多播做多方对齐 |

> 本报告**未改动任何 `packages/*/src`**；若确认现象③为真 bug 且落在我们侧，将按纪律**先报 team-leader** 再动。
