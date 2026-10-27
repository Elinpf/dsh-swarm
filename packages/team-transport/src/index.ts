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

import { fileURLToPath } from 'node:url'
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /** 发送端**进程纪元**：对端重启后 seq 空间重置，接收端据此复位去重窗口（跨进程正确性的关键）。 */
  epoch?: string
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

/** 一条带 JSONL 语义的双工通道（SSH 帧归一到这里）。 */
export interface DuplexSeam {
  write(data: string): void
  onData(cb: (data: string) => void): void
  onClose(cb: () => void): void
  close(): void
}

/**
 * `ctx.subprocess` 的结构化 seam —— 形状**按 0.2.1-rc.3 实测对齐**
 * （`SubprocessHandle`：`stdin` Writable / `stdout` Readable / `done` / `terminate()`；
 * `spawn` 同步返回 handle，`resolveExecutable` 解析可执行文件）。
 */
export interface NodeWritableSeam {
  write(chunk: string | Uint8Array): unknown
}
export interface NodeReadableSeam {
  on(event: 'data', cb: (chunk: unknown) => void): unknown
}
export interface SubprocessHandleSeam {
  readonly stdin: NodeWritableSeam | undefined
  readonly stdout: NodeReadableSeam | undefined
  terminate(): void
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
}
export interface SubprocessSeam {
  resolveExecutable?(name: string): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'inherit' }
    graceMs: number
  }): SubprocessHandleSeam
}

/** `ctx.ssh` 的结构化 seam（【推断·未实测】形状见 spec §9.1；本环境未安装 dsh-ssh）。 */
export interface SshSeam {
  connect?(endpoint: string): Promise<void> | void
  openDuplex(endpoint: string): Promise<DuplexSeam | undefined> | DuplexSeam | undefined
}

/** JSONL 行缓冲提取器：跨进程 `data` 事件按块到达，**必须**按行拼接，否则半行被丢。 */
function drainLines(buffer: string, chunk: unknown, onLine: (line: string) => void): string {
  let rest = buffer + String(chunk)
  let idx: number
  while ((idx = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, idx).trim()
    rest = rest.slice(idx + 1)
    if (line) onLine(line)
  }
  return rest
}

/** 把 JSONL 双工通道适配成 `RawLink`（SSH）。 */
class JsonLink implements RawLink {
  private msgCb: ((m: WireFrame) => void) | undefined
  private closeCb: (() => void) | undefined
  private pending: WireFrame[] = []
  private buffer = ''

  constructor(readonly remoteId: string, private readonly duplex: DuplexSeam) {
    duplex.onData((data) => {
      this.buffer = drainLines(this.buffer, data, (line) => this.accept(line))
    })
    duplex.onClose(() => this.closeCb?.())
  }

  private accept(line: string): void {
    try {
      const frame = JSON.parse(line) as WireFrame
      if (this.msgCb) this.msgCb(frame)
      else this.pending.push(frame)
    } catch {
      // 坏帧：丢弃单帧而不炸链路（跨进程边界必须容错）
    }
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

/** 把**真实**子进程 handle（stdin/stdout/terminate/done）适配成 `RawLink`。 */
class NodeStreamLink implements RawLink {
  private msgCb: ((m: WireFrame) => void) | undefined
  private closeCb: (() => void) | undefined
  private pending: WireFrame[] = []
  private buffer = ''
  private closed = false

  constructor(readonly remoteId: string, private readonly handle: SubprocessHandleSeam) {
    this.handle.stdout?.on('data', (chunk) => {
      this.buffer = drainLines(this.buffer, chunk, (line) => this.accept(line))
    })
    void this.handle.done.then(
      () => this.fireClose(),
      () => this.fireClose(),
    )
  }

  private accept(line: string): void {
    try {
      const frame = JSON.parse(line) as WireFrame
      if (this.msgCb) this.msgCb(frame)
      else this.pending.push(frame)
    } catch {
      // 坏帧：丢弃单帧而不炸链路
    }
  }
  private fireClose(): void {
    if (this.closed) return
    this.closed = true
    this.closeCb?.()
  }

  send(msg: WireFrame): void {
    if (this.closed) return
    try {
      this.handle.stdin?.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // 子进程已死：链路 close 会触发重连
    }
  }
  close(): void {
    try {
      this.handle.terminate()
    } catch {
      /* idempotent */
    }
    this.fireClose()
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

/** local-child：**真起子进程**跑 relay，stdio 走 JSONL。 */
class ChildProcessLinkFactory implements LinkFactory {
  constructor(
    private readonly seam: SubprocessSeam,
    private readonly nodeBin: string,
    private readonly relayPath: string,
    private readonly cwd: string,
  ) {}

  async create(peerId: string, endpoint: string): Promise<RawLink | undefined> {
    let exe = this.nodeBin
    try {
      if (this.seam.resolveExecutable) exe = await this.seam.resolveExecutable(this.nodeBin)
    } catch {
      /* 回退到裸命令名，交给 spawn 报错 */
    }
    try {
      const handle = this.seam.spawn({
        argv: [exe, this.relayPath, endpoint],
        cwd: this.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
        graceMs: 5000,
      })
      return new NodeStreamLink(peerId, handle)
    } catch {
      return undefined
    }
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

// ── local-listen：本机监听 + 端点注册/发现（P32，「任意两进程自动互连」）──────

/** 端点注册条目（写在 registry 目录，供其它进程**发现**）。 */
interface RegistryEntry {
  endpoint: string
  path: string
  pid: number
  /** 心跳时间（ms epoch）；租约过期判据（P32 遗留修复）。 */
  heartbeatAt: number
}

function sanitizeEndpoint(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** 进程是否存活（`kill(pid,0)`）。 */
function isPidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 清理**陈旧端点**（P32 遗留）：持锁进程已死或心跳超租约 → 删除其 `.json`/`.sock`，
 * 避免其它进程「发现」到僵尸端点后反复拨号失败。返回清理条数。
 */
function gcStaleEndpoints(dir: string, leaseTtlMs: number): number {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    let entry: RegistryEntry | undefined
    try {
      entry = JSON.parse(readFileSync(file, 'utf8')) as RegistryEntry
    } catch {
      entry = undefined
    }
    const stale =
      !entry || !isPidAlive(entry.pid) || Date.now() - (entry.heartbeatAt ?? 0) > leaseTtlMs
    if (stale) {
      rmSync(file, { force: true })
      if (entry?.path) rmSync(entry.path, { force: true })
      removed += 1
    }
  }
  return removed
}

/** 一条 socket 链路（JSONL 帧 + 首行 hello 握手定对端名 + 可选令牌）。 */
class SocketLink implements RawLink {
  private msgCb: ((m: WireFrame) => void) | undefined
  private closeCb: (() => void) | undefined
  private readyCb: ((l: SocketLink) => void) | undefined
  private pending: WireFrame[] = []
  private buffer = ''
  private helloSeen = false
  /** 对端 hello 携带的令牌（鉴权用）。 */
  helloToken: string | undefined
  remoteId: string

  constructor(remoteId: string, private readonly sock: Socket) {
    this.remoteId = remoteId
    sock.setEncoding('utf8')
    sock.on('data', (d) => {
      this.buffer = drainLines(this.buffer, d, (line) => this.onLine(line))
    })
    sock.on('close', () => this.closeCb?.())
    sock.on('error', () => this.closeCb?.())
  }

  onReady(cb: (l: SocketLink) => void): void {
    this.readyCb = cb
  }
  /** 客户端连接后主动发 hello（可带令牌）；服务端在收到 hello 后才算就绪。 */
  sendHello(endpoint: string, token?: string): void {
    this.helloSeen = true
    this.sock.write(`${JSON.stringify({ t: 'hello', endpoint, token })}\n`)
  }

  private onLine(line: string): void {
    let m: WireFrame & { endpoint?: string; token?: string }
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (!this.helloSeen) {
      if (m.t === ('hello' as string)) {
        this.helloSeen = true
        this.helloToken = m.token
        if (!this.remoteId && m.endpoint) this.remoteId = m.endpoint
        this.readyCb?.(this)
      }
      return
    }
    if (this.msgCb) this.msgCb(m)
    else this.pending.push(m)
  }

  send(msg: WireFrame): void {
    try {
      this.sock.write(`${JSON.stringify(msg)}\n`)
    } catch {
      /* 对端已断：close 会触发重连 */
    }
  }
  close(): void {
    try {
      this.sock.destroy()
    } catch {
      /* idempotent */
    }
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

/**
 * 本机监听服务端：在 `<registryDir>/<endpoint>.sock` 上 accept 入站连接。
 * - **租约**：周期性刷新 registry 的 `heartbeatAt`（心跳），供其它进程判断存活。
 * - **鉴权**：配置 `token` 后，hello 令牌不匹配 → **拒绝**（销毁连接，不 attach）。
 */
class LocalListenServer {
  private server: Server | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  constructor(
    private readonly dir: string,
    private readonly endpoint: string,
    private readonly onConnection: (link: RawLink) => void,
    private readonly token?: string,
    private readonly heartbeatMs = 10000,
  ) {}

  async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    const sockPath = join(this.dir, `${sanitizeEndpoint(this.endpoint)}.sock`)
    rmSync(sockPath, { force: true })
    this.server = createServer((sock) => this.handle(sock))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(sockPath, () => resolve())
    })
    this.writeEntry(sockPath)
    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.writeEntry(sockPath), this.heartbeatMs)
      ;(this.heartbeat as { unref?: () => void }).unref?.()
    }
  }

  private writeEntry(sockPath: string): void {
    const entry: RegistryEntry = {
      endpoint: this.endpoint,
      path: sockPath,
      pid: process.pid,
      heartbeatAt: Date.now(),
    }
    try {
      writeFileSync(
        join(this.dir, `${sanitizeEndpoint(this.endpoint)}.json`),
        JSON.stringify(entry),
      )
    } catch {
      /* ignore */
    }
  }

  private handle(sock: Socket): void {
    const link = new SocketLink('', sock)
    link.onReady((l) => {
      if (this.token && l.helloToken !== this.token) {
        // 鉴权失败：拒绝并断开，不 attach 到运行时（防止未授权拨入）
        l.close()
        return
      }
      this.onConnection(l)
    })
  }

  dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    try {
      this.server?.close()
    } catch {
      /* ignore */
    }
    this.server = undefined
    const base = sanitizeEndpoint(this.endpoint)
    rmSync(join(this.dir, `${base}.json`), { force: true })
    rmSync(join(this.dir, `${base}.sock`), { force: true })
  }
}

/**
 * 拨号工厂：从 registry **发现**端点地址并连接。
 * - **过期判据**：心跳超 `leaseTtlMs` 或持有进程已死 → 清理并返回 undefined（不连僵尸）。
 * - **鉴权**：hello 携带 `token`（与服务端 `listenToken` 一致才被接受）。
 */
class LocalListenDialFactory implements LinkFactory {
  constructor(
    private readonly dir: string,
    private readonly self: string,
    private readonly token?: string,
    private readonly leaseTtlMs = 30000,
  ) {}

  async create(peerId: string): Promise<RawLink | undefined> {
    const file = join(this.dir, `${sanitizeEndpoint(peerId)}.json`)
    if (!existsSync(file)) return undefined
    let entry: RegistryEntry
    try {
      entry = JSON.parse(readFileSync(file, 'utf8')) as RegistryEntry
    } catch {
      return undefined
    }
    // 陈旧端点：进程已死或心跳超租约 → 清理 + 不拨号
    const stale = !isPidAlive(entry.pid) || Date.now() - (entry.heartbeatAt ?? 0) > this.leaseTtlMs
    if (stale) {
      rmSync(file, { force: true })
      if (entry.path) rmSync(entry.path, { force: true })
      return undefined
    }
    return await new Promise<RawLink | undefined>((resolve) => {
      const sock = netConnect(entry.path)
      const link = new SocketLink(peerId, sock)
      const done = (v: RawLink | undefined) => resolve(v)
      sock.once('error', () => done(undefined))
      sock.once('connect', () => {
        link.sendHello(this.self, this.token)
        done(link)
      })
    })
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
  /** 未 ack 帧的重发节拍（ms）；0 关闭（spec §3.2 退避重试）。 */
  ackTimeoutMs: number
  /** 是否自动重连。 */
  autoReconnect: boolean
  /** local-child 后端：运行 relay 的 node 可执行文件（默认 `node`，经 resolveExecutable 解析）。 */
  nodeBin?: string
  /** relay 脚本路径（默认随包发布：`../relay/relay.mjs`）。 */
  childRelayPath?: string
  /** 子进程工作目录（默认进程 cwd）。 */
  childCwd?: string
  /** local-listen 后端的端点注册/发现目录（默认 `<cwd>/.runtime/xproc-registry`）。 */
  registryDir?: string
  /** local-listen 端点**租约**：心跳超此值视为陈旧（死端点，GC/拒绝拨号）。 */
  leaseTtlMs?: number
  /** local-listen 心跳间隔（ms；≤0 关闭）。 */
  heartbeatMs?: number
  /** local-listen **握手令牌**：两端一致才接受拨入（缺省则不校验，仅靠 socket 文件权限）。 */
  listenToken?: string
}

interface OutboundFrame {
  seq: number
  frame: TransportFrame
  tries: number
  /** 最近一次上网时间（ack 超时重发判据）。 */
  lastSentAt: number
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
  /** 对端进程纪元（变化 ⇒ 对端重启，去重窗口复位）。 */
  epoch: string | undefined
  degradedSince: number
  reconnectAttempts: number
}

export class TeamTransportService extends Service implements TeamTransport {
  static Config: z<Config> = z.object({
    backend: z
      .union(['in-process', 'local-child', 'ssh-rpc', 'local-listen'] as const)
      .default('in-process'),
    endpoint: z.string(),
    maxQueue: z.number().step(1).min(1).default(1024),
    maxHistory: z.number().step(1).min(1).default(1024),
    reconnectTimeoutMs: z.number().step(1).min(1).default(15000),
    reconnectIntervalMs: z.number().step(1).min(0).default(1000),
    ackTimeoutMs: z.number().step(1).min(0).default(1000),
    autoReconnect: z.boolean().default(true),
    nodeBin: z.string(),
    childRelayPath: z.string(),
    childCwd: z.string(),
    registryDir: z.string(),
    leaseTtlMs: z.number().step(1).min(1),
    heartbeatMs: z.number().step(1),
    listenToken: z.string(),
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
  private retryTimer: ReturnType<typeof setInterval> | undefined
  private listenServer: LocalListenServer | undefined
  /** 本进程纪元（跨进程去重窗口复位用）。 */
  private readonly epoch = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
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
    let factory: LinkFactory | undefined
    this.effectiveBackend = requested
    if (requested === 'local-listen') {
      // 服务端监听 + 端点注册/发现（P32）
      const dir = this.config.registryDir ?? join(process.cwd(), '.runtime', 'xproc-registry')
      const leaseTtlMs = this.config.leaseTtlMs ?? 30000
      // 启动即清理陈旧端点（死进程/超租约），避免发现僵尸
      gcStaleEndpoints(dir, leaseTtlMs)
      this.listenServer = new LocalListenServer(
        dir,
        this.selfEndpoint,
        (link) => this.acceptInbound(link),
        this.config.listenToken,
        this.config.heartbeatMs ?? 10000,
      )
      await this.listenServer.start()
      factory = new LocalListenDialFactory(
        dir,
        this.selfEndpoint,
        this.config.listenToken,
        leaseTtlMs,
      )
    } else {
      factory = this.makeFactory(requested)
    }
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
    if (this.config.ackTimeoutMs > 0) {
      this.retryTimer = setInterval(
        () => this.scanRetries(),
        Math.max(5, Math.floor(this.config.ackTimeoutMs / 2)),
      )
      ;(this.retryTimer as { unref?: () => void }).unref?.()
    }
    return () => this.dispose()
  }

  private makeFactory(backend: TransportBackend): LinkFactory | undefined {
    if (backend === 'in-process') return new InProcessLinkFactory(this.bus!, this.selfEndpoint)
    if (backend === 'local-listen') return undefined // 由 start() 单独装配（需先起监听服务端）
    if (backend === 'local-child') {
      const seam = this.ctx.get('subprocess') as SubprocessSeam | undefined
      if (!seam?.spawn) return undefined
      const relayPath =
        this.config.childRelayPath ?? fileURLToPath(new URL('../relay/relay.mjs', import.meta.url))
      return new ChildProcessLinkFactory(
        seam,
        this.config.nodeBin ?? 'node',
        relayPath,
        this.config.childCwd ?? process.cwd(),
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
    const out: OutboundFrame = { seq, frame, tries: 0, lastSentAt: 0 }
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
      epoch: undefined,
      degradedSince: Date.now(),
      reconnectAttempts: 0,
    }
  }

  /** ack 超时重发：对未确认帧按节拍重发（spec §3.2 退避重试），保证链路丢帧可收敛。 */
  private scanRetries(): void {
    const now = Date.now()
    const timeout = this.config.ackTimeoutMs
    if (timeout <= 0) return
    for (const peer of this.peerMap.values()) {
      if (peer.state !== 'connected' || !peer.link) continue
      for (const out of [...peer.outbound]) {
        if (now - out.lastSentAt >= timeout) this.transmit(peer, out, 'retry')
      }
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

  private transmit(peer: PeerRecord, out: OutboundFrame, mode: 'first' | 'replay' | 'retry'): void {
    if (!peer.link) return
    try {
      peer.link.send({ t: 'app', seq: out.seq, epoch: this.epoch, frame: out.frame })
    } catch (e) {
      this.ctx.logger?.warn?.('team-transport: transmit failed: %s', String(e))
      return
    }
    out.tries++
    out.lastSentAt = Date.now()
    this.counters.sent++
    if (mode === 'replay') {
      this.counters.replayed++
      this.counters.retried++
    } else if (mode === 'retry') {
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
    // 对端重启（epoch 变）⇒ 其 seq 空间重置：复位去重窗口，避免把新帧当重复丢弃
    if (msg.epoch && msg.epoch !== peer.epoch) {
      peer.epoch = msg.epoch
      peer.sinceSeq = 0
      peer.seenInbound.clear()
    }
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
    if (this.retryTimer) {
      clearInterval(this.retryTimer)
      this.retryTimer = undefined
    }
    for (const peer of this.peerMap.values()) {
      peer.link?.close()
      peer.link = undefined
      peer.outbound.length = 0
      peer.history.length = 0
    }
    this.factory?.dispose()
    this.factory = undefined
    this.listenServer?.dispose()
    this.listenServer = undefined
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
    ackTimeoutMs: 1000,
    autoReconnect: true,
  }
}

export default TeamTransportService
