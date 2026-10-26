/**
 * 团队完成判定：三条件**合取**时，在**上升沿**发一次 `swarm/team/completed`。
 *
 * 三条件（对齐 JiuwenSwarm）：
 * 1. ≥1 个任务且全部终态（completed / deleted）；
 * 2. 所有成员静止（无 running）；
 * 3. 无未读消息（`blockOnUnread` 为真时）。
 *
 * 保守原则：判定不确定（有在飞轮次 / 未读消息）→ 返回 `completed:false`，
 * **宁可晚完成，不可早完成**。上升沿守卫保证同一段「完成态」只发一次事件。
 *
 * 只依赖契约包类型（ADR-0001）。
 *
 * @module @elinpf/dsh-swarm-team-completion
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemberView, TaskView } from '@elinpf/dsh-swarm-team-core-contract'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamCompletion: TeamCompletionService
  }
}

export interface CompletionSnapshot {
  tasks: number
  members: number
}

export interface TeamCompletion {
  evaluate(agent: Agent): Promise<{ completed: boolean; snapshot?: CompletionSnapshot }>
  /** 任一团队边 → 重新评估。 */
  onEdge(agent: Agent): void
}

export interface Config {
  /** 未读消息是否阻止完成。 */
  blockOnUnread: boolean
}

export class TeamCompletionService extends Service implements TeamCompletion {
  static inject = ['teamCore', 'teamBus', 'sessions'] as const

  static Config: z<Config> = z.object({
    blockOnUnread: z.boolean().default(true),
  })

  private readonly config: Config
  private unread = 0
  private emitted = false
  private lastSnapshot: CompletionSnapshot | undefined

  constructor(ctx: Context, config: Config = { blockOnUnread: true }) {
    super(ctx, 'teamCompletion')
    this.config = config

    ctx.effect(() => {
      // 未读台账：入队 +1、投递 -1（不小于 0）。真实 durable 事件落地见包 README。
      const off = ctx.on('session/event', (_session: unknown, ev: unknown) => {
        const type = String((ev as { type?: string })?.type ?? '')
        if (type === 'team/message/queued') this.unread += 1
        else if (type === 'team/message/delivered') this.unread = Math.max(0, this.unread - 1)
      })
      return () => {
        off()
        this.unread = 0
        this.emitted = false
        this.lastSnapshot = undefined
      }
    }, 'teamCompletion.lifecycle()')
  }

  async evaluate(agent: Agent): Promise<{ completed: boolean; snapshot?: CompletionSnapshot }> {
    // 完成是团队级信号：只对 Lead 生效
    const me = this.ctx.teamCore.tryMembership(agent)
    if (me && me.role !== 'lead') {
      return { completed: false }
    }

    const tasks: TaskView[] = this.ctx.teamCore.listTasks(agent)
    const members: MemberView[] = this.ctx.teamCore.listMembers(agent)

    const tasksDone =
      tasks.length >= 1 && tasks.every((t) => t.status === 'completed' || t.status === 'deleted')
    const membersIdle = members.every((m) => m.status !== 'running')
    const noUnread = !this.config.blockOnUnread || this.unread === 0

    const completed = tasksDone && membersIdle && noUnread
    if (!completed) {
      this.emitted = false // rearm：条件一旦被打破，下次满足时重新算作上升沿
      return { completed: false }
    }

    const snapshot: CompletionSnapshot = { tasks: tasks.length, members: members.length }
    if (!this.emitted) {
      this.emitted = true
      this.lastSnapshot = snapshot
      this.emitCompleted(me?.id ?? 'team', snapshot)
    }
    return { completed: true, snapshot: this.lastSnapshot ?? snapshot }
  }

  onEdge(agent: Agent): void {
    void this.evaluate(agent).catch(() => {})
  }

  /** 观测用：当前未读计数。 */
  get unreadCount(): number {
    return this.unread
  }

  private emitCompleted(teamId: string, snapshot: CompletionSnapshot): void {
    try {
      // cordis 事件名走宽松签名（durable 事件最终经 session 日志落地，见包 README）。
      const emit = (this.ctx as unknown as { emit: (n: string, p: unknown) => void }).emit
      emit.call(this.ctx, 'swarm/team/completed', { version: 1 as const, teamId, snapshot })
    } catch (e) {
      this.ctx.logger?.warn?.('team-completion: emit failed: %s', String((e as Error)?.message))
    }
  }
}

export default TeamCompletionService
