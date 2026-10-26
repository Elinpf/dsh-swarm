# dsh-swarm 实现规格（阶段 2：能力供给补全）

> 产出人：migration-architect（插件化迁移架构师）
> 任务：P6-spec-stage2 — 把实现规格从「阶段 0/1」扩展到「阶段 2」
> 定位：本文件是阶段 2 所有实现任务的**唯一依据**；与 `docs/implementation-spec.md`（阶段 0/1）保持同格式，冲突时以 `docs/plugin-dev-guide.md`（0.2.1-rc.3 核定版，含 §7 报错速查）为准。
> 约定：
> - `【事实】`：来自 `plugin-dev-guide.md`、`agent-team-spike.md`、`verification.md`、`adr/0001`、已实现的 9 包源码、或 `.runtime/deepseek-harness/`（0.2.1-rc.3 源码实测），均附来源。
> - `【设计主张】`：本规格提出、待实现验证的设计决策。
> - 版本锁定唯一：DSH `0.2.1-rc.3`（commit `1f81c047`）· `@deepseek-ai/cordis` `^4.0.1`（本机 4.0.5）· Node `^22.19.0 || >=24.0.0` · pnpm `11.28.5`。

---

## 0. 阶段 2 的事实基线

### 0.1 阶段 0/1 已落地（承接物）【事实·verification.md §P4】

- 远端 `main` = `2b63e6e`；**9 包已在真实 cordis 上加载验证通过、可装卸零残留**：
  `team-core-contract`（纯类型 SSOT）、`team-core`（`ctx.teamCore`，native 后端）、`team-bus`（`ctx.teamBus`）、`team-prompt`、`team-scheduler`（`ctx.teamScheduler`）、`team-review`（`ctx.teamReview`）、`team-completion`（`ctx.teamCompletion`）、`tool-swarm`、`bundle`。
- **契约分离已成惯例**（ADR-0001）：跨包类型只进 `@elinpf/dsh-swarm-team-core-contract`，业务包**禁止** import 实现包。
- 后端选择：**native**（`ctx.agentTeams`），`owned` 未实现（spike 判定原生可用）。
- **已知边界**【事实·verification.md §E】：未做整机 profile 级联调；端到端以「进程内冒烟 + 端口 mock」为准；`followup_task` / `interrupt_agent` 真机未探针。

### 0.2 spike 对阶段 2 能力的裁决【事实·agent-team-spike.md §5】

六项 JiuwenSwarm 特色能力在 DSH `agent-team` 里**全部没有直接 seam**，需新建插件承载。阶段 2 覆盖其中 **两项**（均为高优先级）：
- **worktree + 文件锁**（spike §5 #5：成员共享 cwd，`writeScopes` 仅建议非锁）；
- **技能可见性**（阶段 0/1 未覆盖；DSH 无 Team 专属可见性）。

另两项（**共享+成员记忆**、**团队上下文预算**）属迁移设计阶段 2 原定的「能力供给补全」。

### 0.3 阶段 2 相关 DSH seam（本规格实测）【事实·0.2.1-rc.3 源码】

| 能力 | DSH seam | 关键证据（文件/符号） | 能否承载 |
|---|---|---|---|
| worktree 隔离 | **`ctx.worktrees`（实验）** | `packages/experimental/worktree/src/index.ts:56`（`class WorktreeService extends Service`）、`:74`（`super(ctx,'worktrees')`）；`create(agent, request?, signal?)`；经 `ctx.workingDirectory.ensure/set` 切换会话目录 | ✅ **可复用** |
| 会话/成员工作目录 | `ctx.workingDirectory` | 实测多处 `ctx.workingDirectory.ensure(agent, signal)`（`context/agent-instructions`、`fs-local` 等） | ✅ 复用 |
| 文件锁 / 写域守卫 | **`ctx.fs` 的 `fs/write-intent` / `fs/edit-intent`（waterfall）** | `packages/fs/fs/src/index.ts:45-86`：`fs/write-intent` 返回 `FsWriteIntent \| undefined`，**首个返回 intent 的监听者独占决策**，`next()` 得到无条件写入；另有 `fs/observed`(emit) | ✅ **可承载守卫**（锁策略需自建） |
| 技能可见性 | **`ctx.skills`（host + per-scope 分层注册表）** | `packages/skill/skill/src/index.ts:356`（`class SkillRegistry extends Service`）、`:374`（`super(ctx,'skills')`）、`:439`（`register(skill): ()=>void`）、`:470`（`list`）、`:500`（`get`）；README：注册按**调用 context 的 scope 层**归档，读取合并 global 层 + 查看 scope 链，**最近层同名优先** | ✅ **可复用**（按成员 scope 注册/过滤） |
| 持久化（记忆） | `ctx.storage`（Storage hub） | `packages/storage/storage/src/index.ts:47`（`class Storage extends Service`）、`:54`（`super(ctx,'storage')`） | ✅ 复用 |
| 上下文预算/压缩 | `ctx.compaction`（CompactionEngine） | `packages/compaction/compaction/src/index.ts:119`（`abstract class CompactionEngine extends Service`）、`:121`（`super(ctx,'compaction')`）；`compactIfNeeded(agent, trigger, signal)`；事件 `compaction/summary-error`(waterfall) | ✅ **可复用**（策略需自建薄层） |
| 提示词注入 | `ctx.systemPrompt.section/context` | 阶段 0/1 已用（team-prompt） | ✅ 复用 |

> **【事实·plugin-dev-guide §7】value/parameter schema DSL 硬约束**（阶段 2 若加工具必须遵守）：
> ① 可选参数**省略** `required`（写 `required: false` 抛错）；② `output.schema` 的 `required: true` 只写**属性级**，对象层只写 `additionalProperties: false`；③ 只用白名单键（`type/properties/required/items/enum/oneOf/description/title/default/examples`），`minLength` 等报错；④ `output` 必填。
> **【事实·plugin-dev-guide §7.2】Service 形态经 `ctx.plugin()` 加载要传 `mod.default`。**

---

## 1. 命名规范与包清单（阶段 2）

**【设计主张】** 沿用阶段 0/1 命名：项目 `dsh-swarm`，scope `@elinpf/dsh-swarm-*`。阶段 2 新增 **4 个能力包 + 1 个契约包**，总包数 **9 → 14**。

| 包名 | 路径 | cordis 插件名 / row id | 服务键 | 形态 | 阶段 |
|---|---|---|---|---|---|
| `@elinpf/dsh-swarm-team-capability-contract` | `packages/team-capability-contract/` | —（纯类型，无 row） | — | 纯类型（无实现） | 2 |
| `@elinpf/dsh-swarm-team-workspace` | `packages/team-workspace/` | `team-workspace` | `ctx.teamWorkspace` | Service | 2 |
| `@elinpf/dsh-swarm-team-skills` | `packages/team-skills/` | `team-skills` | `ctx.teamSkills` | Service | 2 |
| `@elinpf/dsh-swarm-team-memory` | `packages/team-memory/` | `team-memory` | `ctx.teamMemory` | Service | 2 |
| `@elinpf/dsh-swarm-team-compaction` | `packages/team-compaction/` | `team-compaction` | `ctx.teamCompaction` | Service | 2 |

阶段 0/1 的 9 包不变。`tool-swarm` 允许**增量**加阶段 2 工具（见 §4.6，非新包）。

### 1.1 契约包的处置（继承 ADR-0001）★必读

**【设计主张】方案：新增一个独立契约包 `@elinpf/dsh-swarm-team-capability-contract`，承载阶段 2 全部四个 `ctx.team*` 端口类型与其类型增强；不把这些类型塞进 `team-core-contract`。** 理由：

1. **同一 cohort + 同一消费者**：四个阶段 2 端口同属「能力供给层」（对应迁移设计的三组插件中的能力供给部分），其跨包消费者是同一小集合（`team-prompt`、`tool-swarm`）。集中一个契约包即可覆盖，无需 4 个 `-contract` 包。
2. **`team-core-contract` 已冻结**：ADR-0001 定它是 `ctx.teamCore` 唯一 SSOT（「SSOT 唯一」）。把无关域类型塞入会稀释其语义并动摇已通过验证的包。
3. **编译期边界仍成立**：新契约包同样是**纯类型、零运行时导出**，业务包只能 `import type`，满足 ADR-0001「禁止直连实现」的强制力。
4. **成本可控**：与 `team-core-contract` 同构（`export {}` 运行时），多一个极小包换取清晰分层。

> **配套（§4.7）**：阶段 2 的**实现包**（`team-workspace` 等）依赖该契约包；契约包**不含** Service/后端/运行时逻辑，`dependencies` 无运行时依赖（仅 type-only peer）。

---

## 2. 阶段 2 范围界定

### 2.1 做（本规格覆盖）

| 包 | 一句话 | 承接迁移设计 |
|---|---|---|
| `team-workspace` | 成员工作区隔离（worktree）+ 文件锁/写域守卫 | 六项缺失能力之二（高优先级） |
| `team-skills` | 按团队/成员声明技能可见性，落到 `ctx.skills` scope 层 | 能力供给补全 |
| `team-memory` | 共享只读 TEAM_MEMORY + 成员私有记忆，经 `ctx.systemPrompt.context` 注入 | 能力供给补全 |
| `team-compaction` | 团队上下文预算/配额策略，消费 `ctx.compaction` | 能力供给补全 |
| `team-capability-contract` | 上述四端口的类型 SSOT | ADR-0001 延续 |

### 2.2 不做（明确排除，避免范围膨胀）

| 不做 | 归属 |
|---|---|
| 跨进程 / 分布式传输 | **阶段 3**（迁移设计阶段 3） |
| 人类成员席位 / 群聊 Web UI | **阶段 3** |
| preset 平面（B2/B3） | 不用（阶段 0/1 已定：能力编进 bundle host 树） |
| `team-core` 的 `owned` 自建后端 | 保持不实现（spike 判定 native 可用） |
| 自建 worktree 实现 | **复用** `ctx.worktrees`（实验），不重造 |
| 自建压缩算法 | **复用** `ctx.compaction`，只做团队预算策略 |
| 迁移 `core/multi_agent` legacy / DAO / pyzmq 细节 | 永不做（迁移设计 §6 负面清单） |

---

## 3. 公共约定（继承阶段 0/1，仅列阶段 2 增量）

- **目录/文件/package.json/tsconfig**：完全沿用 `implementation-spec.md` §3.1–§3.4 与已落地的 9 包写法。
- **插件形态**：需要 `ctx.<key>` 的用 **Service**（`export class XService extends Service implements X`、`static inject`、`super(ctx,'key')`、`export default`）；只注册贡献的用**函数式**（命名导出、无 default）。
- **生命周期**：一切注册经 `ctx.effect(() => disposer, '<label>')` / `ctx.on(...)`；Service 构造挂 `ctx.effect(() => () => this.dispose(), '<key>.lifecycle()')`。
- **失败降级**：不得阻断 DSH 主循环；依赖缺失进 no-op 并告警；工具错误返回 `isError` 结果。
- **事件命名空间**：dsh-swarm 自有 durable 事件用 **`swarm/*`** 前缀，`declare module '@deepseek-ai/dsh-session/types'` 增强 `SessionEventMap`；**不改**原生 `team/*` 的 `version`（现为 2）。
- **契约**：业务包只从 `@elinpf/dsh-swarm-team-core-contract` 与 `@elinpf/dsh-swarm-team-capability-contract` 取类型；**禁止** import 任何实现包。
- **package.json peer**：外部 DSH 包用 semver 区间（`^0.2.1-rc.3`），对齐 `example-plugin`。

---

## 4. 逐包实现规格

### 4.1 `@elinpf/dsh-swarm-team-capability-contract`（阶段 2 端口契约 SSOT）★先做

**职责一句话**：阶段 2 四个能力端口的**唯一类型 SSOT** + 对应的 `ctx.team*` 类型增强；纯类型、零运行时导出。

**依赖**：仅 type-only peer：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`。**无运行时依赖**。

**对外接口（TS 签名级，按域拆子模块后由 index 再导出）**：

```ts
// src/workspace.ts
import type { Agent } from '@deepseek-ai/dsh-agent'
declare module '@deepseek-ai/cordis' { interface Context { teamWorkspace: TeamWorkspace } }

export interface WorktreeRecord { path: string; branch: string; baseCommit: string; repositoryRoot: string }

export type LockMode = 'exclusive' | 'shared'
export interface LockRequest { path: string; mode: LockMode; ttlMs?: number }
export interface LockHandle { id: string; path: string; mode: LockMode; owner: string; expiresAt: number }

export interface TeamWorkspace {
  /** 复用 DSH ctx.worktrees：为 caller 成员建/进 worktree（隔离 checkout）。 */
  createWorktree(caller: Agent, req?: { name?: string; from?: string }): Promise<WorktreeRecord>
  /** 当前成员所处 worktree（无则 undefined）。 */
  currentWorktree(caller: Agent): WorktreeRecord | undefined

  /** 申请写域锁；独占冲突时抛 TEAMWS_LOCK_CONFLICT。 */
  acquireLock(caller: Agent, req: LockRequest): Promise<LockHandle>
  releaseLock(caller: Agent, handle: LockHandle): Promise<void>
  listLocks(): LockHandle[]
}

// src/skills.ts
declare module '@deepseek-ai/cordis' { interface Context { teamSkills: TeamSkills } }
export interface SkillVisibility { /** memberId | '*' → 允许的技能名；空数组=全禁止 */ [member: string]: string[] }
export interface TeamSkills {
  declare(teamId: string, map: SkillVisibility): () => void
  visibleTo(agent: Agent): string[] | 'unrestricted'
  grant(agent: Agent, skillNames: string[]): () => void
}

// src/memory.ts
declare module '@deepseek-ai/cordis' { interface Context { teamMemory: TeamMemory } }
export interface MemoryRecord { id: string; scope: 'shared' | 'member'; memberId?: string; text: string; at: number }
export interface TeamMemory {
  readShared(agent: Agent): MemoryRecord[]
  appendShared(caller: Agent, text: string): Promise<MemoryRecord>   // 授权：Lead（或 config 放行）
  memberNote(agent: Agent, text: string): Promise<MemoryRecord>      // 写自己的私有记忆
  recall(agent: Agent): MemoryRecord[]                              // 共享 + 本人私有
}

// src/compaction.ts
declare module '@deepseek-ai/cordis' { interface Context { teamCompaction: TeamCompaction } }
export interface BudgetSnapshot { usedTokens: number; maxTokens: number; overBudget: boolean; members: number; rounds: number }
export interface TeamCompaction {
  budget(agent: Agent): BudgetSnapshot
  /** 在预算/配额触发时委托 ctx.compaction 执行一次压缩（幂等）。 */
  applyPolicy(agent: Agent, signal?: AbortSignal): Promise<{ compacted: boolean }>
}
```

**生命周期钩子**：无（纯类型包，运行时 `export {}`）。

**失败降级**：不适用。

**订阅/发射事件**：无。

**验收标准（可执行）**：
1. `pnpm test`：断言**运行时零导出**（`import * as m` 除 `default`/空外无值）；用 `expectTypeOf` 冻结四个端口关键形状（对齐 `team-core-contract` 的 2 用例风格）。
2. 四个实现包 `pnpm build`/`typecheck` 通过即证明四个 `ctx.team*` 类型增强可解析。
3. 契约包无运行时依赖（`dependencies` 空/仅 schemastery 不用）。

---

### 4.2 `@elinpf/dsh-swarm-team-workspace`（worktree 隔离 + 文件锁）★阶段 2

**职责一句话**：为成员提供隔离工作区（**复用** `ctx.worktrees`），并在 `ctx.fs` 写入路径上提供**文件锁/写域守卫**（新建）。

**DSH seam 承载评估**【事实·§0.3】：
- **worktree**：`ctx.worktrees.create(agent, req, signal)` 已实现「建 Git worktree 并切换会话目录」→ **直接复用**，不重造。
- **文件锁**：DSH **无锁机制**；但 `fs/write-intent`/`fs/edit-intent` 是 waterfall，**首个返回 intent 的监听者独占决策**，`next()` 得到无条件写入 → **可挂守卫拦截**。【设计主张】锁策略（谁持有哪段路径前缀、TTL、冲突仲裁）自建。

**依赖**：
```ts
static inject = ['fs', 'workingDirectory', 'teamCore', 'agents', 'sessions'] as const
// 'worktrees' 作为可选依赖（实验包可能未挂载）：经 ctx.inject 或运行时探测
```

**对外接口**：实现 `TeamWorkspace`（契约见 §4.1）。

**实现要点**：
- `createWorktree`：委派 `ctx.worktrees.create(caller, req, signal)`，转 `CreatedWorktree → WorktreeRecord`；记录到 durable 事件 `swarm/workspace/worktree`。
- 写域守卫：`ctx.on('fs/write-intent', (target, actor, next) => { ... })`——若 `target.path` 落在**他人持有**的 exclusive 锁前缀内且 `actor` 非持有者 → **不调用 `next()`、返回 `undefined`**（拒绝写）并 `logger.warn`；否则 `return next()`。
  - **【待确认·§9】** `fs/write-intent` 返回 `undefined` 的**确切语义**（拒绝 vs 无意图）须在实现时对 `FileSystem.writeText` 源码核验；若 `undefined` 不等于拒绝，则改用「抛出带 `FS_WRITE_DENIED` 的错误」路径并在 §7 手册回写。
- 锁记录：`acquireLock` 生成 `LockHandle`（uuid + owner + expiresAt）；TTL 到点由内部 `setInterval`（须 `unref()`）清扫。

**生命周期钩子**：`ctx.effect(() => { const offWrite = ctx.on('fs/write-intent', ...); const offEdit = ctx.on('fs/edit-intent', ...); const offTimer = startTtlSweeper(); return () => { offWrite(); offEdit(); offTimer() } }, 'teamWorkspace.guards()')`；`dispose()` 释放全部本地锁记录。

**失败降级**：
- `ctx.worktrees` 不可用（未挂实验包）→ `createWorktree` 抛 `TEAMWS_WORKTREE_UNAVAILABLE`（不静默），但**文件锁守卫仍生效**；服务 `degraded=true`。
- `ctx.fs` 不可用 → 锁降为**建议性**（仅记账 + 提示），写域守卫不生效，告警。

**订阅/发射事件**：订阅 `fs/write-intent`、`fs/edit-intent`；发射 `swarm/workspace/worktree`、`swarm/workspace/lock`（durable）。

**验收标准**：
1. `pnpm test`（假 ctx）：
   - A 成员对 `src/` 取 exclusive 锁后，B 成员写 `src/x.ts` 被拒（守卫返回拒绝）；A 写通过；
   - 释放锁后 B 写通过；
   - 锁 TTL 到点自动释放；
   - `dispose()` 后全部锁释放、两个守卫撤销（HMR 归零）。
2. `ctx.worktrees` mock 存在时，`createWorktree` 委派且返回 `WorktreeRecord`；缺失时抛 `TEAMWS_WORKTREE_UNAVAILABLE`。
3. `pnpm verify`：真实 cordis 加载观察到 `ctx.teamWorkspace`；卸载后消失。

---

### 4.3 `@elinpf/dsh-swarm-team-skills`（技能可见性/授权）★阶段 2

**职责一句话**：按团队/成员声明技能可见子集，落到 `ctx.skills` 的**成员 scope 层**，实现「成员只见授权技能」。

**DSH seam 承载评估**【事实·§0.3】：`ctx.skills` 是 **host + per-scope 分层注册表**，注册按调用 context 的 scope 归档、读取合并 global + 查看 scope 链、最近层优先 → **可直接承载**。`ctx.skills.register(skill)` 返回 disposer；skill 有 `modelFacing` 标志。

**依赖**：
```ts
static inject = ['skills', 'agents', 'teamCore'] as const
```

**对外接口**：实现 `TeamSkills`（契约见 §4.1）。

**实现要点**：
- `declare(teamId, map)`：注册团队可见性文档（内存 + durable 事件 `swarm/skills/visibility`）。
- 落到 `ctx.skills`：对每个成员，在**其 agent scope**（`agent.ctx`）内注册/过滤可见技能——【设计主张】实现二选一，实现时按 `ctx.skills` 的 scope API 择一：
  - (a) **过滤器型**：注册一个 `SkillProvider`（`list()` 只返回该成员可见技能）；或
  - (b) **注册型**：把成员可见技能作为 runtime skill 注册进其 scope 层（`ctx.skills.register`）。
  - 选择依据：若 DSH 的「查看 scope」能按 agent 隔离，则 (b) 最自然；否则用 (a)。**实现时须以 `packages/skill/skill/src/index.ts` 的 scope API 为准并回写 §9。**
- `visibleTo(agent)`：无文档 → 返回 `'unrestricted'`（对齐迁移设计「缺失文档=无限制」）。

**生命周期钩子**：`ctx.effect` 撤销所有 provider/runtime 注册；监听 `session/event`（`team/member`）为新成员套用可见性。

**失败降级**：`ctx.skills` 不可用 → no-op（可见性不生效、日志告警，不阻断）；可见性文档 malformed → 跳过该条并计数。

**订阅/发射事件**：订阅 `session/event`；发射 `swarm/skills/visibility`。

**验收标准**：
1. 声明成员 A 可见 `[arch-design]`、B 可见 `[]` → `visibleTo(A)` 含该技能、`visibleTo(B)` 为空；写入 B 的技能不出现。
2. 无文档 → `visibleTo` 返回 `'unrestricted'`。
3. 授权变更（`grant`）后 `visibleTo` 立即反映。
4. `dispose()` 后 `ctx.skills` 中本包注册项归零（HMR 安全）。
5. `pnpm verify` 观察到 `ctx.teamSkills`。

---

### 4.4 `@elinpf/dsh-swarm-team-memory`（共享 + 成员记忆）★阶段 2

**职责一句话**：维护一份**全体只读**的共享 `TEAM_MEMORY` 与 per-member 私有记忆，经 `ctx.systemPrompt.context`（cache-safe，不进前缀）注入。

**DSH seam 承载评估**【事实·§0.3】：`ctx.systemPrompt.context` 已在阶段 0/1 验证可用于「不进前缀的动态上下文」；`ctx.storage`（Storage hub）可做持久化 → **复用/扩展**。

**依赖**：
```ts
static inject = ['systemPrompt', 'storage', 'teamCore', 'sessions'] as const
```

**对外接口**：实现 `TeamMemory`（契约见 §4.1）。

**实现要点**：
- 共享记忆：以 `swarm/memory/shared` durable 事件 + `ctx.storage`（若可用）双写；`appendShared` 默认**仅 Lead**（config `sharedWriter: 'lead'|'any'`）。
- 成员记忆：`swarm/memory/member`（按 `memberId` 归集）。
- 注入：`ctx.systemPrompt.context({ name:'team:memory', order: 50, text: () => renderRecall(agent) })`——**走 context，不进前缀**（保 KV-cache 前缀稳定）。
- `recall(agent)` = 共享（只读）+ 本人私有。

**生命周期钩子**：`ctx.effect` 撤销 context 注册；监听 `session/event` 重建记忆视图（cold-resume）。

**失败降级**：`ctx.storage` 不可用 → 记忆仅存活于会话事件（仍可回放），告警；`ctx.teamCore` 不可用 → 成员维度退化为单例。

**订阅/发射事件**：订阅 `session/event`；发射 `swarm/memory/shared`、`swarm/memory/member`。

**验收标准**：
1. Lead `appendShared` 后，成员 `readShared` 可见、但**成员无法 `appendShared`**（授权拒绝）。
2. 成员 `memberNote` 仅本人 `recall` 可见，他人不可见。
3. 注入在 **context（用户消息侧）** 而**不在** system-prompt section 前缀（断言前缀稳定）。
4. 重启（重放 `session/event`）后 `readShared`/`recall` 复原。
5. `dispose()` 后 context 注册归零。

---

### 4.5 `@elinpf/dsh-swarm-team-compaction`（团队上下文预算）★阶段 2

**职责一句话**：为团队设定上下文预算/配额（成员数、轮次、消息频率门控），在触发时**委托** `ctx.compaction` 执行压缩。

**DSH seam 承载评估**【事实·§0.3】：`ctx.compaction`（`CompactionEngine.compactIfNeeded(agent, trigger, signal)`）+ `compaction/summary-error` waterfall 已实现压缩引擎 → **复用**；团队预算策略是**新建薄层**。

**依赖**：
```ts
static inject = ['compaction', 'systemPrompt', 'teamCore'] as const
```

**对外接口**：实现 `TeamCompaction`（契约见 §4.1）。

**实现要点**：
- `budget(agent)`：聚合「已用 token（经 `ctx.tokenMeter`，若可用）/ 预算上限 / 成员数 / 轮次」→ `BudgetSnapshot`。
- `applyPolicy(agent, signal)`：`overBudget` 时调 `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`；幂等（同一 trigger 不重复压缩）。
- 可选：监听 `compaction/summary-error` waterfall 记录团队级失败计数（**不**吞掉，需 `next()` 或返回 false）。

**生命周期钩子**：`ctx.effect` 撤销事件监听。

**失败降级**：`ctx.compaction` 不可用 → `applyPolicy` 返回 `{compacted:false}`（no-op），告警；`ctx.tokenMeter` 不可用 → `usedTokens` 置 0 且 `overBudget=false`。

**订阅/发射事件**：订阅 `compaction/summary-error`；发射 `swarm/compaction/policy`（durable）。

**验收标准**：
1. mock `ctx.compaction.compactIfNeeded` 在 `overBudget` 时被调用一次；未超预算时不调用。
2. `overBudget` 由 `usedTokens > maxTokens` 正确判定。
3. `ctx.compaction` 缺失 → `{compacted:false}` 且不抛。
4. `dispose()` 后监听归零。

> **【设计主张】预算门控是可配置项，不默认开启硬限制**（对齐迁移设计「成本可观测、规模可门控」）。

---

### 4.6 `@elinpf/dsh-swarm-tool-swarm` 增量（非新包）

**【设计主张】** 阶段 2 为 `tool-swarm` 追加可选工具（缺依赖不注册，沿用其现有模式）：
- `workspace_lock` `{ path, mode }` → 调 `ctx.teamWorkspace.acquireLock`；
- `workspace_unlock` `{ lock_id }`；
- `workspace_worktree` `{}` → `createWorktree`；
- `skills_visible` `{}` → 返回 `ctx.teamSkills.visibleTo(caller)`；
- `memory_recall` `{}` → `ctx.teamMemory.recall(caller)`。

约束：所有工具 `output` 必填、`required` 逐属性（§0.3 手册铁律）；依赖服务缺失即不注册；`Config` 增加 `enableWorkspace/enableSkills/enableMemory` 开关（默认 false，避免默认打开重能力）。

---

## 5. bundle 组装更新（`@elinpf/dsh-swarm-bundle`）

**【设计主张】** 阶段 2 在既有 bundle 的 `cordis.patch.yml` 追加 4 行（**不改**阶段 0/1 的 disabled/insert 结构；行序不承载加载语义）：

```yaml
# —— 阶段 2：能力供给层（追加到既有 insert 列表）——
    - id: team-workspace
      name: '@elinpf/dsh-swarm-team-workspace'
      config:
        defaultTtlMs: 900000          # 锁默认 TTL 15min
        enforceWriteGuard: true
    - id: team-skills
      name: '@elinpf/dsh-swarm-team-skills'
      config:
        unrestrictedWhenUndeclared: true
    - id: team-memory
      name: '@elinpf/dsh-swarm-team-memory'
      config:
        sharedWriter: lead
    - id: team-compaction
      name: '@elinpf/dsh-swarm-team-compaction'
      config:
        enabled: false                # 预算门控默认关闭
```

- `bundle` 的 `dependencies` 追加 4 个能力包；`peerDependencies` 不变。
- **依赖可用性驱动激活**：`team-workspace` 依赖 `ctx.fs`/`ctx.workingDirectory`（DSH base 有），`ctx.worktrees` 可选；`dsh-base` 已提供这些服务。
- 验证沿用 `pnpm verify`（真实 cordis 加载 14 包）；整机 `--dump-config` 仍属阶段 3（阶段 0/1 已说明边界）。

---

## 6. 目录与包内文件约定（阶段 2 增量）

```
packages/
├── team-capability-contract/
│   ├── src/index.ts            # 再导出四个域子模块；运行时 `export {}`
│   ├── src/{workspace,skills,memory,compaction}.ts   # 各域类型 + ctx 增强
│   ├── tests/team-capability-contract.spec.ts        # 零导出 + expectTypeOf 冻结
│   ├── tsconfig.json
│   └── package.json
├── team-workspace/{src/index.ts, tests/, tsconfig.json, package.json}
├── team-skills/…
├── team-memory/…
└── team-compaction/…
```

- 每包 `package.json`/`tsconfig.json`/`src/index.ts`/`tests/*.spec.ts` 结构**与阶段 0/1 完全一致**（见 `implementation-spec.md` §3.1–§3.2）。
- Service 包 `main: lib/index.js`、`types: lib/index.d.ts`、`export default <Service>`。

---

## 7. 测试策略与「什么算完成」

继承 `implementation-spec.md` §7。阶段 2 增量：

| 层 | 覆盖 |
|---|---|
| 单元（vitest，假 ctx） | 各包 §4.x 验收标准逐条；**假 ctx 需 mock `fs/write-intent`/`edit-intent`、`worktrees.create`、`skills.register/list`、`storage`、`compaction.compactIfNeeded`** |
| 加载（`pnpm verify`） | 真实 cordis 加载 **14 包**，观察 `ctx.teamWorkspace/teamSkills/teamMemory/teamCompaction`，卸载归零 |
| 集成（`pnpm verify:e2e`） | 扩展进程内冒烟：加「取锁→他人写被拒→释放」「worktree 切换 cwd（mock）」「技能可见性」「记忆注入」链路 |

**Definition of Done（每包）**：`pnpm build`/`typecheck`/`test`/`verify`/`lint`/`format:check` 全绿；§4.x 每条验收标准有对应测试用例名；契约包额外通过「零导出 + expectTypeOf」；README（可选）含 `## Model Experience` / `## Known Limitations`。

**阶段 2 集成 DoD**：14 包全量 `pnpm verify` 通过；`bundle` patch 断言（含阶段 2 的 4 行）；关掉 bundle 后零残留；`verify:e2e` 覆盖「锁守卫 + worktree + 技能可见性 + 记忆注入」四条新链路。

---

## 8. 与迁移设计 / 阶段 0/1 的映射与偏离

| 迁移设计元素 | 阶段 2 落地 | 说明 |
|---|---|---|
| `team-skills` / `team-memory` / `team-compaction` / `team-workspace` | 同名 `@elinpf/dsh-swarm-*` 四包 | 覆盖迁移设计阶段 2 能力供给补全 |
| 原设想「worktree 自建」 | **改为复用 `ctx.worktrees`（实验）+ 自建文件锁** | 【设计主张】DSH 已提供 worktree seam，重造无收益；锁仍需自建 |
| 原设想「上下文压缩自建」 | **改为复用 `ctx.compaction` + 自建预算策略** | 同上 |
| 跨包类型入 `team-core-contract` | **改为新增 `team-capability-contract`** | 继承 ADR-0001 的「契约独立成包」精神；理由见 §1.1 |
| 「一切皆插件」 | 四个 Service 各挂一行、可整体装卸 | 一致 |

**与手册的差异（以手册为准）**：阶段 2 新增工具必须遵守 §0.3 的四条 schema 铁律；Service 加载传 `mod.default`。

---

## 9. 待实现期确认（诚实登记）

1. **`fs/write-intent` 的拒绝语义**：返回 `undefined` 是否等于「拒绝写入」，须对 `FileSystem.writeText` 源码核验；如不等，改用抛 `FS_WRITE_DENIED` 并在 `plugin-dev-guide §7` 回写。
2. **`ctx.skills` 的 per-agent scope API**：`team-skills` 用「过滤器型 provider」还是「scope 层注册型」，取决于 `packages/skill/skill/src/index.ts` 的 scope 隔离粒度；实现时定并回写 §4.3。
3. **`ctx.worktrees` / `ctx.workingDirectory` 的可用性**：二者属实验/DSH base 包，须确认在目标 profile 中已挂载（`dsh-base` 是否含 `workingDirectory`）；缺失时 `team-workspace` 进入 `degraded`。
4. **`ctx.storage` 的 forms 机制**：`team-memory` 持久化用 storage hub 的哪个 form，或退回「纯 session/event + 回放」。
5. **契约包拆分粒度**：若阶段 3 契约增多，再评估是否把 `team-capability-contract` 按域拆分（当前单包，理由见 §1.1）。
6. **整机 profile 联调**：与阶段 0/1 相同，留待阶段 3（模型端点限制）。

---

## 附录 A. 证据索引

- 手册（含 §7 报错表）：`docs/plugin-dev-guide.md`
- spike（原生能力边界 + 版本陷阱 + 模型路由）：`docs/agent-team-spike.md`
- 阶段 0/1 验证与边界：`docs/verification.md`、`docs/implementation-spec.md`
- 契约决策：`docs/adr/0001-team-core-contract-package.md`
- 已实现 9 包源码：`packages/team-core-contract/src/index.ts`、`packages/team-scheduler/src/index.ts`、`packages/team-prompt/src/index.ts` 等
- DSH seam 实测（0.2.1-rc.3）：`packages/experimental/worktree/src/index.ts`、`packages/fs/fs/src/index.ts`、`packages/skill/skill/src/index.ts`、`packages/compaction/compaction/src/index.ts`、`packages/storage/storage/src/index.ts`
- 历史调研：团队共享目录 `prompt-engineering.md`、`cluster-architecture.md`、`migration-design.md`

## 附录 B. 【事实】/【设计主张】分界

- **【事实】**：§0 全部、§0.3 表格与 seam 证据、§4.x 的「DSH seam 承载评估」、§8「与手册的差异」、§9 各条。
- **【设计主张】**：§1 包清单与 §1.1 契约包处置、§2 范围、§3 增量约定、§4.x 的接口/实现要点/降级/验收、§5 bundle 更新、§6 目录、§7 测试口径。

---

*（本文件由 migration-architect 产出；DSH seam 均为 0.2.1-rc.3 源码实测，设计主张待实现验证。）*
