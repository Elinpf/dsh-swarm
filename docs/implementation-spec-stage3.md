# dsh-swarm 实现规格（阶段 3：规模化与边界）

> 产出人：migration-architect（插件化迁移架构师）
> 任务：P10-spec-stage3 — 延伸实现规格到阶段 3，把六项缺失能力里最后两项（**跨进程分布式**、**人类成员席位**）落成可编码规格。
> 定位：阶段 3 所有实现任务的**唯一依据**；与 `implementation-spec.md`（阶段 0/1）、`implementation-spec-stage2.md`（阶段 2）同格式；冲突时以 `docs/plugin-dev-guide.md`（0.2.1-rc.3 核定版，含 §7 报错速查）为准。
> 约定：
> - `【事实】`：来自 `plugin-dev-guide.md`、`agent-team-spike.md`、`profile-e2e.md`、`verification.md`、`adr/0001`、已实现 14 包源码、`.runtime/deepseek-harness/`（0.2.1-rc.3 源码实测）或历史调研产物。
> - `【推断】`：未实测、基于源码结构的方向判断（**本规格所有未能实测处一律标【推断】**）。
> - `【设计主张】`：本规格提出的设计决策。
> - 版本锁定唯一：DSH `0.2.1-rc.3`（commit `1f81c047`）· `@deepseek-ai/cordis` `^4.0.1`（本机 4.0.5）。
> **本任务只出规格，不写实现代码。**

---

## 0. 阶段 3 的事实基线

### 0.1 承接物【事实·verification.md P7 / 远端 main=c1db7d5】

- 阶段 0/1+2 共 **14 包**已落地并在真实 cordis + 真实 profile 上验证：`@elinpf/dsh-swarm-*`（**注意 npm scope 已迁移为 `@elinpf/dsh-swarm-*`**）。
- **真实 profile 端到端已跑通**【事实·profile-e2e.md】：`--dump-config` 出现团队行、4 个 legacy `tool-subagent*` disabled、真实模型（`llm-pi-ai` overlay）驱动 `spawn_teammate`/`send_message`(DM)/`team_task_*`/`list_agents`、`interrupt_agent` 真机跑通。
- **`followup_task` 在 0.2.1-rc.3 不存在**【事实·profile-e2e §6.1/§7】：唤醒 inactive 成员的机制就是 `send_message`（"an inactive target starts or resumes a turn"），peer 消息以 `user/message`（source `agent-message/relay`）进入目标会话。
- **实验包必须钉 `@0.2.1-rc.3`**【事实·agent-team-spike §1.2】：npm `latest`=`0.1.5-alpha.2` 不兼容（会「工具都在、一调即错」）。

### 0.2 阶段 2 遗留、应归阶段 3 收尾的项【事实·verification.md §F/§G】

1. **`team-skills` 未真正写入 `ctx.skills` 的成员 scope**：因「从全局 Service 无法安全地把技能注册进成员各自 scope」（§F.2），当前只做「声明注册表 + `visibleTo` 事实源」。→ 阶段 3 收尾（若找到 per-agent scope 接线点）。
2. **`team-memory` 未接 `ctx.storage` forms**：记忆存活于内存/会话事件，持久化 forms 留待阶段 3（§F.4）。
3. **`fs/write-intent` 拒绝语义已实测**【事实·§F.1】：`undefined`=允许/无意图、拒绝=监听里 **throw**、决策槽**单占**（允许须 `next()` 让位）——`team-workspace` 已按此实现。
4. **整机 profile 的真实模型阶段 2 交互**（如经模型取锁）未跑（§G）。

### 0.3 阶段 3 相关 DSH seam（本规格实测）【事实·0.2.1-rc.3 源码】

| 能力 | DSH seam | 关键证据 | 能否承载 |
|---|---|---|---|
| 跨进程成员**执行** | **`ctx.subagents` 命名 provider**（in-process: spawn/fork；**out-of-process: acp / dsh-sdk / codex / claude-code**） | `subagent/src/index.ts:200`（`providers` Map）、`:547`（`registerProvider`）、`:573`（`getProvider`）；`src/out-of-process.ts` 存在；README：「local spawn/fork 保留 durable session；ACP/DSH SDK/Codex/Claude Code 执行一次」 | ✅ **可复用**（成员跑在别的进程） |
| 跨进程/跨机**传输** | **`ctx.ssh`（SSH + JSON-RPC 帧，非重连）**；`ctx.subprocess`（本地子进程 stdio） | `ssh/ssh/src/index.ts:59`（`class SshConnection extends Service`）、`:76`（`lex` 帧、`maxPending`、`leaseMs`、`heartbeat`、`requestTimeoutMs`）；**README：非重连，连接丢失即失效所有操作** | ✅ 可作传输底座（**重连需自建**） |
| 跨进程成员**入口**（宿主集成） | `dsh-acp`（JSON-RPC stdio server，用于 out-of-process subagent/控制器）；`dsh-subagent-dsh-sdk` | `acp/acp/README.md`；`subagent/subagent-dsh-sdk` | ✅ 复用 |
| 共享**持久化** | **`ctx.storage`（hub + forms）** | `storage/storage/src/index.ts:47`（`Storage extends Service`）、`:64`（`mount(form, facility)`）、`:41`（`StorageForms` 可扩展） | ✅ 可作跨进程共享存储（需新 form） |
| 后台**长活进程** | `ctx.jobs`（后台作业注册表） | capability-seams `ctx.jobs` | ✅ 复用（长连接/守护任务） |
| **人类 Q/A** | **`ctx.userQuestions`（`UserQuestionService.ask()`）** | `interaction/user-questions/src/index.ts:79`（`class UserQuestionService extends TypertRemoteService`）、`:85`（`super(ctx,'userQuestions')`）、`:287`（`ask(request)`） | ✅ 复用（人在环询问） |
| **人类/宿主 UI 面** | host remotes（`session-controller`/`workspace-controller`/`account-controller`…）+ `ctx.apiProxy`/connection（RPC 载体）+ **`dsh.client`（Web 客户端插件）** | `packages/host/*`；`packages/api/gateway`；`dsh.client` 字段（`client-ui-agent-team/package.json`） | ✅ 复用（人类席位桥接面） |
| 会话事件**外发**（观测） | `ctx.sessionTelemetry`（`SessionTelemetryBackend`） | `session/session-telemetry/src/index.ts:148-162` | ✅ 复用（可选观测） |
| MCP（可选工具面） | `@deepseek-ai/dsh-mcp-client`（每 server 一行） | 阶段 0 已用范式 | ✅ 复用 |

> **【事实·plugin-dev-guide §7】** 若阶段 3 新增工具：`output` 必填、`required: true` 逐属性、可选参数**省略** `required`、只用白名单键；Service 经 `ctx.plugin()` 加载要传 `mod.default`。

---

## 1. 命名规范与包清单（阶段 3）

**【设计主张】** 沿用命名：scope **`@elinpf/dsh-swarm-*`**（阶段 2 已迁移）；插件名与 row id 同名。阶段 3 新增 **3 个能力包 + 1 个契约包**，总包数 **14 → 18**。

| 包名 | 路径 | cordis 插件名 / row id | 服务键 | 形态 | 阶段 |
|---|---|---|---|---|---|
| `@elinpf/dsh-swarm-team-scale-contract` | `packages/team-scale-contract/` | （纯类型，无 row） | — | 纯类型 | 3 |
| `@elinpf/dsh-swarm-team-transport` | `packages/team-transport/` | `team-transport` | `ctx.teamTransport` | Service | 3 |
| `@elinpf/dsh-swarm-team-distributed` | `packages/team-distributed/` | `team-distributed` | `ctx.teamDistributed` | Service | 3 |
| `@elinpf/dsh-swarm-team-human` | `packages/team-human/` | `team-human` | `ctx.teamHuman` | Service | 3 |

- 阶段 0/1/2 的 14 包不变；`tool-swarm` 允许**增量**加阶段 3 工具（§4.5，非新包）。
- **宿主侧（Python/JiuwenSwarm）的 provider 注册表开放化**：见 §4.6——它**不属于本 TS 仓**，登记为跨仓交办项。

### 1.1 契约包处置（继承 ADR-0001）★必读

**【设计主张】新增独立契约包 `@elinpf/dsh-swarm-team-scale-contract`**，承载阶段 3 三个端口（`ctx.teamTransport`/`ctx.teamDistributed`/`ctx.teamHuman`）的类型与其 `ctx` 类型增强；**不塞进** `team-core-contract` 或 `team-capability-contract`。理由（与阶段 2 §1.1 同构）：

1. **不同 cohort**：阶段 3 =「规模化与边界层」，与阶段 0/1（协作内核）、阶段 2（能力供给）分层不同、冻结时点不同。
2. **前两个契约包保持冻结**：ADR-0001（`team-core-contract`）与阶段 2（`team-capability-contract`）已定型；追加无关域会稀释语义。
3. **编译期边界仍成立**：新契约包同样**纯类型、运行时零导出**，业务包只能 `import type`。
4. **成本最低**：一个极小纯类型包换取清晰分层。

> 配套：`team-transport`/`team-distributed`/`team-human` 依赖该契约包；契约包无运行时依赖（仅 type-only peer）。

---

## 2. 阶段 3 范围界定

### 2.1 做（本规格覆盖）

| 包 | 一句话 | 承接 |
|---|---|---|
| `team-transport` | 跨进程/跨机**传输底座**（本地子进程 stdio / SSH-RPC 两种后端），含**重连与重放** | 源系统 pyzmq/hybrid 传输层 |
| `team-distributed` | **leader 权威**的跨进程团队状态：成员/任务/信箱在多进程间保持单一真相与投递 | 源系统 spawn_mode=process + 集中式 DB |
| `team-human` | **人类成员席位**：人类以成员身份进 roster、收发团队消息、HITT 标签桥接宿主/Web | 源系统 HITT / human_agent inbox / mention-channel |
| `team-scale-contract` | 上述三端口的类型 SSOT | ADR-0001 延续 |
| 阶段 2 收尾 | `team-skills` scope 接线、`team-memory` storage forms | verification §F/§G |

### 2.2 不做（界线要清）

| 不做 | 原因 |
|---|---|
| **分布式共识**（Paxos/Raft/多写者一致） | 采用 leader-authoritative 单写者；共识非必需（源系统亦为集中式 DB + 事件） |
| **跨机自动发现 / 自建鉴权体系** | 复用 `ctx.ssh`（部署方提供的 OpenSSH alias 负责鉴权与主机身份）；不重造安全层 |
| **Web UI 实现** | 只提供人类席位的**桥接面**（RPC/事件）；浏览器 UI 属独立 client 包（沿用 `dsh.client` 范式） |
| **改 DSH 内核 / 复制 agent 运行时** | 一律插件化 |
| **跨进程 exactly-once 投递** | 明确降级为「at-least-once + 幂等去重」（见 §3.2）；与源系统「进程内重试 + 目标去重」同口径 |
| **宿主（JiuwenSwarm）provider 注册表开放化** | 不在本 TS 仓（§4.6 交办） |

---

## 3. 跨进程方案（核心难点）★

> 本节是阶段 3 的规格主干，先定**模型**，再定**包**（§4.2/§4.3）。

### 3.1 一致性模型

**【设计主张】leader-authoritative 单写者 + 权威日志 + 从属只读副本**
- **真相源（SSOT）**：团队状态（roster/task/mailbox）仍以 **Lead 进程的会话日志**为权威（沿用阶段 0/1 的「日志即真相」与 native `ctx.agentTeams`）。
- **远端成员**是**客户端**：不持有权威状态，只持有「可重建的只读副本」；一切**变更**必须回送 Lead 执行（单写者）。
- **状态同步**：Lead 对每次变更分配**单调 `revision`/`seq`**（任务已用 `revision` CAS；信箱用 `queued-minus-delivered` 模型）；远端按 `sinceSeq` 增量拉取。
- **理由（对齐源系统）**：源系统亦为「集中式 DB（单写者）+ 事件总线扇出」，跨进程一致性靠 CAS + DB 事务，而非分布式共识【事实·migration-design/interaction-mechanisms】。

```
远端成员(C)                Lead 进程(权威)                  其他远端(C')
   │  send(mutation) ─────────▶ 单写者 apply(rev++)  ──▶ 持久化(会话日志)
   │                            │
   │  ◀── snapshot/sinceSeq ────┤  (读取副本)
   │  ◀── deliver(event) ───────┘  广播/定向投递（at-least-once + 幂等键）
```

**【设计主张】** 状态机：`LEAD_AUTHORITATIVE`（默认）→ 唯一权威；不允许「多 Lead 并发写同一 Team」（若检测到两个进程都自称 Lead 同 `teamId` → 进入 `SPLIT_BRAIN` 只读保护并告警）。**【推断】** 该保护机制无 DSH 现成 seam，需自建（§4.3）。

### 3.2 消息去重与重试（不丢不重）

**【设计主张】语义 = at-least-once 投递 + 幂等去重（有效 at-most-once 应用）**，与源系统口径一致（源系统明确「进程内重试 + 目标 Session 去重，**非**跨进程 exactly-once」）。

- **稳定消息 id**：每条团队消息有全局唯一 `TeamMessageId`（沿用 native 语义）。
- **投递协议**：发送方（含远端）→ Lead 落 `queued`（durable）→ Lead 尝试投递目标 → 目标 Session **durable 记录**（pending inbox 或 user message）→ 回 `delivered` ack。
- **重试**：未收到 ack 且未超 TTL → 按**指数退避**重试；收到 ack → 停。
- **去重**：目标侧以 **`TeamMessageId`** 为幂等键；已在 pending inbox 或历史中的消息**不再二次投喂模型**（沿用 `TeamMessageSource` 折叠键思路）。
- **崩溃恢复**：`queued-minus-delivered`（已入队未确认）= 待重投集合；Lead 重启后重放。
- **任务副作用幂等**：任务变更一律带 `expectedRevision`（CAS）；重复投递在版本不匹配时**自然 no-op**（不会二次 apply）。

### 3.3 断线重连

**【事实·ssh README】** `ctx.ssh` 是**非重连**的：连接丢失即失效所有在飞操作。**【设计主张】** 因此 `team-transport` 必须在其上实现**可重连的会话层**：

```
重连状态机：CONNECTED → DEGRADED(等待重连) → RESYNCING → CONNECTED
- DEGRADED：检测心跳超时/EOF → 标记 peer 不可达；入队待发帧（有界）
- RESYNCING：重连成功后先做 (a) 拉 sinceSeq 增量  (b) 重放本地 queued-minus-acked
- 冲突：重放前先按 revision 校验；过期变更丢弃（幂等）
```

- **心跳/租约**：复用 `ctx.ssh` 的 `heartbeat`/`leaseMs`/`requestTimeoutMs`（【事实·源码】）。
- **有界缓冲**：待发队列有界（超限丢弃最旧并计数，防止内存膨胀）。
- **降级**：重连超时 → peer 标记 `unreachable`，团队**不因单点掉线而停摆**（成员状态在 roster 中反映，不阻断其余成员）。

### 3.4 「不丢不重」的验证方法（可执行）

**【设计主张】四条客观验证，全部可脚本化：**

| # | 验证目标 | 方法 | 判据 |
|---|---|---|---|
| V1 | **不丢** | 注入丢帧（transport 测试后端按概率丢弃）→ 恢复后进行终态对账 | Lead 权威状态 == 期望终态（roster 数量、每任务终态、每消息已投递） |
| V2 | **不重** | 强制对同一 `TeamMessageId` 重复投递 N 次 | 目标 Session 中该 id **恰好 1 条** user message；任务 `revision` 单调无跳变 |
| V3 | **崩溃恢复** | 在「已 queued、未 delivered」时 kill Lead → 重启 | 重放后所有 queued-minus-delivered 都被投递；无重复投喂 |
| V4 | **断线重连** | 断开 peer 连接、期间产生变更 → 重连 | 重连后 sinceSeq 增量补齐；无丢失；重复变更被 CAS/去重吞掉 |

- **可观测计数器**（`team-transport`/`team-distributed` 暴露）：`sent / acked / retried / dedupDropped / replayed / unreachable`。
- **性质测试**：对消息 id 唯一性 + 幂等 apply 写属性测试（fast-check 或等价）。
- **【推断】** V1–V4 的具体故障注入点需在实现期用可控 transport 后端（内存双端）落地；跨机 SSH 真断网测试列为联调项。

### 3.5 传输后端选型（对照源系统）

| 后端 | 源系统对应 | DSH 承载 | 用途 |
|---|---|---|---|
| **in-process** | `inprocess` | 已有（阶段 0/1，进程级） | 单进程团队（默认，零开销） |
| **local-child** | `spawn_mode=process` | **`ctx.subprocess`**（本地子进程 stdio RPC） | 同机多进程团队成员 |
| **ssh-rpc** | `pyzmq`（跨机） | **`ctx.ssh`**（SSH + JSON-RPC 帧） | 跨机团队成员 |
| **host-relay** | `hybrid`（WebSocket 对外发布） | **host remotes + `ctx.apiProxy`**（宿主/Web 桥） | 人类席位/前端订阅（§4.4） |

**【设计主张】** 三种内部后端（in-process / local-child / ssh-rpc）实现**同一个 `TeamTransport` 接口**，可配置切换；不照搬 pyzmq 实现。

---

## 4. 逐包实现规格

### 4.1 `@elinpf/dsh-swarm-team-scale-contract`（阶段 3 端口契约 SSOT）★先做

**职责一句话**：阶段 3 三个能力端口的唯一类型 SSOT + `ctx` 类型增强；纯类型、运行时零导出。

**依赖**：type-only peer：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`。无运行时依赖。

**对外接口（TS 签名级）**：
```ts
// src/transport.ts
import type { Agent } from '@deepseek-ai/dsh-agent'
declare module '@deepseek-ai/cordis' { interface Context { teamTransport: TeamTransport } }

export type TransportBackend = 'in-process' | 'local-child' | 'ssh-rpc'
export type PeerState = 'connected' | 'degraded' | 'resyncing' | 'unreachable'
export interface TransportFrame { kind: 'mutation' | 'event' | 'ack' | 'sync'; teamId: string; seq?: number; payload: unknown }
export interface PeerStatus { peerId: string; backend: TransportBackend; state: PeerState; sinceSeq: number; pending: number }

export interface TeamTransport {
  /** 启动某后端；返回 disposer。 */
  start(cfg: { backend: TransportBackend; endpoint?: string }): Promise<() => void>
  /** 发送（帧级）；返回 ack 观测。 */
  send(peerId: string, frame: TransportFrame): Promise<{ seq: number }>
  /** 订阅入站帧。 */
  onFrame(handler: (peerId: string, frame: TransportFrame) => void): () => void
  peers(): PeerStatus[]
  /** 重连与重放（见 §3.3）。 */
  reconnect(peerId: string): Promise<void>
  /** 观测计数器（§3.4）。 */
  stats(): { sent: number; acked: number; retried: number; dedupDropped: number; replayed: number; unreachable: number }
}

// src/distributed.ts
declare module '@deepseek-ai/cordis' { interface Context { teamDistributed: TeamDistributed } }
export type DistributedRole = 'lead' | 'follower'
export interface DistributedState { role: DistributedRole; teamId: string; seq: number; peers: PeerStatus[] }
export interface TeamDistributed {
  readonly role: DistributedRole
  /** 声明本进程为 Lead（唯一权威）；重复 Lead 检测 → SPLIT_BRAIN 只读保护。 */
  becomeLead(agent: Agent, teamId: string): void
  /** 作为 follower 加入远端 Lead。 */
  join(agent: Agent, leadEndpoint: string): Promise<void>
  /** 权威变更入口（仅 Lead）：单写者 apply（CAS）。 */
  mutate(agent: Agent, op: MutationOp): Promise<{ revision: number }>
  /** follower 拉取增量快照。 */
  sync(agent: Agent, sinceSeq?: number): Promise<{ seq: number; state: unknown }>
  /** 投递（at-least-once + 幂等键）。 */
  deliver(agent: Agent, targetId: string, messageId: string, content: unknown[]): Promise<{ status: 'accepted' | 'queued' }>
  state(): DistributedState
}

// src/human.ts
declare module '@deepseek-ai/cordis' { interface Context { teamHuman: TeamHuman } }
export type HumanSeatKind = 'controller' | 'user'
export interface HumanSeat { seatId: string; name: string; kind: HumanSeatKind; reachable: boolean }
export interface TeamHuman {
  seats(): HumanSeat[]
  /** 让一个人类以成员身份加入 roster。 */
  addSeat(caller: Agent, spec: { name: string; kind: HumanSeatKind }): Promise<HumanSeat>
  /** 宿主/Web 入站文本 → 投递语义（mention/channel 解析，见 §4.4）。 */
  inbound(seatId: string, text: string): Promise<{ target: string; delivered: boolean }>
  /** 团队消息 → 人类席位（有人则送达，无人则标记未达）。 */
  deliver(seatId: string, content: unknown[]): Promise<{ delivered: boolean }>
  /** 向人类发起阻塞式询问（复用 ctx.userQuestions.ask）。 */
  ask(seatId: string, question: string, signal?: AbortSignal): Promise<{ answer: string }>
}
```

**生命周期钩子**：无（纯类型）。
**失败降级**：不适用。
**订阅/发射事件**：无。
**验收标准**：
1. `pnpm test`：**运行时零导出** + `expectTypeOf` 冻结三端口关键形状（对齐既有契约包）。
2. 三个实现包 `build`/`typecheck` 通过（证明三个 `ctx.team*` 类型增强可解析）。
3. 契约包 `dependencies` 无运行时依赖、`export {}`。

---

### 4.2 `@elinpf/dsh-swarm-team-transport`（跨进程传输底座）★阶段 3

**职责一句话**：实现 `TeamTransport`——把团队帧在 in-process / 本地子进程 / SSH-RPC 间搬运，并负责**重连与重放**。

**DSH seam 承载裁决**【事实·§0.3】：`ctx.ssh`（SSH+JSON-RPC，**非重连**）与 `ctx.subprocess`（本地子进程 stdio）可作**传输底座**；DSH **无**跨进程消息总线 → **传输语义/重连/重放为自建**。

**依赖**：
```ts
static inject = ['subprocess', 'jobs'] as const   // 'ssh' 可选（SSH 后端启用时）
```

**对外接口**：实现 `TeamTransport`（§4.1）。

**实现要点**：
- 三后端实现同一接口：`in-process`（直接调用本进程 handler，零序列化）、`local-child`（`ctx.subprocess.spawn` 起子进程，stdio 走 JSONL 帧）、`ssh-rpc`（`ctx.ssh` 的 RPC 帧，经 `ctx.jobs` 挂长活连接）。
- **重连状态机**（§3.3）；待发队列有界；心跳/租约复用 `ctx.ssh` 参数。
- 长连接/守护经 `ctx.jobs` 注册（可查询/终止）。

**生命周期钩子**：`ctx.effect(() => { const stops = backends.map(b => b.start()); return () => stops.forEach(s => s()) }, 'teamTransport.lifecycle()')`；`dispose()` 关闭全部连接与队列。

**失败降级**：
- `ctx.ssh` 不可用 → `ssh-rpc` 后端起不来 → **回落 `local-child`**（同机）或 `in-process`，告警。
- 子进程崩溃 → peer 标记 `unreachable`，**不影响其余 peer**；按策略重连。

**订阅/发射事件**：订阅自身入站帧；发射 `swarm/transport/peer`（durable，peer 状态迁移）、`swarm/transport/frame`（可选计数）。

**验收标准**：
1. 假 ctx + 内存双端：`send`→对端 `onFrame` 收到；`ack` 使 `stats.acked++`。
2. 丢帧注入 N 次 → 重试后 `acked` 收敛；超 TTL 仍不可达 → `unreachable++`。
3. 断连→`reconnect()`→`RESYNCING`→重放 queued → 状态回 `CONNECTED`。
4. 待发队列超界 → 丢弃最旧 + 计数，不 OOM。
5. `dispose()` 后全部连接关闭、队列清空、`ctx.jobs` 作业注销。
6. `pnpm verify`：真实 cordis 观察到 `ctx.teamTransport`；卸载后消失。

---

### 4.3 `@elinpf/dsh-swarm-team-distributed`（leader 权威跨进程状态）★阶段 3

**职责一句话**：在 `ctx.teamTransport` 之上，实现 leader-authoritative 的单写者状态与 at-least-once + 幂等投递（§3.1/§3.2）。

**DSH seam 承载裁决**【事实·§0.3】：
- 成员**执行**可复用 `ctx.subagents` 的 out-of-process provider（`dsh-sdk`/`acp`）——**复用**；
- 状态**共享**：DSH 无跨进程共享状态 → 走「Lead 权威 + follower 副本」自建；观测可选 `ctx.sessionTelemetry`；持久化可选 `ctx.storage` 新 form。

**依赖**：
```ts
static inject = ['teamCore', 'teamTransport', 'teamBus', 'subagents', 'sessions'] as const
// 'storage' 可选（远端副本持久化）
```

**对外接口**：实现 `TeamDistributed`（§4.1）。

**实现要点**：
- **单写者**：仅 Lead 执行 `mutate`（转调 `ctx.teamCore` 的 CAS 写）；follower 的变更经 transport 回送 Lead。
- **投递**：`deliver` 落 `queued`（durable）→ 经 transport 转发目标 → 目标 durable 记录 → ack；重试/去重见 §3.2。
- **副本**：follower 维护 `sinceSeq` 只读副本（可重建）；`sync` 拉增量。
- **脑裂保护**：同 `teamId` 第二个 Lead → `SPLIT_BRAIN` 只读 + 告警（【推断】需自建，无现成 seam）。
- **成员 out-of-process**：提供工厂，用 `ctx.subagents.registerProvider`（复用 `dsh-sdk`/`acp`）把远端进程注册为团队成员 provider。

**生命周期钩子**：`ctx.effect` 注销 transport 订阅与 provider 注册；`dispose()` 释放副本与待确认集合。

**失败降级**：
- `ctx.teamTransport` 不可用 → **退化为单进程**（等价阶段 0/1 行为），`role='lead'` 且 `peers=[]`，告警。
- follower 掉线 → Lead 侧标记 `unreachable`；该成员在 roster 反映，不阻断团队。

**订阅/发射事件**：订阅 `session/event`（原生 `team/*`）与 transport 帧；发射 `swarm/distributed/role`、`swarm/distributed/split-brain`（durable）。

**验收标准**：
1. 双进程（内存 transport 模拟）：follower `mutate` 经 Lead 生效；`revision` 单调。
2. 重复 `deliver` 同一 `messageId` → 目标恰 1 条；`dedupDropped++`。
3. `kill` Lead 于「queued 未 delivered」→ 重启重放后全部投递、无重复（**V3**）。
4. 第二个 Lead 加入 → `SPLIT_BRAIN` 只读 + 事件（**V4/§3.1**）。
5. transport 缺失 → 单进程退化，团队主流程仍可用。
6. `pnpm verify` 观察到 `ctx.teamDistributed`。

---

### 4.4 `@elinpf/dsh-swarm-team-human`（人类成员席位）★阶段 3

**职责一句话**：让人类以**成员身份**进团队 roster、收发团队消息，并把宿主/Web 入站文本映射为投递语义（HITT）。

**DSH seam 承载裁决**【事实·§0.3】：
- 人类**询问**：`ctx.userQuestions.ask()`（**复用**）；
- 人类/宿主**UI 面**：host remotes + `ctx.apiProxy`/connection + `dsh.client`（**复用**，本包只做桥接面，不写 UI）；
- 「人类作为 roster 成员」DSH **无直接 seam** → 在 `teamCore` 花名册上增一个 `role:'human'` 成员类型（**自建薄层**）。

**依赖**：
```ts
static inject = ['teamCore', 'teamBus', 'userQuestions', 'sessions'] as const
```

**对外接口**：实现 `TeamHuman`（§4.1）。

**实现要点（对照源系统 HITT / human_agent inbox / mention-channel）**：
- **席位 = 一种成员**：`addSeat` 在 roster 注册 `kind:'controller'|'user'` 的人类成员；人类**不跑 agent loop**，其 inbox 由宿主桥接（`deliver`/`inbound`）。
- **入站解析**（对齐源系统 `interaction/router.py`）：`team-channel` 语义——`#...`→Lead、`$name ...`→人类化身、`@m ...`→DM、`@all ...`→广播；解析为投递语义后调 `ctx.teamCore.send`/`ctx.teamBus`。
- **出站**：团队消息（DM/广播）→ `deliver(seatId, …)` 经 host remote/`ctx.apiProxy` 推到前端；离线席位标记 `unreachable/未达`。
- **HITT 标签**：给人类可见消息加来源标签（`from="user"|"controller"`、`for="controller"` 语义，对齐源系统的入站标签体系与 `team-prompt` 的 `team:inbound` 段）。
- **阻塞询问**：`ask` 复用 `ctx.userQuestions.ask`（模型侧挂起）。

**生命周期钩子**：`ctx.effect` 注销席位与事件订阅；`dispose()` 释放席位。

**失败降级**：
- `ctx.userQuestions` 不可用 → `ask` 抛 `TEAMHUMAN_ASK_UNAVAILABLE`；其余（席位/收发）仍可用。
- 无前端在线 → 消息标记未达（不丢，留待前端上线补投，复用「queued-minus-delivered」）。

**订阅/发射事件**：订阅 `session/event`（团队消息）；发射 `swarm/human/seat`、`swarm/human/inbound`、`swarm/human/delivered`（durable）。

**验收标准**：
1. `addSeat` 后 `listMembers`（经 teamCore）含该人类成员，`role/kind` 正确。
2. `inbound('#hi')` → 投给 Lead；`inbound('@all hi')` → 广播；`inbound('@bob hi')` → DM（断言投递目标）。
3. 无前端在线时 `deliver` 返回 `{delivered:false}` 且 durable 记录保留。
4. `ask` 委派 `ctx.userQuestions.ask`（mock）；缺失时抛 `TEAMHUMAN_ASK_UNAVAILABLE`。
5. `dispose()` 后席位与订阅归零。
6. `pnpm verify` 观察到 `ctx.teamHuman`。

### 4.5 `tool-swarm` 增量（非新包）

**【设计主张】** 阶段 3 追加可选工具（缺依赖不注册，沿用既有模式；遵守 §0.3 schema 铁律）：
- `transport_status` `{}` → `ctx.teamTransport.stats()`/`peers()`；
- `distributed_role` `{}` → `ctx.teamDistributed.state()`；
- `human_inbound` `{ seat_id, text }` → `ctx.teamHuman.inbound`；
- `human_ask` `{ seat_id, question }` → `ctx.teamHuman.ask`。

`Config` 增 `enableTransport/enableDistributed/enableHuman`（默认 false）。

### 4.6 宿主侧 provider 注册表开放化（**跨仓交办，不在本 TS 仓**）

**【事实·migration-design / recon】** JiuwenSwarm 侧 `harness_providers/factory.py` 的 provider 注册是**硬编码 if 链**（闭集），`resolve_provider()` 用 `if provider == "<name>"` 分支；`PROVIDER_NAMES` 为固定元组。
**【设计主张】** 阶段 3 将 provider 注册改造为**开放注册表 + entry-point 自动发现 + 惰性加载**，使「一切皆插件」在宿主侧成立。**但这属于 Python 宿主仓（jiuwenswarm/openjiuwen），不属于 dsh-swarm 的 TS 仓**——本规格**登记为跨仓交办项**，由宿主侧团队负责；dsh-swarm 侧只需保证 bundle/provider 通过既有 `HarnessProvider` + overlay 注入通道对接（阶段 0 已用 `composition.py` 范式）。

---

## 5. bundle 组装更新（`@elinpf/dsh-swarm-bundle`）

**【设计主张】** 在既有 bundle 的 `cordis.patch.yml` 追加 3 行（**不改**结构；行序不承载加载语义）：

```yaml
# —— 阶段 3：规模化与边界层（追加到既有 insert 列表；默认关闭重能力）——
    - id: team-transport
      name: '@elinpf/dsh-swarm-team-transport'
      config:
        backend: in-process          # in-process | local-child | ssh-rpc
        reconnectTimeoutMs: 15000
    - id: team-distributed
      name: '@elinpf/dsh-swarm-team-distributed'
      config:
        role: lead
    - id: team-human
      name: '@elinpf/dsh-swarm-team-human'
      config:
        enableAsk: true
```

- `bundle.dependencies` 追加 3 个能力包；`peerDependencies` 不变。
- **默认 `backend: in-process`** → 阶段 3 能力**默认不改变**单进程行为（零回归）；跨进程需显式配 `local-child`/`ssh-rpc`。
- 验证：`pnpm verify` 扩到 **18 包**；`e2e-profile.sh` 期望行数 11 → **14**。

---

## 6. 目录与包内文件约定（阶段 3 增量）

```
packages/
├── team-scale-contract/
│   ├── src/index.ts                 # 再导出 transport/distributed/human 域；运行时 `export {}`
│   ├── src/{transport,distributed,human}.ts   # 各域类型 + ctx 增强
│   ├── tests/team-scale-contract.spec.ts      # 零导出 + expectTypeOf
│   ├── tsconfig.json · package.json
├── team-transport/{src/index.ts,tests/,tsconfig.json,package.json}
├── team-distributed/…
└── team-human/…
```

- 每包 `package.json`/`tsconfig.json`/`src/index.ts`/`tests/*.spec.ts` 结构与阶段 0/1/2 **完全一致**（见 `implementation-spec.md` §3.1–§3.2）；Service 包 `main: lib/index.js`、`types: lib/index.d.ts`、`export default <Service>`。
- **npm scope**：`@elinpf/dsh-swarm-*`（阶段 2 已迁移）；补 `publishConfig.access=public` 与 `files` 白名单（`lib` 进包，`src/tests/.runtime` 不进包）。

---

## 7. 测试策略与「什么算完成」

继承 `implementation-spec.md` §7 + 阶段 2 §7。阶段 3 增量：

| 层 | 覆盖 |
|---|---|
| 单元（vitest，假 ctx） | 各包 §4.x 验收标准逐条；**假 ctx 需 mock `subprocess.spawn`/`ssh`/`userQuestions.ask`/`subagents.registerProvider`**；跨进程用「内存双端 transport mock」 |
| 加载（`pnpm verify`） | 真实 cordis 加载 **18 包**，观察四个新 `ctx.*`（`teamTransport`/`teamDistributed`/`teamHuman`）与既有 14 个，卸载归零 |
| 集成（`pnpm verify:e2e`） | 阶段 1+2 链路 + **阶段 3 链路**：双端 transport 的「发送→接收→ack」「断连→重连→重放」「重复投递→去重」「人类入站 mention→投递目标」 |
| 故障注入 | **V1–V4（§3.4）** 独立脚本/用例：丢帧、重复、崩溃恢复、断线重连 |
| profile | `scripts/e2e-profile.sh` 期望行数 11→14；`--no-model` 通过；真实模型路径见 `profile-e2e.md` |

**Definition of Done（每包）**：`build`/`typecheck`/`test`/`verify`/`lint`/`format:check` 全绿；§4.x 每条验收标准有对应用例名；契约包额外「零导出 + expectTypeOf」。
**阶段 3 集成 DoD**：18 包 `pnpm verify` 通过；`verify:e2e` 覆盖 §3.4 的 V1–V4；默认 `in-process` 下**单进程行为零回归**（阶段 0/1/2 既有用例全绿）；关掉 bundle 零残留。

---

## 8. 与迁移设计 / 阶段 0/1/2 的映射与偏离

| 迁移设计元素 | 阶段 3 落地 | 说明 |
|---|---|---|
| 跨进程/分布式（源 pyzmq/hybrid） | `team-transport` + `team-distributed` | **不照搬 pyzmq**：三后端统一接口（in-process/local-child/ssh-rpc），复用 `ctx.ssh`/`ctx.subprocess` |
| `spawn_mode=process` 每成员一进程 | `ctx.subagents` 的 out-of-process provider（dsh-sdk/acp）承载成员执行 | **复用** |
| 人类成员/HITT | `team-human` | 席位=roster 成员；复用 `ctx.userQuestions` 询问 + host remote/client 桥接；入站 mention/channel 对齐源 `interaction/router.py` |
| 宿主 provider 开放注册 | §4.6 跨仓交办 | **不在本 TS 仓** |
| 一致性 | leader-authoritative 单写者（非共识） | 对齐源系统集中式 DB 模型 |
| 投递语义 | at-least-once + 幂等去重 | 对齐源系统「非跨进程 exactly-once」口径 |
| 阶段 2 遗留 | `team-skills` scope / `team-memory` storage forms 收尾 | 见 §2.1 |

**与手册的差异（以手册为准）**：新增工具遵守 §7 schema 铁律；Service 加载传 `mod.default`。

---

## 9. 待实现期确认（诚实登记，未实测一律【推断】）

1. **`ctx.ssh` 的帧/RPC API 细节**【推断】：`SshConnection` 的 `hello`/帧格式/`maxFrameBytes` 等需在实现期精读；`ssh-rpc` 后端能否直接承载自定义 JSON 帧，或需走其 helper 协议。
2. **`ctx.subagents` 的 out-of-process 成员**是否能在 **0.2.1-rc.3 实测**跑通（`dsh-sdk`/`acp` provider）——**未实测**；受影响：跨进程成员执行路径。
3. **`ctx.storage` forms** 用于远端副本持久化的可行性（阶段 2 亦未落地）。
4. **脑裂检测**的具体实现点（无现成 seam，需自建）。
5. **插件注册表开放化**（§4.6）的宿主侧排期与接口（跨仓）。
6. **跨机 SSH 真断网/真丢包**的联调环境（V1–V4 目前以内存 transport mock 可脚本化，真机联调留待 profile 环境）。
7. **npm 包发布**：`@elinpf/dsh-swarm-*` 版本齐发与 `minimumReleaseAgeExclude`（对齐 dsh-ops-plugins 的 `@elinpf/*` 约定）。

---

## 附录 A. 证据索引

- 手册（含 §7 报错表）：`docs/plugin-dev-guide.md`
- 原生能力与版本陷阱：`docs/agent-team-spike.md`
- 真实 profile e2e 与工具真机探针：`docs/profile-e2e.md`
- 阶段 0/1/2 验证与边界（含 §F/§G）：`docs/verification.md`
- 契约决策：`docs/adr/0001-team-core-contract-package.md`
- 已实现 14 包源码：`packages/*/src/index.ts`（`@elinpf/dsh-swarm-*`）
- DSH seam 实测（0.2.1-rc.3）：`packages/subagent/subagent/src/index.ts`、`packages/ssh/ssh/src/index.ts`、`packages/subprocess/subprocess/src/index.ts`、`packages/storage/storage/src/index.ts`、`packages/interaction/user-questions/src/index.ts`、`packages/acp/acp/README.md`
- 历史调研：团队共享目录 `interaction-mechanisms.md`（传输后端 DM/多播/广播/唤醒、mention-channel、human_agent inbox）、`cluster-architecture.md`、`migration-design.md`

## 附录 B. 【事实】/【推断】/【设计主张】分界

- **【事实】**：§0 全部、§0.3 表格与 seam 证据、§3.3 的 `ctx.ssh` 非重连、§3.5 后端对应关系、§4.6 源系统闭集注册、§8「与手册差异」、§9 各条。
- **【推断】**：§3.1 脑裂保护可行性、§3.4 故障注入落点、§9 的 `ctx.ssh`/`ctx.subagents`/`ctx.storage` 未实测项。
- **【设计主张】**：§1 包清单与契约包处置、§2 范围、§3 一致性/去重/重连/验证方法、§4.x 接口与实现要点/降级/验收、§5 bundle、§6 目录、§7 测试口径。

---

*（本文件由 migration-architect 产出；DSH seam 为 0.2.1-rc.3 源码实测；未能实测处已标【推断】。设计主张待实现验证。）*
