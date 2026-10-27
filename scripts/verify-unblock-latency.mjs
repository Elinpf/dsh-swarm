#!/usr/bin/env node
/**
 * 解锁→唤醒**延迟**探针（P31 · 独立、确定性；不改 `scripts/e2e-profile.sh`）。
 *
 * 量化 `team-scheduler` 的「上游终态 → 下游归属人被 nudge」的延迟，并**明确两条结论**：
 *   1. **延迟上界 = 一个 poll 周期**（随配置变化，**不是固定 200ms**）：同时报
 *      **测试档 200ms** 与 **生产默认档 30000ms**（`team-scheduler/src/index.ts:69` default(30000)，
 *      bundle patch `packages/bundle/cordis.patch.yml:53` pollMs: 30000）。
 *   2. **调度器不存活 ⇒ 解锁根本不发生**（比延迟更重要的 P1 实质风险）：不 `arm()` 时，
 *      任务就绪后**无任何 nudge**。
 *   3. **push 模式（P31 落地后）**：`onTaskTerminal()`（或 emit `swarm/task/terminal`）→ 延迟 ≈ 0；
 *      探针自动探测 push 面，尚未实现则 `SKIP`。
 *
 * 机制级确定性探针（驱动真实 `team-scheduler` 编译产物）；零模型 token。
 * 用法：node scripts/verify-unblock-latency.mjs   （需先 pnpm build）
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const { default: TeamSchedulerService } = await import(
  join(root, 'packages/team-scheduler/lib/index.js')
)

const TEST_POLL_MS = 200
/** 生产默认 poll 间隔（源：team-scheduler/src/index.ts:69 default(30000) + bundle patch:53）。 */
const PROD_POLL_MS = 30000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 可编程 fake ctx / teamCore：一个空闲成员 w。 */
function makeHarness(pollMs) {
  const members = [{ id: 'w', name: 'w', role: 'teammate', phase: 'active', status: 'idle' }]
  const tasks = [] // 无活跃任务 ⇒ w 空闲；下游就绪任务在 push 场景再放
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

/** 测某一 poll 档位下，arm 后「就绪→首次 nudge」的延迟（≈一个 poll 周期）。 */
async function measureLatency(pollMs) {
  const h = makeHarness(pollMs)
  const t0 = Date.now()
  const dispose = h.scheduler.arm({ id: 'lead' })
  const deadline = Date.now() + pollMs + 1500
  while (h.nudges.length === 0 && Date.now() < deadline) await sleep(10)
  const latency = h.nudges[0] ? h.nudges[0].at - t0 : -1
  dispose()
  return latency
}

console.log('== 解锁→唤醒 延迟探针（team-scheduler）==\n')

// ── 1) 两档 poll 延迟 ────────────────────────────────────────────────────────
const latTest = await measureLatency(TEST_POLL_MS)
const latProd = await measureLatency(PROD_POLL_MS)
console.log('| poll 档位 | pollMs | 就绪→首次 nudge 延迟 |')
console.log('|---|---|---|')
console.log(`| 测试档 | ${TEST_POLL_MS}ms | ≈ ${latTest}ms |`)
console.log(`| 生产默认档 | ${PROD_POLL_MS}ms | ≈ ${latProd}ms |`)
console.log(
  '\n[结论] **延迟上界 = 一个 poll 周期**（随配置变化，非固定 200ms）：' +
    `测试档 ${TEST_POLL_MS}ms → ${latTest}ms；生产默认 ${PROD_POLL_MS}ms → ${latProd}ms。`,
)
const okTest = latTest >= 0 && latTest <= TEST_POLL_MS + 300
const okProd = latProd >= 0 && latProd <= PROD_POLL_MS + 1500
console.log(okTest && okProd ? '[OK]   两档均 ≤ 一个 poll 周期' : '[WARN] 某档超出预期')

// ── 2) 调度器不存活 ⇒ 解锁不发生（P1 实质风险）────────────────────────────────
{
  const h = makeHarness(TEST_POLL_MS)
  // 不调用 arm()：等价于「调度器未运行」
  await sleep(TEST_POLL_MS + 400)
  console.log('\n[调度器不存活] 未 arm() → 观察窗内 nudge 数 =', h.nudges.length)
  console.log(
    h.nudges.length === 0
      ? '[OK]   调度器不存活 ⇒ 解锁根本不发生（这是 P1 的实质风险，比延迟更重要）'
      : '[WARN] 未 arm 却出现 nudge（不应发生）',
  )
}

// ── 3) push 模式（P31 落地后自动启用）────────────────────────────────────────
{
  const h = makeHarness(TEST_POLL_MS)
  const hasPush = typeof h.scheduler.onTaskTerminal === 'function'
  if (!hasPush) {
    console.log(
      '\n[SKIP] push not yet implemented（P30 后启用：onTaskTerminal / swarm/task/terminal）',
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
    await sleep(20)
    const latency = h.nudges[0] ? h.nudges[0].at - t0 : -1
    console.log(`\n[push] 终态→nudge 延迟 ≈ ${latency}ms`)
    console.log(
      latency >= 0 && latency < TEST_POLL_MS / 2
        ? '[OK]   push 显著快于 poll'
        : '[WARN] push 未显著',
    )
  }
}

console.log('\n✅ 延迟探针完成（两档 poll 上界 + 调度器不存活风险 + push 对比）')
process.exit(0)
