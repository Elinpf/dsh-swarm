import { describe, expect, it } from 'vitest'
import TeamCoreService from '../src/index.ts'

const task = {
  id: 't1',
  revision: 0,
  subject: 's',
  description: '',
  status: 'pending' as const,
  blockedBy: [],
  ready: true,
}

function makeCtx(
  withSeam: boolean,
  opts: { updateResult?: (r: any) => any; getTaskResult?: () => any } = {},
) {
  const emissions: Array<{ type: string; payload: any }> = []
  const sendCalls: any[] = []
  const updateCalls: any[] = []
  const seam = {
    membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
    tryMembership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
    listMembers: () => [
      { id: 'w', name: 'w', role: 'teammate', status: 'running', description: 'worker' },
      { id: 'p', name: 'p', role: 'teammate', status: 'provisioning' },
    ],
    spawnTeammate: async (_c: unknown, r: any) => ({
      member: { id: 'w', name: r.name, role: 'teammate', description: r.description },
    }),
    sendMessage: async (_c: unknown, r: any) => {
      sendCalls.push(r)
      return { messageId: 'm1' }
    },
    createTask: async () => task,
    getTask: () => (opts.getTaskResult ? opts.getTaskResult() : task),
    listTasks: () => [opts.getTaskResult ? opts.getTaskResult() : task],
    updateTask: async (_c: unknown, r: any) => {
      updateCalls.push(r)
      return opts.updateResult ? opts.updateResult(r) : { ...task, status: 'in_progress' }
    },
    waitForChange: async () => ({ timedOut: false }),
    interrupt: () => ({ previousStatus: 'running' as const }),
  }
  const services: Record<string, unknown> = withSeam ? { agentTeams: seam } : {}
  const injectors: Array<(c: any) => unknown> = []
  const ctx: any = {
    get: (n: string) => services[n],
    logger: { warn() {}, debug() {}, info() {} },
    reflect: { provide() {} },
    effect: (fn: () => unknown) => fn(),
    inject: (_deps: string[], cb: (c: any) => unknown) => {
      injectors.push(cb)
      return () => {}
    },
    // 测试助手：模拟「稍后提供某服务」→ 通知所有 ctx.inject 回调
    _provide: (name: string, v: unknown) => {
      services[name] = v
      for (const cb of injectors) cb({ get: (n: string) => services[n] })
    },
    emit: (t: string, pay: unknown) => emissions.push({ type: t, payload: pay }),
    _sendCalls: sendCalls,
    _updateCalls: updateCalls,
    _emissions: emissions,
  }
  return { ctx, sendCalls, updateCalls, emissions }
}

const agent = { id: 'lead' } as never
const cfg = (over: any = {}) => ({
  backend: 'auto',
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  planGate: false,
  ...over,
})
const text = [{ type: 'text', text: 'hi' }]

describe('@elinpf/dsh-swarm-team-core', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamCoreService).toBe('function')
    expect(TeamCoreService.inject).toEqual(['agents', 'sessions', 'subagents'])
  })

  it('native：send(dm) 委派到 agentTeams.sendMessage（target 一致）', async () => {
    const { ctx, sendCalls } = makeCtx(true)
    const core = new TeamCoreService(ctx, cfg())
    expect(core.backend).toBe('native')
    expect(core.active).toBe(true)
    const res = await core.send(agent, {
      range: { kind: 'dm', to: 'w' },
      content: text as never,
      delivery: 'wakeup',
    })
    expect(res).toEqual({ messageId: 'm1', status: 'accepted' })
    expect(sendCalls[0].target).toBe('w')
    expect(sendCalls[0].content).toEqual(text)
  })

  it('native：multicast/broadcast 抛 TEAMCORE_RANGE_UNSUPPORTED', async () => {
    const { ctx } = makeCtx(true)
    const core = new TeamCoreService(ctx, cfg())
    await expect(
      core.send(agent, { range: { kind: 'broadcast' }, content: text as never, delivery: 'quiet' }),
    ).rejects.toThrow(/TEAMCORE_RANGE_UNSUPPORTED/)
    await expect(
      core.send(agent, {
        range: { kind: 'multicast', targets: ['a'] },
        content: text as never,
        delivery: 'quiet',
      }),
    ).rejects.toThrow(/TEAMCORE_RANGE_UNSUPPORTED/)
  })

  it('listMembers 适配 status/phase；updateTask 把 assign 映射为 reassign', async () => {
    const { ctx, updateCalls } = makeCtx(true)
    const core = new TeamCoreService(ctx, cfg())
    const members = core.listMembers(agent)
    expect(members.find((m) => m.id === 'w')).toMatchObject({ phase: 'active', status: 'running' })
    expect(members.find((m) => m.id === 'p')).toMatchObject({
      phase: 'provisioning',
      status: 'idle',
    })

    await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'assign',
      owner: 'w',
    })
    expect(updateCalls[0].action).toBe('reassign')
  })

  it('auto + 无 agentTeams → no-op：读返回空、写抛 TEAMCORE_UNAVAILABLE，不崩', async () => {
    const { ctx } = makeCtx(false)
    const core = new TeamCoreService(ctx, cfg())
    expect(core.active).toBe(false)
    expect(core.listMembers(agent)).toEqual([])
    expect(core.listTasks(agent)).toEqual([])
    expect(core.tryMembership(agent)).toBeUndefined()
    await expect(core.createTask(agent, { subject: 's', description: '' })).rejects.toThrow(
      /TEAMCORE_UNAVAILABLE/,
    )
  })

  it('响应式接通（P22 回归）：agentTeams 晚于 team-core 提供时也能挂接', () => {
    const { ctx } = makeCtx(false)
    const core = new TeamCoreService(ctx, cfg())
    expect(core.active).toBe(false) // 构造时 agentTeams 尚未提供 → no-op
    // 稍后提供 agentTeams（复现真实 profile：agent-team 的额外依赖 sessionPersistence/
    // sessionProjections 晚就绪 → agentTeams 晚于 team-core 发布）
    ctx._provide('agentTeams', {
      membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
      tryMembership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
      listMembers: () => [{ id: 'alice', name: 'alice', role: 'teammate', status: 'running' }],
      listTasks: () => [],
    })
    expect(core.active).toBe(true) // 响应式挂接生效
    expect(core.listMembers(agent).map((m) => m.name)).toEqual(['alice'])
  })

  it('backend=owned（未实现）→ 构造即抛 TEAMCORE_BACKEND_UNAVAILABLE', () => {
    const { ctx } = makeCtx(true)
    expect(() => new TeamCoreService(ctx, cfg({ backend: 'owned' }))).toThrow(
      /TEAMCORE_BACKEND_UNAVAILABLE/,
    )
  })

  it('membership / interrupt 委派', async () => {
    const { ctx } = makeCtx(true)
    const core = new TeamCoreService(ctx, cfg())
    expect(core.membership(agent)).toEqual({ id: 'lead', role: 'lead', name: 'lead' })
    expect(await core.interrupt(agent, 'w')).toEqual({ previousStatus: 'running' })
  })
})

describe('@elinpf/dsh-swarm-team-core · in_review 叠加态与合法转换', () => {
  /** 造一个任务状态可控的 seam mock（原生状态用 string，便于驱动各转换）。 */
  function makeReviewCtx() {
    const state = {
      id: 't1',
      revision: 0,
      subject: 's',
      description: '',
      status: 'in_progress' as string,
      blockedBy: [] as string[],
      ready: true,
      ownerName: 'w' as string | undefined,
    }
    const calls: any[] = []
    const seam = {
      membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
      tryMembership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
      listMembers: () => [],
      spawnTeammate: async () => ({ member: { id: 'w', name: 'w', role: 'teammate' } }),
      sendMessage: async () => ({ messageId: 'm1' }),
      createTask: async () => ({ ...state, status: 'pending' }),
      getTask: () => ({ ...state }),
      listTasks: () => [{ ...state }],
      updateTask: async (_c: unknown, r: any) => {
        calls.push(r)
        if (r.action === 'complete') state.status = 'completed'
        else if (r.action === 'reopen') state.status = 'in_progress'
        else if (r.action === 'claim') {
          state.status = 'in_progress'
          state.ownerName = r.owner
        } else if (r.action === 'release') state.status = 'pending'
        return { ...state }
      },
      waitForChange: async () => ({ timedOut: false }),
      interrupt: () => ({ previousStatus: 'running' as const }),
    }
    const ctx: any = {
      get: (n: string) => (n === 'agentTeams' ? seam : undefined),
      logger: { warn() {}, debug() {}, info() {} },
      reflect: { provide() {} },
      effect: (fn: () => unknown) => fn(),
      inject: () => () => {},
      on: () => () => {},
      emit: (n: string, p: unknown) => calls.push({ event: n, payload: p }),
    }
    return { ctx, state, calls }
  }

  it('in_progress → in_review：读侧叠加为 in_review，原生仍 in_progress', async () => {
    const { ctx, state } = makeReviewCtx()
    const core = new TeamCoreService(ctx, cfg())
    const view = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'submit_review',
    })
    expect(view.status).toBe('in_review')
    expect(state.status).toBe('in_progress') // 原生枚举无评审态，不被改写
    expect(core.getTask(agent, 't1').status).toBe('in_review')
    expect(core.listTasks(agent)[0].status).toBe('in_review')
  })

  it('非法转换 pending → in_review 被拒（TEAMCORE_INVALID_TRANSITION）', async () => {
    const { ctx, state } = makeReviewCtx()
    state.status = 'pending'
    const core = new TeamCoreService(ctx, cfg())
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' }),
    ).rejects.toThrow(/TEAMCORE_INVALID_TRANSITION/)
    expect(core.getTask(agent, 't1').status).toBe('pending') // 未被叠加
  })

  it('submit_review 的 revision 不符 → TEAMCORE_REVISION_MISMATCH', async () => {
    const { ctx } = makeReviewCtx()
    const core = new TeamCoreService(ctx, cfg())
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 9, action: 'submit_review' }),
    ).rejects.toThrow(/TEAMCORE_REVISION_MISMATCH/)
  })

  it('in_review → completed：complete 离场并清除叠加', async () => {
    const { ctx, state } = makeReviewCtx()
    const core = new TeamCoreService(ctx, cfg())
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' })
    const done = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'complete',
    })
    expect(done.status).toBe('completed')
    expect(state.status).toBe('completed')
    expect(core.getTask(agent, 't1').status).toBe('completed')
  })

  it('in_review → in_progress：reject_review 返工', async () => {
    const { ctx, state } = makeReviewCtx()
    const core = new TeamCoreService(ctx, cfg())
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' })
    const back = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'reject_review',
    })
    expect(back.status).toBe('in_progress')
    expect(state.status).toBe('in_progress')
  })

  it('reject_review 用在非 in_review 任务 → 被拒', async () => {
    const { ctx } = makeReviewCtx()
    const core = new TeamCoreService(ctx, cfg())
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'reject_review' }),
    ).rejects.toThrow(/TEAMCORE_INVALID_TRANSITION/)
  })

  it('评审中 claim/release 被拒；reopen 允许并回到 in_progress', async () => {
    const { ctx } = makeReviewCtx()
    const core = new TeamCoreService(ctx, cfg())
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' })
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'claim', owner: 'w' }),
    ).rejects.toThrow(/TEAMCORE_INVALID_TRANSITION/)
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'release' }),
    ).rejects.toThrow(/TEAMCORE_INVALID_TRANSITION/)
    const reopened = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'reopen',
    })
    expect(reopened.status).toBe('in_progress')
  })

  it('无 seam 时 submit_review 抛 TEAMCORE_UNAVAILABLE（不阻断单 agent）', async () => {
    const { ctx } = makeCtx(false)
    const core = new TeamCoreService(ctx, cfg())
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' }),
    ).rejects.toThrow(/TEAMCORE_UNAVAILABLE/)
  })

  it('恢复（ADR-0002）：重建服务后 recover(durable 事件) → in_review 仍在；未 recover 则丢', async () => {
    // 原生任务存储跨「重启」保留（模拟 durable 的原生 session）；内存的 reviewing 不保留
    const store: any = {
      t1: {
        id: 't1',
        revision: 0,
        subject: 's',
        description: '',
        status: 'in_progress',
        blockedBy: [],
        ready: false,
        ownerName: 'w',
      },
    }
    const seam = {
      membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
      tryMembership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
      listMembers: () => [],
      spawnTeammate: async () => ({ member: {} }),
      sendMessage: async () => ({ messageId: 'm1' }),
      createTask: async () => ({ ...store.t1 }),
      getTask: () => ({ ...store.t1 }),
      listTasks: () => [{ ...store.t1 }],
      updateTask: async (_c: unknown, r: any) => {
        if (r.action === 'complete') store.t1.status = 'completed'
        return { ...store.t1 }
      },
      waitForChange: async () => ({ timedOut: false }),
      interrupt: () => ({ previousStatus: 'running' as const }),
    }
    const emitted: Array<{ type: string; payload: unknown }> = []
    const mk = (): any => ({
      get: (n: string) => (n === 'agentTeams' ? seam : undefined),
      logger: { warn() {}, debug() {}, info() {} },
      reflect: { provide() {} },
      effect: (fn: () => unknown) => fn(),
      inject: () => () => {},
      on: () => () => {},
      emit: (n: string, p: unknown) => emitted.push({ type: n, payload: p }),
    })

    const c1 = new TeamCoreService(mk(), cfg())
    await c1.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' })
    expect(c1.getTask(agent, 't1').status).toBe('in_review')
    expect(emitted.map((e) => e.type)).toContain('swarm/core/review-entered')

    // 模拟重启：同一原生 store，新服务实例
    const c2 = new TeamCoreService(mk(), cfg())
    expect(c2.getTask(agent, 't1').status).toBe('in_progress') // 未恢复 → 丢失（缺陷）
    c2.recover(emitted) // 折叠 durable 事件
    expect(c2.getTask(agent, 't1').status).toBe('in_review') // 恢复 → 仍在
  })

  it('计划闸 T1/T2/T3：pending→planned；未批准不能执行；approve 后回 pending', async () => {
    const { ctx, state } = makeReviewCtx()
    state.status = 'pending'
    const core = new TeamCoreService(ctx, cfg({ planGate: true }))
    const planned = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'open_plan',
    })
    expect(planned.status).toBe('planned')
    // T2：未批准不能执行（claim / complete 均被拒）
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'claim', owner: 'w' }),
    ).rejects.toThrow(/TEAMCORE_INVALID_TRANSITION/)
    await expect(
      core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'complete' }),
    ).rejects.toThrow(/TEAMCORE_INVALID_TRANSITION/)
    // T3：批准 → 回 pending（可执行）
    const approved = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'approve_plan',
    })
    expect(approved.status).toBe('pending')
  })

  it('计划闸 T4/T5：驳回带理由且能回传；任务留在 planned 可再改', async () => {
    const { ctx, state } = makeReviewCtx()
    state.status = 'pending'
    const core = new TeamCoreService(ctx, cfg({ planGate: true }))
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'open_plan' })
    await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'submit_plan',
      plan: 'step1; step2',
    })
    expect(core.planOf('t1')).toBe('step1; step2')
    const rejected = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'reject_plan',
      feedback: '请补测试',
    })
    expect(rejected.status).toBe('planned') // T5：留在 planned
    expect(core.planFeedbackOf('t1')).toBe('请补测试') // T4：理由可回传
  })

  it('计划闸 T6：未入闸不能 approve；planGate 关闭时 open_plan 被拒', async () => {
    const on = new TeamCoreService(makeReviewCtx().ctx, cfg({ planGate: true }))
    await expect(
      on.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'approve_plan' }),
    ).rejects.toThrow(/TEAMCORE_INVALID_TRANSITION/)
    const off = new TeamCoreService(makeReviewCtx().ctx, cfg({ planGate: false }))
    await expect(
      off.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'open_plan' }),
    ).rejects.toThrow(/TEAMCORE_PLAN_GATE_DISABLED/)
  })

  it('返工反馈 T7：reject_review 携带 feedback → revisionFeedbackOf 可读', async () => {
    const { ctx } = makeReviewCtx()
    const core = new TeamCoreService(ctx, cfg())
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' })
    const back = await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'reject_review',
      feedback: '改 A 部分',
    })
    expect(back.status).toBe('in_progress')
    expect(core.revisionFeedbackOf('t1')).toBe('改 A 部分')
  })

  it('计划闸恢复 T11：重建服务 + recover(durable) → planned/计划/反馈 仍在', async () => {
    const a = makeReviewCtx()
    a.state.status = 'pending'
    const core = new TeamCoreService(a.ctx, cfg({ planGate: true }))
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'open_plan' })
    await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'submit_plan',
      plan: 'do X',
    })
    await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'reject_plan',
      feedback: '补测试',
    })
    const durable = a.calls
      .filter((c: any) => typeof c.event === 'string')
      .map((c: any) => ({ type: c.event, payload: c.payload }))
    expect(durable.map((e) => e.type)).toEqual(
      expect.arrayContaining(['swarm/task/plan-request', 'swarm/task/plan-response']),
    )

    const b = makeReviewCtx()
    const core2 = new TeamCoreService(b.ctx, cfg({ planGate: true }))
    expect(core2.getTask(agent, 't1').status).not.toBe('planned') // 未恢复
    core2.recover(durable)
    expect(core2.getTask(agent, 't1').status).toBe('planned') // 恢复
    expect(core2.planOf('t1')).toBe('do X')
    expect(core2.planFeedbackOf('t1')).toBe('补测试')
  })
  it('P31：release → swarm/task/released', async () => {
    const { ctx, emissions } = makeCtx(true, {
      updateResult: () => ({ ...task, status: 'pending', ownerName: undefined }),
    })
    const core = new TeamCoreService(ctx, cfg())
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'release' })
    expect(emissions.some((e) => e.type === 'swarm/task/released')).toBe(true)
  })

  it('P31：reassign → swarm/task/revoked + 向原 owner 定向 DM', async () => {
    const { ctx, emissions, sendCalls } = makeCtx(true, {
      getTaskResult: () => ({ ...task, status: 'in_progress', ownerName: 'old' }),
      updateResult: () => ({ ...task, status: 'in_progress', ownerName: 'w' }),
    })
    const core = new TeamCoreService(ctx, cfg())
    await core.updateTask(agent, {
      taskId: 't1',
      expectedRevision: 0,
      action: 'assign',
      owner: 'w',
    })
    const revoked = emissions.find((e) => e.type === 'swarm/task/revoked')
    expect(revoked?.payload).toMatchObject({ taskId: 't1', fromOwner: 'old' })
    expect(sendCalls.some((c) => c.target === 'old')).toBe(true) // 原 owner 收到「你不用做了」
  })

  it('P31：complete → swarm/task/terminal（触发解锁推送）', async () => {
    const { ctx, emissions } = makeCtx(true, {
      getTaskResult: () => ({ ...task, status: 'in_progress', ownerName: 'w' }),
      updateResult: () => ({ ...task, status: 'completed', ownerName: 'w' }),
    })
    const core = new TeamCoreService(ctx, cfg())
    await core.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'complete' })
    expect(emissions.some((e) => e.type === 'swarm/task/terminal')).toBe(true)
  })
})

describe('P51② 定向消息超时重投/升级（防风暴）', () => {
  const text = [{ type: 'text', text: 'hi' }] as never

  it('send(DM) → 进待处理台账 + emit swarm/message/pending', async () => {
    const { ctx, emissions } = makeCtx(true)
    const core = new TeamCoreService(ctx, cfg({ messageAckTimeoutMs: 0, messageMaxRedeliver: 1 }))
    await core.send(agent, { range: { kind: 'dm', to: 'w' }, content: text, delivery: 'wakeup' })
    expect(core.pendingMessageCount).toBe(1)
    expect(emissions.some((e) => e.type === 'swarm/message/pending')).toBe(true)
  })

  it('逾时未处理 → 重投一次；再逾时 → undelivered + 升级 leader', async () => {
    const { ctx, sendCalls, emissions } = makeCtx(true)
    const core = new TeamCoreService(ctx, cfg({ messageAckTimeoutMs: 0, messageMaxRedeliver: 1 }))
    await core.send(agent, { range: { kind: 'dm', to: 'w' }, content: text, delivery: 'wakeup' })
    const before = sendCalls.length
    await core.sweepPending(Date.now() + 1e9)
    expect(sendCalls.length).toBe(before + 1) // 重投一次
    expect(emissions.some((e) => e.type === 'swarm/message/redelivered')).toBe(true)
    await core.sweepPending(Date.now() + 1e9)
    expect(emissions.some((e) => e.type === 'swarm/message/undelivered')).toBe(true)
    expect(sendCalls.some((c) => c.target === 'lead')).toBe(true) // 升级 leader
    expect(core.pendingMessageCount).toBe(0)
  })

  it('广播不进台账（send 仅接受 DM）', async () => {
    const { ctx } = makeCtx(true)
    const core = new TeamCoreService(ctx, cfg())
    await expect(
      core.send(agent, { range: { kind: 'broadcast' } as never, content: text, delivery: 'quiet' }),
    ).rejects.toThrow(/RANGE_UNSUPPORTED/)
    expect(core.pendingMessageCount).toBe(0)
  })
})
