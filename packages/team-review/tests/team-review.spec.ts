import { describe, expect, it } from 'vitest'
import TeamReviewService from '../src/index.ts'

function makeCtx(ownerName = 'w') {
  const task: any = {
    id: 't1',
    revision: 0,
    subject: 's',
    description: '',
    status: 'in_progress',
    blockedBy: [],
    ownerName,
    ready: false,
  }
  const members = [
    { id: 'lead', name: 'lead' },
    { id: 'w', name: 'w' },
    { id: 'verifier', name: 'verifier' },
    { id: 'challenger', name: 'challenger' },
    { id: 'inspector', name: 'inspector' },
  ]
  const sent: Array<{ to: string; text: string }> = []
  const disposers: Array<() => void> = []
  const teamCore = {
    backend: 'native' as const,
    getTask: () => ({ ...task }),
    updateTask: async (_c: unknown, req: any) => {
      if (req.action === 'complete') {
        task.status = 'completed'
        task.revision += 1
      }
      return { ...task }
    },
    tryMembership: (a: { id?: string }) => members.find((m) => m.id === a?.id),
    send: async (_c: unknown, req: any) => {
      sent.push({ to: req.range.to, text: req.content?.[0]?.text ?? '' })
      return { messageId: 'm', status: 'accepted' as const }
    },
  }
  const ctx: any = {
    teamCore,
    teamBus: {},
    agents: {},
    subagents: {},
    tools: {},
    logger: { warn() {}, debug() {} },
    reflect: { provide() {} },
    effect: (fn: () => unknown) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return d
    },
    _task: task,
    _sent: sent,
  }
  return { ctx, task, sent }
}

const binaryPools = [
  { kind: 'binary' as const, rule: 'veto' as const, roles: ['verifier', 'challenger'] },
]
const asCaller = (id: string) => ({ id } as never)

describe('@dsh-swarm/team-review', () => {
  it('导出形态：Service（default export）+ inject', () => {
    expect(typeof TeamReviewService).toBe('function')
    expect(TeamReviewService.inject).toEqual([
      'teamCore',
      'teamBus',
      'agents',
      'subagents',
      'tools',
    ])
  })

  it('未配置 reviewer → 直接完成（无门）', async () => {
    const { ctx, task } = makeCtx()
    const rv = new TeamReviewService(ctx, { pools: [], maxRounds: 3, stallTimeoutMs: 1000 })
    await rv.submitForReview(asCaller('w'), 't1')
    expect(task.status).toBe('completed')
  })

  it('配 reviewer → 拦截为评审态（round=1），任务保持 in_progress', async () => {
    const { ctx, task } = makeCtx()
    const rv = new TeamReviewService(ctx, {
      pools: binaryPools,
      maxRounds: 3,
      stallTimeoutMs: 1000,
    })
    const view = await rv.submitForReview(asCaller('w'), 't1')
    expect(view.status).toBe('in_progress')
    expect(rv.inspect('t1')?.round).toBe(1)
    expect(task.status).toBe('in_progress')
  })

  it('二元池一票否决：任一 fail → fail，任务不完成', async () => {
    const { ctx, task } = makeCtx()
    const rv = new TeamReviewService(ctx, {
      pools: binaryPools,
      maxRounds: 3,
      stallTimeoutMs: 1000,
    })
    await rv.submitForReview(asCaller('w'), 't1')
    await rv.vote(asCaller('verifier'), 't1', {
      kind: 'binary',
      decision: 'pass',
      role: 'verifier',
    })
    await rv.vote(asCaller('challenger'), 't1', {
      kind: 'binary',
      decision: 'fail',
      role: 'challenger',
    })
    const v = await rv.settle(asCaller('lead'), 't1')
    expect(v.kind).toBe('fail')
    expect(task.status).toBe('in_progress')
  })

  it('二元池全 pass → pass，任务 completed', async () => {
    const { ctx, task } = makeCtx()
    const rv = new TeamReviewService(ctx, {
      pools: binaryPools,
      maxRounds: 3,
      stallTimeoutMs: 1000,
    })
    await rv.submitForReview(asCaller('w'), 't1')
    await rv.vote(asCaller('verifier'), 't1', {
      kind: 'binary',
      decision: 'pass',
      role: 'verifier',
    })
    await rv.vote(asCaller('challenger'), 't1', {
      kind: 'binary',
      decision: 'pass',
      role: 'challenger',
    })
    const v = await rv.settle(asCaller('lead'), 't1')
    expect(v.kind).toBe('pass')
    expect(task.status).toBe('completed')
  })

  it('打分池阈值：均值 ≥0.85 pass，<0.85 fail', async () => {
    const pools = [{ kind: 'score' as const, threshold: 0.85, roles: ['inspector'] }]
    const a = makeCtx()
    const rvA = new TeamReviewService(a.ctx, { pools, maxRounds: 3, stallTimeoutMs: 1000 })
    await rvA.submitForReview(asCaller('w'), 't1')
    await rvA.vote(asCaller('inspector'), 't1', { kind: 'score', value: 0.9, role: 'inspector' })
    expect((await rvA.settle(asCaller('lead'), 't1')).kind).toBe('pass')

    const b = makeCtx()
    const rvB = new TeamReviewService(b.ctx, { pools, maxRounds: 3, stallTimeoutMs: 1000 })
    await rvB.submitForReview(asCaller('w'), 't1')
    await rvB.vote(asCaller('inspector'), 't1', { kind: 'score', value: 0.5, role: 'inspector' })
    expect((await rvB.settle(asCaller('lead'), 't1')).kind).toBe('fail')
  })

  it('任一池未投完 → undecided', async () => {
    const { ctx } = makeCtx()
    const rv = new TeamReviewService(ctx, {
      pools: binaryPools,
      maxRounds: 3,
      stallTimeoutMs: 1000,
    })
    await rv.submitForReview(asCaller('w'), 't1')
    await rv.vote(asCaller('verifier'), 't1', {
      kind: 'binary',
      decision: 'pass',
      role: 'verifier',
    })
    expect((await rv.settle(asCaller('lead'), 't1')).kind).toBe('undecided')
  })

  it('不可自验：作者投自己的任务 → TEAMREVIEW_SELF_VOTE', async () => {
    const { ctx } = makeCtx('w')
    const rv = new TeamReviewService(ctx, {
      pools: binaryPools,
      maxRounds: 3,
      stallTimeoutMs: 1000,
    })
    await rv.submitForReview(asCaller('w'), 't1')
    await expect(
      rv.vote(asCaller('w'), 't1', { kind: 'binary', decision: 'pass', role: 'verifier' }),
    ).rejects.toThrow(/TEAMREVIEW_SELF_VOTE/)
  })

  it('同一 reviewer 后写覆盖', async () => {
    const { ctx } = makeCtx()
    const rv = new TeamReviewService(ctx, {
      pools: binaryPools,
      maxRounds: 3,
      stallTimeoutMs: 1000,
    })
    await rv.submitForReview(asCaller('w'), 't1')
    await rv.vote(asCaller('verifier'), 't1', {
      kind: 'binary',
      decision: 'fail',
      role: 'verifier',
    })
    await rv.vote(asCaller('verifier'), 't1', {
      kind: 'binary',
      decision: 'pass',
      role: 'verifier',
    })
    await rv.vote(asCaller('challenger'), 't1', {
      kind: 'binary',
      decision: 'pass',
      role: 'challenger',
    })
    expect((await rv.settle(asCaller('lead'), 't1')).kind).toBe('pass')
  })

  it('maxRounds 超限 → 向 Lead 升级并停止自动返工', async () => {
    const { ctx, sent } = makeCtx()
    const rv = new TeamReviewService(ctx, {
      pools: binaryPools,
      maxRounds: 3,
      stallTimeoutMs: 1000,
    })
    await rv.submitForReview(asCaller('w'), 't1')
    await rv.vote(asCaller('verifier'), 't1', {
      kind: 'binary',
      decision: 'fail',
      role: 'verifier',
    })
    await rv.vote(asCaller('challenger'), 't1', {
      kind: 'binary',
      decision: 'fail',
      role: 'challenger',
    })
    await rv.settle(asCaller('lead'), 't1') // round 1→2
    await rv.settle(asCaller('lead'), 't1') // round 2→3
    const v = await rv.settle(asCaller('lead'), 't1') // round>=max → escalate
    expect(v.kind).toBe('fail')
    expect(sent.some((s) => s.to === 'lead' && s.text.includes('escalated'))).toBe(true)
  })
})
