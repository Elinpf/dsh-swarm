/**
 * P68-A composer 的**纯逻辑**（无 React / 无 DSH 依赖，便于单测）。
 *
 * - `@`/`$` 触发检测（正对照 Jiuwen `InputArea.tsx:2334-2360`）；
 * - 候选过滤（成员名册）；
 * - composer 序列化：把「文本 + chip」序列化成发送文本（chip → `@<name>`）。
 *
 * ⚠️ 语义限制（P68-A）：chip 展开为 `@<name>`（**用 name，非 UUID**）；最终作为**一条 user 消息**
 * 注入 Lead 会话（等价主输入框），**≠ 向某成员直发**、**不计入本栈未读/兜底**。
 *
 * @module @elinpf/dsh-swarm-team-ui/composer
 */

/** 触发词：`@`(成员) / `$`(角色) + 之后的查询串（中英文/数字/_/-）。 */
export const MENTION_TRIGGER_RE = /([@$])([\p{L}\p{N}_\-\u4e00-\u9fa5]*)$/u

export interface Trigger {
  readonly prefix: '@' | '$'
  readonly kind: 'member' | 'role'
  readonly query: string
}

/** 对**光标前**文本检测触发词；无则 null。 */
export function detectTrigger(textBeforeCaret: string): Trigger | null {
  const m = MENTION_TRIGGER_RE.exec(textBeforeCaret)
  if (m === null) return null
  const prefix = m[1] === '$' ? '$' : '@'
  return { prefix, kind: prefix === '@' ? 'member' : 'role', query: m[2] ?? '' }
}

export interface Candidate {
  readonly name: string
  readonly displayName: string
  readonly role?: string
}

/** 过滤候选：按显示名/name 做大小写不敏感前缀/包含匹配；空 query 返回全部。 */
export function filterCandidates(candidates: readonly Candidate[], query: string): Candidate[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return [...candidates]
  return candidates.filter(
    (c) => c.name.toLowerCase().includes(q) || c.displayName.toLowerCase().includes(q),
  )
}

/** composer 的一段：普通文本 或 一个成员 chip。 */
export type ComposerPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'chip'; readonly name: string }

/**
 * 序列化 composer 内容为发送文本：chip → `@<name>`（**name，非 UUID**），文本原样拼接。
 * 末尾去多余空白。
 */
export function serializeComposer(parts: readonly ComposerPart[]): string {
  const s = parts
    .map((p) => (p.kind === 'chip' ? `@${p.name}` : p.text))
    .join('')
  return s.replace(/\s+$/u, '')
}

/** 从一段纯文本里抽出被 `@name` 提到的名字（用于「会发给谁」的预览提示）。 */
export function mentionedNames(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const n = m[1]
    if (n !== undefined) out.push(n)
  }
  return [...new Set(out)]
}
