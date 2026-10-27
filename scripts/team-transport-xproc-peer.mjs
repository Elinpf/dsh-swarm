#!/usr/bin/env node
/**
 * team-transport-xproc-peer.mjs — **真实 OS 进程**上的确定性故障注入线协议探针。
 *
 * 位置说明：除了产品自带的 `packages/team-transport/relay/relay.mjs`（真实对端）之外，
 * 本探针用于**确定性注入**产品 relay 不易构造的场景（重复帧、跨重启保留历史的增量补齐）。
 * 它讲同一套 `WireFrame` JSONL 协议，跑在真实子进程里。
 *
 * 配置经**环境变量**传入（transport 自己拼 argv，只传 endpoint）：
 *   PEER_CFG      JSON 配置
 *   PEER_ATTEMPT  spawn 序号（1,2,...）
 *
 * cfg 字段：
 *   historyLen, emitStart, dupStart, dropAck[], applyDropAttempts[], dropAckAll, byAttempt{}
 */

const rawCfg = JSON.parse(process.env.PEER_CFG || '{}')
const attempt = Number(process.env.PEER_ATTEMPT || '1')
const cfg = { ...rawCfg, ...(rawCfg.byAttempt?.[String(attempt)] || {}) }

const write = (o) => process.stdout.write(JSON.stringify(o) + '\n')

const history = []
let recvApp = 0
let acksSent = 0
let acksSuppressed = 0
let replayed = 0
let dupSent = 0
let syncReqs = 0

const pushHistory = (seq) => {
  const frame = { kind: 'event', teamId: 'x', seq, payload: { peerSeq: seq } }
  if (!history.some((h) => h.seq === seq)) history.push({ seq, frame })
  return frame
}

for (let s = 1; s <= (cfg.historyLen ?? 0); s++) pushHistory(s)

for (let s = 1; s <= (cfg.emitStart ?? 0); s++) {
  const frame = pushHistory(s)
  write({ t: 'app', seq: s, frame })
  if (cfg.dupStart && s <= cfg.dupStart) {
    write({ t: 'app', seq: s, frame })
    dupSent++
  }
}

const dropThisAttempt = !cfg.applyDropAttempts || cfg.applyDropAttempts.includes(attempt)
const dropAck = new Set(cfg.dropAck || [])

process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.t === 'app') {
      recvApp++
      if (cfg.dropAckAll || (dropThisAttempt && dropAck.has(m.seq))) {
        acksSuppressed++
      } else {
        write({ t: 'ack', ackSeq: m.seq })
        acksSent++
      }
    } else if (m.t === 'sync-req') {
      syncReqs++
      const since = m.sinceSeq ?? 0
      for (const h of history) {
        if (h.seq > since) {
          write({ t: 'app', seq: h.seq, frame: h.frame })
          replayed++
        }
      }
      write({ t: 'sync-resp' })
    }
  }
})

const snapshot = () => ({ attempt, recvApp, acksSent, acksSuppressed, replayed, dupSent, syncReqs })
const timer = setInterval(() => console.error('[peer] ' + JSON.stringify(snapshot())), 1500)
timer.unref?.()

const shutdown = () => {
  console.error('[peer:exit] ' + JSON.stringify(snapshot()))
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.on('close', shutdown)
