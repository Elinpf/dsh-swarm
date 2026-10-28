import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

/**
 * 假 ctx：捕获注册的工具；teamCore 模拟「B2 硬闸」——`in_review` 时 `complete` 抛 TEAMCORE_REVIEW_REQUIRED。
 * 这验证：**我们的任务工具经 team-core ⇒ 闸门不可绕过**（对照原生工具直写 agentTeams 的 §N.1 红态）。
 */
function makeCtx() {
  const tools: any[] = []
  const state: any = {
    id: 't1',
    revision: 0,
    subject: 's',
    description: '',
    status: 'pending',
    blockedBy: [],
    ready: true,
  }
  const teamCore = {
    createTask: async (_c: unknown, req: any) => {
      Object.assign(state, { subject: req.subject, description: req.description ?? '' })
      return { ...state }
    },
    getTask: () => ({ ...state }),
    listTasks: () => [{ ...state }],
    updateTask: async (_c: unknown, req: any) => {
      if (req.action === 'claim') state.status = 'in_progress'
      else if (req.action === 'submit_review') state.status = 'in_review'
      else if (req.action === 'complete') {
        // B2 硬闸（team-core 行为）：in_review 时禁止直接 complete
        if (state.status === 'in_review') {
          throw new Error(
            'TEAMCORE_REVIEW_REQUIRED: task t1 is in_review; complete must go through review settle',
          )
        }
        state.status = 'completed'
      }
      state.revision += 1
      return { ...state }
    },
  }
  const agent = { id: 'lead', name: 'lead' }
  const ctx: any = {
    get: (n: string) =>
      n === 'teamCore' ? teamCore : n === 'agents' ? { list: () => [agent] } : undefined,
    tools: {
      register: (t: any) => {
        tools.push(t)
        return () => {
          const i = tools.indexOf(t)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
    effect: (fn: () => unknown) => fn(),
    logger: { warn() {}, debug() {}, info() {} },
  }
  return { ctx, tools, teamCore, agent, state }
}

const run = (tools: any[], name: string, args: any, agent: unknown) =>
  tools.find((t) => t.name === name).execute(args, { agent })

describe('@elinpf/dsh-swarm-tool-task（P77 收口 (a)）', () => {
  it('注册 4 个任务工具（team_task_create/list/get/update）', () => {
    const { ctx, tools } = makeCtx()
    plugin.apply(ctx)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'team_task_create',
      'team_task_get',
      'team_task_list',
      'team_task_update',
    ])
  })

  it('全走 team-core：create/list/get 路由正确', async () => {
    const { ctx, tools, agent } = makeCtx()
    plugin.apply(ctx)
    const created = JSON.parse((await run(tools, 'team_task_create', { subject: 'x' }, agent)).text)
    expect(created.subject).toBe('x')
    const list = JSON.parse((await run(tools, 'team_task_list', {}, agent)).text)
    expect(list.length).toBe(1)
    const got = JSON.parse((await run(tools, 'team_task_get', { task_id: 't1' }, agent)).text)
    expect(got.id).toBe('t1')
  })

  it('★先红后绿（收口）：claim→review_submit(→in_review) 后 update(complete) 被 TEAMCORE_REVIEW_REQUIRED 拦住', async () => {
    const { ctx, tools, agent, state } = makeCtx()
    plugin.apply(ctx)
    await run(
      tools,
      'team_task_update',
      { task_id: 't1', expected_revision: 0, action: 'claim' },
      agent,
    )
    await run(
      tools,
      'team_task_update',
      { task_id: 't1', expected_revision: 1, action: 'submit_review' },
      agent,
    )
    expect(state.status).toBe('in_review')
    // 收口后：我们的工具经 team-core ⇒ complete 被闸门拦（对照原生工具直写 agentTeams 的绕过）
    await expect(
      run(
        tools,
        'team_task_update',
        { task_id: 't1', expected_revision: 2, action: 'complete' },
        agent,
      ),
    ).rejects.toThrow(/REVIEW_REQUIRED/)
  })

  it('兼容：assign(owner)/set_dependencies(blocked_by) 经 team-core 传参', async () => {
    const { ctx, tools, agent, state } = makeCtx()
    plugin.apply(ctx)
    state.status = 'pending'
    await run(
      tools,
      'team_task_update',
      { task_id: 't1', expected_revision: 0, action: 'assign', owner: 'w' },
      agent,
    )
    expect(state.revision).toBe(1)
  })
})
