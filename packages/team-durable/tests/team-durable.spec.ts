import { describe, expect, it, vi } from 'vitest'
import { DURABLE_VERSION, foldDurableEvents, isDurableEvent } from '../src/index.ts'

describe('@elinpf/dsh-swarm-team-durable', () => {
  it('isDurableEvent 只认 swarm/* 形状', () => {
    expect(isDurableEvent({ type: 'swarm/core/x' })).toBe(true)
    expect(isDurableEvent({ type: 'team/foo' })).toBe(false)
    expect(isDurableEvent(null)).toBe(false)
    expect(isDurableEvent({})).toBe(false)
  })

  it('按序折叠；未知事件名 / 非当前版本 → 跳过 + 告警，不抛', () => {
    const state = { n: 0 }
    const onUnknownEvent = vi.fn()
    const onUnsupportedVersion = vi.fn()
    foldDurableEvents(
      state,
      [
        { type: 'swarm/t/n', payload: { version: DURABLE_VERSION, d: 1 } },
        { type: 'swarm/other/x', payload: { version: DURABLE_VERSION } }, // 未知 → 跳过
        { type: 'swarm/t/n', payload: { version: 99, d: 5 } }, // 版本不符 → 跳过
        { type: 'swarm/t/n', payload: { version: DURABLE_VERSION, d: 2 } },
      ],
      {
        'swarm/t/n': (s: { n: number }, p) => {
          s.n += Number(p.d)
        },
      },
      { onUnknownEvent, onUnsupportedVersion },
    )
    expect(state.n).toBe(3) // 1 + 2，跳过的两条不计
    expect(onUnknownEvent).toHaveBeenCalledWith('swarm/other/x')
    expect(onUnsupportedVersion).toHaveBeenCalledWith('swarm/t/n', 99)
  })

  it('非 durable 形状事件被忽略', () => {
    const state = { n: 0 }
    foldDurableEvents(state, [{ type: 'team/whatever', payload: { version: 1, d: 9 } }], {
      'team/whatever': (s: { n: number }, p) => {
        s.n += Number(p.d)
      },
    })
    expect(state.n).toBe(0)
  })
})
