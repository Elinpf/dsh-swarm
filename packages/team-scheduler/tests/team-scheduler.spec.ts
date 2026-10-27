import { afterEach, describe, expect, it, vi } from 'vitest'
import TeamSchedulerService from '../src/index.ts'

function makeCtx(
  opts: { members?: any[]; tasks?: any[]; throwOnList?: boolean; agents?: any[] } = {},
) {
  const members = opts.members ?? [
    { id: 'lead', name: 'lead', role: 'lead', phase: 'active', status: 'running' },
    { id: 'w', name: 'w', role: 'teammate', phase: 'active', status: 'idle' },
  ]
  const tasks = opts.tasks ?? [
    (globalThis as any).__task ?? {
      id: 't1',
      revision: 0,
      subject: 's',
      description: '',
      status: 'pending',
      blockedBy: [],
      ready: true,
    },
  ]
  const sent: Array<{ from: string; to: string; text: string }> = []
  const emissions: Array<{ type: string; payload: any }> = []
  const onHandlers: Record<string, Array<() => void>> = {}
  const injectCallbacks: Array<(c: any) => unknown> = []
  const disposers: Array<() => void> = []
  const agentsService = { list: () => opts.agents ?? [] }
  const services: Record<string, unknown> = {}
  const teamCore = {
    backend: 'native' as const,
    listMembers: () => {
      if (opts.throwOnList) throw new Error('boom')
      return members
    },
    listTasks: () => tasks,
    tryMembership: (a: { id?: string }) => members.find((m) => m.id === a?.id),
    updateTask: async (_c: unknown, req: any) => {
      const t = tasks.find((x: any) => x.id === req.taskId)!
      if (t.revision !== req.expectedRevision) throw new Error('CAS conflict')
      if (req.action === 'claim' || req.action === 'assign') {
        t.status = 'in_progress'
        if (req.owner) t.ownerName = req.owner
        t.revision += 1
      }
      return { ...t }
    },
    send: async (caller: { id: string }, req: any) => {
      sent.push({ from: caller.id, to: req.range.to, text: req.content?.[0]?.text ?? '' })
      return { messageId: 'm', status: 'accepted' as const }
    },
  }
  const ctx: any = {
    teamCore,
    teamBus: {},
    agents: agentsService,
    systemPrompt: {},
    get: (n: string) =>
      n === 'agents' ? agentsService : n === 'teamCore' ? teamCore : services[n],
    inject: (_deps: string[], cb: (c: any) => unknown) => {
      injectCallbacks.push(cb)
      return () => {}
    },
    logger: { warn() {}, debug() {}, info() {} },
    reflect: { provide: (n: string, v: unknown) => void (services[n] = v) },
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    _sent: sent,
    _tasks: tasks,
    emit: (t: string, pay: unknown) => emissions.push({ type: t, payload: pay }),
    on: (name: string, h: () => void) => {
      ;(onHandlers[name] ??= []).push(h)
      return () => {}
    },
    _disposeAll: () => disposers.forEach((d) => d()),
  }
  return { ctx, sent, tasks, teamCore, emissions, onHandlers, injectCallbacks }
}

const agent = { id: 'lead', name: 'lead' } as never
const cfg = (over: Partial<any> = {}) => ({
  mode: 'autonomous' as const,
  pollMs: 30000,
  staleClaimIdleMs: 600000,
  staleEscalateStreak: 3,
  busyTaskStatuses: ['pending', 'in_progress', 'in_review'] as Array<
    'pending' | 'in_progress' | 'in_review'
  >,
  reviewStallMs: 1800000,
  autoArm: true,
  ...over,
})

afterEach(() => vi.useRealTimers())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** 断言式轮询：避免固定 setTimeout 窗口造成的偶发假红（见 P42 追加要求）。 */
async function waitFor(fn: () => boolean, timeout = 2000, step = 5): Promise<boolean> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (fn()) return true
    await sleep(step)
  }
  return fn()
}
/** 负向断言的**有界**观察窗（证明「不发生」必须观察一段时间）。 */
const OBSERVE_MS = 200

describe('@elinpf/dsh-swarm-team-scheduler', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamSchedulerService).toBe('function')
    expect(TeamSchedulerService.inject).toEqual(['teamCore', 'teamBus', 'agents', 'systemPrompt'])
  })

  it('autonomous：nudge 空闲成员去认领，但不预派（started=0）', async () => {
    const { ctx, sent } = makeCtx()
    const sch = new TeamSchedulerService(ctx, cfg({ mode: 'autonomous' }))
    const report = await sch.scan(agent)
    expect(report.started).toBe(0)
    expect(sent.some((s) => s.to === 'w')).toBe(true)
    expect(sent.some((s) => s.to === 'lead')).toBe(false)
  })

  it('scheduled：启动最早就绪任务，且幂等（第二次不再启动）', async () => {
    const { ctx, tasks } = makeCtx()
    const sch = new TeamSchedulerService(ctx, cfg({ mode: 'scheduled' }))
    const r1 = await sch.scan(agent)
    expect(r1.started).toBeGreaterThanOrEqual(1)
    expect(tasks[0]!.status).toBe('in_progress')
    expect(tasks[0]!.ownerName).toBe('w')

    const r2 = await sch.scan(agent)
    expect(r2.started).toBe(0) // 成员已有活跃任务 → 不重复启动
  })

  it('stale：超时 1 次 nudge；连续 streak 次 → 向 Lead 升级', async () => {
    vi.useFakeTimers()
    const tasks = [
      {
        id: 't1',
        revision: 1,
        subject: 's',
        description: '',
        status: 'in_progress',
        blockedBy: [],
        ownerName: 'w',
        ready: false,
      },
    ]
    const { ctx, sent } = makeCtx({ tasks })
    const sch = new TeamSchedulerService(
      ctx,
      cfg({ mode: 'autonomous', staleClaimIdleMs: 1000, staleEscalateStreak: 3 }),
    )

    vi.advanceTimersByTime(1001)
    const r1 = await sch.scan(agent)
    expect(r1.staleNudged).toBe(1)
    expect(sent.filter((s) => s.to === 'w').length).toBe(1)

    vi.advanceTimersByTime(1001)
    await sch.scan(agent)
    vi.advanceTimersByTime(1001)
    await sch.scan(agent)

    expect(sent.some((s) => s.to === 'lead' && s.text.includes('escalation'))).toBe(true)
  })

  it('review_stall：in_review 停留超阈值 → 向 Lead 升级一次（不重复）', async () => {
    vi.useFakeTimers()
    const tasks = [
      {
        id: 't1',
        revision: 1,
        subject: 's',
        description: '',
        status: 'in_review',
        blockedBy: [],
        ownerName: 'w',
        ready: false,
      },
    ]
    const { ctx, sent } = makeCtx({ tasks })
    const sch = new TeamSchedulerService(ctx, cfg({ mode: 'autonomous', reviewStallMs: 1000 }))
    // 首扫只登记 in_review 起始时刻，尚未超阈值
    expect((await sch.scan(agent)).reviewStalled).toBe(0)
    vi.advanceTimersByTime(1001)
    expect((await sch.scan(agent)).reviewStalled).toBe(1)
    expect(sent.some((s) => s.to === 'lead' && s.text.includes('review_stall'))).toBe(true)
    // 同一卡住的评审只升一次
    vi.advanceTimersByTime(1001)
    expect((await sch.scan(agent)).reviewStalled).toBe(0)
  })

  it('降级：scheduled 连续抛错 3 次 → mode 变为 autonomous', async () => {
    const { ctx } = makeCtx({ throwOnList: true })
    const sch = new TeamSchedulerService(ctx, cfg({ mode: 'scheduled' }))
    await expect(sch.scan(agent)).rejects.toThrow('boom')
    await expect(sch.scan(agent)).rejects.toThrow('boom')
    expect(sch.mode).toBe('scheduled')
    await expect(sch.scan(agent)).rejects.toThrow('boom')
    expect(sch.mode).toBe('autonomous')
  })

  it('arm/dispose：定时器随卸载清除（无悬挂 tick）', async () => {
    vi.useFakeTimers()
    let listCalls = 0
    const { ctx } = makeCtx()
    const orig = ctx.teamCore.listMembers
    ctx.teamCore.listMembers = () => {
      listCalls += 1
      return orig()
    }
    const sch = new TeamSchedulerService(ctx, cfg({ pollMs: 1000 }))
    const stop = sch.arm(agent)
    vi.advanceTimersByTime(3000)
    await vi.runOnlyPendingTimersAsync()
    const callsWhileArmed = listCalls
    expect(callsWhileArmed).toBeGreaterThan(0)

    stop()
    vi.advanceTimersByTime(3000)
    await vi.runOnlyPendingTimersAsync()
    expect(listCalls).toBe(callsWhileArmed) // 卸载后不再 tick
  })

  it('计划闸（P30/T9）：planned 任务不被派发/认领（未批准不能执行）', async () => {
    const tasks = [
      {
        id: 't1',
        revision: 0,
        subject: 's',
        description: '',
        status: 'planned',
        blockedBy: [],
        ready: true,
      },
    ]
    const { ctx, sent } = makeCtx({ tasks })
    const sch = new TeamSchedulerService(ctx, cfg({ mode: 'scheduled' }))
    const r = await sch.scan(agent)
    expect(r.started).toBe(0)
    expect(sent.filter((s) => s.text.includes('启动')).length).toBe(0)
  })
  it('P1：onTaskTerminal 定向 nudge 下游归属人 + emit swarm/task/unblocked', async () => {
    const { ctx, sent, emissions } = makeCtx({
      tasks: [
        {
          id: 't2',
          revision: 0,
          subject: 'downstream',
          description: '',
          status: 'pending',
          blockedBy: [],
          ready: true,
          ownerName: 'w',
        },
      ],
    })
    const sch = new TeamSchedulerService(ctx, cfg())
    const pushed = await sch.onTaskTerminal(agent)
    expect(pushed).toBe(1)
    expect(sent.some((s) => s.to === 'w' && /解锁/.test(s.text))).toBe(true)
    expect(emissions.some((e) => e.type === 'swarm/task/unblocked')).toBe(true)
  })

  it('P1：订阅 swarm/task/terminal → 事件驱动推送（不依赖 poll）', async () => {
    const { ctx, sent, onHandlers } = makeCtx({
      tasks: [
        {
          id: 't3',
          revision: 0,
          subject: 'd',
          description: '',
          status: 'pending',
          blockedBy: [],
          ready: true,
          ownerName: 'w',
        },
      ],
    })
    const sch = new TeamSchedulerService(ctx, cfg({ pollMs: 999999 })) // poll 极慢，排除轮询
    const dispose = sch.arm(agent)
    expect(onHandlers['swarm/task/terminal']?.length).toBe(1)
    sent.length = 0
    onHandlers['swarm/task/terminal']![0]!()
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.some((s) => s.to === 'w' && /解锁/.test(s.text))).toBe(true)
    dispose()
  })

  it('P3：成员状态变更 → swarm/member/status-changed（边沿，仅变化时发）', async () => {
    const { ctx, emissions } = makeCtx()
    const sch = new TeamSchedulerService(ctx, cfg())
    await sch.scan(agent) // 首次建立快照，不发
    expect(emissions.some((e) => e.type === 'swarm/member/status-changed')).toBe(false)
    const w = (ctx.teamCore.listMembers(agent) as any[]).find((m) => m.name === 'w')
    w.status = 'running'
    await sch.scan(agent)
    expect(emissions.some((e) => e.type === 'swarm/member/status-changed')).toBe(true)
  })

  it('P3：看板排空 → swarm/task/list-drained（上升沿一次）', async () => {
    const { ctx, emissions } = makeCtx({
      tasks: [
        {
          id: 't9',
          revision: 1,
          subject: 'done',
          description: '',
          status: 'completed',
          blockedBy: [],
          ready: false,
        },
      ],
    })
    const sch = new TeamSchedulerService(ctx, cfg())
    await sch.scan(agent)
    await sch.scan(agent)
    expect(emissions.filter((e) => e.type === 'swarm/task/list-drained').length).toBe(1)
  })
  it('P38b：自装配——LEADER agent 就绪即 arm，scheduled 真被派发', async () => {
    const tasks = [
      {
        id: 't1',
        revision: 0,
        subject: 's',
        description: '',
        status: 'pending',
        blockedBy: [],
        ready: true,
      },
    ]
    const {
      ctx,
      tasks: ts,
      injectCallbacks,
    } = makeCtx({
      tasks,
      agents: [{ id: 'lead', name: 'lead' }],
    })
    const sch = new TeamSchedulerService(ctx, cfg({ mode: 'scheduled', pollMs: 10 }))
    // 模拟 agents/teamCore 就绪 → 触发自装配
    injectCallbacks.forEach((cb) => cb({ get: ctx.get }))
    expect(await waitFor(() => ts[0]!.status === 'in_progress')).toBe(true) // 轮询至派发
    expect(ts[0]!.ownerName).toBe('w') // P42：owner 是**被派发的成员**，而非 lead
    sch.dispose()
  })

  it('P38b：autoArm=false 复现旧行为（无人 arm → 不派发）—— 先红证据', async () => {
    const tasks = [
      {
        id: 't1',
        revision: 0,
        subject: 's',
        description: '',
        status: 'pending',
        blockedBy: [],
        ready: true,
      },
    ]
    const {
      ctx,
      tasks: ts,
      injectCallbacks,
    } = makeCtx({
      tasks,
      agents: [{ id: 'lead', name: 'lead' }],
    })
    const sch = new TeamSchedulerService(
      ctx,
      cfg({ mode: 'scheduled', pollMs: 10, autoArm: false }),
    )
    injectCallbacks.forEach((cb) => cb({ get: ctx.get }))
    await sleep(OBSERVE_MS) // 有界观察窗：证明「不派发」
    expect(ts[0]!.status).toBe('pending') // 无人 arm → 保持 pending（=修复前行为）
    sch.dispose()
  })

  it('P38b：自装配——非 LEADER 不 arm（不派发、不 nudge）', async () => {
    const tasks = [
      {
        id: 't1',
        revision: 0,
        subject: 's',
        description: '',
        status: 'pending',
        blockedBy: [],
        ready: true,
      },
    ]
    const {
      ctx,
      sent,
      tasks: ts,
      injectCallbacks,
    } = makeCtx({
      tasks,
      agents: [{ id: 'w', name: 'w' }], // 成员表里 role=teammate
    })
    const sch = new TeamSchedulerService(ctx, cfg({ mode: 'autonomous', pollMs: 10 }))
    injectCallbacks.forEach((cb) => cb({ get: ctx.get }))
    await sleep(OBSERVE_MS) // 有界观察窗：证明「不派发、不 nudge」
    expect(ts[0]!.status).toBe('pending')
    expect(sent.length).toBe(0)
    sch.dispose()
  })

  it('默认模式（P19b）：未显式配置时 ≡ scheduled；autonomous 仍可显式切换', () => {
    const a = new TeamSchedulerService(makeCtx().ctx)
    expect(a.mode).toBe('scheduled') // 默认改为 scheduled
    const b = new TeamSchedulerService(makeCtx().ctx, cfg({ mode: 'autonomous' }))
    expect(b.mode).toBe('autonomous') // 显式切换仍有效
  })
})
