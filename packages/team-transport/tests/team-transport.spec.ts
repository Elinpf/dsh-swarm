import { beforeEach, describe, expect, it } from 'vitest'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import TeamTransportService, {
  getLoopbackBus,
  resetLoopbackBus,
  type Config,
  type SubprocessSeam,
} from '../src/index.ts'

/** 假 ctx：只提供 Service 构造 + 本包逻辑所需的 `effect/get/logger/emit`。 */
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
    ackTimeoutMs: 1000,
    autoReconnect: false,
    ...over,
  }
}

const frame = (kind: 'mutation' | 'event', n = 1): any => ({
  kind,
  teamId: 't',
  payload: { n },
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RELAY = fileURLToPath(new URL('../relay/relay.mjs', import.meta.url))

/**
 * **真实子进程** seam：用 Node `child_process` 起 relay 真进程（非 mock）。
 * 与 `ctx.subprocess` 的 handle 形状对齐：`{ stdin, stdout, terminate, done }`。
 */
function nodeSeam(env: Record<string, string> = {}) {
  const children: ChildProcess[] = []
  const seam: SubprocessSeam & { children: ChildProcess[]; killAll(): void } = {
    children,
    async resolveExecutable() {
      return process.execPath
    },
    spawn(spec) {
      const child = nodeSpawn(spec.argv[0]!, spec.argv.slice(1) as string[], {
        cwd: spec.cwd,
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, ...env },
      })
      children.push(child)
      return {
        stdin: child.stdin ?? undefined,
        stdout: child.stdout ?? undefined,
        terminate: () => void child.kill('SIGKILL'),
        done: new Promise((res) =>
          child.on('close', (code, signal) => res({ exitCode: code, signal: signal ?? null })),
        ),
      }
    },
    killAll() {
      for (const c of children) c.kill('SIGKILL')
    },
  }
  return seam
}

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
    bus.shouldDrop = (m) => m.t === 'ack'
    await a.send('B', frame('event'))
    expect(count).toBe(1)
    expect(a.stats().acked).toBe(0)
    expect(a.peers().find((p) => p.peerId === 'B')!.pending).toBe(1)

    bus.shouldDrop = undefined
    bus.disconnect('B')
    await a.reconnect('B')
    expect(count).toBe(1)
    expect(b.stats().dedupDropped).toBeGreaterThanOrEqual(1)
    expect(a.stats().acked).toBeGreaterThanOrEqual(1)
    a.dispose()
    b.dispose()
  })

  it('V4 断线重连：状态机 connected→degraded→resyncing→connected 可观测', async () => {
    const { ctx: ca, events } = makeCtx()
    const { ctx: cb } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A' }))
    const b = new TeamTransportService(cb, cfg({ endpoint: 'B' }))
    await a.send('B', frame('event'))

    getLoopbackBus().disconnect('B')
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

  it('V1/V4 增量补齐：B→A 丢帧后重连，A 终态无丢失、无重复', async () => {
    const { ctx: ca } = makeCtx()
    const { ctx: cb } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A' }))
    const b = new TeamTransportService(cb, cfg({ endpoint: 'B' }))
    const seen: number[] = []
    a.onFrame((_pid, f) => seen.push((f.payload as any).n))
    const bus = getLoopbackBus()

    bus.shouldDrop = (m) => m.t === 'app' && (m.seq === 2 || m.seq === 3)
    await b.send('A', frame('event', 1))
    await b.send('A', frame('event', 2))
    await b.send('A', frame('event', 3))
    expect(seen).toEqual([1])

    bus.shouldDrop = undefined
    bus.disconnect('A')
    await a.reconnect('B')
    expect(seen.sort((x, y) => x - y)).toEqual([1, 2, 3])
    a.dispose()
    b.dispose()
  })

  it('V1 超 TTL 不可达：unreachable++（只影响该 peer）', async () => {
    const { ctx: ca } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ endpoint: 'A', reconnectTimeoutMs: 1 }))
    await a.send('Z', frame('event'))
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
    const { ctx: ca, warns } = makeCtx()
    const a = new TeamTransportService(ca, cfg({ backend: 'ssh-rpc', endpoint: 'A' }))
    expect(a.backend).toBe('in-process')
    expect(warns.some((w) => w.includes('fallback'))).toBe(true)
    a.dispose()
  })

  it('ssh-rpc 后端：经 ctx.ssh seam 的 openDuplex 承载帧（JSONL）', async () => {
    const written: string[] = []
    let dataCb: ((s: string) => void) | undefined
    const duplex = {
      write: (s: string) => void written.push(s),
      onData: (cb: (s: string) => void) => void (dataCb = cb),
      onClose: () => {},
      close: () => {},
    }
    const { ctx: ca } = makeCtx({ ssh: { openDuplex: async () => duplex } })
    const a = new TeamTransportService(ca, cfg({ backend: 'ssh-rpc', endpoint: 'A' }))
    expect(a.backend).toBe('ssh-rpc')
    await a.send('host-1', frame('event'))
    await sleep(5)
    const wires = written.map((w) => JSON.parse(w.trim()))
    expect(wires.some((w) => w.t === 'app')).toBe(true)
    void dataCb
    a.dispose()
  })

  // ── 真实子进程（local-child）───────────────────────────────────────────────

  it('local-child 真实子进程：send → 子进程 ack + 回声被父观察到（真 node 进程）', async () => {
    const seam = nodeSeam()
    const { ctx } = makeCtx({ subprocess: seam })
    const a = new TeamTransportService(
      ctx,
      cfg({ backend: 'local-child', endpoint: 'A', childRelayPath: RELAY, nodeBin: 'node' }),
    )
    expect(a.backend).toBe('local-child')
    const echoes: number[] = []
    a.onFrame((_pid, f) => echoes.push((f.payload as any).n))
    await a.send('child-1', frame('event', 7))
    await sleep(120)
    expect(seam.children.length).toBe(1) // 真起了子进程
    expect(echoes).toEqual([7]) // 恰好一次回声
    expect(a.stats().acked).toBeGreaterThanOrEqual(1) // 子进程 ack
    a.dispose()
    seam.killAll()
  })

  it('V2 真实子进程：子进程丢弃 ack → 父重发 → 目标恰好一次（幂等去重）', async () => {
    const seam = nodeSeam({ RELAY_DROP_ACKS: '1', RELAY_ACK_TIMEOUT_MS: '20' })
    const { ctx } = makeCtx({ subprocess: seam })
    const a = new TeamTransportService(
      ctx,
      cfg({
        backend: 'local-child',
        endpoint: 'A',
        childRelayPath: RELAY,
        nodeBin: 'node',
        ackTimeoutMs: 30,
      }),
    )
    let count = 0
    a.onFrame(() => count++)
    await a.send('child-1', frame('event', 1))
    await sleep(200)
    expect(count).toBe(1) // 恰好一次生效（重复只 ack 不回声）
    expect(a.stats().retried).toBeGreaterThanOrEqual(1) // 发生了 ack 超时重发
    expect(a.peers().find((p) => p.peerId === 'child-1')!.pending).toBe(0) // 最终 ack 掉
    a.dispose()
    seam.killAll()
  })

  it('V1 真实子进程：子进程回声丢失 → 重发定时器补齐，父终态无丢失无重复', async () => {
    const seam = nodeSeam({ RELAY_DROP_ECHOES: '1', RELAY_ACK_TIMEOUT_MS: '20' })
    const { ctx } = makeCtx({ subprocess: seam })
    const a = new TeamTransportService(
      ctx,
      cfg({ backend: 'local-child', endpoint: 'A', childRelayPath: RELAY, nodeBin: 'node' }),
    )
    const seen: number[] = []
    a.onFrame((_pid, f) => seen.push((f.payload as any).n))
    await a.send('child-1', frame('event', 42))
    await sleep(250) // 等子进程重发定时器补上丢失的回声
    expect(seen).toEqual([42]) // 丢失的回声被补齐，且恰好一次（父 ack 后子进程停止重发）
    a.dispose()
    seam.killAll()
  })

  it('local-listen：两服务经 socket + 端点注册/发现互连（真实本机监听）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-listen-'))
    const { ctx: ca } = makeCtx()
    const { ctx: cb } = makeCtx()
    const a = new TeamTransportService(
      ca,
      cfg({ backend: 'local-listen', endpoint: 'A', registryDir: dir }),
    )
    const b = new TeamTransportService(
      cb,
      cfg({ backend: 'local-listen', endpoint: 'B', registryDir: dir }),
    )
    await sleep(80) // 监听服务端异步起来后写入 registry
    expect(a.backend).toBe('local-listen')
    expect(existsSync(join(dir, 'A.json'))).toBe(true)
    expect(existsSync(join(dir, 'B.json'))).toBe(true)

    const got: number[] = []
    b.onFrame((_p, f) => got.push((f.payload as any).n))
    await a.send('B', frame('event', 3))
    await sleep(200)
    expect(got).toEqual([3])
    expect(a.stats().acked).toBeGreaterThanOrEqual(1)

    a.dispose()
    b.dispose()
    expect(existsSync(join(dir, 'A.json'))).toBe(false)
    expect(existsSync(join(dir, 'B.json'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('local-listen 租约 GC：陈旧端点（死进程/超租约）在启动时被清理', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gc-'))
    writeFileSync(
      join(dir, 'dead.json'),
      JSON.stringify({
        endpoint: 'dead',
        path: join(dir, 'dead.sock'),
        pid: 999999,
        heartbeatAt: 0,
      }),
    )
    writeFileSync(join(dir, 'dead.sock'), '')
    const { ctx } = makeCtx()
    const a = new TeamTransportService(
      ctx,
      cfg({ backend: 'local-listen', endpoint: 'A', registryDir: dir, leaseTtlMs: 1000 }),
    )
    await sleep(100)
    expect(existsSync(join(dir, 'dead.json'))).toBe(false)
    expect(existsSync(join(dir, 'dead.sock'))).toBe(false)
    a.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('local-listen 握手令牌：未授权拨入被拒，正确令牌可投递', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-'))
    const { ctx: cb } = makeCtx()
    const b = new TeamTransportService(
      cb,
      cfg({ backend: 'local-listen', endpoint: 'B', registryDir: dir, listenToken: 'secret' }),
    )
    await sleep(100)
    const got: number[] = []
    b.onFrame((_p, f) => got.push((f.payload as any).n))

    const { ctx: cbad } = makeCtx()
    const bad = new TeamTransportService(
      cbad,
      cfg({ backend: 'local-listen', endpoint: 'A', registryDir: dir, listenToken: 'wrong' }),
    )
    await sleep(100) // 等自身监听就绪（factory 装配）
    await bad.send('B', frame('event', 1))
    await sleep(200)
    expect(got).toEqual([]) // 未授权被拒（不静默接受）

    const { ctx: cgood } = makeCtx()
    const good = new TeamTransportService(
      cgood,
      cfg({ backend: 'local-listen', endpoint: 'A2', registryDir: dir, listenToken: 'secret' }),
    )
    await sleep(100)
    await good.send('B', frame('event', 2))
    await sleep(200)
    expect(got).toEqual([2]) // 正确令牌可投递

    bad.dispose()
    good.dispose()
    b.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('V4 真实子进程：kill 子进程 → degraded → 重生子进程 → connected（epoch 复位）', async () => {
    const seam = nodeSeam()
    const { ctx } = makeCtx({ subprocess: seam })
    const a = new TeamTransportService(
      ctx,
      cfg({ backend: 'local-child', endpoint: 'A', childRelayPath: RELAY, nodeBin: 'node' }),
    )
    await a.send('child-1', frame('event', 1))
    await sleep(80)
    expect(seam.children.length).toBe(1)

    seam.children[0]!.kill('SIGKILL') // 真实杀死
    await sleep(100)
    expect(a.peers().find((p) => p.peerId === 'child-1')!.state).toBe('degraded')

    await a.reconnect('child-1') // 重生子进程
    await sleep(80)
    expect(seam.children.length).toBe(2)
    expect(a.peers().find((p) => p.peerId === 'child-1')!.state).toBe('connected')

    // 重启后仍能收发（新 epoch 复位去重窗口，不会把新帧当重复丢弃）
    const seen: number[] = []
    a.onFrame((_pid, f) => seen.push((f.payload as any).n))
    await a.send('child-1', frame('event', 9))
    await sleep(80)
    expect(seen).toContain(9)
    a.dispose()
    seam.killAll()
  })
})
