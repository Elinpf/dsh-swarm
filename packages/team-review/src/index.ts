/**
 * 验证闸 + 裁决数学。
 *
 * 关键不变量（对照 JiuwenSwarm P8/P11）：
 * - **不可自验**：投票者若是任务作者 → `TEAMREVIEW_SELF_VOTE`。
 * - **评审态不进原生任务枚举**：任务在评审期间保持 `in_progress`；只有 `pass` 才调
 *   `teamCore.updateTask(action='complete')`，`fail` 则保持 `in_progress`（返工）。
 * - **裁决数学**：二元池全员投完且任一 fail → fail（一票否决）；打分池全员投完且均值
 *   ≥ threshold → pass；任一池未投完 → undecided。
 * - **maxRounds** 超限 → 向 Lead 升级并停止自动返工环。
 *
 * 只依赖契约包类型（ADR-0001）。
 *
 * @module @dsh-swarm/team-review
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TaskView } from '@dsh-swarm/team-core-contract'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamReview: TeamReviewService
  }
}

export type ReviewVote =
  | { kind: 'binary'; decision: 'pass' | 'fail'; role: 'verifier' | 'challenger' }
  | { kind: 'score'; value: number; role: 'inspector' }

export type ReviewVerdict =
  | { kind: 'undecided' }
  | { kind: 'pass' }
  | { kind: 'fail'; reason: string }

export interface ReviewPool {
  kind: 'binary' | 'score'
  /** binary 池的规则（当前仅支持 veto）。 */
  rule?: 'veto'
  /** score 池的通过阈值（默认 0.85）。 */
  threshold?: number
  /** 该池需要的角色。 */
  roles: string[]
}

export interface ReviewConfig {
  pools: ReviewPool[]
  maxRounds: number
  stallTimeoutMs: number
}

export interface TeamReview {
  submitForReview(caller: Agent, taskId: string): Promise<TaskView>
  vote(caller: Agent, taskId: string, v: ReviewVote): Promise<void>
  settle(caller: Agent, taskId: string): Promise<ReviewVerdict>
  inspect(
    taskId: string,
  ): { round: number; votes: ReviewVote[]; verdict?: ReviewVerdict } | undefined
}

interface ReviewState {
  round: number
  votes: Map<string, ReviewVote>
  verdict?: ReviewVerdict
}

export class TeamReviewError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamReviewError'
  }
}

export class TeamReviewService extends Service implements TeamReview {
  static inject = ['teamCore', 'teamBus', 'agents', 'subagents', 'tools'] as const

  static Config: z<ReviewConfig> = z.object({
    pools: z
      .array(
        z.object({
          kind: z.union([z.const('binary'), z.const('score')]),
          rule: z.string().default('veto'),
          threshold: z.number().default(0.85),
          roles: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    maxRounds: z.number().step(1).min(1).default(3),
    stallTimeoutMs: z.number().step(1).min(1).default(1800000),
  }) as unknown as z<ReviewConfig>

  private readonly config: ReviewConfig
  private readonly states = new Map<string, ReviewState>()

  constructor(
    ctx: Context,
    config: ReviewConfig = { pools: [], maxRounds: 3, stallTimeoutMs: 1800000 },
  ) {
    super(ctx, 'teamReview')
    this.config = config
    ctx.effect(() => () => this.states.clear(), 'teamReview.lifecycle()')
  }

  async submitForReview(caller: Agent, taskId: string): Promise<TaskView> {
    // 未配置评审池 = 无门，直接完成（避免把不需要评审的任务卡住）
    if (this.config.pools.length === 0) {
      return this.ctx.teamCore.updateTask(caller, {
        taskId,
        expectedRevision: this.ctx.teamCore.getTask(caller, taskId).revision,
        action: 'complete',
      })
    }
    const task = this.ctx.teamCore.getTask(caller, taskId)
    this.states.set(taskId, { round: 1, votes: new Map() })
    return task
  }

  async vote(caller: Agent, taskId: string, v: ReviewVote): Promise<void> {
    const state = this.states.get(taskId)
    if (!state)
      throw new TeamReviewError('TEAMREVIEW_NOT_SUBMITTED', `task ${taskId} not under review`)
    const task = this.ctx.teamCore.getTask(caller, taskId)
    const callerName = this.nameOf(caller)
    if (task.ownerName && task.ownerName === callerName) {
      throw new TeamReviewError(
        'TEAMREVIEW_SELF_VOTE',
        `${callerName} cannot review own task ${taskId}`,
      )
    }
    state.votes.set(callerName, v) // 同一 reviewer 后写覆盖
  }

  async settle(caller: Agent, taskId: string): Promise<ReviewVerdict> {
    const state = this.states.get(taskId)
    if (!state)
      throw new TeamReviewError('TEAMREVIEW_NOT_SUBMITTED', `task ${taskId} not under review`)

    const verdict = this.adjudicate(state)
    state.verdict = verdict

    if (verdict.kind === 'pass') {
      const task = this.ctx.teamCore.getTask(caller, taskId)
      await this.ctx.teamCore.updateTask(caller, {
        taskId,
        expectedRevision: task.revision,
        action: 'complete',
      })
      return verdict
    }

    if (verdict.kind === 'fail') {
      if (state.round >= this.config.maxRounds) {
        await this.escalate(caller, taskId, `评审连续 ${state.round} 轮未通过，已停止自动返工。`)
        return verdict
      }
      state.round += 1 // 返工一轮；任务保持 in_progress
      return verdict
    }
    return verdict
  }

  inspect(
    taskId: string,
  ): { round: number; votes: ReviewVote[]; verdict?: ReviewVerdict } | undefined {
    const s = this.states.get(taskId)
    if (!s) return undefined
    return { round: s.round, votes: [...s.votes.values()], verdict: s.verdict }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  /** 裁决数学：任一池未投完 → undecided；任一池 fail → fail；全 pass → pass。 */
  private adjudicate(state: ReviewState): ReviewVerdict {
    let allComplete = true
    let anyFail = false
    let failReason = ''

    for (const pool of this.config.pools) {
      const poolVotes = [...state.votes.values()].filter((v) => pool.roles.includes(v.role))
      const votedRoles = new Set<string>(poolVotes.map((v) => v.role as string))
      const complete = pool.roles.every((r) => votedRoles.has(r))
      if (!complete) {
        allComplete = false
        continue
      }
      if (pool.kind === 'binary') {
        if (poolVotes.some((v) => v.kind === 'binary' && v.decision === 'fail')) {
          anyFail = true
          failReason = failReason || `binary pool vetoed (roles: ${pool.roles.join(',')})`
        }
      } else {
        const scores = poolVotes
          .filter((v) => v.kind === 'score')
          .map((v) => (v as { value: number }).value)
        const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
        if (avg < (pool.threshold ?? 0.85)) {
          anyFail = true
          failReason =
            failReason || `score pool avg ${avg.toFixed(3)} < threshold ${pool.threshold ?? 0.85}`
        }
      }
    }

    if (!allComplete) return { kind: 'undecided' }
    if (anyFail) return { kind: 'fail', reason: failReason }
    return { kind: 'pass' }
  }

  private async escalate(caller: Agent, taskId: string, reason: string): Promise<void> {
    try {
      await this.ctx.teamCore.send(caller, {
        range: { kind: 'dm', to: 'lead' },
        content: [{ type: 'text', text: `[review escalated] task ${taskId}: ${reason}` }],
        delivery: 'wakeup',
      })
    } catch (e) {
      this.ctx.logger?.warn?.('team-review: escalate failed: %s', String((e as Error)?.message))
    }
  }

  private nameOf(caller: Agent): string {
    return (
      this.ctx.teamCore.tryMembership(caller)?.name ??
      String((caller as { name?: string })?.name ?? 'lead')
    )
  }
}

export default TeamReviewService
