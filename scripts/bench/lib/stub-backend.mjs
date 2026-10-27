/**
 * 离线桩后端：在**真实 cordis 运行时**里加载真实插件产物（team-core / team-bus /
 * team-review / team-completion / team-scheduler / tool-swarm …），用**端口 mock**（模拟
 * `ctx.agentTeams` 的结构与状态）驱动 S1–S5，零网络、零模型成本、完全确定。
 *
 * 它验证的是「场景编排 + 指标采集管道 + 真实插件协作链路」，与 `scripts/verify-e2e.mjs`
 * 同源但**带仪表**：所有投递/唤醒/任务状态流转都被记录并打时间戳。
 *
 * 重要边界（诚实标注）：桩模式**没有真实 LLM**，因此 LLM 轮次/token 一律为 `null`（未采集），
 * 只给出**结构性**真实计数（投递、唤醒、空转唤醒、任务停留）。真实 LLM 数字必须来自 model 后端。
 *
 * @module scripts/bench/stub-backend
 */

import { Context } from '@deepseek-ai/cordis'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readdirSync, statSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '..', '..', '..')

const now = () => Date.now()

// ── 端口 mock：结构化模拟 ctx.agentTeams，并记录任务状态流转 ────────────────
class MockTeams {
  constructor(rec, opts = {}) {
    this.rec = rec
    this.opts = opts
    this.members = [{ id: 'lead', name: 'lead', role: 'lead', status: 'idle' }]
    this.tasks = new Map()
    this.seq = 0
    this.flakyFailures = new Map() // target -> remaining forced failures
    this.lastNudge = new Map()
  }

  membership(agent) {
    return { id: 'lead', role: 'lead', name: 'lead' }
  }
  tryMembership(agent) {
    if (!agent) return { id: 'lead', role: 'lead', name: 'lead' }
    if (agent.id === 'lead' || agent.name === 'lead') return { id: 'lead', role: 'lead', name: 'lead' }
    const m = this.members.find((x) => x.id === agent.id || x.name === agent.name)
    return m ? { id: m.id, role: 'teammate', name: m.name } : undefined
  }
  listMembers() {
    return this.members.map((m) => ({ ...m }))
  }

  async spawnTeammate(_c, req) {
    const id = `m${++this.seq}`
    const m = { id, name: req.name, role: 'teammate', status: 'idle', description: req.description }
    this.members.push(m)
    this.rec.event({ kind: 'spawn', t: now(), id, name: req.name })
    return { member: { id, name: req.name, role: 'teammate', description: req.description } }
  }

  async sendMessage(_c, req) {
    const target = this.members.find((m) => m.name === req.target)
    // 强制失败（重试路径）
    const remain = this.flakyFailures.get(req.target) ?? 0
    if (remain > 0) {
      this.flakyFailures.set(req.target, remain - 1)
      this.rec.event({ kind: 'send_fail', t: now(), to: req.target })
      throw new Error(`mock: transient delivery failure to ${req.target}`)
    }
    // 投递：inactive/idle → running 的语义在真实后端会起一个 turn；桩模式仅记录状态转移
    if (target && target.status !== 'running') {
      this.rec.event({ kind: 'member_wake', t: now(), to: req.target })
    }
    return { messageId: `msg-${++this.seq}` }
  }

  async createTask(_c, req) {
    const id = `task-${++this.seq}`
    const t = {
      id,
      revision: 1,
      subject: req.subject,
      description: req.description,
      status: 'pending',
      blockedBy: req.blockedBy ?? [],
      ready: false,
      ownerName: undefined,
    }
    this.tasks.set(id, t)
    this.recomputeReady()
    this.rec.event({ kind: 'task', t: now(), id, status: 'pending', action: 'create', subject: req.subject })
    return { ...this.tasks.get(id) }
  }

  getTask(_c, id) {
    const t = this.tasks.get(id)
    if (!t) throw new Error(`mock: no task ${id}`)
    return { ...t }
  }
  listTasks() {
    return [...this.tasks.values()].map((t) => ({ ...t }))
  }

  async updateTask(_c, req) {
    const t = this.tasks.get(req.taskId)
    if (!t) throw new Error(`mock: no task ${req.taskId}`)
    if (typeof req.expectedRevision === 'number' && req.expectedRevision !== t.revision) {
      this.rec.event({ kind: 'task_cas_conflict', t: now(), id: t.id })
      throw new Error(`mock: CAS conflict on ${t.id}`)
    }
    const before = t.status
    switch (req.action) {
      case 'claim':
        t.status = 'in_progress'
        t.ownerName = req.owner
        break
      case 'complete':
        t.status = 'completed'
        break
      case 'release':
        t.status = 'pending'
        t.ownerName = undefined
        break
      case 'reopen':
        t.status = 'pending'
        break
      case 'set_dependencies':
        t.blockedBy = req.blockedBy ?? t.blockedBy
        break
      case 'assign':
      case 'reassign':
        t.ownerName = req.owner
        break
      case 'edit':
        if (req.subject !== undefined) t.subject = req.subject
        break
      case 'delete':
        t.status = 'deleted'
        break
      default:
        break
    }
    t.revision += 1
    this.recomputeReady()
    this.rec.event({
      kind: 'task',
      t: now(),
      id: t.id,
      action: req.action,
      from: before,
      status: t.status,
      owner: t.ownerName,
      subject: t.subject,
    })
    return { ...t }
  }

  async waitForChange(_c, timeoutMs) {
    const t0 = now()
    const wait = Math.min(timeoutMs ?? 0, 50) // 桩模式不真等满，避免无意义挂起
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.rec.event({ kind: 'wait', t: now(), timeoutMs, waitedMs: now() - t0, timedOut: true })
    return { timedOut: true }
  }

  interrupt(_c, targetName) {
    const m = this.members.find((x) => x.name === targetName)
    const prev = m && m.status === 'running' ? 'running' : 'inactive'
    this.rec.event({ kind: 'interrupt', t: now(), to: targetName, previousStatus: prev })
    return { previousStatus: prev }
  }

  recomputeReady() {
    for (const t of this.tasks.values()) {
      const blockersDone = t.blockedBy.every((bid) => {
        const b = this.tasks.get(bid)
        return b && (b.status === 'completed' || b.status === 'deleted')
      })
      t.ready = t.status === 'pending' && blockersDone
    }
  }
}

// ── 记录器 ────────────────────────────────────────────────────────────────
export class Recorder {
  constructor() {
    this.events = []
    this.t0 = now()
  }
  event(e) {
    this.events.push(e)
  }
}

// ── 主执行 ────────────────────────────────────────────────────────────────
/**
 * @param {import('./scenarios.mjs').SCENARIOS[string]} scenario
 * @param {{scheduler?:'on'|'off', review?:'gate'|'none', delivery?:'bus'|'n-dm', stale?:'on'|'off', schedMode?:'autonomous'|'scheduled', broadcastFanout?:'dm'|'record-only'}} [opts]
 *   A/B 与消融开关（默认全开=基线）：scheduler 有/无、review 有/无闸、delivery 广播实现（bus 扇出 / N 次 DM）、
 *   stale 自愈有/无、schedMode 调度模式、broadcastFanout 广播扇出（dm 逐人投递 / record-only 仅落库可拉取）。
 * @returns {Promise<{metrics: object, events: object[], notes: string[], variant: object}>}
 */
export async function runStubScenario(scenario, opts = {}) {
  const variant = {
    scheduler: opts.scheduler ?? 'on',
    review: opts.review ?? 'gate',
    delivery: opts.delivery ?? 'bus',
    stale: opts.stale ?? 'on',
    schedMode: opts.schedMode ?? 'autonomous',
    broadcastFanout: opts.broadcastFanout ?? 'dm',
    planGate: opts.planGate ?? 'off',
  }
  const schedulerOn = variant.scheduler === 'on'
  const reviewGate = variant.review === 'gate'
  const deliveryImpl = variant.delivery
  const staleSelfHeal = variant.stale === 'on'
  const planGateOn = variant.planGate === 'on'

  const notes = []
  const rec = new Recorder()
  const memBefore = process.memoryUsage()
  const t0 = now()

  // 结果沙箱：仅用于磁盘开销采样（不落密钥、不碰 .runtime 之外）
  const fsSandbox = resolve(REPO_ROOT, '.runtime', 'bench', '_sandbox')
  const fsBefore = dirSize(fsSandbox)

  // ── host：准备外部服务 ────────────────────────────────────────────────
  const seam = new MockTeams(rec)
  const rootCtx = new Context()
  await rootCtx.plugin({
    name: 'bench-stub-host',
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

  const load = async (p) => {
    const mod = await import(pathToFileURL(resolve(REPO_ROOT, p)).href)
    return mod.default ?? mod // tool-swarm 等用命名 apply 导出
  }

  const core = await load('packages/team-core/lib/index.js')
  const bus = await load('packages/team-bus/lib/index.js')
  const review = await load('packages/team-review/lib/index.js')
  const completion = await load('packages/team-completion/lib/index.js')
  const scheduler = await load('packages/team-scheduler/lib/index.js')
  const toolSwarm = await load('packages/tool-swarm/lib/index.js')

  await rootCtx.plugin(core, {
    backend: 'auto',
    maxMembers: 16,
    maxTasks: 256,
    maxMessageBytes: 65536,
    planGate: planGateOn,
  })
  await rootCtx.plugin(bus, { maxFanout: 64, maxMessageBytes: 65536 })
  await rootCtx.plugin(review, {
    pools: reviewGate ? [{ kind: 'binary', rule: 'veto', roles: ['verifier', 'challenger'] }] : [],
    maxRounds: 3,
    stallTimeoutMs: 1800000,
  })
  await rootCtx.plugin(completion, { blockOnUnread: false })

  if (schedulerOn) {
    const schedCfg = scenario.scheduler ?? {}
    await rootCtx.plugin(scheduler, {
      mode: variant.schedMode,
      pollMs: 1_000_000, // 靠显式 scan 驱动，避免定时器噪声
      staleClaimIdleMs: staleSelfHeal ? (schedCfg.staleClaimIdleMs ?? 600000) : Number.MAX_SAFE_INTEGER,
      staleEscalateStreak: staleSelfHeal ? (schedCfg.staleEscalateStreak ?? 3) : Number.MAX_SAFE_INTEGER,
      busyTaskStatuses: ['pending', 'in_progress'],
    })
  } else {
    notes.push('scheduler=off：未加载 team-scheduler（无自动派发 / 无 stale 自愈）')
  }
  await rootCtx.plugin(toolSwarm, { enableBroadcast: true, enableReview: true })

  if (!(rootCtx.teamCore && rootCtx.teamCore.active)) {
    notes.push('team-core 未激活（端口 mock 未接通），后续指标不可信')
  }

  // ── 仪表：包装 teamCore.send（捕获 delivery 分类）与 teamBus.broadcast/multicast ──
  const sends = []
  let fanoutDepth = 0
  const origSend = rootCtx.teamCore.send.bind(rootCtx.teamCore)
  rootCtx.teamCore.send = async (caller, req) => {
    const cls = fanoutDepth > 0 ? 'fanout' : 'direct'
    const to = req.range?.kind === 'dm' ? req.range.to : undefined
    const ev = { kind: 'send', t: now(), to, delivery: req.delivery, cls, text: req.content?.[0]?.text }
    rec.event(ev)
    sends.push(ev)
    return origSend(caller, req)
  }
  const origBroadcast = rootCtx.teamBus.broadcast.bind(rootCtx.teamBus)
  rootCtx.teamBus.broadcast = async (caller, req) => {
    const before = seam.members.length
    fanoutDepth += 1
    try {
      const res = await origBroadcast(caller, req)
      rec.event({ kind: 'broadcast', t: now(), fanout: before - 1, topic: req.topic ?? 'team' })
      return res
    } finally {
      fanoutDepth -= 1
    }
  }
  const origMulticast = rootCtx.teamBus.multicast.bind(rootCtx.teamBus)
  rootCtx.teamBus.multicast = async (caller, req) => {
    fanoutDepth += 1
    try {
      const res = await origMulticast(caller, req)
      rec.event({ kind: 'multicast', t: now(), fanout: req.targets?.length ?? 0 })
      return res
    } finally {
      fanoutDepth -= 1
    }
  }

  const lead = { id: 'lead', name: 'lead' }
  const taskRefs = new Map()
  const scanReports = []
  const flakyCounters = new Map()

  // ── 步骤解释器 ────────────────────────────────────────────────────────
  for (const step of scenario.stub) {
    const a = step.args ?? {}
    switch (step.op) {
      case 'spawn':
        await rootCtx.teamCore.spawn(lead, {
          name: a.name,
          description: a.desc ?? '',
          prompt: [{ type: 'text', text: 'work' }],
          context: 'fresh',
          provider: 'spawn',
          signal: new AbortController().signal,
        })
        break
      case 'dm':
        await rootCtx.teamCore.send(lead, {
          range: { kind: 'dm', to: a.to },
          content: [{ type: 'text', text: a.text ?? '' }],
          delivery: a.delivery ?? 'wakeup',
        })
        break
      case 'broadcast':
        if (deliveryImpl === 'n-dm') {
          // 消融/swap：用 N 次直接 DM 实现「同一条信息送达全员」（绕过 team-bus 扇出）
          const targets = seam.members.filter((m) => m.role !== 'lead')
          for (const m of targets) {
            await rootCtx.teamCore.send(lead, {
              range: { kind: 'dm', to: m.name },
              content: [{ type: 'text', text: a.text ?? '' }],
              delivery: a.delivery ?? 'wakeup',
            })
          }
          rec.event({ kind: 'broadcast', t: now(), fanout: targets.length, topic: a.topic ?? 'team', impl: 'n-dm' })
        } else {
          await rootCtx.teamBus.broadcast(lead, {
            topic: a.topic ?? 'team',
            content: [{ type: 'text', text: a.text ?? '' }],
            delivery: a.delivery ?? 'wakeup',
            // A/B：广播扇出模式（dm=逐人投递 / record-only=仅落库可拉取）
            fanout: variant.broadcastFanout,
          })
        }
        break
      case 'multicast':
        await rootCtx.teamBus.multicast(lead, {
          targets: a.targets ?? [],
          content: [{ type: 'text', text: a.text ?? '' }],
          delivery: a.delivery ?? 'wakeup',
        })
        break
      case 'taskCreate': {
        const t = await rootCtx.teamCore.createTask(lead, {
          subject: a.subject,
          description: a.subject,
          blockedBy: (a.blockedBy ?? []).map((r) => taskRefs.get(r)),
        })
        taskRefs.set(a.ref, t.id)
        break
      }
      case 'taskClaim':
        await rootCtx.teamCore.updateTask(lead, {
          taskId: taskRefs.get(a.ref),
          expectedRevision: rootCtx.teamCore.getTask(lead, taskRefs.get(a.ref)).revision,
          action: 'claim',
          owner: a.owner,
        })
        break
      case 'taskComplete':
        await rootCtx.teamCore.updateTask(lead, {
          taskId: taskRefs.get(a.ref),
          expectedRevision: rootCtx.teamCore.getTask(lead, taskRefs.get(a.ref)).revision,
          action: 'complete',
        })
        break
      case 'taskSetDeps':
        await rootCtx.teamCore.updateTask(lead, {
          taskId: taskRefs.get(a.ref),
          expectedRevision: rootCtx.teamCore.getTask(lead, taskRefs.get(a.ref)).revision,
          action: 'set_dependencies',
          blockedBy: (a.blockedBy ?? []).map((r) => taskRefs.get(r)),
        })
        break
      // ── 计划闸（P30）：执行前审批。动作在 team-core 端口内处理（原生无此态/动作）──
      case 'taskOpenPlan':
      case 'taskSubmitPlan':
      case 'taskApprovePlan':
      case 'taskRejectPlan': {
        const action = {
          taskOpenPlan: 'open_plan',
          taskSubmitPlan: 'submit_plan',
          taskApprovePlan: 'approve_plan',
          taskRejectPlan: 'reject_plan',
        }[step.op]
        const id = taskRefs.get(a.ref)
        const pt = await rootCtx.teamCore.updateTask(lead, {
          taskId: id,
          expectedRevision: rootCtx.teamCore.getTask(lead, id).revision,
          action,
          plan: a.plan,
          feedback: a.feedback,
        })
        rec.event({ kind: 'plan', t: now(), ref: a.ref, action, status: pt.status })
        break
      }
      case 'taskExpectReject': {
        // 负向断言：计划闸中执行**非计划动作必须被拒**（不变量「未批准不能执行」）
        let rejected = false
        let code = ''
        try {
          await rootCtx.teamCore.updateTask(lead, {
            taskId: taskRefs.get(a.ref),
            expectedRevision: rootCtx.teamCore.getTask(lead, taskRefs.get(a.ref)).revision,
            action: a.action ?? 'claim',
            owner: a.owner,
          })
        } catch (e) {
          rejected = true
          code = String(e.message).split(':')[0]
        }
        rec.event({
          kind: 'plan_expect_reject',
          t: now(),
          ref: a.ref,
          action: a.action ?? 'claim',
          rejected,
          code,
        })
        if (!rejected) {
          notes.push(`taskExpectReject 未如期被拒（ref=${a.ref}, action=${a.action ?? 'claim'}）`)
        }
        break
      }
      case 'reviewSubmit':
        // review='none' 时 pools 为空 → submitForReview 直接完成（无闸）
        await rootCtx.teamReview.submitForReview(lead, taskRefs.get(a.ref))
        if (!reviewGate) notes.push('review=none：无评审闸，提交即完成')
        break
      case 'reviewVote':
        if (!reviewGate) {
          notes.push('review=none：跳过 reviewVote（无闸）')
          break
        }
        await rootCtx.teamReview.vote(
          { id: a.role, name: a.role },
          taskRefs.get(a.ref),
          a.value !== undefined
            ? { kind: 'score', value: a.value, role: a.role }
            : { kind: 'binary', decision: a.decision, role: a.role },
        )
        break
      case 'reviewSettle': {
        if (!reviewGate) {
          notes.push('review=none：跳过 reviewSettle（无闸）')
          break
        }
        const v = await rootCtx.teamReview.settle(lead, taskRefs.get(a.ref))
        rec.event({ kind: 'review_settle', t: now(), id: taskRefs.get(a.ref), verdict: v.kind, reason: v.reason })
        break
      }
      case 'scan': {
        if (!schedulerOn) {
          const r = { started: 0, reviewsDispatched: 0, staleNudged: 0, converged: true, skipped: true }
          scanReports.push({ label: a.label ?? '', ...r })
          rec.event({ kind: 'scan', t: now(), label: a.label ?? '', report: r })
          break
        }
        const r = await rootCtx.teamScheduler.scan(lead)
        scanReports.push({ label: a.label ?? '', ...r })
        rec.event({ kind: 'scan', t: now(), label: a.label ?? '', report: r })
        break
      }
      case 'sleep':
        await new Promise((r) => setTimeout(r, a.ms ?? 0))
        break
      case 'flakyDm': {
        // 直接调 seam，绕过 teamCore.send 的包装以模拟底层瞬时失败 + 上层重试
        seam.flakyFailures.set(a.to, a.failTimes ?? 1)
        let attempt = 0
        let ok = false
        while (attempt < (a.failTimes ?? 1) + 1 && !ok) {
          attempt += 1
          try {
            await rootCtx.teamCore.send(lead, {
              range: { kind: 'dm', to: a.to },
              content: [{ type: 'text', text: a.text ?? '' }],
              delivery: a.delivery ?? 'wakeup',
            })
            ok = true
            rec.event({ kind: 'retry_ok', t: now(), to: a.to, attempt })
          } catch (e) {
            rec.event({ kind: 'retry', t: now(), to: a.to, attempt, err: String(e.message) })
          }
        }
        break
      }
      case 'wait':
        await rootCtx.teamCore.waitForChange(lead, a.timeoutMs ?? 0, new AbortController().signal)
        break
      default:
        notes.push(`未知 stub 操作：${step.op}`)
    }
  }

  const e2eMs = now() - t0
  const memAfter = process.memoryUsage()
  const fsAfter = dirSize(fsSandbox)

  const metrics = computeStubMetrics({
    rec,
    sends,
    seam,
    scanReports,
    e2eMs,
    memBefore,
    memAfter,
    fsAfter,
    fsBefore,
    notes,
  })
  metrics.variant = variant
  return { metrics, events: rec.events, notes, variant }
}

function computeStubMetrics({ rec, sends, seam, scanReports, e2eMs, memBefore, memAfter, fsAfter, fsBefore, notes }) {
  const delivers = sends.filter((e) => e.kind === 'send')
  const wakeups = delivers.filter((e) => e.delivery === 'wakeup')
  const directWakeups = wakeups.filter((e) => e.cls === 'direct')
  const fanoutWakeups = wakeups.filter((e) => e.cls === 'fanout')

  const ownedTaskCount = (name) =>
    [...seam.tasks.values()].filter((t) => t.ownerName === name && t.status !== 'deleted').length
  const directTo = (name) => directWakeups.filter((e) => e.to === name).length

  // 空转唤醒：经广播扇出被叫醒，但既无自己的直接消息、也无自己名下的任务
  const spin = fanoutWakeups.filter((e) => directTo(e.to) === 0 && ownedTaskCount(e.to) === 0)
  const spinByMember = {}
  for (const e of spin) spinByMember[e.to] = (spinByMember[e.to] ?? 0) + 1

  // 任务停留时长：按 task 事件时间戳求相邻状态差
  const taskEvents = rec.events.filter((e) => e.kind === 'task')
  const dwell = {}
  const byTask = {}
  for (const e of taskEvents) {
    ;(byTask[e.id] ??= []).push(e)
  }
  for (const [id, evs] of Object.entries(byTask)) {
    const seq = []
    for (let i = 0; i < evs.length; i++) {
      const dur = i + 1 < evs.length ? evs[i + 1].t - evs[i].t : nowMinus(evs[i].t)
      const statusKey = evs[i].status
      dwell[statusKey] = (dwell[statusKey] ?? 0) + dur
      seq.push({ status: statusKey, ms: dur, action: evs[i].action })
    }
    dwell[`#${id}`] = seq
  }

  const retries = rec.events.filter((e) => e.kind === 'retry').length
  const casConflicts = rec.events.filter((e) => e.kind === 'task_cas_conflict').length
  const staleNudged = scanReports.reduce((s, r) => s + (r.staleNudged ?? 0), 0)
  const escalations = rec.events.filter((e) => e.kind === 'send' && /escalation/i.test(e.text ?? '')).length
  const reviewRounds = rec.events.filter((e) => e.kind === 'review_settle').length

  // 计划闸（P30）：合法转换序列 + 非法转换被拒计数（不变量「未批准不能执行」）
  const planEvents = rec.events.filter((e) => e.kind === 'plan')
  const planExpect = rec.events.filter((e) => e.kind === 'plan_expect_reject')
  const planIllegalRejected = planExpect.filter((e) => e.rejected).length
  const planIllegalNotRejected = planExpect.filter((e) => !e.rejected).length
  const planTransitions = planEvents.map((e) => `${e.action}→${e.status}`)

  return {
    backend: 'stub',
    e2eMs,
    llmTurns: null,
    tokens: { input: null, output: null, total: null },
    messageDeliveries: delivers.length,
    broadcasts: rec.events.filter((e) => e.kind === 'broadcast').length,
    multicasts: rec.events.filter((e) => e.kind === 'multicast').length,
    wakeups: wakeups.length,
    wakeupsDirect: directWakeups.length,
    wakeupsFanout: fanoutWakeups.length,
    spinWakeups: spin.length,
    spinWakeupsByMember: spinByMember,
    members: seam.members.map((m) => ({ name: m.name, role: m.role, status: m.status })),
    tasks: [...seam.tasks.values()].map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      ready: t.ready,
      owner: t.ownerName,
    })),
    taskDwellMs: dwell,
    retries,
    casConflicts,
    staleNudged,
    escalations,
    reviewRounds,
    planActions: planEvents.length,
    planTransitions,
    planIllegalRejected,
    planIllegalNotRejected,
    scans: scanReports,
    process: {
      rssBeforeBytes: memBefore.rss,
      rssAfterBytes: memAfter.rss,
      heapUsedBeforeBytes: memBefore.heapUsed,
      heapUsedAfterBytes: memAfter.heapUsed,
    },
    disk: { sandboxBeforeBytes: fsBefore, sandboxAfterBytes: fsAfter, sandboxDeltaBytes: fsAfter - fsBefore },
    notes,
  }
}

const nowMinus = (t) => Date.now() - t

function dirSize(dir) {
  let total = 0
  try {
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = resolve(d, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else total += st.size
      }
    }
    walk(dir)
  } catch {
    /* 目录不存在视为 0 */
  }
  return total
}
