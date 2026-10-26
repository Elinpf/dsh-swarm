import { describe, expect, expectTypeOf, it } from 'vitest'
import type { MessageRange, TaskView, TeamCore, TeamMembership } from '../src/index.ts'
import * as contract from '../src/index.ts'

/**
 * 契约包是纯类型包：运行时零导出，正确性靠**编译期**保证。
 * 这里既断言「运行时空」，也用 expectTypeOf 把 §4.1 的关键形状冻结住，
 * 防止后续有人在契约包里悄悄加实现或改语义（ADR-0001）。
 */
describe('@dsh-swarm/team-core-contract', () => {
  it('运行时零导出（纯类型包，无任何实现）', () => {
    expect(Object.keys(contract)).toHaveLength(0)
  })

  it('端口形状被冻结（编译期断言）', () => {
    expectTypeOf<TeamCore['backend']>().toEqualTypeOf<'native' | 'owned'>()
    expectTypeOf<TaskView['status']>().toEqualTypeOf<
      'pending' | 'in_progress' | 'completed' | 'deleted'
    >()
    expectTypeOf<TeamMembership['role']>().toEqualTypeOf<'lead' | 'teammate'>()
    expectTypeOf<MessageRange>().toMatchTypeOf<
      { kind: 'dm'; to: string } | { kind: 'multicast'; targets: string[] } | { kind: 'broadcast' }
    >()
  })
})
