import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isModelInvocable, type SkillSummary } from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import TeamSkillsService from '../src/index.ts'

/**
 * 行为级单测：用**真实** cordis Context + 真实 `@deepseek-ai/dsh-skill` SkillRegistry
 * + 真实 `@deepseek-ai/dsh-scope` createScope，验证成员级技能隔离在真实注册表上生效。
 *
 * 不变量：
 *  1. A 成员看不到 B 成员的私有技能（正向注册只落在各自 scope）。
 *  2. 未授权技能不出现。模型的「能力目录」= `list({scope:agent}).filter(isModelInvocable)`；
 *     未授权项被落成 `modelInvocable:false` 的抑制影子，故既不在目录里、也不可被 skill 工具加载。
 *  3. 授权（grant）后立即可见；撤销后不可见。
 *  4. 无文档（unrestricted）→ 看到全局目录本身。
 *  5. 成员 scope 释放（HMR）后落层归零，回到全局目录。
 *
 * 说明：这里模拟真实合成关系——skills 服务由 SkillsFiber 提供；每个 agent 用
 * `createScope(app, agent)` 造出「以 agent 自身为 scope key」的上下文（与
 * `agent-loop/src/agent.ts:130-131` 的真实构造同形）。
 */
const cfg = { unrestrictedWhenUndeclared: true }

async function setup() {
  const root = new Context()
  const skillsFiber = await root.plugin(SkillRegistry)
  const app = skillsFiber.ctx
  app.provide('teamCore', { tryMembership: () => undefined })
  app.provide('agents', {})
  const svc = new TeamSkillsService(app, cfg)

  // 全局技能（模拟 skill-filesystem provider / 全局 runtime 落进 global 层）
  app.skills.register({ name: 'global-skill', description: 'g', source: 'test', content: 'g body' })
  app.skills.register({ name: 'secret', description: 's', source: 'test', content: 's body' })

  const agentA: { id: string; ctx?: unknown } = { id: 'a' }
  const agentB: { id: string; ctx?: unknown } = { id: 'b' }
  const scopeA = createScope(app, agentA)
  const scopeB = createScope(app, agentB)
  agentA.ctx = scopeA.ctx
  agentB.ctx = scopeB.ctx

  /** 模型实际看到的能力目录（提示词/工具同源）。 */
  const modelCatalog = async (agent: object): Promise<string[]> =>
    (await app.skills.list({ scope: agent }))
      .filter((s: SkillSummary) => isModelInvocable(s))
      .map((s) => s.name)
      .sort()

  return { app, svc, agentA, agentB, scopeA, scopeB, modelCatalog }
}

describe('@elinpf/dsh-swarm-team-skills（真实注册表行为级）', () => {
  it('B 的私有技能只落到 B 的 scope：A 看不到、也加载不到', async () => {
    const { app, svc, agentA, agentB, modelCatalog } = await setup()
    svc.declare('t', { a: ['global-skill'], b: ['b-private'] })
    await svc.reconcile(agentA as never)
    await svc.reconcile(agentB as never)

    expect(await modelCatalog(agentA)).toEqual(['global-skill'])
    expect(await modelCatalog(agentB)).toEqual(['b-private'])

    // A 的目录里没有 B 的私有技能；A 也取不到它的定义
    expect(await modelCatalog(agentA)).not.toContain('b-private')
    expect(await app.skills.get('b-private', { scope: agentA })).toBeUndefined()
    // B 自己能取到
    expect((await app.skills.get('b-private', { scope: agentB }))?.name).toBe('b-private')
  })

  it('未授权技能不进入模型目录（连同名全局技能也压制）', async () => {
    const { svc, agentA, agentB, modelCatalog } = await setup()
    svc.declare('t', { a: ['global-skill'], b: ['b-private'] })
    await svc.reconcile(agentA as never)
    await svc.reconcile(agentB as never)

    // 'secret' 全局存在，但两家都未授权 → 不在任何人的目录里
    expect(await modelCatalog(agentA)).not.toContain('secret')
    expect(await modelCatalog(agentB)).not.toContain('secret')
    // 授权给 A 的 'global-skill' 仍是真实全局技能（未被占位体顶替）
    expect(await modelCatalog(agentA)).toContain('global-skill')
  })

  it('grant 后立即可见；撤销后回到不可见', async () => {
    const { svc, agentA, modelCatalog } = await setup()
    svc.declare('t', { a: ['global-skill'] })
    await svc.reconcile(agentA as never)
    expect(await modelCatalog(agentA)).not.toContain('secret')

    const off = svc.grant(agentA as never, ['secret'])
    await svc.reconcile(agentA as never)
    expect(await modelCatalog(agentA)).toContain('secret')

    off()
    await svc.reconcile(agentA as never)
    expect(await modelCatalog(agentA)).not.toContain('secret')
  })

  it('无文档（unrestricted）→ 成员看到全局目录本身', async () => {
    const { svc, agentB, modelCatalog } = await setup()
    expect(svc.visibleTo(agentB as never)).toBe('unrestricted')
    await svc.reconcile(agentB as never)
    expect(await modelCatalog(agentB)).toEqual(['global-skill', 'secret'])
  })

  it('成员 scope 释放（HMR）后落层归零，回到全局目录', async () => {
    const { svc, agentA, scopeA, modelCatalog } = await setup()
    svc.declare('t', { a: ['global-skill'] })
    await svc.reconcile(agentA as never)
    expect(await modelCatalog(agentA)).toEqual(['global-skill'])

    await scopeA.dispose()
    // scope 释放 → 其 scope 层全部注册被撤销 → 该 key 的视图回到全局目录
    expect(await modelCatalog(agentA as never)).toEqual(['global-skill', 'secret'])
  })

  it('reconcile 幂等：重复调用不改变结果、不抛', async () => {
    const { svc, agentA, modelCatalog } = await setup()
    svc.declare('t', { a: ['global-skill'] })
    await svc.reconcile(agentA as never)
    const first = await modelCatalog(agentA)
    await svc.reconcile(agentA as never)
    await svc.reconcile(agentA as never)
    expect(await modelCatalog(agentA)).toEqual(first)
  })
})
