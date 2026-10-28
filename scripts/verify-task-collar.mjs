// P78 收口探针（零模型）：任务写路径 guard 覆盖实证。
// - 模型可见工具表（成员 scoped 可见面）
// - guard 执行拒绝：member / leader / **后创建成员** 调 team_task_update 均被拒；swarm_task_update 与 list_agents 放行
// - ②「对端进程」桩：另起一个 cordis Context 加载同一 guard（模拟对端进程加载 tool-swarm）→ 其 agent 亦被拒
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { fileURLToPath } from 'node:url'

const { installTaskCollar } = await import(
  fileURLToPath(new URL('../packages/tool-swarm/lib/task-collar.js', import.meta.url))
)

let fail = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  fail++
  console.error(`[FAIL] ${m}`)
}
const assert = (c, m) => (c ? ok(m) : bad(m))

const def = (name) =>
  defineTool({
    name,
    description: `${name} tool`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true } },
      },
      render: () => [],
    },
    async execute() {
      return { ok: true }
    },
  })

/** 起一个「进程」：真 cordis + dsh-tools + 我们的工具 + 原生（scoped）+ tool-swarm 的 global guard。 */
async function spawnProcess() {
  const root = new Context()
  root.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    context: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
  })
  await root.plugin(ToolRuntime)
  const R = root.get('tools')
  R.register(def('swarm_task_update'))
  const off = installTaskCollar({ get: (n) => (n === 'tools' ? R : undefined) })
  return { root, R, off }
}

const A = await spawnProcess()
const member = { id: 'm1' }
const leader = { id: 'lead' }
const mScope = createScope(A.root, member)
mScope.ctx.get('tools').register(def('team_task_update')) // 模拟原生 tool-agent-team 的成员 scoped 注册
mScope.ctx.get('tools').register(def('list_agents'))
createScope(A.root, leader)

console.log('== 模型可见工具表（成员 scoped 可见面）==')
console.log('member visible:', [...A.R.view(member).visible.keys()].sort())

const deny = (R, a, n) => R.guardReason({ agent: a, name: n })
const lateMember = { id: 'm-late' } // 安装 guard 之后才创建的成员

assert(deny(A.R, member, 'team_task_update') !== undefined, 'member 调 team_task_update → 被拒')
assert(deny(A.R, leader, 'team_task_update') !== undefined, 'leader 调 team_task_update → 被拒')
assert(
  deny(A.R, lateMember, 'team_task_update') !== undefined,
  '④ 后创建成员 m-late 调 team_task_update → 被拒（结构论证升级为实测）',
)
assert(deny(A.R, member, 'list_agents') === undefined, 'list_agents 放行')
assert(deny(A.R, member, 'swarm_task_update') === undefined, 'swarm_task_update 放行')

// ── 进程 B（对端进程桩）：独立 Context 加载同一 guard → 其 agent 亦被拒 ─────────
const B = await spawnProcess()
assert(
  deny(B.R, { id: 'peer-member' }, 'team_task_update') !== undefined,
  '② 对端进程桩：另一 Context 挂 guard 后其成员调 team_task_update → 被拒',
)
assert(
  deny(B.R, { id: 'peer-member' }, 'swarm_task_update') === undefined,
  '② 对端进程桩：swarm_task_update 放行',
)

A.off()
B.off()
console.log(
  fail === 0 ? '\n✅ task-collar 收口探针 PASS' : `\n❌ task-collar 收口探针 FAIL：${fail} 项`,
)
process.exit(fail === 0 ? 0 : 1)
