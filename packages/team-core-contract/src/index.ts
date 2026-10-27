/**
 * 团队协作端口的**唯一契约**（类型 SSOT）。
 *
 * 为什么单独成包（ADR-0001，方案 C）：端口类型若与 `team-core` 的实现同处一个包，
 * 消费方在物理上就能 `import '@elinpf/dsh-swarm-team-core/src/internal'`。把契约抽成独立包后，
 * 「包间只经端口通信、禁止直连实现」这条约束在**编译期**即成立——消费包只能看到这里的类型。
 *
 * 本包**只有类型**：没有 Service、没有后端、没有运行时逻辑；编译产物是空模块。
 * 运行时实现（`native`/`owned` 后端）由 `@elinpf/dsh-swarm-team-core` 提供，类型一律复用本包。
 *
 * @module @elinpf/dsh-swarm-team-core-contract
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

// 让所有依赖本契约的包的 ctx 都带上 ctx.teamCore 的类型（类型增强放契约包，见 ADR-0001）。
declare module '@deepseek-ai/cordis' {
  interface Context {
    teamCore: TeamCore
  }
}

export type TeamRole = 'lead' | 'teammate'

export type MemberPhase = 'provisioning' | 'active' | 'failed'

export type MemberStatus = 'running' | 'idle' | 'inactive'

export interface MemberView {
  id: string
  name: string
  role: TeamRole
  phase: MemberPhase
  status: MemberStatus
  desc?: string
}

export type MessageRange =
  | { kind: 'dm'; to: string }
  | { kind: 'multicast'; targets: string[] }
  | { kind: 'broadcast' }

export interface TaskView {
  id: string
  revision: number
  subject: string
  description: string
  /**
   * `in_review` / `planned` 是本端口在原生 `pending|in_progress|completed|deleted` 之上的**叠加态**：
   * 原生没有这两个态，故由 `team-core` 侧记录，经本端口的读/写分别呈现为 `in_review`（评审）/ `planned`（计划闸待批）。
   */
  status: 'pending' | 'in_progress' | 'in_review' | 'planned' | 'completed' | 'deleted'
  blockedBy: string[]
  ownerName?: string
  ready: boolean
}

export interface TeamMembership {
  id: string
  role: TeamRole
  name: string
}

/** 团队协作的稳定端口；实现可切换 DSH 原生 `ctx.agentTeams` 或自建后端。 */
export interface TeamCore {
  readonly backend: 'native' | 'owned'

  membership(agent: Agent): TeamMembership
  listMembers(agent: Agent): MemberView[]

  spawn(
    caller: Agent,
    req: {
      name: string
      description: string
      prompt: ContentBlock[]
      context: 'fresh' | 'fork'
      provider: string
      signal: AbortSignal
    },
  ): Promise<MemberView>

  /** 统一消息入口：range 决定 DM/多播/广播（阶段 0 仅支持 dm，多播/广播由 team-bus 提供）。 */
  send(
    caller: Agent,
    req: {
      range: MessageRange
      content: ContentBlock[]
      delivery: 'quiet' | 'wakeup'
      /** 来源（P51 扩展）：`'broadcast'`（公告类，**不计入未读/pending 台账**）| `'directed'`（默认，计入）。 */
      origin?: 'broadcast' | 'directed'
    },
  ): Promise<{ messageId: string; status: 'accepted' | 'queued' }>

  createTask(
    caller: Agent,
    req: {
      subject: string
      description: string
      blockedBy?: string[]
      writeScopes?: string[]
    },
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
        | 'assign'
        | 'delete'
        /** 进入评审：`in_progress → in_review`（仅 in_progress 合法，其余被拒）。 */
        | 'submit_review'
        /** 评审返工：`in_review → in_progress`（仅 in_review 合法，其余被拒）。 */
        | 'reject_review'
        /** 计划闸-入闸：`pending → planned`（仅 pending 合法）。 */
        | 'open_plan'
        /** 计划闸-提交计划：任务保持 `planned`（承载计划正文 `plan`）。 */
        | 'submit_plan'
        /** 计划闸-批准：`planned → pending`（仅 planned 合法；批准后可执行）。 */
        | 'approve_plan'
        /** 计划闸-驳回：任务保持 `planned`（仅 planned 合法；携带 `feedback` 供修改）。 */
        | 'reject_plan'
      subject?: string
      description?: string
      blockedBy?: string[]
      owner?: string
      /** 计划闸：计划正文（`submit_plan` 用）。 */
      plan?: string
      /** 计划闸 / 返工：驳回或返工反馈（`reject_plan` / `reject_review` 用）。 */
      feedback?: string
    },
  ): Promise<TaskView>

  waitForChange(
    caller: Agent,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ timedOut: boolean }>
  interrupt(caller: Agent, targetName: string): Promise<{ previousStatus: MemberStatus }>
  tryMembership(agent: Agent): TeamMembership | undefined
}
