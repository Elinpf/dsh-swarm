import { describe, expect, it } from 'vitest'
import TeamSkillsService from '../src/index.ts'

/**
 * 声明层语义单测（不依赖真实技能注册表）。
 * **成员级落层的真实行为**由 `team-skills-scope.spec.ts` 用真实 cordis + 真实 SkillRegistry 覆盖。
 */
function makeCtx() {
  const members = [
    { id: 'a', name: 'alice' },
    { id: 'b', name: 'bob' },
  ]
  const services: Record<string, unknown> = {
    skills: {},
    agents: {},
    teamCore: { tryMembership: (ag: { id?: string }) => members.find((m) => m.id === ag?.id) },
  }
  const cleanups: Array<() => void> = []
  const emitted: Array<{ type: string; payload: unknown }> = []
  const ctx: any = {
    get: (n: string) => services[n],
    effect: (fn: () => unknown) => {
      const off = fn() as (() => void) | undefined
      if (typeof off === 'function') cleanups.push(off)
      return off
    },
    logger: { warn() {}, debug() {}, info() {} },
    reflect: { provide() {} },
    on: () => () => {},
    emit: (n: string, p: unknown) => emitted.push({ type: n, payload: p }),
  }
  ctx._cleanup = () => cleanups.splice(0).forEach((f) => f())
  ctx._emitted = emitted
  return ctx
}

const cfg = { unrestrictedWhenUndeclared: true }
const A = { id: 'a' } as never
const B = { id: 'b' } as never

describe('@elinpf/dsh-swarm-team-skills（声明层）', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamSkillsService).toBe('function')
    expect(TeamSkillsService.inject).toEqual(['skills', 'agents', 'teamCore'])
  })

  it('权限隔离：A 可见 [arch-design]，B 不可见，不泄露', () => {
    const s = new TeamSkillsService(makeCtx(), cfg)
    s.declare('t1', { a: ['arch-design'], b: [] })
    expect(s.visibleTo(A)).toEqual(['arch-design'])
    expect(s.visibleTo(B)).toEqual([])
    expect(s.visibleTo(B)).not.toContain('arch-design')
  })

  it("通配 '*' 生效；无文档 → unrestricted", () => {
    const s = new TeamSkillsService(makeCtx(), cfg)
    s.declare('t1', { '*': ['shared'] })
    expect(s.visibleTo(A)).toEqual(['shared'])
    expect(s.visibleTo(B)).toEqual(['shared'])

    const s2 = new TeamSkillsService(makeCtx(), cfg)
    expect(s2.visibleTo(A)).toBe('unrestricted')
  })

  it('grant 追加授权，visibleTo 立即反映；disposer 撤销', () => {
    const s = new TeamSkillsService(makeCtx(), cfg)
    s.declare('t1', { a: ['x'], b: [] })
    const off = s.grant(B, ['y'])
    expect(s.visibleTo(B)).toEqual(['y'])
    off()
    expect(s.visibleTo(B)).toEqual([])
  })

  it('malformed 文档条目被跳过（不抛）', () => {
    const s = new TeamSkillsService(makeCtx(), cfg)
    s.declare('t1', { a: [123] as never })
    expect(s.visibleTo(A)).toBe('unrestricted')
  })

  it('HMR 安全：declare 的 disposer 撤销后回到无文档', () => {
    const s = new TeamSkillsService(makeCtx(), cfg)
    const off = s.declare('t1', { a: ['x'] })
    expect(s.visibleTo(A)).toEqual(['x'])
    off()
    expect(s.visibleTo(A)).toBe('unrestricted')
  })

  it('无 agent.ctx 时不抛（降级为仅声明）', () => {
    const s = new TeamSkillsService(makeCtx(), cfg)
    s.declare('t1', { a: ['x'] })
    expect(() => s.visibleTo(A)).not.toThrow()
    expect(s.visibleTo(A)).toEqual(['x'])
  })

  it('dispose（effect 回滚）后清空内部注册表', () => {
    const ctx = makeCtx()
    const s = new TeamSkillsService(ctx, cfg)
    s.declare('t1', { a: ['arch-design'] })
    expect(s.visibleTo(A)).toEqual(['arch-design'])
    ctx._cleanup()
    expect(s.visibleTo(A)).toBe('unrestricted')
  })

  it('恢复（ADR-0002）：重建服务 + recover(durable) → 可见性文档/授权仍在；未恢复则 unrestricted（越权风险）', () => {
    const ctx = makeCtx()
    const s = new TeamSkillsService(ctx, cfg)
    s.declare('t1', { a: ['arch-design'], b: [] })
    s.grant(B, ['extra']) // B 追加授权
    const emitted = ctx._emitted as Array<{ type: string; payload: unknown }>
    expect(emitted.map((e) => e.type)).toEqual(
      expect.arrayContaining(['swarm/skills/visibility', 'swarm/skills/grant']),
    )

    const s2 = new TeamSkillsService(makeCtx(), cfg) // 重建（模拟重启）
    expect(s2.visibleTo(A)).toBe('unrestricted') // 未恢复 → 无文档=unrestricted（缺陷：可能越权可见）
    s2.recover(emitted)
    expect(s2.visibleTo(A)).toEqual(['arch-design'])
    expect(s2.visibleTo(B)).toEqual(['extra'])
  })
})
