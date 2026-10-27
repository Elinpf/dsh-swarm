/**
 * `TeamCorePort` 的落地：把团队协作记录（花名册/信箱/任务）暴露为稳定的 `ctx.teamCore`，
 * 内部可切换后端。**本阶段后端为 `native`**（P3-spike 实测 DSH 原生 `ctx.agentTeams` 可用）。
 *
 * 端口隔离：**业务代码不经本包、更不直接碰实验性 API**；本包是唯一接触 `ctx.agentTeams` 的地方，
 * 且用一个**本地结构化的 seam 接口**描述它——不 import 实验包的实现/类型，避免版本脆弱性
 * （spike 已证 npm `latest` 与 0.2.1-rc.3 不兼容）。端口类型 SSOT 在 `@elinpf/dsh-swarm-team-core-contract`。
 *
 * 降级：`ctx.agentTeams` 缺失时（`backend: auto`）进入 **no-op 模式**：`listMembers/listTasks` 返回空、
 * 其余方法抛 `TEAMCORE_UNAVAILABLE`——**不阻断单 agent 运行**，仅告警。`owned` 后端未实现（预留选择点）。
 *
 * @module @elinpf/dsh-swarm-team-core
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { DURABLE_VERSION, foldDurableEvents, isDurableEvent } from '@elinpf/dsh-swarm-team-durable'
import type { DurableEvent } from '@elinpf/dsh-swarm-team-durable'
import type {
  MemberView,
  MessageRange,
  TaskView,
  TeamCore,
  TeamMembership,
} from '@elinpf/dsh-swarm-team-core-contract'

/**
 * 原生 `ctx.agentTeams`（`@deepseek-ai/dsh-experimental-agent-team`）的**结构化 seam**。
 *
 * 只声明本适配器委派用到的方法；刻意**不使用**实验包的导入类型，以便：
 * ① 实验包升级/不可用时仍能构建；② 端口与上游实现解耦（换后端只改本文件）。
 * 字段名与 0.2.1-rc.3 实测一致（如 `sendMessage` 用 `target`、任务动作是 `reassign`）。
 */
interface AgentTeamsSeam {
  membership(agent: Agent): TeamMembership
  tryMembership(agent: Agent): TeamMembership | undefined
  listMembers(agent: Agent): Array<{
    id: string
    name: string
    role: 'lead' | 'teammate'
    status: 'running' | 'inactive' | 'provisioning' | 'failed'
    description?: string
  }>
  spawnTeammate(
    caller: Agent,
    req: {
      name: string
      description: string
      prompt: ContentBlock[]
      context: 'fresh' | 'fork'
      provider: string
      signal: AbortSignal
    },
  ): Promise<{ member: unknown }>
  sendMessage(
    caller: Agent,
    req: { target: string; content: ContentBlock[]; signal: AbortSignal },
  ): Promise<{ messageId: string }>
  createTask(
    caller: Agent,
    req: { subject: string; description: string; blockedBy?: string[]; writeScopes?: string[] },
  ): Promise<TaskView>
  getTask(caller: Agent, id: string): TaskView
  listTasks(caller: Agent): TaskView[]
  updateTask(
    caller: Agent,
    req: {
      taskId: string
      expectedRevision: number
      action:
        | 'claim'
        | 'release'
        | 'edit'
        | 'set_dependencies'
        | 'complete'
        | 'reopen'
        | 'reassign'
        | 'delete'
      subject?: string
      description?: string
      blockedBy?: string[]
      owner?: string
    },
  ): Promise<TaskView>
  waitForChange(
    caller: Agent,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ timedOut: boolean }>
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' }
}

export interface Config {
  /** 'auto' 优先用原生 agentTeams，不可用则进入 no-op（owned 后端未实现）。 */
  backend: 'native' | 'owned' | 'auto'
  maxMembers: number
  maxTasks: number
  maxMessageBytes: number
  /** 计划闸（执行前审批）：**默认关闭（opt-in）**；开启后 `open_plan` 才可用（对齐源系统 PLANNING 为可选闸门）。 */
  planGate: boolean
}

export class TeamCoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamCoreError'
  }
}

export class TeamCoreService extends Service implements TeamCore {
  static inject = ['agents', 'sessions', 'subagents'] as const

  static Config: z<Config> = z.object({
    backend: z.union([z.const('native'), z.const('owned'), z.const('auto')]).default('auto'),
    maxMembers: z.number().step(1).min(1).default(8),
    maxTasks: z.number().step(1).min(1).default(256),
    maxMessageBytes: z.number().step(1).min(1).default(65536),
    planGate: z.boolean().default(false),
  })

  private readonly config: Config
  private seam: AgentTeamsSeam | undefined
  private _backend: 'native' | 'owned'
  /** 「不可用」告警是否已发过（只告警一次，避免刷屏）。 */
  private warnedUnavailable = false
  /**
   * 处于评审态（`in_review`）的任务集。原生 `ctx.agentTeams` 只有
   * `pending|in_progress|completed|deleted`，**没有评审态**，故评审态由本端口自行维持，
   * 并在所有读/写出口叠加（{@link overlay}）。任务在原生仍为 `in_progress`。
   */
  private readonly reviewing = new Set<string>()
  /** 处于计划闸（`planned`，待计划批准）的任务集（同为叠加态；同 {@link overlay}）。 */
  private readonly planning = new Set<string>()
  /** taskId → 已提交的计划正文（计划闸）。 */
  private readonly plans = new Map<string, string>()
  /** taskId → 计划驳回反馈（计划闸）。 */
  private readonly planFeedback = new Map<string, string>()
  /** taskId → 评审返工反馈（`revision-requested`，供作者读取「改什么」）。 */
  private readonly revisionFeedback = new Map<string, string>()

  constructor(
    ctx: Context,
    config: Config = {
      backend: 'auto',
      maxMembers: 8,
      maxTasks: 256,
      maxMessageBytes: 65536,
      planGate: false,
    },
  ) {
    super(ctx, 'teamCore')
    this.config = config

    // owned 后端未实现（阶段 0/1 用 native）：显式失败并给出指引，而不是静默降级。
    if (config.backend === 'owned') {
      throw new TeamCoreError(
        'TEAMCORE_BACKEND_UNAVAILABLE',
        'owned backend is not implemented (stage 0/1 uses native)',
      )
    }

    this._backend = 'native'
    // 立即尝试一次（agentTeams 可能已就绪）；否则进入可观测的 no-op（见 warnUnavailableOnce）。
    const now = ctx.get('agentTeams') as AgentTeamsSeam | undefined
    if (now) this.attach(now)
    else this.warnUnavailableOnce()
    // 响应式挂接：真实 profile 下 agentTeams（原生 TeamService，额外依赖 sessionPersistence/
    // sessionProjections）常**晚于** team-core 就绪；一次性 ctx.get 会永久漏接（P22 实测）。
    // 用 ctx.inject 在 agentTeams 可用/更换时重新挂接，让「服务可用性驱动」真正生效。
    ctx.inject(['agentTeams'], (sctx) => {
      const svc = sctx.get('agentTeams') as AgentTeamsSeam | undefined
      if (!svc) return
      this.attach(svc)
      return () => {
        if (this.seam === svc) this.seam = undefined
      }
    })

    // 恢复（ADR-0002）：把历史 durable 事件折叠回 reviewing。session replay 时经 session/event 到达；
    // 折叠幂等（add/delete），重复应用安全。
    ctx.on?.('session/event', (_s: unknown, ev: unknown) => {
      if (
        isDurableEvent(ev) &&
        (ev.type.startsWith('swarm/core/') || ev.type.startsWith('swarm/task/'))
      )
        this.recover([ev])
    })

    ctx.effect(
      () => () => {
        // 无自有资源需要释放；保留生命周期钩子以便未来 owned 后端挂恢复折叠。
        this.reviewing.clear()
        this.planning.clear()
        this.plans.clear()
        this.planFeedback.clear()
        this.revisionFeedback.clear()
      },
      'teamCore.lifecycle()',
    )
  }

  /** 当前是否处于可用（native）状态；no-op 模式返回 false。 */
  get active(): boolean {
    return this.seam !== undefined
  }

  get backend(): 'native' | 'owned' {
    return this._backend
  }

  membership(agent: Agent): TeamMembership {
    return this.require().membership(agent)
  }

  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.seam?.tryMembership(agent)
  }

  listMembers(agent: Agent): MemberView[] {
    if (!this.seam) return []
    return this.seam.listMembers(agent).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      phase:
        m.status === 'provisioning' ? 'provisioning' : m.status === 'failed' ? 'failed' : 'active',
      status:
        m.status === 'running' ? 'running' : m.status === 'provisioning' ? 'idle' : 'inactive',
      desc: m.description,
    }))
  }

  async spawn(
    caller: Agent,
    req: {
      name: string
      description: string
      prompt: ContentBlock[]
      context: 'fresh' | 'fork'
      provider: string
      signal: AbortSignal
    },
  ): Promise<MemberView> {
    const res = await this.require().spawnTeammate(caller, {
      name: req.name,
      description: req.description,
      prompt: req.prompt,
      context: req.context,
      provider: req.provider,
      signal: req.signal,
    })
    const member = res.member as {
      id: string
      name: string
      role: 'lead' | 'teammate'
      description?: string
    }
    return {
      id: member.id,
      name: member.name,
      role: member.role,
      phase: 'active',
      status: 'idle',
      desc: member.description,
    }
  }

  async send(
    caller: Agent,
    req: { range: MessageRange; content: ContentBlock[]; delivery: 'quiet' | 'wakeup' },
  ): Promise<{ messageId: string; status: 'accepted' | 'queued' }> {
    if (req.range.kind !== 'dm') {
      throw new TeamCoreError(
        'TEAMCORE_RANGE_UNSUPPORTED',
        `${req.range.kind} is not supported by the native backend (use team-bus)`,
      )
    }
    const seam = this.require()
    const controller = new AbortController()
    const res = await seam.sendMessage(caller, {
      target: req.range.to,
      content: req.content,
      signal: controller.signal,
    })
    return { messageId: res.messageId, status: 'accepted' }
  }

  async createTask(
    caller: Agent,
    req: { subject: string; description: string; blockedBy?: string[]; writeScopes?: string[] },
  ): Promise<TaskView> {
    return this.overlay(await this.require().createTask(caller, req))
  }

  getTask(caller: Agent, id: string): TaskView {
    return this.overlay(this.require().getTask(caller, id))
  }

  listTasks(caller: Agent): TaskView[] {
    if (!this.seam) return []
    return this.seam.listTasks(caller).map((t) => this.overlay(t))
  }

  async updateTask(
    caller: Agent,
    req: {
      taskId: string
      expectedRevision: number
      action:
        | 'claim'
        | 'release'
        | 'edit'
        | 'set_dependencies'
        | 'complete'
        | 'reopen'
        | 'assign'
        | 'delete'
        | 'submit_review'
        | 'reject_review'
        | 'open_plan'
        | 'submit_plan'
        | 'approve_plan'
        | 'reject_plan'
      subject?: string
      description?: string
      blockedBy?: string[]
      owner?: string
      /** 计划闸：计划正文（`submit_plan`）。 */
      plan?: string
      /** 计划闸 / 返工：驳回或返工反馈（`reject_plan` / `reject_review`）。 */
      feedback?: string
    },
  ): Promise<TaskView> {
    // 计划闸（overlay `planned`）在端口内处理（原生无此态/动作）；**未批准不能执行**。
    if (req.action === 'open_plan') {
      if (!this.config.planGate) {
        throw new TeamCoreError(
          'TEAMCORE_PLAN_GATE_DISABLED',
          'plan gate is disabled (opt-in via Config.planGate)',
        )
      }
      const cur = this.require().getTask(caller, req.taskId)
      if (cur.revision !== req.expectedRevision) {
        throw new TeamCoreError(
          'TEAMCORE_REVISION_MISMATCH',
          `task ${req.taskId} revision ${cur.revision} != expected ${req.expectedRevision}`,
        )
      }
      if (cur.status !== 'pending') {
        throw new TeamCoreError(
          'TEAMCORE_INVALID_TRANSITION',
          `only a pending task can enter the plan gate (task ${req.taskId} is ${cur.status})`,
        )
      }
      this.planning.add(req.taskId)
      this.emitDurable('swarm/task/plan-request', { taskId: req.taskId })
      return this.overlay(cur)
    }
    if (req.action === 'submit_plan') {
      if (!this.planning.has(req.taskId)) {
        throw new TeamCoreError(
          'TEAMCORE_INVALID_TRANSITION',
          `task ${req.taskId} is not in the plan gate`,
        )
      }
      if (typeof req.plan === 'string') this.plans.set(req.taskId, req.plan)
      this.emitDurable('swarm/task/plan-request', { taskId: req.taskId, plan: req.plan ?? '' })
      return this.overlay(this.require().getTask(caller, req.taskId))
    }
    if (req.action === 'approve_plan') {
      if (!this.planning.has(req.taskId)) {
        throw new TeamCoreError(
          'TEAMCORE_INVALID_TRANSITION',
          `task ${req.taskId} is not in the plan gate`,
        )
      }
      this.planning.delete(req.taskId)
      this.planFeedback.delete(req.taskId)
      this.emitDurable('swarm/task/plan-response', { taskId: req.taskId, approved: true })
      return this.overlay(this.require().getTask(caller, req.taskId))
    }
    if (req.action === 'reject_plan') {
      if (!this.planning.has(req.taskId)) {
        throw new TeamCoreError(
          'TEAMCORE_INVALID_TRANSITION',
          `task ${req.taskId} is not in the plan gate`,
        )
      }
      const feedback = req.feedback ?? ''
      if (feedback) this.planFeedback.set(req.taskId, feedback)
      this.emitDurable('swarm/task/plan-response', {
        taskId: req.taskId,
        approved: false,
        feedback,
      })
      return this.overlay(this.require().getTask(caller, req.taskId))
    }
    // 计划闸中（overlay `planned`）：只允许计划相关动作（上方已处理）；其余一律被拒 —— **未批准不能执行**。
    if (this.planning.has(req.taskId)) {
      throw new TeamCoreError(
        'TEAMCORE_INVALID_TRANSITION',
        `action '${req.action}' not allowed while task ${req.taskId} is in the plan gate (未批准不能执行)`,
      )
    }
    // 评审叠加态的两个转移在端口内处理（原生既无该动作、也无该态），其余委托原生。
    if (req.action === 'submit_review') {
      const cur = this.require().getTask(caller, req.taskId)
      if (cur.revision !== req.expectedRevision) {
        throw new TeamCoreError(
          'TEAMCORE_REVISION_MISMATCH',
          `task ${req.taskId} revision ${cur.revision} != expected ${req.expectedRevision}`,
        )
      }
      // 合法入场只有 in_progress；pending/completed/deleted/in_review 一律拒绝（如 pending→in_review 非法）。
      if (cur.status !== 'in_progress') {
        throw new TeamCoreError(
          'TEAMCORE_INVALID_TRANSITION',
          `only an in-progress task can enter review (task ${req.taskId} is ${cur.status})`,
        )
      }
      this.reviewing.add(req.taskId)
      this.emitDurable('swarm/core/review-entered', { taskId: req.taskId })
      return this.overlay(cur)
    }
    if (req.action === 'reject_review') {
      if (!this.reviewing.has(req.taskId)) {
        throw new TeamCoreError(
          'TEAMCORE_INVALID_TRANSITION',
          `task ${req.taskId} is not in_review`,
        )
      }
      this.reviewing.delete(req.taskId)
      this.emitDurable('swarm/core/review-left', { taskId: req.taskId, outcome: 'reopened' })
      // 返工反馈（P30）：携带内容并回流给作者 —— 作者可从 revisionFeedbackOf/上下文读到「改什么」。
      if (typeof req.feedback === 'string' && req.feedback.length > 0) {
        this.revisionFeedback.set(req.taskId, req.feedback)
        this.emitDurable('swarm/task/revision-requested', {
          taskId: req.taskId,
          feedback: req.feedback,
        })
      }
      return this.overlay(this.require().getTask(caller, req.taskId))
    }
    // 评审中：只允许「离场」动作（complete=通过、reopen=返工、delete=撤销）；
    // 其余动作（claim/release/edit/set_dependencies/assign）在评审期间被拒，避免评审对象被偷改。
    if (this.reviewing.has(req.taskId)) {
      if (req.action !== 'complete' && req.action !== 'reopen' && req.action !== 'delete') {
        throw new TeamCoreError(
          'TEAMCORE_INVALID_TRANSITION',
          `action '${req.action}' not allowed while task ${req.taskId} is in_review`,
        )
      }
      this.reviewing.delete(req.taskId)
      this.emitDurable('swarm/core/review-left', {
        taskId: req.taskId,
        outcome:
          req.action === 'complete'
            ? 'completed'
            : req.action === 'delete'
            ? 'deleted'
            : 'reopened',
      })
    }
    // 端口动作名 'assign' → 原生 'reassign'
    const action = req.action === 'assign' ? 'reassign' : req.action
    // 变更前快照：reassign 要定向通知**原** owner；终态要触发依赖解锁推送（P31）
    const before = this.require().getTask(caller, req.taskId)
    const updated = await this.require().updateTask(caller, {
      taskId: req.taskId,
      expectedRevision: req.expectedRevision,
      action,
      subject: req.subject,
      description: req.description,
      blockedBy: req.blockedBy,
      owner: req.owner,
    })
    const after = this.overlay(updated)
    this.afterTaskChange(caller, action, before, after)
    return after
  }

  /**
   * 任务变更后的**定向可观测/通知**（P28 event-alignment P1/P2，贴近源语义）：
   * - `release` → `swarm/task/released`（回池）
   * - `reassign` 且 owner 变化 → 向**原 owner** 定向 DM「你不用做了」+ `swarm/task/revoked`
   * - 终态（completed/cancelled/deleted）→ `swarm/task/terminal`（供 team-scheduler 立即重算 unlock，替代纯轮询）
   */
  private afterTaskChange(caller: Agent, action: string, before: TaskView, after: TaskView): void {
    if (action === 'release') {
      this.emitEvent('swarm/task/released', {
        taskId: after.id,
        previousOwner: before.ownerName,
      })
    }
    if (action === 'reassign' && before.ownerName && before.ownerName !== after.ownerName) {
      this.emitEvent('swarm/task/revoked', { taskId: after.id, fromOwner: before.ownerName })
      void this.send(caller, {
        range: { kind: 'dm', to: before.ownerName },
        content: [
          {
            type: 'text',
            text: `任务 ${after.id} 已被改派给 ${after.ownerName ?? '他人'}，你不用再做这件事。`,
          },
        ],
        delivery: 'wakeup',
      }).catch(() => {})
    }
    if (after.status === 'completed' || after.status === 'deleted') {
      this.emitEvent('swarm/task/terminal', { taskId: after.id, status: after.status })
    }
  }

  /** 发一条**通知型**事件（非 durable：仅广播，不参与 ADR-0002 折叠）。 */
  private emitEvent(type: string, payload: Record<string, unknown>): void {
    try {
      ;(this.ctx as unknown as { emit?: (t: string, p: unknown) => void }).emit?.(type, payload)
    } catch (e) {
      this.ctx.logger?.warn?.('team-core: emit %s failed: %s', type, String((e as Error)?.message))
    }
  }

  async waitForChange(
    caller: Agent,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ timedOut: boolean }> {
    return this.require().waitForChange(caller, timeoutMs, signal)
  }

  async interrupt(
    caller: Agent,
    targetName: string,
  ): Promise<{ previousStatus: MemberView['status'] }> {
    const res = this.require().interrupt(caller, targetName)
    return { previousStatus: res.previousStatus === 'running' ? 'running' : 'inactive' }
  }

  /** 恢复：折叠 `swarm/core/*` durable 事件到 `reviewing`（ADR-0002；幂等）。 */
  recover(events: Iterable<DurableEvent>): void {
    foldDurableEvents(
      undefined,
      events,
      {
        'swarm/core/review-entered': (_s, p) => {
          if (typeof p.taskId === 'string') this.reviewing.add(p.taskId)
        },
        'swarm/core/review-left': (_s, p) => {
          if (typeof p.taskId === 'string') this.reviewing.delete(p.taskId)
        },
        'swarm/task/plan-request': (_s, p) => {
          if (typeof p.taskId !== 'string') return
          this.planning.add(p.taskId)
          if (typeof p.plan === 'string' && p.plan) this.plans.set(p.taskId, p.plan)
        },
        'swarm/task/plan-response': (_s, p) => {
          if (typeof p.taskId !== 'string') return
          if (p.approved === true) {
            this.planning.delete(p.taskId)
            this.planFeedback.delete(p.taskId)
          } else {
            this.planning.add(p.taskId)
            if (typeof p.feedback === 'string' && p.feedback)
              this.planFeedback.set(p.taskId, p.feedback)
          }
        },
        'swarm/task/revision-requested': (_s, p) => {
          if (typeof p.taskId === 'string' && typeof p.feedback === 'string')
            this.revisionFeedback.set(p.taskId, p.feedback)
        },
      },
      { onUnknownEvent: () => {}, onUnsupportedVersion: () => {} },
    )
  }

  /** 计划闸：读取已提交的计划正文（未提交返回 undefined）。 */
  planOf(taskId: string): string | undefined {
    return this.plans.get(taskId)
  }
  /** 计划闸：读取驳回反馈（未驳回返回 undefined）。 */
  planFeedbackOf(taskId: string): string | undefined {
    return this.planFeedback.get(taskId)
  }
  /** 返工：读取评审返工反馈（无则 undefined）。 */
  revisionFeedbackOf(taskId: string): string | undefined {
    return this.revisionFeedback.get(taskId)
  }

  /** 发一条 durable 事件（ADR-0002）；失败不阻断（仅告警）。 */
  private emitDurable(type: string, payload: Record<string, unknown>): void {
    try {
      ;(this.ctx as unknown as { emit?: (t: string, p: unknown) => void }).emit?.(type, {
        version: DURABLE_VERSION,
        ...payload,
      })
    } catch (e) {
      this.ctx.logger?.warn?.(
        'team-core: durable emit %s failed: %s',
        type,
        String((e as Error)?.message),
      )
    }
  }

  /** 挂接原生 seam（可观测：首次成功挂接记 info）。 */
  private attach(seam: AgentTeamsSeam): void {
    if (this.seam === seam) return
    this.seam = seam
    this.ctx.logger?.info?.('team-core: attached native ctx.agentTeams')
  }

  /** 不可用时的可观测降级告警（只发一次）；明确「读返回空、写抛 TEAMCORE_UNAVAILABLE」，避免静默。 */
  private warnUnavailableOnce(): void {
    if (this.warnedUnavailable) return
    this.warnedUnavailable = true
    this.ctx.logger?.warn?.(
      this.config.backend === 'native'
        ? 'team-core: native backend unavailable (ctx.agentTeams missing); entering no-op mode (reads empty / writes throw)'
        : 'team-core: native backend unavailable; entering no-op mode (reads empty / writes throw TEAMCORE_UNAVAILABLE)',
    )
  }

  /** 把评审叠加态套到原生任务视图上：在评审集内 → `in_review`，否则原样。 */
  private overlay(task: TaskView): TaskView {
    if (this.reviewing.has(task.id)) return { ...task, status: 'in_review' }
    if (this.planning.has(task.id)) return { ...task, status: 'planned' }
    return task
  }

  /** 读侧在 no-op 模式下返回空；写侧抛 `TEAMCORE_UNAVAILABLE`，绝不阻断单 agent。 */
  private require(): AgentTeamsSeam {
    if (!this.seam) {
      throw new TeamCoreError(
        'TEAMCORE_UNAVAILABLE',
        'team backend unavailable (no ctx.agentTeams)',
      )
    }
    return this.seam
  }
}

export default TeamCoreService
