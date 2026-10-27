# 05 · 独立对抗式核验报告（01–04）

> **核验员**：`auditor`（task-4）。**方法**：不复用作者结论，先独立从源码/运行态重新推导基线，再逐条回源核对作者文档中的承重论断。
> **证据根**：`[H]` = `.runtime/deepseek-harness`（只读 checkout）；`[S]` = 工作区根；`[P]` = `.runtime/dsh-home/profiles/dsh-swarm-demo`。
> **行号纪律**：本报告所有 `path:line` 均由 `read` 打开确认，未使用 grep 推断行号。
> **本次产物**（lead 认可的工作区）：`docs/investigation/05-verify-tmp/{check1-pure.mjs,check1-output.txt,check2-live.mjs,check2-output.txt,check3-paths.mjs,check3-output.txt}`。
> **未修改任何 01–04 正文或源码。**

## 0. 计数结论

| 判定         | 条数   |
| ------------ | ------ |
| CORRECT      | **23** |
| WRONG        | **3**  |
| IMPRECISE    | **2**  |
| UNSUPPORTED  | **0**  |
| 合计承重论断 | **28** |

**未通过合计 5 条**（WRONG 3 + IMPRECISE 2），修复措辞见 §2。

---

## 1. 判定表

### 1.1 `01-core-model.md`

| #   | 论断（摘）                                                                                                                                          | 判定    | 我的证据 path:line                                                                                                                       | 理由                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Team 是隐式的，`TeamId` = 根 SessionId，无创建事件                                                                                                  | CORRECT | `[H]agent-team/src/types.ts:9,16-18`；`projection.ts:145-153,391`                                                                        | `TeamId(id)` 原样返回并 brand；`emptyTeamState` 用 `toTeamId(rootId)`；`init: header => emptyTeamState(header.id)`。与 `README.md:126` 一致。                                                                                            |
| R2  | 成员三层状态；durable phase 只有 `provisioning\|active\|failed`，无 `inactive`                                                                      | CORRECT | `[H]agent-team/src/types.ts:45,48-56,59-69,101-108`                                                                                      | 三个类型逐字段核对；`TeamMemberPhase` 确实三值；`TeamMemberProjection` 注释 `:105` 明确 Lead 恒 active、turn activity 另取 Session status。                                                                                              |
| R3  | durable 状态机只允许 provisioning→active\|failed；name/provider/context 不可变；名字不可复用                                                        | CORRECT | `[H]agent-team/src/projection.ts:253-267`；`roster.ts:252-261,437-443`                                                                   | `:255-257` 名字复用；`:258-259` 首条必须 provisioning；`:261-262` 不可变字段；`:264-266` 非法转移。creator 侧 `transact` 内查重 + 上限。                                                                                                 |
| R4  | `inactive` = Agent 未加载或已加载但 `status !== 'running'`，与任务/失败无关                                                                         | CORRECT | `[H]agent-team/src/roster.ts:475-477,144-148`                                                                                            | `availability()` 实现即该语义；`list()` 的 failed/provisioning 分支优先于 availability，因此 `inactive` 不会掩盖 durable 终态。                                                                                                          |
| R5  | CAS 顺序：存在 → revision → deleted；旧 revision 得 `TEAM_TASK_STALE_REVISION`，只有传删除态 revision 才得 `TEAM_TASK_DELETED`                      | CORRECT | `[H]agent-team/src/task-board.ts:113-121`；`tests/team.spec.ts:797-805,651-655`                                                          | 逐行确认判断顺序；测试 `:801` 传 `deleted.revision` 得 `TEAM_TASK_DELETED`，`:653` 传旧 revision 得 stale。                                                                                                                              |
| R6  | `claim` 不调用 `authorizeOwner`；任何成员可抢 pending+ready 的无主任务                                                                              | CORRECT | `[H]agent-team/src/task-board.ts:122-137`                                                                                                | `:128-137` 的 claim 分支内无 `authorizeOwner()`；仅校验 "已有他人 owner" 与 pending+`taskReady`。                                                                                                                                        |
| R7  | `reassign` 仅 Lead；unassign 分支跳过 `taskReady`；已有 owner 的 pending/in_progress 任务可被直接改派                                               | CORRECT | `[H]agent-team/src/task-board.ts:172-188`；`tests/team.spec.ts:822-824,857-861`                                                          | `:173` Lead-only；`:174-179` 状态门禁；`:180-183` 空 owner 提前 return（无 ready 检查）；`:184` 指定 owner 才查 ready。测试 `:823` blocked 改派被拒、`:858` 空 owner 成功。                                                              |
| R8  | `ready = status==='pending' && taskReady`；`taskReady` 只认 blocker 的 `completed`                                                                  | CORRECT | `[H]agent-team/src/task-view.ts:24-26,59`                                                                                                | 逐行确认；deleted/缺失 blocker 均不满足。                                                                                                                                                                                                |
| R9  | writeScope 告警是纯派生非锁，只与其他 `in_progress` 任务比较                                                                                        | CORRECT | `[H]agent-team/src/task-view.ts:14-16,44-49`；`validation.ts:22,26-33`                                                                   | 过滤条件 `other.status !== 'in_progress'` 作用在**兄弟任务**上；前缀按路径段判包含；`writeScope()` 拒绝绝对/盘符/`.`/`..`。**附加实测**：被查看任务自身即使 pending，只要与 in_progress 兄弟重叠同样告警（见 §4 check1）。措辞本身准确。 |
| R10 | task-graph 保证仅"blocker 存在且非 deleted、无重复、无环"，不提供拓扑序/调度/可行性                                                                 | CORRECT | `[H]agent-team/src/task-graph.ts:26-69`；`projection.ts:280`                                                                             | 全量校验 + 三色 DFS；deleted 节点跳过；命令侧与投影回放侧各调用一次。收紧后的表述与实现一致。                                                                                                                                            |
| R11 | projection `failure` 是终态：写入后所有后续事件返回同一状态引用；view 返回最后有效 members/tasks + failure；`TeamJournal.state()` 读到 failure 抛错 | CORRECT | `[H]agent-team/src/projection.ts:226,235-238,342-361,371-372`；`journal.ts:29-34`（抛错在 `:32`）；`tests/projection-events.spec.ts:476` | `:226` 早退；`:372` failure 分支直接 `buildTeamProjection`；测试断言 `apply(failed, queuedEvent) === failed`。                                                                                                                           |
| R12 | `memberView()`（spawn 返回）只有 `live?.options.model`，无 root fallback；`list()` 有 `?? root.options.model` —— 两者不对称                         | CORRECT | `[H]agent-team/src/roster.ts:430`（无 fallback）对比 `:139`（有 fallback）                                                               | 两行实读确认；01 §7 更正 #12 的收紧正确。                                                                                                                                                                                                |
| R13 | 恢复要求 `descriptor.provider === member.provider`，README 未提该条件                                                                               | CORRECT | `[H]agent-team/src/roster.ts:388-393`；`README.md:126`                                                                                   | `:390-391` 同时要求 continuable、provider 匹配、parentSession 匹配、初始 prompt 被接受；README `:126` 只写 "matching direct-parent and continuable descriptor plus a recorded initial user message"。                                    |
| R14 | `maxMembers` 计入 failed 成员；服务公开面没有任何删除/回收成员的方法                                                                                | CORRECT | `[H]agent-team/src/roster.ts:257`；`index.ts:116-221`；`tests/team.spec.ts:331-342`                                                      | 上限判定 `state.members.length` 不过滤 phase；`index.ts:116-221` 内无回收方法。                                                                                                                                                          |

### 1.2 `02-tools-and-messaging.md`

| #   | 论断（摘）                                                                                                                       | 判定      | 我的证据 path:line                                                                                                                                                                                                                                        | 理由                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R15 | harness 9 个团队工具 + 产品层 10 个 = 并集 19、交集 ∅；`tool-swarm` 是产品层唯一注册模型工具的包                                 | CORRECT   | `[H]tool-agent-team/src/index.ts:192-400`；`[S]tool-swarm/src/index.ts:102-331`；`grep ctx.tools.register packages/*/src` 仅命中 tool-swarm 与 example-plugin                                                                                             | 逐个工具名与行段核对；两层名字无重叠。                                                                                                                                                                                                            |
| R16 | `wait_agent` 无活跃 peer（`running\|provisioning`）时立即返回 `noProgress` 且不注册 waiter；越界不自行报错而转交 `waitForChange` | CORRECT   | `[H]tool-agent-team/src/index.ts:44,264-279`；`activity.ts:23-24`                                                                                                                                                                                         | `:44` 活跃集合；`:264-265` 非法 timeout 直接下传；`:269-270` 活跃 peer 计算；`:271-279` 短路返回 `{timedOut:false,noProgress:{reason:'no-active-peer'}}`。                                                                                        |
| R17 | `team_summary` 无 Config 开关（仅 `if (core)`）；真实开关点为 `:102/:165/:243/:297/:315`                                         | CORRECT   | `[S]tool-swarm/src/index.ts:47-53,102,165,217,243,297,315`                                                                                                                                                                                                | `:217` 为 `if (core)`；五个开关点与 02 更正 #1/#3 完全一致。                                                                                                                                                                                      |
| R18 | `tool-swarm` 硬 `inject` `teamBus`+`teamReview`，缺一则整包不 apply（含本不依赖它们的 `team_summary`）                           | CORRECT   | `[S]tool-swarm/src/index.ts:25-32`；`[H]packages/client/AGENTS.md:97`                                                                                                                                                                                     | `inject` 数组逐项确认；cordis 语义 "Unsatisfied → stays PENDING, with no timeout" 有权威表述。                                                                                                                                                    |
| R19 | `delivery: quiet\|wakeup` 行为差异为**零**：`team-core.send` 收 `delivery` 却不使用，全部内部调用硬编码 `'wakeup'`               | CORRECT   | `[S]team-core/src/index.ts:271-289`（`:273` 收参、`:283-287` 调用不含 delivery）；`team-bus/src/index.ts:325`；`:508`、`team-review:304`                                                                                                                  | 实读确认；`seam.sendMessage` 无 delivery 概念（`[H]agent-team/src/index.ts:224-248` 恒 steer）。                                                                                                                                                  |
| R20 | 当前 `send_message` 不写 `team/message/*`，走目标 Agent inbox 的 `agent-message`/`relay`                                         | CORRECT   | `[H]agent-team/src/types.ts:233`；`agent-team/src/index.ts:237-245`；`tests/team.spec.ts:907`；**实测 check2**                                                                                                                                            | 类型注释标 Historical；发送用 `root.steer`/`steerHostSubagentPrompt`；测试断言 Lead 日志 `team/message/*` 为空；我在运行会话实测 **0 条**。                                                                                                       |
| R21 | `multicast` 按 `id` 寻址、模型只有 `name` → 该工具在模型侧不可用                                                                 | CORRECT   | `[S]team-bus/src/index.ts:216-231`（`:222-225` 传 id 集合、`:229-230` 未知即抛）；`[H]tool-agent-team/src/index.ts:68-71`（只暴露 name 为 target）                                                                                                        | `known` 集合来自 `listMembers().id`；模型工具面永远拿不到 id，故必然 `TEAMBUS_UNKNOWN_TARGET`。                                                                                                                                                   |
| R22 | §2.6.1 结论："`swarm/*` 落地链在本仓无实现者；**在出厂组合下 `recover()` 是不可达代码（只有测试与验证脚本直接调用）**"           | **WRONG** | 反证：`[S]team-bus/src/index.ts:118-120`（recover 在 `:119`）、`team-core/src/index.ts:184-190`（`:189`）、`team-memory/src/index.ts:51-53`（`:52`）、`team-skills/src/index.ts:84-86`（`:85`）；`team-completion/src/index.ts:66-75`（只监听不 recover） | 四个包的生产构造器都在 `ctx.on('session/event')` 内调用 `this.recover([ev])`，并非只有测试/脚本调用。该结论与其同段"恢复侧监听的是 `ctx.on('session/event')`"自相矛盾。缺的是**事件生产端**（无 `session.append`/`sessions.flush`），不是恢复端。 |

### 1.3 `03-ui-wiring-and-docs.md`

| #   | 论断（摘）                                                                                                              | 判定                | 我的证据 path:line                                                                                                                                                              | 理由                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R23 | Web 面板从 Lead 会话的共享 store 读 `projectionsBySession[lead].values.agentTeam`（wire 视图）；Host 半边 inert；无 RPC | CORRECT             | `[H]client-ui-agent-team/src/client/TeamAction.tsx:192-193`；`mount.ts:23-26,53-62`；`src/index.ts:4`；`README.md:28,50`；`session-projection/src/index.ts:347,371,457`         | 取数表达式逐字确认；只有带 `wire` 的注册进入 `values`；Host `apply()` 为空；README 声明不挂 Remote 命名空间。                                                                                                                 |
| R24 | 客户端任务态只有 3 个 locale key，`deleted` 复用 `status.completed`；成员态 4 key                                       | CORRECT             | `[H]client-ui-agent-team/src/client/locales.ts:26-32`；`TeamAction.tsx:33-41`                                                                                                   | zh 字典 `:30-32` 仅 3 个 `status.*`；`statusKey()` 的 `deleted` 分支返回 `status.completed`（`:38-40`）；成员态 `:26-29` 四个。                                                                                               |
| R25 | 原生任务态是 4 值闭集；dsh-swarm 的 `in_review`/`planned` 在原生投影与面板不可见，只在 `team-core` 端口读侧 overlay     | CORRECT             | `[H]agent-team/src/projection.ts:82,325`；`[S]team-core/src/index.ts:298-304,625-630`；`TeamAction.tsx:33-41`                                                                   | schema `z.enum(['pending','in_progress','completed','deleted'])` 两处；overlay 在 `getTask`/`listTasks` 出口叠加；面板 switch 无叠加态。                                                                                      |
| R26 | §4 端到端链路图 ③："Lead Session 落 durable 事件 `team/member` + `team/task` + `team/message/{queued,delivered}`"       | **WRONG**           | 反证：`[H]agent-team/src/types.ts:233-241`；`index.ts:237-245`；`tests/team.spec.ts:907`；**实测 check2 = 0 条**                                                                | 该行把历史只读的 `team/message/*` 列为会落盘的事件，与 01 §1.4 / 02 §2.6 / 04 §1.3 及其自身的实测计数（8+12 只含 member/task）冲突。                                                                                          |
| R27 | 组装后出现**两条同 id `preset-swarm`**（用户 patch + bundle 新增 `presets/swarm.patch.yml`），patch 语义不去重          | CORRECT             | `docs/investigation/evidence/03-composed-entries.txt:223,226`；`[S]packages/bundle/package.json:23-26`；`[P]cordis.patch.yml:4-5`；`[S]packages/bundle/presets/swarm.patch.yml` 存在 | 证据行实读命中两条同名 entry；bundle manifest 已声明两个 patch 文件。启动后果标 `UNVERIFIED`（未启动验证）是恰当处置。                                                                                                        |
| R28 | §5 C5：`[W]README.md:183-188` 与 `:260` 自相矛盾（默认 scheduled vs autonomous）                                        | CORRECT（快照期内） | `[S]README.md`（03 指纹版 sha256 `568cea4c…`）`git diff` 显示旧 `:260` 原文为"当前默认仍是 `autonomous`…"；`logic`：`team-scheduler/src/index.ts:70,519`                        | 对其指纹版本判定正确；**但该漂移已于 16:56 被并发写入者修正**（现 `README.md:267` 为 P44 更正、`:265` 为 Web UI 未写；因 `:209` 起插入 7 行，03 引用的 `:255/:258/:260` 现迁移为 `:262/:265/:267`）。引用需按新 sha256 复核。 |
| R29 | §1.4："源码全文无 Remote/rpc 标识符"                                                                                    | IMPRECISE           | `[H]client-ui-agent-team/src/index.ts:3`（注释含 "Host RPC domain"）；`mount.ts:26`（"no Team RPC"）                                                                            | 实质结论（未注册 Remote 命名空间）有 README `:50` 与源码结构支持，但"无任何 rpc 标识符"字面不成立。                                                                                                                           |

### 1.4 `04-live-session-evidence.md`

| #   | 论断（摘）                                                                                                                                                                                                                                   | 判定                          | 我的证据 path:line                                                                                                                                                                         | 理由                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R30 | F1/F2/F5/F12/F13：`team/*` 的 teamId = 根会话 id；每条 team/task 为完整快照 version 2；每个队员 provisioning→active 两跳且 Lead 无 member 事件；成员 →Lead 消息以 `agent-message/relay` 落 `next-step`；正文首块 `Team message from <name>:` | CORRECT                       | **实测 check2**（独立解压 240 帧、508 事件）全部通过；源码对应 `types.ts:230-234`、`agent-team/src/index.ts:231,237-245`                                                                   | 9/9 断言通过；含"Lead 日志 0 条 team/message"交叉验证。                                                                                                         |
| R31 | F16：task-1 以 `completed` 完整快照收尾（rev+1，owner 保留），引用 `owner=8754a0c8…`                                                                                                                                                         | 事实 CORRECT / **引用 WRONG** | **实测**：`seq 363 team/task task-1 rev=3 status=completed owner=8754a0a1-1dfa-43ab-bb24-b5cf0bda90f3`（= `core-model`）；`8754a0c8` 仅出现在日志中被回显的 04 正文里                      | rev=3/owner 保留成立；owner id 前缀抄错（应为 `8754a0a1`）。                                                                                                    |
| R32 | F14：成员"本轮结束"以 inbox notice 通知 Lead；"**源码文档未专门描述**"                                                                                                                                                                       | IMPRECISE                     | 实测存在 4 条 `subagent-settled` splice（seq 313/375/449/473，`form:'notice'`）；`[H]docs/subsystems/subagent.md:189-206`；`packages/subagent/subagent/src/continuation-messages.ts:22-37` | 观测事实成立；但该机制在 subagent 子系统文档中有正式定义（`SubagentSettledMessageSource`），"源码文档未专门描述"未加限定词，应限定为"agent-team 包文档未描述"。 |

---

## 2. 未通过项修复建议（可直接采用的替代措辞）

### FIX-1（R22，02 §2.6.1 结论，WRONG）

> 把"在出厂组合下 `recover()` 是**不可达代码**（只有测试与验证脚本直接调用）"替换为：
> "本仓内缺少的是这条链的**事件生产端**：`packages/*/src` 中 `session.append` 与 `sessions.flush` **零命中**，`emitDurable` 只调用 `ctx.emit('swarm/*')`。恢复端在生产路径上**已经接好**——`team-bus/src/index.ts:119`、`team-core/src/index.ts:189`、`team-memory/src/index.ts:52`、`team-skills/src/index.ts:85` 均在 `ctx.on('session/event')` 内调用 `this.recover([ev])`（`team-completion/src/index.ts:66-75` 只监听、不 recover）——因此 `recover()` 不是不可达代码，只要宿主桥把 `swarm/*` 事件写进 Session 日志即可折叠。宿主是否存在该桥仍 `UNVERIFIED`。"

### FIX-2（R26，03 §4 ③，WRONG）

> 把 "`team/member` + `team/task` + `team/message/{queued,delivered}`" 替换为：
> "`team/member` + `team/task`（本实例实测 8 + 12 条）。`team/message/{queued,delivered}` 是**历史只读类型**，当前发送不再写入（见 01 §1.4、02 §2.6；实测该会话 0 条）。"

### FIX-3（R31，04 F16 owner id，WRONG）

> `seq 363 team/task task-1 rev=3 status=completed owner=8754a0a1-1dfa-43ab-bb24-b5cf0bda90f3`（原文 `8754a0c8…` 为笔误；正确 id = `core-model` 的 SessionId）——`completed` 是一次普通写入（rev+1），owner 字段保留。

### FIX-4（R29，03 §1.4，IMPRECISE）

> "`mount.ts` JSDoc 声明 'this registration performs no Team RPC'（`:23-26`），`src/` 中没有任何 Remote 命名空间注册或 rpc 调用（唯一出现 'RPC' 字样的是 `src/index.ts:3` 的归属注释 'Host RPC domain' 与 `mount.ts:26` 的否定声明）；包 README 亦声明 'it mounts no Remote namespace'（`:50`）。"

### FIX-5（R32，04 F14，IMPRECISE）

> "→ **agent-team 包文档未描述该通道**；机制由 subagent 子系统定义：`docs/subsystems/subagent.md:189-206` 与 `packages/subagent/subagent/src/continuation-messages.ts:22-37` 定义 `SubagentSettledMessageSource{ kind:'subagent-settled', form:'notice', summary, senderSessionId }`。因此成员结束走 inbox notice，而不是 `team/member` 事件。"

### 附：需按最新指纹复核（非错误，但引用已过期）

- 03 全部 `[W]README.md` 行号基于 sha256 `568cea4c…`（16:20）。该文件已于 **16:56** 被并发写入者修改（现 sha256 `45c39bc9…`），`:209` 起插入 7 行：`03:255/258/260` → 现 `262/265/267`，且 §5 C5 的"矛盾"已被修正。建议 03 补一句"以 568cea4c 快照为准；现工作区该漂移已消除"。

---

## 3. 专项检查

### 3.1 被引用文件路径是否真实存在

- 用 `docs/investigation/05-verify-tmp/check3-paths.mjs` 从 01–04 抽取**唯一文件路径 113 个**并逐一解析（`[H]`/`[S]`/`[W]`/`[P]` 前缀 + 工作区相对路径 + basename 后缀兜底）。
- **结果：0 个真正不存在的路径。** 108 个直接命中；其余 5 个是省略号/占位形式，全部人工复核存在：
  - `.runtime/dsh-cli-npm/…/@deepseek-ai/dsh-web-app/presets/standard.patch.yml` → 存在于 `.pnpm/@deepseek-ai+dsh-web-app@0.2.1-rc.3…/presets/standard.patch.yml`；
  - `session-4e0b08f3-….json` → `.runtime/dsh-home/storages/session_projcache/sessions/session-4e0b08f3-9cfa-43a8-bc0a-5b6debceea3f.json`；
  - `docs/adr/0002-...md` → `docs/adr/0002-durable-state-convention.md`；
  - `subagent/.../manager.ts` → 命中 2 个 `[H]` 内 `manager.ts`；
  - `$DSH_SESSION_ID/session.v4.jsonl.zstd` → 运行期环境变量占位，实际文件存在。

### 3.2 跨文档自相矛盾

- **发现 1 处实质矛盾**：03 §4 ③ 把 `team/message/{queued,delivered}` 列为落盘 durable 事件（R26），与 01 §1.4、02 §2.6、04 §1.3 及运行实测（0 条）冲突 → 已列 WRONG。
- 排除的疑似项：
  - 03 §2.4 "agentTeam seq=358、12 条 team/task" 与 04 "task-1 完成于 seq 363（第 13 条）"——**不矛盾**，是同一会话不同采样时刻（358 < 363）。
  - 04 §2 表把 quiet/wakeup 差异"留给 02/05 裁决"，而 02 已判定为零——**不矛盾**，04 显式让渡裁决权。
  - 01/02 对 `inactive`、`provisioning` 可寻址性、writeScope 语义表述互相一致。

### 3.3 `UNVERIFIED` 是否被滥用

- 逐条检查 01 §8(3 项)、02 §2.8(4 项)、03 §7(7 项)。**未发现滥用**：
  - 跨进程并发、宿主 `swarm/*` 桥、`callerOf` 是否恒有 `exec.agent`、UI 运行时截图、重复 preset 的启动后果——都需要本任务被禁止的操作（安装依赖/启动 server）或超出 [S]/[H] 范围，标记合理。
  - 01 §8-3 "failure 态 view 未缓存"**没有**滥用 UNVERIFIED：它给出了源码级事实（`projection.ts:372` vs `:373-383`），只把"是否有意"留作开放观察——处理得当。
- 唯一问题不是滥用而是**该标未标**：02 §2.6.1 的"recover() 不可达"是带 `UNVERIFIED` 语境却给出了确定性错误结论（R22）。

### 3.4 是否把模型侧工具说明当证据

- 未发现。02 §2.9 是**显式**的"模型侧描述 vs 实现"对照审计，属正当主题；`spawn_teammate`/`wait_agent` 等语义结论均另有实现行号支撑。
- 01 §6.4 仅用 `tool-agent-team/src/index.ts:41` 的 policy 文本证明"措辞与实现一致"，未用它推断行为。
- 03 §3.3 把"本会话模型侧工具目录同时含 subagent 与 spawn_teammate"显式标注为**观察**。
- 04 §2 表格明确把运行期观测与源码证据分开，且声明"冲突以源码为准"。

---

## 4. 可运行检验（无需安装依赖，产物在 `docs/investigation/05-verify-tmp/`）

### check-1 `check1-pure.mjs` — 对运行副本已构建 lib 的纯函数断言

`node docs/investigation/05-verify-tmp/check1-pure.mjs` → **11/11 通过**（输出 `check1-output.txt`）。
被测对象：`.runtime/dsh-home/profiles/dsh-swarm-demo/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/{task-graph,task-view}.js`
覆盖：task-graph 的 cycle/duplicate/missing/deleted-as-missing/合法 DAG；`taskReady` 仅认 completed；`ready = pending && taskReady`；writeScope 告警只由 in_progress 兄弟触发；路径段重叠（`src` vs `srclib` 不重叠）；`ownerName` 的 `'lead'` 映射与悬空 owner 省略。

> **该检验同时纠正了我自己的一个错误预期**：我最初假设"pending 任务的 view 不会有 writeScopeWarnings"，实测为假——过滤条件作用于**兄弟任务**而非被查看任务。这一点反过来证实 01 §3.5 与 README `:136` 的措辞（"warn on overlap with in-progress tasks"）是准确的，没有过度泛化。

### check-2 `check2-live.mjs` — 独立解析运行中会话日志与投影缓存

`node docs/investigation/05-verify-tmp/check2-live.mjs` → **9/9 通过**（输出 `check2-output.txt`）。
方法：自行按 zstd magic `28 b5 2f fd` 切帧解压 Lead 会话（`frames=240 decoded=240 events=508`），再与 `.runtime/dsh-home/storages/session_projcache/sessions/session-4e0b08f3-….json` 交叉验证。
关键实测：`team/member=8`、`team/task=17`（较 04/03 采样时刻增长）、`team/message/*=0`、`relay-splices=4`；4 名成员 id 全为纯 uuid，Lead 无 member 事件；task-1 `112:r1:pending → 167:r2:in_progress:8754a0a1… → 363:r3:completed:8754a0a1…`；投影状态的 task 快照不含 `ready/ownerName/writeScopeWarnings`（这些只在 wire view）。

### check-3 `check3-paths.mjs` — 引用路径存在性

见 §3.1。脚本退出码 1 仅因 5 个省略号/占位形式未被解析器识别，人工复核后均为存在。

---

## 5. 未核验 / 局限

1. **未跑 harness 单测**：上游 checkout 无 `node_modules`，且 `@deepseek-ai/dsh-agent-loop-testkit` 在工作区与运行 profile 中均不存在；按任务约束未安装。故 01–04 中所有"测试断言"引用是我**阅读测试源码**核对到行，而非本轮执行结果。
2. **未启动 server / 未复验 GUI**：03 的 UI 可见行为与"面板不发起 RPC"仍属源码级证据，我未做浏览器验证。
3. **未逐条重读 03 引用的全部无关行号**（如 `TeamAction.tsx:223-316` 中我抽读了 `:129-176`、`:306-316`；`plugin-manager`、`app-boot:740-823` 未逐行重读）。这些支撑的是 03 的非承重细节，未进入 §1 判定表。
4. **会话日志仍在增长**：check-2 的计数是某一时刻快照；`04` 的 seq/计数同理，比较时须按 seq 对齐而非按"总数"对齐。
5. **并发写入者**：`packages/bundle/{cordis.patch.yml,package.json,presets/swarm.patch.yml}` 与 `README.md` 在调查期间被非本小组成员修改（README 于 16:56）。`packages/bundle/cordis.patch.yml` 当前 sha256 `b3de4c7f…` 与 03 快照一致，02 的 `md5=146e6d53`（112 行）亦指同一版本；但 README 已漂移，见 §2 附注。

---

## 6. 结论

- 01/02/04 的承重论断经独立回源后**全部通过**，其中 02 对 `wait_agent` 短路方向、`quiet==wakeup`、`multicast` 不可用三处是本轮最有价值的更正。
- **02 §2.6.1 的"recover() 不可达"是唯一实质性的架构级错误**（FIX-1），需按替代措辞改写；它同时也是 01/02/03/04 中唯一被"本仓内实现者"这一强断言误导的地方。
- 03 §4 链路图混入历史事件类型（FIX-2）、04 一处 id 笔误（FIX-3），属可直接替换的文字级缺陷。
- 被引用路径 113/113 存在；未发现 UNVERIFIED 滥用；未发现把模型侧工具描述当行为证据。

---

## 7. 修复后复验（round 2）

> 任务 task-7 要求标题为「§4 修复后复验（round 2）」；本文件 §4 已是「可运行检验」，为避免重复编号，本节按文档顺序编为 §7，内容与要求一致。
> **方法**：逐项 `read` 打开被修文件核对替代措辞**是否真的落地**，并对 FIX-1 逐行回读被引代码；不采信作者自述。复验时间 2026-10-27 17:0x。

| 项 | 修复位置 | 复验判定 | 证据 path:line | 备注 |
|---|---|---|---|---|
| FIX-1 | `02-tools-and-messaging.md` §2.6.1（标题 `:248`）、§2.7 #11（`:303-305`）、§2.8（`:311-313`）、更正清单 #19（`:391`） | **RESOLVED** | `docs/investigation/02-tools-and-messaging.md:248-278`；被引代码逐行 read：`packages/team-bus/src/index.ts:118-120`（recover 在 `:119`）、`packages/team-core/src/index.ts:184-190`（`:189`）、`packages/team-memory/src/index.ts:51-53`（`:52`）、`packages/team-skills/src/index.ts:84-86`（`:85`）、`packages/team-completion/src/index.ts:66-75`（只监听、不 recover） | 替代措辞逐字落地于 `:271-278`；"生产端缺失 / 恢复端已接好"的分工与上述 5 处代码一一对应，`recover()` 不再被称为不可达；`team-completion` 的"只监听不 recover"限定准确（其 `:66-75` 监听 `team/message/*` 维护未读台账）。宿主桥仍标 `UNVERIFIED`，处置恰当。 |
| FIX-2 | `03-ui-wiring-and-docs.md` §4 ③（`:180-186`）、更正 #15（`:300`） | **RESOLVED** | `docs/investigation/03-ui-wiring-and-docs.md:180-186`；`[H]agent-team/src/journal.ts:9`（`MutableTeamEventType` 仅 `team/member`/`team/task`）、`:60`（`appendAndFlush` 泛型上界）；`[H]agent-team/src/projection.ts:292-305`（仅回放折叠）；实测 `docs/investigation/05-verify-tmp/check2-round2-output.txt` | ③ 已改为"`team/member` + `team/task`（8+12 条）；`team/message/*` 是历史只读类型，当前发送不再写入"，并补了写入侧代码依据；`journal.ts:9` 与 `:60` 我 read 复核无误。 |
| FIX-4 | `03-ui-wiring-and-docs.md` §0（`:20`）、§1.4（`:68`）、§7.2（`:268`）、更正 #16（`:301`） | **RESOLVED** | `docs/investigation/03-ui-wiring-and-docs.md:20,68,268` | 已精确化为"`src/` 中没有任何 Remote 命名空间注册或 rpc 调用；唯一出现 RPC 字样的是 `src/index.ts:3` 归属注释与 `mount.ts:26` 否定声明"。全量 grep 复核命中恰为这 2 处，与文述一致。 |
| FIX-3 | `04-live-session-evidence.md` F16（`:204-207`） | **RESOLVED** | `docs/investigation/04-live-session-evidence.md:204-207`；实测 `check2-round2-output.txt`：`task-1 … 363:r3:completed:8754a0a1-1dfa-43ab-bb24-b5cf0bda90f3` | owner 已改为正确的 `8754a0a1-…` 并注明 = `core-model` 的 SessionId；与运行日志、投影缓存交叉验证一致。 |
| FIX-5 | `04-live-session-evidence.md` F14（`:181-187`） | **RESOLVED** | `docs/investigation/04-live-session-evidence.md:181-187`；`[H]docs/subsystems/subagent.md:189-206`；`[H]packages/subagent/subagent/src/continuation-messages.ts:22-37` | 已限定为"**agent-team 包文档未描述**"，并补 subagent 子系统正式定义（`SubagentSettledMessageSource{ kind:'subagent-settled', form:'notice', summary, senderSessionId }`）；两处引用 read 确认。 |
| 附加：E15（lead 亲改） | `evidence/02-delivery-and-wait-raw.md:192-198` | **RESOLVED** | `docs/investigation/evidence/02-delivery-and-wait-raw.md:176-198`（更正段 `:192-198`） | 与 02 §2.6.1 同口径；原"没有落地桥"的绝对化表述改为"缺的是事件生产端（宿主桥）"，所列 4 个恢复端行号与我 read 的代码一致。 |
| 附加：README 快照声明 | `03-ui-wiring-and-docs.md` 文首 `:11` + §5 C5（`:229`）+ 补充核验（`:234,236`） | **RESOLVED** | `docs/investigation/03-ui-wiring-and-docs.md:11`；`README.md:262,265,267`；`sha256sum README.md` = `45c39bc9…` | 声明给出的 sha256、+7 行平移与 `:255/258/260 → :262/265/267` 与现文件**逐行核对全部正确**；"§5 C5 的矛盾在现工作区已被修掉"亦属实（`:267` 已写明"默认即 `scheduled`"）。足以避免误导。 |

**新引入矛盾检查（逐项）**：未发现新的前后矛盾。

- 02 内部：`§2.6.1` 更正结论与 `§2.6`（"生产代码不再 emit"）、`§2.7 #11`、`§2.8`、更正清单 #6/#19 口径一致。
- 03 内部：`§0 :20`、`§1.4 :68`、`§4 ③ :180-186`、`§5 C5 :229`、`§7.2 :268` 相互一致；全文已无将 `team/message/*` 描述为"落盘事件"的残留。
- 04 内部：`F14`（`:181-187`）与 §3 第 7 条（`:245`）一致；`F16` 与 §1.1 时间线（`:70`）的 owner 前缀一致。
- 跨文档：新生效的 `00-overview.md`（`:104-106` 的 K10/K11/K12、`:139-145` 的处置结论）与 05 的 R26 / FIX-1/2/4/5 口径一致，未复述已被推翻的结论。
- 可运行检验复跑（round 2）：`node docs/investigation/05-verify-tmp/check2-live.mjs` → **9/9 通过**（`check2-round2-output.txt`，会话已增长到 348 帧 / 709 事件 / `team/task=27`），`team/message/*` 仍为 **0**、relay-splice=7。`00-overview.md:148` 记的"240 帧 / 508 事件"是 **round-1** 计数，非矛盾，但引用时宜注明轮次。

**一句总结论**：FIX-1…FIX-5 加 lead 亲改的 E15、03 的 README 快照声明共 **7 项全部 RESOLVED**；替代措辞真实落地、语义与代码一致，未引入新的前后矛盾，唯一遗留的 `UNVERIFIED`（宿主桥存在性）属正当未决项。

**附注（非本任务项）**：17:00 左右工作区执行过一次格式化（`prettier`），本文件与 `01-core-model.md` 等的 Markdown 表格被重排、行号整体平移但**语义未变**；我抽查了 01 中与 R1–R14 相关的段落（`:47,49,105,106,197`），文字与 16:44 版一致。
