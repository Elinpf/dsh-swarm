#!/usr/bin/env node
/**
 * team-transport 的 **out-of-process 对端（真实子进程 relay）**。
 *
 * 父进程用 local-child 后端 spawn 本脚本，stdin/stdout 走 JSONL 的 `WireFrame`。
 * 语义与父进程 transport 的「对端」一致，用于在**真实父子进程**上验证 V1–V4：
 *   - `app`：按 `seq` 幂等去重 → 一律回 `ack`；**非重复**才回声一条本端 app 帧
 *     （重复只 ack 不回声 ⇒ 保证「不重」）；回声用于观测「子→父」方向链路。
 *   - `ack`：从本端未确认历史中摘除该 seq。
 *   - `sync-req(sinceSeq)`：重放本端历史中 `seq > sinceSeq` 的帧，再回 `sync-resp`
 *     （⇒ 父进程重连时增量补齐「不丢」）。
 *
 * 故障注入（仅测试用，经环境变量；默认关闭）：
 *   - `RELAY_DROP_ACKS=N`   前 N 条 ack 不发出（模拟 ack 丢失 → 父进程重发 → 本端去重）
 *   - `RELAY_DROP_ECHOES=N` 前 N 条回声不即时发出（模拟帧丢失 → 重发定时器补齐）
 *   - `RELAY_ACK_TIMEOUT_MS` 未确认帧重发节拍（默认 50ms；0 关闭）
 *
 * 本脚本刻意只依赖 line-JSON，不 import 父进程实现，保证它是**真正独立进程**。
 */
const MAX_HISTORY = 4096

const epoch = `relay-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
// 故障注入既可经环境变量、也可经 argv（argv 便于跨 SSH 传递，SSH 默认不透传本地 env）：
//   node relay.mjs <endpoint> [dropAcks] [dropEchoes] [ackTimeoutMs]
const argv = process.argv.slice(2)
const ackTimeoutMs = Number(process.env.RELAY_ACK_TIMEOUT_MS ?? argv[4] ?? 50)
let dropAcks = Number(process.env.RELAY_DROP_ACKS ?? argv[2] ?? 0)
let dropEchoes = Number(process.env.RELAY_DROP_ECHOES ?? argv[3] ?? 0)

let nextSeq = 1
let sinceSeqIn = 0
/** 父进程已发的 app seq（幂等去重）。 */
const seenIn = new Set()
/** 本端已发未 ack 的 app 帧（重放集合 = queued-minus-acked）。 */
const history = []
let buffer = ''

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function sendAck(seq) {
  if (dropAcks > 0) {
    dropAcks-- // 注入：本条 ack 丢失
    return
  }
  send({ t: 'ack', ackSeq: seq })
}

function onLine(line) {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return // 坏帧丢弃，不炸链路
  }
  switch (m.t) {
    case 'app': {
      const seq = m.seq ?? 0
      const dup = seq > 0 && (seenIn.has(seq) || seq <= sinceSeqIn)
      if (dup) {
        sendAck(seq) // 重复：只 ack，不再次回声
        return
      }
      if (seq > 0) {
        seenIn.add(seq)
        if (seq > sinceSeqIn) sinceSeqIn = seq
      }
      sendAck(seq)
      const out = { t: 'app', seq: nextSeq++, epoch, frame: m.frame }
      history.push(out)
      while (history.length > MAX_HISTORY) history.shift()
      if (dropEchoes > 0) {
        dropEchoes-- // 注入：本条回声丢失（仍在 history，等重发）
      } else {
        send(out)
      }
      break
    }
    case 'ack': {
      const i = history.findIndex((o) => o.seq === m.ackSeq)
      if (i >= 0) history.splice(i, 1)
      break
    }
    case 'sync-req': {
      const s = m.sinceSeq ?? 0
      for (const o of history) if (o.seq > s) send(o)
      send({ t: 'sync-resp' })
      break
    }
    default:
      break
  }
}

// 重发定时器：本端未确认帧按节拍重发（父进程按 seq 去重）
if (ackTimeoutMs > 0) {
  const timer = setInterval(() => {
    for (const o of [...history]) send(o)
  }, ackTimeoutMs)
  timer.unref?.()
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line) onLine(line)
  }
})
process.stdin.on('end', () => process.exit(0))
