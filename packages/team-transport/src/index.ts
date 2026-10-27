/**
 * 跨进程传输底座（阶段 3 · `ctx.teamTransport`）。
 *
 * 职责：把团队帧在 **三种后端**（`in-process` / `local-child` / `ssh-rpc`）间搬运，并**自建**
 * 断线重连、重放、去重与有界队列——因为 DSH 的 `ctx.ssh`/`ctx.subprocess` 只给**非重连**的底层连接
 * （ssh README 明说「连接丢失即失效所有在飞操作」），投递语义必须由本包承担。
 *
 * 投递语义（spec §3.2/§3.3，**可证伪**）：at-least-once + 按 `seq` 幂等去重。
 * - 发送端：帧进**有界待发队列**（未 ack 前保留），ack 到达才摘除；队列满 → **丢最旧并计数**（绝不隐式丢）。
 * - 接收端：按 `seq` 去重（重复帧仍回 ack，以停止对端重发）。
 * - 重连：`connected → degraded → resyncing → connected`；`resyncing` 阶段先让对端按 `sinceSeq`
 *   重放增量，再重放本端 queued-minus-acked；超时未恢复 → `unreachable`（只影响该 peer）。
 *
 * 端口隔离：只从 `@elinpf/dsh-swarm-team-scale-contract` 取类型；`ctx.subprocess`/`ctx.ssh` 用**本地结构化
 * seam** 描述（spec §9 明确二者形状未实测，seam 即隔离边界），不 import 上游实验包类型。
 *
 * @module @elinpf/dsh-swarm-team-transport
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  PeerState,
  PeerStatus,
  TeamTransport,
  TransportBackend,
  TransportFrame,
  TransportStats,
} from '@elinpf/dsh-swarm-team-scale-contract'

export class TeamTransportError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamTransportError'
  }
}

// ── 线协议 ────────────────────────────────────────────────────────────────────
// 帧在链路上是**有结构**的对象（in-process 直传引用、零序列化；子进程/SSH 由 seam 负责 JSONL）。

type WireKind = 'app' | 'ack' | 'sync-req' | 'sync-resp'

interface WireFrame {
  t: WireKind
  /** app 帧：发送端本 peer 单调序号。 */
  seq?: number
  /** ack 帧：确认收到的 app seq。 */
  ackSeq?: number
  /** sync-req 帧：请求方已连续收到的最大 seq（据此重放其后的增量）。 */
  sinceSeq?: number
  /** app 帧负载。 */
  frame?: TransportFrame
}

// ── 链路抽象（seam）──────────────────────────────────────────────────────────

/** 一条全双工链路的最小面。`remoteId` = 对端端点名，用于把入站连接归属到正确 peer。 */
export interface RawLink {
  readonly remoteId: string
  send(msg: WireFrame): void
  close(): void
  onMessage(cb: (msg: WireFrame) => void): void
  onClose(cb: () => void): void
}

/** 链路工厂：把「连到某个 endpoint」抽象掉，后端只负责造链路。 */
interface LinkFactory {
  create(peerId: string, endpoint: string): Promise<RawLink | undefined>
  dispose(): void
}

// ── in-process：内存双端总线（同时是故障注入工具）─────────────────────────────

class LoopbackEnd implements RawLink {
  private msgCb: ((m: WireFrame) => void) | undefined
  private closeCb: (() => void) | undefined
  /** 建链早于消费者挂 onMessage 时先缓冲，避免丢首帧（in-process 同步投递的必然竞态）。 */
  private pending: WireFrame[] = []

  constructor(private readonly channel: LoopbackChannel, private readonly side: 'left' | 'right') {}

  get remoteId(): string {
    return this.side === 'left' ? this.channel.labels.right : this.channel.labels.left
  }

  send(msg: WireFrame): void {
    this.channel.deliver(this.side, msg)
  }
  close(): void {
    this.channel.close()
  }
  onMessage(cb: (m: WireFrame) => void): void {
    this.msgCb = cb
    if (this.pending.length) {
      const queued = this.pending
      this.pending = []
      for (const m of queued) cb(m)
    }
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }

  /** 由对端投递进来。 */
  receive(msg: WireFrame): void {
    if (this.channel.closed) return
    if (this.msgCb) this.msgCb(msg)
    else this.pending.push(msg)
  }
  notifyClose(): void {
    this.closeCb?.()
  }
}

class LoopbackChannel {
  closed = false
  readonly left: LoopbackEnd
  readonly right: LoopbackEnd

  constructor(private readonly bus: LoopbackBus, readonly labels: { left: string; right: string }) {
    this.left = new LoopbackEnd(this, 'left')
    this.right = new LoopbackEnd(this, 'right')
  }

  deliver(from: 'left' | 'right', msg: WireFrame): void {
    if (this.closed) return
    if (this.bus.shouldDrop?.(msg)) return
    if (this.bus.dropRate > 0 && Math.random() < this.bus.dropRate) return
    const target = from === 'left' ? this.right : this.left
    // 同步投递：in-process 直传引用，零序列化（与子进程/SSH 的 JSONL 路径对称）。
    target.receive(msg)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.left.notifyClose()
    this.right.notifyClose()
    this.bus.forget(this)
  }
}

/**
 * 内存双端总线：`in-process` 后端的底座，也是 **V1（丢帧）/V4（断线重连）** 的故障注入点。
 *
 * - `handlers`：已注册端点的入站连接处理器（服务启动时注册自己的 endpoint）。
 * - `shouldDrop` / `dropRate`：确定性 / 概率丢帧注入。
 * - `disconnect(endpoint)`：关闭该端点的所有在飞通道 → 触发双方 `onClose`（进入 degraded）。
 */
export class LoopbackBus {
  private readonly handlers = new Map<string, (link: RawLink) => void>()
  private readonly channels = new Set<LoopbackChannel>()

  /** 概率丢帧（0~1）。测试用 `shouldDrop` 更可控。 */
  dropRate = 0
  /** 确定性丢帧判定：返回 true 则该次投递被丢弃。 */
  shouldDrop: ((msg: WireFrame) => boolean) | undefined

  register(endpoint: string, handler: (link: RawLink) => void): () => void {
    this.handlers.set(endpoint, handler)
    return () => {
      if (this.handlers.get(endpoint) === handler) this.handlers.delete(endpoint)
    }
  }

  has(endpoint: string): boolean {
    return this.handlers.has(endpoint)
  }

  /** `from` 主动连到 `to`；返回 `from` 侧的链路。目标不存在时返回 undefined。 */
  connect(from: string, to: string): RawLink | undefined {
    const handler = this.handlers.get(to)
    if (!handler) return undefined
    const channel = new LoopbackChannel(this, { left: from, right: to })
    this.channels.add(channel)
    handler(channel.right) // 把对端侧交给目标
    return channel.left
  }

  disconnect(endpoint: string): void {
    for (const ch of [...this.channels]) {
      if (ch.labels.left === endpoint || ch.labels.right === endpoint) ch.close()
    }
  }

  /** @internal */ forget(ch: LoopbackChannel): void {
    this.channels.delete(ch)
  }

  reset(): void {
    for (const ch of [...this.channels]) ch.close()
    this.handlers.clear()
    this.dropRate = 0
    this.shouldDrop = undefined
  }
}

// in-process 下，同一进程内的多个传输服务必须共享**同一个**总线才能互相发现端点。
// 生产环境一个进程一个实例；测试里用 resetLoopbackBus() 在用例间清理。
let sharedBus: LoopbackBus | undefined

/** 取进程内共享的 in-process 总线（懒建）。 */
export function getLoopbackBus(): LoopbackBus {
  if (!sharedBus) sharedBus = new LoopbackBus()
  return sharedBus
}

/** 测试用：清空共享总线（端点/通道/注入配置全复位）。 */
export function resetLoopbackBus(): void {
  sharedBus?.reset()
  sharedBus = undefined
}

// ── 子进程 / SSH 的本地结构化 seam（隔离上游实验性形状；spec §9）───────────────

/** 一条带 JSONL 语义的双工通道（子进程 stdio / SSH 帧都归一到它）。 */
export interface DuplexSeam {
  write(data: string): void
  onData(cb: (data: string) => void): void
  onClose(cb: () => void): void
  close(): void
}

/** `ctx.subprocess` 的结构化 seam（只取本包用到的「起子进程拿 stdio 双工」这一面）。 */
export interface SubprocessSeam {
  spawn(cfg: {
    command: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
  }): Promise<DuplexSeam | undefined> | DuplexSeam | undefined
}

/** `ctx.ssh` 的结构化 seam（【推断】形状见 spec §9.1：把连接归一为 JSON 帧双工通道）。 */
export interface SshSeam {
  connect?(endpoint: string): Promise<void> | void
  openDuplex(endpoint: string): Promise<DuplexSeam | undefined> | DuplexSeam | undefined
}

/** 把 JSONL 双工通道适配成 `RawLink`（子进程 / SSH 共用）。 */
class JsonLink implements RawLink {
  private msgCb: ((m: WireFrame) => void) | undefined
  private closeCb: (() => void) | undefined
  private pending: WireFrame[] = []

  constructor(readonly remoteId: string, private readonly duplex: DuplexSeam) {
    duplex.onData((data) => {
      for (const line of data.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const frame = JSON.parse(trimmed) as WireFrame
          if (this.msgCb) this.msgCb(frame)
          else this.pending.push(frame)
        } catch {
          // 坏帧：丢弃单帧而不炸链路（跨进程边界必须容错）
        }
      }
    })
    duplex.onClose(() => this.closeCb?.())
  }

  send(msg: WireFrame): void {
    this.duplex.write(`${JSON.stringify(msg)}\n`)
  }
  close(): void {
    this.duplex.close()
  }
  onMessage(cb: (m: WireFrame) => void): void {
    this.msgCb = cb
    if (this.pending.length) {
      const queued = this.pending
      this.pending = []
      for (const m of queued) cb(m)
    }
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }
}

class ChildProcessLinkFactory implements LinkFactory {
  constructor(
    private readonly seam: SubprocessSeam,
    private readonly command: string,
    private readonly args: string[],
  ) {}

  async create(peerId: string, endpoint: string): Promise<RawLink | undefined> {
    const duplex = await this.seam.spawn({ command: this.command, args: [...this.args, endpoint] })
    return duplex ? new JsonLink(peerId, duplex) : undefined
  }
  dispose(): void {}
}

class SshLinkFactory implements LinkFactory {
  constructor(private readonly seam: SshSeam) {}

  async create(peerId: string, endpoint: string): Promise<RawLink | undefined> {
    await this.seam.connect?.(endpoint)
    const duplex = await this.seam.openDuplex(endpoint)
    return duplex ? new JsonLink(peerId, duplex) : undefined
  }
  dispose(): void {}
}

class InProcessLinkFactory implements LinkFactory {
  constructor(private readonly bus: LoopbackBus, private readonly self: string) {}

  async create(peerId: string, endpoint: string): Promise<RawLink | undefined> {
    void peerId
    return this.bus.connect(this.self, endpoint)
  }
  dispose(): void {}
}

// ── 服务 ──────────────────────────────────────────────────────────────────────

export interface Config {
  /** 默认后端。 */
  backend: TransportBackend
  /** 本进程在传输层的端点名（in-process 下即 peerId）。 */
  endpoint?: string
  /** 待发队列上界（未 ack 帧）；满 → 丢最旧并计数。 */
  maxQueue: number
  /** 重放历史上界（供对端 sync 增量补齐）。 */
  maxHistory: number
  /** 重连后多久未恢复判 unreachable（ms）。 */
  reconnectTimeoutMs: number
  /** 自动重连尝试间隔（ms）；0 / autoReconnect=false 时只接受显式 `reconnect()`。 */
  reconnectIntervalMs: number
  /** 是否自动重连。 */
  autoReconnect: boolean
  /** local-child 后端要跑的中继命令（未配置则 local-child 视为不可用）。 */
  childCommand?: string
  childArgs?: string[]
}

interface OutboundFrame {
  seq: number
  frame: TransportFrame
  tries: number
}

interface PeerRecord {
  peerId: string
  endpoint: string
  backend: TransportBackend
  state: PeerState
  link?: RawLink
  nextSeq: number
  /** 已发送未 ack（重连重放集合 = queued-minus-acked）。 */
  outbound: OutboundFrame[]
  /** 近期已发帧（应答对端 sync-req 的增量重放）。 */
  history: OutboundFrame[]
  /** 已连续收到的最大入站 seq。 */
  sinceSeq: number
  /** 入站去重集合。 */
  seenInbound: Set<number>
  degradedSince: number
  reconnectAttempts: number
}

export class TeamTransportService extends Service implements TeamTransport {
  static Config: z<Config> = z.object({
    backend: z.union(['in-process', 'local-child', 'ssh-rpc'] as const).default('in-process'),
    endpoint: z.string(),
    maxQueue: z.number().step(1).min(1).default(1024),
    maxHistory: z.number().step(1).min(1).default(1024),
    reconnectTimeoutMs: z.number().step(1).min(1).default(15000),
    reconnectIntervalMs: z.number().step(1).min(0).default(1000),
    autoReconnect: z.boolean().default(true),
    childCommand: z.string(),
    childArgs: z.array(z.string()).default([]),
  })

  private config: Config
  private bus: LoopbackBus | undefined
  private unregisterEndpoint: (() => void) | undefined
  private factory: LinkFactory | undefined
  private effectiveBackend: TransportBackend = 'in-process'
  private selfEndpoint = ''
  private readonly peerMap = new Map<string, PeerRecord>()
  private readonly frameHandlers = new Set<(peerId: string, frame: TransportFrame) => void>()
  private readonly counters: TransportStats = {
    sent: 0,
    acked: 0,
    retried: 0,
    dedupDropped: 0,
    replayed: 0,
    unreachable: 0,
    queueDropped: 0,
  }
  private timers = new Map<string, ReturnType<typeof setInterval>>()
  private disposed = false

  constructor(ctx: Context, config: Config = defaultConfig()) {
    super(ctx, 'teamTransport')
    this.config = config
    ctx.effect(() => {
      void this.start({ backend: config.backend, endpoint: config.endpoint })
      return () => this.dispose()
    }, 'teamTransport.lifecycle()')
  }

  /** 实际生效的后端（可能因不可用回落，见 §4.2 失败降级）。 */
  get backend(): TransportBackend {
    return this.effectiveBackend
  }

  async start(cfg: { backend: TransportBackend; endpoint?: string }): Promise<() => void> {
    this.teardown()
    this.disposed = false
    this.selfEndpoint = cfg.endpoint ?? this.config.endpoint ?? 'default'
    this.bus = getLoopbackBus()
    this.unregisterEndpoint = this.bus.register(this.selfEndpoint, (link) =>
      this.acceptInbound(link),
    )
    const requested = cfg.backend
    let factory = this.makeFactory(requested)
    this.effectiveBackend = requested
    if (!factory) {
      // 失败降级：请求的后端不可用 → 回落 in-process，告警（spec §4.2）
      this.ctx.logger?.warn?.(
        'team-transport: backend %s unavailable → fallback to in-process',
        requested,
      )
      this.effectiveBackend = 'in-process'
      factory = new InProcessLinkFactory(this.bus, this.selfEndpoint)
    }
    this.factory = factory
    return () => this.dispose()
  }

  private makeFactory(backend: TransportBackend): LinkFactory | undefined {
    if (backend === 'in-process') return new InProcessLinkFactory(this.bus!, this.selfEndpoint)
    if (backend === 'local-child') {
      const seam = this.ctx.get('subprocess') as SubprocessSeam | undefined
      if (!seam?.spawn || !this.config.childCommand) return undefined
      return new ChildProcessLinkFactory(
        seam,
        this.config.childCommand,
        this.config.childArgs ?? [],
      )
    }
    const seam = this.ctx.get('ssh') as SshSeam | undefined
    if (!seam?.openDuplex) return undefined
    return new SshLinkFactory(seam)
  }

  // ── 外部 API ────────────────────────────────────────────────────────────────

  async send(peerId: string, frame: TransportFrame): Promise<{ seq: number }> {
    const peer = this.ensurePeer(peerId)
    const seq = peer.nextSeq++
    const out: OutboundFrame = { seq, frame, tries: 0 }
    this.enqueue(peer, out)
    // 仅 CONNECTED 时立即上网；degraded/resyncing 时留在队列，重连后重放（不静默丢）
    if (peer.state === 'connected' && peer.link) this.transmit(peer, out, 'first')
    return { seq }
  }

  onFrame(handler: (peerId: string, frame: TransportFrame) => void): () => void {
    this.frameHandlers.add(handler)
    return () => {
      this.frameHandlers.delete(handler)
    }
  }

  peers(): PeerStatus[] {
    return [...this.peerMap.values()].map((p) => ({
      peerId: p.peerId,
      backend: p.backend,
      state: p.state,
      sinceSeq: p.sinceSeq,
      pending: p.outbound.length,
    }))
  }

  stats(): TransportStats {
    return { ...this.counters }
  }

  async reconnect(peerId: string): Promise<void> {
    const peer = this.peerMap.get(peerId)
    if (!peer || peer.state === 'connected' || !this.factory) return
    this.setState(peer, 'resyncing')
    let link: RawLink | undefined
    try {
      link = await this.factory.create(peer.peerId, peer.endpoint)
    } catch (e) {
      this.ctx.logger?.warn?.('team-transport: reconnect %s failed: %s', peerId, String(e))
    }
    if (!link) {
      peer.reconnectAttempts++
      if (Date.now() - peer.degradedSince > this.config.reconnectTimeoutMs) {
        this.counters.unreachable++
        this.setState(peer, 'unreachable')
      } else {
        this.setState(peer, 'degraded')
        this.scheduleReconnect(peer)
      }
      return
    }
    peer.reconnectAttempts = 0
    this.activate(peer, link)
  }

  dispose(): void {
    this.teardown()
    this.disposed = true
  }

  // ── 内部：peer 管理 ──────────────────────────────────────────────────────────

  private ensurePeer(peerId: string): PeerRecord {
    let peer = this.peerMap.get(peerId)
    if (!peer) {
      peer = this.newPeer(peerId)
      this.peerMap.set(peerId, peer)
      // 首次接触即尝试建链（对端可能尚未注册 → 保持 degraded，等待显式 reconnect / 自动重连 / 对方主动连入）
      void this.reconnect(peerId)
    }
    return peer
  }

  private newPeer(peerId: string): PeerRecord {
    return {
      peerId,
      endpoint: peerId,
      backend: this.effectiveBackend,
      state: 'degraded',
      nextSeq: 1,
      outbound: [],
      history: [],
      sinceSeq: 0,
      seenInbound: new Set(),
      degradedSince: Date.now(),
      reconnectAttempts: 0,
    }
  }

  /** 对端主动连入：链路自带 `remoteId`，据此归属 peer。 */
  private acceptInbound(link: RawLink): void {
    const peer = this.peerMap.get(link.remoteId) ?? this.newPeer(link.remoteId)
    this.peerMap.set(peer.peerId, peer)
    this.activate(peer, link)
  }

  /** 建链成功后的统一入口：挂链路 → 拉 sinceSeq 增量 → 重放本端 queued-minus-acked → CONNECTED。 */
  private activate(peer: PeerRecord, link: RawLink): void {
    peer.link?.close()
    this.attachLink(peer, link)
    link.send({ t: 'sync-req', sinceSeq: peer.sinceSeq })
    for (const out of [...peer.outbound]) this.transmit(peer, out, 'replay')
    this.setState(peer, 'connected')
    this.clearReconnectTimer(peer.peerId)
  }

  private attachLink(peer: PeerRecord, link: RawLink): void {
    peer.link = link
    link.onMessage((msg) => this.onWire(peer, msg))
    link.onClose(() => this.onLinkClosed(peer))
  }

  private onLinkClosed(peer: PeerRecord): void {
    if (peer.state === 'unreachable') return
    peer.link = undefined
    peer.degradedSince = Date.now()
    this.setState(peer, 'degraded')
    if (this.config.autoReconnect) this.scheduleReconnect(peer)
  }

  private setState(peer: PeerRecord, state: PeerState): void {
    if (peer.state === state) return
    peer.state = state
    // `swarm/transport/peer`（durable，peer 状态迁移观测）
    this.emit('swarm/transport/peer', {
      version: 1 as const,
      peerId: peer.peerId,
      backend: peer.backend,
      state,
    })
  }

  private enqueue(peer: PeerRecord, out: OutboundFrame): void {
    peer.outbound.push(out)
    // 有界队列：满 → 丢最旧 + 计数（spec §3.3，明确策略，绝不隐式丢）
    while (peer.outbound.length > this.config.maxQueue) {
      peer.outbound.shift()
      this.counters.queueDropped++
    }
  }

  private transmit(peer: PeerRecord, out: OutboundFrame, mode: 'first' | 'replay'): void {
    if (!peer.link) return
    try {
      peer.link.send({ t: 'app', seq: out.seq, frame: out.frame })
    } catch (e) {
      this.ctx.logger?.warn?.('team-transport: transmit failed: %s', String(e))
      return
    }
    out.tries++
    this.counters.sent++
    if (mode === 'replay') {
      this.counters.replayed++
      this.counters.retried++
    }
    // 记录重放历史（供对端 sync-req 增量补齐）
    peer.history.push(out)
    while (peer.history.length > this.config.maxHistory) peer.history.shift()
  }

  private onWire(peer: PeerRecord, msg: WireFrame): void {
    switch (msg.t) {
      case 'app':
        this.handleApp(peer, msg)
        break
      case 'ack':
        this.handleAck(peer, msg.ackSeq ?? 0)
        break
      case 'sync-req':
        this.handleSyncReq(peer, msg.sinceSeq ?? 0)
        break
      case 'sync-resp':
        // 对端已补齐增量；本端重放集合已在 activate() 中处理
        break
    }
  }

  private handleApp(peer: PeerRecord, msg: WireFrame): void {
    const seq = msg.seq ?? 0
    const dup = seq > 0 && (peer.seenInbound.has(seq) || seq <= peer.sinceSeq)
    if (dup) {
      this.counters.dedupDropped++
      // 重复帧仍回 ack：停止对端无谓重发（幂等，不二次投喂）
      peer.link?.send({ t: 'ack', ackSeq: seq })
      return
    }
    if (seq > 0) {
      peer.seenInbound.add(seq)
      if (seq > peer.sinceSeq) peer.sinceSeq = seq
    }
    peer.link?.send({ t: 'ack', ackSeq: seq })
    if (msg.frame) for (const h of this.frameHandlers) h(peer.peerId, msg.frame)
  }

  private handleAck(peer: PeerRecord, ackSeq: number): void {
    const idx = peer.outbound.findIndex((o) => o.seq === ackSeq)
    if (idx >= 0) {
      peer.outbound.splice(idx, 1)
      this.counters.acked++
    }
  }

  private handleSyncReq(peer: PeerRecord, sinceSeq: number): void {
    for (const out of peer.history) {
      if (out.seq > sinceSeq) {
        peer.link?.send({ t: 'app', seq: out.seq, frame: out.frame })
        this.counters.sent++
        this.counters.replayed++
      }
    }
    peer.link?.send({ t: 'sync-resp' })
  }

  private scheduleReconnect(peer: PeerRecord): void {
    if (this.timers.has(peer.peerId) || this.disposed) return
    const interval = this.config.reconnectIntervalMs
    if (interval <= 0 || !this.config.autoReconnect) return
    const timer = setInterval(() => void this.reconnect(peer.peerId), interval)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.set(peer.peerId, timer)
  }

  private clearReconnectTimer(peerId: string): void {
    const t = this.timers.get(peerId)
    if (t) {
      clearInterval(t)
      this.timers.delete(peerId)
    }
  }

  private emit(name: string, payload: unknown): void {
    try {
      const emit = (this.ctx as unknown as { emit?: (n: string, p: unknown) => void }).emit
      emit?.call(this.ctx, name, payload)
    } catch (e) {
      this.ctx.logger?.warn?.('team-transport: emit %s failed: %s', name, String(e))
    }
  }

  private teardown(): void {
    for (const t of this.timers.values()) clearInterval(t)
    this.timers.clear()
    for (const peer of this.peerMap.values()) {
      peer.link?.close()
      peer.link = undefined
      peer.outbound.length = 0
      peer.history.length = 0
    }
    this.factory?.dispose()
    this.factory = undefined
    this.bus?.disconnect(this.selfEndpoint)
    this.unregisterEndpoint?.()
    this.unregisterEndpoint = undefined
    this.bus = undefined
  }
}

function defaultConfig(): Config {
  return {
    backend: 'in-process',
    maxQueue: 1024,
    maxHistory: 1024,
    reconnectTimeoutMs: 15000,
    reconnectIntervalMs: 1000,
    autoReconnect: true,
    childArgs: [],
  }
}

export default TeamTransportService
