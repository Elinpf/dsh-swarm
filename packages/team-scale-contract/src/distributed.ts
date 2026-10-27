/**
 * 阶段 3 · leader 权威跨进程状态端口类型（`ctx.teamDistributed`）。
 *
 * 一致性模型（spec §3.1）：**单写者**。团队状态真相源在 Lead 进程；远端成员是只读副本，
 * 一切变更回送 Lead 执行。投递语义 = **at-least-once + 幂等去重**（spec §3.2），
 * 明确**不承诺**跨进程 exactly-once。
 *
 * @module @elinpf/dsh-swarm-team-scale-contract
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PeerStatus } from './transport.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamDistributed: TeamDistributed
  }
}

export type DistributedRole = 'lead' | 'follower'

/** 权威变更种类；每种都必须可经 CAS 幂等 apply。 */
export type MutationKind = 'task.create' | 'task.update' | 'member.spawn' | 'message.send'

export type MutationAction =
  | 'claim'
  | 'release'
  | 'edit'
  | 'set_dependencies'
  | 'complete'
  | 'reopen'
  | 'assign'
  | 'delete'

export interface MutationOp {
  /** 幂等键：同一 `opId` 重复 apply 必须 no-op（返回首次的 revision）。 */
  opId: string
  kind: MutationKind
  /** CAS 期望版本（`task.update` 用）；不匹配 → 自然 no-op。 */
  expectedRevision?: number
  payload: {
    // task.create
    subject?: string
    description?: string
    blockedBy?: string[]
    // task.update
    taskId?: string
    action?: MutationAction
    owner?: string
    // member.spawn
    name?: string
    prompt?: string
    provider?: string
    // message.send
    targetId?: string
    messageId?: string
    content?: unknown[]
  }
}

export interface DistributedState {
  role: DistributedRole
  teamId: string
  /** 权威单调序号（每次 apply 递增）。 */
  seq: number
  peers: PeerStatus[]
  /** 检测到同 teamId 的第二个 Lead 时进入只读保护（spec §3.1）。 */
  splitBrain: boolean
  /** 投递观测（queued 未确认 = 待重投集合）。 */
  pending: number
  delivered: number
  dedupDropped: number
}

export interface TeamDistributed {
  readonly role: DistributedRole
  /** 声明本进程为 Lead（唯一权威）；重复 Lead 检测 → SPLIT_BRAIN 只读保护 + 告警。 */
  becomeLead(agent: Agent, teamId: string): void
  /** 作为 follower 加入远端 Lead。 */
  join(agent: Agent, leadEndpoint: string): Promise<void>
  /** 权威变更入口（仅 Lead）：单写者 apply（CAS + opId 幂等）。 */
  mutate(agent: Agent, op: MutationOp): Promise<{ revision: number }>
  /** follower 拉取增量快照。 */
  sync(agent: Agent, sinceSeq?: number): Promise<{ seq: number; state: unknown }>
  /** 投递（at-least-once + messageId 幂等键）。 */
  deliver(
    agent: Agent,
    targetId: string,
    messageId: string,
    content: unknown[],
  ): Promise<{ status: 'accepted' | 'queued' }>
  state(): DistributedState
}
