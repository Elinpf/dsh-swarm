/**
 * P63 群聊面板「Jiuwen 观感」的**纯展示逻辑**（无 React / 无 DSH 依赖，便于单测）。
 *
 * 四件事：
 * 1. 发言人显示名：**优先中文 `display_name`**（含 CJK 的候选），无则回退英文 ID（`name`）。
 * 2. 头像首字母：中文取首字，英文取首字母大写。
 * 3. 正文 `@名字` → chip 段（已知成员名标记 known，用于高亮；未知也成 chip，不崩）。
 * 4. 定向/指派可视化（**只做展示**）：
 *    - outbound（`send_message`/`multicast`）→ 前导「→ @目标…」；
 *    - task 指派形态（防御式，当前数据流可能无此输入）→「@某人 收到任务：<标题>」。
 * 可见范围/排序/去重**不变**（沿用 P61 的 `id`/`seq`；本模块只提供 `orderMessages` 供断言）。
 *
 * @module @elinpf/dsh-swarm-team-ui/chat-format
 */

/** 成员（只取展示所需字段；`displayName`/`title` 可能来自数据侧的中文显示名）。 */
export interface MemberLike {
  readonly id: string
  readonly name: string
  readonly role?: string
  /** 显式中文显示名（若数据侧提供）。 */
  readonly displayName?: string
  /** 次级中文来源，如成员会话标题。 */
  readonly title?: string
}

/** 一条群聊消息（与 `swarmBus` 投影 wire 形状对齐，取展示所需字段）。 */
export interface MessageLike {
  readonly id: string
  readonly kind: 'broadcast' | 'multicast' | 'dm' | 'relay' | 'outbound'
  readonly senderId?: string
  readonly senderName?: string
  readonly topic?: string
  readonly content?: ReadonlyArray<{ type?: string; text?: string }>
  readonly targets?: readonly string[]
  readonly seq?: number
  /** 防御式：若消息流出现 task 指派形态。 */
  readonly task?: { id?: string; subject?: string; assignee?: string }
}

/** 是否含 CJK 字符（用于"优先中文显示名"判定）。 */
export function isCjk(value: string | undefined): boolean {
  return typeof value === 'string' && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(value)
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 是否"像一个人名"（用于审慎地把 `sessionTitle` 当中文显示名）。
 * 经验：成员会话标题常是 **spawn 提示前缀**（如"你是团队中的调研成员 researche…"），
 * 不能直接当名字。这里只接受**纯中文、短（≤12）、不含空白/标点**的标题。
 */
export function looksLikeDisplayName(value: string | undefined): boolean {
  if (!nonEmpty(value)) return false
  const s = value.trim()
  return isCjk(s) && s.length <= 12 && !/[\s，,。.：:；;、!！?？/\\|]/.test(s)
}

/**
 * 发言人显示名：
 * 1) 含 CJK 的 `displayName`；2) 像人名的中文 `title`（会话标题）；3) 其它 `displayName`；4) 回退 `name`（英文 ID）。
 * —— 优先"干净的中文名"；`sessionTitle` 若是 spawn 提示前缀（长/含空白）会被**拒绝**，避免把整段提示当名字。
 */
export function displayNameOf(member: Pick<MemberLike, 'name' | 'displayName' | 'title'>): string {
  const displayName = nonEmpty(member.displayName) ? member.displayName.trim() : undefined
  const title = nonEmpty(member.title) ? member.title.trim() : undefined
  if (displayName !== undefined && isCjk(displayName)) return displayName
  if (title !== undefined && looksLikeDisplayName(title)) return title
  if (displayName !== undefined) return displayName
  return member.name
}

/** 头像首字母：中文取首字，英文取首字母大写。 */
export function avatarInitial(displayName: string): string {
  const s = displayName.trim()
  if (s.length === 0) return '?'
  const first = Array.from(s)[0] ?? '?'
  return isCjk(first) ? first : first.toUpperCase()
}

/** 消息正文纯文本。 */
export function textOf(message: MessageLike): string {
  return (message.content ?? [])
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim()
}

/** 正文分段：普通文本 与 `@提及`。 */
export interface Segment {
  readonly type: 'text' | 'mention'
  readonly value: string
  /** mention 是否命中已知成员名（用于高亮样式）。 */
  readonly known?: boolean
}

/**
 * 把正文按 `@提及` 切成段。`@` 后跟连续字母/数字/下划线/连字符/CJK 视为一个提及。
 * 无 `@` → 单段 text；空串 → []（调用方渲染空）。
 */
export function parseMentions(text: string, knownNames: readonly string[] = []): Segment[] {
  if (text.length === 0) return []
  const known = new Set(knownNames)
  const re = /@([\p{L}\p{N}_-]+)/gu
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push({ type: 'text', value: text.slice(last, idx) })
    const name = m[1] ?? ''
    out.push({ type: 'mention', value: name, known: known.has(name) })
    last = idx + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

/** 一条消息的可渲染形态。 */
export interface RenderModel {
  /** 发言人显示名（outbound 固定为 lead 的显示名，由调用方传入）。 */
  readonly senderName: string
  /** 头像首字母。 */
  readonly avatar: string
  /** 前导段（定向可视化，如 outbound 的「→ @目标」）；无则 []。 */
  readonly leading: Segment[]
  /** 正文段。 */
  readonly body: Segment[]
}

/**
 * 组装一条消息的展示模型。
 * @param message - 折叠后的群聊消息。
 * @param knownNames - 已知成员显示名集合（用于 @chip 高亮）。
 * @param leadName - lead 的显示名（outbound 的发言人）。
 */
export function renderMessage(
  message: MessageLike,
  knownNames: readonly string[] = [],
  leadName = 'lead',
): RenderModel {
  // task 指派形态（防御式）：合成「@某人 收到任务：<标题>」。
  if (message.task !== undefined && (message.task.subject !== undefined || message.task.assignee !== undefined)) {
    const who = message.task.assignee ?? '成员'
    const subject = message.task.subject ?? ''
    return {
      senderName: message.senderName ?? leadName,
      avatar: avatarInitial(message.senderName ?? leadName),
      leading: [],
      body: parseMentions(`@${who} 收到任务：${subject}`, knownNames),
    }
  }

  const body = parseMentions(textOf(message), knownNames)
  if (message.kind === 'outbound') {
    const targets = (message.targets ?? []).filter(nonEmpty)
    const leading: Segment[] = targets.length === 0
      ? [{ type: 'text', value: '→' }]
      : [
          { type: 'text', value: '→ ' },
          ...targets.flatMap((target, i): Segment[] =>
            (i === 0 ? [] : [{ type: 'text', value: ', ' }]).concat({ type: 'mention', value: target, known: knownNames.includes(target) }),
          ),
        ]
    return { senderName: message.senderName ?? leadName, avatar: avatarInitial(message.senderName ?? leadName), leading, body }
  }

  const senderName = message.senderName ?? leadName
  return { senderName, avatar: avatarInitial(senderName), leading: [], body }
}

/**
 * 排序 + 去重（**可见范围不变**）：按 `seq` 升序、同 id 去重；
 * `newestFirst=true` 时反转（与现有面板"最新在顶"一致）。
 */
export function orderMessages(
  messages: readonly MessageLike[],
  newestFirst = true,
): MessageLike[] {
  const seen = new Set<string>()
  const unique: MessageLike[] = []
  for (const m of messages) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    unique.push(m)
  }
  const sorted = unique.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return newestFirst ? sorted.reverse() : sorted
}

/** 从成员列表构造"已知显示名"集合（含 name 与中文显示名，供 @chip 高亮）。 */
export function knownNamesOf(members: readonly MemberLike[]): string[] {
  const names = new Set<string>()
  for (const m of members) {
    if (nonEmpty(m.name)) names.add(m.name)
    const dn = displayNameOf(m)
    if (nonEmpty(dn)) names.add(dn)
  }
  return [...names]
}
