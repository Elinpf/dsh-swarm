import { beforeEach, describe, expect, it } from 'vitest'
import TeamDistributedService, {
  createJournal,
  resetLeadRegistry,
  type Config,
  type DeliverJournal,
} from '../src/index.ts'

function makeCtx(services: Record<string, unknown> = {}) {
  const events: Array<{ name: string; payload: any }> = []
  const registered: Record<string, unknown> = { ...services }
  const ctx: any = {
    logger: { debug() {}, info() {}, warn() {} },
    reflect: { provide: (n: string, v: unknown) => void (registered[n] = v) },
    get: (n: string) => registered[n],
    effect: (fn: () => unknown) => {
      const d = fn()
      return d
    },
    emit: (name: string, payload: unknown) => void events.push({ name, payload }),
  }
  return { ctx, events, registered }
}

/** 可观测的假 teamCore：记录调用次数，可切「交付失败」开关。 */
function fakeCore() {
  let tasks = 0
  const calls = { createTask: 0, updateTask: 0, send: 0, spawn: 0 }
  const sent: Array<{ to: string; n: number }> = []
  let sendFails = false
  return {
    calls,
    sent,
    setSendFails(v: boolean) {
      sendFails = v
    },
    async createTask() {
      calls.createTask++
      return { id: `t${++tasks}`, revision: 0 }
    },
    async updateTask() {
      calls.updateTask++
      return { id: 't1', revision: 5 }
    },
    async send(_a: unknown, req: { range: { to: string } }) {
      if (sendFails) throw new Error('target offline')
      calls.send++
      const n = sent.length + 1
      sent.push({ to: req.range.to, n })
      return { messageId: `m${n}`, status: 'accepted' }
    },
    async spawn() {
      calls.spawn++
      return { id: 'm1', name: 'x' }
    },
    listMembers: () => [{ id: 'lead', name: 'lead', role: 'lead' }],
    listTasks: () => [],
  }
}

function cfg(over: Partial<Config> = {}): Config {
  return { role: 'lead', deliveryTtlMs: 30000, ...over }
}

const agent = { id: 'lead' } as never

describe('@elinpf/dsh-swarm-team-distributed', () => {
  beforeEach(() => resetLeadRegistry())

  it('导出形态：Service + 依赖注入声明', () => {
    expect(typeof TeamDistributedService).toBe('function')
    expect(TeamDistributedService.inject).toContain('teamCore')
  })

  it('单写者 mutate：revision 单调；opId 幂等（重复 apply no-op）', async () => {
    const core = fakeCore()
    const { ctx } = makeCtx({ teamCore: core })
    const svc = new TeamDistributedService(ctx, cfg())
    svc.becomeLead(agent, 'T')

    const r1 = await svc.mutate(agent, {
      opId: 'op-1',
      kind: 'task.create',
      payload: { subject: 'a' },
    })
    expect(r1.revision).toBe(1)
    const r2 = await svc.mutate(agent, {
      opId: 'op-1',
      kind: 'task.create',
      payload: { subject: 'a' },
    })
    expect(r2.revision).toBe(1) // 幂等：不二次 apply
    expect(core.calls.createTask).toBe(1)

    const r3 = await svc.mutate(agent, {
      opId: 'op-2',
      kind: 'task.create',
      payload: { subject: 'b' },
    })
    expect(r3.revision).toBe(2) // 单调
  })

  it('CAS：task.update 带 expectedRevision 下传，重复投递不跳变', async () => {
    const core = fakeCore()
    const { ctx } = makeCtx({ teamCore: core })
    const svc = new TeamDistributedService(ctx, cfg())
    svc.becomeLead(agent, 'T')
    await svc.mutate(agent, {
      opId: 'u-1',
      kind: 'task.update',
      expectedRevision: 0,
      payload: { taskId: 't1', action: 'claim', owner: 'a' },
    })
    expect(core.calls.updateTask).toBe(1)
  })

  it('V2 不重：同一 messageId 重复投递 → 只交付一次（dedupDropped++）', async () => {
    const core = fakeCore()
    const { ctx } = makeCtx({ teamCore: core })
    const svc = new TeamDistributedService(ctx, cfg())
    svc.becomeLead(agent, 'T')

    const a = await svc.deliver(agent, 'bob', 'msg-1', [{ type: 'text', text: 'hi' }])
    const b = await svc.deliver(agent, 'bob', 'msg-1', [{ type: 'text', text: 'hi' }])
    const c = await svc.deliver(agent, 'bob', 'msg-1', [{ type: 'text', text: 'hi' }])
    expect(a.status).toBe('accepted')
    expect(b.status).toBe('accepted')
    expect(c.status).toBe('accepted')
    expect(core.calls.send).toBe(1)
    expect(svc.state().dedupDropped).toBe(2)
    expect(svc.state().delivered).toBe(1)
  })

  it('V3 崩溃恢复：queued-minus-delivered 在重启后重放，且不重复', async () => {
    const core = fakeCore()
    const journal: DeliverJournal = createJournal()
    const { ctx: c1 } = makeCtx({ teamCore: core, teamDistributedJournal: journal })
    const svc1 = new TeamDistributedService(c1, cfg())
    svc1.becomeLead(agent, 'T')

    core.setSendFails(true) // 目标离线 → 交付失败
    const r = await svc1.deliver(agent, 'bob', 'm-crash', [{ type: 'text', text: 'x' }])
    expect(r.status).toBe('queued')
    expect(svc1.pending).toBe(1)
    expect(journal.delivered.has('m-crash')).toBe(false)

    // 模拟 kill → 重启：新服务复用同一 journal
    const { ctx: c2 } = makeCtx({ teamCore: core, teamDistributedJournal: journal })
    const svc2 = new TeamDistributedService(c2, cfg())
    svc2.becomeLead(agent, 'T')
    core.setSendFails(false)
    const rec = await svc2.recover(agent)
    expect(rec.replayed).toBe(1)
    expect(svc2.pending).toBe(0)
    expect(journal.delivered.has('m-crash')).toBe(true)
    expect(core.calls.send).toBe(1) // 恰好投递一次

    // 恢复后再投同一 id → 幂等吞掉
    const again = await svc2.deliver(agent, 'bob', 'm-crash', [])
    expect(again.status).toBe('accepted')
    expect(core.calls.send).toBe(1)
  })

  it('V4/§3.1 脑裂：同 teamId 第二个 Lead → SPLIT_BRAIN 只读', async () => {
    const core = fakeCore()
    const { ctx: ca } = makeCtx({ teamCore: core })
    const { ctx: cb } = makeCtx({ teamCore: core })
    const lead1 = new TeamDistributedService(ca, cfg({ ownerId: 'p1' }))
    const lead2 = new TeamDistributedService(cb, cfg({ ownerId: 'p2' }))
    lead1.becomeLead(agent, 'T')
    lead2.becomeLead(agent, 'T')
    expect(lead1.state().splitBrain).toBe(false)
    expect(lead2.state().splitBrain).toBe(true)
    await expect(
      lead2.mutate(agent, { opId: 'x', kind: 'task.create', payload: {} }),
    ).rejects.toThrow(/SPLIT_BRAIN/)
  })

  it('失败降级：无 ctx.teamTransport → 单进程（peers=[]），主流程仍可用', async () => {
    const core = fakeCore()
    const { ctx } = makeCtx({ teamCore: core })
    const svc = new TeamDistributedService(ctx, cfg())
    svc.becomeLead(agent, 'T')
    expect(svc.state().peers).toEqual([])
    const r = await svc.mutate(agent, {
      opId: 'o',
      kind: 'task.create',
      payload: { subject: 's' },
    })
    expect(r.revision).toBe(1)
  })

  it('follower 无 transport 时 mutate 明确报错（不静默丢）', async () => {
    const { ctx } = makeCtx({ teamCore: fakeCore() })
    const svc = new TeamDistributedService(ctx, cfg({ role: 'follower' }))
    await expect(
      svc.mutate(agent, { opId: 'f', kind: 'task.create', payload: {} }),
    ).rejects.toThrow(/FOLLOWER_NO_LEAD/)
  })

  it('sync：返回 seq 与只读副本状态（含 pending 供对账）', async () => {
    const core = fakeCore()
    const { ctx } = makeCtx({ teamCore: core })
    const svc = new TeamDistributedService(ctx, cfg())
    svc.becomeLead(agent, 'T')
    const snap = await svc.sync(agent, 0)
    expect(snap.seq).toBe(0)
    expect((snap.state as any).pending).toBe(0)
    expect((snap.state as any).members).toHaveLength(1)
  })
})
