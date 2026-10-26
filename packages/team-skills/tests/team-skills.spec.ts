import { describe, expect, it } from 'vitest'
import TeamSkillsService from '../src/index.ts'

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
  const ctx: any = {
    get: (n: string) => services[n],
    effect: (fn: () => unknown) => fn(),
    logger: { warn() {}, debug() {} },
    reflect: { provide() {} },
  }
  return ctx
}

const cfg = { unrestrictedWhenUndeclared: true }
const A = { id: 'a' } as never
const B = { id: 'b' } as never

describe('@elinpf/dsh-swarm-team-skills', () => {
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
    // 条目 malformed → 跳过 → 视为无文档
    expect(s.visibleTo(A)).toBe('unrestricted')
  })

  it('HMR 安全：declare 的 disposer 撤销后回到无文档', () => {
    const s = new TeamSkillsService(makeCtx(), cfg)
    const off = s.declare('t1', { a: ['x'] })
    expect(s.visibleTo(A)).toEqual(['x'])
    off()
    expect(s.visibleTo(A)).toBe('unrestricted')
  })
})
