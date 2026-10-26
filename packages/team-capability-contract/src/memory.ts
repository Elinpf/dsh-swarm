/**
 * 阶段 2 · 记忆端口 `ctx.teamMemory` 的类型契约。
 * @module @elinpf/dsh-swarm-team-capability-contract/memory
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamMemory: TeamMemory
  }
}

export interface MemoryRecord {
  id: string
  scope: 'shared' | 'member'
  memberId?: string
  text: string
  at: number
}

/** 全体只读的共享 TEAM_MEMORY + 成员私有记忆。 */
export interface TeamMemory {
  readShared(agent: Agent): MemoryRecord[]
  /** 授权：Lead（或 config 放行）。 */
  appendShared(caller: Agent, text: string): Promise<MemoryRecord>
  /** 写自己的私有记忆。 */
  memberNote(agent: Agent, text: string): Promise<MemoryRecord>
  /** 共享 + 本人私有。 */
  recall(agent: Agent): MemoryRecord[]
}
