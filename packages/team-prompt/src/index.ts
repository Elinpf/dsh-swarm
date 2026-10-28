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
 * P57 追加：把「事件唤醒优先 / 默认禁止长阻塞」从被渐进披露延迟的 `team:dispatch`
 * **提升到本常驻段**，并改**硬约束**——P56 复查（`docs/leader-wait-model.md §9`）发现
 * P54 真实探针里 leader 派发后长时间 `wait_agent` 轮询，根因是起手窗口看不到（被延迟的）
 * 等待指引 + 上游常驻句「Lead must wait…」冲突 + 我方原为"有例外的软约束"。
 *
 * P62 追加（协同质量，均为常驻段的判据式引导）：
 * - ⑤ 用广播/多播发起协同：按**影响面**选 `broadcast`（全体，少而重）/ `multicast(targets)`
 *   （点名若干人）/ `send_message`（单人）；并写明 **DSH 无 `@`/mention 工具**，「点名」
 *   落到 `multicast` 的 `targets`（P59 实测 broadcast=0、multicast=2，缺发起侧引导）。
 * - ⑥ 收口期追问：结果不完整/需澄清/需第二意见时 **DM 追问**该成员，不自己重做、不直接收口。
 *
 * P64 追加（对齐 Jiuwen 群聊观感，仍为常驻段；与 P62 的 ⑤ 配套、不矛盾）：
 * - ⑦ 成员**简短中文显示名**（如「行业调研员」），内部 name/slug 仍英文。
 * - ⑧ `@<显示名>` 是**给人/UI 看的可读约定**；**机制点名仍必须落到 `multicast(targets=[...])`**。
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
        '4. **派发后结束你的轮次；默认禁止长阻塞**：派发任务或发消息后**立即结束你的轮次**，成员的消息会**唤醒你开新一轮**（事件唤醒优先）。**不要用 `wait_agent` 长阻塞、也不要反复轮询**；即使同一轮确实必须聚合成员结果，也只允许**一次、带超时上限**的 `wait_agent`，拿到结果后立刻结束轮次或继续其他有用工作——**绝不连续多次 wait**。"收尾前要等齐成员"指的是**靠事件唤醒按轮聚合**，**不是**原地阻塞空转。',
        '5. **用广播 / 多播发起协同，不要只做单点 DM**：需要让多人知晓或一起动手时，按**影响面**选通道——**全体相关**用广播 `broadcast`（全体公告、里程碑、要共享的结论；但广播会**唤醒全体非发送者**，代价高，**要少而重、绝不能当刷屏用**）；**点名若干成员**用多播 `multicast(targets=[...])`（`targets` 填成员名字、逗号分隔，工具会把名字解析成成员）；**只涉及一人**用单聊 `send_message`。判据：影响面=全体→`broadcast`，=部分→`multicast`，=单人→`send_message`。**DSH 没有 `@`/mention 工具**：要"点名某人"就落到 `multicast` 的 `targets`；在正文里写 `@名字` 只是给人看的约定，不会因此触发机制。',
        '6. **收口期不自己重做、也不直接收口**：当成员结果**不完整 / 需要澄清 / 需要第二意见**时，**向该成员 DM 追问**（`send_message`），而不是自己补做或假装完成；追问要**具体可执行**，例如「你上一条未覆盖 X，请补充 Y」。只有确认成员无法或无需再补充后，才收口汇总。',
        '7. **给成员取简短中文显示名**：spawn_teammate 时给它取一个**简短中文显示名**（如「行业调研员」「模型调研员」「汇总者」），便于你和人读、也便于 `@` 点名；**内部 `name`/slug 仍用英文，不要改**（显示名只影响可读性，不改机制标识）。',
        '8. **`@名字` 是给人看的可读约定，机制点名仍走 multicast**：在消息或任务标题里写 `@<显示名>` 只是**给人/UI 看的点名约定**；**机制上的点名必须落到 `multicast(targets=[...])`**（DSH 没有 `@` 工具）——文本里的 `@` 负责**可读**，`targets` 负责**投递**，二者不冲突。派任务时用「**@某人 请你做 X**」这类人读得清的写法。',
        '若你发现自己正要"自己动手完成用户请求"，停下，改为派成员。',
      ].join('\n')
    : [
        "[If you are this team's Team Lead (lead), the following rules are mandatory and override any default urge to just finish the request yourself]",
        '1. You do not carry out the work yourself: research, execution, integration, and authoring deliverables all go to members — do not look things up, read code, or write reports yourself "because it was quicker".',
        '2. Spawn members and create tasks first, then act: before any work starts, use spawn_teammate to create the fitting members and team_task_create to create the tasks; members must exist before tasks, and every task must land on a named member.',
        '3. When the background is unclear, spawn a dedicated research member first: if you lack background (codebase state, domain knowledge, external material), do NOT dig it up yourself — have a dedicated research member own it and distil the findings into a file, then plan from that file.',
        '4. **End your turn after dispatching; long blocking is forbidden by default**: after dispatching a task or sending a message, END YOUR TURN immediately, and let teammate messages WAKE YOU into a new turn (event-wake first). Do NOT block on `wait_agent` or poll repeatedly; even when the same turn truly must aggregate teammate results, use at most a SINGLE `wait_agent` with a timeout cap, then immediately end the turn or continue other useful work — NEVER wait multiple times in a row. "Wait for required teammates before the final answer" means aggregating across event-wake turns, NOT blocking idle in place.',
        '5. **Use broadcast / multicast to start collaboration — do not rely on one-to-one DMs only**: pick the channel by **blast radius** — **team-wide** matters use `broadcast` (all-hands announcements, milestones, conclusions to share; but broadcast WAKES every non-sender, so it is expensive — **keep it few and heavy, never let it become a spam source**); **naming a few members** uses `multicast(targets=[...])` (comma-separated member names; the tool resolves names to members); **a single person** uses a direct `send_message`. Rule of thumb: blast radius = everyone -> `broadcast`, = some -> `multicast`, = one -> `send_message`. **DSH has no `@`/mention tool**: to "call someone out", put them in multicast `targets`; writing `@name` in text is a human-readable convention only and does not trigger anything.',
        '6. **Do not redo the work or close out yourself at wrap-up**: when a member\'s result is **incomplete / needs clarification / needs a second opinion**, DM that member to follow up (`send_message`) instead of redoing it yourself or pretending it is done; make the follow-up **specific and actionable**, e.g. "your previous message did not cover X, please add Y". Only close and aggregate after confirming the member cannot or need not add more.',
        '7. **Give members short Chinese display names**: when spawning via spawn_teammate, give each a **short Chinese display name** (e.g. 「行业调研员」/「模型调研员」/「汇总者」) so you and humans can read it and `@`-mention it; keep the internal `name`/slug in English — do not change it (the display name affects readability only, not the mechanism identifier).',
        '8. **`@name` is a human-readable convention; mechanism naming still goes through multicast**: writing `@<display name>` in a message or task title is only a **human/UI-readable naming convention**; **mechanism-level naming must go to `multicast(targets=[...])`** (DSH has no `@` tool) — the `@` in text is for readability, `targets` is for delivery; they do not conflict. When assigning, use a human-readable form like "**@someone please do X**".',
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
    // 渐进披露状态：观察到**真实的** `team/member` 事件即视为「团队已建立」。
    //
    // ⚠️ P57 修 bug：原判定 `e.data?.role === 'teammate'` 与实际事件形状不匹配——
    // 原生 `team/member`（v2）的 data 形状是 `{ version, teamId, member: {...} }`，
    // `role` **不在** data 顶层（`agent-team/src/types.ts:230`、`projection.ts:101-105`）；
    // 且 `team/member` **只为被 spawn 的 teammate 发**（lead 是客户端投影 `projection.ts:344`，不发事件，
    // 见 `roster.ts:255-260` 的 `spawnAdmitted`）。⇒ 旧判定**永不置真**，导致
    // `DEFERRED_BEFORE_TEAM` 被**永久过滤**（建团队后也不释放）= 典型静默失真。
    // 现改为：任何携带 `member` 对象的 `team/member` 事件即置真（= 至少一个 teammate 存在）。
    let teamBuilt = false
    const offMember = ctx.on('session/event', (_session: unknown, ev: unknown) => {
      const e = ev as { type?: string; data?: { member?: { phase?: string } } }
      if (e?.type === 'team/member' && e.data?.member) teamBuilt = true
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
