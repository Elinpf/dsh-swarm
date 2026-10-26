/**
 * Hello-world DSH 插件。
 *
 * 存在的唯一目的，是把「插件能被构建 → 能被 cordis/DSH 加载 → 能观察到它注册的东西」
 * 这条链路跑通并留下可复现的证据；它不是业务能力，后续的团队协作插件另起包。
 *
 * 形态遵循 docs/plugin-dev-guide.md §2.2 的最小函数式插件契约：
 * 命名导出 `name` / `inject` / `Config` / `apply`，且**没有 default export**
 * ——default export 会让 loader 的 unwrapExports 丢掉 inject，运行时静默失败。
 *
 * @module @dsh-swarm/example-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** cordis 插件名，同时也是 cordis.patch.yml 里的 row id。 */
export const name = 'example-plugin'

/**
 * 激活前置：本插件在 apply 里要用到 `ctx.tools` 与 `ctx.systemPrompt`，
 * 声明成 inject 让 cordis 按服务可用性来编排加载顺序，而不是靠行序。
 */
export const inject = ['tools', 'systemPrompt'] as const

/** 部署期可变的配置；每个字段都要 JSDoc，config 目录会据此生成。 */
export interface Config {
  /** `greet` 工具回复时使用的前缀词。 */
  greeting: string
  /** 系统提示词 section 的排序位；100–199 是「工具指导」区间。 */
  order: number
}

/** schemastery schema；其校验输出必须与 `Config` 等价，默认值就近写在字段上。 */
export const Config: z<Config> = z.object({
  greeting: z.string().default('hello'),
  order: z.number().default(120),
})

/**
 * 注册本插件的贡献。这里的一切都必须是「可回滚的副作用」：
 * cordis 卸载本 fiber 时会自动撤销注册，因此不在这里做任何持久化。
 */
export function apply(ctx: Context, config: Config): void {
  // 模型可见工具：schema 会自动并入系统提示词的工具清单。
  ctx.tools.register(
    defineTool({
      name: 'greet',
      description: 'Say hello to a name (example plugin).',
      parameters: {
        who: { type: 'string', required: true, description: 'Name to greet.' },
      },
      // output 是必填项（见手册 §2.2）：schema 描述返回结构，render 决定回灌给模型的文本。
      // 注意：真实 0.2.1-rc.3 的 value schema DSL 只接受「属性级 required: true」，
      // 对象层写 required 会抛 JsonSchemaError（手册示例此处有误，已按 tool-todo 真实范例修正）。
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
      },
      async execute(args) {
        return { text: `${config.greeting}, ${args.who}` }
      },
    }),
  )

  // 系统提示词 section：告诉模型什么时候该用上面的工具。
  ctx.systemPrompt.section({
    name: 'example-plugin:guide',
    order: config.order,
    text: 'Use the `greet` tool when you need to greet someone.',
  })
}
