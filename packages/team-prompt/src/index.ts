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
 * - ⑦ 成员**中文角色名写进 `description` 开头**；`name` 必须英文 lower-kebab（严禁中文进 name）。
 * - ⑧ `@<显示名>` 是**给人/UI 看的可读约定**；**机制点名仍必须落到 `multicast(targets=[...])`**。
 *
 * P73 追加（Jiuwen 提示词迁移第一批 P0×2+P1×9；按 `docs/jiuwen-prompt-migration.md` §3/§8）：
 * - 常驻 `team:leader`：⑨ 起手与任务自检、⑩ 独立汇总成员、⑪ 事件驱动不催 idle（C4/C6/C8）。
 * - 常驻 `team:role`：通信唯一通道 = send_message/multicast/broadcast（C9）。
 * - `team:task-state`：全量状态机 + 验证闸 + 验证者三类（C1/C2/C11）。
 * - `team:dispatch`：派发纪律（assignee/框架代交接）+ 升级处置 + 收尾（C3/C5/C7）。
 * - `team:inbound`：来源区分（C10，我方无 Jiuwen 的 XML 标签体系 → 降级为通用来源说明）。
 * 所有工具名均按 §8 对照表用**真实名**（任务动作一律 `team_task_update(action=...)`）。
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
        '7. **给成员一个中文角色名，写进 `description` 开头**：spawn_teammate 时把**简短中文角色名写在 `description` 的开头**（如「行业调研员」「模型调研员」「汇总者」…），供人和工具列表阅读、也便于 `@` 点名；**`name` 必须是英文 lower-kebab，严禁把中文塞进 `name`**（违反工具契约）。',
        '8. **`@名字` 是给人看的可读约定，机制点名仍走 multicast**：在消息或任务标题里写 `@<显示名>` 只是**给人/UI 看的点名约定**；**机制上的点名必须落到 `multicast(targets=[...])`**（DSH 没有 `@` 工具）——文本里的 `@` 负责**可读**，`targets` 负责**投递**，二者不冲突。派任务时用「**@某人 请你做 X**」这类人读得清的写法。',
        '9. **起手与任务自检**：先分析目标、明确验收标准，再动手——**先建人、后建任务**；**建任务前先 `team_task_list` 查一遍看板**（避免重复、漏依赖）；**建完任务再自检一遍**（标题清晰、依赖正确、覆盖完整）。',
        '10. **需要整合时另立汇总成员**：当最终交付要综合多个成员的产出时，**单独建一名汇总成员**，让它读各成员的产物文件、写出最终交付文件；**你只读结论并向用户汇报，不要自己整合**。',
        '11. **响应节奏：事件驱动、不催 idle**：新消息/任务状态变化/计划提交会自动通知你——**不要反复轮询**；**成员 idle 是正常状态**（≠卡死），不要催促或重发启动消息；只有**明显长期停滞且未汇报阻塞**时才介入。',
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
        '7. **Give each member a Chinese role name, written at the START of `description`**: when spawning via spawn_teammate, put a **short Chinese role name at the beginning of `description`** (e.g. 「行业调研员」/「模型调研员」/「汇总者」) so humans and the tool list can read it and it can be `@`-mentioned; **`name` MUST be English lower-kebab — never put Chinese in `name`** (it violates the tool contract).',
        '8. **`@name` is a human-readable convention; mechanism naming still goes through multicast**: writing `@<display name>` in a message or task title is only a **human/UI-readable naming convention**; **mechanism-level naming must go to `multicast(targets=[...])`** (DSH has no `@` tool) — the `@` in text is for readability, `targets` is for delivery; they do not conflict. When assigning, use a human-readable form like "**@someone please do X**".',
        '9. **Opening sequence & task self-check**: analyse the goal and pin the acceptance criteria first, then act — **spawn people BEFORE tasks**; **run `team_task_list` before creating tasks** (avoid duplicates and missed dependencies); **self-check right after creating tasks** (clear titles, correct dependencies, full coverage).',
        '10. **Spin up a dedicated synthesis member when integration is needed**: when the final deliverable must combine several members\' outputs, **create a separate synthesis member** to read each member\'s artifact files and write the final deliverable; **you only read the conclusion and report to the user — do not integrate it yourself**.',
        '11. **Response rhythm: event-driven, never nag idle members**: new messages / task-state changes / plan submissions notify you automatically — **do not poll**; **an idle member is normal** (not stuck) — do not nag or resend a start message; only step in on a **clearly long stall with no reported blocker**.',
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
        ? '你是团队的一员：与队友通过 `send_message`（DM）/`multicast`（多播）/`broadcast`（广播）和共享任务看板协作。**你的普通文本输出不会送达其他成员**——要让队友看到，必须走上述消息工具。'
        : 'You are a team member: collaborate via `send_message` (DM) / `multicast` / `broadcast` and the shared task board. **Your plain text output does not reach other members** — to be seen by a teammate, use the messaging tools.',
    },
    {
      name: 'team:dispatch',
      order: 15,
      text: cn
        ? leaderWaitModel === 'event-wake'
          ? '就绪任务由调度器派发；你也可主动认领。**派发或发消息后请结束你的轮次**：成员的消息会唤醒你开新一轮（事件唤醒优先）；**不要用 `wait_agent` 长阻塞**（仅当同一轮必须同步聚合多个成员结果时才用一次）。只处理发给你的消息/含你的广播。`team_task_create` 必须指定承担者（`assignee`）；**调度框架代你完成交接**——开工/完成/验收自动流转，**不要用消息逐个通知成员开工**。收到升级（验收轮数耗尽/验证停摆）时：**先等在 inbox 收齐返工总结，再综合 reviewer 反馈**，决定 retry（放宽轮数）还是 replan（换人/改任务内容）。收尾：完成后汇总本轮成果并 `broadcast` 一次总结、进入待命（长期团队不关闭成员）。'
          : '就绪任务由调度器派发；你也可主动认领。如需同步等待队友结果，可用 `wait_agent`（可选）。`team_task_create` 必须指定承担者（`assignee`）；**调度框架代你完成交接**——不要用消息逐个通知成员开工。收尾：完成后汇总成果并进入待命（长期团队不关闭成员）。'
        : leaderWaitModel === 'event-wake'
        ? 'Ready tasks are dispatched by the scheduler; you may also claim them. **After dispatching or messaging, end your turn**: teammate messages wake you into a new turn (event-wake first); do NOT block on `wait_agent` (use it once only when the same turn must aggregate). Act only on messages addressed to you (or broadcasts that include you). `team_task_create` MUST specify an assignee; **the scheduler performs the handoff for you** — do NOT notify members one by one. On escalation (review rounds exhausted / review stalled), **wait for the rework summary in your inbox first, then weigh reviewer feedback** to decide retry vs replan. At wrap-up, `broadcast` a one-time summary and stand by (a persistent team does not shut members down).'
        : 'Ready tasks are dispatched by the scheduler; you may also claim them. You may use `wait_agent` (optional). `team_task_create` MUST specify an assignee; **the scheduler performs the handoff** — do not notify members one by one. At wrap-up, summarize and stand by (a persistent team does not shut members down).',
    },
    {
      name: 'team:task-state',
      order: 16,
      text: cn
        ? '任务状态流转：pending → in_progress → in_review → completed（仅当任务配了验证者时才经 `in_review`）；另有 `blocked`（依赖未满足）与取消后的终态（我方用 `delete`，终态为 `deleted`，**无 `cancelled` 态**）。用 `team_task_update(action=...)` 推进：认领 `claim`、完成 `complete`、提交验证 `submit_review`、返工 `reject_review`、取消 `delete`。plan 模式另有**计划闸**：`pending → planned`（`open_plan`）→ `submit_plan` → `approve_plan` 批准后方可执行。**验证闸**：任务配了 reviewer 时，author 完成后进入 `in_review` 等裁决，通过才 `completed`，打回则回 `in_progress` 返工。验证者三类用 `review_vote` 裁决：`verifier` 判 `decision="pass|fail"`（任一 fail 即打回）、`inspector` 打 `value=0~1` 分、`challenger` 对抗找盲区（默认 pass，仅阻塞性缺陷 fail）。'
        : 'Task state: pending → in_progress → in_review → completed (goes through `in_review` only when a reviewer is set); plus `blocked` (unmet dependency) and a deleted terminal state (we use `delete` → `deleted`; there is **no `cancelled`**). Advance via `team_task_update(action=...)`: claim / complete / submit_review / reject_review / delete. Plan mode adds a **plan gate** (pending → planned: `open_plan` → `submit_plan` → `approve_plan` before it can run). **Review gate**: when a task has reviewers, the author finishing moves it to `in_review`; it completes only on approval, otherwise it returns to `in_progress` for rework. Reviewers vote via `review_vote`: `verifier` gives `decision="pass|fail"` (any fail rejects), `inspector` gives a `value=0..1` score, `challenger` looks for blind spots (pass by default, fail only on blocking defects).',
    },
    {
      name: 'team:inbound',
      order: 18,
      text: cn
        ? '入站消息与事件通知会标注来源（发送者 / 事件类型）；请按来源区分处理（不要把框架事件当成对话或指令）。'
        : 'Inbound messages and event notices are attributed by source (sender / event kind); handle them by source (do not treat framework events as conversation or instructions).',
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
