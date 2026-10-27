# 00 · DSH Team 模式总览（调查结论）

> **调查小组**：`lead`（协调 + 运行期活证据）、`core-model`（核心模型）、`tools-messaging`（工具面/消息）、
> `wiring-ui`（UI/启用接线）、`auditor`（对抗式独立核验）。
> **证据分三层**：① 源码（`[H]` = `.runtime/deepseek-harness`，上游 0.2.1-rc.3；`[S]` = 本仓 `packages/`）、
> ② 运行期（正在跑的这次 team 会话的日志与 projection 缓存）、③ 独立核验
> （[05-verification.md](05-verification.md)：28 条承重论断，23 CORRECT / 3 WRONG / 2 IMPRECISE，
> 全部未通过项已修复）。
> 阅读顺序见 [docs/investigation/README.md](README.md)。

---

## 1. 一页 TL;DR

1. **Team 不是一个被创建的对象，而是一个根会话的视图。** 没有 `create_team`；根 Session 即 Lead，
   `TeamId` 就是根 SessionId（[01-core-model.md §1.1](01-core-model.md)；
   运行期实测 `team/task.data.teamId` = 根会话 id，[04-live-session-evidence.md F1](04-live-session-evidence.md)）。
2. **三大支柱**：**roster**（成员注册与生命周期）、**task board**（共享任务板，revision CAS + `blockedBy` 依赖）、
   **messaging**（向目标 Agent 的 inbox steer）。
3. **成员是独立 Session**（in-process、`continuable` 子代理），有自己的会话日志；而**团队状态集中落在根会话**——
   成员日志里没有任何 `team/*` 事件（[04 F7/F9](04-live-session-evidence.md)）。
4. **durable 状态只有 `provisioning → active | failed`**；模型侧看到的 `running / inactive` 是**派生的**，
   不写回记录（[01 §1.2/§2.2](01-core-model.md)）。
5. **工具面是两层的并集**：harness 基础层 9 个 + 本仓产品层 10 个，交集为 ∅；
   出厂 bundle 下模型实际可见 **12 个**（[02 §2.10](02-tools-and-messaging.md)）。
6. **最值得注意的语义缺口**（描述与实现不符，均为实测/源码确认）：
   `delivery: quiet|wakeup` **完全无差异**（永远唤醒）；`multicast` 按 **UUID** 寻址而模型只有 **name** →
   **模型侧不可用**；`review_submit` 声称「blocks direct completion」**不成立**；
   `writeScope` 只是**建议性**警告，且只与 `in_progress` 的兄弟任务比较。
7. **Web 面板是上游原生能力**，dsh-swarm 没有自己的 UI；本仓叠加的 `in_review`/`planned` 等状态
   **永远不会出现在原生面板**（[03 §6](03-ui-wiring-and-docs.md)）。

---

## 2. 两代码根心智模型

| 关注点 | 归属 | 位置 / 开关 |
| --- | --- | --- |
| 团队域服务（roster / inbox / 任务 DAG / 子代理生命周期） | **native** | `[H] packages/experimental/agent-team` |
| durable `team/*` 事件 + `agentTeam` 会话投影 | **native** | `[H] …/agent-team/src/{index,projection}.ts`（`:99` 注册、`:386-394` wire） |
| 模型侧团队工具（9 个） | **native** | `[H] packages/experimental/tool-agent-team` |
| Web roster / 任务板 / 成员导航 | **native** | `[H] packages/experimental/client-ui-agent-team` |
| 一键启用 + 关闭 legacy 委派 | **native** | `[H] packages/experimental/agent-team-profile`（`OPTIONAL_BUNDLES`，默认关闭） |
| 端口类型 SSOT（`TeamCore` / 六态 `TaskView`） | **dsh-swarm** | `[S] packages/team-core-contract` |
| native seam 适配（不 import 实验包类型） | **dsh-swarm** | `[S] packages/team-core/src/index.ts` |
| 消息总线 / 评审闸 / 调度 / 完成判定 / 人类席位 | **dsh-swarm** | `[S] packages/team-{bus,review,scheduler,completion,human,memory,skills,workspace,transport,durable,compaction,prompt,distributed,scale-contract}` |
| 模型侧产品工具（10 个，唯一注册方） | **dsh-swarm** | `[S] packages/tool-swarm`（`enableBroadcast` 默认 **true**，`enableReview/Workspace/Skills/Memory` 默认 **false**） |

**边界铁律**：任何「任务状态」的说法都必须标注视角——**native 视角**只有
`pending|in_progress|completed`（`deleted` 被过滤），**dsh-swarm 端口视角**才有
`in_review`/`planned`（只在 `[S] team-core` 读侧 overlay，[03 §6](03-ui-wiring-and-docs.md)）。

---

## 3. 一次 team 会话的完整生命周期（实测复合）

```
Lead 会话启动（agentPreset=swarm，团队域随 bundle 装配）
   │
   ├─ ① 建板：team_task_create ×N        → 每条 team/task 事件 = 完整快照 rev=1 status=pending owner 缺省
   │      team_task_update(set_dependencies) → rev=2 写入 blockedBy（DAG；ready 由 view 计算，不落盘）
   │
   ├─ ② 招人：spawn_teammate              → 子 Session 创建，delegationDepth=1，继承 preset
   │      team/member: provisioning → active（实测间隔 150–200ms，成对出现）
   │      成员初始 prompt 经 agent/inbox/spliced(next-turn, source.kind=user) 注入
   │
   ├─ ③ 派活：成员 claim                  → rev+1，status=in_progress，ownerId=其 SessionId
   │      （Lead 也可 claim，ownerId=根 SessionId；ownerName='lead'）
   │
   ├─ ④ 通信：send_message / broadcast    → 目标 inbox 的 next-step splice
   │      source={kind:'agent-message', form:'relay'}，正文前缀 "Team message from <name>:"
   │      · 目标 running：最近 step 边界收到，不打断当前 step
   │      · 目标 inactive：coldResume（要求 descriptor=continuable）后投递并唤醒
   │      · 目标 provisioning/failed：直接拒绝（TEAM_MEMBER_NOT_FOUND）
   │      · quiet 与 wakeup 当前行为相同（永远唤醒）——见 §5
   │
   ├─ ⑤ 观测：wait_agent                  → 无活跃 peer 立即返回 noProgress；
   │      有活跃 peer 则注册 waiter，等 roster/message/task 变更（不看 turn 内进度）
   │
   ├─ ⑥ 干预：interrupt_agent（Lead-only）→ 打断某成员当前 turn，保留其 inbox
   │
   └─ ⑦ 收口：成员一轮结束 → subagent-settled inbox notice（不是 team/member 事件）
          team_task_update(complete) → rev+1 status=completed，owner 保留
```

上述每一步都有运行期落盘证据（[04-live-session-evidence.md](04-live-session-evidence.md)），
源码侧的完整状态机与转移表见 [01 §2–§3](01-core-model.md)。

---

## 4. 关键结论清单（逐条指向来源）

| # | 结论 | 来源 |
| --- | --- | --- |
| K1 | TeamId = 根 SessionId；Lead 不出现于 roster/projection members | [01 §1.1–1.2](01-core-model.md)、[04 F1/F5](04-live-session-evidence.md) |
| K2 | durable phase 仅 3 值；`inactive` 是派生状态，含义是「没有 turn 在执行」 | [01 §1.2/§2.3](01-core-model.md) |
| K3 | 无成员删除/回收 API；`failed` 占 `maxMembers` 名额，名字永不复用 | [01 §8-2](01-core-model.md) |
| K4 | 任务 id `task-<n>`；任何写入 rev+1；CAS 顺序 = 存在 → revision → deleted | [01 §3.2–3.3](01-core-model.md) |
| K5 | `ready`/`ownerName`/`writeScopeWarnings` 只在 **view** 层，不落 durable 快照 | [01 §1.3](01-core-model.md)、[04 F10](04-live-session-evidence.md) |
| K6 | `writeScopes` 是**建议性**的：仅与其他 `in_progress` 任务比较后告警，**不阻塞** | [01 §3.5](01-core-model.md)、[05 R21](05-verification.md) |
| K7 | `task-graph` 只保证「阻塞者存在且非 deleted、无重复、无环」，不保证可调度/可行性 | [01 §4/§7-14](01-core-model.md) |
| K8 | Lead-only 约束全在**服务端**：`spawn`/`interrupt`/`reassign`；工具 schema 不做 action 级角色过滤 | [01 §8-1](01-core-model.md) |
| K9 | 工具面并集 19、交集 ∅、出厂可见 12；11 条描述-实现出入 | [02 §2.9/§2.10](02-tools-and-messaging.md) |
| K10 | `team/message/{queued,delivered}` 是**历史只读类型**，当前发送不再写入（实测 0 条） | [01 §1.4](01-core-model.md)、[05 R26](05-verification.md) |
| K11 | `swarm/*` durable 链：**恢复端已接好，缺的是事件生产端（宿主桥）** | [02 §2.6.1](02-tools-and-messaging.md)、[05 FIX-1](05-verification.md) |
| K12 | 面板数据源 = 根会话的 `agentTeam` **wire 投影**；UI 层零 RPC、零状态 | [03 §1](03-ui-wiring-and-docs.md) |
| K13 | dsh-swarm 叠加态在原生面板**不可见**（4 态闭集） | [03 §6](03-ui-wiring-and-docs.md) |
| K14 | 本实例装配：`base → web-app → agent-team-profile → @elinpf/dsh-swarm-bundle → inspector-profile`，212 条有效 entry | [03 §2](03-ui-wiring-and-docs.md) |

---

## 5. 已知缺口、竞态与开放问题

**设计性缺口（源码可证）**

- `delivery: quiet|wakeup` 参数被产品层接收但**从不使用**，`quiet` 与 `wakeup` 行为完全相同（[02 §2.3](02-tools-and-messaging.md)）。
- `multicast` 按 `listMembers().id`（UUID）匹配，模型侧只有 `name` → 实测 `TEAMBUS_UNKNOWN_TARGET`，**工具不可用**（[02 §2.9 B](02-tools-and-messaging.md)）。
- `fanout:'record-only'` 声称「成员按需拉取」，但**没有任何模型工具暴露 `TeamBus.history`**（[02 §2.9 D](02-tools-and-messaging.md)）。
- `review_submit` 在无评审池时**直接完成**任务；`in_review` 期间 `complete` 未被阻止（[02 §2.9 C](02-tools-and-messaging.md)）。
- `review_vote` 的 `role`/`value` 无校验；bundle 评审池只有 `[verifier, challenger]`，`inspector` 票**永不计票**（[02 §2.9 E](02-tools-and-messaging.md)）。
- 产品层工具参数**无 `enum`**，非法值被静默接受（对比 harness 用 `enum`）（[02 §2.9 F](02-tools-and-messaging.md)）。
- 阶段 2 能力（`workspace_*`/`skills_visible`/`memory_recall`）在出厂 bundle 中**未启用**（[02 §2.7](02-tools-and-messaging.md)）。

**仍开放（UNVERIFIED）**

- **跨进程并发**：CAS + `TeamJournal.transact` 只保证单进程内串行；多进程同写同一 Lead 会话的语义无描述（[01 §8](01-core-model.md)）。
- **宿主 durable 桥是否存在**：本仓缺事件生产端；宿主侧是否有桥未证实（[02 §2.6.1](02-tools-and-messaging.md)）。
- **`ownerId` 悬空时的 `ownerName` 静默省略**：源码未声明这是合法状态还是退化输入（[01 §8](01-core-model.md)）。
- **无运行时 UI 截图/抓包**：面板行为结论来自源码 + README + projection 缓存（[03 §7](03-ui-wiring-and-docs.md)）。

---

## 6. 独立核验结论与处置

[05-verification.md](05-verification.md) 从 01–04 抽取 **28 条承重论断**独立回源，
结果 **CORRECT 23 / WRONG 3 / IMPRECISE 2 / UNSUPPORTED 0**；引用文件路径 **113/113 存在**。
未通过 5 项**全部采纳并已修复**：

| 项 | 判定 | 处置 |
| --- | --- | --- |
| 02 §2.6.1「`recover()` 不可达」 | WRONG（架构级） | 已按 [FIX-1](05-verification.md) 改为「缺事件生产端，恢复端已接好」，并同步 `evidence/02-delivery-and-wait-raw.md` E15 |
| 03 §4 ③ 把 `team/message/*` 列为落盘事件 | WRONG | 已按 [FIX-2](05-verification.md) 标注为历史只读类型 |
| 04 F16 owner id 笔误 | WRONG | 已改为 `8754a0a1-…`（`core-model`） |
| 03 §1.4「src 全文无 rpc 标识符」 | IMPRECISE | 已按 [FIX-4](05-verification.md) 精确化 |
| 04 F14「源码文档未专门描述 subagent-settled」 | IMPRECISE | 已按 [FIX-5](05-verification.md) 限定为「agent-team 包文档未描述」 |

**修复后复验（round 2，`auditor` 独立执行）**：上述 5 项 + 我（lead）亲改的证据附件 E15、03 的 README 快照声明，
共 **7 项全部 RESOLVED**，未引入新的前后矛盾（判定表见 [05-verification.md §7](05-verification.md)）。

**可运行检验**（`auditor` 独立执行）：`check1-pure.mjs` 对运行副本已构建 lib 的纯函数断言 **11/11 通过**；
`check2-live.mjs` 独立解压 Lead 会话 + projection 交叉验证 **9/9 通过**
（`team/message/*` = 0、relay splice = 4、task-1 `112:r1 → 167:r2 → 363:r3`）。
其中会话规模为 round 1 采样 240 帧 / 508 事件，round 2 复跑为 348 帧 / 709 事件，结论不变。
harness 自带 vitest **无法实跑**（其开发依赖 `@deepseek-ai/dsh-agent-loop-testkit` 未安装），
因此 01 中引用测试的结论均标注为「读测试断言」而非「本轮实跑」。

---

## 7. 快速上手：怎么启用 team 模式

1. **上游一刀切换**：插件管理页开启 `@deepseek-ai/dsh-experimental-agent-team-profile`
   （白名单 `OPTIONAL_BUNDLES`，默认关闭）→ 该 bundle 一次 disabled 4 个 legacy 委派行，
   并 insert `agent-team`（`maxMembers:8 / maxTasks:256 / maxMessageBytes:65536`）+
   `tool-agent-team` + `ui-agent-team`（[03 §3](03-ui-wiring-and-docs.md)）。
2. **本仓叠加**：`[S] packages/bundle` 在其上再 insert 14 行 dsh-swarm 包并提供 `preset-swarm` 预设；
   本实例 profile 为 `dsh-swarm-demo`（`bundle→base→web-app→agent-team-profile→@elinpf/dsh-swarm-bundle→inspector-profile`）。
3. **验证已生效**：根会话事件里有 `agentPreset:"swarm"`、`team/member`、`team/task`；
   `projection 缓存` 的 `agentTeam` 行有成员与任务 → 面板（会话头部 slot）即可见。
   复现命令见 [04 §0](04-live-session-evidence.md)。

---

## 8. 现场风险（须另行处置，非本次调查结论）

1. **存在另一个并发写入者**：`packages/bundle/{cordis.patch.yml,package.json}` 于 16:36–16:39 被修改、
   新增 `packages/bundle/presets/swarm.patch.yml`，`README.md` 于 16:56 被修改。**本调查小组全程只读源码**，
   `git status` 中我们的产出仅为新增 `docs/investigation/`（详见 [03 §2.5](03-ui-wiring-and-docs.md)）。
2. **工作区里还有另一轮同名调查的产物（非本小组）**：`docs/dsh-team-mode-investigation.md`（16:54，
   其成员名为 `arch-core` / `bus-messaging` / `ui-wiring`，引用的分节在 `docs/investigation/dsh-team-mode/`）。
   那是**另一个并行/上一轮的小组**，与本轮 `docs/investigation/00–05` 相互独立、成员与判定集都不同。
   本节结论只对本小组的 00–05 负责；若两份报告冲突，请以各自引用的 `path:line` 与快照 sha256 复核。
3. **重复 `preset-swarm` 风险**：上述并发改动使有效 entry 出现两条同 id `preset-swarm`
   （`03-composed-entries.txt:223,226`）；patch 层不去重，**下次启动的后果未验证**
   （[03 §7-4](03-ui-wiring-and-docs.md)）。建议由该文件的 owner 收敛为一份后再启动验证。
4. 若上述变化影响结论，请以各自文件的 sha256 快照为准（[03-file-fingerprints.txt](evidence/03-file-fingerprints.txt)）。
