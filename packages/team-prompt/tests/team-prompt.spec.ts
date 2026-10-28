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

    // 模拟 teammates 出现：使用**真实** team/member v2 形状
    // data = { version, teamId, member: { id, name, description, provider, context, phase } }
    ctx._handlers['session/event']![0]!(
      {},
      {
        type: 'team/member',
        data: {
          version: 2,
          teamId: 'team-1',
          member: {
            id: 'm1',
            name: 'alice',
            description: '',
            provider: 'spawn',
            context: 'fresh',
            phase: 'active',
          },
        },
      },
    )

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

describe('P57 等待模型硬约束提升到常驻 team:leader（治 wait_agent 长轮询）', () => {
  it('常驻段含「派发后结束轮次 / 默认禁止长阻塞 / 单次短 wait / 绝不轮询」', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    // 事件唤醒优先：派发后结束轮次，由消息唤醒新一轮
    expect(leader.text).toContain('结束你的轮次')
    expect(leader.text).toContain('唤醒你开新一轮')
    // 硬约束：默认禁止长阻塞 + 绝不轮询
    expect(leader.text).toContain('默认禁止长阻塞')
    expect(leader.text).toContain('不要反复轮询')
    expect(leader.text).toContain('绝不连续多次 wait')
    // 有上限的口子：单次、带超时
    expect(leader.text).toContain('一次、带超时上限')
    // 与上游「收尾前要等齐」的显式调和（靠事件唤醒聚合，不是原地阻塞）
    expect(leader.text).toContain('事件唤醒按轮聚合')
  })

  it('该硬约束在常驻段、不被渐进披露过滤（团队未建时也在）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const assemble = ctx._handlers['system-prompt/assemble']![0]!
    const next = async () => assembly()
    const before = await assemble(assembly(), {}, next)
    // 常驻段 team:leader 未被摘掉（文本断言见注册测试与集成测试；此处 assembly 为占位文本）
    expect(before.sections.some((s: any) => s.name === 'team:leader')).toBe(true)
    // 对照组：被延迟的 team:dispatch 在团队未建时确实不在
    expect(before.sections.some((s: any) => s.name === 'team:dispatch')).toBe(false)
    // 且该常驻段的注册文本确实含硬约束（从注册处取，非占位 assembly）
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('默认禁止长阻塞')
  })

  it('英文常驻段同样含等待硬约束', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { ...config, locales: 'en' })
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('long blocking is forbidden by default')
    expect(leader.text).toContain('END YOUR TURN')
    expect(leader.text).toContain('NEVER wait multiple times in a row')
  })
})

describe('P57 修 teamBuilt 判定 bug（渐进披露形状错配 → 永久过滤）', () => {
  /** 用真实 team/member v2 事件驱动装配，返回放出后的 section 名单。 */
  async function namesAfter(ctx: any, event: unknown): Promise<string[]> {
    const assemble = ctx._handlers['system-prompt/assemble']![0]!
    const next = async () => assembly()
    ctx._handlers['session/event']![0]!({}, event)
    const result = await assemble(assembly(), {}, next)
    return result.sections.map((s: any) => s.name)
  }

  it('真实形状 {version, teamId, member:{...}} → dispatch/task-state 被释放（hasDispatch=true）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const names = await namesAfter(ctx, {
      type: 'team/member',
      data: {
        version: 2,
        teamId: 'team-1',
        member: {
          id: 'm1',
          name: 'bob',
          description: '',
          provider: 'spawn',
          context: 'fresh',
          phase: 'provisioning',
        },
      },
    })
    expect(names).toContain('team:dispatch')
    expect(names).toContain('team:task-state')
  })

  it('回归防护：旧错误形状 {data:{role}} 不触发释放（固化 bug 记忆）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const names = await namesAfter(ctx, { type: 'team/member', data: { role: 'teammate' } })
    // 该形状不是真实事件，故不应释放——若此断言变红，说明判定又被写入错误字段
    expect(names).not.toContain('team:dispatch')
  })
})

describe('P62 协同质量判据（广播/多播发起 + 收口期追问，常驻 team:leader）', () => {
  it('① 发起协同判据：三类通道 + 影响面判据 + broadcast 少而重 + DSH 无 @', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader).toBeDefined()
    // 三类通道都点名
    expect(leader.text).toContain('broadcast')
    expect(leader.text).toContain('multicast(targets=')
    expect(leader.text).toContain('send_message')
    // 影响面判据
    expect(leader.text).toContain('影响面')
    // 广播「少而重」+ 唤醒全体非发送者（防把广播变刷屏）
    expect(leader.text).toContain('少而重')
    expect(leader.text).toContain('唤醒全体非发送者')
    // DSH 无 @/mention 工具 → 点名落 targets；@ 仅人类可读
    expect(leader.text).toContain('没有 `@`')
    expect(leader.text).toContain('targets')
  })

  it('④ 收口期追问：向成员 DM 追问、不自己重做、不直接收口、含追问模板', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('收口')
    expect(leader.text).toContain('追问')
    expect(leader.text).toContain('不自己重做')
    expect(leader.text).toContain('请补充')
  })

  it('新引导在常驻段、团队未建时也渲染（不被渐进披露过滤）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    // 注册处文本（非占位 assembly）含新引导
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('multicast(targets=')
    expect(leader.text).toContain('追问')
    // 团队未建时 team:leader 仍在，被延迟的 team:dispatch 不在（对照）
    const assemble = ctx._handlers['system-prompt/assemble']![0]!
    const next = async () => assembly()
    const before = await assemble(assembly(), {}, next)
    expect(before.sections.some((s: any) => s.name === 'team:leader')).toBe(true)
    expect(before.sections.some((s: any) => s.name === 'team:dispatch')).toBe(false)
  })

  it('英文语种下同样含发起判据与追问引导', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { ...config, locales: 'en' })
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('blast radius')
    expect(leader.text).toContain('few and heavy')
    expect(leader.text).toContain('no `@`/mention tool')
    expect(leader.text).toContain('follow up')
  })
})

describe('P64 显示名 + @ 可读约定（常驻 team:leader，与 P62 配套）', () => {
  it('⑦ 中文显示名：给示例，并要求内部 name/slug 仍英文', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('中文显示名')
    expect(leader.text).toContain('行业调研员')
    expect(leader.text).toContain('slug')
    expect(leader.text).toContain('仍用英文')
  })

  it('⑧ @名字 可读约定：文本 @ 给人看、机制点名仍走 multicast(targets)', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('@<显示名>')
    expect(leader.text).toContain('multicast(targets=')
    expect(leader.text).toContain('给人')
    expect(leader.text).toContain('请你做 X')
  })

  it('新句在常驻段、团队未建也渲染（不被渐进披露过滤）', async () => {
    const ctx = makeCtx()
    plugin.apply(ctx, config)
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('中文显示名')
    const assemble = ctx._handlers['system-prompt/assemble']![0]!
    const next = async () => assembly()
    const before = await assemble(assembly(), {}, next)
    expect(before.sections.some((s: any) => s.name === 'team:leader')).toBe(true)
    expect(before.sections.some((s: any) => s.name === 'team:dispatch')).toBe(false)
  })

  it('英文语种含 display name 与 @ convention', () => {
    const ctx = makeCtx()
    plugin.apply(ctx, { ...config, locales: 'en' })
    const leader = ctx._sections.find((s: any) => s.name === 'team:leader')
    expect(leader.text).toContain('short Chinese display name')
    expect(leader.text).toContain('human-readable')
    expect(leader.text).toContain('multicast(targets=')
  })
})
