#!/usr/bin/env node
/**
 * 可执行的加载验证（`pnpm verify` 的核心），覆盖 dsh-swarm 的全部包。
 *
 * 与单测不同，这里不起假 ctx，而是对每个插件起一个**真实 cordis 运行时**（DSH 的内核），
 * 用 host 插件准备好它 `inject` 的服务，然后 `ctx.plugin()` 真正加载**构建产物**，断言：
 *   - 产物可被 cordis 加载成 fiber；
 *   - 加载后确实观察到它声明的服务 / 工具 / section；
 *   - fiber 卸载后这些注册归零（Cordis 效应回滚）。
 * 契约包（纯类型）单独做「运行时零导出」检查。
 *
 * 这是「插件能被 DSH 加载 / 能观察到预期行为」的最小证据。
 */
import { Context } from '@deepseek-ai/cordis'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let failures = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  failures++
  console.error(`[FAIL] ${m}`)
}
const assert = (c, m) => (c ? ok(m) : bad(m))

/** 起真实 cordis 上下文，并准备一套 mock 服务供各插件 inject。 */
async function withContext(fn, skipServices = []) {
  const tools = []
  const sections = []
  const contexts = []
  const ctxRoot = new Context()

  const leadMember = { id: 'lead', name: 'lead', role: 'lead', phase: 'active', status: 'idle' }
  const teamCore = {
    backend: 'native',
    membership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
    tryMembership: () => ({ id: 'lead', role: 'lead', name: 'lead' }),
    listMembers: () => [leadMember],
    listTasks: () => [],
    getTask: () => ({
      id: 't1',
      revision: 0,
      subject: '',
      description: '',
      status: 'pending',
      blockedBy: [],
      ready: true,
    }),
    updateTask: async () => ({
      id: 't1',
      revision: 1,
      subject: '',
      description: '',
      status: 'completed',
      blockedBy: [],
      ready: false,
    }),
    send: async () => ({ messageId: 'm1', status: 'accepted' }),
  }

  const host = {
    name: 'verify-host',
    apply(ctx) {
      const remove = (arr, item) => () => {
        const i = arr.indexOf(item)
        if (i >= 0) arr.splice(i, 1)
      }
      ctx.provide('tools', {
        register: (t) => {
          tools.push(t)
          return remove(tools, t)
        },
      })
      ctx.provide('systemPrompt', {
        section: (s) => {
          sections.push(s)
          return remove(sections, s)
        },
        context: (c) => {
          contexts.push(c)
          return remove(contexts, c)
        },
      })
      ctx.provide('sessions', {})
      ctx.provide('agents', { list: () => [] })
      ctx.provide('subagents', {})
      ctx.provide('teamCore', teamCore)
      if (skipServices.includes('teamBus')) return
      ctx.provide('teamBus', {
        broadcast: async () => ({ messageId: 'b' }),
        multicast: async () => ({ messageId: 'm' }),
      })
      if (!skipServices.includes('teamReview')) {
        ctx.provide('teamReview', {
          submitForReview: async () => ({ id: 't', status: 'in_progress' }),
          vote: async () => {},
        })
      }
    },
  }

  await ctxRoot.plugin(host)
  return fn({ ctxRoot, tools, sections, contexts })
}

const PACKAGES = [
  {
    name: '@dsh-swarm/team-core-contract',
    file: 'packages/team-core-contract/lib/index.js',
    kind: 'types',
  },
  {
    name: '@dsh-swarm/example-plugin',
    file: 'packages/example-plugin/lib/index.js',
    config: { greeting: 'hello', order: 120 },
    expectTools: ['greet'],
    expectSections: ['example-plugin:guide'],
    // example-plugin 直接调 ctx.tools.register（真实 ToolRuntime 自带 effect 回滚）；
    // 本脚本 mock 服务不挂 cordis effect，故其回滚由单测覆盖，这里只校验 fiber 生命周期。
    expectRollback: false,
  },
  {
    name: '@dsh-swarm/team-bus',
    file: 'packages/team-bus/lib/index.js',
    config: { maxFanout: 64, maxMessageBytes: 65536 },
    expectService: 'teamBus',
    provides: ['teamBus'],
  },
  {
    name: '@dsh-swarm/team-prompt',
    file: 'packages/team-prompt/lib/index.js',
    config: { locales: 'cn', leaderProgressiveDisclosure: true, sections: [] },
    expectSections: ['team:role', 'team:inbound'],
  },
  {
    name: '@dsh-swarm/team-scheduler',
    file: 'packages/team-scheduler/lib/index.js',
    config: {
      mode: 'autonomous',
      pollMs: 30000,
      staleClaimIdleMs: 600000,
      staleEscalateStreak: 3,
      busyTaskStatuses: ['pending', 'in_progress'],
    },
    expectService: 'teamScheduler',
  },
  {
    name: '@dsh-swarm/team-review',
    file: 'packages/team-review/lib/index.js',
    config: { pools: [], maxRounds: 3, stallTimeoutMs: 1800000 },
    expectService: 'teamReview',
    provides: ['teamReview'],
  },
  {
    name: '@dsh-swarm/team-completion',
    file: 'packages/team-completion/lib/index.js',
    config: { blockOnUnread: true },
    expectService: 'teamCompletion',
  },
  {
    name: '@dsh-swarm/tool-swarm',
    file: 'packages/tool-swarm/lib/index.js',
    config: { enableBroadcast: true, enableReview: true },
    expectTools: ['broadcast', 'multicast', 'review_submit', 'review_vote', 'team_summary'],
  },
]

for (const p of PACKAGES) {
  console.log(`\n== ${p.name} (${p.file}) ==`)

  if (p.kind === 'types') {
    const mod = await import(pathToFileURL(resolve(root, p.file)).href)
    assert(Object.keys(mod).length === 0, '纯类型包：运行时零导出（无实现）')
    continue
  }

  const mod = await import(pathToFileURL(resolve(root, p.file)).href)
  const plugin = mod.default ?? mod
  // 被测插件自己提供的服务不能由 host 预先 mock，否则冲突。
  const skip = p.provides ?? []
  await withContext(async ({ ctxRoot, tools, sections }) => {
    const fiber = await ctxRoot.plugin(plugin, p.config)
    assert(fiber != null, 'ctx.plugin() 返回 fiber')

    if (p.expectService) {
      assert(typeof ctxRoot[p.expectService] === 'object', `观察到服务 ctx.${p.expectService}`)
    }
    if (p.expectTools) {
      const names = tools.map((t) => t.name)
      for (const t of p.expectTools) assert(names.includes(t), `观察到工具 ${t}`)
    }
    if (p.expectSections) {
      const names = sections.map((s) => s.name)
      for (const s of p.expectSections) assert(names.includes(s), `观察到 section ${s}`)
    }

    await fiber.dispose()
    if (p.expectService) {
      assert(ctxRoot[p.expectService] === undefined, `卸载后 ctx.${p.expectService} 消失`)
    }
    if (p.expectRollback === false) {
      assert(fiber.state === 4, `fiber 卸载后状态为 DISPOSED（当前 ${fiber.state}）`)
    } else {
      assert(tools.length === 0, `卸载后工具归零（剩余 ${tools.length}）`)
      assert(sections.length === 0, `卸载后 section 归零（剩余 ${sections.length}）`)
    }
  }, skip)
}

if (failures === 0) {
  console.log('\n✅ 加载验证通过：全部插件可被真实 cordis 运行时加载并观察到预期行为。')
} else {
  console.error(`\n❌ 加载验证失败：${failures} 项断言未通过。`)
  process.exit(1)
}
