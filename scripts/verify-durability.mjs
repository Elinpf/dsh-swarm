#!/usr/bin/env node
/**
 * 内存态持久化诊断（P23）——**非发布门禁**，用于暴露「重启后必须持久的状态是否还在」。
 *
 * 模拟：置入「必须持久」的状态 → **重建服务（模拟重启/新会话）** → 断言状态仍在。
 * 现状（阶段 0/1/2 无任何 storage/durable 依赖）：**除阶段 3 的 recover() 外全部丢失** → 本脚本红。
 * 修复（对齐「durable 事件即真相」的 fold）后应变绿；详见 docs/state-durability.md。
 *
 * 用法：`pnpm verify:durability`（需先 build）。
 */
import { Context } from '@deepseek-ai/cordis'
import TeamCore from '../packages/team-core/lib/index.js'

const agent = { id: 'lead' }

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

async function boot() {
  const root = new Context()
  root.provide('agents', { list: () => [] })
  root.provide('sessions', {})
  root.provide('subagents', {})
  root.provide('agentTeams', seam)
  await root.plugin(TeamCore, {
    backend: 'auto',
    maxMembers: 8,
    maxTasks: 256,
    maxMessageBytes: 65536,
  })
  return root.get('teamCore')
}

// 会话 1：进入评审（in_progress → in_review）
const c1 = await boot()
await c1.updateTask(agent, { taskId: 't1', expectedRevision: 0, action: 'submit_review' })
const before = c1.getTask(agent, 't1').status

// 重建服务 = 模拟重启/新会话（原生 store 仍在）
const c2 = await boot()
const after = c2.getTask(agent, 't1').status

console.log(`[durability] team-core in_review: before-restart=${before} after-restart=${after}`)
const ok = before === 'in_review' && after === 'in_review'
console.log(
  ok
    ? '✅ in_review 跨重启保持'
    : '❌ in_review 重启丢失（退化为 in_progress）——媒体态未持久化，见 docs/state-durability.md §2',
)
process.exit(ok ? 0 : 1)
