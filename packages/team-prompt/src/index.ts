/**
 * 团队段落装配：把团队策略/角色/下发/入站标签注册为**稳定 section**（进系统提示词前缀），
 * 把身份/roster/团队信息注册为 **cache-safe context**（不进前缀，作为用户消息侧快照）。
 *
 * 渐进披露：在团队尚未建立（还没出现 teammate 成员）前，把「协作约定」两段
 * （`team:dispatch` / `team:task-state`）从装配结果里摘掉，等团队起来再放出来，
 * 避免 Lead 在单 agent 阶段被无用的协作指南占预算（对照 T7 F_76 的渐进披露）。
 *
 * 形态：函数式插件（只注册贡献，无新服务）。只从契约包取类型（ADR-0001）。
 *
 * @module @dsh-swarm/team-prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
// 仅为引入契约包的 `ctx.teamCore` 类型增强（type-only import 即可生效）。
import type { TeamCore } from '@dsh-swarm/team-core-contract'

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
}

export const Config: z<Config> = z.object({
  locales: z.union([z.const('cn'), z.const('en')]).default('cn'),
  leaderProgressiveDisclosure: z.boolean().default(true),
  sections: z
    .array(z.object({ name: z.string(), order: z.number(), text: z.string() }))
    .default([]),
})

/** 稳定段名（进前缀）与顺序约定。 */
export const STABLE_SECTION_NAMES = [
  'team:role',
  'team:dispatch',
  'team:task-state',
  'team:inbound',
] as const
/** cache-safe context 名（不进前缀）。 */
export const CONTEXT_NAMES = ['team:identity', 'team:roster', 'team:info'] as const

/** 团队建成前延后的段（渐进披露）。 */
const DEFERRED_BEFORE_TEAM = ['team:dispatch', 'team:task-state']

function builtinSections(locales: 'cn' | 'en'): SectionSpec[] {
  const cn = locales === 'cn'
  return [
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
        ? '就绪任务由调度器派发；你也可主动认领。'
        : 'Ready tasks are dispatched by the scheduler; you may also claim them.',
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
  const specs = config.sections.length > 0 ? config.sections : builtinSections(config.locales)

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
