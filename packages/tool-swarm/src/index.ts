/**
 * 把 `team-bus` / `team-review` / `team-core` 的**增量能力**暴露为模型工具
 * （DSH 原生 `tool-agent-team` 没有的部分）：broadcast / multicast / review_submit /
 * review_vote / team_summary。
 *
 * 降级原则：某依赖服务缺失 → 对应工具**不注册**（而非注册后报错）；
 * `enableReview=false` 时不暴露评审工具。
 *
 * 只依赖契约包类型（ADR-0001）。
 *
 * @module @elinpf/dsh-swarm-tool-swarm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
// 仅为引入契约包的 `ctx.teamCore` 类型增强。
import type { TeamCore as _TeamCore, TaskView } from '@elinpf/dsh-swarm-team-core-contract'

/** cordis 插件名（= cordis.patch.yml 的 row id）。 */
export const name = 'tool-swarm'

export const inject = [
  'agents',
  'teamCore',
  'teamBus',
  'teamReview',
  'tools',
  'systemPrompt',
] as const

export interface SwarmToolConfig {
  /** 是否暴露 broadcast/multicast（需 teamBus）。 */
  enableBroadcast: boolean
  /** 是否暴露 review_submit/review_vote（需 teamReview + 已配评审池）。 */
  enableReview: boolean
  /** 阶段2：是否暴露 workspace_lock/unlock/worktree（需 teamWorkspace）。 */
  enableWorkspace: boolean
  /** 阶段2：是否暴露 skills_visible（需 teamSkills）。 */
  enableSkills: boolean
  /** 阶段2：是否暴露 memory_recall（需 teamMemory）。 */
  enableMemory: boolean
}

export const Config: z<SwarmToolConfig> = z.object({
  enableBroadcast: z.boolean().default(true),
  enableReview: z.boolean().default(false),
  enableWorkspace: z.boolean().default(false),
  enableSkills: z.boolean().default(false),
  enableMemory: z.boolean().default(false),
})

/** 统一的文本输出契约（schema 的属性级 required，符合真实 value schema DSL）。 */
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

function callerOf(ctx: Context, exec: unknown): Agent {
  const agent = (exec as { agent?: Agent } | undefined)?.agent
  if (agent) return agent
  // 退化：取 agents 注册表里的第一个（测试/无 agent 上下文时）。
  const agents = ctx.get('agents') as { list?: () => Agent[] } | undefined
  const first = agents?.list?.()[0]
  return (first ?? ({} as Agent)) as Agent
}

/** 注册全部可得工具；返回 disposer 列表（外层 effect 负责回滚）。 */
function installTools(ctx: Context, config: SwarmToolConfig): Array<() => void> {
  const ds: Array<() => void> = []
  const bus = ctx.get('teamBus') as
    | { broadcast: (...a: unknown[]) => unknown; multicast: (...a: unknown[]) => unknown }
    | undefined
  const review = ctx.get('teamReview') as
    | { submitForReview: (...a: unknown[]) => unknown; vote: (...a: unknown[]) => unknown }
    | undefined
  const core = ctx.get('teamCore') as
    | { listTasks: (...a: unknown[]) => unknown; listMembers: (...a: unknown[]) => unknown }
    | undefined
  const ws = ctx.get('teamWorkspace') as
    | {
        acquireLock: (...a: unknown[]) => Promise<{ id: string; mode: string; path: string }>
        releaseLock: (...a: unknown[]) => Promise<void>
        createWorktree: (...a: unknown[]) => Promise<{ path: string }>
      }
    | undefined
  const skills = ctx.get('teamSkills') as
    | { visibleTo: (...a: unknown[]) => string[] | 'unrestricted' }
    | undefined
  const mem = ctx.get('teamMemory') as
    | { recall: (...a: unknown[]) => Array<{ text: string }> }
    | undefined

  if (config.enableBroadcast && bus) {
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'broadcast',
          description: 'Broadcast a message to the whole team (sender filtered out).',
          parameters: {
            content: { type: 'string', required: true, description: 'Message text.' },
            topic: { type: 'string', description: 'team | task | message | announce' },
            delivery: { type: 'string', description: 'quiet | wakeup (default wakeup)' },
            fanout: {
              type: 'string',
              description:
                "dm | record-only (default dm). 'record-only' = 仅落库、不逐人唤醒，成员按需拉取（公告类）。",
            },
          },
          output: textOutput,
          async execute(args, exec) {
            const caller = callerOf(ctx, exec)
            const res = (await bus.broadcast(caller, {
              topic: (args.topic as string | undefined) ?? 'team',
              content: [{ type: 'text', text: String(args.content) }],
              delivery: (args.delivery as 'quiet' | 'wakeup' | undefined) ?? 'wakeup',
              fanout: (args.fanout as 'dm' | 'record-only' | undefined) ?? 'dm',
            })) as { messageId: string }
            return { text: `broadcast sent: ${res.messageId}` }
          },
        }),
      ),
    )
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'multicast',
          description: 'Send a message to specific teammates (comma-separated names).',
          parameters: {
            targets: {
              type: 'string',
              required: true,
              description: 'Comma-separated member names.',
            },
            content: { type: 'string', required: true, description: 'Message text.' },
            delivery: { type: 'string', description: 'quiet | wakeup' },
          },
          output: textOutput,
          async execute(args, exec) {
            const caller = callerOf(ctx, exec)
            const targets = String(args.targets)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
            const res = (await bus.multicast(caller, {
              targets,
              content: [{ type: 'text', text: String(args.content) }],
              delivery: (args.delivery as 'quiet' | 'wakeup' | undefined) ?? 'wakeup',
            })) as { messageId: string }
            return { text: `multicast sent: ${res.messageId}` }
          },
        }),
      ),
    )
  }

  if (config.enableReview && review) {
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'review_submit',
          description: 'Submit a task for review (blocks direct completion).',
          parameters: { task_id: { type: 'string', required: true, description: 'Task id.' } },
          output: textOutput,
          async execute(args, exec) {
            const caller = callerOf(ctx, exec)
            const view = (await review.submitForReview(caller, String(args.task_id))) as TaskView
            return { text: `task ${view.id} under review (status=${view.status})` }
          },
        }),
      ),
    )
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'review_vote',
          description: 'Cast a review vote (binary pass/fail, or a score).',
          parameters: {
            task_id: { type: 'string', required: true, description: 'Task id.' },
            role: {
              type: 'string',
              required: true,
              description: 'verifier | challenger | inspector',
            },
            decision: { type: 'string', description: 'pass | fail (binary)' },
            value: { type: 'number', description: '0..1 score (inspector)' },
          },
          output: textOutput,
          async execute(args, exec) {
            const caller = callerOf(ctx, exec)
            const role = String(args.role)
            const vote =
              args.value !== undefined
                ? { kind: 'score' as const, value: Number(args.value), role }
                : {
                    kind: 'binary' as const,
                    decision:
                      String(args.decision) === 'fail' ? ('fail' as const) : ('pass' as const),
                    role,
                  }
            await review.vote(caller, String(args.task_id), vote)
            return { text: `vote recorded for ${String(args.task_id)}` }
          },
        }),
      ),
    )
  }

  if (core) {
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'team_summary',
          description: 'Summarize the team: members and task board.',
          parameters: {},
          output: textOutput,
          async execute(_args, exec) {
            const caller = callerOf(ctx, exec)
            const tasks = core.listTasks(caller) as TaskView[]
            const members = core.listMembers(caller) as Array<{ name: string; status: string }>
            const byStatus = tasks.reduce<Record<string, number>>((acc, t) => {
              acc[t.status] = (acc[t.status] ?? 0) + 1
              return acc
            }, {})
            const t = Object.entries(byStatus)
              .map(([k, v]) => `${k}=${v}`)
              .join(',')
            return { text: `members=${members.length}; tasks=${tasks.length}${t ? ` (${t})` : ''}` }
          },
        }),
      ),
    )
  }

  if (config.enableWorkspace && ws) {
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'workspace_lock',
          description: 'Acquire a write-scope lock on a path (exclusive|shared).',
          parameters: {
            path: { type: 'string', required: true, description: 'Path prefix to lock.' },
            mode: { type: 'string', description: 'exclusive (default) | shared' },
          },
          output: textOutput,
          async execute(args, exec) {
            const caller = callerOf(ctx, exec)
            const h = await ws.acquireLock(caller, {
              path: String(args.path),
              mode: String(args.mode) === 'shared' ? 'shared' : 'exclusive',
            })
            return { text: `locked ${h.id} (${h.mode}) ${h.path}` }
          },
        }),
      ),
    )
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'workspace_unlock',
          description: 'Release a previously acquired write-scope lock.',
          parameters: { lock_id: { type: 'string', required: true, description: 'Lock id.' } },
          output: textOutput,
          async execute(args, exec) {
            const caller = callerOf(ctx, exec)
            await ws.releaseLock(caller, { id: String(args.lock_id) })
            return { text: `released ${String(args.lock_id)}` }
          },
        }),
      ),
    )
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'workspace_worktree',
          description: 'Create/enter an isolated worktree for the calling member.',
          parameters: {},
          output: textOutput,
          async execute(_args, exec) {
            const caller = callerOf(ctx, exec)
            const rec = await ws.createWorktree(caller)
            return { text: `worktree at ${rec.path}` }
          },
        }),
      ),
    )
  }

  if (config.enableSkills && skills) {
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'skills_visible',
          description: 'List skill names visible to the calling member.',
          parameters: {},
          output: textOutput,
          async execute(_args, exec) {
            const caller = callerOf(ctx, exec)
            const v = skills.visibleTo(caller)
            return { text: v === 'unrestricted' ? 'unrestricted' : v.join(', ') || '(none)' }
          },
        }),
      ),
    )
  }

  if (config.enableMemory && mem) {
    ds.push(
      ctx.tools.register(
        defineTool({
          name: 'memory_recall',
          description: 'Recall shared team memory plus your own private notes.',
          parameters: {},
          output: textOutput,
          async execute(_args, exec) {
            const caller = callerOf(ctx, exec)
            const recs = mem.recall(caller)
            return { text: recs.map((r) => r.text).join('\n') || '(empty)' }
          },
        }),
      ),
    )
  }

  return ds
}

/** 注册工具；一切注册都在 ctx.effect 内，卸载即回滚。 */
export function apply(ctx: Context, config: SwarmToolConfig): void {
  ctx.effect(() => {
    const ds = installTools(ctx, config)
    return () => ds.forEach((d) => d())
  }, 'tool-swarm.tools()')
}
