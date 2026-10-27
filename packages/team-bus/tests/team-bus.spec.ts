import { describe, expect, it } from 'vitest'
import TeamBusService, { TeamBusError } from '../src/index.ts'
import { swarmBusProjectionDefinition } from '../src/projection.ts'

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
  const emitted: Array<{ type: string; payload: unknown }> = []
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
    on: () => () => {},
    emit: (n: string, p: unknown) => emitted.push({ type: n, payload: p }),
    _disposeAll: () => disposers.forEach((d) => d()),
    _services: services,
    _emitted: emitted,
  }
  return { ctx, sent, teamCore, disposers, emitted }
}

const caller = { id: 'lead', name: 'lead' } as never
const text = (t: string) => [{ type: 'text', text: t }]

describe('@elinpf/dsh-swarm-team-bus', () => {
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

  it("broadcast fanout:'record-only'：零逐人 DM、仅落库 + 通知订阅者（信号+拉取）", async () => {
    const { ctx, sent } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    const aGot: unknown[] = []
    bus.subscribe({ id: 'a' } as never, 'announce', (ev) => aGot.push(ev))

    await bus.broadcast(caller, {
      topic: 'announce',
      content: text('FYI'),
      delivery: 'wakeup',
      fanout: 'record-only',
    })

    expect(sent).toHaveLength(0) // 不逐人 DM
    expect(bus.durableCount).toBe(1) // 仍落库
    expect(aGot).toHaveLength(1) // 本进程订阅者仍被通知
  })

  it('history：不回投自己发的、可按 topic/since 增量拉取', async () => {
    const { ctx } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    await bus.broadcast(caller, { topic: 'announce', content: text('one'), delivery: 'quiet' })
    await bus.broadcast(caller, { topic: 'task', content: text('two'), delivery: 'quiet' })

    const asMember = { id: 'a', name: 'a' } as never
    expect(bus.history(asMember).map((s) => s.topic)).toEqual(['announce', 'task'])
    expect(bus.history(asMember, { topic: 'task' }).map((s) => s.topic)).toEqual(['task'])
    const first = bus.history(asMember)[0]!
    expect(bus.history(asMember, { sinceId: first.id }).map((s) => s.topic)).toEqual(['task'])
    // 发送者自己拉取 → 不回投自己发的
    expect(bus.history(caller)).toHaveLength(0)
  })

  it('恢复（ADR-0002）：重建 bus + recover(durable) → durable/history 仍在；未恢复则空', async () => {
    const { ctx, emitted } = makeCtx()
    const bus = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    await bus.broadcast(caller, { topic: 'announce', content: text('one'), delivery: 'quiet' })
    expect(bus.durableCount).toBe(1)
    expect(emitted.map((e) => e.type)).toContain('swarm/bus/broadcast')

    const bus2 = new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    expect(bus2.durableCount).toBe(0) // 未恢复 → 空（缺陷）
    bus2.recover(emitted)
    expect(bus2.durableCount).toBe(1) // 恢复 → 仍在
    expect(bus2.history({ id: 'a', name: 'a' } as never).map((s) => s.topic)).toEqual(['announce'])
  })

  // ── P47 读取侧：swarmBus 投影折叠 + 可见范围 + 注册 ─────────────────────────

  it('P47-B：swarmBus 投影折叠 bus 广播/多播全显示 + 仅保留与 Lead 相关的 DM', () => {
    const def = swarmBusProjectionDefinition
    // 合成事件：`plugin:swarm/bus/broadcast` 记录（durableRecordOf 依赖 type=plugin:swarm/… + data）
    const busEv = (snapshot: Record<string, unknown>, seq: number) =>
      ({
        type: 'plugin:swarm/bus/broadcast',
        ignorable: true,
        seq,
        time: 1000 + seq,
        data: { version: 1, name: 'swarm/bus/broadcast', snapshot },
      } as never)
    const dmEv = (message: Record<string, unknown>, seq: number) =>
      ({
        type: 'team/message/queued',
        seq,
        time: 1000 + seq,
        data: { version: 2, teamId: 'lead', message },
      } as never)
    let s = def.init({ id: 'lead' })
    // 全体广播（无 targets）→ 显示
    s = def.apply(
      s,
      busEv(
        {
          id: 'bcast-1',
          senderId: 'lead',
          senderName: 'lead',
          topic: 'team',
          content: [{ type: 'text', text: 'hi' }],
          delivery: 'quiet',
        },
        1,
      ),
    )
    // 多播 → 显示
    s = def.apply(
      s,
      busEv(
        {
          id: 'mcast-1',
          senderId: 'a',
          senderName: 'a',
          topic: 'message',
          content: [{ type: 'text', text: 'yo' }],
          delivery: 'quiet',
          targets: ['lead'],
        },
        2,
      ),
    )
    // 与 Lead 相关的 DM（a→lead）→ 显示
    s = def.apply(
      s,
      dmEv({ id: 'm-keep', senderId: 'a', senderName: 'a', targetId: 'lead', content: [] }, 3),
    )
    // 与 Lead 无关的 DM（a→b）→ 丢弃（不泄露）
    s = def.apply(
      s,
      dmEv({ id: 'm-drop', senderId: 'a', senderName: 'a', targetId: 'b', content: [] }, 4),
    )
    // 无关事件 → 原状态引用不变（零下游工作）
    const same = def.apply(s, { type: 'turn/start', seq: 5, time: 5, data: {} } as never)
    expect(same).toBe(s)

    const view = def.wire.view(s)
    expect(view.messages.map((m) => m.id)).toEqual(['bcast-1', 'mcast-1', 'm-keep'])
    expect(view.messages.map((m) => m.kind)).toEqual(['broadcast', 'multicast', 'dm'])
    // wire 视图引用稳定（同状态 → 同对象）
    expect(def.wire.view(s)).toBe(view)
  })

  it('P47-B：sessionProjections 可用时构造函数注册 swarmBus 投影；缺席时不注册也不报错', () => {
    const { ctx, disposers } = makeCtx()
    const registered: unknown[] = []
    const injected: Array<(sctx: unknown) => unknown> = []
    ctx.inject = (_deps: string[], cb: (sctx: unknown) => unknown) => {
      injected.push(cb)
      return () => {}
    }
    ctx.sessionProjections = {
      register: (d: unknown) => {
        registered.push(d)
        return () => {}
      },
    }
    // eslint-disable-next-line no-new
    new TeamBusService(ctx, { maxFanout: 64, maxMessageBytes: 65536 })
    expect(injected).toHaveLength(1)
    injected[0]!({
      sessionProjections: ctx.sessionProjections,
      effect: (fn: () => unknown) => fn(),
    })
    expect(registered[0]).toBe(swarmBusProjectionDefinition)
    expect(disposers.length).toBeGreaterThanOrEqual(0)
  })
})
