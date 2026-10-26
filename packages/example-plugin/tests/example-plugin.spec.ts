import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'

/**
 * 最小的假 ctx：只记录插件注册了什么、并提供可调用的 disposer，
 * 用来在不起完整 DSH 运行时的前提下断言 apply 的行为。
 * 真正的「经 cordis 加载」验证在 scripts/verify-load.mjs 里做。
 */
function makeCtx() {
  const tools: any[] = []
  const sections: any[] = []
  const disposers: Array<() => void> = []

  const ctx = {
    tools: {
      register(tool: any) {
        tools.push(tool)
        const dispose = () => {
          const i = tools.indexOf(tool)
          if (i >= 0) tools.splice(i, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
    systemPrompt: {
      section(section: any) {
        sections.push(section)
        const dispose = () => {
          const i = sections.indexOf(section)
          if (i >= 0) sections.splice(i, 1)
        }
        disposers.push(dispose)
        return dispose
      },
    },
  }

  return { ctx, tools, sections, disposeAll: () => disposers.forEach((d) => d()) }
}

describe('@dsh-swarm/example-plugin', () => {
  it('导出形态符合函数式插件契约（命名导出、无 default export）', () => {
    expect(plugin.name).toBe('example-plugin')
    expect(plugin.inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeTruthy()
    // 关键：函数式插件绝不能有 default export，否则 loader 会丢 inject
    expect((plugin as Record<string, unknown>).default).toBeUndefined()
  })

  it('Config 提供默认值并校验输入', () => {
    const validated = (plugin.Config as unknown as (input: unknown) => plugin.Config)({})
    expect(validated.greeting).toBe('hello')
    expect(validated.order).toBe(120)
  })

  it('apply 注册一个 greet 工具和一个 prompt section', () => {
    const { ctx, tools, sections } = makeCtx()
    plugin.apply(ctx as never, { greeting: 'hi', order: 130 })

    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('greet')
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: 'example-plugin:guide', order: 130 })
  })

  it('greet 工具按配置的前缀回复，render 输出纯文本', async () => {
    const { ctx, tools } = makeCtx()
    plugin.apply(ctx as never, { greeting: 'hi', order: 120 })

    const tool = tools[0]
    const value = await tool.execute({ who: 'DSH' })
    expect(value).toEqual({ text: 'hi, DSH' })

    const rendered = tool.output.render({ who: 'DSH' }, value)
    expect(rendered).toEqual([{ type: 'text', text: 'hi, DSH' }])
  })

  it('HMR 安全：注册随 disposer 撤销', () => {
    const { ctx, tools, sections, disposeAll } = makeCtx()
    plugin.apply(ctx as never, { greeting: 'hello', order: 120 })
    expect(tools).toHaveLength(1)
    expect(sections).toHaveLength(1)

    disposeAll()
    expect(tools).toHaveLength(0)
    expect(sections).toHaveLength(0)
  })
})
