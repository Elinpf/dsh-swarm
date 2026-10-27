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

// 任务存储 + 忠实建模原生状态机所需的小工具（P34）。
const taskOf = (id) => tasks.find((t) => t.id === id)
const depsDone = (t) => (t.blockedBy ?? []).every((id) => taskOf(id)?.status === 'completed')
const isReady = (t) => t.status === 'pending' && depsDone(t)
const taskView = (t) => ({ ...t, ready: isReady(t) })
const taskErr = (code, m) => Object.assign(new Error(`${code}: ${m}`), { code })

/**
 * ── mock 保真度说明（P34；后来人写断言前必读）──────────────────────────────────
 * 本 mock 模拟 `ctx.agentTeams` 的**结构**（端口 seam），**不是**真实后端。保真度如下：
 *
 * **已忠实建模（可写强断言）**：
 *  - `sendMessage`：记录 `{ target, content }`；真实 seam 另带 `{ signal }`（对断言无意义，不记）。
 *    `range`/`delivery` 由 `team-core.send` 在端口层消化，**不进 native seam**。
 *  - `updateTask`：`claim` / `release` / `complete` / `reopen` / `reassign`(端口 `assign`) / `delete` /
 *    `edit` / `set_dependencies` —— 状态迁移与非法转换**以真实原生实现为基准**（见下「对照」）。
 *  - `createTask` / `getTask` / `listTasks`：建模 `blockedBy` **DAG 依赖 + readiness**
 *    （`ready = pending && blockedBy 全部 completed`，与原生 `projectTaskView`/`taskReady` 一致）。
 *
 * **对照（原生 `@deepseek-ai/dsh-experimental-agent-team` 实测行号）**：`claim`(需 pending+ready→
 *  in_progress+owner) · `release`(需 in_progress→pending, 清 owner) · `complete`(需 in_progress→completed) ·
 *  `reopen`(需 completed→pending, 清 owner) · `reassign`(需 pending/in_progress；owner 空→pending，否则→
 *  in_progress+新 owner) · `delete`(有下游阻塞者则拒) —— 见 `lib/index.js:1288-1360`。
 *
 * **不覆盖 / 仍属「弱断言」（须在真实 profile 或真 seam 验收，勿在此假设）**：
 *  - `waitForChange`：恒 `timedOut:true`（无真实阻塞/事件驱动）。
 *  - `delivery`（quiet/wakeup）语义、广播/多播扇出的真实投递。
 *  - 跨进程 / 持久化 / 崩溃恢复 / footprint。
 *  - `updateTask` 的 **revision CAS 未强制**（原生以 `expectedRevision` 乐观并发；本 mock 只校验动作/状态）。
 *
 * **注意**：`team-core` 的叠加态动作（`submit_review`/`reject_review`/`open_plan`/`plan-*`）由团队端口
 *  自处理、**不经此 mock**；其断言测的是端口行为，不受上面 mock 保真度限制。
 */
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
    sent.push({ target: req.target, content: req.content })
    return { messageId: `msg${sent.length}` }
  },
  createTask: async (_c, req) => {
    const t = {
      id: `t${++seq}`,
      revision: 0,
      subject: req.subject,
      description: req.description,
      status: 'pending',
      blockedBy: req.blockedBy ?? [],
      ownerName: undefined,
    }
    tasks.push(t)
    return taskView(t)
  },
  getTask: (_c, id) => {
    const t = taskOf(id)
    return t ? taskView(t) : undefined
  },
  listTasks: () => tasks.map(taskView),
  // 忠实建模原生任务状态机（对照 `@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1288-1360`）：
  // 非法转换抛**带 code** 的错，与真实一致；`assign`(端口) 已由 team-core 映射为 `reassign`。
  updateTask: async (_c, req) => {
    const t = taskOf(req.taskId)
    if (!t) throw taskErr('TEAM_TASK_NOT_FOUND', req.taskId)
    switch (req.action) {
      case 'claim':
        if (t.ownerName !== undefined && t.ownerName !== req.owner)
          throw taskErr('TEAM_TASK_ALREADY_CLAIMED', `${req.taskId} owned by another member`)
        if (t.status !== 'pending' || !depsDone(t))
          throw taskErr('TEAM_TASK_BLOCKED', `${req.taskId} is not ready to claim`)
        t.status = 'in_progress'
        t.ownerName = req.owner
        break
      case 'release':
        if (t.status !== 'in_progress')
          throw taskErr('TEAM_TASK_INVALID_TRANSITION', 'only an in-progress task can be released')
        t.status = 'pending'
        t.ownerName = undefined
        break
      case 'complete':
        if (t.status !== 'in_progress')
          throw taskErr('TEAM_TASK_INVALID_TRANSITION', 'only an in-progress task can complete')
        t.status = 'completed'
        break
      case 'reopen':
        if (t.status !== 'completed')
          throw taskErr('TEAM_TASK_INVALID_TRANSITION', 'only a completed task can reopen')
        t.status = 'pending'
        t.ownerName = undefined
        break
      case 'reassign':
        if (t.status !== 'pending' && t.status !== 'in_progress')
          throw taskErr(
            'TEAM_TASK_INVALID_TRANSITION',
            'only a pending or in-progress task can be reassigned',
          )
        if (req.owner === undefined || String(req.owner).trim() === '') {
          t.status = 'pending'
          t.ownerName = undefined
          break
        }
        if (!depsDone(t)) throw taskErr('TEAM_TASK_BLOCKED', `${req.taskId} is blocked`)
        t.status = 'in_progress'
        t.ownerName = req.owner
        break
      case 'delete': {
        const dependent = tasks.find(
          (x) => x.status !== 'deleted' && x.id !== t.id && (x.blockedBy ?? []).includes(t.id),
        )
        if (dependent)
          throw taskErr('TEAM_TASK_HAS_DEPENDENTS', `${req.taskId} still blocks ${dependent.id}`)
        t.status = 'deleted'
        t.ownerName = undefined
        break
      }
      case 'edit':
        if (req.subject !== undefined) t.subject = req.subject
        if (req.description !== undefined) t.description = req.description
        break
      case 'set_dependencies':
        if (req.blockedBy !== undefined) t.blockedBy = req.blockedBy
        break
      default:
        throw taskErr('TEAM_TASK_INVALID_ACTION', String(req.action))
    }
    t.revision += 1
    return taskView(t)
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
    ctx.provide('skills', {})
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
  planGate: true,
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
assert(
  rootCtx.teamCore.getTask(lead, task.id).status === 'in_review',
  '提交评审 → 任务 in_review（显式评审态）',
)
// 评审态非终态：in_review 期间团队完成判定不得误判为完成
assert(
  (await rootCtx.teamCompletion.evaluate(lead)).completed === false,
  'in_review 期间不判团队完成',
)
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

// ── 阶段 P30：计划闸 + 返工反馈定向回流 ──────────────────────────────────────
console.log('\n== 阶段 P30：计划闸（执行前审批）/ 返工反馈 ==')
// 计划闸：入闸 → 未批不能执行 → 驳回带理由 → 批准后可执行
const pTask = await rootCtx.teamCore.createTask(lead, {
  subject: 'plan-task',
  description: 'needs plan',
})
await rootCtx.teamCore.updateTask(lead, {
  taskId: pTask.id,
  expectedRevision: pTask.revision,
  action: 'open_plan',
})
assert(rootCtx.teamCore.getTask(lead, pTask.id).status === 'planned', '计划闸：入闸 → planned')
let blocked = false
try {
  await rootCtx.teamCore.updateTask(lead, {
    taskId: pTask.id,
    expectedRevision: pTask.revision,
    action: 'claim',
    owner: 'alice',
  })
} catch {
  blocked = true
}
assert(blocked, '计划闸：未批准不能执行（claim 被拒）')
await rootCtx.teamCore.updateTask(lead, {
  taskId: pTask.id,
  expectedRevision: pTask.revision,
  action: 'submit_plan',
  plan: 'step1; step2',
})
await rootCtx.teamCore.updateTask(lead, {
  taskId: pTask.id,
  expectedRevision: pTask.revision,
  action: 'reject_plan',
  feedback: '请补测试',
})
assert(rootCtx.teamCore.planFeedbackOf(pTask.id) === '请补测试', '计划闸：驳回带理由且可回传')
await rootCtx.teamCore.updateTask(lead, {
  taskId: pTask.id,
  expectedRevision: pTask.revision,
  action: 'approve_plan',
})
assert(
  rootCtx.teamCore.getTask(lead, pTask.id).status === 'pending',
  '计划闸：批准后回 pending（可执行）',
)

// 返工反馈：评审 fail 携带 feedback + 定向 steer 回作者
const rTask = await rootCtx.teamCore.createTask(lead, { subject: 'rev-task', description: '' })
await rootCtx.teamCore.updateTask(lead, {
  taskId: rTask.id,
  expectedRevision: rTask.revision,
  action: 'claim',
  owner: 'alice',
})
await rootCtx.teamReview.submitForReview(lead, rTask.id)
await rootCtx.teamReview.vote({ id: 'verifier', name: 'verifier' }, rTask.id, {
  kind: 'binary',
  decision: 'fail',
  role: 'verifier',
})
await rootCtx.teamReview.vote({ id: 'challenger', name: 'challenger' }, rTask.id, {
  kind: 'binary',
  decision: 'pass',
  role: 'challenger',
})
sent.length = 0
await rootCtx.teamReview.settle(lead, rTask.id, '请补测试')
assert(
  rootCtx.teamCore.revisionFeedbackOf(rTask.id) === '请补测试',
  '返工：feedback 存于 team-core（可读）',
)
assert(
  sent.some(
    (s) =>
      s.target === 'alice' && String(s.content?.[0]?.text ?? '').includes('revision-requested'),
  ),
  '返工：定向 steer 回作者（alice 收到 revision-requested）',
)

// ── P34：任务动作保真（mock 已忠实建模 native 状态机）——强断言 ──────────────
console.log(
  '\n== P34：任务动作保真（DAG/claim/release/assign/complete/reopen/delete + 非法转换）==',
)
const a = await rootCtx.teamCore.createTask(lead, { subject: 'A', description: '' })
assert(
  a.status === 'pending' && a.ready === true,
  'DAG/readiness：空依赖任务 → pending 且 ready=true',
)
const a1 = await rootCtx.teamCore.updateTask(lead, {
  taskId: a.id,
  expectedRevision: a.revision,
  action: 'claim',
  owner: 'alice',
})
assert(
  a1.status === 'in_progress' && a1.ownerName === 'alice',
  'claim：pending+ready → in_progress + owner=alice',
)
const a2 = await rootCtx.teamCore.updateTask(lead, {
  taskId: a.id,
  expectedRevision: a1.revision,
  action: 'release',
})
assert(
  a2.status === 'pending' && a2.ownerName === undefined,
  'release：in_progress → pending，清 owner',
)
const a3 = await rootCtx.teamCore.updateTask(lead, {
  taskId: a.id,
  expectedRevision: a2.revision,
  action: 'assign',
  owner: 'bob',
})
assert(
  a3.status === 'in_progress' && a3.ownerName === 'bob',
  'reassign(端口 assign)：pending → in_progress + owner=bob',
)
const a4 = await rootCtx.teamCore.updateTask(lead, {
  taskId: a.id,
  expectedRevision: a3.revision,
  action: 'complete',
})
assert(a4.status === 'completed', 'complete：in_progress → completed')
// 非法转换：pending 任务不能 complete（忠实原生，抛 TEAM_TASK_INVALID_TRANSITION）
const cc = await rootCtx.teamCore.createTask(lead, { subject: 'C', description: '' })
let invalid = false
try {
  await rootCtx.teamCore.updateTask(lead, {
    taskId: cc.id,
    expectedRevision: cc.revision,
    action: 'complete',
  })
} catch (e) {
  invalid = /TEAM_TASK_INVALID_TRANSITION/.test(String(e))
}
assert(invalid, '非法转换：pending 任务 complete → TEAM_TASK_INVALID_TRANSITION')
// DAG：B 阻塞于 A；A 未完成时 B 不可 claim；A 完成后 B ready
// DAG：先 reopen A 使 A 未完成；B 阻塞于 A → B 不可 claim；A 完成后 B ready
const ar = await rootCtx.teamCore.updateTask(lead, {
  taskId: a.id,
  expectedRevision: a4.revision,
  action: 'reopen',
})
assert(ar.status === 'pending', 'reopen：completed → pending')
const b = await rootCtx.teamCore.createTask(lead, {
  subject: 'B',
  description: '',
  blockedBy: [a.id],
})
assert(b.ready === false, 'DAG：B 有未完成依赖 → ready=false')
let blockedErr = false
try {
  await rootCtx.teamCore.updateTask(lead, {
    taskId: b.id,
    expectedRevision: b.revision,
    action: 'claim',
    owner: 'alice',
  })
} catch (e) {
  blockedErr = /TEAM_TASK_BLOCKED/.test(String(e))
}
assert(blockedErr, 'DAG：依赖未完成 → claim 被拒 TEAM_TASK_BLOCKED')
const a5 = await rootCtx.teamCore.updateTask(lead, {
  taskId: a.id,
  expectedRevision: ar.revision,
  action: 'claim',
  owner: 'alice',
})
await rootCtx.teamCore.updateTask(lead, {
  taskId: a.id,
  expectedRevision: a5.revision,
  action: 'complete',
})
assert(
  rootCtx.teamCore.getTask(lead, b.id).ready === true,
  'DAG：上游 A complete → 下游 B ready=true',
)
// delete：有下游阻塞者则拒（忠实原生）；无依赖则 deleted
let delErr = false
try {
  await rootCtx.teamCore.updateTask(lead, {
    taskId: a.id,
    expectedRevision: rootCtx.teamCore.getTask(lead, a.id).revision,
    action: 'delete',
  })
} catch (e) {
  delErr = /TEAM_TASK_HAS_DEPENDENTS/.test(String(e))
}
assert(delErr, 'delete：仍有下游阻塞者 → TEAM_TASK_HAS_DEPENDENTS')
const dd = await rootCtx.teamCore.createTask(lead, { subject: 'D', description: '' })
const d1 = await rootCtx.teamCore.updateTask(lead, {
  taskId: dd.id,
  expectedRevision: dd.revision,
  action: 'delete',
})
assert(d1.status === 'deleted', 'delete：无依赖 → deleted')
// 显式标注仍为**弱断言**的维度（见文件顶部「mock 保真度说明」）
console.log(
  '[WEAK] delivery(quiet/wakeup)、跨进程、持久化、waitForChange 在本 mock 下属弱断言——须在真实 profile 验收',
)

// ── 阶段 2：锁守卫 / 技能可见性 / 记忆注入 ──────────────────────────────────
console.log('\n== 阶段 2：workspace / skills / memory ==')
const wsMod = await load('packages/team-workspace/lib/index.js')
const skMod = await load('packages/team-skills/lib/index.js')
const memMod = await load('packages/team-memory/lib/index.js')
await rootCtx.plugin(wsMod.default, {
  defaultTtlMs: 900000,
  enforceWriteGuard: true,
  sweepIntervalMs: 30000,
})
await rootCtx.plugin(skMod.default, { unrestrictedWhenUndeclared: true })
await rootCtx.plugin(memMod.default, { sharedWriter: 'lead' })

const bob = { id: 'bob', name: 'bob' }

// 技能可见性隔离
rootCtx.teamSkills.declare('t', { lead: ['arch-design'], bob: [] })
assert(
  JSON.stringify(rootCtx.teamSkills.visibleTo(lead)) === JSON.stringify(['arch-design']),
  '技能可见性：lead 可见 arch-design',
)
assert(
  JSON.stringify(rootCtx.teamSkills.visibleTo(bob)) === JSON.stringify([]),
  '技能可见性：bob 为空（不泄露）',
)

// 记忆：lead 写共享、bob 只读
await rootCtx.teamMemory.appendShared(lead, 'convention')
assert(rootCtx.teamMemory.readShared(bob).length === 1, '共享记忆允许 bob 读')
let memDenied = false
try {
  await rootCtx.teamMemory.appendShared(bob, 'x')
} catch {
  memDenied = true
}
assert(memDenied, '成员不可写共享记忆（授权拒绝）')

// 锁互斥：lead 独占 src，bob 取竞合锁被拒
const lk = await rootCtx.teamWorkspace.acquireLock(lead, { path: 'src', mode: 'exclusive' })
let conflict = false
try {
  await rootCtx.teamWorkspace.acquireLock(bob, { path: 'src/x.ts', mode: 'exclusive' })
} catch {
  conflict = true
}
assert(conflict, '写域锁互斥：bob 与 lead 的独占锁冲突')
await rootCtx.teamWorkspace.releaseLock(lead, lk)
assert(rootCtx.teamWorkspace.listLocks().length === 0, '释放后无锁')

// ── 阶段 3：传输 / 分布式 / 人类席位（覆盖 spec §3.4 的 V1/V2/V4）────────────
console.log('\n== 阶段 3：transport / distributed / human ==')
const trMod = await load('packages/team-transport/lib/index.js')
const distMod = await load('packages/team-distributed/lib/index.js')
const humMod = await load('packages/team-human/lib/index.js')

// 同进程双端：借用共享内存总线模拟「两个传输服务」
const peerCtx = new Context()
await peerCtx.plugin({
  name: 'peer-host',
  apply(ctx) {
    ctx.provide('tools', { register: () => () => {} })
    ctx.provide('systemPrompt', { section: () => () => {}, context: () => () => {} })
    ctx.provide('sessions', {})
    ctx.provide('agents', { list: () => [] })
  },
})
const trCfg = {
  backend: 'in-process',
  maxQueue: 8,
  maxHistory: 8,
  reconnectTimeoutMs: 60,
  reconnectIntervalMs: 0,
  autoReconnect: false,
}
await rootCtx.plugin(trMod.default, { ...trCfg, endpoint: 'lead' })
await peerCtx.plugin(trMod.default, { ...trCfg, endpoint: 'worker' })
const tbus = trMod.getLoopbackBus()
const tick = () => new Promise((r) => setTimeout(r, 0))

// V2 不重：丢 ack → 重连重放 → 恰好一次生效
const seenX = []
peerCtx.teamTransport.onFrame((_pid, f) => {
  if (f.payload && f.payload.x) seenX.push(f.payload.x)
})
tbus.shouldDrop = (m) => m.t === 'ack'
await rootCtx.teamTransport.send('worker', { kind: 'event', teamId: 'T', payload: { x: 1 } })
await tick()
assert(seenX.length === 1, '阶段3 V2：首投送达 1 次')
assert(rootCtx.teamTransport.stats().acked === 0, '阶段3 V2：ack 被注入丢弃')
tbus.shouldDrop = undefined
tbus.disconnect('worker')
assert(
  rootCtx.teamTransport.peers().find((p) => p.peerId === 'worker').state === 'degraded',
  '阶段3 V4：断连 → degraded',
)
await rootCtx.teamTransport.reconnect('worker')
assert(
  rootCtx.teamTransport.peers().find((p) => p.peerId === 'worker').state === 'connected',
  '阶段3 V4：重连 → connected',
)
assert(seenX.length === 1, '阶段3 V2：重放后仍恰好一次生效（幂等去重）')
assert(peerCtx.teamTransport.stats().dedupDropped >= 1, '阶段3 V2：dedupDropped++')

// V1 丢帧 → 重连重放后收敛（不丢）
const seenY = []
rootCtx.teamTransport.onFrame((_pid, f) => {
  if (f.payload && f.payload.y) seenY.push(f.payload.y)
})
tbus.shouldDrop = (m) => m.t === 'app' && m.seq === 2 // 吞掉第 2 帧
await peerCtx.teamTransport.send('lead', { kind: 'event', teamId: 'T', payload: { y: 1 } })
await peerCtx.teamTransport.send('lead', { kind: 'event', teamId: 'T', payload: { y: 2 } })
assert(seenY.length === 1, '阶段3 V1：丢帧导致本端只收到 1 帧')
tbus.shouldDrop = undefined
tbus.disconnect('lead')
await peerCtx.teamTransport.reconnect('lead')
assert(seenY.sort((a, b) => a - b).join(',') === '1,2', '阶段3 V1/V4：重放后终态对账补齐（不丢）')

// 分布式：leader 权威 + 投递去重
await rootCtx.plugin(distMod.default, { role: 'lead', deliveryTtlMs: 30000 })
rootCtx.teamDistributed.becomeLead(lead, 'T')
await rootCtx.teamDistributed.deliver(lead, member.id, 'e2e-msg-1', [{ type: 'text', text: 'hi' }])
await rootCtx.teamDistributed.deliver(lead, member.id, 'e2e-msg-1', [{ type: 'text', text: 'hi' }])
assert(
  rootCtx.teamDistributed.state().dedupDropped === 1,
  '阶段3 V2：分布式投递去重（dedupDropped=1）',
)
assert(rootCtx.teamDistributed.state().delivered === 1, '阶段3 V2：恰好交付一次')

// 人类席位：注册 + 入站路由 + 离线未达保留
await rootCtx.plugin(humMod.default, { leadName: 'lead', retainWhenOffline: true })
const opSeat = await rootCtx.teamHuman.addSeat(lead, { name: 'op', kind: 'controller' })
assert(opSeat.kind === 'controller', '阶段3：人类席位注册（kind=controller）')
const routed = await rootCtx.teamHuman.inbound(opSeat.seatId, '@all hi')
assert(routed.target === 'all', '阶段3：入站 @all → 广播目标')
const offline = await rootCtx.teamHuman.deliver(opSeat.seatId, [{ type: 'text', text: 'x' }])
assert(offline.delivered === false, '阶段3：无前端在线 → 未达（保留待补投）')

if (failures === 0) {
  console.log(
    '\n✅ 集成冒烟通过：成员 → 消息 → 任务 → 评审 → 完成 + 阶段3 传输/分布式/人类席位 链路打通（端口 mock 后端）。',
  )
} else {
  console.error(`\n❌ 集成冒烟失败：${failures} 项断言未通过。`)
  process.exit(1)
}
