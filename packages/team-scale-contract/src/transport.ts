/**
 * 阶段 3 · 跨进程传输端口类型（`ctx.teamTransport`）。
 *
 * 语义定调（对齐 spec §3）：DSH 的 `ctx.ssh`/`ctx.subprocess` 只提供**非重连**的底层连接，
 * 因此重连、重放、幂等去重的**投递语义由本端口自建**，且必须可被证伪（见实现包的 V1–V4 验证）。
 *
 * @module @elinpf/dsh-swarm-team-scale-contract
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamTransport: TeamTransport
  }
}

/** 传输后端：单进程零开销 / 同机子进程 stdio / 跨机 SSH-RPC。 */
export type TransportBackend = 'in-process' | 'local-child' | 'ssh-rpc'

/**
 * 断线重连状态机（spec §3.3）：
 * `connected → degraded(等待重连) → resyncing(拉增量+重放) → connected`；重连超时 → `unreachable`。
 * 降级时**入队待发帧（有界）**，绝不静默丢消息。
 */
export type PeerState = 'connected' | 'degraded' | 'resyncing' | 'unreachable'

/** 帧种类：应用帧（mutation/event）、确认（ack）、增量同步（sync）。 */
export type TransportFrameKind = 'mutation' | 'event' | 'ack' | 'sync'

export interface TransportFrame {
  kind: TransportFrameKind
  teamId: string
  /** 单调发送序号（由发送端分配；接收端据此幂等去重与增量补齐）。 */
  seq?: number
  payload: unknown
}

export interface PeerStatus {
  peerId: string
  /** 实际生效的后端（可能因可用性回落，见 spec §4.2 失败降级）。 */
  backend: TransportBackend
  state: PeerState
  /** 已从该 peer 连续收到的最大入站 seq（重连时据此拉增量）。 */
  sinceSeq: number
  /** 待发（未 ack）帧数。 */
  pending: number
}

/** 投递可观测计数器（spec §3.4）。 */
export interface TransportStats {
  /** 已交给链路的帧数（含重试）。 */
  sent: number
  /** 已收到 ack 的帧数。 */
  acked: number
  /** 重试次数。 */
  retried: number
  /** 因重复（seq 已见过）被丢弃的入站帧数。 */
  dedupDropped: number
  /** 重连后重放的帧数。 */
  replayed: number
  /** 因重连超时被判不可达的 peer 次数。 */
  unreachable: number
}

export interface TeamTransport {
  /** 启动某后端；返回 disposer（关闭连接与队列）。 */
  start(cfg: { backend: TransportBackend; endpoint?: string }): Promise<() => void>
  /** 发送（帧级）；返回分配的单调 seq。ack 异步到达，经 `stats().acked` 观测。 */
  send(peerId: string, frame: TransportFrame): Promise<{ seq: number }>
  /** 订阅入站应用帧。 */
  onFrame(handler: (peerId: string, frame: TransportFrame) => void): () => void
  peers(): PeerStatus[]
  /** 重连与重放（spec §3.3）：拉 sinceSeq 增量 + 重放 queued-minus-acked。 */
  reconnect(peerId: string): Promise<void>
  /** 观测计数器。 */
  stats(): TransportStats
}
