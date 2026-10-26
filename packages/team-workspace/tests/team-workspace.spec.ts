import { afterEach, describe, expect, it, vi } from 'vitest'
import TeamWorkspaceService from '../src/index.ts'

function makeCtx(opts: { withFs?: boolean; withWorktrees?: boolean } = {}) {
  const { withFs = true, withWorktrees = true } = opts
  const members = [
    { id: 'a', name: 'alice' },
    { id: 'b', name: 'bob' },
  ]
  const handlers: Record<string, Array<(...a: any[]) => unknown>> = {}
  const disposers: Array<() => void> = []
  const created: any[] = []
  const services: Record<string, unknown> = {
    teamCore: { tryMembership: (ag: { id?: string }) => members.find((m) => m.id === ag?.id) },
    agents: {},
    sessions: {},
  }
  if (withFs) services.fs = { writeText: async () => ({}) }
  if (withWorktrees)
    services.worktrees = {
      create: async (ag: any, req: any) => {
        created.push({ ag, req })
        return {
          path: `/wt/${req?.name ?? 'x'}`,
          branch: `b/${req?.name ?? 'x'}`,
          baseCommit: 'abc123',
          repositoryRoot: '/repo',
        }
      },
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
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    logger: { warn() {}, debug() {} },
    reflect: { provide() {} },
    _handlers: handlers,
    _disposeAll: () => disposers.forEach((d) => d()),
  }
  return { ctx, handlers, created }
}

const cfg = { defaultTtlMs: 900000, enforceWriteGuard: true, sweepIntervalMs: 30000 }
const A = { id: 'a' } as never
const B = { id: 'b' } as never
const actorA = { agent: { id: 'a' } }
const actorB = { agent: { id: 'b' } }
const target = (path: string) => ({ path })

afterEach(() => vi.useRealTimers())

describe('@elinpf/dsh-swarm-team-workspace', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamWorkspaceService).toBe('function')
    expect(TeamWorkspaceService.inject).toEqual(['teamCore', 'agents', 'sessions'])
  })

  it('createWorktree 复用 seam；缺失时抛 TEAMWS_WORKTREE_UNAVAILABLE', async () => {
    const { ctx, created } = makeCtx({ withWorktrees: true })
    const ws = new TeamWorkspaceService(ctx, cfg)
    const rec = await ws.createWorktree(A, { name: 'a' })
    expect(rec).toMatchObject({ path: '/wt/a', branch: 'b/a', baseCommit: 'abc123' })
    expect(created).toHaveLength(1)
    expect(ws.currentWorktree(A)).toEqual(rec)

    const noWt = makeCtx({ withWorktrees: false })
    const ws2 = new TeamWorkspaceService(noWt.ctx, cfg)
    await expect(ws2.createWorktree(A)).rejects.toThrow(/TEAMWS_WORKTREE_UNAVAILABLE/)
  })

  it('独占锁互斥：A 锁 src → B 锁 src/x 冲突', async () => {
    const { ctx } = makeCtx()
    const ws = new TeamWorkspaceService(ctx, cfg)
    await ws.acquireLock(A, { path: 'src', mode: 'exclusive' })
    await expect(ws.acquireLock(B, { path: 'src/x.ts', mode: 'exclusive' })).rejects.toThrow(
      /TEAMWS_LOCK_CONFLICT/,
    )
    // shared 与 exclusive 也冲突
    await expect(ws.acquireLock(B, { path: 'src/y.ts', mode: 'shared' })).rejects.toThrow(
      /TEAMWS_LOCK_CONFLICT/,
    )
  })

  it('写域守卫：他人写被拒（throw），持有者写放行（调用 next）', async () => {
    const { ctx, handlers } = makeCtx()
    const ws = new TeamWorkspaceService(ctx, cfg)
    const lock = await ws.acquireLock(A, { path: 'src', mode: 'exclusive' })
    const guard = handlers['fs/write-intent']![0]!

    // B 写 src/x.ts → 拒
    let nextCalled = false
    await expect(
      Promise.resolve(guard(target('src/x.ts'), actorB, () => ((nextCalled = true), undefined))),
    ).rejects.toThrow(/FS_WRITE_DENIED/)
    expect(nextCalled).toBe(false)

    // A 写 src/x.ts → 放行
    const r = await guard(target('src/x.ts'), actorA, () => ((nextCalled = true), 'intent'))
    expect(r).toBe('intent')
    expect(nextCalled).toBe(true)

    // 释放后 B 写放行
    await ws.releaseLock(A, lock)
    const r2 = await guard(target('src/x.ts'), actorB, () => 'ok')
    expect(r2).toBe('ok')
  })

  it('锁 TTL 到点自动回收', async () => {
    vi.useFakeTimers()
    const { ctx } = makeCtx()
    const ws = new TeamWorkspaceService(ctx, { ...cfg, defaultTtlMs: 1000, sweepIntervalMs: 500 })
    await ws.acquireLock(A, { path: 'src', mode: 'exclusive' })
    expect(ws.listLocks()).toHaveLength(1)
    vi.advanceTimersByTime(1500) // 触发 sweep 定时器
    expect(ws.listLocks()).toHaveLength(0)
  })

  it('HMR 安全：dispose 后锁清空、两个守卫撤销', async () => {
    const { ctx, handlers } = makeCtx()
    const ws = new TeamWorkspaceService(ctx, cfg)
    await ws.acquireLock(A, { path: 'src', mode: 'exclusive' })
    expect(ws.listLocks()).toHaveLength(1)
    expect(handlers['fs/write-intent']).toHaveLength(1)
    expect(handlers['fs/edit-intent']).toHaveLength(1)

    ctx._disposeAll()
    expect(ws.listLocks()).toHaveLength(0)
    expect(handlers['fs/write-intent']).toHaveLength(0)
    expect(handlers['fs/edit-intent']).toHaveLength(0)
  })

  it('enforceWriteGuard=false → 守卫不拦截', async () => {
    const { ctx, handlers } = makeCtx()
    const ws = new TeamWorkspaceService(ctx, { ...cfg, enforceWriteGuard: false })
    await ws.acquireLock(A, { path: 'src', mode: 'exclusive' })
    expect(handlers['fs/write-intent'] ?? []).toHaveLength(0)
  })
})
