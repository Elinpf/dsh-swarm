import { beforeEach, describe, expect, it } from 'vitest'
import TeamTransportService, {
  getLoopbackBus,
  resetLoopbackBus,
  type Config,
  type DuplexSeam,
} from '../src/index.ts'

/**
 * 假 ctx：只提供 Service 构造 + 本包逻辑所需的 `effect/get/logger/emit`。
 * `events` 收集 `swarm/transport/peer`（用于断言状态机迁移可观测）。
 */
function makeCtx(services: Record<string, unknown> = {}) {
  const events: Array<{ name: string; payload: any }> = []
  const disposers: Array<() => void> = []
  const registered: Record<string, unknown> = { ...services }
  const warns: string[] = []
  const ctx: any = {
    logger: {
      debug() {},
      info() {},
      warn: (...a: unknown[]) => void warns.push(a.map(String).join(' ')),
    },
    reflect: { provide: (n: string, v: unknown) => void (registered[n] = v) },
    get: (n: string) => registered[n],
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    emit: (name: string, payload: unknown) => void events.push({ name, payload }),
  }
  return { ctx, events, disposers, warns, registered }
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    backend: 'in-process',
    maxQueue: 1024,
    maxHistory: 1024,
    reconnectTimeoutMs: 15000,
    reconnectIntervalMs: 0,
    autoReconnect: false,
    childArgs: [],
    ...over,
  }
}

const frame = (kind: 'mutation' | 'event', teamId = 't'): any => ({
  kind,
  teamId,
  payload: { n: Math.random() },
})

/** 内存双工对（模拟 ctx.ssh / ctx.subprocess 归一后的 JSONL 通道）。 */
function duplexPair() {
  const mk = () => {
    const data: Array<(s: string) => void> = []
    const closeCbs: Array<() => void> = []
    const written: string[] = []
    const d: DuplexSeam & { written: string[]; feed(s: string): void; remoteClose(): void } = {
      written,
      write(s: string) {
        written.push(s)
      },
      onData(cb) {
        data.push(cb)
      },
      onClose(cb) {
        closeCbs.push(cb)
      },
      close() {
        closeCbs.forEach((c) => c())
      },
      feed(s: string) {
        data.forEach((c) => c(s))
      },
      remoteClose() {
        closeCbs.forEach((c) => c())
      },
    }
    return d
  }
  return { local: mk() }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('@elinpf/dsh-swarm-team-transport', () => {
  beforeEach(() => resetLoopbackBus())

  it('导出形态：Service（default export）+ 共享总线工具', () => {
    expect(typeof TeamTransportService).toBe('function')
    expect(typeof getLoopbackBus).toBe('function')
    expect(typeof resetLoopbackBus).toBe('function')
  })

  it('in-process 双端：A.send → B.onFrame 收到；ack 使 stats.acked++', async () => {
    const { ctx: ca } = makeCtx()
    const { ctx: cb } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A' }))
    const b = new TeamTransportService(cb, cfg({ endpoint: 'B' }))
    const got: Array<{ pid: string; frame: any }> = []
    b.onFrame((pid, f) => got.push({ pid, frame: f }))

    const { seq } = await a.send('B', frame('event'))
    expect(seq).toBe(1)
    expect(got).toHaveLength(1)
    expect(got[0]!.pid).toBe('A')
    expect(got[0]!.frame.kind).toBe('event')
    expect(a.stats().acked).toBe(1)
    expect(a.peers().find((p) => p.peerId === 'B')!.state).toBe('connected')

    a.dispose()
    b.dispose()
  })

  it('V2 不重：丢 ack 后重连重放 → 目标恰好生效一次（dedupDropped++）', async () => {
    const { ctx: ca } = makeCtx()
    const { ctx: cb } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A' }))
    const b = new TeamTransportService(cb, cfg({ endpoint: 'B' }))
    let count = 0
    b.onFrame(() => count++)

    const bus = getLoopbackBus()
    bus.shouldDrop = (m) => m.t === 'ack' // 只吞 ack：A 侧帧保留在待发队列
    await a.send('B', frame('event'))
    expect(count).toBe(1)
    expect(a.stats().acked).toBe(0)
    expect(a.peers().find((p) => p.peerId === 'B')!.pending).toBe(1)

    bus.shouldDrop = undefined
    bus.disconnect('B') // 制造断线
    expect(a.peers().find((p) => p.peerId === 'B')!.state).toBe('degraded')
    await a.reconnect('B') // 重放 queued-minus-acked

    expect(count).toBe(1) // 恰好一次生效（重复帧被幂等吞掉）
    expect(b.stats().dedupDropped).toBeGreaterThanOrEqual(1)
    expect(a.stats().acked).toBeGreaterThanOrEqual(1)
    expect(a.peers().find((p) => p.peerId === 'B')!.pending).toBe(0)

    a.dispose()
    b.dispose()
  })

  it('V4 断线重连：状态机 connected→degraded→resyncing→connected 可观测', async () => {
    const { ctx: ca, events } = makeCtx()
    const { ctx: cb } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A' }))
    const b = new TeamTransportService(cb, cfg({ endpoint: 'B' }))
    await a.send('B', frame('event'))

    const bus = getLoopbackBus()
    bus.disconnect('B')
    expect(a.peers().find((p) => p.peerId === 'B')!.state).toBe('degraded')
    await a.reconnect('B')
    expect(a.peers().find((p) => p.peerId === 'B')!.state).toBe('connected')

    const states = events
      .filter((e) => e.name === 'swarm/transport/peer')
      .map((e) => e.payload.state)
    expect(states).toContain('degraded')
    expect(states).toContain('resyncing')
    expect(states[states.length - 1]).toBe('connected')

    a.dispose()
    b.dispose()
  })

  it('V4 增量补齐：B→A 丢帧后重连，A 终态无丢失、无重复', async () => {
    const { ctx: ca } = makeCtx()
    const { ctx: cb } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A' }))
    const b = new TeamTransportService(cb, cfg({ endpoint: 'B' }))
    const seen: number[] = []
    a.onFrame((_pid, f) => seen.push((f.payload as any).n))
    const bus = getLoopbackBus()

    // B 向 A 发 3 帧，第 2、3 帧在链路被吞（A 只收到第 1 帧）
    bus.shouldDrop = (m) => m.t === 'app' && (m.seq === 2 || m.seq === 3)
    await b.send('A', { kind: 'event', teamId: 't', payload: { n: 1 } })
    await b.send('A', { kind: 'event', teamId: 't', payload: { n: 2 } })
    await b.send('A', { kind: 'event', teamId: 't', payload: { n: 3 } })
    expect(seen).toEqual([1])
    expect(b.peers().find((p) => p.peerId === 'A')!.pending).toBe(2)

    bus.shouldDrop = undefined
    bus.disconnect('A')
    await a.reconnect('B') // A 主动重连：sync-req(增量) + 双方重放

    expect(seen.sort((x, y) => x - y)).toEqual([1, 2, 3]) // 无丢失
    expect(new Set(seen).size).toBe(3) // 无重复
    expect(a.peers().find((p) => p.peerId === 'B')!.sinceSeq).toBe(3)

    a.dispose()
    b.dispose()
  })

  it('V1 超 TTL 不可达：unreachable++（只影响该 peer）', async () => {
    const { ctx: ca } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A', reconnectTimeoutMs: 1 }))
    await a.send('Z', frame('event')) // 目标端点未注册
    await sleep(5)
    await a.reconnect('Z')
    expect(a.peers().find((p) => p.peerId === 'Z')!.state).toBe('unreachable')
    expect(a.stats().unreachable).toBe(1)
    a.dispose()
  })

  it('有界待发队列：超界丢最旧并计数（不 OOM、不隐式丢）', async () => {
    const { ctx: ca } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A', maxQueue: 3 }))
    for (let i = 0; i < 5; i++) await a.send('Z', frame('event'))
    expect(a.stats().queueDropped).toBe(2)
    expect(a.peers().find((p) => p.peerId === 'Z')!.pending).toBe(3)
    a.dispose()
  })

  it('失败降级：ssh-rpc 不可用 → 回落 in-process 并告警', async () => {
    const { ctx: ca, warns } = makeCtx() // 无 ctx.ssh
    const a = new TeamTransportService(ca, cfg({ backend: 'ssh-rpc', endpoint: 'A' }))
    expect(a.backend).toBe('in-process')
    expect(warns.some((w) => w.includes('fallback'))).toBe(true)
    a.dispose()
  })

  it('local-child 后端：经 ctx.subprocess seam 把帧 JSONL 化上网', async () => {
    const { local } = duplexPair()
    const subprocessSeam = { spawn: async () => local }
    const { ctx: ca } = makeCtx({ subprocess: subprocessSeam })
    const a = new TeamTransportService(
      ca,
      cfg({ backend: 'local-child', endpoint: 'A', childCommand: 'node', childArgs: ['relay.mjs'] }),
    )
    expect(a.backend).toBe('local-child')
    await a.send('child-1', frame('mutation'))
    await sleep(5) // 等异步建链完成（子进程 spawn 是异步的）
    const wires = local.written.map((w) => JSON.parse(w.trim()))
    const app = wires.find((w) => w.t === 'app')
    expect(app).toBeDefined()
    expect(app.frame.kind).toBe('mutation')
    a.dispose()
  })

  it('ssh-rpc 后端：经 ctx.ssh seam 的 openDuplex 承载帧', async () => {
    const { local } = duplexPair()
    const sshSeam = { openDuplex: async () => local }
    const { ctx: ca } = makeCtx({ ssh: sshSeam })
    const a = new TeamTransportService(ca, cfg({ backend: 'ssh-rpc', endpoint: 'A' }))
    expect(a.backend).toBe('ssh-rpc')
    await a.send('host-1', frame('event'))
    await sleep(5)
    const wires = local.written.map((w) => JSON.parse(w.trim()))
    expect(wires.some((w) => w.t === 'app')).toBe(true)
    a.dispose()
  })

  it('dispose：端点注销、待发队列清空', async () => {
    const { ctx: ca } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A' }))
    await a.send('Z', frame('event'))
    a.dispose()
    expect(getLoopbackBus().has('A')).toBe(false)
    expect(a.peers().every((p) => p.pending === 0)).toBe(true)
  })
})
