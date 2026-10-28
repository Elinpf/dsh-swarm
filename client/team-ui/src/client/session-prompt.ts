/**
 * P68-A：把 composer 文本作为**一条 user 消息**注入 **Lead 会话**（等价主输入框）。
 *
 * 通道：客户端 `@deepseek-ai/dsh-api-session-controller/client` 的
 * `ctx.sessions.binding(id).session.prompt(content, 'queue')`（与主 composer 同源）。
 *
 * **语义限制（须对用户可见）**：≠ 向某成员直发；不经我们 `team-bus`/`team-core`；
 * **不计入本栈未读/兜底（P51 边界）**；**会触发 Lead 一轮（计入 token）**。
 *
 * @module @elinpf/dsh-swarm-team-ui/session-prompt
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface SubmitResult {
  readonly ok: boolean
  readonly error?: string
}

interface PromptCapableSession {
  prompt?: (
    content: Array<{ type: 'text'; text: string }>,
    mode: 'queue' | 'steer',
  ) => Promise<{ ok?: boolean; error?: { message?: string } } | undefined>
}

/** 从 client ctx 解析可 prompt 的 session（精确到 binding.session）。 */
function resolveSession(ctx: ClientContext, sessionId: SessionId): PromptCapableSession | undefined {
  const sessions = (ctx as unknown as { sessions?: { binding?: (id: SessionId) => { session?: unknown } } }).sessions
  const binding = sessions?.binding?.(sessionId)
  const session = binding?.session as PromptCapableSession | undefined
  return session
}

/**
 * 把文本作为 user 消息注入 Lead 会话。
 * 失败一律返回 `{ok:false,error}`（**不静默**），由调用方展示错误。
 */
export async function submitTeamPrompt(
  ctx: ClientContext,
  sessionId: SessionId,
  text: string,
): Promise<SubmitResult> {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, error: '空消息未发送' }
  const session = resolveSession(ctx, sessionId)
  if (session?.prompt === undefined) {
    return { ok: false, error: '会话通道不可用（session controller 未就绪）——未发送' }
  }
  try {
    const result = await session.prompt([{ type: 'text', text: trimmed }], 'queue')
    if (result === undefined || result.ok !== false) return { ok: true }
    return { ok: false, error: result.error?.message ?? '发送被会话拒绝' }
  } catch (e) {
    return { ok: false, error: `发送失败：${String((e as Error)?.message ?? e)}` }
  }
}
