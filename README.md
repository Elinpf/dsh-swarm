# dsh-swarm

把 JiuwenSwarm 的「集群/多智能体协作精髓」迁移到 **DeepSeek Harness（DSH）** 的插件族仓库。

本仓已走完 **阶段 0–3**：在可复用的 pnpm workspace 骨架上，用 `packages/example-plugin` 跑通「**插件能被构建 → 能被 DSH 内核加载 → 能观察到它注册的东西**」这条链路后，已在其上落地 **19 个协作能力包**（协作内核 / 能力供给 / 规模化边界三层），覆盖消息总线、任务看板、验证闸、跨进程传输与人类成员席位等团队协作能力。

> `example-plugin` 是骨架阶段的 hello-world **演示包**（保留 `"private": true`，不发布）；其余 **19 个**协作包均为可发布交付件。各包的阶段归属与清单见 [`docs/package-layout.md`](docs/package-layout.md)，验证证据见 [`docs/verification.md`](docs/verification.md)。

插件与 bundle 的开发契约以 [`docs/plugin-dev-guide.md`](docs/plugin-dev-guide.md)（`dsh-v0.2.1-rc.3` 核定版）为唯一依据；隔离开发环境见 [`docs/env-setup.md`](docs/env-setup.md)。

---

## 锁定版本

| 组件                  | 版本                     | 说明                                          |
| --------------------- | ------------------------ | --------------------------------------------- |
| DSH                   | `0.2.1-rc.3`             | 上游 tag `dsh-v0.2.1-rc.3`，commit `1f81c047` |
| Node                  | `^22.19.0 \|\| >=24.0.0` | 与 DSH `engines` 一致；隔离环境用 `v22.23.4`  |
| pnpm                  | `11.28.5`                | 锁在根 `package.json` 的 `packageManager`     |
| `@deepseek-ai/cordis` | `^4.0.1`（本机装 4.0.5） | DSH 的插件内核                                |

### 命名（npm scope）

本项目自有包统一发布在 **`@elinpf`** scope 下，命名规则 `@elinpf/dsh-swarm-<能力>`：

| 本项目包                         | 对应上游（DSH）                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@elinpf/dsh-swarm-team-core` 等 | 编排/协作能力由本仓自建，**不**对应单个上游包                                                                   |
| `@elinpf/dsh-swarm-bundle`       | 组合层，叠加在上游 bundle（如 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-experimental-agent-team-profile`）之上 |

> 上游 DSH 包一律以 `@deepseek-ai/dsh-*` 命名（peer 依赖，不由本仓发布）。本仓的包名与上游**不混用同一 scope**：自建=`@elinpf/dsh-swarm-*`，上游=`@deepseek-ai/*`。
>
> `example-plugin` 是骨架阶段的 hello-world **演示包**，`package.json` 保留 `"private": true`，**不发布到 npm**（`pnpm -r publish` 会自动跳过它）。其余 19 个协作包可发布。

---

## 目录结构

```
dsh-swarm/
├── package.json            # 根 workspace：脚本 + 开发依赖 + packageManager 锁定
├── pnpm-workspace.yaml     # workspace 成员 + 链接器设置（hoisted / autoInstallPeers）
├── tsconfig.base.json      # 统一 TS 基座（含 DSH 声明文件所需的 allowImportingTsExtensions）
├── eslint.config.mjs       # 扁平 ESLint 配置
├── .prettierrc.json        # 格式化配置
├── .gitignore              # 忽略 .runtime/ 与本地环境/凭证
├── packages/
│   ├── example-plugin/          # hello-world 基线（P2 产出）；演示包，不发布到 npm（private）
│   ├── team-core-contract/      # 端口类型 SSOT（纯类型，无实现；ADR-0001）
│   ├── team-bus/                # 广播 / 多播 / 主题扇出（Service）
│   ├── team-prompt/             # 团队段落装配（函数式）
│   ├── team-scheduler/          # 幂等调度 + stale 自愈（Service）
│   ├── team-review/             # 验证闸 + 裁决数学（Service）
│   ├── team-completion/         # 团队完成判定（Service）
│   └── tool-swarm/              # 模型工具（函数式）
│   # 每个包：src/index.ts + tests/*.spec.ts + tsconfig.json + package.json
├── scripts/
│   ├── env.sh              # source 后进入隔离环境（P1-env-setup 产出）
│   ├── setup-env.sh        # 幂等搭建隔离环境（P1-env-setup 产出）
│   ├── verify-load.mjs     # 真实 cordis 加载验证（pnpm verify 的核心）
│   ├── verify-e2e.mjs      # 集成冒烟（pnpm verify:e2e）
│   ├── run-headless.sh     # 真实模型 headless 驱动（profile 联调）
│   ├── e2e-profile.sh      # 真实 profile 回归（bundle patch 断言）
│   └── bench/              # 可复现基准 harness（场景/成本门禁/JSW 对照夹具；见其 README）
└── docs/
    ├── plugin-dev-guide.md # 插件/bundle 开发手册（核定版）
    ├── env-setup.md        # 隔离环境方案与实测记录
    └── verification.md     # 本阶段构建/测试/加载验证的实测输出
```

---

## 快速开始

### 1. 进入隔离环境（**必须**，避免影响现有 DSH 实例）

```bash
cd dsh-swarm
source scripts/env.sh        # 切到项目内隔离的 Node / pnpm / DSH_HOME
node -v                      # v22.23.4
corepack pnpm -v             # 11.28.5
```

> 隔离环境由 `scripts/setup-env.sh` 幂等搭建（详见 `docs/env-setup.md`）。首次或换机器时先跑：`bash scripts/setup-env.sh`。

### 2. 安装依赖

```bash
corepack pnpm install
```

### 3. 构建 / 测试 / 验证

```bash
corepack pnpm build      # tsc 编译所有包到 lib/
corepack pnpm test       # vitest 单测
corepack pnpm verify     # build + 用真实 cordis 加载插件并断言注册结果
corepack pnpm typecheck  # 仅类型检查
corepack pnpm lint       # ESLint
corepack pnpm format:check
```

实测输出见 [`docs/verification.md`](docs/verification.md)。

---

## example-plugin 是什么

一个**最小可运行的 DSH 函数式插件**，用来证明链路通畅：

- 命名导出 `name` / `inject` / `Config` / `apply`，**没有 default export**（default export 会让 loader 丢掉 `inject`）；
- `apply` 里注册一个模型可见工具 `greet` 和一个系统提示词 section `example-plugin:guide`；
- `package.json` 通过 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明自己是 bundle，patch 用 `- insert:` 往组合树里加一行。

**加载验证**（`scripts/verify-load.mjs`）用**真实的 cordis 运行时**（DSH 的内核）把构建产物 `ctx.plugin()` 进去，断言：无 default export、工具与 section 被注册、工具可执行、fiber 卸载进入 `DISPOSED`、`ctx.effect` 注册会随卸载回滚。

---

## 阶段 1 协作插件（P4a）

在 `example-plugin` 之外，新增 7 个协作能力包（一个能力一个包，包间**只经端口通信**）：

| 包                                     | 形态    | 服务键               | 职责                                                            |
| -------------------------------------- | ------- | -------------------- | --------------------------------------------------------------- |
| `@elinpf/dsh-swarm-team-core-contract` | 纯类型  | —                    | 端口类型 **SSOT** + `ctx.teamCore` 类型增强（无实现，ADR-0001） |
| `@elinpf/dsh-swarm-team-bus`           | Service | `ctx.teamBus`        | 广播 / 多播 / 主题扇出（自过滤、原子多播、防滥用）              |
| `@elinpf/dsh-swarm-team-prompt`        | 函数式  | —                    | 稳定段 + cache-safe context + 渐进披露                          |
| `@elinpf/dsh-swarm-team-scheduler`     | Service | `ctx.teamScheduler`  | 幂等扫描调度 + stale 自催/升级 + 降级                           |
| `@elinpf/dsh-swarm-team-review`        | Service | `ctx.teamReview`     | 验证闸 + 裁决数学（一票否决 / 打分阈值 / 自投拒绝）             |
| `@elinpf/dsh-swarm-team-completion`    | Service | `ctx.teamCompletion` | 完成判定三条件 + 上升沿去重                                     |
| `@elinpf/dsh-swarm-tool-swarm`         | 函数式  | —                    | 暴露 broadcast/multicast/review\_\*/team_summary 模型工具       |
| `@elinpf/dsh-swarm-team-core`          | Service | `ctx.teamCore`       | **TeamCorePort** 落地：native 薄适配 + no-op 降级               |
| `@elinpf/dsh-swarm-bundle`             | bundle  | —                    | 组合层：先 disabled 关 legacy，再 insert 团队行                 |

### 阶段 2 能力供给包（能力供给补全）

| 包                                           | 形态    | 服务键               | 职责                                                                    |
| -------------------------------------------- | ------- | -------------------- | ----------------------------------------------------------------------- |
| `@elinpf/dsh-swarm-team-capability-contract` | 纯类型  | —                    | 4 个能力端口类型 SSOT（无实现）                                         |
| `@elinpf/dsh-swarm-team-workspace`           | Service | `ctx.teamWorkspace`  | worktree 隔离（复用 `ctx.worktrees`）+ 文件锁/写域守卫（`fs/*-intent`） |
| `@elinpf/dsh-swarm-team-skills`              | Service | `ctx.teamSkills`     | 技能可见性，**落到成员 `ctx.skills` scope 层**（缺失文档=无限制）       |
| `@elinpf/dsh-swarm-team-memory`              | Service | `ctx.teamMemory`     | 共享只读 + 成员私有记忆，`ctx.systemPrompt.context` 注入（cache-safe）  |
| `@elinpf/dsh-swarm-team-compaction`          | Service | `ctx.teamCompaction` | 团队上下文预算，委托 `ctx.compaction`（幂等，默认关闭）                 |

`tool-swarm` 增量暴露 `workspace_lock/unlock/worktree`、`skills_visible`、`memory_recall`（`Config` 里 `enableWorkspace/enableSkills/enableMemory`，默认 false）。

**`team-skills` 能力边界**：成员级技能可见性已**真实生效**——可见集被落到每个成员的 `ctx.skills` scope 层（注册经 `agent.ctx.get('skills')`），因此 A 成员看不到 B 成员的私有技能、未授权技能不出现在模型能力目录与 `skill` 工具中；`reconcile()` 幂等、随成员 scope 释放自动回滚。边界：`team-skills` 只拥有**可见性**、不拥有技能正文（虚拟技能为正例占位体，正文由团队技能包承载）；实时落层依赖 `visibleTo`/`grant`/`declare` 被消费方调用。细节与源码依据见 `docs/verification.md` §H。

**任务状态机与 `in_review` 能力边界**：`ctx.teamCore` 的任务状态在原生 `pending|in_progress|completed|deleted` 之上**叠加显式评审态 `in_review`**（对齐 JiuwenSwarm 的 `in_progress → in_review → completed`）：提交评审 → 进入；裁决 `pass` → 完成；`fail` → 返工回 `in_progress`；非法转换（如 `pending → in_review`）被拒（`TEAMCORE_INVALID_TRANSITION`）。`in_review` 期间**团队完成判定不判完成**、**调度器不重复派发**，并对其做 `review_stall` 超时升级。**已知限制（如实登记）**：`in_review` 是 `team-core` 的**进程内叠加态、未持久化**——进程重启 / 跨进程 / 崩溃恢复后，卡在评审的任务会**退化为 `in_progress`**，后果为：可能被**重复派发**、可能**绕过验证闸**直接被完成、`review_stall` 计时归零后会**再升级一次**；`reviewSince`/`reviewEscalated` 同类。持久化修复见 P23（内存态审计）。细节见 `docs/verification.md` P18 节。

### 跨重启状态（持久化边界，P23 审计）

> 全仓**无任何包声明 storage/durable 依赖**；约定是「durable 事件即真相」，但阶段 0/1/2 多数包只 emit 不 fold → 重启即丢。完整清单/行号见 `docs/state-durability.md`。

| 状态                                       | 跨重启                 | 说明                                                   |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------ |
| `team-core.in_review` 叠加态               | **保持**（ADR-0002）   | emit `swarm/core/review-entered/left` + `recover` fold |
| `team-review` 评审轮次/票/verdict          | **保持**（ADR-0002）   | emit `swarm/review/*` + fold                           |
| `team-bus` 广播记录（`history`）           | **保持**（ADR-0002）   | emit `swarm/bus/broadcast` + fold                      |
| `team-skills` 可见性声明 / 授权            | **保持**（ADR-0002）   | emit `swarm/skills/visibility\|grant` + fold           |
| `team-memory` 共享 & 成员私有记忆          | **保持**（ADR-0002）   | emit `swarm/memory/*` + fold                           |
| `team-completion.unread` 台账              | **保持**（ADR-0002）   | emit `swarm/completion/unread` + fold                  |
| `team-workspace` 写域锁（带 TTL）          | 不保持（**有意正确**） | TTL 锁重启即失效避免死锁                               |
| `team-scheduler` `review_stall`/stale 计时 | 不保持（可接受）       | 至多重升/早催一次，非正确性                            |
| `team-completion.emitted` 上升沿           | 不保持（可接受）       | 至多重复发一次 `swarm/team/completed`                  |
| `team-core` 后端挂接（seam）               | 自动重挂               | 响应式 `ctx.inject`（P22），非持久化问题               |

机制与事件 schema 见 `docs/adr/0002-durable-state-convention.md`；诊断 `pnpm verify:durability`（非发布门禁）验证「置态 → 重建 → recover → 恢复」为绿。

### 广播与唤醒语义（P27 核实）

**广播唤醒全体非发送者 = 与源系统一致**（源系统 `interaction-mechanisms.md` L232 / §3：广播 `to='*'` 唤醒每个非发送者 1 轮），**非缺陷、不存在省轮空间**。真正的对齐点是「**发给别人的直接消息不唤醒我**」——已核实对齐（真实 profile：DM 给 alice 时 bob/carol 额外轮 = 0）。详见 `docs/experiments-idle-wakeup.md §9`、`docs/verification.md` P27 节。

- **`record-only` / `quiet` 为 opt-in（非默认）**：`broadcast({fanout:'record-only'})` = 1 落库、不逐人 DM、成员按需 `history()` 拉取（完全不唤醒）；`broadcast({delivery:'quiet'})` = 入邮箱但不唤醒。**适用**高流量信息型广播。**风险**：静默广播**无法触发协同动作**（「全体停止 / 任务变更」类若无人被唤醒可能长期无人处理），故**不作默认**。
- **遗留（待评估）**：写放大——源系统广播 **O(1)** 写（1 记录 + 读水位线）vs 我们 **O(N)**（1 落库 + 逐人 DM）；唤醒语义相同、存储形态不同。

### 计划闸与返工反馈（P30）

- **计划闸（执行前审批，opt-in）**：`ctx.teamCore` 的 `Config.planGate` **默认 `false`**（对齐源系统 PLANNING 为可选闸门，避免默认给所有任务加人工卡点）。开启后：`pending → planned`（`updateTask.action:'open_plan'`）→ 提交计划（`submit_plan`，携带 `plan` 正文）→ 批准（`approve_plan`）回到 `pending` 可执行；**驳回**（`reject_plan`，携带 `feedback`）留在 `planned` 可再改。**未批准不能执行**（`claim`/`complete` 等被拒 `TEAMCORE_INVALID_TRANSITION`）；关闭时 `open_plan` 抛 `TEAMCORE_PLAN_GATE_DISABLED`。`planned` 是**非终态**（不被完成判定误判）且**不被调度器派发**；与 `in_review` 验证闸**独立可开关**。批准/驳回经**统一 action 面**（不新增独立工具）。
- **返工反馈（定向回流）**：评审 `fail` 时 `settle(caller, taskId, feedback)` 携带 `feedback`；`team-core` 存 `revisionFeedbackOf(taskId)` 并发 `swarm/task/revision-requested`；`team-review` 再把 `[revision-requested] task X: <feedback>` **定向 DM 回原作者**——作者知道「改什么」（不再只知 fail）。
- 事件 schema（ADR-0002 §3）：`swarm/task/{plan-request, plan-response, revision-requested}`。

### 任务派发模式（**默认 `scheduled`**，P19b —— ⚠️ 破坏性行为变更）

- **默认 `scheduled`（调度派发）**：Leader 侧常驻 `TeamScheduler`，幂等扫描**主动派发**就绪任务（经端口 `assign`→ 原生 `reassign`，owner 落到被派发成员），带超时/重试/卡死升级。**原默认是 `autonomous`，本次改为 `scheduled`，属破坏性默认变更。**
- **如何切回 `autonomous`（自主认领）**：把 `team-scheduler` 的 `Config.mode` 设为 `'autonomous'`（或 bundle patch 对应行的 `config.mode`）。此时调度器**只 nudge** 空闲成员去自行 `claim`，**不主动派发**——行为与改前一致（未改坏）。
- **两者差别（真实 profile 数据：【P39/P43】）**：同场景下 `scheduled` **真派发**（任务 `pending→in_progress`、`ownerName` = 被派发成员）、teammate 开销 **4 轮 / 119.7k token**；`autonomous` **不派发**、靠成员被 nudge 后自 claim，且**反复 nudge**，teammate 开销 **12 轮 / 206.1k token（≈2.4×）**。→ 无人值守场景 `scheduled` 开销/信噪更优，故定为默认。
- 装配条件：`role=LEADER 且 dispatch_mode=scheduled` 时自装配（P38b 自 arming）。

**端口隔离（ADR-0001，方案 C）**：6 个能力包**只从 `@elinpf/dsh-swarm-team-core-contract` 取类型**，不得 import `@elinpf/dsh-swarm-team-core` 的内部实现——契约与实现物理分离，约束在编译期成立。`team-core` 是**唯一**接触实验性 `ctx.agentTeams` 的包，且用本地结构化的 seam 接口描述它（不 import 实验包类型）。

### 后端选择（`team-core`）

**后端 = `native`**：P3-spike 实测 DSH 原生 `ctx.agentTeams` 在 `0.2.1-rc.3` 上可用（8/10 工具跑通、durable 事件落盘、`--session-id` 重启可复原）。阶段 0/1 **不实现 `owned` 自建后端**，但端口保留 `backend` 选择点：`backend: 'owned'` 显式抛 `TEAMCORE_BACKEND_UNAVAILABLE`；`ctx.agentTeams` 缺失时进入 **no-op 模式**（读返回空、写抛 `TEAMCORE_UNAVAILABLE`），**不阻断单 agent**。

### 如何启用团队 bundle

> ⚠️ 实验包**必须钉 `0.2.1-rc.3`**（npm `latest` 是 `0.1.5-alpha.2`，不兼容会被版本门禁禁用）。

```sh
source scripts/env.sh
DSH=.runtime/dsh-cli-npm/node_modules/.bin/dsh
$DSH plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.3
$DSH plugin --profile headless add ./packages/bundle
$DSH --profile headless --dump-config | grep -E "team-core|team-bus|tool-swarm"
$DSH --profile headless remove @elinpf/dsh-swarm-bundle    # 关闭即回退（零残留）
```

### 「集群模式」agent preset（**默认**，P44）

- **默认「集群模式」**：`@elinpf/dsh-swarm-bundle` 现随包提供 agent preset `swarm`（`name: '集群模式'`，`order: 0`），并把 `agent-preset-registry` 的 `default` 覆盖为 `swarm` → **安装后默认即「集群模式」**（原默认 `standard`，属行为变更）。
- **如何切回 / 切换**：在 Web 的模式选择器切到 `standard`（标准模式）或其他内置 preset（`ptc`/`minimal`/`cordis`）；或在 profile 层覆盖 `agent-preset-registry.default`。profile 层同名 preset 会覆盖本 bundle 的声明（**演示实例不受影响**）。
- **该模式包含什么**：与 `standard` preset **完全相同的工具集**（32 个插件 id），**外加** dsh-swarm bundle 注入的团队协作行（team-core/bus/review/scheduler/completion/workspace/skills/memory/compaction/transport/distributed/human + tool-swarm）。
- **验证**：dump-config 中 `swarm` 与 `standard` 的插件 id 集**逐项一致**（32/32，无缺失无多余，仅 id/order/name 不同）。

---

## 环境注意

正常路径就是标准 pnpm 流程：

```bash
source scripts/env.sh          # 隔离 Node v22.23.4 + pnpm 11.28.5 + 独立 DSH_HOME
corepack pnpm install          # 默认 store 即可
corepack pnpm verify
```

> **网络**：不要挂 Clash 之类本地代理（实测大 body 会 `SSL_ERROR_SYSCALL`）。npm 直连或走 npmmirror 均可（见 `docs/env-setup.md`「网络注意事项」）。
>
> **推送凭证**：若需 `git push`，**不要**先 `source scripts/env.sh`——它会把 `HOME` 改到项目内隔离目录，
> 导致凭证助手找不到 `/root/.git-credentials`。推送请用：
> `git -c credential.helper=/root/repo/jiuwen/.proxy-config/git-cred-helper.sh push`。

<details>
<summary>可选：磁盘紧张时的临时规避（开发过程中曾用到，现磁盘已充足，通常不需要）</summary>

若根盘接近占满，可把依赖与 store 放到 tmpfs，避免写满根盘：

```bash
mkdir -p /dev/shm/dsh-swarm/node_modules
ln -sfn /dev/shm/dsh-swarm/node_modules node_modules
corepack pnpm install --store-dir=/dev/shm/dsh-swarm-store --prefer-offline
```

`/dev/shm` 是易失内存，重启后需重建（`node_modules` 已在 `.gitignore` 中）。

</details>

---

## 当前阶段状态

- [x] pnpm workspace 骨架（根 package.json / pnpm-workspace.yaml / tsconfig 基座 / lint+format / .gitignore）
- [x] hello-world 插件包 + bundle 声明
- [x] 阶段 0/1 协作插件 7 包（team-core-contract / team-bus / team-prompt / team-scheduler / team-review / team-completion / tool-swarm）
- [x] `team-core`（TeamCorePort，native 后端）+ `bundle` 组装 —— 阶段 0/1 全部 9 个包就位
- [x] **阶段 2 能力供给 5 包**（team-capability-contract / team-workspace / team-skills / team-memory / team-compaction）
- [x] **阶段 3 规模化与边界 4 包**（team-scale-contract / team-transport / team-distributed / team-human）—— 阶段 0–3 共 **19 个协作包**
- [x] ADR-0002 内存态持久化约定（`team-durable` 折叠助手 + 各包 `emit`/`fold`；`pnpm verify:durability` 诊断）
- [x] `pnpm build` / `pnpm test` / `pnpm verify` / `pnpm verify:e2e` / `pnpm lint` / `pnpm format:check` 全部实跑通过
- [x] 真实 cordis 加载验证覆盖**全部 19 个包**（`scripts/verify-load.mjs`）；集成冒烟覆盖「成员 → 消息 → 任务 → 评审 → 完成」+ 阶段 2/3「锁互斥 / 技能隔离 / 记忆授权 / 跨进程 transport / 分布式 / 人类席位」（`scripts/verify-e2e.mjs`）
- [x] 真实 profile 回归（`scripts/e2e-profile.sh --no-model`）：bundle **14 行** + 4 legacy disabled + 原生行来自 agent-team-profile + 阶段 3 三行 + `subprocess` 可用 + 无禁用/不兼容告警，全绿
- [x] 阶段 3 真实跨进程 / 崩溃恢复 / 人类席位验证（真实 OS 进程 + 真实 `ctx.subprocess`）—— 见 [`docs/profile-e2e-stage3.md`](docs/profile-e2e-stage3.md)
- [ ] 整机 profile 级联调（完整 `dsh-base` + 实验包 + 可用模型端点）—— 见 `docs/verification.md` 边界说明
- [ ] Web 端 roster / task-board UI（`team-human` 只提供桥接面，Web UI 未写）

> **默认派发模式（P44 更正，保留历史）**：`team-scheduler` 的 `Config.mode` **曾默认为 `autonomous`**；**已于 P19b（commit `2031d44`）改为默认 `scheduled`**（详见上文「任务派发模式（默认 `scheduled`）」段）。原任务 P19 曾被取消并重建为 P19b，**现已落地**——以实现为准：**默认即 `scheduled`**；如需切回自主认领，显式配置 `mode: 'autonomous'`。（此前本节曾写「当前默认仍是 `autonomous` / P19b 仍未落地」，属 P19b 落地前的旧状态，现更正。）

### 依赖版本陷阱（重要）

安装 DSH 原生实验包时**必须显式带 `@0.2.1-rc.3`**（dist-tag `next`）：

```bash
pnpm add @deepseek-ai/dsh-experimental-agent-team@0.2.1-rc.3
```

npm 上这两个实验包的 `latest`（`0.1.5-alpha.2`）与我们的运行时不兼容，会被版本门禁直接禁用，强行打开会在 `spawn`/typert codec 上报错。详见 `docs/agent-team-spike.md`。

### 对手册的两处修正（真实 0.2.1-rc.3 实测）

1. **`output.schema` 的 `required`**：手册 §2.2 示例把 `required: true` 写在对象层，真实 value schema DSL **不支持**（抛 `JsonSchemaError`）。正确写法是把 `required: true` 写在**属性**上（见 `packages/example-plugin/src/index.ts`）。
2. **消费 DSH 声明需要 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`**：DSH 的 `.d.ts` 之间用 `.ts` 扩展名互相引用；不开启这两项，`declare module '@deepseek-ai/cordis'` 的类型增强会被静默丢弃（症状：`ctx.tools` / `ctx.systemPrompt` 不存在）。已写入 `tsconfig.base.json`。

## 行为变更：leader 等待模型（P46）

leader 默认改为**纯事件唤醒**（对齐 JiuwenSwarm）：**派发/发消息后结束轮次**，由成员消息唤醒新一轮；**不把 `wait_agent` 当默认动作**（工具保留、随时可用，仅同轮必须聚合时使用）。
由 `team-prompt` 配置 `leaderWaitModel`（`event-wake` 默认 / `blocking-allowed` 旧口径）控制。详见 `docs/leader-wait-model.md`。
