#!/usr/bin/env node
/**
 * team-transport-xproc.mjs — 跨**真实 OS 进程**的 team-transport 端到端验证。
 *
 * 目的：把 P15 只在「内存双工 mock」上验过的投递语义，搬到**真实进程边界**上重验——
 *   - 主角是**真实产品代码** `TeamTransportService`（import 自 `packages/team-transport/lib`）；
 *   - 链路是**真实** `ctx.subprocess`（`@deepseek-ai/dsh-subprocess-local`）spawn 出的**真实子进程** + 真实 stdio 管道；
 *   - 对端默认是**产品自带的真实对端** `packages/team-transport/relay/relay.mjs`；
 *     确定性注入场景另用 `team-transport-xproc-peer.mjs`（协议探针，同协议、真实进程）；
 *   - 「断线」是**真实杀掉子进程**再拉起（不是同实例注入）。
 *
 * 覆盖：V1 丢 ack→真断线→重连重放→终态补齐；V2 重复帧→接收端恰好一次；
 *       V4 断线→degraded→重连→sinceSeq 增量补齐；有界队列 queueDropped。
 *
 * 运行：node scripts/team-transport-xproc.mjs
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import TeamTransportService from '../packages/team-transport/lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PROBE = resolve(HERE, 'team-transport-xproc-peer.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 真实 ctx.subprocess → transport 的 SubprocessSeam 适配器 ───────────────────
// transport 现在按 0.2.1-rc.3 实测形状直接吃 SubprocessHandle；适配器只做两件事：
//   1) 把注入用环境变量显式传给子进程（transport 自己不带 env）；
//   2) 记录 handle 以便「真断线」时 terminate。
function makeAdapter(ctx, envForAttempt) {
  const handles = []
  let attempt = 0
  return {
    handles,
    async resolveExecutable(name) {
      return ctx.subprocess.resolveExecutable(name)
    },
    spawn(spec) {
      attempt++
      const env = {
        ...(envForAttempt ? envForAttempt(attempt) : {}),
        PEER_ATTEMPT: String(attempt),
      }
      const h = ctx.subprocess.spawn({
        argv: spec.argv,
        cwd: spec.cwd,
        stdio: spec.stdio,
        graceMs: spec.graceMs,
        env,
      })
      handles.push(h)
      return h
    },
  }
}

function mkCtx(subprocessSeam) {
  const warns = []
  const events = []
  const registered = { subprocess: subprocessSeam }
  const ctx = {
    logger: { debug() {}, info() {}, warn: (...a) => warns.push(a.map(String).join(' ')) },
    reflect: { provide: (n, v) => (registered[n] = v) },
    get: (n) => registered[n],
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    emit: (name, payload) => events.push({ name, payload }),
  }
  return { ctx, warns, events }
}

function mkTransport(ctx, opts = {}) {
  return new TeamTransportService(ctx, {
    backend: 'local-child',
    endpoint: 'A',
    maxQueue: opts.maxQueue ?? 16,
    maxHistory: 16,
    reconnectTimeoutMs: 800,
    reconnectIntervalMs: 0,
    ackTimeoutMs: opts.ackTimeoutMs ?? 60,
    autoReconnect: false,
    nodeBin: 'node',
    childRelayPath: opts.relayPath, // undefined → 产品自带 relay/relay.mjs
    childCwd: REPO_ROOT,
  })
}

async function waitFor(fn, timeout = 5000, step = 15) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fn()) return true
    await sleep(step)
  }
  return false
}

const frame = (n) => ({ kind: 'mutation', teamId: 'x', payload: { n } })

const results = []
async function scenario(name, fn) {
  process.stdout.write(`\n===== ${name} =====\n`)
  try {
    const r = await fn()
    results.push({ name, ...r })
    process.stdout.write(`[RESULT] ${JSON.stringify({ name, ...r })}\n`)
  } catch (e) {
    results.push({ name, error: String(e) })
    process.stdout.write(`[ERROR] ${name}: ${String(e)}\n`)
  }
}

const baseCtx = new Context()
await baseCtx.plugin(SubprocessLocal)
process.stdout.write(
  `[env] real ctx.subprocess: spawn=${typeof baseCtx.subprocess
    ?.spawn} resolveExecutable=${typeof baseCtx.subprocess?.resolveExecutable}\n`,
)

// ── V1：丢 ack → 真断线 → 重连重放 → 终态补齐（真实 relay，不丢）──────────────
await scenario('V1 真实 relay 不丢：丢 ack→真杀进程→重连重放→终态全 ack', async () => {
  const seam = makeAdapter(baseCtx, (n) => (n === 1 ? { RELAY_DROP_ACKS: '999' } : {}))
  const { ctx, events } = mkCtx(seam)
  const t = mkTransport(ctx) // 默认产品 relay
  await t.send('peer-1', frame(1))
  await t.send('peer-1', frame(2))
  await t.send('peer-1', frame(3))
  await waitFor(() => t.peers()[0]?.state === 'connected')
  await waitFor(() => t.peers()[0]?.sinceSeq >= 1) // relay 已回声 → 子→父链路通
  await sleep(120)
  const before = { acked: t.stats().acked, pending: t.peers()[0]?.pending }
  seam.handles.at(-1).terminate() // 真断线
  await waitFor(() => t.peers()[0]?.state === 'degraded')
  const degraded = t.peers()[0]?.state
  await t.reconnect('peer-1')
  await waitFor(() => t.stats().acked >= 3)
  const after = {
    acked: t.stats().acked,
    pending: t.peers()[0]?.pending,
    replayed: t.stats().replayed,
  }
  const states = events.filter((e) => e.name === 'swarm/transport/peer').map((e) => e.payload.state)
  t.dispose()
  return {
    stateAfterKill: degraded,
    before,
    after,
    stateTransitions: states,
    pass:
      before.acked === 0 &&
      degraded === 'degraded' &&
      after.acked === 3 &&
      after.pending === 0 &&
      after.replayed >= 1,
  }
})

// ── 有界队列：未 ack 超上界 → 丢最旧 + 计数（真实 relay，不隐式丢）────────────
await scenario(
  '有界队列：真实 relay 不回 ack，maxQueue=3 连发 5 → queueDropped=2, pending=3',
  async () => {
    const seam = makeAdapter(baseCtx, () => ({ RELAY_DROP_ACKS: '9999' }))
    const { ctx } = mkCtx(seam)
    const t = mkTransport(ctx, { maxQueue: 3 })
    for (let i = 1; i <= 5; i++) await t.send('peer-1', frame(i))
    await waitFor(() => t.peers()[0]?.state === 'connected')
    await sleep(150)
    const stats = t.stats()
    const peer = t.peers()[0]
    t.dispose()
    return {
      queueDropped: stats.queueDropped,
      pending: peer?.pending,
      pass: stats.queueDropped === 2 && peer?.pending === 3,
    }
  },
)

// ── V2：重复帧 → 接收端恰好一次（探针确定性注入）─────────────────────────────
await scenario('V2 不重：对端重复发 seq=1 → 接收端幂等去重恰好一次', async () => {
  const seam = makeAdapter(baseCtx, () => ({
    PEER_CFG: JSON.stringify({ emitStart: 2, dupStart: 1 }),
  }))
  const { ctx } = mkCtx(seam)
  const t = mkTransport(ctx, { relayPath: PROBE })
  const seen = []
  t.onFrame((pid, f) => seen.push(f.seq ?? f.payload?.peerSeq))
  await t.send('peer-1', frame(1))
  await waitFor(() => seen.length >= 2)
  await sleep(150)
  const stats = t.stats()
  t.dispose()
  return {
    distinctSeqs: [...new Set(seen)].sort((a, b) => a - b),
    frameCount: seen.length,
    dedupDropped: stats.dedupDropped,
    pass: seen.length === 2 && stats.dedupDropped >= 1,
  }
})

// ── V4：断线 → degraded → 重连 → sinceSeq 增量补齐（探针模拟对端保留历史）──────
await scenario('V4 断线重连：重连后按 sinceSeq 增量补齐', async () => {
  const seam = makeAdapter(baseCtx, () => ({
    PEER_CFG: JSON.stringify({
      byAttempt: { 1: { historyLen: 5, emitStart: 5 }, 2: { historyLen: 8, emitStart: 0 } },
    }),
  }))
  const { ctx, events } = mkCtx(seam)
  const t = mkTransport(ctx, { relayPath: PROBE })
  const seen = new Set()
  t.onFrame((pid, f) => seen.add(f.seq ?? f.payload?.peerSeq))
  await t.send('peer-1', frame(1))
  await waitFor(() => t.peers()[0]?.sinceSeq >= 5)
  const sinceBefore = t.peers()[0]?.sinceSeq
  seam.handles.at(-1).terminate()
  await waitFor(() => t.peers()[0]?.state === 'degraded')
  const states = events.filter((e) => e.name === 'swarm/transport/peer').map((e) => e.payload.state)
  await t.reconnect('peer-1')
  await waitFor(() => t.peers()[0]?.sinceSeq >= 8)
  const sinceAfter = t.peers()[0]?.sinceSeq
  t.dispose()
  return {
    sinceBefore,
    sinceAfter,
    distinctFrames: [...seen].sort((a, b) => a - b),
    stateTransitions: states,
    pass: sinceBefore >= 5 && sinceAfter >= 8,
  }
})

const allPass = results.every((r) => r.pass === true)
process.stdout.write(`\n===== SUMMARY =====\n`)
process.stdout.write(JSON.stringify(results, null, 2) + '\n')
process.stdout.write(
  `\n[${allPass ? 'PASS' : 'FAIL'}] 跨进程 xproc 验证：${results.filter((r) => r.pass).length}/${
    results.length
  }\n`,
)
await baseCtx.stop?.()
process.exit(allPass ? 0 : 1)
