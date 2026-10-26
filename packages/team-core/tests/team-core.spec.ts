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
