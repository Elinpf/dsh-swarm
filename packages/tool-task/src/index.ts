/**
 * 自建任务看板工具集（P77 收口 (a)）：`swarm_task_create` / `swarm_task_list` / `swarm_task_get` / `swarm_task_update`。
 * **命名防空名遮盖（P77 补丁）**：原生 `team_task_*` 是**成员 scoped**注册，成员 scope 覆盖全局 ⇒ 同名全局注册会被遮盖；故本包用 **`swarm_task_*`** 前缀，确保生效。
 *
 * **为什么自建**：原生 `tool-agent-team` 的 `team_task_*` **直接写 native `agentTeams`、不经 `team-core`**
 * （P74 探针 `docs/verification.md §N.1` 实证：`review_submit → in_review` 后原生 `complete` 仍成功）
 * ⇒ 我们活在 `team-core` 的 **B2 硬闸 / P74 验收闸 / P30 计划闸可被绕过**。
 * 本包把任务写路径**全部经 `ctx.teamCore`**，使闸门**不可绕过**；配合 preset 里 disabled 原生 4 个任务工具（P78）即完成收口。
 *
 * 语义：**复用 `team-core.updateTask` 既有动作集**（claim/release/assign/complete/reopen/set_dependencies/
 * submit_review/reject_review/edit/delete + plan-*），不新增归属机制（不重复 P42），不碰 P49。
 *
 * @module @elinpf/dsh-swarm-tool-task
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 仅为引入契约包的 `ctx.teamCore` 类型增强。
import type { TeamCore as _TeamCore, TaskView } from '@elinpf/dsh-swarm-team-core-contract'

/** cordis 插件名（= row id）。 */
export const name = 'tool-task'

export const inject = ['agents', 'teamCore', 'tools'] as const

/** 本包无需门控（任务工具是收口目标，默认全开）。 */
export interface TaskToolConfig {}

function callerOf(ctx: Context, exec: unknown): Agent {
  const agent = (exec as { agent?: Agent } | undefined)?.agent
  if (agent) return agent
  const agents = ctx.get('agents') as { list?: () => Agent[] } | undefined
  return (agents?.list?.()[0] ?? ({} as Agent)) as Agent
}

/** team-core 的结构化 seam（只取任务写读面）。 */
interface CoreSeam {
  createTask: (
    caller: Agent,
    req: { subject: string; description?: string; blockedBy?: string[] },
  ) => Promise<TaskView>
  getTask: (caller: Agent, id: string) => TaskView
  listTasks: (caller: Agent) => TaskView[]
  updateTask: (caller: Agent, req: Record<string, unknown>) => Promise<TaskView>
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  } satisfies ValueSchemaSpec,
  render: (_args: unknown, value: { text: string }) => [
    { type: 'text' as const, text: value.text },
  ],
}

const csv = (s: unknown): string[] | undefined => {
  if (typeof s !== 'string' || s.trim() === '') return undefined
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

const TASK_ACTIONS = [
  'claim',
  'release',
  'assign',
  'complete',
  'reopen',
  'set_dependencies',
  'submit_review',
  'reject_review',
  'edit',
  'delete',
  'submit_plan',
  'approve_plan',
  'reject_plan',
] as const

function installTools(ctx: Context): Array<() => void> {
  const core = ctx.get('teamCore') as CoreSeam | undefined
  if (!core) return [] // 依赖缺失 → 不注册（降级原则）
  const ds: Array<() => void> = []

  ds.push(
    ctx.tools.register(
      defineTool({
        name: 'swarm_task_create',
        description: 'Create a shared task (routes through team-core; gate-enforced).',
        parameters: {
          subject: { type: 'string', required: true, description: 'Task subject.' },
          description: { type: 'string', description: 'Task description.' },
          blocked_by: {
            type: 'string',
            description: 'Comma-separated blocking task ids (dependencies).',
          },
        },
        output: textOutput,
        async execute(args, exec) {
          const caller = callerOf(ctx, exec)
          const t = await core.createTask(caller, {
            subject: String(args.subject),
            description: args.description ? String(args.description) : undefined,
            blockedBy: csv(args.blocked_by),
          })
          return { text: JSON.stringify(t) }
        },
      }),
    ),
  )

  ds.push(
    ctx.tools.register(
      defineTool({
        name: 'swarm_task_list',
        description: 'List all shared tasks (routes through team-core).',
        parameters: {},
        output: textOutput,
        async execute(_args, exec) {
          return { text: JSON.stringify(core.listTasks(callerOf(ctx, exec))) }
        },
      }),
    ),
  )

  ds.push(
    ctx.tools.register(
      defineTool({
        name: 'swarm_task_get',
        description: 'Get one shared task by id (routes through team-core).',
        parameters: { task_id: { type: 'string', required: true, description: 'Task id.' } },
        output: textOutput,
        async execute(args, exec) {
          return { text: JSON.stringify(core.getTask(callerOf(ctx, exec), String(args.task_id))) }
        },
      }),
    ),
  )

  ds.push(
    ctx.tools.register(
      defineTool({
        name: 'swarm_task_update',
        description:
          'Update a shared task (routes through team-core ⇒ B2/plan gate enforced). Actions: claim/release/assign/complete/reopen/set_dependencies/submit_review/reject_review/edit/delete/submit_plan/approve_plan/reject_plan. NOTE: there is NO cancel/cancelled (same as native); cancel semantics = action=delete (terminal status deleted).',
        parameters: {
          task_id: { type: 'string', required: true, description: 'Task id.' },
          expected_revision: {
            type: 'number',
            required: true,
            description: 'CAS expected revision (from the last read).',
          },
          action: {
            type: 'string',
            required: true,
            description: TASK_ACTIONS.join(' | '),
          },
          owner: { type: 'string', description: 'Owner name (for claim/assign).' },
          subject: { type: 'string', description: 'New subject (for edit).' },
          description: { type: 'string', description: 'New description (for edit).' },
          blocked_by: { type: 'string', description: 'New comma-separated blockers (for edit).' },
          feedback: {
            type: 'string',
            description: 'Rework feedback (for reject_review/reject_plan).',
          },
          plan: { type: 'string', description: 'Plan text (for submit_plan).' },
        },
        output: textOutput,
        async execute(args, exec) {
          const caller = callerOf(ctx, exec)
          const t = await core.updateTask(caller, {
            taskId: String(args.task_id),
            expectedRevision: Number(args.expected_revision),
            action: String(args.action),
            owner: args.owner ? String(args.owner) : undefined,
            subject: args.subject ? String(args.subject) : undefined,
            description: args.description ? String(args.description) : undefined,
            blockedBy: csv(args.blocked_by),
            feedback: args.feedback ? String(args.feedback) : undefined,
            plan: args.plan ? String(args.plan) : undefined,
          })
          return { text: JSON.stringify(t) }
        },
      }),
    ),
  )

  return ds
}

/** 注册工具；一切注册都在 ctx.effect 内，卸载即回滚。 */
export function apply(ctx: Context, _config?: TaskToolConfig): void {
  ctx.effect(() => {
    const ds = installTools(ctx)
    return () => ds.forEach((d) => d())
  }, 'tool-task.tools()')
}
