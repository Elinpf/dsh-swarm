import { describe, expect, it } from 'vitest'
import TeamCompletionService from '../src/index.ts'

function makeCtx(state: { tasks: any[]; members: any[] }) {
  const emitted: string[] = []
  const durable: Array<{ type: string; payload: unknown }> = []
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
    logger: { warn() {}, debug() {}, info() {} },
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
    emit: (n: string, p?: unknown) => {
      emitted.push(n)
      durable.push({ type: n, payload: p })
    },
    _emitted: emitted,
    _durable: durable,
    _handlers: handlers,
    _disposeAll: () => disposers.forEach((d) => d()),
  }
  return { ctx, emitted, handlers, durable }
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

describe('@elinpf/dsh-swarm-team-completion', () => {
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
    expect(emitted.filter((n) => n === 'swarm/team/completed')).toHaveLength(2) // 两次上升沿（忽略 durable unread 事件）
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

  it('有 in_review 任务 → 不完成（评审态非终态，防提前判完成；通过后才完成）', async () => {
    const inReviewTask = { ...doneTask, status: 'in_review' }
    const { ctx, emitted } = makeCtx({ tasks: [inReviewTask], members: [idleMember] })
    const c = new TeamCompletionService(ctx, { blockOnUnread: true })
    expect((await c.evaluate(lead)).completed).toBe(false)
    expect(emitted).toEqual([])

    // 评审通过（in_review → completed）后才算完成
    ;(ctx.teamCore as { listTasks: () => unknown }).listTasks = () => [{ ...doneTask }]
    expect((await c.evaluate(lead)).completed).toBe(true)
    expect(emitted).toEqual(['swarm/team/completed'])
  })

  it('恢复（ADR-0002）：重建服务 + recover(durable) → unread 台账重建；未恢复则 0（可能提前判完成）', () => {
    const a = makeCtx({ tasks: [doneTask], members: [idleMember] })
    const c = new TeamCompletionService(a.ctx, { blockOnUnread: true })
    a.handlers['session/event']![0]!({}, { type: 'team/message/queued' })
    a.handlers['session/event']![0]!({}, { type: 'team/message/queued' })
    expect(c.unreadCount).toBe(2)

    const b = makeCtx({ tasks: [doneTask], members: [idleMember] })
    const c2 = new TeamCompletionService(b.ctx, { blockOnUnread: true })
    expect(c2.unreadCount).toBe(0) // 未恢复 → 0（缺陷）
    c2.recover(a.durable)
    expect(c2.unreadCount).toBe(2) // 恢复 → 台账重建
  })

  it('计划闸（P30/T8）：planned 任务非终态 → 不判团队完成', async () => {
    const planned = { ...doneTask, status: 'planned' }
    const { ctx, emitted } = makeCtx({ tasks: [planned], members: [idleMember] })
    const c = new TeamCompletionService(ctx, { blockOnUnread: true })
    expect((await c.evaluate(lead)).completed).toBe(false)
    expect(emitted).toEqual([])
  })
})
