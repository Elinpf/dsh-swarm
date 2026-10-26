import { describe, expect, it } from 'vitest'
import TeamCompletionService from '../src/index.ts'

function makeCtx(state: { tasks: any[]; members: any[] }) {
  const emitted: string[] = []
  const handlers: Record<string, Array<(...a: any[]) => unknown>> = {}
  const disposers: Array<() => void> = []
  const teamCore = {
    backend: 'native' as const,
    listTasks: () => state.tasks,
    listMembers: () => state.members,
    tryMembership: (a: { id?: string }) => state.members.find((m) => m.id === a?.id),
  }
  const ctx: any = {
    teamCore,
    teamBus: {},
    sessions: {},
    logger: { warn() {}, debug() {} },
    reflect: { provide() {} },
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    on: (n: string, h: (...a: any[]) => unknown) => {
      ;(handlers[n] ??= []).push(h)
      return () => {
        const a = handlers[n]!
        const i = a.indexOf(h)
        if (i >= 0) a.splice(i, 1)
      }
    },
    emit: (n: string) => void emitted.push(n),
    _emitted: emitted,
    _handlers: handlers,
    _disposeAll: () => disposers.forEach((d) => d()),
  }
  return { ctx, emitted, handlers }
}

const lead = { id: 'lead' } as never
const doneTask = {
  id: 't1',
  revision: 2,
  subject: '',
  description: '',
  status: 'completed',
  blockedBy: [],
  ready: false,
}
const idleMember = { id: 'lead', name: 'lead', role: 'lead', phase: 'active', status: 'idle' }

describe('@dsh-swarm/team-completion', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamCompletionService).toBe('function')
    expect(TeamCompletionService.inject).toEqual(['teamCore', 'teamBus', 'sessions'])
  })

  it('三条件满足 → completed=true 且恰好发一次事件（上升沿守卫）', async () => {
    const { ctx, emitted } = makeCtx({ tasks: [doneTask], members: [idleMember] })
    const c = new TeamCompletionService(ctx, { blockOnUnread: true })
    const r1 = await c.evaluate(lead)
    expect(r1.completed).toBe(true)
    expect(r1.snapshot).toEqual({ tasks: 1, members: 1 })
    const r2 = await c.evaluate(lead)
    expect(r2.completed).toBe(true)
    expect(emitted).toEqual(['swarm/team/completed']) // 只发一次
  })

  it('有未读消息 → completed=false（且条件恢复后重新上升沿）', async () => {
    const { ctx, emitted, handlers } = makeCtx({ tasks: [doneTask], members: [idleMember] })
    const c = new TeamCompletionService(ctx, { blockOnUnread: true })
    expect((await c.evaluate(lead)).completed).toBe(true)

    handlers['session/event']![0]!({}, { type: 'team/message/queued' })
    expect(c.unreadCount).toBe(1)
    expect((await c.evaluate(lead)).completed).toBe(false)

    handlers['session/event']![0]!({}, { type: 'team/message/delivered' })
    expect(c.unreadCount).toBe(0)
    expect((await c.evaluate(lead)).completed).toBe(true)
    expect(emitted).toHaveLength(2) // 两次上升沿
  })

  it('无任务 / 有 running 成员 → 不完成', async () => {
    const a = makeCtx({ tasks: [], members: [idleMember] })
    const ca = new TeamCompletionService(a.ctx, { blockOnUnread: true })
    expect((await ca.evaluate(lead)).completed).toBe(false)

    const b = makeCtx({ tasks: [doneTask], members: [{ ...idleMember, status: 'running' }] })
    const cb = new TeamCompletionService(b.ctx, { blockOnUnread: true })
    expect((await cb.evaluate(lead)).completed).toBe(false)
  })

  it('blockOnUnread=false → 忽略未读', async () => {
    const { ctx, handlers } = makeCtx({ tasks: [doneTask], members: [idleMember] })
    const c = new TeamCompletionService(ctx, { blockOnUnread: false })
    handlers['session/event']![0]!({}, { type: 'team/message/queued' })
    expect((await c.evaluate(lead)).completed).toBe(true)
  })
})
