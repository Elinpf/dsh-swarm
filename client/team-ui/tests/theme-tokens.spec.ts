import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P85 回归护栏：群聊正文「发灰」的根因是**硬编码前景/背景色**（不跟宿主主题、且比主对话浅）。
 *
 * 本测试静态读取 `TeamChatTab.tsx`，断言：
 *  1) 已移除导致发灰 / 暗色崩坏的字面色（`#191919`/`#808080`/`#fafafa`/`#f4f4f5`/`#e4e4e7`）；
 *  2) 已改用宿主 `--dsw-alias-*` token（正文=`label-primary`、次级=`label-tertiary`、底=`bg-base`）；
 *  3) 保留了抵消 `MarkdownText variant="compact"` tertiary 调淡的 `MD_COLOR_SCOPE` 覆盖。
 *
 * 说明：不做像素断言（本环境无浏览器）；像素观感由用户在 demo 点开确认（见 docs/verification.md）。
 */
const SRC = readFileSync(join(import.meta.dirname, '../src/client/TeamChatTab.tsx'), 'utf8')

describe('P85 主题 token 化（发灰修复护栏）', () => {
  it('不再包含会导致发灰 / 暗色崩坏的字面色', () => {
    for (const hex of ['#191919', '#808080', '#fafafa', '#f4f4f5', '#e4e4e7']) {
      expect(SRC.includes(hex), `残留字面色 ${hex}`).toBe(false)
    }
  })

  it('正文与次级信息改用宿主 label token（与主对话同源）', () => {
    expect(SRC).toContain('var(--dsw-alias-label-primary)') // 正文/标题 = 主对话同色
    expect(SRC).toContain('var(--dsw-alias-label-tertiary)') // 次级信息
    expect(SRC).toContain('var(--dsw-alias-bg-base)') // 面板/左栏底（随主题）
  })

  it('抵消 compact 变体的 tertiary 调淡，保证 Markdown 与纯文本同色', () => {
    // wrapper 把 label-tertiary 局部重指向 label-primary（CSS 变量按最近祖先解析）
    expect(SRC).toContain('MD_COLOR_SCOPE')
    expect(SRC).toMatch(/--dsw-alias-label-tertiary':\s*'var\(--dsw-alias-label-primary\)'/)
  })
})
