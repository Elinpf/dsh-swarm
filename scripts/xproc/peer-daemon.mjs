#!/usr/bin/env node
/**
 * 对端进程守护（P29 · 对端入站 attach 的真机对端）。
 *
 * 这是一个**独立 node 进程**：在 stdin/stdout 上以 JSONL `WireFrame` 通信，
 * 并把入站帧**接进本进程真实的 `team-distributed` 运行时**（`attachTransport` 的消费面），
 * 从而证明「另一个进程各自跑本栈、能真实消费对方投递」——而非只在传输层回声。
 *
 * 协议（最小）：
 *   - 收到 `{t:'app', seq, frame}` → 回 `{t:'ack', ackSeq:seq}`，并把 `frame` 交给
 *     本地运行时（`onInboundMessage` 消费 → 追加到 `PEER_SINK` 文件）。
 *   - `{t:'sync-req', sinceSeq}` → 回 `{t:'sync-resp'}`。
 *
 * 环境：`PEER_SINK` = 消费记录落盘路径。
 */
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../../packages/team-distributed/lib/index.js', import.meta.url))
const sinkPath = process.env.PEER_SINK ?? ''

const { default: TeamDistributedService } = await import(DIST)

// 本进程内的「团队运行时」：一个真实的 TeamDistributedService + 最小 transport 面。
const handlers = []
const transport = {
  async send() {
    return { seq: 0 }
  },
  peers() {
    return []
  },
  onFrame(h) {
    handlers.push(h)
    return () => {}
  },
}
const registered = {
  teamCore: {
    listMembers: () => [],
    listTasks: () => [],
  },
  teamTransport: transport,
}
const ctx = {
  logger: { debug() {}, info() {}, warn() {} },
  reflect: { provide() {} },
  get: (n) => registered[n],
  effect: (fn) => fn(),
  emit() {},
}

const svc = new TeamDistributedService(ctx, { role: 'follower', deliveryTtlMs: 30000 })
svc.onInboundMessage((m) => {
  if (sinkPath) appendFileSync(sinkPath, `${JSON.stringify(m)}\n`)
})
// 构造时已 attach；这里再显式 attach 一次以确保订阅（幂等）
svc.attachTransport()

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.t === 'app') {
      send({ t: 'ack', ackSeq: m.seq })
      // 关键：入站帧接进本地运行时（消费者面）
      for (const h of handlers) h('leader', m.frame)
    } else if (m.t === 'sync-req') {
      send({ t: 'sync-resp' })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
