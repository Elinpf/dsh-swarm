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

function makeCtx(withSeam: boolean) {
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
    getTask: () => task,
    listTasks: () => [task],
    updateTask: async (_c: unknown, r: any) => {
      updateCalls.push(r)
      return { ...task, status: 'in_progress' }
    },
    waitForChange: async () => ({ timedOut: false }),
    interrupt: () => ({ previousStatus: 'running' as const }),
  }
  const services: Record<string, unknown> = withSeam ? { agentTeams: seam } : {}
  const ctx: any = {
    get: (n: string) => services[n],
    logger: { warn() {}, debug() {} },
    reflect: { provide() {} },
    effect: (fn: () => unknown) => fn(),
    _sendCalls: sendCalls,
    _updateCalls: updateCalls,
  }
  return { ctx, sendCalls, updateCalls }
}

const agent = { id: 'lead' } as never
const cfg = (over: any = {}) => ({
  backend: 'auto',
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
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
      logger: { warn() {}, debug() {} },
      reflect: { provide() {} },
      effect: (fn: () => unknown) => fn(),
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
})
