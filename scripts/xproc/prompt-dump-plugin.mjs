/**
 * P56 探针辅助插件：把每次装配出的 system prompt 段落名 + 是否含 P46 文本 落盘，
 * 使「某轮 leader 的 prompt 里是否已有 event-wake 指引」从【推断】变【事实】。
 * 由 dsh `--patch` 注入；输出路径取 env `P56_PROMPT_DUMP`。
 */
import { appendFileSync } from 'node:fs'

export const name = 'p56-prompt-dump'
export const inject = ['systemPrompt']

export function apply(ctx) {
  const out = process.env.P56_PROMPT_DUMP
  if (!out) return
  ctx.on?.('system-prompt/assemble', async (_assembly, _context, next) => {
    const result = await next()
    try {
      const sections = Array.isArray(result?.sections) ? result.sections : []
      const text = JSON.stringify(result)
      appendFileSync(
        out,
        JSON.stringify({
          at: Date.now(),
          sectionNames: sections.map((s) => s?.name).filter(Boolean),
          hasEventWake: text.includes('结束你的轮次') || text.includes('end your turn'),
          hasDispatch: text.includes('team:dispatch') || text.includes('派发或发消息后'),
        }) + '\n',
      )
    } catch {
      /* ignore */
    }
    return result
  })
}
