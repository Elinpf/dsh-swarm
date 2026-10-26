import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

/** 最小假 ctx：记录 systemPrompt 注册、on 订阅、effect/disposer。 */
function makeCtx() {
  const sections: any[] = []
  const contexts: any[] = []
  const handlers: Record<string, Array<(...a: any[]) => unknown>> = {}
  const disposers: Array<() => void> = []
  const ctx: any = {
    systemPrompt: {
      section: (s: any) => {
        sections.push(s)
        return () => {
          const i = sections.indexOf(s)
          if (i >= 0) sections.splice(i, 1)
        }
      },
      context: (c: any) => {
        contexts.push(c)
        return () => {
          const i = contexts.indexOf(c)
          if (i >= 0) contexts.splice(i, 1)
        }
      },
    },
    on: (n: string, h: (...a: any[]) => unknown) => {
      ;(handlers[n] ??= []).push(h)
      return () => {
        const a = handlers[n]!
        const i = a.indexOf(h)
        if (i >= 0) a.splice(i, 1)
      }
    },
    teamCore: {},
    sessions: {},
    logger: { debug() {}, warn() {} },
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    _sections: sections,
    _contexts: contexts,
    _handlers: handlers,
    _disposeAll: () => disposers.forEach((d) => d()),
  }
  return ctx
}

const config = { locales: 'cn' as const, leaderProgressiveDisclosure: true, sections: [] }

function assembly() {
  return {
    sections: [
      { name: 'team:role', text: 'r' },
      { name: 'team:dispatch', text: 'd' },
      { name: 'team:task-state', text: 't' },
      { name: 'team:inbound', text: 'i' },
    ],
    contexts: [],
    tools: [],
    variables: {},
  }
}

describe('@elinpf/dsh-swarm-team-prompt', () => {
  it('导出形态：函数式插件（命名导出、无 default export）', () => {
    expect(plugin.name).toBe('team-prompt')
    expect(plugin.inject).toEqual(['systemPrompt', 'teamCore', 'sessions'])
    expect(typeof plugin.apply).toBe('function')
    expect((plugin as Record<string, unknown>).default).toBeUndefined()
  })

  it('注册稳定 section，顺序按 order 升序', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const names = ctx._sections.map((s: any) => s.name)
    expect(names).toEqual(['team:role', 'team:dispatch', 'team:task-state', 'team:inbound'])
    const orders = ctx._sections.map((s: any) => s.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })

  it('identity/roster/info 走 context，而不是 section', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    expect(ctx._contexts.map((c: any) => c.name)).toEqual([
      'team:identity',
      'team:roster',
      'team:info',
    ])
    expect(ctx._sections.some((s: any) => s.name.startsWith('team:identity'))).toBe(false)
  })

  it('渐进披露：团队建成前摘掉协作约定段，出现 teammate 后放出', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const assemble = ctx._handlers['system-prompt/assemble']![0]!
    const next = async () => assembly()

    const before = await assemble(assembly(), {}, next)
    expect(before.sections.map((s: any) => s.name)).toEqual(['team:role', 'team:inbound'])

    // 模拟 teammates 出现（team/member v2，role=teammate）
    ctx._handlers['session/event']![0]!({}, { type: 'team/member', data: { role: 'teammate' } })

    const after = await assemble(assembly(), {}, next)
    expect(after.sections.map((s: any) => s.name)).toEqual([
      'team:role',
      'team:dispatch',
      'team:task-state',
      'team:inbound',
    ])
  })

  it('HMR 安全：dispose 后 section/context/订阅全部归零', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    expect(ctx._sections).toHaveLength(4)
    ctx._disposeAll()
    expect(ctx._sections).toHaveLength(0)
    expect(ctx._contexts).toHaveLength(0)
    expect(Object.keys(ctx._handlers).every((k) => ctx._handlers[k]!.length === 0)).toBe(true)
  })
})
