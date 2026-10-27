import { describe, expect, it } from 'vitest'
import TeamHumanService, { TeamHumanError, type Config } from '../src/index.ts'

function makeCtx(services: Record<string, unknown> = {}) {
  const events: Array<{ name: string; payload: any }> = []
  const registered: Record<string, unknown> = { ...services }
  const ctx: any = {
    logger: { debug() {}, info() {}, warn() {} },
    reflect: { provide: (n: string, v: unknown) => void (registered[n] = v) },
    get: (n: string) => registered[n],
    effect: (fn: () => unknown) => fn(),
    emit: (name: string, payload: unknown) => void events.push({ name, payload }),
  }
  return { ctx, events, registered }
}

/** 可观测假 teamCore：成员表 + send 记录 + 人类登记。 */
function fakeCore() {
  const members: Array<{ id: string; name: string; role?: string; kind?: string }> = [
    { id: 'lead', name: 'lead', role: 'lead' },
  ]
  const sent: Array<{ to: string; text: string }> = []
  return {
    members,
    sent,
    membership: (a: { id?: string }) =>
      a?.id === 'lead' ? { role: 'lead', name: 'lead' } : { role: 'teammate', name: a?.id },
    listMembers: () => members.map((m) => ({ ...m })),
    addHumanMember: (_a: unknown, spec: { name: string; kind: string }) => {
      const id = `member-human-${spec.name}`
      members.push({ id, name: spec.name, role: 'human', kind: spec.kind })
      return { id }
    },
    send: async (_a: unknown, req: { range: { to: string } }) => {
      sent.push({ to: req.range.to, text: 'x' })
      return { messageId: `m${sent.length}`, status: 'accepted' }
    },
  }
}

const cfg = (over: Partial<Config> = {}): Config => ({
  leadName: 'lead',
  retainWhenOffline: true,
  ...over,
})
const lead = { id: 'lead', name: 'lead' } as never
const bob = { id: 'bob', name: 'bob' } as never

describe('@elinpf/dsh-swarm-team-human', () => {
  it('导出形态：Service + 依赖注入声明', () => {
    expect(typeof TeamHumanService).toBe('function')
    expect(TeamHumanService.inject).toContain('teamCore')
  })

  it('addSeat：Lead 可加人类成员并登记进花名册（role/kind 正确）', async () => {
    const core = fakeCore()
    const { ctx } = makeCtx({ teamCore: core })
    const svc = new TeamHumanService(ctx, cfg())
    const seat = await svc.addSeat(lead, { name: 'alice', kind: 'user' })
    expect(seat.kind).toBe('user')
    const roster = core.listMembers()
    const human = roster.find((m) => m.role === 'human')
    expect(human?.name).toBe('alice')
    expect(human?.kind).toBe('user')
    expect(svc.seats()).toHaveLength(1)
  })

  it('权限：非 Lead 加席位 → TEAMHUMAN_FORBIDDEN', async () => {
    const { ctx } = makeCtx({ teamCore: fakeCore() })
    const svc = new TeamHumanService(ctx, cfg())
    await expect(svc.addSeat(bob, { name: 'x', kind: 'user' })).rejects.toThrow(/FORBIDDEN/)
  })

  it('入站路由： #→Lead，@all→广播，@bob→DM，$alice→人类化身', async () => {
    const core = fakeCore()
    const broadcasts: unknown[] = []
    const bus = { broadcast: async () => (broadcasts.push(1), { messageId: 'b' }) }
    const { ctx } = makeCtx({ teamCore: core, teamBus: bus })
    const svc = new TeamHumanService(ctx, cfg())
    const alice = await svc.addSeat(lead, { name: 'alice', kind: 'user' })

    expect(svc.parseInbound('#hi')).toEqual({ target: 'lead', body: 'hi' })
    expect(svc.parseInbound('@all hi')).toEqual({ target: 'all', body: 'hi' })
    expect(svc.parseInbound('@bob hi')).toEqual({ target: 'bob', body: 'hi' })
    expect(svc.parseInbound('$alice yo')).toEqual({ target: alice.seatId, body: 'yo' })

    const r1 = await svc.inbound(alice.seatId, '#hi')
    expect(r1).toEqual({ target: 'lead', delivered: true })
    const r2 = await svc.inbound(alice.seatId, '@all hi')
    expect(r2.target).toBe('all')
    expect(broadcasts).toHaveLength(1)
    const r3 = await svc.inbound(alice.seatId, '@bob hi')
    expect(r3.target).toBe('bob')
    expect(core.sent.map((s) => s.to)).toContain('bob')
  })

  it('入站：未知席位 → TEAMHUMAN_NO_SEAT', async () => {
    const { ctx } = makeCtx({ teamCore: fakeCore() })
    const svc = new TeamHumanService(ctx, cfg())
    await expect(svc.inbound('nope', '#hi')).rejects.toThrow(/NO_SEAT/)
  })

  it('出站：无前端在线 → {delivered:false} 且保留待补投；上线后 flush 补投', async () => {
    const { ctx, registered } = makeCtx({ teamCore: fakeCore() })
    const svc = new TeamHumanService(ctx, cfg())
    const seat = await svc.addSeat(lead, { name: 'alice', kind: 'user' })

    const r = await svc.deliver(seat.seatId, [{ type: 'text', text: 'hi' }])
    expect(r.delivered).toBe(false)
    expect(svc.pendingCount).toBe(1)

    // 前端上线
    const pushed: string[] = []
    registered['teamHumanBridge'] = {
      isOnline: () => true,
      send: (id: string) => void pushed.push(id),
    }
    const n = await svc.flush(seat.seatId)
    expect(n).toBe(1)
    expect(svc.pendingCount).toBe(0)
    expect(pushed).toEqual([seat.seatId])
  })

  it('ask：委派 ctx.userQuestions.ask；缺失 → TEAMHUMAN_ASK_UNAVAILABLE', async () => {
    const { ctx, registered } = makeCtx({ teamCore: fakeCore() })
    const svc = new TeamHumanService(ctx, cfg())
    const seat = await svc.addSeat(lead, { name: 'alice', kind: 'user' })

    await expect(svc.ask(seat.seatId, 'q?')).rejects.toThrow(/ASK_UNAVAILABLE/)

    registered['userQuestions'] = { ask: async () => ({ answer: 'yes' }) }
    const res = await svc.ask(seat.seatId, 'q?')
    expect(res.answer).toBe('yes')
  })

  it('dispose：席位与待补投归零', async () => {
    const { ctx } = makeCtx({ teamCore: fakeCore() })
    const svc = new TeamHumanService(ctx, cfg())
    const seat = await svc.addSeat(lead, { name: 'alice', kind: 'user' })
    await svc.deliver(seat.seatId, [])
    svc.dispose()
    expect(svc.seats()).toHaveLength(0)
    expect(svc.pendingCount).toBe(0)
  })

  it('TeamHumanError 形状稳定', () => {
    const e = new TeamHumanError('X', 'msg')
    expect(e.code).toBe('X')
    expect(e.message).toContain('X: msg')
  })
})
