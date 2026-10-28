import { describe, expect, it } from 'vitest'
import { renderMessage, textOf, type MessageLike } from '../src/client/chat-format.ts'

/**
 * P75 XSS 反例：agent 内容**不可信**。
 *
 * 本层只把内容转成**纯字符串**交给宿主 `MarkdownText`（React）渲染——**不做任何 HTML 解析/拼接/注入**，
 * 因此 `<script>`/`<img onerror>`/`javascript:` 只会是**字面文本**，由宿主渲染器转义/安全化
 * （宿主：`ui-primitives/src/markdown/render.tsx` "No HTML parser enters the pipeline: raw HTML stays
 * literal text"；链接经 `sanitizeUrl` 仅放行 http/https/mailto，外链加 `rel=noopener noreferrer`）。
 */
const msg = (text: string): MessageLike => ({ id: 'x', kind: 'relay', seq: 1, content: [{ type: 'text', text }] })

describe('P75 XSS 反例（不可信内容按字面处理，不生成 HTML）', () => {
  it('<script> / <img onerror> / javascript: 均按字面文本，不被解析或执行', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>[x](javascript:alert(3))'
    const m = renderMessage(msg(evil), [])
    const body = m.body.map((s) => (s.type === 'mention' ? `@${s.value}` : s.value)).join('')
    // 字面透传：本层不做任何 HTML 解析/剥离/生成（=> 交给 React 文本节点，自动转义）
    expect(body).toBe(evil)
    expect(body).toContain('<script>alert(2)</script>')
    expect(body).toContain('onerror=alert(1)')
    expect(body).toContain('javascript:alert(3)')
  })

  it('textOf 保真：不静默剥离可疑内容', () => {
    expect(textOf(msg('<b>x</b>'))).toBe('<b>x</b>')
    expect(textOf(msg('javascript:alert(1)'))).toBe('javascript:alert(1)')
  })
})
