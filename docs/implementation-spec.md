# dsh-swarm 实现规格（阶段 0/1）

> 产出人：migration-architect（插件化迁移架构师）
> 任务：P3-spec — 把 `migration-design.md` 落成**可直接指导编码**的实现规格
> 定位：本文件是后续所有 dsh-swarm 插件实现任务的**唯一依据**；凡与 `docs/plugin-dev-guide.md`（0.2.1-rc.3 核定版）冲突，以该手册为准并在此标出。
> 约定：
> - `【事实】`：来自 `docs/plugin-dev-guide.md`、`docs/env-setup.md`、`docs/verification.md`、`packages/example-plugin/`、`.runtime/deepseek-harness/`（0.2.1-rc.3 源码）或团队调研产物，均附来源。
> - `【设计主张】`：本规格提出的、尚待 P3-spike 或实现验证的设计决策。
> - 版本锁定（唯一）：DSH `0.2.1-rc.3`（commit `1f81c047`）· Node `^22.19.0 || >=24.0.0` · pnpm `11.28.5` · `@deepseek-ai/cordis` `^4.0.1`（本机 4.0.5）【事实·README/plugin-dev-guide §0】

---

## 0. 事实基线（编码前必须知道）

**【事实·plugin-dev-guide §1】0.1.0-rc.8 → 0.2.1-rc.3 破坏性变更，直接影响本规格：**

| # | 变更 | 对本规格的强制约束 |
|---|---|---|
| B1 | `invariant` 机制整体移除（无 `src/invariant.ts`、`ctx.invariants`、`dsh-invariants`） | **禁止**写 invariant 伴侣包；持久数据校验改放 `session/event` 订阅侧或插件私有（见 §3.7） |
| B2/B3 | preset 由「目录式」改「插件行式」（`@deepseek-ai/dsh-agent-preset`） | 阶段 0/1 **不使用 preset**；能力全部编进 bundle 的 host 树 |
| B4 | 依赖协议统一 `workspace:~`（仅适用于 DSH monorepo 内部包） | dsh-swarm 是独立仓，**对外部 DSH 包用 semver 区间**（对齐 `example-plugin` 实际写法） |
| B5 | `private: true` 不再出现在包 manifest | dsh-swarm 自建仓可省 `private`（阶段 0/1 内部包可保留 `private: true` 直至发布） |
| B7 | bundle 的 patch 可为**有序文件列表** | 复杂 bundle 可拆多个 patch（本规格阶段 0/1 先用单文件） |
| B8 | 新增 DSH 版本兼容门禁：`engines.dsh` 或 peer 必须匹配 runtime | 所有包 `peerDependencies` 上的 `@deepseek-ai/dsh-*` 必须写对，否则 profile 会**跳过该 bundle**（`skippedBundles`） |
| B12 | `agent-team` 的 session 事件 `version` 由 1 升到 **2** | 若订阅/发射其事件，版本号按 **2** |

**【事实·example-plugin / verification.md §5】对手册的**两处真实修正**（实现时必须遵守）：**

1. **`output.schema` 的对象层不接受 `required`**：`defineTool` 的 value schema DSL **只支持属性级 `required: true`**，对象层写 `required` 会抛 `JsonSchemaError`。真实范例见 `packages/example-plugin/src/index.ts:57-64`。
2. **消费 DSH 类型声明必须开 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`**（`tsconfig.base.json` 已配）：否则 DSH 的 `.d.ts` 间 `.ts` 互引会导致 `declare module '@deepseek-ai/cordis'` 类型增强被静默丢弃（症状：`ctx.tools`/`ctx.systemPrompt` 不存在）。

**【事实·0.2.1-rc.3 源码实测】本规格用到的真实契约：**

- 服务键：**`ctx.agentTeams`**（`packages/experimental/agent-team`，`@deepseek-ai/dsh-experimental-agent-team`）。
- durable session 事件（`agent-team/src/types.ts:227-240`）：`team/member`(**v2**)、`team/task`(**v2**)、`team/message/queued`(**v2**)、`team/message/delivered`(**v2**)。
- 原生模型工具（`@deepseek-ai/dsh-experimental-tool-agent-team`，`inject=['agents','agentTeams','tools','systemPrompt']`）：`spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` / `team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`；提示段 `team:policy`(order 60)、`team:identity`。
- 团队 bundle 最佳模板（`packages/experimental/agent-team-profile`）：`cordis.patch.yml` **先 `disabled: true` 关掉 legacy 行**（`tool-subagent-control` / `tool-subagent-list-agents` / `tool-subagent` / `tool-subagent-fork`），**再 `insert:`** `agent-team` / `tool-agent-team` / `ui-agent-team` 行；`src/index.ts` 为空模块（运行时内容是 patch）。
- 插件两形态与导出陷阱、`ctx.effect`/`ctx.on` 回滚、事件 5 种派发模式（`emit/parallel/serial/bail/waterfall`）、`Config`=schemastery、`dsh.bundle.patch` 声明——均【事实·plugin-dev-guide §2/§3】。

---

## 1. 命名规范与包清单

**【设计主张】命名规则**：项目名 `dsh-swarm`（用户明确要求，**不是** team）。原设计的 `@dsh-team/*` 一律把 scope 替换为 **`@dsh-swarm/*`**；bundle 为 **`@dsh-swarm/bundle`**。包内 cordis 插件名（`export const name`）与 `cordis.patch.yml` 的 row id 保持一致（对齐 example-plugin：`name='example-plugin'` ↔ row id `example-plugin`）。

### 1.1 完整包名清单

| 包名 | cordis 插件名 / row id | 服务键 | 阶段 | 一句话 |
|---|---|---|---|---|
| `@dsh-swarm/team-core` | `team-core` | `ctx.teamCore` | 0 | 团队协作稳定端口（TeamCorePort）+ 两种后端 |
| `@dsh-swarm/bundle` | —（bundle） | — | 0 | 组合层：关 legacy 行、插团队能力行 |
| `@dsh-swarm/team-bus` | `team-bus` | `ctx.teamBus` | 1 | 广播 / 多播 / topic 群聊 |
| `@dsh-swarm/team-scheduler` | `team-scheduler` | `ctx.teamScheduler` | 1 | 幂等调度扫描（含 stale 自愈模块） |
| `@dsh-swarm/team-review` | `team-review` | `ctx.teamReview` | 1 | 验证闸 + 裁决数学 |
| `@dsh-swarm/team-completion` | `team-completion` | `ctx.teamCompletion` | 1 | 团队完成判定 |
| `@dsh-swarm/team-prompt` | `team-prompt` | （用 `ctx.systemPrompt`） | 1 | 团队段落装配 |
| `@dsh-swarm/tool-swarm` | `tool-swarm` | （用 `ctx.tools`） | 1 | 暴露 bus/scheduler/review 的模型工具 |

> 阶段 2+（本规格**不实现**，仅登记）：`team-skills`、`team-memory`、`team-compaction`、`team-workspace`、`transport-*`、`channels`、`host-bridge`、Web UI。命名沿用 `@dsh-swarm/<能力>`。

### 1.2 与 DSH 原生包的关系

**【事实】** 阶段 0 复用 DSH 原生 `@deepseek-ai/dsh-experimental-agent-team`（`ctx.agentTeams`）与 `@deepseek-ai/dsh-experimental-tool-agent-team`（工具）。
**【设计主张】** dsh-swarm 的插件**不直接依赖**实验包的实现类型，只通过 `ctx.teamCore` 端口交互（见 §4.1）；`team-core` 是唯一直接 import 实验包类型的包。这样 P3-spike 若判定原生死，只需换 `team-core` 的后端实现。

---

## 2. 阶段 0/1 范围界定

### 2.1 做（本规格覆盖）

- **阶段 0（MVP，复用原生跑通最小协作）**：`@dsh-swarm/team-core` + `@dsh-swarm/bundle`（挂原生 `agent-team` + `tool-agent-team`）。产出一个可加载、可验证的团队协作最小闭环（Lead + teammate + DM + 共享任务 DAG）。
- **阶段 1（协作内核补全）**：`team-bus`、`team-scheduler`、`team-review`、`team-completion`、`team-prompt`、`tool-swarm`。补齐 DSH 原生**完全缺失**的四项（广播群聊、自动派发、验证闸、完成判定）。

### 2.2 不做（明确排除，避免范围膨胀）

| 不做 | 归属 | 依据 |
|---|---|---|
| 跨进程/分布式传输 | 阶段 3 `transport-*` | 迁移设计阶段 3 |
| worktree/文件锁 | 阶段 2 `team-workspace` | 同上 |
| 技能可见性 / 团队记忆 / 上下文压缩 | 阶段 2 | 同上 |
| 人类成员席位 / 群聊 Web UI | 阶段 3 + Web 层 | 同上 |
| preset 平面（B2） | **不用** | 阶段 0/1 能力全部编进 bundle host 树 |
| 自建 `TeamCoreOwned` 后端 | **仅当 P3-spike 判定原生死时**才实现（见 §4.1.3 gate） | 任务约束「两种情形都覆盖」 |
| 复用 `core/multi_agent` legacy、DAO、pyzmq 细节 | **永不做** | 迁移设计 §6 负面清单 |

---

## 3. 公共约定（所有包共享）

### 3.1 包内文件结构（对齐 `example-plugin`）

```
packages/<pkg>/
├── src/index.ts          # 插件实现（唯一入口）
├── src/<module>.ts        # 可选：拆分的内部模块（不导出）
├── cordis.patch.yml       # 仅 bundle 包/自带行的包需要（见 §5）
├── tests/<pkg>.spec.ts    # vitest 单测
├── tsconfig.json          # extends ../../tsconfig.base.json
└── package.json
```

**【事实·example-plugin/tsconfig.json】** 子包 tsconfig：`{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "lib" }, "include": ["src"] }`。

### 3.2 `package.json` 约定（对齐 example-plugin 实测字段）

```jsonc
{
  "name": "@dsh-swarm/team-bus",
  "version": "0.0.1",
  "private": true,                                  // 阶段 0/1 未发布前保留
  "description": "One-line purpose",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/index.d.ts"],
  "license": "MIT",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.1" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.2.1-rc.3",
    "@deepseek-ai/dsh-system-prompt": "^0.2.1-rc.3",
    "@deepseek-ai/dsh-agent": "^0.2.1-rc.3",
    "@deepseek-ai/dsh-session": "^0.2.1-rc.3",
    "@deepseek-ai/dsh-llm": "^0.2.1-rc.3"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/dsh-system-prompt": "0.2.1-rc.3",
    "@deepseek-ai/dsh-agent": "0.2.1-rc.3",
    "@deepseek-ai/dsh-session": "0.2.1-rc.3",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.3",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

> **【事实·example-plugin】** peer 用**独立的** semver 区间（`^0.2.1-rc.3`），**不是** 手册 monorepo 示例里的 `workspace:~`。原因：dsh-swarm 是独立仓，DSH 包来自 npm。
> **【事实·plugin-dev-guide B8】** peer 上的 `@deepseek-ai/dsh-*` 版本必须与 runtime 匹配，否则 profile 跳过该 bundle。
> **【设计主张】** 只依赖实际用到的 peer；`team-core` 额外可选依赖实验包（`peerDependenciesMeta.optional=true`），使「原生不可用」时仍能构建。

### 3.3 插件形态与导出（强制）

- **函数式插件**（默认选它）：**命名导出** `name` / `inject` / `Config` / `apply`，**禁止 default export**（default 会让 loader 丢 `inject`，【事实·postmortem 0001】）。
- **Service 子类**（需要 `ctx.<key>` 时）：`class X extends Service`、`static inject`、构造 `super(ctx,'key')`、**default export**。
- `Config`：`export interface Config` + `export const Config: z<Config> = z.object({...})`，字段默认值就近写；每字段必须 JSDoc（config 目录据此生成）。
- **【设计主张】** 本规格中 `team-core/team-bus/team-scheduler/team-review/team-completion` 用 **Service 形态**（需要暴露 `ctx.<key>`）；`team-prompt/tool-swarm` 用**函数式形态**（只注册贡献）。`export const name` 与 row id 同名。

### 3.4 生命周期钩子（强制）

- 一切注册（工具/section/事件订阅/定时器/子服务）必须经 `ctx.effect(() => disposer, '<label>')` 或 `ctx.on(...)`（返回 disposer），**保证 fiber 卸载即回滚**（【事实·plugin-dev-guide §2.4】）。
- Service 在构造里挂 `ctx.effect(() => () => this.dispose(), '<key>.lifecycle()')`。
- **禁止**在插件里做不可回滚的持久化副作用；durable 状态一律走 `session/event`（见 §3.6）。
- HMR 安全：重复 apply → 注册可叠加但卸载必须净空；单测须覆盖「注册 → dispose → 归零」（对齐 example-plugin 第 5 个用例）。

### 3.5 失败降级（统一原则）

【设计主张】每个插件必须声明 `degrade` 行为，且降级**不得阻断 DSH 主循环**：
- 依赖服务缺失：cordis 的 `inject` 会**等待**而非报错；若某依赖声明为可选（`ctx.inject`/`peerDependenciesMeta`），缺失时插件进入**no-op 模式**并 `ctx.logger.warn`。
- 运行时异常：捕获后记日志并返回结构化失败（工具返回 `isError` 结果），**不抛到 loop**。
- 降级必须在 `Config` 里有开关或自动判定，并在验收中可观测。

### 3.6 事件命名空间（强制）

【设计主张】dsh-swarm 自有 durable 事件用 **`swarm/*`** 前缀（与 DSH 原生 `team/*` 区分），通过 declaration merging 增强 `@deepseek-ai/dsh-session/types` 的 `SessionEventMap`：

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'swarm/message/broadcast': { version: 1; teamId: TeamId; message: BroadcastSnapshot }
    'swarm/review/submitted':  { version: 1; teamId: TeamId; taskId: TeamTaskId; revision: number }
    'swarm/review/vote':       { version: 1; teamId: TeamId; taskId: TeamTaskId; vote: ReviewVote }
    'swarm/review/settled':    { version: 1; teamId: TeamId; taskId: TeamTaskId; verdict: ReviewVerdict }
    'swarm/team/completed':    { version: 1; teamId: TeamId; snapshot: CompletionSnapshot }
  }
}
```

- **订阅**原生事件用 `ctx.on('session/event', (session, ev) => ...)` 后按 `ev.type` 过滤（【事实·0.2.1 源码：`ctx.on('session/event', ...)` 是真实用法】）。
- **发射**新事件：append 到 Lead Session 日志（经 `ctx.sessions`，参考原生 agent-team 的 journal 写法）；**只发 durable 事实，不把可变对象塞进事件**。
- **禁止**擅自改原生 `team/*` 事件的 `version`（B12：现为 2）。

### 3.7 持久数据校验（替代已移除的 invariant，B1）

【设计主张】不引入 invariant 伴侣包。策略：
- **写侧不做**：新事件在 append 前由插件内私有函数做轻量结构校验（类型 + 关键字段非空 + revision 连续）。
- **读侧过滤**：`fold` 折叠时对 malformed 记录**跳过并计数**，而非抛错。
- 单测覆盖「malformed 记录被安全跳过」。

---

## 4. 逐包实现规格

> 每包给出：职责 / 依赖 / 接口（TS 签名）/ 生命周期钩子 / 失败降级 / 订阅·发射事件 / 验收标准。
> 公共类型引用：`Agent`（`@deepseek-ai/dsh-agent`）、`ContentBlock`（`@deepseek-ai/dsh-llm`）、`SessionId`（`@deepseek-ai/dsh-session`）。

### 4.1 `@dsh-swarm/team-core`（TeamCorePort）★阶段 0

**职责一句话**：把「团队协作记录」（花名册/信箱/任务）暴露为一个**稳定的 `ctx.teamCore` 端口**，内部可切换 DSH 原生 `ctx.agentTeams` 或自建后端。

**依赖**：
```ts
static inject = ['agents', 'sessions', 'subagents']           // 原生后端额外需要 'agentTeams'
// agentTeams 作为可选依赖，见 §3.2 peerDependenciesMeta
```

**对外接口（TS 签名级）**：
```ts
import { Service, Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context { teamCore: TeamCore }
}

export type TeamRole = 'lead' | 'teammate'
export type MemberPhase = 'provisioning' | 'active' | 'failed'
export type MemberStatus = 'running' | 'idle' | 'inactive'

export interface MemberView {
  id: string
  name: string
  role: TeamRole
  phase: MemberPhase
  status: MemberStatus
  desc?: string
}

export type MessageRange =
  | { kind: 'dm'; to: string }
  | { kind: 'multicast'; targets: string[] }
  | { kind: 'broadcast' }

export interface TaskView {
  id: string
  revision: number
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blockedBy: string[]
  ownerName?: string
  ready: boolean
}

export interface TeamMembership { id: string; role: TeamRole; name: string }

export interface TeamCore {
  readonly backend: 'native' | 'owned'

  membership(agent: Agent): TeamMembership
  listMembers(agent: Agent): MemberView[]

  spawn(caller: Agent, req: {
    name: string; description: string; prompt: ContentBlock[]
    context: 'fresh' | 'fork'; provider: string; signal: AbortSignal
  }): Promise<MemberView>

  /** 统一消息入口：range 决定 DM/多播/广播（阶段 0 仅支持 dm，多播/广播由 team-bus 提供）。 */
  send(caller: Agent, req: {
    range: MessageRange; content: ContentBlock[]; delivery: 'quiet' | 'wakeup'
  }): Promise<{ messageId: string; status: 'accepted' | 'queued' }>

  createTask(caller: Agent, req: {
    subject: string; description: string
    blockedBy?: string[]; writeScopes?: string[]
  }): Promise<TaskView>
  getTask(caller: Agent, id: string): TaskView
  listTasks(caller: Agent): TaskView[]
  updateTask(caller: Agent, req: {
    taskId: string; expectedRevision: number
    action: 'claim' | 'release' | 'edit' | 'set_dependencies' | 'complete' | 'reopen' | 'assign' | 'delete'
    subject?: string; description?: string; blockedBy?: string[]; owner?: string
  }): Promise<TaskView>

  waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<{ timedOut: boolean }>
  interrupt(caller: Agent, targetName: string): Promise<{ previousStatus: MemberStatus }>
  tryMembership(agent: Agent): TeamMembership | undefined
}
```

**后端切换（两种情形都覆盖）**：
```ts
export interface Config {
  /** 'auto' 优先用原生 agentTeams，不可用则回落 owned。 */
  backend: 'native' | 'owned' | 'auto'
  maxMembers: number        // 默认 8
  maxTasks: number          // 默认 256
  maxMessageBytes: number   // 默认 65536
}
```
- `4.1.1 TeamCoreDsh`（`backend='native'`）：**薄适配**，把上述方法逐条委派给 `ctx.agentTeams`（`spawnTeammate/sendMessage/createTask/getTask/listTasks/updateTask/waitForChange/interrupt/membership/tryMembership`，【事实·0.2.1 源码】）。适配差异：原生 `sendMessage` 只支持单目标 → `range.kind==='dm'` 直通，`multicast/broadcast` 抛 `TEAMCORE_RANGE_UNSUPPORTED`（由 `team-bus` 承接）。
- `4.1.2 TeamCoreOwned`（`backend='owned'`）：**自建后端**——用 `ctx.sessions` 的 Lead Session 日志 + 本包 `swarm/team/*` durable 事件 + `fold` 重建 roster/task/mailbox；成员创建经 `ctx.subagents`（continuable child）。
- `4.1.3 gate`：`TeamCoreOwned` **只在 P3-spike 判定原生不可用（或 `backend='owned'`）时实现**；在此之前 `backend='owned'` 抛 `TEAMCORE_BACKEND_UNAVAILABLE` 并给出明确指引。【设计主张】

**生命周期钩子**：
- Service 构造 `super(ctx, 'teamCore')`；`ctx.effect(() => () => this.dispose(), 'teamCore.lifecycle()')`。
- 监听 `ctx.on('agent/session-start', ...)` 触发 owned 后端的恢复折叠（native 后端委派原生恢复）。

**失败降级**：`backend='auto'` 且 `ctx.agentTeams` 缺失 → 回落 owned（若 owned 未实现则进入 **no-op 模式**：`listMembers→[]`、`listTasks→[]`、其余抛 `TEAMCORE_UNAVAILABLE`），仅告警不阻断单 agent。

**订阅/发射事件**：
- 订阅：`session/event`（owned 后端折叠 `swarm/team/*` + 原生 `team/*`）；`agent/session-start`。
- 发射（owned）：`swarm/team/member`、`swarm/team/task`、`swarm/team/message/*`（**仅 owned 后端**；native 后端由实验包发 `team/*` v2）。

**验收标准（可执行）**：
1. `pnpm test`：`backend='native'` 下 `send(dm)` 委派到 mock `ctx.agentTeams.sendMessage` 且参数一致。
2. `backend='auto'` 且 mock 无 `agentTeams` → 不抛错，`listMembers()===[]` 且日志含 `team-core: native backend unavailable`。
3. `multicast/broadcast` 在 native 后端抛 `TEAMCORE_RANGE_UNSUPPORTED`。
4. `ctx.teamCore` 类型在消费包中可解析（`ctx.teamCore.listTasks(agent)` 通过 tsc）。
5. `pnpm verify`：真实 cordis 加载后 `ctx.teamCore` 存在、fiber 卸载后服务消失。

---

### 4.2 `@dsh-swarm/team-bus`（广播 / 多播 / topic 群聊）★阶段 1

**职责一句话**：在 `ctx.teamCore` 的 DM 之上补**广播 / 多播 / 主题扇出**，并保证「内容落库 + 信号走总线」。

**依赖**：
```ts
static inject = ['teamCore', 'sessions', 'tools']
```

**对外接口（TS 签名级）**：
```ts
declare module '@deepseek-ai/cordis' { interface Context { teamBus: TeamBus } }

export type TeamTopic = 'team' | 'task' | 'message' | 'announce'

export interface BroadcastSnapshot {
  id: string; senderId: string; senderName: string; topic: TeamTopic
  content: ContentBlock[]; delivery: 'quiet' | 'wakeup'
}

export interface TeamBus {
  /** 主题订阅；返回 disposer。 */
  subscribe(agent: Agent, topic: TeamTopic, handler: (ev: BroadcastSnapshot) => void): () => void
  /** 广播：1 次持久化 + 全员扇出；唤醒每个非发送者。 */
  broadcast(caller: Agent, req: { topic?: TeamTopic; content: ContentBlock[]; delivery: 'quiet' | 'wakeup' }): Promise<{ messageId: string }>
  /** 多播：一次事务写入 N 个收件人；targets 恰为全体时拒绝，强制走 broadcast。 */
  multicast(caller: Agent, req: { targets: string[]; content: ContentBlock[]; delivery: 'quiet' | 'wakeup' }): Promise<{ messageId: string }>
}

export interface Config {
  maxFanout: number           // 默认 64
  maxMessageBytes: number     // 默认 65536
}
```

**实现要点（对照 JiuwenSwarm 原语 P3/P4/P5）**：
- `broadcast`：append 一条 `swarm/message/broadcast`（`toMemberName=null`）→ 对全体成员按**水位线**扇出信号；每个非发送者读到 → 唤醒（【事实·T2 双轨模型】）。
- `multicast`：对 N 个目标各写一条 durable 消息（**单次 flush**）→ 扇出 N 信号；**原子**：整批失败回滚。
- **防滥用（迁移 P4 规则，【事实·T2】）**：`targets` 恰为全体 → 拒绝并提示改用 broadcast；`targets` 含 `'*'`/`'user'` → 拒绝；正文超 `maxMessageBytes` → 拒绝。

**生命周期钩子**：`ctx.effect` 撤销全部 topic 订阅；监听 `session/event`，在 cold-resume 时对未投递广播补投。

**失败降级**：multicast 事务失败 → 整批回滚并返回 `isError`（不部分投递）；bus 服务不可用 → `tool-swarm` 的广播工具退化为**循环 DM**并标注无原子性。

**订阅/发射事件**：订阅 `session/event`；发射 `swarm/message/broadcast`（durable）+ `session/event` 实时监听点。

**验收标准**：
1. `broadcast` 后，除发送者外每成员各收到 1 条；发送者 0 条（自过滤）。
2. `multicast([a,b])` 产生 2 条 durable 消息；`multicast(全体)` 抛 `TEAMBUS_REDUNDANT_BROADCAST`。
3. 正文超限 → `TEAMBUS_MESSAGE_TOO_LARGE`，且**无**任何 durable 写入。
4. 卸载 fiber 后所有 topic 订阅归零（HMR 安全）。

---

### 4.3 `@dsh-swarm/team-scheduler`（幂等调度 + stale 自愈）★阶段 1

**职责一句话**：任何唤醒（团队事件 / 周期 tick）触发**同一对幂等扫描**——派发 ready 任务 + 推进评审；并内置「卡住任务自催→升级」。

**依赖**：
```ts
static inject = ['teamCore', 'teamBus', 'agents', 'systemPrompt']
```

**对外接口（TS 签名级）**：
```ts
declare module '@deepseek-ai/cordis' { interface Context { teamScheduler: TeamScheduler } }

export interface ScanReport {
  started: number
  reviewsDispatched: number
  staleNudged: number
  converged: boolean
}

export interface TeamScheduler {
  readonly mode: 'autonomous' | 'scheduled'
  /** 幂等；有界 fixpoint（最多 4 轮，模仿 TeamScheduler._MAX_SCAN_PASSES）。 */
  scan(agent: Agent): Promise<ScanReport>
  /** 团队事件 → 触发一次 scan（防抖）。 */
  onTeamEdge(agent: Agent, ev: { type: string }): void
  /** 装配（构造 + 首扫）；返回 disposer。 */
  arm(agent: Agent): () => void
}

export interface Config {
  mode: 'autonomous' | 'scheduled'          // 默认 'autonomous'
  pollMs: number                            // 默认 30000
  staleClaimIdleMs: number                  // 默认 600000（10min）
  staleEscalateStreak: number               // 默认 3
  busyTaskStatuses: Array<'pending' | 'in_progress'>  // 活跃=一人一活跃任务
}
```

**策略（对照 P9/P10/P12）**：
- `autonomous`：只做「nudge 空闲成员去认领」（不预派）；成员自 `claim`。
- `scheduled`：`reconcileStarts`——对无活跃任务的成员，取其最早 `ready && owner==成员` 的任务 CAS 启动 + 以 Lead 身份投消息唤醒；**同时**是这个 SSOT 的唯一 dispatcher。
- **stale 自愈（P12）**：对「自己欠工且超 `staleClaimIdleMs`」的成员追加 nudge；连续 `staleEscalateStreak` 次无果 → **由卡住者自己**向 Lead 发消息升级（不跨进程直催）。
- **并发门控**：沿用「一人一活跃任务」不变量，**不做**全局并发池（避免与 `ctx.jobs` 语义冲突）。

**生命周期钩子**：`ctx.effect(() => { const d = this.arm(lead); return d }, 'teamScheduler.lifecycle()')`；监听 `session/event`（`team/task`、`team/member`、`swarm/*`）与内部 `setInterval(pollMs)`（须随 fiber 卸载清除）。

**失败降级**：`scheduled` 扫描连续失败 → **自动降级为 `autonomous`** 并告警；`teamCore` 不可用 → 调度器进入 no-op（成员仍可自 claim）。

**订阅/发射事件**：订阅 `session/event`；**不新增 durable 事件**（调度是幂等推进行为，状态仍在 core）。

**验收标准**：
1. `autonomous` 下，新建 `ready` 任务 → 空闲成员被 nudge（收到 1 条唤醒来信）。
2. `scheduled` 下，同一状态 → `scan` 报告 `started>=1` 且任务进入 `in_progress`；**重复 `scan` 不再启动**（幂等）。
3. stale：mock 时钟推进 `staleClaimIdleMs` 后 1 次 nudge；连续 `streak` 次 → 产生 1 条给 Lead 的升级消息。
4. `scheduled` 连续抛错 N 次后 `mode` 变为 `autonomous`。
5. 卸载后 `setInterval` 被清除（无悬挂定时器）。

---

### 4.4 `@dsh-swarm/team-review`（验证闸 + 裁决数学）★阶段 1

**职责一句话**：任务完成时若配 reviewer，则**不直接完成**，进入评审；收集投票、按池聚合（二元一票否决 / 打分均值阈值）、settle 后 pass→完成+解锁 / fail→返工。

**依赖**：
```ts
static inject = ['teamCore', 'teamBus', 'agents', 'subagents', 'tools']
```

**对外接口（TS 签名级）**：
```ts
declare module '@deepseek-ai/cordis' { interface Context { teamReview: TeamReview } }

export type ReviewVote =
  | { kind: 'binary'; decision: 'pass' | 'fail'; role: 'verifier' | 'challenger' }
  | { kind: 'score';  value: number; role: 'inspector' }

export type ReviewVerdict =
  | { kind: 'undecided' }
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }

export interface TeamReview {
  /** 提交评审（in_progress → 评审态；阻止直接 complete）。 */
  submitForReview(caller: Agent, taskId: string): Promise<TaskView>
  /** 投票；同一 reviewer 后写覆盖。 */
  vote(caller: Agent, taskId: string, v: ReviewVote): Promise<void>
  /** 结算：按池聚合。 */
  settle(caller: Agent, taskId: string): Promise<ReviewVerdict>
  /** 查询某任务当前评审快照。 */
  inspect(taskId: string): { round: number; votes: ReviewVote[]; verdict?: ReviewVerdict } | undefined
}

export interface ReviewConfig {
  pools: Array<
    | { kind: 'binary'; rule: 'veto'; roles: string[] }
    | { kind: 'score'; threshold: number; roles: string[] }     // 默认 threshold 0.85
  >
  maxRounds: number          // 默认 3；超限升级 Lead 并停止自动返工环
  stallTimeoutMs: number     // 默认 1800000（30min）
}
```

**关键不变量（P8/P11）**：
- **不可自验**：`vote` 时校验 caller 不是任务作者，否则 `TEAMREVIEW_SELF_VOTE`。
- **评审态不进原生任务枚举**：DSH 原生 `TeamTaskStatus` 只有 `pending/in_progress/completed/deleted`（【事实·0.2.1】），**不篡改**；评审子态记录在自有 durable 事件 `swarm/review/*` 里，任务在评审期间保持 `in_progress`，**只有 pass 才调 `teamCore.updateTask(action='complete')`**，fail 则保持 `in_progress`（返工）。
- 裁决数学：**二元池**全员投完且任一 fail → fail（一票否决）；**打分池**全员投完且均值 ≥ `threshold` → pass；任一池未投完 → `undecided`。

**生命周期钩子**：`ctx.effect`；监听 `session/event`（任务 `complete` 意图 → 若配 reviewer 则拦截转评审）。

**失败降级**：**未配置 reviewer → 直接完成**（无门）；reviewer 子 agent 启不来 → 重试（≤3）后升级 Lead。

**订阅/发射事件**：订阅 `session/event`；发射 `swarm/review/submitted` / `swarm/review/vote` / `swarm/review/settled`。

**验收标准**：
1. 配 reviewer 的任务 `complete` 被拦截为 `submitForReview`（`inspect().round===1`）。
2. 二元池：任一 `fail` → `settle()=={kind:'fail'}`；全 `pass` → `{kind:'pass'}` 且任务 `completed` 并解锁下游。
3. 打分池：均值 ≥0.85 → pass；<0.85 → fail；未投完 → undecided。
4. 作者自投 → `TEAMREVIEW_SELF_VOTE`。
5. `maxRounds` 超限 → 产生 1 条升级 Lead 的消息且不再自动返工。

---

### 4.5 `@dsh-swarm/team-completion`（团队完成判定）★阶段 1

**职责一句话**：三条件合取（≥1 任务且全终态 + 全成员静止 + 无未读消息）时，**上升沿**发一次 `swarm/team/completed`。

**依赖**：
```ts
static inject = ['teamCore', 'teamBus', 'sessions']
```

**对外接口（TS 签名级）**：
```ts
declare module '@deepseek-ai/cordis' { interface Context { teamCompletion: TeamCompletion } }

export interface CompletionSnapshot { tasks: number; members: number }

export interface TeamCompletion {
  evaluate(agent: Agent): Promise<{ completed: boolean; snapshot?: CompletionSnapshot }>
  /** 任一团队边 → 重新评估。 */
  onEdge(agent: Agent): void
}

export interface Config {
  /** 未读消息是否阻止完成（对齐 JiuwenSwarm 三条件）。 */
  blockOnUnread: boolean     // 默认 true
}
```

**生命周期钩子**：`ctx.effect`；监听 `session/event`；只对 **Lead** 生效（完成是团队级信号）。

**失败降级**：判定不确定（有在飞轮次 / 未读消息）→ 返回 `completed:false`（**宁可晚完成，不可早完成**）。

**订阅/发射事件**：订阅 `session/event`；发射 `swarm/team/completed`（durable，上升沿一次；用内部 rearm 守卫）。

**验收标准**：
1. 全任务终态 + 全成员静止 + 无未读 → `evaluate` 返回 `completed:true` 且发出**恰好一次** `swarm/team/completed`。
2. 新增未读消息后 → `completed:false`。
3. 重复评估不产生第二次事件（上升沿守卫）。

---

### 4.6 `@dsh-swarm/team-prompt`（团队段落装配）★阶段 1

**职责一句话**：把团队策略/角色/下发/入站标签注册为**稳定 section**（进系统提示词前缀），把身份/roster/团队信息注册为 **cache-safe context**（不进前缀）。

**形态**：**函数式插件**（只注册贡献，无新服务）。

**依赖**：
```ts
export const inject = ['systemPrompt', 'teamCore', 'sessions'] as const
```

**对外接口（TS 签名级）**：
```ts
export interface Config {
  sections: Array<{ name: string; order: number; text: string | ((c: AssembleContext) => string) }>
  locales: 'cn' | 'en'          // 默认 'cn'
  leaderProgressiveDisclosure: boolean   // 默认 true
}
export function apply(ctx: Context, config: Config): void
```

**实现要点（对照 P15/P16）**：
- 稳定段 → `ctx.systemPrompt.section({ name, order, text })`：`team:role`(order 11)、`team:dispatch`(15)、`team:task-state`(16)、`team:inbound`(18)。
- 易变段 → `ctx.systemPrompt.context({ name, order, text })`：`team:identity`(10)、`team:roster`(20)、`team:info`(30)。
- **渐进披露**：注册 `ctx.on('system-prompt/assemble', ...)` waterfall 监听，Lead 只保留 bootstrap+extra 段，其余延后到 `build_team` 结果（对齐【事实·T7 F_76】）。
- 模板外置：段落文本从 `team-workspace` 可覆盖（阶段 1 先内置常量，阶段 2 接工作区覆盖）。

**生命周期钩子**：`ctx.effect(() => { const ds=[...sections]; const dc=[...contexts]; const off=ctx.on('system-prompt/assemble', ...); return () => { ds.forEach(d=>d()); dc.forEach(d=>d()); off() } }, 'team-prompt.sections()')`。

**失败降级**：section 重名 → DSH 语义**抛错**（装配前须校验）；模板缺失 → 用内置兜底文本。

**订阅/发射事件**：订阅 `system-prompt/assemble`（waterfall）；发射由 `ctx.systemPrompt` 自动产生 `system-prompt/change`。

**验收标准**：
1. 注册后系统提示词含 `team:role` 等稳定段，且**顺序按 order 升序**。
2. identity/roster 出现在 **context（用户消息）** 中而**不在** section 前缀（前缀稳定性可断言）。
3. Lead 的协作约定段在 `build_team` 结果中才出现（渐进披露）。
4. dispose 后所有 section/context 归零。

---

### 4.7 `@dsh-swarm/tool-swarm`（模型工具）★阶段 1

**职责一句话**：把 `team-bus` / `team-scheduler` / `team-review` 的**增量能力**暴露为模型工具（原生 `tool-agent-team` 没有的部分）。

**形态**：函数式插件；**Agent-scoped** 安装（对齐原生 `tool-agent-team` 的 `agent.ctx` 模式）。

**依赖**：
```ts
export const inject = ['agents', 'teamCore', 'teamBus', 'teamReview', 'tools', 'systemPrompt'] as const
```

**对外接口（工具清单，TS 签名级）**：
```ts
// 工具（defineTool；output 必填，required 写在属性级）
// 1) broadcast        { topic?, content, delivery } → 全体
// 2) multicast        { targets, content, delivery } → 多目标
// 3) review_submit    { task_id }
// 4) review_vote      { task_id, decision|value, role }
// 5) team_summary     {} → 看板/成员/评审快照
export interface SwarmToolConfig {
  enableBroadcast: boolean   // 默认 true
  enableReview: boolean      // 默认 false（需先配 review 池）
}
```

**生命周期钩子**：`ctx.effect(() => { const ds = installForAgents(ctx); return () => ds.forEach(d=>d()) }, 'tool-swarm.scoped()')`；监听 `agent/created` / `agent/disposed` 做 scope 安装/清理（对齐【事实·T8 tool-agent-team】）。

**失败降级**：某依赖服务缺失 → 对应工具**不注册**（而非注册后报错）；`enableReview=false` 时不暴露评审工具。

**订阅/发射事件**：不发射 durable 事件；工具执行结果走 `isError` 语义。

**验收标准**：
1. 全依赖在位时注册 5 个工具；缺 `teamBus` 时 `broadcast/multicast` 不出现。
2. `broadcast` 工具执行后等价调用 `ctx.teamBus.broadcast`。
3. 每个工具的 `output.schema` 通过 value schema DSL 校验（属性级 required）。
4. Agent dispose 后其 scope 内工具归零。

---

## 5. bundle 组装（`@dsh-swarm/bundle`）★阶段 0 起

**职责**：一个 bundle 包，按 `agent-team-profile` 范式把上述插件行组装进 DSH 组合树。

### 5.1 `package.json`

```jsonc
{
  "name": "@dsh-swarm/bundle",
  "version": "0.0.1",
  "private": true,
  "description": "dsh-swarm 协作能力 bundle：在 dsh-base 之上层叠团队插件行",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "cordis.patch.yml"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@dsh-swarm/team-core": "workspace:~",
    "@dsh-swarm/team-bus": "workspace:~",
    "@dsh-swarm/team-scheduler": "workspace:~",
    "@dsh-swarm/team-review": "workspace:~",
    "@dsh-swarm/team-completion": "workspace:~",
    "@dsh-swarm/team-prompt": "workspace:~",
    "@dsh-swarm/tool-swarm": "workspace:~",
    "@deepseek-ai/dsh-experimental-agent-team": "^0.2.1-rc.3",
    "@deepseek-ai/dsh-experimental-tool-agent-team": "^0.2.1-rc.3"
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-base": "^0.2.1-rc.3",
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "engines": { "dsh": "0.2.1-rc.3" }
}
```

> **【事实·agent-team-profile】** `exports` 必须含 `"./cordis.patch.yml"`；`dsh.bundle.patch` 指向 patch 文件。
> **【事实·plugin-dev-guide B8】** `engines.dsh`（或 peer 匹配）决定 profile 是否跳过该 bundle。
> **【设计主张】** 阶段 0 可先只依赖 `team-core` + 原生两包；阶段 1 追加其余依赖（保持同一 bundle，避免多 bundle 的层叠复杂度；B7 允许后续拆多为有序 patch 文件）。

### 5.2 `cordis.patch.yml`（沿用 agent-team-profile 范式）

```yaml
# 施加在 dsh-base 之后：先关掉与团队工具冲突的 legacy 全局行，再插入 dsh-swarm 能力行。
# 行序不承载加载语义，激活由服务可用性驱动（plugin-dev-guide §3.2）。

# —— 关闭 legacy 直属委派行（对齐 agent-team-profile 的处理）——
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true

# —— 阶段 0：挂 DSH 原生团队域 + 工具（复用，不重造）——
- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config:
        maxMembers: 8
        maxTasks: 256
        maxMessageBytes: 65536
        disposalTimeoutMs: 5000

    - id: tool-agent-team
      name: '@deepseek-ai/dsh-experimental-tool-agent-team'
      config:
        freshProvider: spawn
        forkProvider: fork

    - id: team-core
      name: '@dsh-swarm/team-core'
      config:
        backend: auto
        maxMembers: 8
        maxTasks: 256
        maxMessageBytes: 65536

# —— 阶段 1：追加协作内核补全插件（依赖可用性驱动激活）——
    - id: team-prompt
      name: '@dsh-swarm/team-prompt'
      config:
        locales: cn
        leaderProgressiveDisclosure: true

    - id: team-bus
      name: '@dsh-swarm/team-bus'
      config:
        maxFanout: 64
        maxMessageBytes: 65536

    - id: team-review
      name: '@dsh-swarm/team-review'
      config:
        pools:
          - { kind: binary, rule: veto, roles: [verifier, challenger] }
        maxRounds: 3
        stallTimeoutMs: 1800000

    - id: team-scheduler
      name: '@dsh-swarm/team-scheduler'
      config:
        mode: autonomous
        pollMs: 30000

    - id: team-completion
      name: '@dsh-swarm/team-completion'
      config:
        blockOnUnread: true

    - id: tool-swarm
      name: '@dsh-swarm/tool-swarm'
      config:
        enableBroadcast: true
        enableReview: false
```

**行顺序与 disabled/insert 关系（照 agent-team-profile 范式）**：
- **先 `disabled: true` 关冲突 legacy 行**（4 个 `tool-subagent*`），**再 `insert:`** 自建行。
- 阶段 0 与阶段 1 的 insert 行**同属一个 patch 文件**；未实现的包（阶段 1）在其包就绪后再追加（或拆为多个有序 patch 文件，B7）。
- **不覆盖** `dsh-base` 的 `spawn` provider（保留给 workflow）；仅关直属委派工具。

### 5.3 装配与验证命令

```sh
# 在隔离环境内（source scripts/env.sh 后）
corepack pnpm build
corepack pnpm test
corepack pnpm verify                      # 真实 cordis 加载 + 观察注册
# 整机联调（需完整 dsh-base，超出阶段 0/1 范围，阶段 3 再做）：
# dsh plugin --profile web add ./packages/bundle
# dsh --profile web --dump-config
```

---

## 6. 目录与包内文件约定

### 6.1 仓库目录（扩展 example-plugin）

```
dsh-swarm/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json   # 已存在，勿改
├── packages/
│   ├── example-plugin/          # 已有（基线参照，勿动）
│   ├── team-core/               # 阶段 0
│   │   ├── src/index.ts         # Service 形态
│   │   ├── tests/team-core.spec.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── bundle/                  # 阶段 0
│   │   ├── src/index.ts         # 空模块（`export {}`，运行时内容是 patch）
│   │   ├── cordis.patch.yml
│   │   └── package.json
│   ├── team-bus/  team-scheduler/  team-review/  team-completion/  team-prompt/  tool-swarm/   # 阶段 1
└── docs/
    ├── implementation-spec.md   # 本文件
    └── package-layout.md
```

### 6.2 包内文件（强制对齐 example-plugin）

| 文件 | 约定 |
|---|---|
| `src/index.ts` | 唯一入口；模块头 `@module @dsh-swarm/<pkg>`；命名导出或 Service default（见 §3.3） |
| `tests/<pkg>.spec.ts` | vitest；用**假 ctx** 断言 apply 行为（对齐 example-plugin.spec.ts 的 `makeCtx`） |
| `tsconfig.json` | `{"extends":"../../tsconfig.base.json","compilerOptions":{"rootDir":"src","outDir":"lib"},"include":["src"]}` |
| `cordis.patch.yml` | 仅 bundle 或自带行的包需要；`insert:` 自己的 row |
| `package.json` | 见 §3.2；`name`/`main`/`types`/`exports`/`scripts`/`dsh`(bundle 包) |

---

## 7. 测试策略与「什么算完成」

### 7.1 三层测试

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | vitest（假 ctx） | 导出形态（含「无 default export」）、Config 默认值/校验、apply 注册、工具执行/ render、HMR 安全（disposer 归零）、malformed 记录跳过、降级分支 |
| 加载 | `scripts/verify-load.mjs`（真实 cordis） | 插件可被真实 cordis `ctx.plugin()` 加载；观察工具/section/服务；fiber `dispose` 后注册归零 |
| 组合 | `--dump-config`（阶段 3 才做） | profile 组合树中出现 dsh-swarm 行；`skippedBundles` 为空（版本匹配） |

> **【事实·verification.md】** 阶段 0 骨架已实测：`pnpm build`（tsc）→ `pnpm test`（vitest）→ `pnpm verify`（真实 cordis 加载 + 观察）全通过。团队插件沿用同一脚本。
> **【事实·plugin-dev-guide §6】** DSH 官方覆盖率门禁是**逐文件 100%**；**【设计主张】** dsh-swarm 阶段 0/1 先要求「新增文件行覆盖 ≥ 80% 且关键分支（降级/幂等/自过滤）100%」，不作逐文件 100% 硬门禁（降低早期摩擦），阶段 2 再收紧。

### 7.2 「什么算完成」（每包可执行的 Definition of Done）

一个包**完成**当且仅当：
1. `corepack pnpm build` 成功（tsc 无错，产出 `lib/index.js` + `lib/index.d.ts`）。
2. `corepack pnpm typecheck` 成功（含跨包 `ctx.teamCore` 等类型增强可解析）。
3. `corepack pnpm test` 全绿，且**覆盖本包 §4.x 列出的全部验收标准**（逐条对应测试用例名）。
4. `corepack pnpm verify` 通过：真实 cordis 加载后**观察到**该包声明的服务/工具/section；dispose 后归零。
5. `corepack pnpm lint` + `format:check` 通过。
6. 包内 README（可选但推荐）含 `## Model Experience` / `## Known Limitations`（DSH monorepo gate 沿用，【事实·plugin-dev-guide §4 #17】）。

### 7.3 集成 DoD（阶段级）

- **阶段 0 完成**：`bundle` 的 patch 能被组合器接受；`team-core` + 原生 `agent-team`/`tool-agent-team` 三者共存；一个 smoke 用例跑通「spawn teammate → DM → 建任务 → 认领 → 完成」。
- **阶段 1 完成**：四个新增能力（broadcast / scheduled 派发 / review 闸 / completion）各自 DoD 达标，且**关掉 `@dsh-swarm/bundle` 后回到纯 DSH 行为（零残留）**。

---

## 8. 与迁移设计的映射与偏离

| 迁移设计元素 | 本规格落地 | 说明 |
|---|---|---|
| `@dsh-team/*` 命名 | `@dsh-swarm/*` | 用户要求替换 scope（§1） |
| `team-core`（TeamCorePort） | `@dsh-swarm/team-core`，`backend: native\|owned\|auto` | 覆盖「原生可用/不可用」两情形（§4.1） |
| `team-bus` / `team-scheduler` / `team-review` / `team-completion` / `team-prompt` | 同名 `@dsh-swarm/*` | 阶段 1 |
| `team-stale` 独立包 | **并入 `team-scheduler` 内部模块** | 【设计主张】减包数；stale 与 scan 同 tick 天然耦合，可日后拆出 |
| 三组插件（消息/编排/提示词） | 阶段 0/1 落到「core+原生 / 编排四件套 / prompt」 | 提示词层阶段 1 只做 prompt；skills/memory/compaction 阶段 2 |
| `@dsh-team/bundle` | `@dsh-swarm/bundle` | 单 bundle；B7 允许以后拆多 patch |
| 跨进程/技能/记忆/worktree/Web | **本规格排除** | §2.2 |

**与手册的显式差异（均按手册/真实代码为准）**：
1. 手册 §2.2 示例把 `required` 写在对象层 → **错误**，真实是属性级（§0）。
2. 手册 monorepo 示例用 `workspace:~` → dsh-swarm 独立仓用 **semver 区间**（对齐 example-plugin）。
3. 手册说事件派发 4 种 → 真实 **5 种**（含 `bail`）。
4. `main/types` 路径：手册示例 `lib/types/index.d.ts` → example-plugin 实际 `lib/index.d.ts`（**以 example-plugin 为准**）。

---

## 9. 待 P3-spike 与实现期确认

1. **P3-spike 结论**（任务已注明未出）：决定 `team-core` 默认 `backend` 与是否实现 `TeamCoreOwned`。本规格已用端口隔离使两种情形都可切换。
2. **`ctx.agentTeams` 的 `inject` 名称**：原生 tool-agent-team 用 `inject=['agents','agentTeams','tools','systemPrompt']`（【事实】）；`team-core` 的 `agentTeams` 应声明为**可选**以避免原生缺失时卡住（cordis `inject` 缺失即等待）。
3. **durable 事件 append API**：`swarm/*` 事件经 `ctx.sessions` 的具体 append 调用点需在实现时对 0.2.1-rc.3 源码核验（参考 agent-team 的 journal 写法）。
4. **评审子态表达**：本规格选择「不改原生任务枚举、评审子态存自有事件」。若发现与原生 `updateTask` 的 `complete` 语义冲突，退路是评审期间保持任务 `in_progress` 并在 `team-review` 内部记账（已按此设计）。
5. **覆盖率门禁**：是否在阶段 2 收紧到逐文件 100%。

---

## 附录 A. 证据索引

- 手册：`docs/plugin-dev-guide.md`（§0 版本、§1 破坏性变更、§2 插件契约、§3 bundle、§4 forge 对照、§6 构建测试）
- 环境：`docs/env-setup.md`（隔离 Node/pnpm/DSH_HOME、网络注意）
- 验证：`docs/verification.md`（构建/测试/加载实测 + 两处契约修正）、`README.md`
- 写法基准：`packages/example-plugin/{src/index.ts,package.json,cordis.patch.yml,tsconfig.json,tests/example-plugin.spec.ts}`
- 0.2.1-rc.3 真实参考：`.runtime/deepseek-harness/packages/experimental/agent-team-profile/{package.json,cordis.patch.yml,README.md}`、`.runtime/deepseek-harness/packages/experimental/agent-team/src/types.ts`、`.runtime/deepseek-harness/packages/experimental/tool-agent-team/src/index.ts`
- 第三方真实插件仓：`/root/repo/dsh-plugin/dsh-ops-plugins/`
- 迁移设计：团队共享目录 `migration-design.md`、`final-report-jiuwen-to-deepseek-harness.md` 等

## 附录 B. 【事实】/【设计主张】分界

- **【事实】**：§0 全部、§1.2、§3.1–3.4、§5.1/5.2 的 DSH 契约引用、§6.2、§7.1–7.2 的脚本路径、§8「与手册的差异」。
- **【设计主张】**：§1.1 包清单、§2 范围划分、§3.5–3.7、§4 全部逐包设计（接口/降级/验收）、§5.2 的 patch 内容、§7.1 覆盖率口径、§9。

---

*（本文件由 migration-architect 产出；DSH 契约均为 0.2.1-rc.3 实测或手册核定，设计主张待 P3-spike 与实现验证。）*
