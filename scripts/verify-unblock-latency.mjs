#!/usr/bin/env node
/**
 * 解锁→唤醒**延迟**探针（P31 · 独立、确定性；不改 `scripts/e2e-profile.sh`）。
 *
 * 目标：量化 `team-scheduler` 的「上游终态 → 下游归属人被 nudge」延迟：
 *   - **poll 模式（现状基线）**：仅靠 `pollMs` 轮询 → 延迟 ≈ 一个 poll 周期。
 *   - **push 模式（P31 落地后）**：`onTaskTerminal()`（或 emit `swarm/task/terminal`）→ 延迟 ≈ 0。
 * 若 push 面尚未实现（P30 前），打印 `SKIP: push not yet implemented`，只报 poll 基线。
 *
 * 说明：这是**机制级**确定性探针（驱动真实 `team-scheduler` 编译产物）；带模型 overlay 的
 * 真实 profile 头条数字由 profile 链路侧面支撑（P20 地盘）。零模型 token。
 *
 * 用法：node scripts/verify-unblock-latency.mjs   （需先 pnpm build）
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const { default: TeamSchedulerService } = await import(
  join(root, 'packages/team-scheduler/lib/index.js')
)

const POLL_MS = 200
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 可编程 fake ctx / teamCore：一个空闲成员 w + 一条就绪任务。 */
function makeHarness(pollMs) {
  const members = [{ id: 'w', name: 'w', role: 'teammate', phase: 'active', status: 'idle' }]
  // 无活跃任务 ⇒ 成员 w 空闲；t1 作为「下游就绪任务」用于 push 场景
  const tasks = []
  const nudges = []
  const teamCore = {
    backend: 'native',
    listMembers: () => members,
    listTasks: () => tasks,
    tryMembership: () => ({ role: 'teammate', name: 'w' }),
    updateTask: async () => ({ ...tasks[0] }),
    send: async (caller, req) => {
      nudges.push({ to: req.range.to, at: Date.now() })
      return { messageId: 'm', status: 'accepted' }
    },
  }
  const ctx = {
    teamCore,
    teamBus: {},
    agents: {},
    systemPrompt: {},
    logger: { warn() {}, debug() {}, info() {} },
    reflect: { provide() {} },
    get: (n) => ({ teamCore, teamBus: {}, agents: {}, systemPrompt: {} }[n]),
    effect: (fn) => fn(),
    emit() {},
    on() {
      return () => {}
    },
  }
  const scheduler = new TeamSchedulerService(ctx, {
    mode: 'autonomous',
    pollMs,
    staleClaimIdleMs: 600000,
    staleEscalateStreak: 3,
    busyTaskStatuses: ['pending', 'in_progress', 'in_review'],
    reviewStallMs: 1800000,
  })
  return { scheduler, nudges, members, tasks }
}

console.log('== 解锁→唤醒 延迟探针（team-scheduler）==')

// ── poll 基线 ────────────────────────────────────────────────────────────────
{
  const h = makeHarness(POLL_MS)
  const t0 = Date.now()
  const dispose = h.scheduler.arm({ id: 'lead' })
  await sleep(POLL_MS + 120)
  const first = h.nudges[0]
  const latency = first ? first.at - t0 : -1
  console.log(`[poll] pollMs=${POLL_MS} 首次 nudge 延迟 ≈ ${latency}ms（成员 ${first?.to}）`)
  console.log(
    latency >= 0 && latency <= POLL_MS + 60
      ? '[OK]   poll 基线符合预期（延迟 ≤ 一个 poll 周期）'
      : `[WARN] poll 延迟 ${latency}ms 超出预期`,
  )
  dispose()
}

// ── push 模式（P31 落地后自动启用）──────────────────────────────────────────
{
  const h = makeHarness(POLL_MS)
  const hasPush = typeof h.scheduler.onTaskTerminal === 'function'
  if (!hasPush) {
    console.log(
      '[SKIP] push not yet implemented（P30 后启用：onTaskTerminal / swarm/task/terminal）',
    )
  } else {
    h.tasks.push({
      id: 't2',
      revision: 0,
      subject: 'downstream',
      description: '',
      status: 'pending',
      blockedBy: [],
      ready: true,
      ownerName: 'w',
    })
    h.scheduler.arm({ id: 'lead' })
    const t0 = Date.now()
    await h.scheduler.onTaskTerminal({ id: 'lead' })
    const first = h.nudges[0]
    const latency = first ? first.at - t0 : -1
    console.log(`[push] 终态→nudge 延迟 ≈ ${latency}ms`)
    console.log(
      latency >= 0 && latency < POLL_MS / 2 ? '[OK]   push 显著快于 poll' : '[WARN] push 未显著',
    )
  }
}

console.log('\n✅ 延迟探针完成（poll 基线；push 待 P30 落地后自动对比）')
process.exit(0)
