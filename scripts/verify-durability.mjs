#!/usr/bin/env node
/**
 * 内存态持久化诊断（P23）——**非发布门禁**。
 *
 * 模拟：置入「必须持久」的状态 → **重建服务（模拟重启/新会话）** → `recover(durable 事件)` → 断言状态仍在。
 *
 * 修复前（阶段 0/1/2 无任何 durable 依赖）：重建后状态丢失 → 红。
 * 修复后（ADR-0002：emit durable + recover fold）：折叠后恢复 → 绿。
 * 详见 docs/state-durability.md 与 docs/adr/0002-durable-state-convention.md。
 *
 * 用法：`pnpm verify:durability`（需先 build）。
 */
import { Context } from '@deepseek-ai/cordis'
import TeamCore from '../packages/team-core/lib/index.js'

const agent = { id: 'lead' }
const DURABLE_TYPES = ['swarm/core/review-entered', 'swarm/core/review-left']

// 原生任务存储：跨「重启」保留（模拟 durable 的原生 session 日志）
const store = {
  t1: {
    id: 't1',
    revision: 0,
    subject: 's',
    description: '',
    status: 'in_progress',
    blockedBy: [],
    ready: false,
    ownerName: 'w',
  },
}
const seam = {
  membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
  tryMembership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
  listMembers: () => [],
  spawnTeammate: async () => ({ member: {} }),
  sendMessage: async () => ({ messageId: 'm' }),
  createTask: async (_c, r) => ({ ...store.t1, ...r }),
  getTask: (_c, id) => ({ ...store[id] }),
  listTasks: () => Object.values(store).map((t) => ({ ...t })),
  updateTask: async (_c, r) => {
    const t = store[r.taskId]
    if (r.action === 'complete') t.status = 'completed'
    else if (r.action === 'reopen') t.status = 'in_progress'
    return { ...t }
  },
  waitForChange: async () => ({ timedOut: false }),
  interrupt: () => ({ previousStatus: 'running' }),
}

/** Boot 一个 team-core；`captured` 非空时收集其 durable 事件。 */
async function boot(captured) {
  const root = new Context()
  root.provide('agents', { list: () => [] })
  root.provide('sessions', {})
  root.provide('subagents', {})
  root.provide('agentTeams', seam)
  if (captured) {
    for (const t of DURABLE_TYPES) root.on(t, (payload) => captured.push({ type: t, payload }))
  }
  await root.plugin(TeamCore, {
    backend: 'auto',
    maxMembers: 8,
    maxTasks: 256,
    maxMessageBytes: 65536,
  })
  return root.get('teamCore')
}

// 会话 1：进入评审（in_progress → in_review），收集 durable 事件
const captured = []
const c1 = await boot(captured)
await c1.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' })
const before = c1.getTask(agent, 't1').status

// 重建服务 = 模拟重启/新会话（原生 store 仍在）
const c2 = await boot(undefined)
const lostUnlessRecover = c2.getTask(agent, 't1').status // 未恢复
c2.recover(captured) // 折叠 durable 事件
const afterRecover = c2.getTask(agent, 't1').status

console.log(
  `[durability] team-core in_review: before=${before} | after-restart(no-recover)=${lostUnlessRecover} | after-recover=${afterRecover}`,
)
console.log(`[durability] captured durable events = ${captured.map((e) => e.type).join(', ')}`)
const ok = before === 'in_review' && afterRecover === 'in_review'
console.log(
  ok
    ? '✅ 内存态经 durable 事件折叠后跨重启保持（ADR-0002）'
    : '❌ 内存态重启丢失——见 docs/state-durability.md',
)
process.exit(ok ? 0 : 1)
