/**
 * 团队段落装配：把团队策略/角色/下发/入站标签注册为**稳定 section**（进系统提示词前缀），
 * 把身份/roster/团队信息注册为 **cache-safe context**（不进前缀，作为用户消息侧快照）。
 *
 * 渐进披露：在团队尚未建立（还没出现 teammate 成员）前，把「协作约定」两段
 * （`team:dispatch` / `team:task-state`）从装配结果里摘掉，等团队起来再放出来，
 * 避免 Lead 在单 agent 阶段被无用的协作指南占预算（对照 T7 F_76 的渐进披露）。
 *
 * ⚠️ `team:leader`（P54「Leader 只调度不干活」约束）**不参与**渐进披露：
 * 团队未建时也必须渲染——那正是最需要该约束的时刻（P53 结论）。
 *
 * 形态：函数式插件（只注册贡献，无新服务）。只从契约包取类型（ADR-0001）。
 *
 * @module @elinpf/dsh-swarm-team-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
// 仅为引入契约包的 `ctx.teamCore` 类型增强（type-only import 即可生效）。
import type { TeamCore as _TeamCore } from '@elinpf/dsh-swarm-team-core-contract'

/** cordis 插件名（= cordis.patch.yml 的 row id）。 */
export const name = 'team-prompt'

/** 激活前置。 */
export const inject = ['systemPrompt', 'teamCore', 'sessions'] as const

/** 一个稳定 section 的规格。 */
export interface SectionSpec {
  name: string
  order: number
  text: string
}

export interface Config {
  /** 段落语言。 */
  locales: 'cn' | 'en'
  /** 是否对 Lead 做渐进披露（团队建成前隐藏协作约定段）。 */
  leaderProgressiveDisclosure: boolean
  /** 覆盖内置稳定段；为空则用内置常量。 */
  sections: SectionSpec[]
  /**
   * leader 等待模型（P46）：
   * - `event-wake`（默认）：**派发/发消息后结束轮次**，由成员消息唤醒新一轮；不把 `wait_agent` 当默认动作。
   * - `blocking-allowed`：保留「可同步等待」的旧口径（`wait_agent` 仍可用）。
   */
  leaderWaitModel: 'event-wake' | 'blocking-allowed'
}

export const Config: z<Config> = z.object({
  locales: z.union([z.const('cn'), z.const('en')]).default('cn'),
  leaderProgressiveDisclosure: z.boolean().default(true),
  sections: z
    .array(z.object({ name: z.string(), order: z.number(), text: z.string() }))
    .default([]),
  leaderWaitModel: z
    .union([z.const('event-wake'), z.const('blocking-allowed')])
    .default('event-wake'),
})

/** 稳定段名（进前缀）与顺序约定。 */
export const STABLE_SECTION_NAMES = [
  'team:leader',
  'team:role',
  'team:dispatch',
  'team:task-state',
  'team:inbound',
] as const
/** cache-safe context 名（不进前缀）。 */
export const CONTEXT_NAMES = ['team:identity', 'team:roster', 'team:info'] as const

/**
 * 团队建成前延后的段（渐进披露）。
 *
 * ⚠️ `team:leader` **刻意不在**此列表：它承载「Leader 只调度不干活」的身份约束，
 * 必须在**团队尚未建成时**（尚无 teammate 成员）也留在前缀里——那正是最需要它的时刻
 * （P53 结论：把它放进会被过滤的 `team:dispatch` 会在最需要时恰好藏掉约束）。
 */
const DEFERRED_BEFORE_TEAM = ['team:dispatch', 'team:task-state']

/**
 * Leader 专属行为约束（P54，移植自 JiuwenSwarm）。
 *
 * 对齐 Jiuwen 的两处硬约束：
 * - `cn/leader_bootstrap.md:1`（Leader 自己不执行任务）
 * - `cn/leader_policy.md:21-24`（禁止承接执行 / 背景不清先建调研成员 / 没人适合就造一个）
 *
 * 差异：DSH 是"编码代理"persona 且默认行为=自己完成请求（`swarm.patch.yml:15`），
 * 故此处以**负向禁令 + 起手动作**直接点名纠正「自己查资料 / 读代码 / 写报告」。
 *
 * 段为全局注册（所有成员可见），以条件主语「如果你是本团队的 Team Lead」保证语义只对 lead 生效。
 */
function leaderPolicy(locales: 'cn' | 'en'): string {
  return locales === 'cn'
    ? [
        '【如果你是本团队的 Team Lead（lead），以下为强制规则，优先级高于任何"直接完成任务"的默认倾向】',
        '1. 你不亲自执行任务：调研、执行、整合、撰写产物一律交给成员——不要因为"顺手就做了"而自己查资料、读代码、写报告。',
        '2. 先建成员、先建任务，再动手：任何工作开始前，先用 spawn_teammate 建立对口成员、用 team_task_create 建好任务；成员必须先于任务存在，每个任务都要落到具体成员头上。',
        '3. 背景不清先建专职调研成员：若缺背景（代码库现状、领域知识、外部资料），不要自己去查——先让一名专职调研成员承担该调研并把结论沉淀成文件，你基于该文件再规划。',
        '若你发现自己正要"自己动手完成用户请求"，停下，改为派成员。',
      ].join('\n')
    : [
        "[If you are this team's Team Lead (lead), the following rules are mandatory and override any default urge to just finish the request yourself]",
        '1. You do not carry out the work yourself: research, execution, integration, and authoring deliverables all go to members — do not look things up, read code, or write reports yourself "because it was quicker".',
        '2. Spawn members and create tasks first, then act: before any work starts, use spawn_teammate to create the fitting members and team_task_create to create the tasks; members must exist before tasks, and every task must land on a named member.',
        '3. When the background is unclear, spawn a dedicated research member first: if you lack background (codebase state, domain knowledge, external material), do NOT dig it up yourself — have a dedicated research member own it and distil the findings into a file, then plan from that file.',
        'If you catch yourself about to "just do the user\'s request yourself", stop and delegate instead.',
      ].join('\n')
}

function builtinSections(
  locales: 'cn' | 'en',
  leaderWaitModel: 'event-wake' | 'blocking-allowed' = 'event-wake',
): SectionSpec[] {
  const cn = locales === 'cn'
  return [
    {
      name: 'team:leader',
      order: 10,
      text: leaderPolicy(locales),
    },
    {
      name: 'team:role',
      order: 11,
      text: cn
        ? '你是团队的一员：与队友通过消息与共享任务看板协作。'
        : 'You are a team member: collaborate via messages and the shared task board.',
    },
    {
      name: 'team:dispatch',
      order: 15,
      text: cn
        ? leaderWaitModel === 'event-wake'
          ? '就绪任务由调度器派发；你也可主动认领。**派发或发消息后请结束你的轮次**：成员的消息会唤醒你开新一轮，优先用事件唤醒；**不要用 wait_agent 长阻塞等待**（仅当同一轮必须同步聚合多个成员结果时才用 wait_agent）。只处理发给你的消息/含你的广播。'
          : '就绪任务由调度器派发；你也可主动认领。如需同步等待队友结果，可用 wait_agent（可选）。'
        : leaderWaitModel === 'event-wake'
        ? 'Ready tasks are dispatched by the scheduler; you may also claim them. **After dispatching or messaging, end your turn**: teammate messages wake you into a new turn (event-wake first); do NOT block on wait_agent (use it only when the same turn must aggregate multiple teammates synchronously). Act only on messages addressed to you (or broadcasts that include you).'
        : 'Ready tasks are dispatched by the scheduler; you may also claim them. You may use wait_agent (optional) to wait synchronously for teammates.',
    },
    {
      name: 'team:task-state',
      order: 16,
      text: cn
        ? '关注任务状态流转（pending → in_progress → completed）。'
        : 'Track task state transitions (pending → in_progress → completed).',
    },
    {
      name: 'team:inbound',
      order: 18,
      text: cn
        ? '入站消息会以标签标注来源，请按来源区分处理。'
        : 'Inbound messages are tagged by source; handle accordingly.',
    },
  ]
}

/** 注册团队段落；一切注册都在 ctx.effect 内，卸载即回滚。 */
export function apply(ctx: Context, config: Config): void {
  const specs =
    config.sections.length > 0
      ? config.sections
      : builtinSections(config.locales, config.leaderWaitModel)

  ctx.effect(() => {
    // 渐进披露状态：观察到 teammate 成员即视为「团队已建立」。
    let teamBuilt = false
    const offMember = ctx.on('session/event', (_session: unknown, ev: unknown) => {
      const e = ev as { type?: string; data?: { role?: string } }
      if (e?.type === 'team/member' && e.data?.role === 'teammate') teamBuilt = true
    })

    const disposers: Array<() => void> = []
    for (const s of specs) {
      disposers.push(ctx.systemPrompt.section({ name: s.name, order: s.order, text: s.text }))
    }
    disposers.push(
      ctx.systemPrompt.context({
        name: 'team:identity',
        order: 10,
        text: 'You are a team member.',
      }),
      ctx.systemPrompt.context({ name: 'team:roster', order: 20, text: '' }),
      ctx.systemPrompt.context({ name: 'team:info', order: 30, text: 'dsh-swarm' }),
    )

    const offAssemble = ctx.on(
      'system-prompt/assemble',
      async (
        _assembly: PromptAssembly,
        _context: unknown,
        next: () => Promise<PromptAssembly>,
      ): Promise<PromptAssembly> => {
        const result = await next()
        if (!config.leaderProgressiveDisclosure || teamBuilt) return result
        return {
          ...result,
          sections: result.sections.filter((sec) => !DEFERRED_BEFORE_TEAM.includes(sec.name)),
        }
      },
    )

    return () => {
      disposers.forEach((d) => d())
      offAssemble()
      offMember()
    }
  }, 'team-prompt.sections()')
}
