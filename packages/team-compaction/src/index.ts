/**
 * 团队上下文预算：为团队设定 token 预算/配额门控，触发时**委托** `ctx.compaction` 执行压缩。
 *
 * - `budget(agent)`：聚合「已用 token（`ctx.tokenMeter`，若可用）/ 预算上限 / 成员数 / 轮次」。
 * - `applyPolicy(agent, signal)`：`overBudget` 时调 `ctx.compaction.compactIfNeeded(agent, 'pressure', signal)`；
 *   **幂等**（同一段 overBudget 只压一次，回到未超预算后重置）。
 * - 预算门控**默认关闭**（`enabled: false`，对齐迁移设计「成本可观测、规模可门控」）。
 *
 * 端口隔离：只从契约包取类型；`ctx.compaction` / `ctx.tokenMeter` 作为可选 seam（本地结构化描述）。
 *
 * @module @elinpf/dsh-swarm-team-compaction
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BudgetSnapshot, TeamCompaction } from '@elinpf/dsh-swarm-team-capability-contract'
import type { TeamCore as _TeamCore } from '@elinpf/dsh-swarm-team-core-contract'

/** 本地结构化 seam：ctx.compaction 的压缩入口。 */
interface CompactionSeam {
  compactIfNeeded(agent: Agent, trigger: string, signal?: AbortSignal): Promise<unknown>
}
/** 本地结构化 seam：ctx.tokenMeter 的用量读取。 */
interface TokenMeterSeam {
  used?(agent: Agent): number | undefined
}

export interface Config {
  /** 是否启用预算门控（默认关闭）。 */
  enabled: boolean
  /** 团队上下文 token 预算上限。 */
  maxTokens: number
}

export class TeamCompactionService extends Service implements TeamCompaction {
  static inject = ['systemPrompt', 'teamCore'] as const

  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false),
    maxTokens: z.number().step(1).min(1).default(100000),
  })

  private readonly config: Config
  private rounds = 0
  /** 幂等守卫：本段 overBudget 是否已压过。 */
  private compactedForOverBudget = false
  private summaryErrors = 0

  constructor(ctx: Context, config: Config = { enabled: false, maxTokens: 100000 }) {
    super(ctx, 'teamCompaction')
    this.config = config

    ctx.effect(() => {
      // 记录团队级压缩失败计数（**不吞掉** waterfall：返回 next()）。
      const on = ctx.on as unknown as (n: string, h: (...a: unknown[]) => unknown) => () => void
      const off = on('compaction/summary-error', (...a: unknown[]) => {
        this.summaryErrors += 1
        const next = a[a.length - 1] as (() => unknown) | undefined
        return typeof next === 'function' ? next() : undefined
      })
      return () => {
        off()
        this.compactedForOverBudget = false
        this.rounds = 0
        this.summaryErrors = 0
      }
    }, 'teamCompaction.lifecycle()')
  }

  budget(agent: Agent): BudgetSnapshot {
    const usedTokens = this.usedTokens(agent)
    const maxTokens = this.config.maxTokens
    const overBudget = maxTokens > 0 && usedTokens > maxTokens
    const members = this.ctx.get('teamCore')?.listMembers?.(agent).length ?? 0
    return { usedTokens, maxTokens, overBudget, members, rounds: this.rounds }
  }

  async applyPolicy(agent: Agent, signal?: AbortSignal): Promise<{ compacted: boolean }> {
    if (!this.config.enabled) return { compacted: false }
    const snap = this.budget(agent)
    if (!snap.overBudget) {
      this.compactedForOverBudget = false // 回到未超预算 → 重置幂等守卫
      return { compacted: false }
    }
    if (this.compactedForOverBudget) return { compacted: false } // 幂等：同一段不重复压

    const compaction = this.ctx.get('compaction') as CompactionSeam | undefined
    if (!compaction) {
      this.ctx.logger?.warn?.('team-compaction: ctx.compaction unavailable → no-op')
      return { compacted: false }
    }
    await compaction.compactIfNeeded(agent, 'pressure', signal)
    this.compactedForOverBudget = true
    this.rounds += 1
    return { compacted: true }
  }

  /** 观测用：团队级压缩失败计数。 */
  get summaryErrorCount(): number {
    return this.summaryErrors
  }

  private usedTokens(agent: Agent): number {
    const meter = this.ctx.get('tokenMeter') as TokenMeterSeam | undefined
    const used = meter?.used?.(agent)
    return typeof used === 'number' ? used : 0
  }
}

export default TeamCompactionService
