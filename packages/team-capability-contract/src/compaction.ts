/**
 * 阶段 2 · 上下文预算端口 `ctx.teamCompaction` 的类型契约。
 * @module @elinpf/dsh-swarm-team-capability-contract/compaction
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamCompaction: TeamCompaction
  }
}

export interface BudgetSnapshot {
  usedTokens: number
  maxTokens: number
  overBudget: boolean
  members: number
  rounds: number
}

/** 团队上下文预算/配额策略；触发时委托 ctx.compaction 执行压缩。 */
export interface TeamCompaction {
  budget(agent: Agent): BudgetSnapshot
  /** 在预算/配额触发时委托 ctx.compaction 执行一次压缩（幂等）。 */
  applyPolicy(agent: Agent, signal?: AbortSignal): Promise<{ compacted: boolean }>
}
