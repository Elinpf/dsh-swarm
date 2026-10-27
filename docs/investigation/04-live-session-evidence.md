# 04 · 本会话活证据：一次真实 team 会话的事件与投影实证

> 调查对象就是**正在运行这一组调查小组的会话本身**（Lead = `lead`，根会话
> `session-4e0b08f3-9cfa-43a8-bc0a-5b6debceea3f`，成员 `core-model` / `tools-messaging` /
> `wiring-ui` / `auditor`）。本文只记录**可复现的观测事实**，推断部分显式标注「推断」。
> 与 01/02/03 的关系：那三份是**源码**证据，本文是**运行期**证据，用于交叉验证「源码说了什么」
> 与「实际落了什么」。

---

## 0. 证据来源与复现命令

| 证据           | 路径                                                                                                                           | 说明                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 根会话事件日志 | `.runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm--/$DSH_SESSION_ID/session.v4.jsonl.zstd` | 多帧 zstd 追加写；`$DSH_SESSION_ID` = 根会话 id |
| 成员会话日志   | 同目录下以**成员 SessionId 命名**的子目录（无 `session-` 前缀）                                                                | 每个 teammate 一份                              |
| 会话投影缓存   | `.runtime/dsh-home/storages/session_projcache/sessions/$DSH_SESSION_ID.json`                                                   | `record.rows.agentTeam` 即团队投影              |

```bash
# 1) 解压（多帧 zstd，逐帧解；脚本见 docs/investigation/evidence/04-extract-session.mjs）
node docs/investigation/evidence/04-extract-session.mjs \
  ".runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm--/$DSH_SESSION_ID/session.v4.jsonl.zstd" \
  .runtime/investigation-live/session-events.jsonl

# 2) 抽取 team/* 时间线（脚本见 docs/investigation/evidence/04-team-timeline.mjs）
node docs/investigation/evidence/04-team-timeline.mjs .runtime/investigation-live/session-events.jsonl

# 3) 读投影
node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).record.rows.agentTeam,null,1))' \
  ".runtime/dsh-home/storages/session_projcache/sessions/$DSH_SESSION_ID.json"
```

**工具细节（实测坑）**：`session.v4.jsonl.zstd` 不是单个 zstd 帧，而是「每批写入一个独立帧」追加
（文件前 4 字节就是 magic `28 b5 2f fd`，此后每帧自带 magic）。Node 22 的
`zlib.zstdDecompressSync()` 只解第一帧，流式解压会在帧边界抛
`Unknown frame descriptor`。按 magic 切帧逐帧解压即可；最后一帧可能正在写入，失败就丢弃。
此种文件格式在该仓库的公开文档中未见说明 → **推断**：这是会话持久化层的内部实现细节，非契约。

---

## 1. 观测到的事实（本会话，seq 为根会话事件序号）

### 1.1 任务板事件：每次写入一条完整快照

`node docs/investigation/evidence/04-team-timeline.mjs` 的实测输出（截取）：

```
111  tool/call        team_task_create
112  team/task        task-1  rev=1  status=pending  owner=-        blockedBy=[]
115  team/task        task-2  rev=1  status=pending  owner=-        blockedBy=[]
118  team/task        task-3  rev=1  status=pending  owner=-        blockedBy=[]
121  team/task        task-4  rev=1  status=pending  owner=-        blockedBy=[]
127  team/task        task-5  rev=1  status=pending  owner=-        blockedBy=[]
130  team/task        task-6  rev=1  status=pending  owner=-        blockedBy=[]
136  team/task        task-4  rev=2  status=pending  owner=-        blockedBy=["task-1","task-2","task-3","task-5"]
139  team/task        task-6  rev=2  status=pending  owner=-        blockedBy=["task-4"]
144  tool/call        spawn_teammate
145  team/member      core-model      phase=provisioning  id=8754a0a1
147  team/member      core-model      phase=active        id=8754a0a1
149  tool/call        spawn_teammate
150  team/member      tools-messaging phase=provisioning  id=47072ac8
152  team/member      tools-messaging phase=active        id=47072ac8
154  tool/call        spawn_teammate
155  team/member      wiring-ui       phase=provisioning  id=3d8517d7
157  team/member      wiring-ui       phase=active        id=3d8517d7
159  tool/call        spawn_teammate
160  team/member      auditor         phase=provisioning  id=1ca7e9bf
162  team/member      auditor         phase=active        id=1ca7e9bf
166  team/task        task-2  rev=2  status=in_progress  owner=47072ac8  blockedBy=[]
167  team/task        task-1  rev=2  status=in_progress  owner=8754a0a1  blockedBy=[]
168  team/task        task-3  rev=2  status=in_progress  owner=3d8517d7  blockedBy=[]
171  team/task        task-5  rev=2  status=in_progress  owner=session-  blockedBy=[]
```

**F1（隐式 Team）**：`team/task` 事件的 `data.teamId` = `session-4e0b08f3-…`，即**根会话 id 本身**；
投影 `agentTeam.val.id` 同值。→ 与 01 §1.1「Team 不是被创建的实体，根 Session 即 Team」一致。

**F2（事件=完整快照，不是 delta）**：每条 `team/task` 都携带 `task` 全字段
（`id/revision/subject/description/status/ownerId?/blockedBy/writeScopes`），`data.version=2`。
一次 `team_task_create` 恰产生一条事件（seq 111→112，114→115 …）。

**F3（依赖变更也走同一事件）**：`set_dependencies` 使 `revision` 1→2 并写入 `blockedBy`
（seq 136、139）。→ 与 01 §3.3「任何写入都递增 revision」一致。

**F4（owner 可以是根会话自己）**：`task-5` 由 Lead 认领，`ownerId` = 根会话 id（`session-` 前缀），
而 teammate 认领时 `ownerId` = 成员 SessionId（纯 uuid）。→ 任务板把 owner 建模为 SessionId，
不区分 lead / teammate。

**F5（成员生命周期实测只有两跳）**：4 次 `spawn_teammate` 各产生**成对的** `team/member` 事件：
`provisioning` → `active`（间隔 150–200 ms，seq 相邻）。**Lead 自身从不产生 `team/member` 事件**，
投影 members 列表里也没有 Lead 行。→ 与 01 §1.2/§2.2「durable phase 只有
provisioning→active|failed；Lead 不是 roster 成员」一致。本会话未观测到 `failed`。

**F6（模型侧 status 与 durable phase 不同源）**：`spawn_teammate` 返回体给出的 `status: "running"`，
而落盘 phase 是 `active`。→ 与 01 §1.2「runtime view 的 running/inactive 来自会话 turn 状态，
不是 durable 快照字段」一致（本文档只作运行期旁证，判定权归 05）。

### 1.2 成员会话：另一个 Session，另一个日志文件

成员 `core-model` 的会话日志（目录名 = 纯 uuid `8754a0a1-1dfa-43ab-bb24-b5cf0bda90f3`）：

```json
{"type":"session","id":"8754a0a1-1dfa-43ab-bb24-b5cf0bda90f3","delegationDepth":1,"isSeeded":false,"agentPreset":"swarm"}
{"type":"subagent/descriptor","seq":0,"data":{"version":3,"mode":"continuable","provider":"spawn",
  "label":"核查并补全 team 核心模型文档（任务 task-1）","agentProvider":"dshdemo","agentModel":"DeepSeek-Flash"}}
{"type":"agent/inbox/spliced","seq":3,"data":{"target":"next-turn","inserted":[
  {"content":[{"type":"text","text":"你是「DSH team 模式调查小组」成员 core-model。…"}],
   "source":{"kind":"user"},"role":"user"}]}}
```

**F7（成员是独立 Session）**：每个 teammate 有独立 SessionId 与独立会话日志目录；
`delegationDepth=1`、`agentPreset` 继承 Lead 的 `swarm`；`subagent/descriptor.mode="continuable"`、
`provider="spawn"`、`label` = `spawn_teammate` 的 `description`。

**F8（spawn 的 prompt 走 inbox splice，与人类消息同一机制）**：Lead 传入的 prompt 以
`agent/inbox/spliced`（`target: "next-turn"`，`source.kind="user"`）注入成员会话，
随后成为该会话的 `user/message`。→ 说明团队成员初始指令与用户消息在投递层同构。

**F9（团队状态是根会话的投影，不是分布式的）**：成员自己的会话日志里**没有任何 `team/*` 事件**
（core-model 日志的 type 直方图：`session/subagent-descriptor/sandbox-mode/approval-policy/
agent-inbox-spliced/turn-start/step-start/system-message/user-message/request-header/request-context/
session-title/assistant-message/tool-call/tool-result/job-registered/job-settled/step-end`），
而它认领 task-1 的动作（seq 167）只出现在 **Lead 的日志**里。
→ **推断**：任务板/roster 的持久状态挂在根会话（TeamId = 根 SessionId），成员侧只是执行者；
跨会话可见性由投影而非共享存储提供。

### 1.3 投影内容（`.runtime/dsh-home/storages/session_projcache/sessions/$DSH_SESSION_ID.json`）

`record.rows.agentTeam.val` 实测结构：

```jsonc
{
  "id": "session-4e0b08f3-…", // = TeamId = 根会话 id
  "members": [
    /* 4 项：id,name,description,provider,context,phase；无 Lead 行 */
  ],
  "tasks": [
    /* 6 项：id,revision,subject,description,status,ownerId,blockedBy,writeScopes */
  ],
  "messages": [],
  "delivered": [],
  "nextTaskNumber": 7
}
```

**F10（投影字段 ≠ 工具视图字段）**：投影里**没有** `ready`、`writeScopeWarnings`、`ownerName`
（这些属于 `TeamTaskView`，见 01 §1.3）；却有源码类型中不显眼的 `messages` / `delivered` /
`nextTaskNumber`。本会话 `messages`/`delivered` 始终为空数组。

**F11（writeScopes 确实随任务持久化）**：投影中每条任务都带创建时传入的 `writeScopes`
（如 task-1 = `["docs/investigation/01-core-model.md","docs/investigation/evidence/01-"]`），
但**未观测到任何 `writeScopeWarnings` 产生或落盘**（该字段只在 view 层）。

### 1.4 消息投递：成员 → Lead 的实际落盘形态

调查中途 `auditor` 用 `send_message` 向 Lead 发了一条简报，在 **Lead 的会话日志**里留下：

```
305  agent/inbox/spliced  target=next-step  inserted=[{source:{kind:"agent-message",form:"relay"}, role:"user"}]
310  agent/inbox/spliced  target=next-step  removedCount=1  inserted=[]      ← 被 step 消费后移除
313  agent/inbox/spliced  target=next-step  inserted=[{source:{kind:"subagent-settled",...}}]
```

splice 的实际正文是两个 content 块：

```json
[
  { "type": "text", "text": "Team message from auditor:" },
  { "type": "text", "text": "auditor 阶段0 完成：独立基线已就绪…" }
]
```

**F12（投递目标 = `next-step`，形态 = relay）**：成员发给 Lead 的消息以
`agent/inbox/spliced` 落入 Lead 会话的 **`next-step`** 列表，`source.kind="agent-message"`、
`source.form="relay"`，`role="user"`。→ 与 02 §2.2 的源码结论一致：走 `root.steer(...)`，
即「目标的下一个 step 边界收到，不打断当前 step」。

**F13（消息前缀由投递方加）**：正文首块为 `Team message from <sender>:`，第二块才是原正文。
→ 与 02 §2.2 第 3 条（`index.ts:231` 加前缀）一致。

**F14（成员结束会自动产生一条 notice）**：`auditor` 结束本轮后，同一 `next-step` 通道出现
`source.kind="subagent-settled"` 的 splice。→ **agent-team 包文档未描述该通道**；机制由 subagent
子系统定义：`docs/subsystems/subagent.md:189-206` 与
`packages/subagent/subagent/src/continuation-messages.ts:22-37` 定义
`SubagentSettledMessageSource{ kind:'subagent-settled', form:'notice', summary, senderSessionId }`。
因此成员「本轮结束」走 inbox notice，而不是 `team/member` 事件（该事件仅覆盖 provisioning→active）。
（措辞按 05 的 FIX-5 修正。）

### 1.5 等待与完成：`wait_agent` 实测

Lead 在 3 名成员均为 `running` 时调用 `wait_agent {timeout_ms:180000}`（tool/call seq 358），
结果：

```json
{ "timedOut": true } // tool/result，isError:false
```

**F15（等待语义）**：整整 180 s 内成员状态 / 消息 / 任务板均无变化，`wait_agent` 就等满超时并返回
`timedOut:true`；它**不观察运行中 turn 的“进度”**，只观察状态/消息/任务板变化。→ 与
tool-agent-team 的实现一致（`waitForChange` 只在 roster/message/task 变更时解析）。
**推断**：所谓 `noProgress` 立即返回，前提是「没有其他成员处于 running/provisioning」；本例中
3 名成员都 running，故不会立即返回。

**F16（任务完成事件）**：`core-model` 完成 task-1 后产生
`seq 363 team/task task-1 rev=3 status=completed owner=8754a0a1-1dfa-43ab-bb24-b5cf0bda90f3`
（= `core-model` 的 SessionId）——`completed` 是一次普通写入
（rev+1），**owner 字段保留**；`team/task` 事件族本身没有“删除”事件（删除体现为 `status=deleted` 的快照）。

### 1.6 本轮「跑测试」的可行性实测（供复现者参考）

- 工作区根有 `node_modules/.bin/vitest`（v4.1.11），但**上游 harness checkout 没有 `node_modules`**，
  且 `packages/experimental/agent-team/tests/team.spec.ts:1-16` 依赖
  `@deepseek-ai/dsh-agent-loop-testkit` 等 harness 开发依赖——该包在工作区
  `node_modules/@deepseek-ai/` 与运行 profile 的 `node_modules/@deepseek-ai/` 中**均不存在**。
- 因此无法在不安装 harness devDependencies 的前提下实跑 agent-team 测试；
  core-model 的尝试原始输出见 `docs/investigation/evidence/01-vitest-attempt.log`。
  可行的替代实证是：用运行 profile 里**已构建**的
  `.runtime/dsh-home/profiles/dsh-swarm-demo/node_modules/@deepseek-ai/dsh-experimental-agent-team`
  跑纯函数/常量断言，以及本节的会话日志解析。

---

## 2. 与源码结论的交叉验证

| 源码结论（01/02）                                         | 本会话运行期观测                                                           | 结论                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| Team 隐式，TeamId = 根 SessionId                          | F1                                                                         | 一致                                           |
| durable phase 仅 provisioning→active\|failed，无 inactive | F5（2 跳；还未观测到成员退出）                                             | 一致（待补 `failed`/退出样本）                 |
| Lead 不在 roster/projection members 中                    | F5                                                                         | 一致                                           |
| 任务写入产生带 revision 的完整快照事件                    | F2/F3                                                                      | 一致                                           |
| view 才有 ready/ownerName/warnings                        | F10/F11                                                                    | 一致                                           |
| 成员是独立 Session，可继续对话（continuable）             | F7                                                                         | 一致                                           |
| 消息投递经 inbox（quiet/wakeup 决定是否唤醒）             | F8（prompt 以 inbox splice 注入）、F12（成员 →Lead 以 relay 落 next-step） | 一致（quiet/wakeup 的行为差异留给 02/05 裁决） |

## 3. 源码/文档未言明、由本次实证补上的点

1. **会话日志文件名与目录命名不对称**：Lead 目录为 `session-<uuid>`，成员目录为 `<uuid>`（无前缀）。
2. **`session.v4.jsonl.zstd` 为多帧 zstd 追加格式**，`zstdDecompressSync` 只解首帧；需按 magic 切帧。
3. **投影含 `messages` / `delivered` / `nextTaskNumber`**：前两者本会话恒空，说明「durable mailbox 类型仍在
   但非活跃投递路径」（01 §1.4）在**投影层面**也留了空壳字段。
4. **`team/member` 事件的两个 phase 总是成对且相邻**，间隔 150–200 ms；Lead 侧不落任何 member 事件。
5. **任务在成员存在之前就已创建**：seq 112–139 建板 / 设依赖，seq 144 才 spawn 首个成员 → 现实中
   「先建板、后招人、再认领」；`owner` 空缺是常态而非异常。
6. **成员日志不含团队状态**：团队状态只存在于根会话（F9）——这是理解「projection 而非共享存储」的直接证据。
7. **成员的「一轮结束」以 `subagent-settled` inbox notice 通知 Lead**（F14），与 `team/member` 的
   durable phase 事件是两条独立通道；因此「模型侧看到的 inactive/finished」并非 roster 事件来源。
8. **消息消费会在同一 `next-step` 通道留下 remove 记录**（seq 310，`removedCount:1`）：inbox 是
   可观测的「插入—取走」两段式，而非只写不删。

## 4. 局限与后续

- **单样本**：只有一个会话、4 名成员、一次 spawn 波次；`failed`、`interrupt`、成员退出后的
  `inactive` 呈现、`quiet` 投递、`wait_agent` 的“有变化即返回”分支均未覆盖
  → 已交由 task-2（工具/消息）与 task-4（核验）补充。
- 会话仍在写入：本文所有 seq 截取自 `16:38` 左右的日志快照；复现时会话已继续增长（后续事件只增不改前缀）。
- 本文**不**替代 01–03 的源码证据；凡与 01–03 冲突之处，以源码为准并由 05 裁决。
