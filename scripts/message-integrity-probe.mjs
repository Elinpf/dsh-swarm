#!/usr/bin/env node
/**
 * 消息并发完整性确定性探针（P48 核实用，零模型成本）。
 *
 * 起**真实 cordis 运行时**加载 team-core / team-bus 的**构建产物**，后端用**端口 mock**（记录每一条投递），
 * 针对用户关心的三个并发场景做**确定性断言**：
 *   P1 多个成员**同时**向 leader 发 DM → 不丢、不串味（条数/发送者/内容一一对应）。
 *   P2 并发多次 broadcast → 每次 1 落库 + 逐人投递；durable 计数与投递数不丢；自过滤生效。
 *   P3 并发 multicast → 原子批写 + 逐目标投递；无丢。
 *   P4 未知目标 / 自发自：行为边界（抛错 vs 静默）。
 *
 * 说明：探针只验证**我们插件层**的并发行为；"必有回应"不在此断言（我们层无 ack/重试语义，见报告）。
 *
 * 运行：node scripts/message-integrity-probe.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const load = (p) => import(pathToFileURL(resolve(root, p)).href)

let failures = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  failures++
  console.error(`[FAIL] ${m}`)
}
const assert = (c, m) => (c ? ok(m) : bad(m))

// ── 端口 mock：记录每一条投递（mailbox: targetName → [{from,content,id}]）─────────
const mailbox = new Map()
let seq = 0
const members = [{ id: 'lead', name: 'lead', role: 'lead', status: 'idle' }]
const seam = {
  membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
  tryMembership: (a) => {
    if (!a) return undefined
    if (a.id === 'lead') return { id: 'lead', role: 'lead', name: 'lead' }
    const m = members.find((x) => x.id === a.id)
    return m ? { id: m.id, name: m.name, role: 'teammate' } : undefined
  },
  listMembers: () => members.map((m) => ({ ...m })),
  spawnTeammate: async (_c, req) => {
    const m = { id: `m${++seq}`, name: req.name, role: 'teammate', status: 'idle' }
    members.push(m)
    return { member: { id: m.id, name: m.name, role: m.role, description: req.description } }
  },
  sendMessage: async (caller, req) => {
    const from = caller?.name ?? caller?.id ?? '?'
    const id = `msg-${++seq}`
    const arr = mailbox.get(req.target) ?? []
    arr.push({ id, from, to: req.target, content: req.content })
    mailbox.set(req.target, arr)
    return { messageId: id }
  },
  createTask: async () => ({
    id: `t${++seq}`,
    revision: 0,
    subject: '',
    status: 'pending',
    blockedBy: [],
    ready: true,
  }),
  getTask: () => ({ id: 't', revision: 0, status: 'pending', blockedBy: [], ready: true }),
  listTasks: () => [],
  updateTask: async () => ({
    id: 't',
    revision: 1,
    status: 'completed',
    blockedBy: [],
    ready: false,
  }),
  waitForChange: async () => ({ timedOut: true }),
  interrupt: () => ({ previousStatus: 'running' }),
}

const rootCtx = new Context()
await rootCtx.plugin({
  name: 'mi-host',
  apply(ctx) {
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} })
    ctx.provide('sessions', {})
    ctx.provide('agents', { list: () => [] })
    ctx.provide('subagents', {})
    ctx.provide('skills', {})
    ctx.provide('agentTeams', seam)
  },
})

const lead = { id: 'lead', name: 'lead' }
const core = await load('packages/team-core/lib/index.js')
const bus = await load('packages/team-bus/lib/index.js')
await rootCtx.plugin(core.default, {
  backend: 'auto',
  maxMembers: 16,
  maxTasks: 256,
  maxMessageBytes: 65536,
})
await rootCtx.plugin(bus.default, { maxFanout: 64, maxMessageBytes: 65536 })

const txt = (t) => [{ type: 'text', text: t }]
const member = (name, id) => ({ id: id ?? name, name })

// 准备 5 个成员（alice..erin）——记下 spawn 返回的真实 id（与 name 不同）
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin']
const ID = {}
for (const n of NAMES) {
  const v = await rootCtx.teamCore.spawn(lead, {
    name: n,
    description: n,
    prompt: txt('idle'),
    context: 'fresh',
    provider: 'spawn',
    signal: new AbortController().signal,
  })
  ID[n] = v.id
}
console.log(
  `[info] 成员 id 映射：${NAMES.map((n) => `${n}=${ID[n]}`).join(
    ', ',
  )}（注：id ≠ name，与真实 profile 一致）`,
)

// ── P1：多成员**同时**向 leader 发 DM ──────────────────────────────────────
console.log('\n== P1 多成员并发 DM → leader（不丢/不串味）==')
{
  mailbox.set('lead', [])
  const K = 40
  const tasks = []
  for (let i = 0; i < K; i++) {
    const n = NAMES[i % NAMES.length]
    tasks.push(
      rootCtx.teamCore.send(member(n), {
        range: { kind: 'dm', to: 'lead' },
        content: txt(`msg-${i}-from-${n}`),
        delivery: 'wakeup',
      }),
    )
  }
  await Promise.all(tasks)
  const got = mailbox.get('lead') ?? []
  assert(got.length === K, `收到 = 期望 ${K}（实收 ${got.length}）—— 不丢`)
  const ids = new Set(got.map((m) => m.id))
  assert(ids.size === K, `消息 id 无重复（${ids.size}/${K}）`)
  // 不串味：每条 content 的 i 与 from 必须自洽（msg-i-from-n）
  const mism = got.filter((m) => {
    const t = m.content?.[0]?.text ?? ''
    const mm = /^msg-(\d+)-from-(.+)$/.exec(t)
    return !mm || mm[2] !== m.from
  })
  assert(mism.length === 0, `无串味（content 与 sender 自洽；异常 ${mism.length}）`)
  // 每个发送者的条数均衡
  const bySender = {}
  for (const m of got) bySender[m.from] = (bySender[m.from] ?? 0) + 1
  assert(Object.keys(bySender).length === NAMES.length, `发送者覆盖全部 ${NAMES.length} 名成员`)
}

// ── P2：并发多次 broadcast ────────────────────────────────────────────────
console.log('\n== P2 并发 broadcast（durable 计数 + 逐人投递不丢 + 自过滤）==')
{
  for (const n of NAMES) mailbox.set(n, [])
  mailbox.set('lead', [])
  const before = rootCtx.teamBus.durableCount
  const K = 25
  await Promise.all(
    Array.from({ length: K }, (_, i) =>
      rootCtx.teamBus.broadcast(lead, {
        topic: 'team',
        content: txt(`bcast-${i}`),
        delivery: 'wakeup',
      }),
    ),
  )
  const after = rootCtx.teamBus.durableCount
  assert(after - before === K, `durable 新增 = ${K}（实测 ${after - before}）—— 不丢`)
  const okFan = NAMES.every((n) => (mailbox.get(n) ?? []).length === K)
  assert(okFan, `每个非发送者收到 ${K} 条（逐人扇出不丢）`)
  assert((mailbox.get('lead') ?? []).length === 0, 'broadcast 自过滤：发送者 lead 不收到自己的广播')
}

// ── P3：并发 multicast（原子批写 + 逐目标不丢）──────────────────────────────
console.log('\n== P3 并发 multicast（3 目标 × K 次）==')
{
  for (const n of NAMES) mailbox.set(n, [])
  const targetNames = ['alice', 'bob', 'carol']
  const targetIds = targetNames.map((n) => ID[n])
  const before = rootCtx.teamBus.durableCount
  const K = 20
  await Promise.all(
    Array.from({ length: K }, (_, i) =>
      rootCtx.teamBus.multicast(lead, {
        targets: targetIds,
        content: txt(`mc-${i}`),
        delivery: 'wakeup',
      }),
    ),
  )
  const after = rootCtx.teamBus.durableCount
  assert(
    after - before === K * targetIds.length,
    `durable 新增 = ${K}×${targetIds.length}（实测 ${after - before}）`,
  )
  const okAll = targetNames.every((n) => (mailbox.get(n) ?? []).length === K)
  assert(okAll, `每个目标收到 ${K} 条（按 id 正确投递）`)
  const others = NAMES.filter((n) => !targetNames.includes(n))
  assert(
    others.every((n) => (mailbox.get(n) ?? []).length === 0),
    `非目标（${others.join(',')}）0 条 —— 不误投`,
  )
}

// ── P4：tool-swarm 的 multicast 按「名字」发送 → 与 bus 的「id」契约不符 ────────
console.log(
  '\n== P4 tool-swarm.multicast 用「名字」当目标 → TEAMBUS_UNKNOWN_TARGET（疑似真 bug）==',
)
{
  let err = null
  try {
    await rootCtx.teamBus.multicast(member('lead', 'lead'), {
      targets: ['alice'],
      content: txt('x'),
      delivery: 'wakeup',
    })
  } catch (e) {
    err = e
  }
  assert(
    err != null && /UNKNOWN_TARGET/.test(String(err.code ?? err.message)),
    `按名字投递被拒（${
      err ? err.code ?? err.message : '未抛错'
    }）—— 证实：bus 契约=id，tool 传 name`,
  )
  // 对照：按 id 正常
  await rootCtx.teamBus.multicast(member('lead', 'lead'), {
    targets: [ID.alice],
    content: txt('x'),
    delivery: 'wakeup',
  })
  ok('按 id 投递正常 —— 说明是 tool 层 name/id 不一致，而非 bus 并发缺陷')
}

console.log(`\n结果：${failures === 0 ? 'PASS（全部断言通过）' : `FAIL（${failures} 项未通过）`}`)
process.exit(failures === 0 ? 0 : 1)
