import { describe, expect, it } from 'vitest'
import TeamCompactionService from '../src/index.ts'

function makeCtx(opts: { used?: number; withCompaction?: boolean } = {}) {
  const { used = 0, withCompaction = true } = opts
  const calls: any[] = []
  const handlers: Record<string, Array<(...a: any[]) => unknown>> = {}
  const services: Record<string, unknown> = {
    teamCore: { listMembers: () => [{ id: 'lead' }, { id: 'a' }] },
    systemPrompt: {},
    tokenMeter: { used: () => used },
  }
  if (withCompaction) {
    services.compaction = {
      compactIfNeeded: async (ag: any, trigger: any, _signal: any) => {
        calls.push({ ag, trigger })
        return {}
      },
    }
  }
  const ctx: any = {
    get: (n: string) => services[n],
    on: (n: string, h: (...a: any[]) => unknown) => {
      ;(handlers[n] ??= []).push(h)
      return () => {
        const a = handlers[n]!
        const i = a.indexOf(h)
        if (i >= 0) a.splice(i, 1)
      }
    },
    effect: (fn: () => unknown) => {
      ;(ctx as any)._cleanup = fn()
      return (ctx as any)._cleanup
    },
    logger: { warn() {}, debug() {} },
    reflect: { provide() {} },
    _calls: calls,
    _handlers: handlers,
  }
  return { ctx, calls, handlers }
}

const agent = { id: 'lead' } as never

describe('@elinpf/dsh-swarm-team-compaction', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamCompactionService).toBe('function')
    expect(TeamCompactionService.inject).toEqual(['systemPrompt', 'teamCore'])
  })

  it('overBudget 判定 + 触发压缩一次（幂等）', async () => {
    const { ctx, calls } = makeCtx({ used: 200, withCompaction: true })
    const c = new TeamCompactionService(ctx, { enabled: true, maxTokens: 100 })
    expect(c.budget(agent).overBudget).toBe(true)
    expect(await c.applyPolicy(agent)).toEqual({ compacted: true })
    expect(calls).toHaveLength(1)
    // 幂等：同一段 overBudget 再调用不再压缩
    expect(await c.applyPolicy(agent)).toEqual({ compacted: false })
    expect(calls).toHaveLength(1)
  })

  it('未超预算 → 不调用压缩', async () => {
    const { ctx, calls } = makeCtx({ used: 50 })
    const c = new TeamCompactionService(ctx, { enabled: true, maxTokens: 100 })
    expect(c.budget(agent).overBudget).toBe(false)
    expect(await c.applyPolicy(agent)).toEqual({ compacted: false })
    expect(calls).toHaveLength(0)
  })

  it('enabled=false → no-op', async () => {
    const { ctx, calls } = makeCtx({ used: 999 })
    const c = new TeamCompactionService(ctx, { enabled: false, maxTokens: 100 })
    expect(await c.applyPolicy(agent)).toEqual({ compacted: false })
    expect(calls).toHaveLength(0)
  })

  it('ctx.compaction 缺失 → {compacted:false} 且不抛', async () => {
    const { ctx } = makeCtx({ used: 999, withCompaction: false })
    const c = new TeamCompactionService(ctx, { enabled: true, maxTokens: 100 })
    await expect(c.applyPolicy(agent)).resolves.toEqual({ compacted: false })
  })

  it('tokenMeter 缺失 → usedTokens=0、overBudget=false', () => {
    const { ctx } = makeCtx()
    const services = { teamCore: { listMembers: () => [] }, systemPrompt: {} }
    const ctx2: any = { ...ctx, get: (n: string) => (services as any)[n], effect: () => () => {} }
    const c = new TeamCompactionService(ctx2, { enabled: true, maxTokens: 100 })
    const b = c.budget(agent)
    expect(b.usedTokens).toBe(0)
    expect(b.overBudget).toBe(false)
  })

  it('HMR 安全：dispose 后 summary-error 监听归零', () => {
    const { ctx, handlers } = makeCtx()
    const c = new TeamCompactionService(ctx, { enabled: true, maxTokens: 100 })
    expect(c.summaryErrorCount).toBe(0)
    expect(handlers['compaction/summary-error']).toHaveLength(1)
    ;(ctx as any)._cleanup()
    expect(handlers['compaction/summary-error']).toHaveLength(0)
  })
})
