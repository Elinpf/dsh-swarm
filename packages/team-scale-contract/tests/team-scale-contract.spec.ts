import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  DistributedRole,
  DistributedState,
  HumanSeat,
  HumanSeatKind,
  MutationOp,
  PeerState,
  PeerStatus,
  TeamDistributed,
  TeamHuman,
  TeamTransport,
  TransportBackend,
  TransportFrame,
  TransportStats,
} from '../src/index.ts'
import * as contract from '../src/index.ts'

/**
 * 契约包是纯类型包：运行时零导出，正确性靠**编译期**保证。
 * 这里既断言「运行时空」，也用 expectTypeOf 把三个端口的关键形状冻结住，
 * 防止后续有人在契约包里悄悄加实现或改语义（ADR-0001 延续）。
 */
describe('@elinpf/dsh-swarm-team-scale-contract', () => {
  it('运行时零导出（纯类型包，无任何实现）', () => {
    expect(Object.keys(contract)).toHaveLength(0)
  })

  it('三个端口形状被冻结（编译期断言）', () => {
    // transport
    expectTypeOf<TransportBackend>().toEqualTypeOf<'in-process' | 'local-child' | 'ssh-rpc'>()
    expectTypeOf<PeerState>().toEqualTypeOf<
      'connected' | 'degraded' | 'resyncing' | 'unreachable'
    >()
    expectTypeOf<TransportFrame>().toHaveProperty('kind')
    expectTypeOf<TransportStats['dedupDropped']>().toEqualTypeOf<number>()
    expectTypeOf<TeamTransport['send']>().returns.resolves.toEqualTypeOf<{ seq: number }>()
    expectTypeOf<TeamTransport['peers']>().returns.toEqualTypeOf<PeerStatus[]>()

    // distributed
    expectTypeOf<DistributedRole>().toEqualTypeOf<'lead' | 'follower'>()
    expectTypeOf<MutationOp>().toHaveProperty('opId')
    expectTypeOf<DistributedState['splitBrain']>().toEqualTypeOf<boolean>()
    expectTypeOf<TeamDistributed['state']>().returns.toEqualTypeOf<DistributedState>()
    expectTypeOf<TeamDistributed['deliver']>().returns.resolves.toEqualTypeOf<{
      status: 'accepted' | 'queued'
    }>()

    // human
    expectTypeOf<HumanSeatKind>().toEqualTypeOf<'controller' | 'user'>()
    expectTypeOf<HumanSeat['reachable']>().toEqualTypeOf<boolean>()
    expectTypeOf<TeamHuman['inbound']>().returns.resolves.toEqualTypeOf<{
      target: string
      delivered: boolean
    }>()
    expectTypeOf<TeamHuman['ask']>().returns.resolves.toEqualTypeOf<{ answer: string }>()
  })
})
