/**
 * 团队记忆：一份**全体只读**的共享 `TEAM_MEMORY` + per-member 私有记忆。
 *
 * - 共享记忆：`appendShared` 默认**仅 Lead**（`sharedWriter: 'lead'`）；成员只能读。
 * - 成员私有：`memberNote` 写自己的，`recall` = 共享 + 本人私有，**他人不可见**。
 * - 注入：经 `ctx.systemPrompt.context`（**cache-safe，不进前缀**）注入共享记忆。
 *
 * 端口隔离：只从契约包取类型；`ctx.storage` 作为可选持久化（缺失时仅存活于内存，告警）。
 *
 * @module @elinpf/dsh-swarm-team-memory
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryRecord, TeamMemory } from '@elinpf/dsh-swarm-team-capability-contract'
import type { TeamCore as _TeamCore } from '@elinpf/dsh-swarm-team-core-contract'
import { DURABLE_VERSION, foldDurableEvents, isDurableEvent } from '@elinpf/dsh-swarm-team-durable'
import type { DurableEvent } from '@elinpf/dsh-swarm-team-durable'

export interface Config {
  /** 共享记忆的写权限：'lead' 仅 Lead，'any' 任意成员。 */
  sharedWriter: 'lead' | 'any'
}

export class TeamMemoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamMemoryError'
  }
}

export class TeamMemoryService extends Service implements TeamMemory {
  static inject = ['systemPrompt', 'teamCore', 'sessions'] as const

  static Config: z<Config> = z.object({
    sharedWriter: z.union([z.const('lead'), z.const('any')]).default('lead'),
  })

  private readonly config: Config
  private readonly shared: MemoryRecord[] = []
  private readonly private = new Map<string, MemoryRecord[]>()
  private seq = 0

  constructor(ctx: Context, config: Config = { sharedWriter: 'lead' }) {
    super(ctx, 'teamMemory')
    this.config = config

    // 恢复（ADR-0002）：把历史 durable 记忆事件折叠回 shared/private。
    ctx.on?.('session/event', (_s: unknown, ev: unknown) => {
      if (isDurableEvent(ev) && ev.type.startsWith('swarm/memory/')) this.recover([ev])
    })
    ctx.effect(() => {
      // context（非 section）：保 system-prompt 前缀稳定（cache-safe）。
      const off = ctx.systemPrompt.context({
        name: 'team:memory',
        order: 50,
        text: () => this.renderShared(),
      })
      return () => {
        off()
        this.shared.length = 0
        this.private.clear()
      }
    }, 'teamMemory.lifecycle()')
  }

  readShared(_agent: Agent): MemoryRecord[] {
    return [...this.shared]
  }

  async appendShared(caller: Agent, text: string): Promise<MemoryRecord> {
    if (this.config.sharedWriter === 'lead' && !this.isLead(caller)) {
      throw new TeamMemoryError('TEAMMEM_NOT_AUTHORIZED', 'only the lead may append shared memory')
    }
    const rec = this.record('shared', text)
    this.shared.push(rec)
    this.emitDurable('swarm/memory/shared', { record: rec })
    return rec
  }

  async memberNote(agent: Agent, text: string): Promise<MemoryRecord> {
    const id = this.memberId(agent)
    const rec = this.record('member', text, id)
    const list = this.private.get(id) ?? []
    list.push(rec)
    this.private.set(id, list)
    this.emitDurable('swarm/memory/private', { memberId: id, record: rec })
    return rec
  }

  recall(agent: Agent): MemoryRecord[] {
    const id = this.memberId(agent)
    return [...this.shared, ...(this.private.get(id) ?? [])]
  }

  /** 恢复：折叠 `swarm/memory/*` durable 事件到 shared/private（ADR-0002；幂等去重）。 */
  recover(events: Iterable<DurableEvent>): void {
    foldDurableEvents(
      undefined,
      events,
      {
        'swarm/memory/shared': (_s, p) => {
          const rec = p.record as MemoryRecord | undefined
          if (!rec?.id) return
          if (!this.shared.some((r) => r.id === rec.id)) this.shared.push(rec)
          this.bumpSeq(rec.id)
        },
        'swarm/memory/private': (_s, p) => {
          const rec = p.record as MemoryRecord | undefined
          if (!rec?.id || typeof p.memberId !== 'string') return
          const list = this.private.get(p.memberId) ?? []
          if (!list.some((r) => r.id === rec.id)) list.push(rec)
          this.private.set(p.memberId, list)
          this.bumpSeq(rec.id)
        },
      },
      { onUnknownEvent: () => {}, onUnsupportedVersion: () => {} },
    )
  }

  private bumpSeq(id: string): void {
    const n = Number(id.split('-').pop())
    if (Number.isFinite(n)) this.seq = Math.max(this.seq, n)
  }

  private emitDurable(type: string, payload: Record<string, unknown>): void {
    try {
      ;(this.ctx as unknown as { emit?: (t: string, p: unknown) => void }).emit?.(type, {
        version: DURABLE_VERSION,
        ...payload,
      })
    } catch (e) {
      this.ctx.logger?.warn?.(
        'team-memory: durable emit %s failed: %s',
        type,
        String((e as Error)?.message),
      )
    }
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  private renderShared(): string {
    if (this.shared.length === 0) return ''
    return this.shared.map((r) => `- ${r.text}`).join('\n')
  }

  private record(scope: 'shared' | 'member', text: string, memberId?: string): MemoryRecord {
    this.seq += 1
    return { id: `mem-${this.seq}`, scope, memberId, text, at: Date.now() }
  }

  private isLead(agent: Agent): boolean {
    return this.ctx.get('teamCore')?.tryMembership?.(agent)?.role === 'lead'
  }
  private memberId(agent: Agent): string {
    return (
      this.ctx.get('teamCore')?.tryMembership?.(agent)?.id ??
      String((agent as { id?: string })?.id ?? 'unknown')
    )
  }
}

export default TeamMemoryService
