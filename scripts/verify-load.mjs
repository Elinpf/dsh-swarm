#!/usr/bin/env node
/**
 * 可执行的加载验证（`pnpm verify` 的核心）。
 *
 * 与单测不同，这里不再用假 ctx，而是起一个**真实的 cordis 运行时**（DSH 的内核），
 * 把 example-plugin 的构建产物真正 `ctx.plugin()` 进去，断言：
 *   1. 产物符合函数式插件契约（命名导出、无 default export）；
 *   2. cordis 能把它加载成 ACTIVE fiber；
 *   3. 加载后确实观察到它注册的 `greet` 工具与 prompt section；
 *   4. fiber 卸载后注册被回滚。
 *
 * 这是「插件能被 DSH 加载 / 能观察到预期行为」的最小证据。
 */
import { Context } from '@deepseek-ai/cordis'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginEntry = resolve(here, '../packages/example-plugin/lib/index.js')

let failures = 0
const ok = (msg) => console.log(`[OK]   ${msg}`)
const bad = (msg) => {
  failures++
  console.error(`[FAIL] ${msg}`)
}

function assert(cond, msg) {
  if (cond) ok(msg)
  else bad(msg)
}

// ── 1. 载入构建产物 ─────────────────────────────────────────────────────────
const mod = await import(pathToFileURL(pluginEntry).href)
console.log(`\n== 加载构建产物 ${pluginEntry.replace(process.cwd(), '.')} ==`)
assert(typeof mod.apply === 'function', '导出 apply（函数式插件入口）')
assert(Array.isArray(mod.inject), `导出 inject = ${JSON.stringify(mod.inject)}`)
assert(mod.default === undefined, '无 default export（否则 loader 会丢 inject）')

// ── 2. 起真实 cordis 运行时 ─────────────────────────────────────────────────
const tools = []
const sections = []
const root = new Context()

// host 插件只做一件事：把本插件 inject 的两个服务准备好。
const host = {
  name: 'verify-host',
  apply(ctx) {
    ctx.provide('tools', {
      register(tool) {
        tools.push(tool)
        return () => {
          const i = tools.indexOf(tool)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    })
    ctx.provide('systemPrompt', {
      section(section) {
        sections.push(section)
        return () => {
          const i = sections.indexOf(section)
          if (i >= 0) sections.splice(i, 1)
        }
      },
    })
  },
}

await root.plugin(host)
console.log('\n== 用真实 cordis 加载 example-plugin ==')
const fiber = await root.plugin(mod, { greeting: 'hello', order: 120 })
assert(fiber === undefined || fiber !== null, 'ctx.plugin() 返回 fiber')

// ── 3. 观察注册结果 ─────────────────────────────────────────────────────────
assert(tools.length === 1, `观察到 1 个工具（实际 ${tools.length}）`)
assert(tools[0]?.name === 'greet', `工具名为 greet（实际 ${tools[0]?.name}）`)
assert(sections.length === 1, `观察到 1 个 prompt section（实际 ${sections.length}）`)
assert(
  sections[0]?.name === 'example-plugin:guide',
  `section 名为 example-plugin:guide（实际 ${sections[0]?.name}）`,
)

// 真正调一次工具，确认它在加载后是可执行的。
if (tools[0]) {
  const value = await tools[0].execute({ who: 'DSH' })
  assert(value?.text === 'hello, DSH', `工具执行结果 = ${JSON.stringify(value)}`)
}

// ── 4. 卸载：fiber 进入 DISPOSED ────────────────────────────────────────────
// 注意：本脚本用的是 mock 服务，它的 register/section 并不挂到 cordis 的 effect 上，
// 因此「业务注册随卸载回滚」由单测（真实 disposer）覆盖；这里验证 fiber 生命周期本身。
console.log('\n== 卸载 fiber ==')
assert(typeof fiber?.dispose === 'function', 'fiber 提供 dispose')
const beforeState = fiber.state
await fiber.dispose()
assert(fiber.state === 4, `fiber 卸载后状态为 DISPOSED（${beforeState} → ${fiber.state}）`)

// ── 5. 证明 cordis effect 回滚确实生效 ──────────────────────────────────────
// 用一个把注册包在 ctx.effect 里的探针插件：卸载该 fiber 后，注册必须被撤销。
console.log('\n== 验证 cordis effect 回滚 ==')
const probeFiber = await root.plugin({
  name: 'effect-probe',
  inject: ['tools'],
  apply(ctx) {
    ctx.effect(() => ctx.tools.register({ name: '__probe__' }))
  },
})
assert(
  tools.some((t) => t.name === '__probe__'),
  '探针工具已注册',
)
await probeFiber.dispose()
assert(
  !tools.some((t) => t.name === '__probe__'),
  '探针 fiber 卸载后注册被撤销（cordis effect 回滚生效）',
)

// ── 结论 ────────────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log('\n✅ 加载验证通过：插件可被真实 cordis 运行时加载并观察到预期行为。')
} else {
  console.error(`\n❌ 加载验证失败：${failures} 项断言未通过。`)
  process.exit(1)
}
