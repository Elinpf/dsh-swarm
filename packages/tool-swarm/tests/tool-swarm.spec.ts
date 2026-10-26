import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

function makeCtx(services: Record<string, unknown> = {}) {
  const tools: any[] = []
  const disposers: Array<() => void> = []
  const all: Record<string, unknown> = {
    agents: { list: () => [{ id: 'lead', name: 'lead' }] },
    ...services,
  }
  const ctx: any = {
    tools: {
      register: (t: any) => {
        tools.push(t)
        return () => {
          const i = tools.indexOf(t)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
    get: (n: string) => all[n],
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    logger: { warn() {}, debug() {} },
    _tools: tools,
    _disposeAll: () => disposers.forEach((d) => d()),
  }
  return ctx
}

const busMock = () => {
  const calls: any[] = []
  return {
    calls,
    broadcast: async (caller: any, req: any) => {
      calls.push({ caller, req })
      return { messageId: 'b1' }
    },
    multicast: async () => ({ messageId: 'm1' }),
  }
}
const reviewMock = {
  submitForReview: async () => ({ id: 't1', status: 'in_progress' }),
  vote: async () => {},
}
const coreMock = { listTasks: () => [], listMembers: () => [] }

describe('@elinpf/dsh-swarm-tool-swarm', () => {
  it('导出形态：函数式插件（命名导出、无 default export）', () => {
    expect(plugin.name).toBe('tool-swarm')
    expect(typeof plugin.apply).toBe('function')
    expect((plugin as Record<string, unknown>).default).toBeUndefined()
  })

  it('全依赖在位 + enableReview → 注册 5 个工具', () => {
    const ctx = makeCtx({ teamBus: busMock(), teamReview: reviewMock, teamCore: coreMock })
    plugin.apply(ctx, { enableBroadcast: true, enableReview: true })
    expect(ctx._tools.map((t: any) => t.name).sort()).toEqual([
      'broadcast',
      'multicast',
      'review_submit',
      'review_vote',
      'team_summary',
    ])
  })

  it('缺 teamBus → broadcast/multicast 不注册（不报错）', () => {
    const ctx = makeCtx({ teamReview: reviewMock, teamCore: coreMock })
    plugin.apply(ctx, { enableBroadcast: true, enableReview: true })
    const names = ctx._tools.map((t: any) => t.name)
    expect(names).not.toContain('broadcast')
    expect(names).not.toContain('multicast')
    expect(names).toEqual(expect.arrayContaining(['review_submit', 'team_summary']))
  })

  it('enableReview=false → 不暴露评审工具', () => {
    const ctx = makeCtx({ teamBus: busMock(), teamReview: reviewMock, teamCore: coreMock })
    plugin.apply(ctx, { enableBroadcast: true, enableReview: false })
    const names = ctx._tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['broadcast', 'multicast', 'team_summary']))
    expect(names).not.toContain('review_submit')
  })

  it('broadcast 工具执行 → 等价调用 teamBus.broadcast', async () => {
    const bus = busMock()
    const ctx = makeCtx({ teamBus: bus, teamCore: coreMock })
    plugin.apply(ctx, { enableBroadcast: true, enableReview: false })
    const tool = ctx._tools.find((t: any) => t.name === 'broadcast')
    const value = await tool.execute({ content: 'hi', topic: 'team' }, { agent: { id: 'lead' } })
    expect(value.text).toContain('b1')
    expect(bus.calls).toHaveLength(1)
    expect(bus.calls[0].req.content[0].text).toBe('hi')
  })

  it('HMR 安全：dispose 后工具归零', () => {
    const ctx = makeCtx({ teamBus: busMock(), teamCore: coreMock })
    plugin.apply(ctx, { enableBroadcast: true, enableReview: false })
    expect(ctx._tools.length).toBeGreaterThan(0)
    ctx._disposeAll()
    expect(ctx._tools).toHaveLength(0)
  })

  it('阶段2：enableWorkspace/enableSkills/enableMemory 时注册对应工具', () => {
    const ws = {
      acquireLock: async () => ({ id: 'l1', mode: 'exclusive', path: 'src' }),
      releaseLock: async () => {},
      createWorktree: async () => ({ path: '/wt/a' }),
    }
    const skills = { visibleTo: () => ['arch-design'] }
    const mem = { recall: () => [{ text: 'shared-note' }] }
    const ctx = makeCtx({ teamWorkspace: ws, teamSkills: skills, teamMemory: mem })
    plugin.apply(ctx, {
      enableBroadcast: false,
      enableReview: false,
      enableWorkspace: true,
      enableSkills: true,
      enableMemory: true,
    })
    const names = ctx._tools.map((t: any) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'workspace_lock',
        'workspace_unlock',
        'workspace_worktree',
        'skills_visible',
        'memory_recall',
      ]),
    )
  })

  it('阶段2：依赖缺失时对应工具不注册', () => {
    const ctx = makeCtx({})
    plugin.apply(ctx, {
      enableBroadcast: false,
      enableReview: false,
      enableWorkspace: true,
      enableSkills: true,
      enableMemory: true,
    })
    const names = ctx._tools.map((t: any) => t.name)
    expect(names).not.toContain('workspace_lock')
    expect(names).not.toContain('skills_visible')
    expect(names).not.toContain('memory_recall')
  })
})
