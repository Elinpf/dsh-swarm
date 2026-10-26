import { describe, expect, it } from 'vitest'
import TeamBusService, { TeamBusError } from '../src/index.ts'

/** 最小假 ctx：只提供 Service 构造与 teamBus 逻辑需要的东西。 */
function makeCtx() {
  const members = [
    { id: 'lead', name: 'lead', role: 'lead', phase: 'active', status: 'running' },
    { id: 'a', name: 'a', role: 'teammate', phase: 'active', status: 'idle' },
    { id: 'b', name: 'b', role: 'teammate', phase: 'active', status: 'idle' },
  ]
  const sent: Array<{ from: string; to: string }> = []
  const disposers: Array<() => void> = []
  const services: Record<string, unknown> = {}
  const teamCore = {
    backend: 'native' as const,
    listMembers: () => members,
    tryMembership: (agent: { id?: string }) => members.find((m) => m.id === agent?.id),
    send: async (caller: { id: string }, req: { range: { to: string } }) => {
      sent.push({ from: caller.id, to: req.range.to })
      return { messageId: `m-${sent.length}`, status: 'accepted' as const }
    },
  }
  const ctx: any = {
    teamCore,
    sessions: {},
    tools: {},
    logger: { debug() {}, warn() {}, info() {} },
    reflect: { provide: (n: string, v: unknown) => void (services[n] = v) },
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    _disposeAll: () => disposers.forEach((d) => d()),
    _services: services,
  }
  return { ctx, sent, teamCore, disposers }
}

const caller = { id: 'lead', name: 'lead' } as never
const text = (t: string) => [{ type: 'text', text: t }]

describe('@dsh-swarm/team-bus', () => {
  it('导出形态：Service 形态（default export）', () => {
    expect(typeof TeamBusService).toBe('function')
    expect(TeamBusService.inject).toEqual(['teamCore', 'sessions', 'tools'])
  })

  it('broadcast：除发送者外每成员各 1 条，发送者 0 条（自过滤、不重不漏）', async () => {
    const { ctx, sent } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    await bus.broadcast(caller, { content: text('hi'), delivery: 'wakeup' })

    expect(sent.map((s) => s.to).sort()).toEqual(['a', 'b'])
    expect(sent.some((s) => s.to === 'lead')).toBe(false)
    expect(bus.durableCount).toBe(1)
  })

  it('multicast：产生 N 条 durable 消息，且逐目标投递', async () => {
    const { ctx, sent } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    await bus.multicast(caller, { targets: ['a', 'b'], content: text('yo'), delivery: 'quiet' })

    expect(bus.durableCount).toBe(2)
    expect(sent.map((s) => s.to).sort()).toEqual(['a', 'b'])
  })

  it('multicast(全体) → TEAMBUS_REDUNDANT_BROADCAST', async () => {
    const { ctx, sent } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    await expect(
      bus.multicast(caller, { targets: ['lead', 'a', 'b'], content: text('x'), delivery: 'quiet' }),
    ).rejects.toThrow(/TEAMBUS_REDUNDANT_BROADCAST/)
    expect(sent).toHaveLength(0)
    expect(bus.durableCount).toBe(0)
  })

  it("multicast 含 '*' / 'user' → TEAMBUS_INVALID_TARGET，且无落库", async () => {
    const { ctx } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    await expect(
      bus.multicast(caller, { targets: ['*'], content: text('x'), delivery: 'quiet' }),
    ).rejects.toThrow(/TEAMBUS_INVALID_TARGET/)
    await expect(
      bus.multicast(caller, { targets: ['a', 'user'], content: text('x'), delivery: 'quiet' }),
    ).rejects.toThrow(/TEAMBUS_INVALID_TARGET/)
    expect(bus.durableCount).toBe(0)
  })

  it('正文超限 → TEAMBUS_MESSAGE_TOO_LARGE，且零落库零投递', async () => {
    const { ctx, sent } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 8 })
    await expect(
      bus.broadcast(caller, { content: text('this is well over eight bytes'), delivery: 'quiet' }),
    ).rejects.toThrow(/TEAMBUS_MESSAGE_TOO_LARGE/)
    expect(bus.durableCount).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('主题订阅：匹配 topic 的成员收到、且不投给他人；dispose 后归零', async () => {
    const { ctx } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    const aGot: unknown[] = []
    const bGot: unknown[] = []
    const offA = bus.subscribe({ id: 'a' } as never, 'team', (ev) => aGot.push(ev))
    bus.subscribe({ id: 'b' } as never, 'task', (ev) => bGot.push(ev))

    await bus.broadcast(caller, { topic: 'team', content: text('hi'), delivery: 'quiet' })
    expect(aGot).toHaveLength(1)
    expect(bGot).toHaveLength(0) // topic 不匹配

    offA()
    await bus.broadcast(caller, { topic: 'team', content: text('again'), delivery: 'quiet' })
    expect(aGot).toHaveLength(1) // 已退订
  })

  it('HMR 安全：构造产生的 effect 在卸载后清空订阅与落库', async () => {
    const { ctx } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    bus.subscribe({ id: 'a' } as never, 'team', () => {})
    await bus.broadcast(caller, { topic: 'team', content: text('hi'), delivery: 'quiet' })
    expect(bus.durableCount).toBe(1)
    ;(ctx as any)._disposeAll()
    expect(bus.durableCount).toBe(0)
  })

  it('错误码类型化', () => {
    const err = new TeamBusError('TEAMBUS_X', 'boom')
    expect(err.code).toBe('TEAMBUS_X')
    expect(err.message).toContain('TEAMBUS_X')
  })
})
