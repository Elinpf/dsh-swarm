#!/usr/bin/env node
/**
 * 进程内集成冒烟（`pnpm verify:e2e`）。
 *
 * 起**真实 cordis 运行时**，把 team-core / team-bus / team-review / team-completion / tool-swarm
 * 一起加载，跑通端到端链路：**创建成员 → 消息投递 → 任务流转 → 评审放行 → 完成判定**。
 *
 * 后端用**端口 mock**（模拟 `ctx.agentTeams` 的结构），因此本脚本验证的是**插件间的装配与协作链路**，
 * 不含模型驱动与真实持久化——那需要 profile 级联调（完整 dsh-base + 实验包 + 可用模型端点），
 * 见 docs/verification.md 的「边界」说明。
 */
import { Context } from '@deepseek-ai/cordis'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let failures = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  failures++
  console.error(`[FAIL] ${m}`)
}
const assert = (c, m) => (c ? ok(m) : bad(m))

const load = (p) => import(pathToFileURL(resolve(root, p)).href)

// ── 端口 mock：模拟 ctx.agentTeams 的结构与状态 ─────────────────────────────
const members = [{ id: 'lead', name: 'lead', role: 'lead', status: 'idle' }]
const tasks = []
const sent = []
let seq = 0

const seam = {
  membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
  tryMembership: (a) => {
    if (a?.id === 'lead') return { id: 'lead', role: 'lead', name: 'lead' }
    const m = members.find((x) => x.id === a?.id)
    return m ? { id: m.id, name: m.name, role: 'teammate' } : undefined
  },
  listMembers: () => members.map((m) => ({ ...m })),
  spawnTeammate: async (_c, req) => {
    const m = { id: `m${++seq}`, name: req.name, role: 'teammate', status: 'idle' }
    members.push(m)
    return { member: { id: m.id, name: m.name, role: m.role, description: req.description } }
  },
  sendMessage: async (_c, req) => {
    sent.push({ target: req.target })
    return { messageId: `msg${sent.length}` }
  },
  createTask: async (_c, req) => {
    const t = {
      id: `t${++seq}`,
      revision: 0,
      subject: req.subject,
      description: req.description,
      status: 'pending',
      blockedBy: [],
      ready: true,
    }
    tasks.push(t)
    return { ...t }
  },
  getTask: (_c, id) => ({ ...tasks.find((t) => t.id === id) }),
  listTasks: () => tasks.map((t) => ({ ...t })),
  updateTask: async (_c, req) => {
    const t = tasks.find((x) => x.id === req.taskId)
    if (req.action === 'claim') {
      t.status = 'in_progress'
      t.ownerName = req.owner
      t.ready = false
    } else if (req.action === 'complete') {
      t.status = 'completed'
    }
    t.revision += 1
    return { ...t }
  },
  waitForChange: async () => ({ timedOut: true }),
  interrupt: () => ({ previousStatus: 'running' }),
}

// ── host：准备外部服务（含 agentTeams 端口 mock）────────────────────────────
const rootCtx = new Context()
await rootCtx.plugin({
  name: 'e2e-host',
  apply(ctx) {
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} })
    ctx.provide('sessions', {})
    ctx.provide('agents', { list: () => [] })
    ctx.provide('subagents', {})
    ctx.provide('agentTeams', seam)
  },
})

const lead = { id: 'lead', name: 'lead' }

// ── 按依赖顺序加载插件（inject 会自行编排激活）──────────────────────────────
const core = await load('packages/team-core/lib/index.js')
const bus = await load('packages/team-bus/lib/index.js')
const review = await load('packages/team-review/lib/index.js')
const completion = await load('packages/team-completion/lib/index.js')
const toolSwarm = await load('packages/tool-swarm/lib/index.js')

await rootCtx.plugin(core.default, {
  backend: 'auto',
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
})
await rootCtx.plugin(bus.default, { maxFanout: 64, maxMessageBytes: 65536 })
await rootCtx.plugin(review.default, {
  pools: [{ kind: 'binary', rule: 'veto', roles: ['verifier', 'challenger'] }],
  maxRounds: 3,
  stallTimeoutMs: 1800000,
})
await rootCtx.plugin(completion.default, { blockOnUnread: true })
await rootCtx.plugin(toolSwarm, { enableBroadcast: true, enableReview: true })

assert(
  typeof rootCtx.teamCore === 'object' && rootCtx.teamCore.active,
  'team-core 激活（native 端口）',
)

// ── 1. 创建成员 ─────────────────────────────────────────────────────────────
const member = await rootCtx.teamCore.spawn(lead, {
  name: 'alice',
  description: 'worker',
  prompt: [{ type: 'text', text: 'work' }],
  context: 'fresh',
  provider: 'spawn',
  signal: new AbortController().signal,
})
assert(member.name === 'alice', `创建成员 alice（id=${member.id}）`)
assert(rootCtx.teamCore.listMembers(lead).length === 2, '花名册含 lead + alice')

// ── 2. 消息投递（广播扇出到非发送者）────────────────────────────────────────
sent.length = 0
await rootCtx.teamBus.broadcast(lead, {
  content: [{ type: 'text', text: 'hello team' }],
  delivery: 'wakeup',
})
assert(sent.length === 1 && sent[0].target === 'alice', '广播扇出 1 条到 alice（自过滤 lead）')

// ── 3. 任务流转 ─────────────────────────────────────────────────────────────
const task = await rootCtx.teamCore.createTask(lead, { subject: 'task-1', description: 'do it' })
assert(task.status === 'pending' && task.ready, `任务创建且 ready（id=${task.id}）`)
const claimed = await rootCtx.teamCore.updateTask(lead, {
  taskId: task.id,
  expectedRevision: task.revision,
  action: 'claim',
  owner: 'alice',
})
assert(claimed.status === 'in_progress', '任务认领 → in_progress')

// ── 4. 评审放行（一票否决池，全 pass → completed）───────────────────────────
await rootCtx.teamReview.submitForReview(lead, task.id)
assert(rootCtx.teamReview.inspect(task.id)?.round === 1, '进入评审 round=1')
await rootCtx.teamReview.vote({ id: 'verifier', name: 'verifier' }, task.id, {
  kind: 'binary',
  decision: 'pass',
  role: 'verifier',
})
await rootCtx.teamReview.vote({ id: 'challenger', name: 'challenger' }, task.id, {
  kind: 'binary',
  decision: 'pass',
  role: 'challenger',
})
const verdict = await rootCtx.teamReview.settle(lead, task.id)
assert(verdict.kind === 'pass', '评审裁决 pass')
assert(rootCtx.teamCore.getTask(lead, task.id).status === 'completed', '评审通过 → 任务 completed')

// ── 5. 完成判定（任务全终态 + 成员静止 + 无未读）────────────────────────────
members.forEach((m) => (m.status = 'idle'))
const done = await rootCtx.teamCompletion.evaluate(lead)
assert(done.completed === true, '完成判定 → completed=true')
const done2 = await rootCtx.teamCompletion.evaluate(lead)
assert(done2.completed === true, '重复评估仍 completed（上升沿只发一次事件）')

if (failures === 0) {
  console.log('\n✅ 集成冒烟通过：成员 → 消息 → 任务 → 评审 → 完成 链路打通（端口 mock 后端）。')
} else {
  console.error(`\n❌ 集成冒烟失败：${failures} 项断言未通过。`)
  process.exit(1)
}
