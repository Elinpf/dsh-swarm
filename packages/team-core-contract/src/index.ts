/**
 * 团队协作端口的**唯一契约**（类型 SSOT）。
 *
 * 为什么单独成包（ADR-0001，方案 C）：端口类型若与 `team-core` 的实现同处一个包，
 * 消费方在物理上就能 `import '@dsh-swarm/team-core/src/internal'`。把契约抽成独立包后，
 * 「包间只经端口通信、禁止直连实现」这条约束在**编译期**即成立——消费包只能看到这里的类型。
 *
 * 本包**只有类型**：没有 Service、没有后端、没有运行时逻辑；编译产物是空模块。
 * 运行时实现（`native`/`owned` 后端）由 `@dsh-swarm/team-core` 提供，类型一律复用本包。
 *
 * @module @dsh-swarm/team-core-contract
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
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
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
      subject?: string
      description?: string
      blockedBy?: string[]
      owner?: string
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
