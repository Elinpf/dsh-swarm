import { describe, expect, it } from 'vitest'
import TeamMemoryService from '../src/index.ts'

function makeCtx() {
  const members = [
    { id: 'lead', name: 'lead', role: 'lead' },
    { id: 'a', name: 'alice', role: 'teammate' },
    { id: 'b', name: 'bob', role: 'teammate' },
  ]
  const sections: any[] = []
  const contexts: any[] = []
  const services: Record<string, unknown> = {
    teamCore: { tryMembership: (ag: { id?: string }) => members.find((m) => m.id === ag?.id) },
    sessions: {},
  }
  const ctx: any = {
    get: (n: string) => services[n],
    systemPrompt: {
      section: (s: any) => {
        sections.push(s)
        return () => {}
      },
      context: (c: any) => {
        contexts.push(c)
        return () => {
          const i = contexts.indexOf(c)
          if (i >= 0) contexts.splice(i, 1)
        }
      },
    },
    effect: (fn: () => unknown) => {
      const d = fn()
      ;(ctx as any)._cleanup = d
      return d
    },
    logger: { warn() {}, debug() {} },
    reflect: { provide() {} },
    _sections: sections,
    _contexts: contexts,
  }
  return ctx
}

const LEAD = { id: 'lead' } as never
const A = { id: 'a' } as never
const B = { id: 'b' } as never
const cfg = { sharedWriter: 'lead' as const }

describe('@elinpf/dsh-swarm-team-memory', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamMemoryService).toBe('function')
    expect(TeamMemoryService.inject).toEqual(['systemPrompt', 'teamCore', 'sessions'])
  })

  it('共享记忆：Lead 可写、成员可读；成员写被拒（授权）', async () => {
    const m = new TeamMemoryService(makeCtx(), cfg)
    await m.appendShared(LEAD, 'team convention')
    expect(m.readShared(A).map((r) => r.text)).toEqual(['team convention'])
    await expect(m.appendShared(A, 'nope')).rejects.toThrow(/TEAMMEM_NOT_AUTHORIZED/)
  })

  it('成员私有记忆隔离：本人 recall 可见，他人不可见', async () => {
    const m = new TeamMemoryService(makeCtx(), cfg)
    await m.appendShared(LEAD, 'shared')
    await m.memberNote(A, 'a-secret')
    await m.memberNote(B, 'b-secret')
    expect(m.recall(A).map((r) => r.text)).toEqual(['shared', 'a-secret'])
    expect(m.recall(B).map((r) => r.text)).toEqual(['shared', 'b-secret'])
    expect(m.recall(A).some((r) => r.text === 'b-secret')).toBe(false)
  })

  it('注入走 context（用户消息侧），不进 section 前缀；文本为共享记忆', async () => {
    const ctx = makeCtx()
    const m = new TeamMemoryService(ctx, cfg)
    await m.appendShared(LEAD, 'line-1')
    expect(ctx._sections).toHaveLength(0)
    expect(ctx._contexts).toHaveLength(1)
    expect(ctx._contexts[0].name).toBe('team:memory')
    expect(ctx._contexts[0].text()).toContain('line-1')
  })

  it('HMR 安全：dispose 后 context 注册归零、记忆清空', async () => {
    const ctx = makeCtx()
    const m = new TeamMemoryService(ctx, cfg)
    await m.appendShared(LEAD, 'x')
    expect(ctx._contexts).toHaveLength(1)
    ctx._cleanup()
    expect(ctx._contexts).toHaveLength(0)
    expect(m.readShared(A)).toHaveLength(0)
  })
})
