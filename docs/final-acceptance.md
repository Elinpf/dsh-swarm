# dsh-swarm 最终验收报告（**终版**：能力覆盖矩阵 + 可信度分级 + 使用指南）

> 产出人：report-synthesizer（调研报告汇总员） ｜ 任务：**P21-final-acceptance（首版）→ P37-final-revision（终版）** ｜ 时间：2026-10-27
> 定位：**面向交付/接手者**的验收件，回答一个问题——「JiuwenSwarm 的六项精髓能力，到底还剩哪些没落地、可信度多高、别人怎么用」。

> **【P52 更正 · 2026-10-27】durable 落盘通道的真实性**：经 P50 独立核实，本约定此前**只 `ctx.emit` 进程内广播、从未 append 到会话日志**
> （182 份真实会话日志中 `swarm/*` 0 条）⇒ **「可跨重启恢复」当时并不成立**（P23 的恢复验证是**模拟**：内存捕获 + 手动 recover）。
> 已由 **P52** 修为真持久：统一入口 `@elinpf/dsh-swarm-team-durable.emitDurable(session, name, payload)`
> → **`appendPluginRecord("plugin:swarm/…")`**（通道 A），并在 `@deepseek-ai/dsh-session` 落地 plugin record；
> `durableRecordOf(ev)` 供 replay fold。证据与逐类判定见 `docs/durability-findings.md`。
> 下文若与「已修复」相关表述冲突，**以本条为准**（历史叙述：曾为 emit-only 不可恢复 → P52 修为真持久）。
> 证据分级：**【session 级 已验证】**（真实 `dsh-session` 真落盘 + 新 Context 重挂载重读仍可取回，O2 GREEN③）；**【profile 级 端到端 未验】**（无可达的 swarm emit 触发点，未做；待 P49 后 tool-swarm 可用时顺带补，或走免模型路径）。未接完：`team-bus` 待 analyst P47 push 后 rebase 复核；`team-skills.visibility`（`declare` 无 agent）仅进程内 emit。

> 素材边界：**只整合 `dsh-swarm/docs/` 下已落盘产物 + 仓库实际状态**，不新增未经证据支持的结论。
> 证据强度标记：**【已验证】**＝**真实 profile 下、真实栈、端到端**（或真实 OS 进程级）实测；**【单测级】**＝vitest 行为单测 / **进程内**集成冒烟（含端口 mock / 记录型 seam）；**【未验证】**＝仅有设计、推断或真实 profile 缺入口。
>
> 素材代号：`[R]`=README.md｜`[PL]`=package-layout.md｜`[V]`=verification.md｜`[PE]`=profile-e2e.md｜`[PE3]`=profile-e2e-stage3.md｜`[OL]`=optimization-log.md｜`[BM]`=benchmark.md｜`[EX1]`=experiments-stage1.md｜`[EXW]`=experiments-idle-wakeup.md｜`[EXR]`=experiments-retest-p24.md｜`[SP]`=agent-team-spike.md｜`[JS]`=jsfw-comparison-fixture.md｜`[PUB]`=publishing.md｜`[ENV]`=env-setup.md｜`[EA]`=event-alignment.md｜`[SD]`=state-durability.md｜`[CPC]`=cross-package-consistency.md｜`[P31]`=p31-unblock-push-design.md｜`[ADR1]`/`[ADR2]`。

---

## 本报告的时点与「终版相对首版变了什么」（必读）

> **本报告是 P21 首版（时点快照版，锚 `5e6ab63`）的终版修订。** 首版的价值在于「在途中就暴露了『文档声称 vs 仓库实际』的四类偏差」；那一批依赖（P31/P33/P34/P19b/P35）现已**全部落地**，故本终版做**逐项重判**。

| 项 | 首版 | **终版（本报告）** |
|---|---|---|
| 报告时点 | `5e6ab63`（P31 在飞） | **`2031d44`**（P19b「默认派发改 scheduled」已落地） |
| 在飞任务 | P31/P33/P34/P19b「进行中/未验证」 | **全部完成**：P31（解锁推送+可观测事件）、P33/P39/P43（三臂重测+归属复核）、P34（mock 加固）、P19b（默认 scheduled）、P35（文档同步）、P38b（scheduler 自 arming）、P40（跨包一致性）、P41（ADR-0002 §3 同步）、P42（派发归属修复） |
| 包数 | 19 | 19（不变；首版已正确） |
| 默认派发模式 | 仍 `autonomous`（P19 cancelled） | **`scheduled`（P19b 已落地，破坏性变更）** |
| 手册偏差记录 §7 | A/B/C/D 四类 8 条 | **保留历史**，B 类（S1–S5/S8）标注「已于 P35 同步」，C 类（S7）标注「已于 P19b 落地」；**新增 1 条**（README 残留「默认仍 autonomous」段，见 §7 S9） |
| **跨进程分级** | 合并为 1 个【已验证】 | **拆为两层**（精度校正，见 §1.4/§2） |
| 若干分级 | 偏宽 | **按「宁降不升」校正**（见 §2.5 变更日志） |

**终版证据强度原则**：**【已验证】以「真实 profile 下、完整栈、端到端」为准**；达不得的降【单测级】或加显式限定词。

---

## 0. 一句话结论 + 关键结论速览

### 0.1 一句话结论（终版）

**JiuwenSwarm 的六项精髓能力在 DSH 上「全部有插件载体」：其中 3 项达【已验证】（广播群聊、任务自动派发、人类席位——真实 profile 或真实进程级），跨进程能力**必须拆成两层**（**传输层 + 对端运行时消费 = 【已验证】；两套完整 dsh 团队栈互通 = 【未验证】**），验证闸与 worktree 为【单测级】且各有真实-profile 受限面；发布前唯一硬性人工步骤是**在 GitHub 配置 `NPM_TOKEN`**；最大的系统风险仍是**对实验性 `ctx.agentTeams` 的依赖**，其次是**文档在 P19b 后残留一处自相矛盾**（见 §7 S9）。**

### 0.2 关键结论速览

| 项 | 结论 | 证据 |
|---|---|---|
| 交付形态 | npm monorepo，**19 个可发布协作包**（`packages/` 共 20 目录，含不发布的 `example-plugin`），锁定 DSH `0.2.1-rc.3` | `packages/` 实测（20 项）；`[CPC] §1–§2`（`pnpm -r publish --dry-run` → 19）；`[R]`、`[PL]`（均已同步为 19） |
| 六项能力载体 | 广播群聊=`team-bus`；自动派发=`team-scheduler`；验证闸=`team-review`+`team-core(in_review)`；跨进程=`team-transport`/`team-distributed`；worktree+锁=`team-workspace`；人类席位=`team-human` | `[PL]`、`[V]` |
| 额外交付 | 计划闸（执行前审批，opt-in）、返工反馈定向回流、团队提示词/技能/记忆/压缩、内存态持久化（`team-durable`+ADR-0002）、解锁主动推送与可观测事件（P31） | `[V]` P30/P31/P23；`[ADR2]` |
| **默认派发模式** | **`scheduled`（调度派发）**——P19b 落地，**破坏性默认变更**；`autonomous` 仍可显式切换 | `packages/team-scheduler/src/index.ts`（默认 `scheduled`）、`bundle/cordis.patch.yml`（`mode: scheduled`）、`[V]` P19b |
| 发布门禁 | `build / test / verify / verify:e2e`（+ `verify:wiring`/`verify:durability`/`verify:xproc` 诊断）全绿；npm 流水线「tag 驱动 + 三门禁先于发布」 | `[V]`、`[PUB]` |
| 唯一人工发布步骤 | 在 npmjs.com 建 Automation token 并存为 GitHub Secret `NPM_TOKEN` | `[PUB]` §2 |
| 证据强度分布 | 【已验证】3 类（+跨进程第 1 层）、【单测级】多项、【未验证】若干（见 §2） | 本报告 §2 |
| 最高价值发现（§7） | **A 类（能力偏差）S0**：早期 T1/T4 称「双闸门已实现」实为只有 IN_REVIEW；**B 类（文档滞后）S1–S5/S8 已由 P35 同步**；**C 类 S7 已由 P19b 落地**；**新增 S9**：README 残留「默认仍 autonomous」段与 P19b 自相矛盾 | §7 |

---

## 1. 能力覆盖矩阵（六项精髓能力 × 当前实现）

> 口径：**已落地**=有插件实现且有可复现验证；**部分落地**=主功能在、但存在未触发的真实路径或受限面；**未落地**=无实现。
> 证据强度：**【已验证】**=真实 profile / 真实 OS 进程级**端到端**；**【单测级】**=vitest 行为单测 / **进程内**集成冒烟（含端口 mock / 记录型 seam）；**【未验证】**=仅设计/推断，或真实 profile 缺入口。

### 1.1 能力 1 — 广播群聊（broadcast / 多播 / topic 扇出）

| 项 | 内容 |
|---|---|
| 判定 | ✅ **已落地** |
| 载体 | `@elinpf/dsh-swarm-team-bus`（`ctx.teamBus`）+ 工具 `@elinpf/dsh-swarm-tool-swarm`（`broadcast`/`multicast`）+ `team-prompt`（topic 语义） |
| 能力面 | `broadcast`（1 落库 + 逐人 DM 扇出，自过滤发送者）、`multicast`（N 条原子写）、topic 订阅 `subscribe/notifySubscribers`、`history()` 拉取、`fanout:'dm'|'record-only'`（opt-in）、`delivery:'quiet'`（opt-in） |
| 证据（包/文件） | `packages/team-bus/src/index.ts`；`packages/tool-swarm/src/index.ts` |
| 证据（验证位置） | **真实 profile 长驻观测**：`[EXW] §7`（P24 三臂 broadcast / n_dm / record-only）、`[EXW] §9`/`[V]` P27（`dm_one`：真实 profile 下 DM 只唤醒收件人，两次独立取数一致）；单测 `[V]` P16（team-bus 11~14 例）；`pnpm verify:e2e`（阶段1「成员→广播（自过滤）」） |
| 证据强度 | **【已验证】（真实 profile）**——扇出与唤醒语义**在 P22 修复原生接通后**于真实 headless profile + 真实模型的长驻实验下取得 |
| 真机工具面 | profile-e2e 中模型自报工具含 `broadcast`/`multicast`（`[PE]` §3） |
| ⚠️ 遗留（非缺陷） | 写放大：源系统广播 **O(1)** 写 vs 我方 **O(N)**（1 落库 + 逐人 DM）；唤醒语义与源一致（`[EXW] §9.2`、`[R]`）。`record-only`/`quiet` 为 **opt-in**（静默广播无法触发协同动作，故不作默认） |

### 1.2 能力 2 — 任务自动派发（scheduler / 幂等扫描）

| 项 | 内容 |
|---|---|
| 判定 | ✅ **已落地**（**默认 `scheduled`**；`autonomous` 仍可切换） |
| 载体 | `@elinpf/dsh-swarm-team-scheduler`（`ctx.teamScheduler`）+ `team-core`（任务状态） |
| 能力面 | 幂等扫描 `reconcileStarts`/`reconcileReviews`；`scheduled`=唯一 dispatcher 直接派发（经端口 `assign`→原生 `reassign`，owner 落到成员）；`autonomous`=nudge 空闲成员自取；`stale` 自催→升级；`review_stall` 超时升级；失败自动降级为 autonomous；**LEADER 就绪自 arming（P38b）**；**解锁主动推送（P31）** |
| 证据 | `packages/team-scheduler/src/index.ts`（`SchedulerMode` 默认 `scheduled`、`DEGRADE_AFTER_FAILURES`、`pollMs`、自 arming）；`[V]` P18/P30/P31/P38b/P42/P19b |
| 证据（验证位置） | **真实 profile 三臂实测**：`[EXR] §1.2/§1.3`（P39 arming 后 + P43/P42 归属复核）——`scheduled` **真派发**（`pending→in_progress`、`ownerName`=被派发成员 `alice`/`bob`），teammate 开销 **4 轮/119.7k token** vs `autonomous` **12 轮/206.1k（≈2.4×）**；确定性单测（team-scheduler 15 条）；桩 bench `[EX1] §2 AB2/§3 Ab2` |
| 证据强度 | **【已验证】（真实 profile，派发动作端到端）**——P39（arming 后真派发）+ P43（P42 后 owner 归属收口【成立】） |
| ⚠️ 边界 | `scheduled` 的 `assign` 派发属 **P42 修复后**成立；`autonomous` 只 nudge 不派发（成员被 nudge 后自 claim）；降级路径（连续失败→autonomous）经单测覆盖 |

> **首版→终版变更**：首版因 P19 被取消、默认仍 autonomous、仅【单测级】+桩；本终版 P19b 落地默认 scheduled，且 P39/P43 真实 profile 数据支撑 → **升级为【已验证】并修正默认值描述**。

### 1.3 能力 3 — 验证闸（in_review / verify / 裁决）

| 项 | 内容 |
|---|---|
| 判定 | ✅ **已落地**（功能完整），**真实 profile 端到端为部分/受限** |
| 载体 | `@elinpf/dsh-swarm-team-review`（`ctx.teamReview`）+ `team-core`（`in_review` 叠加态）+ `tool-swarm`（`review_submit`/`review_vote`） |
| 能力面 | 提交评审进 `in_review`；二元池一票否决 / 打分池阈值 / UNDECIDED；`maxRounds`/`stallTimeoutMs` 升级；**不可自验**、后写覆盖；`fail` 返工回 `in_progress`（P30 起带 feedback 定向回流作者） |
| 证据 | `packages/team-review/src/index.ts`；`packages/team-core/src/index.ts`（`reviewing`、`overlay()`）；`[V]` P18 §A–C、P30 §A |
| 证据（验证位置） | **真实 profile**：`review_submit` → 任务进 `in_review` **真实可达**（`[EXR] §2.2` 原文）；但 **`settle()` 无调用入口**（`tool-swarm` 只暴露 `review_submit`/`review_vote`），**裁决无法触发**；且 lead 认领导致自验被拒 → **端到端结算不可判定**。单测：review 14 例、core 22 例；`pnpm verify:e2e`（「提交评审→in_review→不判完成→pass→completed」，端口 mock） |
| 证据强度 | **【单测级】（端口 mock 集成冒烟）**；真实 profile 下 **`in_review` 入闸可达，但 `settle` 端到端【未验证·前置缺失】** |
| ⚠️ 已知限制 | ①`in_review` 是 `team-core` 的**叠加态**，原生 `team_task_*` 读侧看不到（`[V]` P18 §E）；②**`settle` 真实 profile 无触发入口**（`[EXR] §2.2`，解锁条件=暴露 `settle`/auto-settle + 构造「作者=成员」链路）；③持久化已由 ADR-0002 修复（见 §4/§2） |

> **首版→终版变更**：首版已标【单测级】；本终版**追加真实 profile 的精确结论**——入闸真可达、结算前置缺失（P33/P39 重测）。

### 1.4 能力 4 — 跨进程分布式（transport / distributed / 不丢不重）★精度校正

> **首版把本能力合并为一个【已验证】，给宽了。终版按「宁降不升」拆为两层。**

| 层 | 判定 | 证据强度 | 证据 |
|---|---|---|---|
| **4a. 传输层 + 对端运行时消费** | ✅ **已落地** | **【已验证】**（真实 OS 进程级，含真 SIGKILL） | `[PE3] §3/§4`（真实 `ctx.subprocess` spawn 真实子进程 + **真杀进程** + 重连重放；**两个不同 pid** 的进程 + journal 原子落盘 + `recover`）；`[V]` §I（P25 真实子进程）、§K.3（**A 进程→B 进程运行时真实消费**）、§L.3（**两个独立启动进程经 `local-listen` 自动互连**）；一键 `scripts/e2e-stage3.sh` → `PASS=4`；`pnpm verify:xproc` |
| **4b. 两套完整 dsh 团队栈互通（各自跑完整 bundle 协作）** | ❌ **未落地/未验证** | **【未验证】** | P20 明确登记「**完整 dsh peer 作对端**」当时不行；P29 补 `attachTransport` 后验证的**对端是 `peer-daemon.mjs` 探针进程**（非完整 dsh 栈）；P32 `local-listen` 对端同样是探针进程。⇒「leader 与远端成员**各跑整套 bundle**」的**对称完整栈**链路**未验证**（`[PE3] §6.2`、`[V]` §K.5/§L.4） |

| 项 | 内容 |
|---|---|
| 载体 | `@elinpf/dsh-swarm-team-transport`（`ctx.teamTransport`）、`team-distributed`（`ctx.teamDistributed`）、`team-scale-contract`（纯类型契约） |
| 能力面（4a 层） | 4 后端：`loopback` / `local-child`（真实子进程）/ `local-listen`（监听+端点注册发现+租约/GC+握手令牌）/ `ssh-rpc`；断线重连状态机、ack 超时重发、有界队列（丢最旧）、`epoch` 复位、journal 原子落盘 + `recover()`、对端入站 attach、V1–V4「不丢不重」 |
| ⚠️ 受限 | **跨机**仍走 `ssh-rpc`：**机制**已在真实 SSH 通道验证（`[V]` §J.2），但 **`dsh-ssh` 本体未接通**（需远端 helper 归档部署）；`ctx.subagents` out-of-process 成员执行**包可装可加载、执行未验证**（`[V]` §J.3）；`local-child` 重连=重生子进程（对端重启后 seq/历史丢失，at-least-once 可能重复投递一次，由应用层 `messageId` 幂等兜底） |
| ⚠️ 安全边界 | `local-listen` 的握手令牌是**「防误连」而非「安全鉴权」**（明文经本机 unix socket；同用户不构成安全边界）；socket 权限只隔离不同用户（`[V]` §N.3） |

### 1.5 能力 5 — worktree + 文件锁

| 项 | 内容 |
|---|---|
| 判定 | 🟡 **部分落地**——**文件锁=已落地（单测级）；worktree=复用 `ctx.worktrees` 的未触发 seam** |
| 载体 | `@elinpf/dsh-swarm-team-workspace`（`ctx.teamWorkspace`）+ `tool-swarm`（`workspace_lock/unlock/worktree`） |
| **哪部分在/不在** | **在**：写域锁（互斥 + TTL）、`fs/write-intent`/`fs/edit-intent` 写域守卫（拒绝=`throw`，允许=`next()`）——经单测（7 例）+ `pnpm verify:e2e`（「写域锁互斥」）。**不在**：真实 **worktree 创建**（`ctx.worktrees`）**未在真实 profile 触发**（`[V]` §G「仅以可选 seam 接入」）。 |
| 证据 | `packages/team-workspace/src/index.ts`（`:80` `locks`、`:81` `worktrees`、`:115-116` 订阅 intent）；`[V]` P7 §F.1（`fs/write-intent` 拒绝语义实测） |
| 证据强度 | **【单测级】**（锁语义 + 写域守卫；端口 mock e2e）；worktree 真实路径【未验证】 |
| 说明 | 源系统是「跨进程 leader 中介锁 / git 版本化工作区」；我方为**本地 fs-guard 锁**（单进程足够）。跨进程锁归阶段 3（`[EA]` #30） |

### 1.6 能力 6 — 人类成员席位

| 项 | 内容 |
|---|---|
| 判定 | ✅ **已落地**（**桥接面 + 路由 + 阻塞/离线语义**），**真实 UI / answerer 未写** |
| 载体 | `@elinpf/dsh-swarm-team-human`（`ctx.teamHuman`） |
| 能力面 | HITT 路由解析（`@name`→DM、`@all`→广播、`#...`→Lead、`$name`→另一化身、纯文本→Lead）、`addSeat`（仅 Lead）、`ask()` 阻塞→输入→继续、离线保留→上线补投 |
| 证据 | `packages/team-human/src/index.ts`；`[PE3]` §5；`[V]` §H |
| 证据（验证位置） | **真实跨进程**：`scripts/team-human-xproc.mjs`（「人类输入」来自**真实独立子进程**；`[PE3]` §5 原始输出）；单测 9 例 |
| 证据强度 | **【已验证】（桥接/路由/阻塞语义，真实进程边界）**；**验到的是哪一层**＝**产品 `team-human` 代码 + 真实独立子进程作输入源**；**未验**真实人类 UI / answerer（profile 装配 `dsh-user-questions` 服务但**无 answerer/UI 行**，真 `ask` 需 UI/Session 栈；`teamCore`/`teamBus`/`teamHumanBridge` 以**记录型 seam** 注入并断言被正确调用，`[PE3]` §5） |
| ⚠️ 边界 | 真实人类 UI / 宿主桥【未验证】；官方定位归 Host/Web（spec §2.2 明确不做 Web UI） |

### 1.7 覆盖矩阵汇总

| # | 六项精髓能力 | 判定 | 载体包 | 证据强度 |
|---|---|---|---|---|
| 1 | 广播群聊 / 多播 / topic | ✅ 已落地 | `team-bus`+`tool-swarm` | 【已验证】真实 profile |
| 2 | 任务自动派发 / 调度 | ✅ 已落地（**默认 scheduled**） | `team-scheduler`+`team-core` | 【已验证】真实 profile（P39/P43） |
| 3 | 验证闸 / in_review / 裁决 | ✅ 已落地 | `team-review`+`team-core` | 【单测级】+端口 mock；真实 profile 入闸可达/结算未验证 |
| 4a | 跨进程——传输层 + 对端运行时消费 | ✅ 已落地 | `team-transport`+`team-distributed`+`team-scale-contract` | 【已验证】真实 OS 进程 |
| 4b | 跨进程——两套完整 dsh 栈互通 | ❌ 未验证 | （同上） | 【未验证】 |
| 5 | worktree + 文件锁 | 🟡 部分落地（锁在/worktree 未触发） | `team-workspace` | 【单测级】 |
| 6 | 人类成员席位 | ✅ 已落地（桥接面；真实 UI 未写） | `team-human` | 【已验证】跨进程（桥接层） |

**超出「六项」的补充能力（同样交付）**：计划闸（执行前审批，opt-in，`team-core.Config.planGate` 默认 `false`）、返工反馈定向回流、团队提示词（`team-prompt`）、技能可见性（`team-skills`，真实写入成员 `ctx.skills` scope）、团队记忆（`team-memory`）、上下文预算（`team-compaction`）、内存态持久化（`team-durable`+ADR-0002）、解锁主动推送与可观测事件（P31）。（`[PL]`、`[V]` P23/P30/P31、`[ADR2]`）

---

## 2. 可信度分级

> 纪律：**不把【单测级】或【未验证】写成【已验证】**。三档定义见文首。**【已验证】以「真实 profile 下、完整栈、端到端」为准。**

### 2.1 【已验证】（真实 profile 或真实 OS 进程级端到端）

| 结论 | 验证位置 |
|---|---|
| 插件栈被真实 cordis 加载并可观察注册（19 包全量） | `[V]` P22 §D：`pnpm verify` 全绿；（`scripts/verify-load.mjs`） |
| bundle 在**真实 DSH profile** 装配正确（无禁用/不兼容告警；阶段3 三行存在；`subprocess` 可用） | `[PE3]` §2：`PASS=7`；`scripts/e2e-profile.sh` |
| 真实模型驱动团队（spawn/DM/任务看板） | `[PE]` §5（真实 `spawn_teammate`/`send_message`/`team_task_*` 工具结果原文） |
| `team-core` ↔ 原生 `ctx.agentTeams` 原生接通（P22 回归） | `[V]` P22 §C：`team_summary members=2` vs `list_agents` 一致；`pnpm verify:wiring` |
| 广播唤醒全体 = 与源系统一致；DM 只唤醒收件人 | `[EXW]` §7 P24（三臂）、§9/`[V]` P27（`dm_one` 两次独立取数） |
| **scheduler `scheduled` 真派发 + owner 落成员 + 开销更低** | `[EXR] §1.2/§1.3`（P39/P43，真实 profile 三臂）；`[V]` P19b §C |
| 跨进程 **4a 层**：V1–V4「不丢不重」+ 真杀进程/真进程重启 + journal 落盘 + A→B 运行时消费 + `local-listen` 自动互连 | `[PE3]` §3/§4；`[V]` §I/§K.3/§L.3；`pnpm verify:xproc` |
| ssh-rpc **机制**在真实 SSH 通道收发帧 + 断线重连 | `[V]` §J.2（需本机 sshd） |
| 人类席位：路由 / 阻塞→输入→继续（真实输入进程）/ 离线补投 | `[PE3]` §5 |
| 内存态跨重启恢复（ADR-0002：`in_review`/评审/广播/技能/记忆/未读 6 项） | `[V]` P23 §B：`pnpm verify:durability` 由红转绿 |
| 发布流水线门禁顺序（build<test<verify<publish）+ 无凭证预检 | `[PUB]` §4/§7（`check-publish-workflow.mjs` 全通过） |

### 2.2 【单测级】（行为单测 / 进程内集成冒烟，含端口 mock / 记录型 seam）

| 结论 | 验证位置 |
|---|---|
| 广播/多播/topic 语义（自过滤、原子多播、防滥用、超限零落库） | `[V]` P4a（team-bus 11~14 例） |
| 调度器两模式派发语义、stale 自催/升级、降级、自 arming、解锁推送 | `[V]` P4a/P18/P30/P31/P38b（scheduler 15 例） |
| 验证闸裁决数学（一票否决/阈值/自投拒绝/后写覆盖/maxRounds） | `[V]` P4a/P18/P30（review 14 例） |
| `in_review`/`planned` 合法与非法状态转换、返工 feedback 定向回流 | `[V]` P18 §C、P30 §B（core 22 例） |
| 文件锁互斥 / 写域守卫拒绝语义 | `[V]` P7（7 例）+ `verify:e2e` |
| 技能成员级隔离（真实 `ctx.skills` scope 层） | `[V]` P7b §H.4（team-skills 14 例，真实 `SkillRegistry`+`createScope`） |
| 完成判定三条件 + 上升沿去重 | `[V]` P4a（team-completion 8 例） |
| 跨进程协议（帧/ack/去重/队列）**内存 mock 单测** | `[V]` §H.2/§I.3（transport/distributed 单测） |
| **计划闸全链（opt-in）**：入闸→planned→未批不能执行→批准→pending / 驳回带理由 | `[V]` P30 §B/§C（**端口 mock e2e**；真实 profile 无工具入口，见 §2.3） |

### 2.3 【未验证】（仅有设计/推断，或真实 profile 缺入口/未跑通）

| 结论 | 状态 | 原因（来源） |
|---|---|---|
| **跨进程 4b 层：两套完整 dsh 团队栈互通** | ❌ 未验证 | 对端是探针进程（`peer-daemon.mjs`/`relay.mjs`），非完整 dsh 栈（`[PE3]` §6.2、`[V]` §K.5/§L.4） |
| **验证闸真实 profile 的 `settle` 端到端** | ❌ 未验证（前置缺失） | `settle()` 无调用入口 + 自验拒绝（`[EXR] §2.2`） |
| **计划闸真实 profile 端到端** | ❌ 未验证（前置缺失） | `team_task_update action='open_plan'` 被原生 enum 拒绝；`tool-swarm` 不提供任务工具（`[EXR] §2.1`） |
| `ssh-rpc` 经 **`dsh-ssh` 本体**接通（跨机） | ❌ 未验证 | 本仓无 `dsh-ssh`；需远端 helper 归档部署（`[V]` §J.2、`[PE3]` §6.2） |
| `ctx.subagents` **out-of-process 成员执行** | ❌ 未验证 | 包可装可加载，缺具体 subagent runtime + 子 profile + 模型路由（`[V]` §J.3） |
| 真实 **worktree 创建**（`ctx.worktrees`）在 profile 内触发 | ❌ 未验证 | `team-workspace` 以可选 seam 接入（`[V]` §G） |
| 人类**真实 UI / 宿主桥** | ❌ 未验证 | profile 无 answerer/UI 行；Web UI 明确不做（`[PE3]` §5/§6.2） |
| 「空转唤醒省 LLM 轮」命题 | ❌ **已证伪**（当前实现无该原语） | `[EXW]` §7.3/§9、`[V]` P27 §A：广播≡N DM（各 +1 轮）；`record-only`=不唤醒（`[EXW]` §7.3） |
| 跨机互连（不依赖预置守护/同机 registry） | ❌ 未验证 | registry 为同机共享目录（`[V]` §L.4） |
| 对端侧历史跨重启保留（V4 完全体） | ❌ 未验证 | 需对端持久化（`[PE3]` §3.4） |
| `local-listen` 跨用户/共享主机安全 | ❌ 未验证（且设计上不承诺） | 令牌是「防误连」非鉴权（`[V]` §N.3） |

### 2.4 首版→终版的「分级变更日志」（逐项重判）

| 项 | 首版分级 | 终版分级 | 变更依据 |
|---|---|---|---|
| 任务自动派发 | 【单测级】+桩（默认仍 autonomous） | **【已验证】真实 profile**（默认 scheduled） | P39/P43 真实三臂 + P19b |
| 跨进程分布式 | **【已验证】（单一）** | **拆两层**：4a【已验证】/4b【未验证】 | 精度校正（P20/P29/P32 证据只支撑 4a） |
| 广播群聊 | 【已验证】 | 【已验证】（**明确为真实 profile 长驻观测**，非桩/探针） | 同类给宽排查 |
| 人类席位 | 【已验证】 | 【已验证】（**限定为桥接/路由/阻塞层**；真实 UI/answerer 未验证） | 同类给宽排查 |
| worktree+锁 | 🟡 部分落地 | 🟡 部分落地（**写清：锁在、`ctx.worktrees` 未触发**） | 同类给宽排查 |
| 验证闸 | 【单测级】 | 【单测级】+ 真实 profile**入闸可达/结算前置缺失** | P33/P39 重测 |
| §7 B 类 S1–S5/S8 | 文档滞后 | **已于 P35 同步**（历史保留） | P35 |
| §7 C 类 S7 | 默认仍 autonomous | **已于 P19b 落地（默认 scheduled）** | P19b |
| §7 A 类 S0 | 双闸门偏差 | **不变**（唯一实现级偏差；计划闸已于 P30 补为 opt-in） | P28/P30 |

---

## 3. 与 JiuwenSwarm 的差异总结

> 纪律：**只报可比指标**——口径见 `[JS] §4`：可比 C1–C8（结构量/状态机/规则），不可比 N1–N6（绝对 token、进程/内存、DB 吞吐、跨进程、冷启动、代码行数）。**不可比项一律不报数字。**

### 3.1 可比指标对照（`[EX1] §1`）

| 可比指标 | JiuwenSwarm（jsfw 夹具实测） | dsh-swarm（实测） | 判定 |
|---|---|---|---|
| **C3 任务状态机** | `pending→in_progress→completed`；带 reviewer 时 `in_progress→in_review→completed` | 同（原生 + `in_review` 叠加态）；P30 增 `planned` 计划态 | **已对齐**（`in_review`/`planned` 均已补） |
| **C4 DAG 依赖解锁** | `blocked→pending` 自动解锁 | `blocked→ready(ready=true)` | **一致** |
| **C7 评审裁决** | autonomous **首票即决** | 二元池需 verifier+challenger 全投、任一 fail veto（更严） | **差异**：我方更严（多角色合议）——见下 §3.2 D2 |
| **C1 广播扇出形态** | `broadcast_message`：**O(1) 写**（1 记录 + 读水位线） | `team-bus`：**O(N) 扇出**（1 落库 + 逐人 DM，实测 N=3→3 投递） | **差异（形态级）**：写放大 O(1) vs O(N)——见下 §3.2 D1 |
| C2 每动作 DB 往返 | 未逐条埋点 | 未逐条埋点 | 未采集 |
| C5 幂等 / C8 单动作墙钟 | 未测 | 桩 e2e 亚毫秒，不可跨语言比 | 不可比 |

### 3.2 仍未对齐的设计差异（带原因）

| # | 差异 | 原因 / 现状 | 来源 |
|---|---|---|---|
| D1 | **广播存储形态**：源 O(1) 写 vs 我方 O(N) 写 | 我方 `fanout:'dm'` 逐人 DM（唤醒语义相同）；`record-only` 可退化为 O(1) 但**不唤醒**。**源系统选择唤醒全体是有意设计**，故不作默认 | `[EXW]` §9.2、`[R]`「广播与唤醒语义」 |
| D2 | **裁决数学**：源首票即决 vs 我方池合议 | 我方更严（不可自验 + 多角色）；属**有意的更严格取舍** | `[EX1]` §1 C7 |
| D3 | **任务解锁**：源 `TASK_UNBLOCKED` 主动推送 vs 我方轮询重算 readiness | **P31 已补「事件驱动即时推送（push）+ 轮询兜底」**；真实 profile 下 push 依赖同进程 `swarm/task/terminal`（跨进程 unlock 推送未打通） | `[EA]` #9、`[V]` P31 §M |
| D4 | **返工反馈**：源 `TASK_REVISION_REQUESTED` 带 feedback 定向 steer 作者 | **P30 已补** `swarm/task/revision-requested` + 定向 DM 作者 | `[EA]` #11、`[V]` P30 |
| D5 | **计划闸**：源有执行前 `PLANNING` | **P30 已补**（opt-in，默认 off）；但真实 profile 无工具入口（§2.3） | `[EA]` #16、`[V]` P30、`[EXR]` §2.1 |
| D6 | **事件模型**：源 41 个 `TeamEvent`（`TASK_*`/`MEMBER_*`）vs 我方 `swarm/*` 命名域 | 状态**存储**同源（原生 `team/task` durable 快照）；我方自造命名承载「原生没覆盖的补充态」；**不建议整体改名**，靠映射文档对照 | `[EA]` §0/§5、`[ADR2]` §3 |
| D7 | **跨进程模型**：源 pyzmq/subprocess/external-cli vs 我方 `local-child`/`local-listen`/`ssh-rpc` | 传输语义等价、实现不同；跨机需 `dsh-ssh` | `[EA]` #30、`[V]` §J |
| D8 | **假派发的默认时序**：源由 supervisor 常驻派发 | **P19b 已把默认改为 scheduled（对齐源「无人值守不卡」）** | `[V]` P19b、`[R]` |
| D9 | **审计/事件可观测性缺口**（`released`/`revoked`/`list-drained`/`member/status-changed`、解锁推送） | **P31 已补**（通知型事件） | `[EA]` §6、`[V]` P31 §M |

---

## 4. 已知边界与风险

### 4.1 未跑通 / 无法在本环境验证的项

1. **跨机 SSH（`dsh-ssh` 本体）**：`ssh-rpc` 机制在真实 SSH 通道已验证，但 `ctx.ssh` 需「远端 helper 归档 + OpenSSH alias + helperHash」（`[V]` §J.2、`[PE3]` §6.2）。
2. **`ctx.subagents` out-of-process 成员执行**：包存在可装，缺具体 runtime + 子 profile + 模型路由（`[V]` §J.3）。
3. **跨进程 4b 层：两套完整 dsh 栈互通**：现仅「传输层 + 对端运行时消费（探针对端）」（`[PE3]` §6.2、`[V]` §K.5/§L.4）。
4. **真实 Web UI / 人类真实 UI**：官方定位归 Host/Web；spec §2.2 明确不做（`[PE3]` §5）。
5. **真实 profile 下的验证闸/计划闸端到端**：`settle` 与计划动作**无工具入口**（§2.3）。
6. **整机 profile 真实模型全链路**：`profile-e2e` 的真实模型团队交互**走原生工具**，**未覆盖 `team-core` 端口**；本栈端到端在真实 profile 的覆盖面由 P22 `team_summary` 断言 + P39/P43 三臂部分弥补（`[V]` P22 §E-3、`[EXR]`）。
7. **对端侧历史跨重启保留（V4 完全体）**：需对端持久化（`[PE3]` §3.4）。
8. **e2e mock 盲区**（P34 已加固，仍有残留弱断言）：`delivery`(quiet/wakeup)、跨进程、持久化/崩溃恢复、`waitForChange`（mock 恒 timeout）、`updateTask` 的 **revision CAS 未强制**——依赖这些的断言属**弱断言，须真实 profile 验收**（`[V]` P34 §C）。
   - **历史事故（写清为鉴）**：真实 `sendMessage` 语义字段含 `content`，而 mock 曾**只记 `{target}`、丢掉 `content`** → 「返工 steer 回作者」断言**实际失败却被报成通过**（假绿）；P30 修 mock（增记 `content`）后转绿，P34 进一步把 `updateTask` DAG/readiness 等 12 条断言由弱转强（`[V]` P30 §D、P34 §A/B）。

### 4.2 跨进程的实际可用性（终版，按两层表述）

- ✅ **4a（传输层 + 对端运行时消费）**：**同机**——任意两个独立 dsh 进程可经 `local-listen` + 同机 registry **自动互连**（无需预置守护）；A→B 运行时真实消费（`[V]` §K.3/§L.3）；掉线/杀进程/重启可重放。
- ❌ **4b（两套完整 dsh 团队栈互通）**：**未验证**——对端需跑**承接线协议的守护进程**（`relay.mjs` / `peer-daemon.mjs`），**没有**「任意第三方 dsh 进程被拨入并各跑完整 bundle」的对称链路（`[V]` §K.5/§L.4、`[PE3]` §6.2）。
- ❌ **跨机**：仍走 `ssh-rpc`，`dsh-ssh` 未接通。
- ⚠️ **local-child 重连=重生子进程**：对端重启后 seq/历史丢失，at-least-once 重放**可能重复投递一次**，由应用层 `messageId` 幂等兜底（`[V]` §I.5）。

### 4.3 发布前还差什么

- **唯一硬性人工步骤**：在 npmjs.com 建 Automation token（限定 `@elinpf` scope）并存入 GitHub Secret **`NPM_TOKEN`**；缺失时流水线第一步即 `exit 1`（`[PUB]` §2/§1）。
- 发布对象：`pnpm -r publish` 会**自动跳过** `example-plugin`（`private:true`）；当前应发布 **19 个**协作包（`[PUB]`、`[CPC] §2` 均为 19）。
- 原生依赖构建被有意跳过：`pnpm-workspace.yaml` 的 `ignoredBuiltDependencies` 忽略 `node-pty`/`koffi` 等；**本仓发布产物为纯 JS/TS，不承诺替消费者构建原生依赖**（`[PUB]` §6.1）。
- 发布需先在隔离环境验证（`source scripts/env.sh` 后再跑门禁），避免污染现有 DSH 实例（`[PUB]` §6.3）。

### 4.4 「声称但未证伪/未证实」的说法（诚实清单）

| 说法 | 现状 | 来源 |
|---|---|---|
| 「空转唤醒省 LLM 轮」 | **已证伪**（广播≡N DM，各 +1 轮；无「唤醒但不投消息」原语） | `[EXW]` §7.3/§9、`[V]` P27 §A |
| 「`record-only` 省轮」 | `record-only` = **完全不唤醒**，故「省轮」无从谈起 | `[EXW]` §7.3 |
| P13/P17 早期真实 profile 结论（广播 0 唤醒等） | **【no-op 时代】产物**，真因是 `team-core` 未接通 `agentTeams`（P22 已修复），已被 P24 推翻 | `[EXW]` §7.4、`[V]` P22 §E |
| 「P19 默认 scheduled 用户已拍板」 | 曾**被误读为已完成**；实际 P19 取消→默认仍 autonomous（P19b 才落地） | `view_task P19`、`[V]` P19b |
| 成本口径 `--json` root-only | **低估真实团队 token 17.9%–36.2%**（`--json` 只投影 root 会话）；harness 已补 `teamActivity`/`teammateActivity` | `[EX1]` §4 发现 C |
| 「`in_review` 重启后保持」 | 早期为**缺陷**（重启退化 `in_progress`）；P23/ADR-0002 已修复为「保持」 | `[V]` P18 §E → P23 §B |
| scheduler「自动派发」 | 早期真实 profile **从未 arm → 从不派发**（P38b 修复）；P39/P43 后**真派发** | `[V]` P38b、`[EXR]` §1.0 vs §1.2/§1.3 |
| 「测试全绿」在**当前工作树** | 历史上多次因**他人在研未提交文件**使工作树 lint/test 转红（已如实记录）；**发布门禁在干净提交树上是绿的** | `[V]` P16 §E |

### 4.5 顶层系统风险

| # | 风险 | 来源 |
|---|---|---|
| R1 | **依赖实验性 `ctx.agentTeams`**（experimental、无版本承诺；npm `latest` 与 `0.2.1-rc.3` 不兼容，**必须钉 `0.2.1-rc.3`**） | `[SP]` §1.2、`[PL]` §6、`[R]` |
| R2 | **验证闸/计划闸真实 profile 无触发入口**（`settle`、计划动作）→ 端到端不可判定 | `[EXR]` §2 |
| R3 | **写放大**（广播 O(N) vs 源 O(1)）未消除（opt-in 存在但非默认） | `[EXW]` §9.2 |
| R4 | **文档在 P19b 后残留一处自相矛盾**（README「默认仍 autonomous」段与 P19b 冲突，见 §7 S9） | `[R]` 第 260 行 vs 第 183 行 |
| R5 | **部分能力真实 profile 覆盖不足**（`in_review` 结算、worktree、4b 完整栈互通） | §2.3/§1 |
| R6 | 跨机协作未打通（`dsh-ssh`），当前仅同机多进程可用 | `[V]` §J、§L.4 |
| R7 | **`local-listen` 安全边界**：令牌仅「防误连」，不构成鉴权；跨用户/共享主机不安全 | `[V]` §N.3 |

### 4.6 平台级观察（**由 team-leader 提供，非本仓 `docs/` 产物**，供接手者留意）

> 以下为团队负责人补充的平台级事实，**不属于 `dsh-swarm/docs/` 已落盘产物**，单独标注来源以供对照；具体复现与影响面待接手者按需核实。

| # | 观察 | 含义 / 影响 |
|---|---|---|
| O1 | 工具调用解析失败会**静默降级为文本**（不报错） | 真实运行时若模型工具调用格式不合，可能被当作普通文本吞掉 → 建议在 harness / 日志侧加**工具调用解析校验**，避免「该调工具却成了闲聊」而无人察觉 |
| O2 | 磁盘 trace **每天约 8–22G** | 长驻 / 真实模型运行需关注**磁盘配额与清理**（`.runtime/` 已 gitignore，但运维层面须关注 trace 体积） |
| O3 | **停工判定缺「正常思考 / 有意等待」档** | 与 §6.5 同源；本轮实际**误报过一次**（把「有意等待外部约束」判为停滞）→ 迁移 stale 语义时**必须区分「停滞」与「有意停驻」** |

---

## 5. 使用指南（从现有文档汇总，不重写一套）

> 以下均为对现有文档的**汇总指引**，细节以原文为准。

### 5.1 装（隔离环境）

```bash
cd <repo>/dsh-swarm
bash scripts/setup-env.sh        # 首次/换机器：幂等搭建隔离 Node v22.23.4 + pnpm 11.28.5 + 独立 DSH_HOME
source scripts/env.sh            # 必须 bash；切入隔离环境（.runtime/）
corepack pnpm install
```
- **不要挂本地代理**（大 body 会 `SSL_ERROR_SYSCALL`）；npm 直连或 npmmirror（`[ENV]` §4、`[R]`「环境注意」）。
- 隔离性：全程不碰 `/root/.dsh`、不改系统 node（`[ENV]` §6、`[PE]` §1）。

### 5.2 构建 / 测试 / 验证（开发内环）

```bash
corepack pnpm build / test / verify / typecheck / lint / format:check
corepack pnpm verify:e2e        # 进程内集成冒烟（阶段1/2/3 链路 + P34 强断言）
corepack pnpm verify:wiring     # 原生接通回归（P22）
corepack pnpm verify:durability # 内存态持久化恢复（P23/ADR-0002，非发布门禁）
corepack pnpm verify:xproc      # 真实跨进程（V1–V4 + 对端 attach + local-listen）
```
（`[R]`「快速开始」、`[V]` 各节）

### 5.3 启用团队 bundle（真实 profile）

```bash
DSH=.runtime/dsh-cli-npm/node_modules/.bin/dsh
# ⚠️ 实验包必须钉 0.2.1-rc.3（latest 是 0.1.5-alpha.2，不兼容会被版本门禁禁用）
$DSH plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.3
$DSH plugin --profile headless add ./packages/bundle
$DSH --profile headless --dump-config | grep -E "team-core|team-bus|tool-swarm"
$DSH --profile headless remove @elinpf/dsh-swarm-bundle   # 关闭即回退（零残留）
```
一键端到端：`bash scripts/e2e-profile.sh --no-model`（离线断言）或 `bash scripts/e2e-stage3.sh`（跨进程+人类席位）。（`[R]`「如何启用团队 bundle」、`[PE]`、`[PE3]`）

**调度默认**：bundle 装配后 `team-scheduler.mode` **默认 `scheduled`**（P19b）。要切回自主认领，把 `team-scheduler` 的 `config.mode` 设为 `'autonomous'`（`[R]`「任务派发模式」）。

**真实模型驱动**（内置 `dsh-llm-deepseek` 对 OpenAI 兼容端点 401，需 overlay）：
```bash
bash scripts/run-headless.sh "Reply with exactly: PONG"   # 自动读本机 config.yaml 的模型端点，密钥只注入进程环境
```
（`[PE]` §4）

### 5.4 跑基准（可选）

```bash
bash scripts/bench/run.sh --no-model --scenario S1,S2,S3,S4,S5 --repeat 3 --out .runtime/bench/baseline-stub
bash scripts/bench/run.sh --scenario S1,S2,S3 --token-cap 400000 --timeout-ms 700000   # 真实模型
```
口径与成本门禁见 `[BM]` §2/§6（`--token-cap` 超限即 `SIGKILL`）。（`[BM]`、`[OL]`）

### 5.5 发版

```bash
source scripts/env.sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build && corepack pnpm run test && corepack pnpm run verify
corepack pnpm -r publish --dry-run --no-git-checks --access public   # 本地等价预检
# 正式：改 19 个包 version → commit → git tag vX.Y.Z && git push origin main vX.Y.Z
```
- 前置：GitHub 配 `NPM_TOKEN`（§4.3）。
- **整族同版本 + tag 驱动**（19 包经 `workspace:*` 强耦合，由 `bundle` 统一组装）。（`[PUB]` §1/§2/§3/§4）
- 回滚：72h 内可 `npm unpublish`；更推荐发补丁版 + `npm deprecate`；`npm dist-tag` 改 `latest`。（`[PUB]` §5）
- 推送注意：**不要先 `source scripts/env.sh`**（会改 HOME 致凭证助手失效），用 `git -c credential.helper=/root/repo/jiuwen/.proxy-config/git-cred-helper.sh push`。（`[R]`、`[ENV]` §8）

### 5.6 开发契约速查（写新插件时）

- DSH 版本锁定 `0.2.1-rc.3`（commit `1f81c047`）；`@deepseek-ai/cordis` `^4.0.1`（`[R]`）。
- 两处**实测契约修正**（务必遵守）：① `defineTool` 的 value schema **对象层不接受 `required`**，`required:true` 写在**属性**上；② 消费 DSH 类型声明必须开 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（否则 `ctx.tools`/`ctx.systemPrompt` 类型增强被静默丢弃）。（`[R]`「对手册的两处修正」）
- 端口隔离：6 个能力包**只从 `team-core-contract` 取类型**，不得 import `team-core` 内部实现（ADR-0001）；`team-core` 是**唯一**接触实验包 `ctx.agentTeams` 的包，用本地结构化 seam 描述（不 import 实验包类型）。（`[ADR1]`、`[PL]` §2）
- 命名：`@elinpf/dsh-swarm-<能力>`；durable 事件 `swarm/<domain>/<action>`（带 `version`，ADR-0002 §3 为**唯一权威事件表**）。（`[PL]` §1、`[ADR2]` §3）

---

## 6. 未决问题清单（汇总各文档登记但未解决）

### 6.1 来自规格/布局（`[PL]` §6）

1. `ctx.ssh` 帧/RPC API 形状；`ctx.subagents` out-of-process provider 在 `0.2.1-rc.3` 的可跑性。
2. `ctx.storage` forms 用于远端副本持久化（当前 journal 用 atomic-write）。
3. 脑裂检测实现点；跨机断网联调；npm 齐发与 `minimumReleaseAgeExclude`。
4. 宿主（JiuwenSwarm）`HarnessProvider` 注册表开放化——**跨仓交办**，不在本 TS 仓。

### 6.2 来自事件对齐审计（`[EA]` §6）

| 优先级 | 缺口 | 现状（终版） |
|---|---|---|
| P0 计划闸 | 已由 P30 补（opt-in） | ✅ 已落地（真实 profile 无工具入口，§2.3） |
| P0 返工反馈 | 已由 P30 补（feedback 定向回流） | ✅ 已落地 |
| P1 解锁推送（`task/unblocked`） | 已由 P31 落地 | ✅ 已落地（跨进程 unlock 推送未打通） |
| P2 撤回定向通知 / 释放回池 | 已由 P31 落地 | ✅ 已落地 |
| P3 成员状态变更 / 看板排空 | 已由 P31 落地 | ✅ 已落地 |
| — 命名映射文档 | `[EA]` §3 可作种子 | 建议落 `docs/`（未做） |

### 6.3 来自持久化审计（`[SD]`、`[ADR2]`）

- 6 项「必须持久」已按 ADR-0002 修复；`review_stall`/stale 计时等「有意不持久」为已知可接受边界（`[V]` P23 §D）。ADR-0002 §3 事件表已由 P41 同步为**完整 SSOT**（补阶段 3/P31 事件）。

### 6.4 来自阶段 3 边界（`[PE3]` §6.2、`[V]` §I.5/§J/§L.4）

- `dsh-ssh` 本体接通（远端 helper 归档）；`ctx.subagents` out-of-process 执行；对端历史跨重启保留；跨机互连；4b「两套完整 dsh 栈互通」。

### 6.5 任务状态机语义缺陷（`[P31]` §6）

- **缺「有意停驻 / 等待外部约束」态**：进行中但在等人/等协调只能挂 `in_progress`，与 stale 检测**误判停滞**同根。移植 stale 语义时**必须区分「停滞」与「有意停驻」**，否则持续误升级。

### 6.6 实验局限（`[EX1]` §7、`[EXW]`、`[EXR]` §6）

- teammate token 未计重试 attempt 的额外用量（轻微低估）；真实模型实验多为**单次取数**（无 `--repeat` 区间）；`record-only` 未在真实模型下测（按定义 0 唤醒）。

### 6.7 跨包一致性（`[CPC]`）

- #1（中·文档）ADR-0002 §3 已由 **P41 同步**（原审计发现的缺口已闭）。
- #2（低·文档）bundle 显式 `planGate: false` **已修**。
- 结论：**未发现行为语义性不一致 / 真 bug**。

### 6.8 文档与实现（本报告 §7）

- **S9（新）**：README「默认派发模式」段（第 260 行）仍写「当前默认仍是 `autonomous`……P19b 仍未落地」，与 P19b 已落地的**默认 `scheduled`** 及 README 另一处（第 183 行）自相矛盾——**待同步**。

---

## 7. 【最高价值发现】文档声称与仓库实际对不上的地方

> 任务要求：若发现「文档声称已做但仓库里找不到证据」的情况，单独列一节。以下均为**实测对比**；**B/C 类历史记录按承诺保留**（项目过程也是交付物）。
>
> **★ 四类性质（读者请勿混淆）**：
> - **A 类「声称已做、实际未做」= 能力/事实偏差**：仅 **S0**。
> - **B 类「文档滞后于实现」= 维护问题**：**S1–S5、S8（均已于 P35 同步）、S9（新，待同步）**。
> - **C 类「计划/预期未回写」**：**S7（已于 P19b 落地）**。
> - **D 类「已修复的旧观察项」**：**S6**。

| # | 文档声称 | 仓库实际 | 证据 |
|---|---|---|---|
| **S0 ★（头号，A 类）** | 早期调研 **T1** 与迁移设计 **T4** 的最终报告 **F4** 曾写「**双闸门（PLANNING 执行前 + IN_REVIEW 执行后）已实现**」 | **当时实际只实现了 `IN_REVIEW`，计划闸/`PLANNING` 完全缺失**；该偏差直到 **P28 审计**才发现，**P30 才补上计划闸（opt-in）** | `[EA]` §0/§4 #16；`[V]` P30；对照 `final-report-jiuwen-to-deepseek-harness.md` F4 |
| **S1（B 类，**已同步 P35**）** | `[R]` 开篇曾写：「本仓当前处于**骨架阶段（scaffold）**……**只包含 hello-world**」 | 实际已有 **19 个协作包** | `[R]` 第 5 行（**P35 已改为「已走完阶段 0–3，19 包」**）；`packages/` |
| **S2（B 类，**已同步 P35**）** | `[R]`「当前阶段状态」曾勾到「阶段 2 共 **14 个包**」、阶段 2/3 标 `[ ]` | 实际 **19 包**（阶段 3 + `team-durable`） | `[R]` 第 251–252 行（**P35 已勾到阶段 3、19 包**） |
| **S3（B 类，**已同步 P35**）** | `[R]` 曾写「其余 **14 个协作包**可发布」 | 实际可发布 **19 个** | `[R]` 第 33 行（**P35 已改为 19**） |
| **S4（B 类，**已同步 P35**）** | `[PUB]` 曾写「发布的包：**14 个**协作包」 | 实际 **19** | `[PUB]` 第 7 行（**P35 已改为 19**） |
| **S5（B 类，**已同步 P35**）** | `[PL]` 包布局曾写阶段 3 后 **18 包** | 实际 **19 包**（ADR-0002 新增 `team-durable`） | `[PL]` §1（**P35 已改为 19**）；`packages/team-durable/` |
| **S6（D 类，已修复）** | `[PE]` §7「团队 bundle 重复插入 `agent-team`/`tool-agent-team` ⚠️ 观察项」 | **已收敛**：bundle 现只 disabled 4 legacy 行 + insert dsh-swarm 自身 14 行，不重复插入原生两行 | `[PE3]` §2、`[CPC] §3`（insert=14 恰好一致） |
| **S7（C 类，**已于 P19b 落地**）** | 「默认派发模式改 `scheduled`」曾被表述为**用户已拍板**（任务名即含此意） | 曾长期**默认仍是 `autonomous`**（P19 取消）；**P19b 已把默认改为 `scheduled`**（源码默认 + bundle + README 段） | `[V]` P19b；`packages/team-scheduler/src/index.ts`（默认 `scheduled`）、`bundle/cordis.patch.yml`（`mode: scheduled`） |
| **S8（B 类，**已同步 P35**）** | `[PUB]` §3 曾写「**14 个包**彼此经 `workspace:*` 强耦合」 | 实为 **19** | `[PUB]` §3（**P35 已改为 19**） |
| **S9（B 类，★新，待同步）** | `[R]` 第 260 行仍写「**当前默认仍是 `autonomous`**……『默认改为 `scheduled`』的原任务 P19 已取消（重建为 P19b，仍未落地）——不要把计划中的默认变更当作已完成」 | **与 P19b 已落地的事实矛盾**：源码默认、bundle、README 另一处（第 183 行「默认 `scheduled`」）均已为 scheduled。此段是 P35 同步后、P19b 落地前留下的**残留**，未随 P19b 更新 | `[R]` 第 260 行 vs 第 183 行；`packages/team-scheduler/src/index.ts`、`bundle/cordis.patch.yml` |

> **分类小结（终版）**：
> - **A 类（能力偏差，唯一）**：**S0**——早期 T1/T4 称「双闸门已实现」，实际当时只有 `IN_REVIEW`（P28 发现、P30 补计划闸）。这是「声称已做但仓库找不到证据」的**唯一实现级**偏差。
> - **B 类（文档滞后）**：**S1–S5、S8 已于 P35 同步**；**S9 为新残留**（P19b 引入），**待 P35 后续或下一轮同步**。
> - **C 类（计划未回写）**：**S7**——已于 P19b 落地。
> - **D 类（已修复旧观察项）**：**S6**。
>
> **历史保留承诺兑现**：B/C 类偏差**未删除**，改为「**曾存在，已于 P35/P19b 同步/落地**」——保留项目过程。

---

## 8. 附录：证据索引

| 结论域 | 主要来源 |
|---|---|
| 包布局 / 阶段 / 依赖图 | `[PL]` §1–§2；`packages/` 实测（19 包） |
| 跨包一致性（包名/可发布性/bundle patch/依赖） | `[CPC]` §1–§6 |
| 构建/测试/加载/集成验证 | `[V]` P2/P4a/P4/P7/P16/P18/P22/P23/P30/P31/P34 各节；`pnpm verify`/`verify:e2e` |
| 真实 profile 联调 | `[PE]`；`[PE3]`；`scripts/e2e-profile.sh`/`e2e-stage3.sh` |
| 调度派发 / 归属 / 默认模式 | `[EXR]` §1.2/§1.3；`[V]` P38b/P42/P19b |
| 计划闸 / 返工反馈（真实 profile 前置缺失） | `[EXR]` §2；`[V]` P30 |
| 基准与成本门禁 | `[BM]`；`[OL]`；`scripts/bench/run.sh` |
| A/B / 消融 / 差异定位 | `[EX1]` §1–§3 |
| 空转唤醒定论（P24/P27） | `[EXW]` §7/§9；`[V]` P27 |
| 源系统对照夹具 | `[JS]`（可比 C1–C8 / 不可比 N1–N6） |
| DSH agent-team 真实边界 | `[SP]` §2/§5/§6 |
| 原生接通修复 | `[V]` P22 |
| 内存态持久化 | `[SD]`；`[ADR2]`；`[V]` P23 |
| 事件体系对齐 | `[EA]` §1–§6；`[V]` P31 |
| 阶段 3 跨进程/人类席位 | `[PE3]`；`[V]` §H/§I/§J/§K/§L/§N |
| 发布 | `[PUB]` §1–§7；`.github/workflows/publish.yml` |
| 隔离环境 | `[ENV]`；`scripts/env.sh`/`setup-env.sh` |
| 端口隔离 ADR | `[ADR1]`（contract 包）；`[ADR2]`（durable 事件） |

---

*（本文件由 report-synthesizer 汇总成稿：P21 首版 2026-10-27，锚 `5e6ab63`；**P37 终版**同日，锚 `2031d44`。只整合 `dsh-swarm/docs/` 已落盘产物与仓库实际状态，未新增未经证据支持的结论。凡【已验证】/【单测级】/【未验证】分级见 §2；文档与实现不一致处见 §7；分级变更见 §2.4。）*
