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
import {
  DURABLE_VERSION,
  emitDurable as appendDurable,
  durableRecordOf,
  foldDurableEvents,
} from '@elinpf/dsh-swarm-team-durable'
import type { DurableEvent } from '@elinpf/dsh-swarm-team-durable'

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
  /** 是否允许 leader 显式 override 未读闸（默认 false；P51）。 */
  allowUnreadOverride: boolean
}

export class TeamCompletionService extends Service implements TeamCompletion {
  static inject = ['teamCore', 'teamBus', 'sessions'] as const

  static Config: z<Config> = z.object({
    blockOnUnread: z.boolean().default(true),
    allowUnreadOverride: z.boolean().default(false),
  })

  private readonly config: Config
  private unread = 0
  private emitted = false
  private blockedEmitted = false
  private lastSnapshot: CompletionSnapshot | undefined

  constructor(ctx: Context, config: Config = { blockOnUnread: true, allowUnreadOverride: false }) {
    super(ctx, 'teamCompletion')
    this.config = config

    ctx.effect(() => {
      // 未读台账：入队 +1、投递 -1（不小于 0）。真源是上游 `team/message/*` durable 事件；
      // 本包同时发 `swarm/completion/unread`（ADR-0002）供恢复折叠。
      const off = ctx.on('session/event', (session: unknown, ev: unknown) => {
        const type = String((ev as { type?: string })?.type ?? '')
        if (type === 'team/message/queued') {
          this.unread += 1
          this.emitDurable(session, 'swarm/completion/unread', { delta: 1 })
        } else if (type === 'team/message/delivered') {
          this.unread = Math.max(0, this.unread - 1)
          this.emitDurable(session, 'swarm/completion/unread', { delta: -1 })
        }
        // P52：跨重启 replay —— 真落盘记录类型为 `plugin:swarm/…`
        const rec = durableRecordOf(ev)
        if (rec?.name === 'swarm/completion/unread')
          this.recover([{ type: rec.name, payload: rec.payload }])
      })
      return () => {
        off()
        this.unread = 0
        this.emitted = false
        this.lastSnapshot = undefined
      }
    }, 'teamCompletion.lifecycle()')
  }

  async evaluate(
    agent: Agent,
    opts?: { overrideUnread?: boolean },
  ): Promise<{ completed: boolean; snapshot?: CompletionSnapshot }> {
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
    const gated = this.config.blockOnUnread && this.unread > 0
    const overridden = !!(opts?.overrideUnread && this.config.allowUnreadOverride)
    const noUnread = !gated || overridden

    const completed = tasksDone && membersIdle && noUnread
    if (!completed) {
      // 可观测：因「未读>0」被拦（仅当其它条件都已满足），上升沿发一次
      if (tasksDone && membersIdle && gated && !overridden && !this.blockedEmitted) {
        this.blockedEmitted = true
        this.emitNotify('swarm/completion/unread-blocked', {
          unread: this.unread,
          overridden: false,
        })
      }
      this.emitted = false // rearm：条件一旦被打破，下次满足时重新算作上升沿
      return { completed: false }
    }
    if (overridden) {
      this.emitNotify('swarm/completion/unread-blocked', { unread: this.unread, overridden: true })
    }
    this.blockedEmitted = false

    const snapshot: CompletionSnapshot = { tasks: tasks.length, members: members.length }
    if (!this.emitted) {
      this.emitted = true
      this.lastSnapshot = snapshot
      this.emitCompleted(me?.id ?? 'team', snapshot)
    }
    return { completed: true, snapshot: this.lastSnapshot ?? snapshot }
  }

  /** 恢复：折叠 `swarm/completion/unread` delta 到 unread（ADR-0002；clamp ≥0）。 */
  recover(events: Iterable<DurableEvent>): void {
    foldDurableEvents(
      undefined,
      events,
      {
        'swarm/completion/unread': (_s, p) => {
          const d = typeof p.delta === 'number' ? p.delta : 0
          this.unread = Math.max(0, this.unread + d)
        },
      },
      { onUnknownEvent: () => {}, onUnsupportedVersion: () => {} },
    )
  }

  /** 通知型事件（非 durable）：仅广播，不参与 fold。 */
  private emitNotify(type: string, payload: Record<string, unknown>): void {
    try {
      ;(this.ctx as unknown as { emit?: (t: string, p: unknown) => void }).emit?.(type, payload)
    } catch {
      /* ignore */
    }
  }

  /** durable 发射：进程内 `ctx.emit`（供 fold）**且** 真 append 会话日志（P52 通道 A，供跨重启 replay）。 */
  private emitDurable(session: unknown, type: string, payload: Record<string, unknown>): void {
    try {
      ;(this.ctx as unknown as { emit?: (t: string, p: unknown) => void }).emit?.(type, {
        version: DURABLE_VERSION,
        ...payload,
      })
      appendDurable(session, type, payload)
    } catch (e) {
      this.ctx.logger?.warn?.(
        'team-completion: durable emit %s failed: %s',
        type,
        String((e as Error)?.message),
      )
    }
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
