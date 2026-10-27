#!/usr/bin/env node
/**
 * 原生接通回归（P22）——零模型成本、确定性。
 *
 * 复现真实 profile 的**服务就绪时序**：`team-core` 的注入依赖（agents/sessions/subagents）先就绪，
 * 而 `agentTeams`（原生 TeamService，额外依赖 sessionPersistence/sessionProjections）稍后发布。
 * 断言：团队栈在 `agentTeams` 后发布时**也必须接通**（否则 team-core 静默 no-op，真实 profile 下
 * `team_summary` 恒为 members=0）。
 *
 * 修复前：STEP2 active=false → RESULT: FAIL（红）。修复后：active=true → PASS。
 * 用法：`pnpm verify:wiring`（需先 build）。
 */
import { Context } from '@deepseek-ai/cordis'
import TeamCore from '../packages/team-core/lib/index.js'

const root = new Context()
root.provide('agents', { list: () => [] })
root.provide('sessions', {})
root.provide('subagents', {})

await root.plugin(TeamCore, {
  backend: 'auto',
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
})
const core = root.get('teamCore')

// 稍后提供 agentTeams，模拟原生 TeamService 晚于 team-core 就绪
root.provide('agentTeams', {
  membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
  tryMembership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
  listMembers: () => [{ id: 'alice', name: 'alice', role: 'teammate', status: 'running' }],
  listTasks: () => [],
})
await new Promise((r) => setTimeout(r, 20))

const members = core.active ? core.listMembers({ id: 'lead' }) : []
const ok = core.active && members.length === 1
console.log(`[wiring] active=${core.active} members=${members.length}`)
console.log(
  ok ? '✅ 原生接通回归通过' : '❌ 原生未接通（team-core 走 no-op）——见 docs/verification.md P22',
)
process.exit(ok ? 0 : 1)
