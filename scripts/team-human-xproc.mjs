#!/usr/bin/env node
/**
 * team-human-xproc.mjs — 人类成员席位的**真实**验证（阶段 3 · `ctx.teamHuman`）。
 *
 * 主角是**真实产品代码** `TeamHumanService`（import 自 `packages/team-human/lib`），跑在真实 cordis Context 上。
 * 覆盖任务要求的三点：
 *   1) 入站文本路由（HITT）：`@name`→DM、`@all`→广播、`#...`→Lead、`$name`→另一人类化身；
 *   2) 「需要人类输入 → 阻塞 → 输入后继续」：`ask()` 阻塞等待**一个真实独立进程**给出回答后才返回；
 *   3) 离线不丢：桥离线下出站消息**保留待补投**，席位上线后 `flush()` 补投。
 *
 * 诚实边界（见 docs/profile-e2e-stage3.md §4）：
 *   - `ctx.userQuestions` 是产品 seam（spec §4.4）。Headless profile **未提供**该服务，且真实
 *     `@deepseek-ai/dsh-user-questions` 是 UI/Session 耦合的 `TypertRemoteService`，无法在无 UI 栈时单独装配。
 *     因此这里用「真实独立子进程作为人类」实现 `ask` seam —— 阻塞/输入/继续**跨真实进程边界**。
 *   - `teamCore`/`teamBus`/`teamHumanBridge` 同为产品 seam（薄适配面），此处以记录型 seam 注入并断言其被正确调用。
 *
 * 运行：node scripts/team-human-xproc.mjs
 */

import { spawn } from 'node:child_process'

const { default: TeamHumanService } = await import('../packages/team-human/lib/index.js')

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = []
const log = (k, v) => {
  out.push({ [k]: v })
  process.stdout.write(`[${k}] ${JSON.stringify(v)}\n`)
}

// ── 记录型 seam + 真实“人类”子进程 ──────────────────────────────────────────
const calls = { coreSend: [], busBroadcast: [], bridgeSend: [] }
const seats = new Map()
let online = true

const ctx = {
  logger: { debug() {}, info() {}, warn() {} },
  reflect: { provide: (n, v) => (ctx._s[n] = v) },
  _s: {},
  get(n) {
    return this._s[n]
  },
  effect(fn) {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  emit() {},
}

// 真实独立进程充当“人类”：延迟后把回答写到 stdout
async function realHumanAnswer(answer, delayMs) {
  const script = `setTimeout(()=>{process.stdout.write(${JSON.stringify(
    answer + '\n',
  )})},${delayMs})`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  let buf = ''
  child.stdout.on('data', (d) => (buf += String(d)))
  await new Promise((res) => child.on('exit', res))
  return { answer: buf.trim(), pid: child.pid }
}

ctx.reflect.provide('teamCore', {
  membership: (agent) => (agent?.id === 'lead' ? { role: 'lead', name: 'lead' } : undefined),
  listMembers: () =>
    [...seats.values()].map((s) => ({ id: s.seatId, name: s.name, role: 'human' })),
  addHumanMember: (_caller, spec) => {
    const id = `roster-${spec.name}`
    seats.set(id, { seatId: id, name: spec.name, kind: spec.kind })
    return { id }
  },
  send: async (_caller, req) => {
    calls.coreSend.push(req)
    return { messageId: `m-${calls.coreSend.length}`, status: 'accepted' }
  },
})
ctx.reflect.provide('teamBus', {
  broadcast: async (_caller, req) => {
    calls.busBroadcast.push(req)
    return { messageId: `b-${calls.busBroadcast.length}` }
  },
})
ctx.reflect.provide('teamHumanBridge', {
  isOnline: () => online,
  send: async (seatId, outbound) => {
    calls.bridgeSend.push({ seatId, from: outbound.from })
  },
})
ctx.reflect.provide('userQuestions', {
  ask: async ({ question }) => {
    // 真实子进程回答（阻塞直到外部输入到达）
    const r = await realHumanAnswer('APPROVED:' + question.slice(0, 12), 300)
    return { answer: r.answer }
  },
})

const human = new TeamHumanService(ctx, { leadName: 'lead', retainWhenOffline: true })

// ── 1. 登记人类席位（仅 Lead 可登记）────────────────────────────────────────
const lead = { id: 'lead', name: 'lead' }
const seat = await human.addSeat(lead, { name: 'alice', kind: 'user' })
log('addSeat(alice,user)', { seatId: seat.seatId, name: seat.name, kind: seat.kind })
let forbidden = false
try {
  await human.addSeat({ id: 'bob', name: 'bob' }, { name: 'x', kind: 'user' })
} catch {
  forbidden = true
}
log('addSeat(non-lead) forbidden', forbidden)

// ── 2. 入站文本路由（HITT）──────────────────────────────────────────────────
const routeCases = [
  ['@alice hello there', { target: 'alice', body: 'hello there' }],
  ['@all standup now', { target: 'all', body: 'standup now' }],
  ['#status report', { target: 'lead', body: 'status report' }],
  ['$alice ping', { target: seat.seatId, body: 'ping' }],
  ['just plain text', { target: 'lead', body: 'just plain text' }],
]
const routes = routeCases.map(([text, want]) => {
  const got = human.parseInbound(text)
  return { text, got, want, pass: got.target === want.target && got.body === want.body }
})
log('parseInbound routes', routes)
log(
  'routes all pass',
  routes.every((r) => r.pass),
)

// 实投：@all → 广播；@alice → DM
const r1 = await human.inbound(seat.seatId, '@all all-hands')
const r2 = await human.inbound(seat.seatId, '@alice direct-msg')
log('inbound @all', { r1, busBroadcastCalls: calls.busBroadcast.length })
log('inbound @alice', {
  r2,
  coreSendCalls: calls.coreSend.length,
  lastRange: calls.coreSend.at(-1)?.range,
})

// ── 3. 阻塞询问 → 输入 → 继续（跨真实进程）──────────────────────────────────
const t0 = Date.now()
const askRes = await human.ask(seat.seatId, 'deploy to prod?')
const elapsed = Date.now() - t0
log('ask blocked-then-continued', {
  answer: askRes.answer,
  elapsedMs: elapsed,
  blocked: elapsed >= 250,
  realExternalProcess: true,
})

// ── 4. 离线保留 → 上线补投（不丢）───────────────────────────────────────────
online = false
const d1 = await human.deliver(seat.seatId, [{ type: 'text', text: 'while offline' }])
const pendingBefore = human.pendingCount
online = true
const flushed = await human.flush()
log('offline retention', {
  deliverWhileOffline: d1,
  pendingBefore,
  flushed,
  bridgeSendCalls: calls.bridgeSend.length,
})

human.dispose()

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const pass = {
  seat: seat.kind === 'user',
  forbidden,
  routes: routes.every((r) => r.pass),
  busBroadcast: calls.busBroadcast.length === 1,
  coreDm:
    calls.coreSend.at(-1)?.range?.kind === 'dm' && calls.coreSend.at(-1)?.range?.to === 'alice',
  askBlocked: elapsed >= 250 && askRes.answer.startsWith('APPROVED:'),
  offlineRetained: d1.delivered === false && pendingBefore === 1 && flushed === 1,
}
const allPass = Object.values(pass).every(Boolean)
process.stdout.write(`\n===== SUMMARY =====\n${JSON.stringify({ pass, allPass }, null, 2)}\n`)
process.stdout.write(`\n[${allPass ? 'PASS' : 'FAIL'}] 人类席位验证\n`)
process.exit(allPass ? 0 : 1)
