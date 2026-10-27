/**
 * 阶段 3 规模化端口的**唯一类型契约**（SSOT）。
 *
 * 延续 ADR-0001（契约独立成包）：只含阶段 3 三个端口（传输底座 / leader 权威分布式 / 人类席位）
 * 的类型与 `ctx.team*` 类型增强，**不含任何实现**——编译产物是空模块。
 * 实现包（team-transport / team-distributed / team-human）只从这里 `import type`，
 * 编译期即无法触达实现内部。
 *
 * 为什么单开一个契约包而不并入 team-core-contract / team-capability-contract：
 * 三者是不同 cohort（协作内核 / 能力供给 / 规模化边界）、冻结时点不同，独立成包成本最低且语义不稀释。
 *
 * @module @elinpf/dsh-swarm-team-scale-contract
 */
export type * from './transport.ts'
export type * from './distributed.ts'
export type * from './human.ts'
