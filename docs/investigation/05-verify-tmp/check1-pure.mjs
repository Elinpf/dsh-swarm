// auditor check-1: 对运行副本已构建 lib 的纯函数断言（不依赖 harness 测试装置）
// 运行: node investigation/05-verify-tmp/check1-pure.mjs
import assert from 'node:assert/strict'

const BASE = new URL(
  '../../.runtime/dsh-home/profiles/dsh-swarm-demo/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/',
  import.meta.url,
)
const { assertTaskGraphCandidate, TeamTaskGraphError } = await import(
  new URL('task-graph.js', BASE)
)
const { projectTaskView, taskReady } = await import(new URL('task-view.js', BASE))

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push(['PASS', name])
  } catch (e) {
    results.push(['FAIL', name + ' :: ' + (e?.message ?? e)])
  }
}
const task = (id, patch = {}) => ({
  id,
  revision: 1,
  subject: 's',
  description: 'd',
  status: 'pending',
  blockedBy: [],
  writeScopes: [],
  ...patch,
})
const violationOf = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof TeamTaskGraphError) return e.violation
    return 'not-TeamTaskGraphError:' + e.message
  }
}

check('task-graph: 自阻塞 -> cycle', () => {
  assert.equal(
    violationOf(() => assertTaskGraphCandidate([], task('task-1', { blockedBy: ['task-1'] }))),
    'cycle',
  )
})
check('task-graph: 重复 blocker -> duplicate', () => {
  assert.equal(
    violationOf(() =>
      assertTaskGraphCandidate(
        [task('task-1')],
        task('task-2', { blockedBy: ['task-1', 'task-1'] }),
      ),
    ),
    'duplicate',
  )
})
check('task-graph: 缺失 blocker -> missing', () => {
  assert.equal(
    violationOf(() => assertTaskGraphCandidate([], task('task-1', { blockedBy: ['nope'] }))),
    'missing',
  )
})
check('task-graph: deleted blocker 等同 missing', () => {
  assert.equal(
    violationOf(() =>
      assertTaskGraphCandidate(
        [task('task-1', { status: 'deleted' })],
        task('task-2', { blockedBy: ['task-1'] }),
      ),
    ),
    'missing',
  )
})
check('task-graph: 两节点环 -> cycle', () => {
  const a = task('task-1', { blockedBy: ['task-2'] })
  const b = task('task-2', { blockedBy: ['task-1'] })
  assert.equal(
    violationOf(() => assertTaskGraphCandidate([a], b)),
    'cycle',
  )
})
check('task-graph: 合法 DAG 不抛', () => {
  const a = task('task-1')
  const b = task('task-2', { blockedBy: ['task-1'] })
  assert.equal(
    violationOf(() => assertTaskGraphCandidate([a, b], task('task-3', { blockedBy: ['task-2'] }))),
    null,
  )
})

check('taskReady: 仅 completed blocker 满足', () => {
  const blocker = task('task-1', { status: 'completed' })
  const t = task('task-2', { blockedBy: ['task-1'] })
  assert.equal(taskReady({ tasks: [blocker, t] }, t), true)
  const inProgress = task('task-1', { status: 'in_progress' })
  assert.equal(taskReady({ tasks: [inProgress, t] }, t), false)
  const deleted = task('task-1', { status: 'deleted' })
  assert.equal(taskReady({ tasks: [deleted, t] }, t), false)
})

const state = (tasks, members = [], id = 'root-id') => ({ id, members, tasks })

check('view.ready = pending && 全部 blocker completed', () => {
  const blocker = task('task-1', { status: 'completed' })
  const pending = task('task-2', { blockedBy: ['task-1'] })
  const inProg = task('task-3', { blockedBy: ['task-1'], status: 'in_progress', ownerId: 'm1' })
  assert.equal(projectTaskView(state([blocker, pending]), pending).ready, true)
  assert.equal(projectTaskView(state([blocker, inProg]), inProg).ready, false)
})

// 实测语义：过滤条件作用在“兄弟任务”上（other.status !== 'in_progress'），
// 与“被查看任务”自身状态无关；pending 任务只要与 in_progress 兄弟重叠同样告警。
check('view.writeScopeWarnings 由 in_progress 兄弟任务触发（含 pending 主体）', () => {
  const a = task('task-1', { status: 'in_progress', writeScopes: ['src'] })
  const b = task('task-2', { writeScopes: ['src/nested'] }) // 主体 pending -> 仍告警
  assert.deepEqual(projectTaskView(state([a, b]), b).writeScopeWarnings, [
    'write scopes overlap with task-1',
  ])
  const c = task('task-3', { status: 'in_progress', writeScopes: ['src/nested'] })
  assert.deepEqual(projectTaskView(state([a, c]), c).writeScopeWarnings, [
    'write scopes overlap with task-1',
  ])
  const d = task('task-4', { status: 'in_progress', writeScopes: ['docs'] }) // 不重叠
  assert.deepEqual(projectTaskView(state([a, d]), d).writeScopeWarnings, [])
})

check('scopesOverlap 按路径段：src 与 srclib 不重叠', () => {
  const a = task('task-1', { status: 'in_progress', writeScopes: ['src'] })
  const b = task('task-2', { status: 'in_progress', writeScopes: ['srclib'] })
  assert.deepEqual(projectTaskView(state([a, b]), b).writeScopeWarnings, [])
})

check('ownerName: ownerId === state.id -> lead，未知 owner 省略字段', () => {
  const leadOwned = task('task-1', { status: 'in_progress', ownerId: 'root-id' })
  assert.equal(projectTaskView(state([leadOwned]), leadOwned).ownerName, 'lead')
  const member = { id: 'm1', name: 'worker-a' }
  const mOwned = task('task-2', { status: 'in_progress', ownerId: 'm1' })
  assert.equal(projectTaskView(state([mOwned], [member]), mOwned).ownerName, 'worker-a')
  const dangling = task('task-3', { status: 'in_progress', ownerId: 'ghost' })
  assert.equal('ownerName' in projectTaskView(state([dangling]), dangling), false)
})

for (const [s, n] of results) console.log(s.padEnd(4), n)
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\ncheck1: ${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
