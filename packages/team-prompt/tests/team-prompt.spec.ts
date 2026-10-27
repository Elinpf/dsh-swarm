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
      { name: 'team:leader', text: 'l' },
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
    expect(names).toEqual([
      'team:leader',
      'team:role',
      'team:dispatch',
      'team:task-state',
      'team:inbound',
    ])
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
    expect(before.sections.map((s: any) => s.name)).toEqual([
      'team:leader',
      'team:role',
      'team:inbound',
    ])

    // 模拟 teammates 出现（team/member v2，role=teammate）
    ctx._handlers['session/event']![0]!({}, { type: 'team/member', data: { role: 'teammate' } })

    const after = await assemble(assembly(), {}, next)
    expect(after.sections.map((s: any) => s.name)).toEqual([
      'team:leader',
      'team:role',
      'team:dispatch',
      'team:task-state',
      'team:inbound',
    ])
  })

  it('HMR 安全：dispose 后 section/context/订阅全部归零', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    expect(ctx._sections).toHaveLength(5)
    ctx._disposeAll()
    expect(ctx._sections).toHaveLength(0)
    expect(ctx._contexts).toHaveLength(0)
    expect(Object.keys(ctx._handlers).every((k) => ctx._handlers[k]!.length === 0)).toBe(true)
  })
})

describe('P46 leader 等待模型提示（event-wake 默认）', () => {
  it('默认 event-wake：team:dispatch 提示「派发后结束轮次、不要 wait_agent 长阻塞」', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { ...config, leaderWaitModel: 'event-wake' })
    const dispatch = ctx._sections.find((s: any) => s.name === 'team:dispatch')
    expect(dispatch.text).toContain('结束你的轮次')
    expect(dispatch.text).toContain('wait_agent')
    expect(ctx._sections).toHaveLength(5) // 段数不变（含 team:leader）
  })

  it('blocking-allowed：保留「可同步等待」旧口径', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { ...config, leaderWaitModel: 'blocking-allowed' })
    const dispatch = ctx._sections.find((s: any) => s.name === 'team:dispatch')
    expect(dispatch.text).toContain('可选')
    expect(dispatch.text).not.toContain('结束你的轮次')
  })
})

describe('P54 Leader 专属行为约束（只调度不干活，team:leader）', () => {
  it('新段存在且内容覆盖高优先级 3 条（不执行 / 先建成员 / 背景不清先调研）', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader).toBeDefined()
    // order 靠前（在 team:role 之前）
    const role = ctx._sections.find((s: any) => s.name === 'team:role')
    expect(leader.order).toBeLessThan(role.order)
    // 负向禁令：点名「查资料 / 读代码 / 写报告」
    expect(leader.text).toContain('不亲自执行任务')
    expect(leader.text).toContain('查资料')
    expect(leader.text).toContain('读代码')
    expect(leader.text).toContain('写报告')
    // 起手动作：先 spawn_teammate + team_task_create
    expect(leader.text).toContain('spawn_teammate')
    expect(leader.text).toContain('team_task_create')
    expect(leader.text).toContain('成员必须先于任务存在')
    // 背景不清先建专职调研成员，不要自己去查
    expect(leader.text).toContain('不要自己去查')
    expect(leader.text).toContain('专职调研成员')
  })

  it('team:leader 不被 leaderProgressiveDisclosure 过滤（团队未建时也渲染）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const assemble = ctx._handlers['system-prompt/assemble']![0]!
    const next = async () => assembly()
    // 团队尚未建成（无 team/member 事件）
    const result = await assemble(assembly(), {}, next)
    const names = result.sections.map((s: any) => s.name)
    expect(names).toContain('team:leader')
    // 同时确认协作约定段确实被摘掉（对照组，证明过滤逻辑本身在工作）
    expect(names).not.toContain('team:dispatch')
    expect(names).not.toContain('team:task-state')
  })

  it('英文语种下 team:leader 输出英文约束', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { ...config, locales: 'en' })
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('Team Lead')
    expect(leader.text).toContain('do not look things up, read code, or write reports')
    expect(leader.text).toContain('spawn_teammate')
  })

  it('STABLE_SECTION_NAMES 暴露 team:leader', () => {
    expect(plugin.STABLE_SECTION_NAMES).toContain('team:leader')
  })
})
