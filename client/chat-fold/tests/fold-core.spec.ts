import { describe, expect, it } from 'vitest'
import {
  foldRuns,
  isFoldable,
  isTeamTriggerKind,
  TEAM_TRIGGER_KINDS,
  type FoldDecision,
  type FoldNode,
} from '../src/client/fold-core.ts'

const node = (key: string, sourceKind?: string, extra: Partial<FoldNode> = {}): FoldNode => ({
  key,
  ...(sourceKind === undefined ? {} : { sourceKind }),
  time: 1000,
  ...extra,
})

function decisions(nodes: readonly FoldNode[]): Array<[string, FoldDecision['kind']]> {
  const map = foldRuns(nodes)
  return nodes.map((n) => [n.key, map.get(n.key)?.kind ?? 'render'])
}

describe('P61 折叠护栏（fold-core）', () => {
  it('① 只折团队来源：request/goal/webhook 等一律 render', () => {
    expect(isTeamTriggerKind('agent-message')).toBe(true)
    expect(isTeamTriggerKind('subagent-settled')).toBe(true)
    expect(isTeamTriggerKind('team-message')).toBe(true)
    expect(isTeamTriggerKind('request')).toBe(false)
    expect(isTeamTriggerKind('goal')).toBe(false)
    expect(isTeamTriggerKind(undefined)).toBe(false)
    expect(TEAM_TRIGGER_KINDS).toHaveLength(3)

    expect(decisions([node('a', 'request'), node('b', 'goal'), node('c', 'webhook')])).toEqual([
      ['a', 'render'],
      ['b', 'render'],
      ['c', 'render'],
    ])
  })

  it('② 永不折最后 turn：末 turn 的团队 trigger 保留为 render', () => {
    expect(isFoldable(node('x', 'agent-message', { isLastTurn: true }))).toBe(false)
    expect(decisions([node('a', 'agent-message', { isLastTurn: true })])).toEqual([['a', 'render']])
  })

  it('② 最后 turn 打断 run（两侧各成孤立 run → 都 render）', () => {
    const ns = [
      node('a', 'agent-message'),
      node('b', 'subagent-settled', { isLastTurn: true }),
      node('c', 'agent-message'),
    ]
    expect(decisions(ns)).toEqual([
      ['a', 'render'],
      ['b', 'render'],
      ['c', 'render'],
    ])
  })

  it('④ fail-open：key 缺失/空 或 sourceKind 缺失 → render', () => {
    expect(isFoldable(node('', 'agent-message'))).toBe(false)
    expect(decisions([node('', 'agent-message'), node('', 'agent-message')])).toEqual([
      ['', 'render'],
      ['', 'render'],
    ])
    expect(decisions([node('a'), node('b')])).toEqual([
      ['a', 'render'],
      ['b', 'render'],
    ])
  })

  it('孤立团队 trigger（run 长 1）→ render，不隐藏', () => {
    expect(decisions([node('only', 'agent-message')])).toEqual([['only', 'render']])
  })

  it('连续团队 trigger ≥2 → 首行 aggregate(count,lastTime)，其余 hidden', () => {
    const ns = [
      node('a', 'subagent-settled', { time: 1000 }),
      node('b', 'agent-message', { time: 2000 }),
      node('c', 'agent-message', { time: 3000 }),
    ]
    const map = foldRuns(ns)
    expect(map.get('a')).toEqual({ kind: 'aggregate', count: 3, lastTime: 3000 })
    expect(map.get('b')).toEqual({ kind: 'hidden' })
    expect(map.get('c')).toEqual({ kind: 'hidden' })
  })

  it('非团队节点打断 run：两段各自成组', () => {
    const ns = [
      node('a', 'agent-message'),
      node('b', 'agent-message'),
      node('mid', 'request'), // 打断
      node('c', 'agent-message'),
      node('d', 'team-message'),
    ]
    const map = foldRuns(ns)
    expect(map.get('a')).toMatchObject({ kind: 'aggregate', count: 2 })
    expect(map.get('b')).toEqual({ kind: 'hidden' })
    expect(map.get('mid')).toEqual({ kind: 'render' })
    expect(map.get('c')).toMatchObject({ kind: 'aggregate', count: 2 })
    expect(map.get('d')).toEqual({ kind: 'hidden' })
  })

  it('不修改入参', () => {
    const ns = [node('a', 'agent-message'), node('b', 'agent-message')]
    const snapshot = JSON.stringify(ns)
    foldRuns(ns)
    expect(JSON.stringify(ns)).toBe(snapshot)
  })

  it('lastTime 取 run 内最后一条有 time 的节点', () => {
    const ns = [node('a', 'agent-message', { time: 111 }), node('b', 'agent-message', { time: 222 })]
    expect(foldRuns(ns).get('a')).toEqual({ kind: 'aggregate', count: 2, lastTime: 222 })
  })
})
