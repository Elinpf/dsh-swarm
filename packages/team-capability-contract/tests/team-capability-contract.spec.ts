import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  BudgetSnapshot,
  LockHandle,
  LockMode,
  MemoryRecord,
  SkillVisibility,
  TeamCompaction,
  TeamMemory,
  TeamSkills,
  TeamWorkspace,
  WorktreeRecord,
} from '../src/index.ts'
import * as contract from '../src/index.ts'

/**
 * 契约包是纯类型包：运行时零导出，正确性靠**编译期**保证。
 * 这里既断言「运行时空」，也用 expectTypeOf 把四个端口的关键形状冻结住，
 * 防止后续有人在契约包里悄悄加实现或改语义（ADR-0001 延续）。
 */
describe('@elinpf/dsh-swarm-team-capability-contract', () => {
  it('运行时零导出（纯类型包，无任何实现）', () => {
    expect(Object.keys(contract)).toHaveLength(0)
  })

  it('四个端口形状被冻结（编译期断言）', () => {
    expectTypeOf<TeamWorkspace['createWorktree']>().toBeFunction()
    expectTypeOf<LockMode>().toEqualTypeOf<'exclusive' | 'shared'>()
    expectTypeOf<LockHandle['mode']>().toEqualTypeOf<LockMode>()
    expectTypeOf<WorktreeRecord>().toHaveProperty('path')

    expectTypeOf<TeamSkills['visibleTo']>().returns.toEqualTypeOf<string[] | 'unrestricted'>()
    expectTypeOf<SkillVisibility>().toMatchTypeOf<Record<string, string[]>>()

    expectTypeOf<MemoryRecord['scope']>().toEqualTypeOf<'shared' | 'member'>()
    expectTypeOf<TeamMemory['recall']>().toBeFunction()

    expectTypeOf<BudgetSnapshot['overBudget']>().toEqualTypeOf<boolean>()
    expectTypeOf<TeamCompaction['applyPolicy']>().returns.resolves.toEqualTypeOf<{
      compacted: boolean
    }>()
  })
})
