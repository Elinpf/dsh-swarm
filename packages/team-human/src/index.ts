/**
 * 人类成员席位（阶段 3 · `ctx.teamHuman`）。
 *
 * 让人类以**成员身份**进团队 roster、收发团队消息，并把宿主/Web 入站文本映射为投递语义（HITT）。
 * 对齐源系统的 HITT / human_agent inbox / mention-channel（`interaction/router.py`）。
 *
 * DSH seam 承载裁决（spec §4.4）：
 * - 人类**询问** → **复用** `ctx.userQuestions.ask()`；
 * - 人类/宿主 **UI 面** → 复用 host remotes / `ctx.apiProxy` / `dsh.client`，本包只做**桥接面**（seam：`ctx.teamHumanBridge`）；
 * - 「人类作为 roster 成员」DSH **无直接 seam** → 在 `ctx.teamCore` 花名册上增 `role:'human'` 成员（薄层 seam：`addHumanMember`）。
 *
 * 端口隔离：只从 `@elinpf/dsh-swarm-team-scale-contract` 取类型；不 import 实现包。
 *
 * @module @elinpf/dsh-swarm-team-human
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  HittOrigin,
  HumanOutbound,
  HumanSeat,
  HumanSeatKind,
  TeamHuman,
} from '@elinpf/dsh-swarm-team-scale-contract'

export class TeamHumanError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamHumanError'
  }
}

/** 本地结构化 seam：只覆盖本包用到的 `ctx.teamCore` 面。 */
interface TeamCoreSeam {
  membership?(agent: Agent): { role?: string; name?: string } | undefined
  tryMembership?(agent: Agent): { role?: string; name?: string } | undefined
  listMembers?(agent?: Agent): Array<{ id: string; name: string; role?: string; kind?: string }>
  send?(
    agent: Agent,
    req: {
      range: { kind: 'dm'; to: string }
      content: unknown[]
      delivery: 'quiet' | 'wakeup'
    },
  ): Promise<{ messageId: string; status: string }>
  /** 薄层：把人类登记进花名册（无则本包仅内部持有席位）。 */
  addHumanMember?(agent: Agent, spec: { name: string; kind: HumanSeatKind }): { id: string }
}

/** 本地结构化 seam：本包用到的 `ctx.teamBus` 面。 */
interface TeamBusSeam {
  broadcast?(
    agent: Agent,
    req: { content: unknown[]; delivery: 'quiet' | 'wakeup' },
  ): Promise<{ messageId: string }>
}

/** 宿主/Web 桥接面（`ctx.teamHumanBridge`）：把团队消息推到前端、回报在线态。 */
export interface HumanBridgeSeam {
  isOnline?(seatId: string): boolean
  send(seatId: string, outbound: HumanOutbound): void | Promise<void>
}

/** `ctx.userQuestions` 的结构化 seam（阻塞式询问）。 */
interface UserQuestionsSeam {
  ask(req: { question: string; signal?: AbortSignal; seatId?: string }): Promise<{
    answer?: string
  }>
}

export interface Config {
  /** 团队 Lead 的名字（`#...` 频道与默认路由落点）。 */
  leadName: string
  /** 无在线前端时消息保留待补投（复用 queued-minus-delivered 思路）。 */
  retainWhenOffline: boolean
}

interface PendingOutbound {
  seatId: string
  outbound: HumanOutbound
}

export class TeamHumanService extends Service implements TeamHuman {
  static inject = ['teamCore', 'sessions'] as const

  static Config: z<Config> = z.object({
    leadName: z.string().default('lead'),
    retainWhenOffline: z.boolean().default(true),
  })

  private readonly config: Config
  private readonly seatMap = new Map<string, HumanSeat>()
  private readonly pending: PendingOutbound[] = []
  private seatSeq = 0

  constructor(ctx: Context, config: Config = { leadName: 'lead', retainWhenOffline: true }) {
    super(ctx, 'teamHuman')
    this.config = config
    ctx.effect(() => () => this.dispose(), 'teamHuman.lifecycle()')
  }

  private get core(): TeamCoreSeam | undefined {
    return this.ctx.get('teamCore') as TeamCoreSeam | undefined
  }
  private get bus(): TeamBusSeam | undefined {
    return this.ctx.get('teamBus') as TeamBusSeam | undefined
  }
  private get bridge(): HumanBridgeSeam | undefined {
    return this.ctx.get('teamHumanBridge') as HumanBridgeSeam | undefined
  }
  private get userQuestions(): UserQuestionsSeam | undefined {
    return this.ctx.get('userQuestions') as UserQuestionsSeam | undefined
  }

  // ── 席位 ────────────────────────────────────────────────────────────────────

  seats(): HumanSeat[] {
    return [...this.seatMap.values()].map((s) => ({ ...s, reachable: this.isReachable(s.seatId) }))
  }

  async addSeat(caller: Agent, spec: { name: string; kind: HumanSeatKind }): Promise<HumanSeat> {
    const role = this.roleOf(caller)
    if (role !== 'lead')
      throw new TeamHumanError('TEAMHUMAN_FORBIDDEN', 'only the Lead can add human seats')
    const seatId = `human-${++this.seatSeq}`
    // 薄层登记到花名册（无 seam 时仅内部持有，仍可收发）
    const registered = this.core?.addHumanMember?.(caller, { name: spec.name, kind: spec.kind })
    const seat: HumanSeat = {
      seatId: registered?.id ?? seatId,
      name: spec.name,
      kind: spec.kind,
      reachable: this.isReachable(registered?.id ?? seatId),
    }
    this.seatMap.set(seat.seatId, seat)
    this.emit('swarm/human/seat', { version: 1 as const, seat })
    return { ...seat }
  }

  private isReachable(seatId: string): boolean {
    return this.bridge?.isOnline?.(seatId) ?? false
  }

  private roleOf(agent: Agent): string | undefined {
    const core = this.core
    return (
      core?.membership?.(agent)?.role ??
      core?.tryMembership?.(agent)?.role ??
      (agent as { role?: string }).role
    )
  }

  private seatOrThrow(seatId: string): HumanSeat {
    const seat = this.seatMap.get(seatId)
    if (!seat) throw new TeamHumanError('TEAMHUMAN_NO_SEAT', `unknown seat ${seatId}`)
    return seat
  }

  // ── 入站路由（HITT，对齐源 interaction/router.py）─────────────────────────

  /**
   * 解析入站文本为投递语义：
   * - `#...` → Lead；`@all ...` → 广播；`@name ...` → DM；`$name ...` → 另一个人类化身。
   */
  parseInbound(text: string): { target: string; body: string } {
    const trimmed = text.trim()
    if (trimmed.startsWith('@all')) {
      return { target: 'all', body: trimmed.slice(4).trim() }
    }
    if (trimmed.startsWith('@')) {
      const rest = trimmed.slice(1)
      const sp = rest.indexOf(' ')
      const name = sp === -1 ? rest : rest.slice(0, sp)
      return { target: name, body: sp === -1 ? '' : rest.slice(sp + 1).trim() }
    }
    if (trimmed.startsWith('$')) {
      const rest = trimmed.slice(1)
      const sp = rest.indexOf(' ')
      const name = sp === -1 ? rest : rest.slice(0, sp)
      const seat = [...this.seatMap.values()].find((s) => s.kind === 'user' && s.name === name)
      return { target: seat ? seat.seatId : name, body: sp === -1 ? '' : rest.slice(sp + 1).trim() }
    }
    if (trimmed.startsWith('#')) {
      return { target: this.config.leadName, body: trimmed.slice(1).trim() }
    }
    return { target: this.config.leadName, body: trimmed }
  }

  async inbound(seatId: string, text: string): Promise<{ target: string; delivered: boolean }> {
    const seat = this.seatOrThrow(seatId)
    const { target, body } = this.parseInbound(text)
    const caller: Agent = { id: seat.seatId, name: seat.name } as unknown as Agent
    const content = [{ type: 'text', text: body }]
    this.emit('swarm/human/inbound', {
      version: 1 as const,
      seatId,
      kind: seat.kind,
      target,
      origin: seat.kind as HittOrigin,
    })
    try {
      if (target === 'all') {
        await this.bus?.broadcast?.(caller, { content, delivery: 'wakeup' })
      } else {
        // 原生后端只接受 DM range（广播走 team-bus）
        await this.core?.send?.(caller, {
          range: { kind: 'dm', to: target },
          content,
          delivery: 'wakeup',
        })
      }
      return { target, delivered: true }
    } catch (e) {
      this.ctx.logger?.warn?.('team-human: inbound deliver failed: %s', String(e))
      return { target, delivered: false }
    }
  }

  // ── 出站（团队消息 → 人类席位）────────────────────────────────────────────

  async deliver(seatId: string, content: unknown[]): Promise<{ delivered: boolean }> {
    const seat = this.seatOrThrow(seatId)
    const outbound: HumanOutbound = { seatId, from: 'team', content }
    if (this.bridge && this.isReachable(seatId)) {
      await this.bridge.send(seatId, outbound)
      this.emit('swarm/human/delivered', { version: 1 as const, seatId })
      return { delivered: true }
    }
    // 无前端在线：标记未达；默认保留待补投（不丢）
    if (this.config.retainWhenOffline) this.pending.push({ seatId, outbound })
    seat.reachable = false
    return { delivered: false }
  }

  /** 观测：未达（待补投）条数。 */
  get pendingCount(): number {
    return this.pending.length
  }

  /** 座位上线后补投（host 桥接面调用）。 */
  async flush(seatId?: string): Promise<number> {
    let n = 0
    for (const p of [...this.pending]) {
      if (seatId && p.seatId !== seatId) continue
      if (this.bridge && this.isReachable(p.seatId)) {
        await this.bridge.send(p.seatId, p.outbound)
        this.pending.splice(this.pending.indexOf(p), 1)
        n++
      }
    }
    return n
  }

  // ── 阻塞式询问 ──────────────────────────────────────────────────────────────

  async ask(seatId: string, question: string, signal?: AbortSignal): Promise<{ answer: string }> {
    this.seatOrThrow(seatId)
    const uq = this.userQuestions
    if (!uq?.ask)
      throw new TeamHumanError('TEAMHUMAN_ASK_UNAVAILABLE', 'ctx.userQuestions.ask unavailable')
    const res = await uq.ask({ question, signal, seatId })
    return { answer: res.answer ?? '' }
  }

  dispose(): void {
    this.seatMap.clear()
    this.pending.length = 0
  }

  private emit(name: string, payload: unknown): void {
    try {
      const emit = (this.ctx as unknown as { emit?: (n: string, p: unknown) => void }).emit
      emit?.call(this.ctx, name, payload)
    } catch (e) {
      this.ctx.logger?.warn?.('team-human: emit %s failed: %s', name, String(e))
    }
  }
}

export default TeamHumanService
