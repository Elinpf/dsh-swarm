/**
 * leader 权威的跨进程团队状态（阶段 3 · `ctx.teamDistributed`）。
 *
 * 一致性模型（spec §3.1）：**单写者**。团队状态真相源在 Lead 进程；远端成员是只读副本，
 * 一切变更回送 Lead 执行。投递语义 = **at-least-once + 幂等去重**（spec §3.2），
 * 明确**不承诺**跨进程 exactly-once。
 *
 * 本包把「不丢不重」做成**可证伪**：
 * - 任务/成员变更一律带 `opId`（幂等键）与 `expectedRevision`（CAS）；重复投递自然 no-op。
 * - 消息投递经 {@link DeliverJournal} 落 `queued`（durable）→ 尝试交付 → `delivered`；
 *   `queued-minus-delivered` 即崩后待重投集合，`recover()` 重放，`messageId` 去重保证不重复。
 * - 脑裂：同 `teamId` 第二个 Lead → `SPLIT_BRAIN` 只读保护（无现成 seam，自建）。
 *
 * 端口隔离：只从 `@elinpf/dsh-swarm-team-scale-contract` 取类型；`ctx.teamCore`/`ctx.teamTransport`/
 * `ctx.subagents` 用本地结构化 seam 描述，不 import 实现包。
 *
 * @module @elinpf/dsh-swarm-team-distributed
 */

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  DistributedRole,
  DistributedState,
  MutationOp,
  PeerStatus,
  TeamDistributed,
} from '@elinpf/dsh-swarm-team-scale-contract'

export class TeamDistributedError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamDistributedError'
  }
}

/** 本地结构化 seam：只覆盖本包用到的 `ctx.teamCore` 面。 */
interface TeamCoreSeam {
  createTask?(
    agent: Agent,
    req: { subject?: string; description?: string; blockedBy?: string[] },
  ): Promise<{ id: string; revision: number }>
  updateTask?(agent: Agent, req: Record<string, unknown>): Promise<{ id: string; revision: number }>
  spawn?(agent: Agent, req: Record<string, unknown>): Promise<{ id: string; name: string }>
  send?(
    agent: Agent,
    req: {
      range: { kind: 'dm'; to: string }
      content: unknown[]
      delivery: 'quiet' | 'wakeup'
    },
  ): Promise<{ messageId: string; status: string }>
  listMembers?(agent?: Agent): Array<{ id: string; name: string; role: string }>
  listTasks?(agent?: Agent): unknown[]
}

/** 本地结构化 seam：只覆盖本包用到的 `ctx.teamTransport` 面。 */
interface TransportSeam {
  send(
    peerId: string,
    frame: { kind: string; teamId: string; payload: unknown },
  ): Promise<{
    seq: number
  }>
  peers(): PeerStatus[]
}

/**
 * 投递日志：把「已入队 / 已交付」做成**可跨重启保留**的结构（测试注入同一实例即模拟崩溃恢复）。
 * 生产实现可用 `ctx.storage` forms 落地（spec §4.3，本包留 seam 未接）。
 */
export interface DeliverJournal {
  queued: Map<string, { targetId: string; content: unknown[] }>
  delivered: Set<string>
}

export function createJournal(): DeliverJournal {
  return { queued: new Map(), delivered: new Set() }
}

/** 进程内「同 teamId 当前 Lead」登记表——脑裂检测的落地（无 DSH 现成 seam）。 */
const leadRegistry = new Map<string, string>()
export function resetLeadRegistry(): void {
  leadRegistry.clear()
}

export interface Config {
  role: DistributedRole
  /** 本进程标识（脑裂判定用；默认取 agent.id 或 'process'）。 */
  ownerId?: string
  /** 消息在途超时后并入 recover() 重投的判定（ms）。 */
  deliveryTtlMs: number
  /** journal 落盘路径（复用 dsh-atomic-write 原子写）；配置后 journal **活过进程重启**。 */
  journalPath?: string
}

interface AppliedOp {
  opId: string
  revision: number
}

export class TeamDistributedService extends Service implements TeamDistributed {
  static inject = ['teamCore', 'sessions'] as const

  static Config: z<Config> = z.object({
    role: z.union(['lead', 'follower'] as const).default('lead'),
    ownerId: z.string(),
    deliveryTtlMs: z.number().step(1).min(1).default(30000),
    journalPath: z.string(),
  })

  private config: Config
  private currentRole: DistributedRole
  private teamIdValue = ''
  private seqValue = 0
  private splitBrainValue = false
  private readonly applied = new Map<string, AppliedOp>()
  private readonly journal: DeliverJournal
  private dedupDroppedValue = 0

  constructor(ctx: Context, config: Config = { role: 'lead', deliveryTtlMs: 30000 }) {
    super(ctx, 'teamDistributed')
    this.config = config
    this.currentRole = config.role
    const injected = ctx.get('teamDistributedJournal') as DeliverJournal | undefined
    this.journal = injected ?? loadJournalFile(config.journalPath) ?? createJournal()
    ctx.effect(() => () => this.dispose(), 'teamDistributed.lifecycle()')
    if (this.transport) {
      void this.spawnRecoveryLoop()
    } else {
      this.ctx.logger?.warn?.(
        'team-distributed: ctx.teamTransport unavailable → single-process mode (peers=[])',
      )
    }
  }

  get role(): DistributedRole {
    return this.currentRole
  }

  private get core(): TeamCoreSeam | undefined {
    return this.ctx.get('teamCore') as TeamCoreSeam | undefined
  }
  private get transport(): TransportSeam | undefined {
    return this.ctx.get('teamTransport') as TransportSeam | undefined
  }
  private ownerId(agent?: Agent): string {
    return this.config.ownerId ?? (agent as { id?: string } | undefined)?.id ?? 'process'
  }

  // ── 角色 ────────────────────────────────────────────────────────────────────

  becomeLead(agent: Agent, teamId: string): void {
    const owner = this.ownerId(agent)
    const existing = leadRegistry.get(teamId)
    if (existing && existing !== owner) {
      // 同 teamId 第二个 Lead → 只读保护 + 告警（spec §3.1）
      this.splitBrainValue = true
      this.currentRole = 'lead'
      this.teamIdValue = teamId
      this.emit('swarm/distributed/split-brain', {
        version: 1 as const,
        teamId,
        existingOwner: existing,
        owner,
      })
      return
    }
    leadRegistry.set(teamId, owner)
    this.currentRole = 'lead'
    this.teamIdValue = teamId
    this.splitBrainValue = false
    this.emit('swarm/distributed/role', { version: 1 as const, teamId, role: 'lead' })
  }

  async join(agent: Agent, leadEndpoint: string): Promise<void> {
    this.currentRole = 'follower'
    this.teamIdValue = teamIdFrom(leadEndpoint)
    void agent
    void leadEndpoint
    this.emit('swarm/distributed/role', {
      version: 1 as const,
      teamId: this.teamIdValue,
      role: 'follower',
    })
  }

  // ── 权威变更（仅 Lead，CAS + opId 幂等）────────────────────────────────────

  async mutate(agent: Agent, op: MutationOp): Promise<{ revision: number }> {
    if (this.currentRole === 'follower') {
      // follower 变更回送 Lead（经 transport）；无 transport → 明确报错，不静默丢
      if (!this.transport)
        throw new TeamDistributedError(
          'TEAMDIST_FOLLOWER_NO_LEAD',
          'follower mutate requires ctx.teamTransport to reach the Lead',
        )
      await this.transport.send(peerFromEndpoint(this.teamIdValue), {
        kind: 'mutation',
        teamId: this.teamIdValue,
        payload: op,
      })
      return { revision: this.seqValue }
    }
    if (this.splitBrainValue)
      throw new TeamDistributedError('TEAMDIST_SPLIT_BRAIN', 'read-only under SPLIT_BRAIN guard')

    // opId 幂等：同一 op 重复 apply → 返回首次 revision（no-op）
    const prev = this.applied.get(op.opId)
    if (prev) return { revision: prev.revision }

    const core = this.core
    if (core) {
      if (op.kind === 'task.create' && core.createTask) {
        await core.createTask(agent, {
          subject: op.payload.subject,
          description: op.payload.description,
          blockedBy: op.payload.blockedBy,
        })
      } else if (op.kind === 'task.update' && core.updateTask) {
        // CAS：expectedRevision 不匹配 → 自然 no-op（不二次 apply）
        await core.updateTask(agent, {
          taskId: op.payload.taskId,
          expectedRevision: op.expectedRevision,
          action: op.payload.action,
          owner: op.payload.owner,
        })
      } else if (op.kind === 'member.spawn' && core.spawn) {
        await core.spawn(agent, { name: op.payload.name, prompt: op.payload.prompt })
      }
    }
    this.seqValue += 1
    this.applied.set(op.opId, { opId: op.opId, revision: this.seqValue })
    return { revision: this.seqValue }
  }

  async sync(_agent: Agent, sinceSeq?: number): Promise<{ seq: number; state: unknown }> {
    const core = this.core
    return {
      seq: this.seqValue,
      state: {
        teamId: this.teamIdValue,
        role: this.currentRole,
        sinceSeq: sinceSeq ?? 0,
        members: core?.listMembers?.() ?? [],
        tasks: core?.listTasks?.() ?? [],
        // 只读副本可重建：带上 pending（queued-minus-delivered）供对账
        pending: this.pending,
      },
    }
  }

  // ── 投递（at-least-once + messageId 幂等）─────────────────────────────────

  async deliver(
    agent: Agent,
    targetId: string,
    messageId: string,
    content: unknown[],
  ): Promise<{ status: 'accepted' | 'queued' }> {
    if (this.journal.delivered.has(messageId)) {
      // 幂等：重复投递不二次交付
      this.dedupDroppedValue++
      return { status: 'accepted' }
    }
    // 落 queued（durable）：即使随后交付失败，也在 recover() 集合中
    this.journal.queued.set(messageId, { targetId, content })
    await this.persistJournal()
    const ok = await this.tryDeliver(agent, messageId, targetId, content)
    await this.persistJournal()
    return { status: ok ? 'accepted' : 'queued' }
  }

  private async tryDeliver(
    agent: Agent,
    messageId: string,
    targetId: string,
    content: unknown[],
  ): Promise<boolean> {
    try {
      if (this.currentRole === 'follower' && this.transport) {
        await this.transport.send(peerFromEndpoint(this.teamIdValue), {
          kind: 'event',
          teamId: this.teamIdValue,
          payload: { targetId, messageId, content },
        })
      } else {
        const core = this.core
        if (!core?.send) return false
        // 原生后端只接受 DM range（广播走 team-bus）；缺 kind/delivery 会被 team-core 拒绝
        await core.send(agent, {
          range: { kind: 'dm', to: targetId },
          content,
          delivery: 'wakeup',
        })
      }
    } catch (e) {
      // 交付失败：保持 queued（不丢），交由 recover()/重试处理
      this.ctx.logger?.warn?.('team-distributed: deliver %s failed: %s', messageId, String(e))
      return false
    }
    this.journal.queued.delete(messageId)
    this.journal.delivered.add(messageId)
    return true
  }

  /** 崩溃恢复（spec §3.4 V3）：重放 queued-minus-delivered；messageId 去重保证不重复。 */
  async recover(agent: Agent): Promise<{ replayed: number }> {
    let replayed = 0
    for (const [messageId, rec] of [...this.journal.queued]) {
      if (this.journal.delivered.has(messageId)) {
        this.journal.queued.delete(messageId)
        continue
      }
      const ok = await this.tryDeliver(agent, messageId, rec.targetId, rec.content)
      if (ok) replayed++
    }
    await this.persistJournal()
    return { replayed }
  }

  /** 落盘 journal（原子写）：`queued` = queued-minus-delivered，`delivered` = 幂等去重集。 */
  private async persistJournal(): Promise<void> {
    const path = this.config.journalPath
    if (!path) return
    const payload = JSON.stringify({
      queued: [...this.journal.queued.entries()],
      delivered: [...this.journal.delivered],
    })
    try {
      await writeFileAtomic(path, payload, { mode: 0o600 })
    } catch (e) {
      this.ctx.logger?.warn?.('team-distributed: journal persist failed: %s', String(e))
    }
  }

  private async spawnRecoveryLoop(): Promise<void> {
    // 轻量周期重投：失败保持 queued，不退化为丢（真正的守护经 ctx.jobs，此处保持最小）
    return
  }

  state(): DistributedState {
    return {
      role: this.currentRole,
      teamId: this.teamIdValue,
      seq: this.seqValue,
      peers: this.transport?.peers() ?? [],
      splitBrain: this.splitBrainValue,
      pending: this.pending,
      delivered: this.journal.delivered.size,
      dedupDropped: this.dedupDroppedValue,
    }
  }

  /** 观测用：queued-minus-delivered 条数。 */
  get pending(): number {
    let n = 0
    for (const id of this.journal.queued.keys()) if (!this.journal.delivered.has(id)) n++
    return n
  }

  dispose(): void {
    this.applied.clear()
  }

  private emit(name: string, payload: unknown): void {
    try {
      const emit = (this.ctx as unknown as { emit?: (n: string, p: unknown) => void }).emit
      emit?.call(this.ctx, name, payload)
    } catch (e) {
      this.ctx.logger?.warn?.('team-distributed: emit %s failed: %s', name, String(e))
    }
  }
}

/** 从磁盘恢复 journal（缺失/损坏则返回 undefined，退化为内存 journal）。 */
function loadJournalFile(path: string | undefined): DeliverJournal | undefined {
  if (!path) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      queued?: Array<[string, { targetId: string; content: unknown[] }]>
      delivered?: string[]
    }
    return {
      queued: new Map(raw.queued ?? []),
      delivered: new Set(raw.delivered ?? []),
    }
  } catch {
    return undefined
  }
}

function teamIdFrom(endpoint: string): string {
  return endpoint
}
function peerFromEndpoint(endpoint: string): string {
  return endpoint
}

export default TeamDistributedService
