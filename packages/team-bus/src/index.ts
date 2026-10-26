/**
 * 团队消息总线：在 `ctx.teamCore` 的 DM 之上补**广播 / 多播 / 主题群聊**。
 *
 * 语义（对照 JiuwenSwarm 原语 P3/P4/P5）：
 * - 内容先落库（一次持久化），信号再扇出；广播**自过滤**发送者，绝不回投。
 * - 多播是「一次事务写 N 个收件人」，整批失败即回滚，不产生部分投递。
 * - 防滥用：targets 恰为全体 → 拒绝并要求走 broadcast；含 `*`/`user` → 拒绝；正文超限 → 拒绝。
 *
 * 端口隔离：本包只依赖 `@elinpf/dsh-swarm-team-core-contract` 的 `TeamCore` 类型，
 * 不 import 任何 `@elinpf/dsh-swarm-team-core` 的内部实现（ADR-0001）。
 *
 * @module @elinpf/dsh-swarm-team-bus
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// 仅为引入契约包的 `ctx.teamCore` 类型增强（type-only import 即可生效）。
import type { TeamCore } from '@elinpf/dsh-swarm-team-core-contract'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamBus: TeamBusService
  }
}

/** 群聊主题（topic）。 */
export type TeamTopic = 'team' | 'task' | 'message' | 'announce'

/** 一条已落库的广播/多播快照。 */
export interface BroadcastSnapshot {
  id: string
  senderId: string
  senderName: string
  topic: TeamTopic
  content: ContentBlock[]
  delivery: 'quiet' | 'wakeup'
  /** 多播时为目标成员 id；广播时为 undefined。 */
  targetId?: string
}

/**
 * 广播扇出模式：
 * - `dm`（默认，当前语义）：1 次落库 + **逐人 DM 扇出**（每个非发送者各收 1 条，按 `delivery` 决定是否唤醒）。
 * - `record-only`：1 次落库 + **不逐人 DM**；仅通知本进程主题订阅者，成员按需经 {@link TeamBus.history} **拉取**。
 *   —— 用于「公告/信号」类广播，避免对无关成员造成投递与唤醒放大（实验证据见 docs/experiments-stage1.md §2 AB1 / §1 C1）。
 */
export type BroadcastFanout = 'dm' | 'record-only'

export interface TeamBus {
  /** 主题订阅；返回 disposer。 */
  subscribe(agent: Agent, topic: TeamTopic, handler: (ev: BroadcastSnapshot) => void): () => void
  /** 广播：1 次持久化 + 全员扇出（`fanout` 决定逐人 DM / 仅落库可拉取）。 */
  broadcast(
    caller: Agent,
    req: {
      topic?: TeamTopic
      content: ContentBlock[]
      delivery: 'quiet' | 'wakeup'
      fanout?: BroadcastFanout
    },
  ): Promise<{ messageId: string }>
  /** 多播：一次事务写入 N 个收件人；targets 恰为全体时拒绝，强制走 broadcast。 */
  multicast(
    caller: Agent,
    req: { targets: string[]; content: ContentBlock[]; delivery: 'quiet' | 'wakeup' },
  ): Promise<{ messageId: string }>
  /**
   * 拉取对调用者可见的已落库快照（不回投自己发的），可选按 topic 与 `sinceId` 增量过滤。
   * 与 `fanout:'record-only'` 配套：成员按需拉取，而非被动接收逐人 DM。
   */
  history(caller: Agent, opts?: { topic?: TeamTopic; sinceId?: string }): BroadcastSnapshot[]
}

export interface Config {
  /** 单次扇出上限，超过即拒绝（防一次广播打爆总线）。 */
  maxFanout: number
  /** 单条消息正文上限（字节）。 */
  maxMessageBytes: number
}

/** 带稳定错误码的总线错误，便于上游按码降级。 */
export class TeamBusError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamBusError'
  }
}

interface Subscription {
  topic: TeamTopic
  handler: (ev: BroadcastSnapshot) => void
}

export class TeamBusService extends Service implements TeamBus {
  static inject = ['teamCore', 'sessions', 'tools'] as const

  static Config: z<Config> = z.object({
    maxFanout: z.number().step(1).min(1).default(64),
    maxMessageBytes: z.number().step(1).min(1).default(65536),
  })

  private readonly config: Config
  private readonly subs = new Map<string, Set<Subscription>>()
  /** 已落库快照（持久化落地见包 README 的 Known Limitations）。 */
  private readonly durable: BroadcastSnapshot[] = []
  private seq = 0

  constructor(ctx: Context, config: Config = { maxFanout: 64, maxMessageBytes: 65536 }) {
    super(ctx, 'teamBus')
    this.config = config
    ctx.effect(() => () => this.dispose(), 'teamBus.lifecycle()')
    ctx.logger?.debug?.('team-bus: ready (backend=%s)', this.ctx.teamCore?.backend ?? 'none')
  }

  /** 观测用：当前落库条数（供测试与诊断）。 */
  get durableCount(): number {
    return this.durable.length
  }

  subscribe(agent: Agent, topic: TeamTopic, handler: (ev: BroadcastSnapshot) => void): () => void {
    const id = this.agentId(agent)
    let set = this.subs.get(id)
    if (!set) {
      set = new Set()
      this.subs.set(id, set)
    }
    const entry: Subscription = { topic, handler }
    set.add(entry)
    return () => {
      set?.delete(entry)
      if (set && set.size === 0) this.subs.delete(id)
    }
  }

  async broadcast(
    caller: Agent,
    req: {
      topic?: TeamTopic
      content: ContentBlock[]
      delivery: 'quiet' | 'wakeup'
      fanout?: BroadcastFanout
    },
  ): Promise<{ messageId: string }> {
    this.assertSize(req.content)
    const sender = this.senderOf(caller)
    const targets = this.members(caller).filter((m) => m.id !== sender.id)
    if (targets.length > this.config.maxFanout) {
      throw new TeamBusError(
        'TEAMBUS_FANOUT_EXCEEDED',
        `fanout ${targets.length} > maxFanout ${this.config.maxFanout}`,
      )
    }

    const snap: BroadcastSnapshot = {
      id: this.nextId('bcast'),
      senderId: sender.id,
      senderName: sender.name,
      topic: req.topic ?? 'team',
      content: req.content,
      delivery: req.delivery,
    }
    this.durable.push(snap)
    const targetIds = targets.map((m) => m.id)
    if ((req.fanout ?? 'dm') === 'record-only') {
      // 仅落库 + 通知本进程订阅者；不逐人 DM（成员按需 history 拉取）。
      this.notifySubscribers(targetIds, snap)
    } else {
      await this.fanout(caller, targetIds, snap)
    }
    return { messageId: snap.id }
  }

  async multicast(
    caller: Agent,
    req: { targets: string[]; content: ContentBlock[]; delivery: 'quiet' | 'wakeup' },
  ): Promise<{ messageId: string }> {
    this.assertSize(req.content)
    const all = this.members(caller)
    this.assertTargets(
      req.targets,
      all.map((m) => m.id),
    )

    const sender = this.senderOf(caller)
    const known = new Set(all.map((m) => m.id))
    for (const t of req.targets) {
      if (!known.has(t)) throw new TeamBusError('TEAMBUS_UNKNOWN_TARGET', `unknown target ${t}`)
    }

    const topic: TeamTopic = 'message'
    const records = req.targets.map((t) => ({
      id: this.nextId('mcast'),
      senderId: sender.id,
      senderName: sender.name,
      topic,
      content: req.content,
      delivery: req.delivery,
      targetId: t,
    }))
    // 原子：整批先落库，任一步失败即回滚已落库的，绝不部分投递。
    const written: BroadcastSnapshot[] = []
    try {
      for (const r of records) {
        this.durable.push(r)
        written.push(r)
      }
    } catch (e) {
      this.rollback(written)
      throw new TeamBusError('TEAMBUS_TX_FAILED', String((e as Error)?.message ?? e))
    }

    await this.fanout(caller, req.targets, {
      // 扇出用「代表快照」：内容/主题一致，仅 targetId 逐目标不同。
      id: records[0]?.id ?? this.nextId('mcast'),
      senderId: sender.id,
      senderName: sender.name,
      topic,
      content: req.content,
      delivery: req.delivery,
    })
    return { messageId: records[0]?.id ?? '' }
  }

  /** 卸载：清空全部订阅与落库（fiber 回滚，HMR 安全）。 */
  dispose(): void {
    this.subs.clear()
    this.durable.length = 0
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async fanout(caller: Agent, targetIds: string[], snap: BroadcastSnapshot): Promise<void> {
    for (const id of targetIds) {
      // 1) 信号走总线：以 DM 送达（内容已落库）
      await this.deliver(caller, id, snap)
      // 2) 通知本进程内的主题订阅者
      this.notifySubscribers([id], snap)
    }
  }

  /** 通知本进程内的主题订阅者（`record-only` 模式不经 DM，仅走这里）。 */
  private notifySubscribers(targetIds: string[], snap: BroadcastSnapshot): void {
    for (const id of targetIds) {
      const set = this.subs.get(id)
      if (!set) continue
      for (const sub of set) {
        if (sub.topic === snap.topic) {
          try {
            sub.handler(snap)
          } catch (e) {
            this.ctx.logger?.warn?.('team-bus: subscriber threw: %s', String((e as Error)?.message))
          }
        }
      }
    }
  }

  history(caller: Agent, opts: { topic?: TeamTopic; sinceId?: string } = {}): BroadcastSnapshot[] {
    const me = this.senderOf(caller)
    const sinceIndex =
      opts.sinceId === undefined ? -1 : this.durable.findIndex((s) => s.id === opts.sinceId)
    const out: BroadcastSnapshot[] = []
    for (let i = 0; i < this.durable.length; i++) {
      const s = this.durable[i]
      if (s === undefined) continue
      if (opts.topic !== undefined && s.topic !== opts.topic) continue
      if (sinceIndex >= 0 && i <= sinceIndex) continue
      if (s.senderId === me.id) continue // 不回投自己发的
      out.push({ ...s, content: [...s.content] })
    }
    return out
  }

  private async deliver(caller: Agent, targetId: string, snap: BroadcastSnapshot): Promise<void> {
    const member = this.members(caller).find((m) => m.id === targetId)
    if (!member) return
    try {
      await this.ctx.teamCore.send(caller, {
        range: { kind: 'dm', to: member.name },
        content: snap.content,
        delivery: snap.delivery,
      })
    } catch (e) {
      // 投递失败不打断扇出（内容已落库，可补投）；仅告警。
      this.ctx.logger?.warn?.(
        'team-bus: deliver to %s failed: %s',
        member.name,
        String((e as Error)?.message),
      )
    }
  }

  private members(caller: Agent): ReturnType<TeamCore['listMembers']> {
    return this.ctx.teamCore.listMembers(caller)
  }

  private senderOf(caller: Agent): { id: string; name: string } {
    const m = this.ctx.teamCore.tryMembership(caller)
    return {
      id: m?.id ?? this.agentId(caller),
      name: m?.name ?? String((caller as { name?: string })?.name ?? 'lead'),
    }
  }

  private agentId(agent: Agent): string {
    const m = this.ctx.teamCore?.tryMembership?.(agent)
    return m?.id ?? String((agent as { id?: string })?.id ?? 'unknown')
  }

  private assertSize(content: ContentBlock[]): void {
    const bytes = Buffer.byteLength(JSON.stringify(content ?? []), 'utf8')
    if (bytes > this.config.maxMessageBytes) {
      throw new TeamBusError(
        'TEAMBUS_MESSAGE_TOO_LARGE',
        `${bytes} bytes > maxMessageBytes ${this.config.maxMessageBytes}`,
      )
    }
  }

  private assertTargets(targets: string[], allIds: string[]): void {
    if (!targets || targets.length === 0) {
      throw new TeamBusError('TEAMBUS_NO_TARGETS', 'multicast requires at least one target')
    }
    if (targets.some((t) => t === '*' || t === 'user')) {
      throw new TeamBusError(
        'TEAMBUS_INVALID_TARGET',
        "'*' and 'user' are not valid multicast targets",
      )
    }
    if (targets.length > this.config.maxFanout) {
      throw new TeamBusError(
        'TEAMBUS_FANOUT_EXCEEDED',
        `fanout ${targets.length} > maxFanout ${this.config.maxFanout}`,
      )
    }
    // 恰为全体 → 冗余，强制 broadcast
    const targetSet = new Set(targets)
    const fullRoster = new Set(allIds)
    if (targetSet.size === fullRoster.size && [...targetSet].every((t) => fullRoster.has(t))) {
      throw new TeamBusError(
        'TEAMBUS_REDUNDANT_BROADCAST',
        'targets equal the full roster — use broadcast() instead',
      )
    }
  }

  private rollback(written: BroadcastSnapshot[]): void {
    for (const r of written) {
      const i = this.durable.indexOf(r)
      if (i >= 0) this.durable.splice(i, 1)
    }
  }

  private nextId(kind: string): string {
    this.seq += 1
    return `${kind}-${this.seq}`
  }
}

export default TeamBusService
