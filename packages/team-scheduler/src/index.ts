/**
 * 幂等调度器：任何唤醒（团队事件或周期 tick）都触发**同一对幂等扫描**——
 * 派发 ready 任务 + 推进评审；并内置「卡住任务自催 → 升级 Lead」的 stale 自愈。
 *
 * 语义要点：
 * - 幂等：一串扫描收敛到同一状态；已 in_progress 的任务不会被重复启动。
 * - 「一人一活跃任务」不变量：成员已有活跃任务时不再被派新活。
 * - stale 自愈：自己欠工且超 `staleClaimIdleMs` → 追加 nudge；连续 `staleEscalateStreak`
 *   次无果 → 由卡住者自己向 Lead 发消息升级（不跨进程直催）。
 * - 降级：`scheduled` 连续抛错达到阈值 → 自动降级为 `autonomous` 并告警。
 *
 * 只依赖契约包类型（ADR-0001）；不 import team-core 实现。
 *
 * @module @elinpf/dsh-swarm-team-scheduler
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemberView, TaskView } from '@elinpf/dsh-swarm-team-core-contract'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamScheduler: TeamSchedulerService
  }
}

export interface ScanReport {
  started: number
  reviewsDispatched: number
  staleNudged: number
  /** 评审卡住（`in_review` 超过 `reviewStallMs`）向 Lead 升级的次数。 */
  reviewStalled?: number
  converged: boolean
}

export type SchedulerMode = 'autonomous' | 'scheduled'

export interface TeamScheduler {
  readonly mode: SchedulerMode
  /** 幂等；有界 fixpoint（最多 4 轮）。 */
  scan(agent: Agent): Promise<ScanReport>
  /** 团队事件 → 触发一次 scan（防抖）。 */
  onTeamEdge(agent: Agent, ev: { type: string }): void
  /** 装配（构造 + 首扫）；返回 disposer。 */
  arm(agent: Agent): () => void
}

export interface Config {
  mode: SchedulerMode
  pollMs: number
  staleClaimIdleMs: number
  staleEscalateStreak: number
  /** 视为「成员已占工」的状态；含 `in_review` 以维持「一人一活跃任务」不被评审任务破坏。 */
  busyTaskStatuses: Array<'pending' | 'in_progress' | 'in_review'>
  /** 评审卡住阈值：`in_review` 停留超过此毫秒数即向 Lead 升级（每次卡住的评审只升一次）。 */
  reviewStallMs: number
}

const MAX_SCAN_PASSES = 4
const DEGRADE_AFTER_FAILURES = 3

export class TeamSchedulerService extends Service implements TeamScheduler {
  static inject = ['teamCore', 'teamBus', 'agents', 'systemPrompt'] as const

  static Config: z<Config> = z.object({
    mode: z.union([z.const('autonomous'), z.const('scheduled')]).default('autonomous'),
    pollMs: z.number().step(1).min(1).default(30000),
    staleClaimIdleMs: z.number().step(1).min(1).default(600000),
    staleEscalateStreak: z.number().step(1).min(1).default(3),
    busyTaskStatuses: z
      .array(z.union([z.const('pending'), z.const('in_progress'), z.const('in_review')]))
      .default(['pending', 'in_progress', 'in_review']),
    reviewStallMs: z.number().step(1).min(1).default(1800000),
  })

  private readonly config: Config
  private _mode: SchedulerMode
  private timer: ReturnType<typeof setInterval> | undefined
  private failures = 0
  private armedAgent: Agent | undefined
  /** memberId → 上次 nudge 时刻。 */
  private readonly lastNudge = new Map<string, number>()
  /** memberId → 连续无果次数。 */
  private readonly streak = new Map<string, number>()
  /** taskId → 首次观测到 in_review 的时刻（用于 review_stall 计时）。 */
  private readonly reviewSince = new Map<string, number>()
  /** 已因评审卡住升级过的 taskId（每次卡住只升一次）。 */
  private readonly reviewEscalated = new Set<string>()

  constructor(ctx: Context, config: Config = defaultConfig()) {
    super(ctx, 'teamScheduler')
    this.config = config
    this._mode = config.mode
    ctx.effect(() => () => this.dispose(), 'teamScheduler.lifecycle()')
  }

  get mode(): SchedulerMode {
    return this._mode
  }

  async scan(agent: Agent): Promise<ScanReport> {
    const report: ScanReport = {
      started: 0,
      reviewsDispatched: 0,
      staleNudged: 0,
      reviewStalled: 0,
      converged: false,
    }
    try {
      const members = this.ctx.teamCore.listMembers(agent)
      let tasks = this.ctx.teamCore.listTasks(agent)

      // 有界 fixpoint：直到某一轮不再产生变更
      for (let pass = 0; pass < MAX_SCAN_PASSES; pass++) {
        const changed = await this.onePass(agent, members, tasks, report)
        if (!changed) break
        tasks = this.ctx.teamCore.listTasks(agent)
      }

      await this.staleSweep(agent, members, tasks, report)
      await this.reviewStallSweep(agent, tasks, report)
      report.converged = true
      this.failures = 0
      return report
    } catch (e) {
      this.failures += 1
      if (this._mode === 'scheduled' && this.failures >= DEGRADE_AFTER_FAILURES) {
        this._mode = 'autonomous'
        this.ctx.logger?.warn?.(
          'team-scheduler: degraded to autonomous after %d failures',
          this.failures,
        )
      }
      throw e
    }
  }

  onTeamEdge(agent: Agent, _ev: { type: string }): void {
    // 防抖：同一 tick 内多次事件只触发一次 scan
    if (this.edgePending) return
    this.edgePending = true
    queueMicrotask(() => {
      this.edgePending = false
      void this.scan(agent).catch(() => {})
    })
  }

  arm(agent: Agent): () => void {
    this.armedAgent = agent
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.armedAgent) void this.scan(this.armedAgent).catch(() => {})
    }, this.config.pollMs)
    // setInterval 不该阻止进程退出
    ;(this.timer as { unref?: () => void })?.unref?.()
    return () => this.dispose()
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.armedAgent = undefined
    this.lastNudge.clear()
    this.streak.clear()
    this.reviewSince.clear()
    this.reviewEscalated.clear()
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private edgePending = false

  private async onePass(
    agent: Agent,
    members: MemberView[],
    tasks: TaskView[],
    report: ScanReport,
  ): Promise<boolean> {
    const active = new Set(
      tasks.filter((t) => this.isBusy(t.status) && t.ownerName).map((t) => t.ownerName as string),
    )
    let changed = false

    for (const m of members) {
      if (m.role === 'lead') continue
      if (active.has(m.name)) continue // 一人一活跃任务

      if (this._mode === 'autonomous') {
        // 只 nudge 空闲成员去认领，不预派
        await this.nudge(agent, m.name, '有就绪任务待认领，请在工作台上 claim。')
      } else {
        // scheduled：作为唯一 dispatcher，取该成员最早的就绪任务 CAS 启动
        const task = tasks
          .filter(
            (t) => t.ready && t.status === 'pending' && (!t.ownerName || t.ownerName === m.name),
          )
          .sort((a, b) => a.id.localeCompare(b.id))[0]
        if (!task) continue
        try {
          await this.ctx.teamCore.updateTask(agent, {
            taskId: task.id,
            expectedRevision: task.revision,
            action: 'claim',
            owner: m.name,
          })
          report.started += 1
          changed = true
          await this.nudge(agent, m.name, `任务 ${task.id} 已启动，请开始执行。`)
          break // 重新读取 tasks 后再决定是否还有可启动的
        } catch {
          // CAS 冲突：说明有人抢先改了；本轮不启动，交给下一轮
        }
      }
    }
    return changed
  }

  private async staleSweep(
    agent: Agent,
    members: MemberView[],
    tasks: TaskView[],
    report: ScanReport,
  ): Promise<void> {
    const now = Date.now()
    const busyBy = new Map<string, TaskView>()
    for (const t of tasks) {
      // in_review 是「等待裁决」而非「等待推进」，不走「推进或释放」的常规 stale 催办（另有 reviewStallSweep）。
      if (this.isBusy(t.status) && t.status !== 'in_review' && t.ownerName)
        busyBy.set(t.ownerName, t)
    }

    for (const m of members) {
      if (m.role === 'lead') continue
      const task = busyBy.get(m.name)
      if (!task) continue // 没欠工，不催
      const last = this.lastNudge.get(m.id) ?? this.armedAt
      if (now - last < this.config.staleClaimIdleMs) continue

      await this.nudge(agent, m.name, `任务 ${task.id} 卡住已久，请推进或释放。`)
      this.lastNudge.set(m.id, now)
      report.staleNudged += 1

      const s = (this.streak.get(m.id) ?? 0) + 1
      if (s >= this.config.staleEscalateStreak) {
        await this.escalateToLead(agent, m.name, task.id)
        this.streak.set(m.id, 0)
      } else {
        this.streak.set(m.id, s)
      }
    }
  }

  private async nudge(agent: Agent, targetName: string, text: string): Promise<void> {
    try {
      await this.ctx.teamCore.send(agent, {
        range: { kind: 'dm', to: targetName },
        content: [{ type: 'text', text }],
        delivery: 'wakeup',
      })
    } catch (e) {
      this.ctx.logger?.warn?.(
        'team-scheduler: nudge %s failed: %s',
        targetName,
        String((e as Error)?.message),
      )
    }
  }

  private async escalateToLead(agent: Agent, memberName: string, taskId: string): Promise<void> {
    try {
      await this.ctx.teamCore.send(agent, {
        range: { kind: 'dm', to: 'lead' },
        content: [
          {
            type: 'text',
            text: `[escalation] ${memberName} 连续多次未推进任务 ${taskId}，请介入。`,
          },
        ],
        delivery: 'wakeup',
      })
    } catch (e) {
      this.ctx.logger?.warn?.('team-scheduler: escalate failed: %s', String((e as Error)?.message))
    }
  }

  private isBusy(status: TaskView['status']): boolean {
    return (this.config.busyTaskStatuses as string[]).includes(status)
  }

  /**
   * 评审卡住检测：`in_review` 停留超过 `reviewStallMs` → 向 Lead 升级（每次卡住只升一次）。
   * 与常规 stale 分离：评审中的任务无人可「推进」，只有 Lead 介入才解冻。
   */
  private async reviewStallSweep(
    agent: Agent,
    tasks: TaskView[],
    report: ScanReport,
  ): Promise<void> {
    const now = Date.now()
    const inReview = new Set(tasks.filter((t) => t.status === 'in_review').map((t) => t.id))
    // 已离开评审的：清计时与升级标记，使任务下次再入评审时重新计时
    for (const id of [...this.reviewSince.keys()]) {
      if (!inReview.has(id)) this.reviewSince.delete(id)
    }
    for (const id of [...this.reviewEscalated]) {
      if (!inReview.has(id)) this.reviewEscalated.delete(id)
    }

    for (const t of tasks) {
      if (t.status !== 'in_review') continue
      const since = this.reviewSince.get(t.id)
      if (since === undefined) {
        this.reviewSince.set(t.id, now)
        continue
      }
      if (now - since < this.config.reviewStallMs) continue
      if (this.reviewEscalated.has(t.id)) continue
      this.reviewEscalated.add(t.id)
      report.reviewStalled = (report.reviewStalled ?? 0) + 1
      await this.escalateReviewStall(agent, t)
    }
  }

  private async escalateReviewStall(agent: Agent, task: TaskView): Promise<void> {
    try {
      await this.ctx.teamCore.send(agent, {
        range: { kind: 'dm', to: 'lead' },
        content: [
          {
            type: 'text',
            text: `[review_stall] 任务 ${task.id} 在 in_review 停留超过阈值，评审疑似卡住，请介入裁决。`,
          },
        ],
        delivery: 'wakeup',
      })
    } catch (e) {
      this.ctx.logger?.warn?.(
        'team-scheduler: review_stall escalate failed: %s',
        String((e as Error)?.message),
      )
    }
  }

  private readonly armedAt = Date.now()
}

function defaultConfig(): Config {
  return {
    mode: 'autonomous',
    pollMs: 30000,
    staleClaimIdleMs: 600000,
    staleEscalateStreak: 3,
    busyTaskStatuses: ['pending', 'in_progress', 'in_review'],
    reviewStallMs: 1800000,
  }
}

export default TeamSchedulerService
