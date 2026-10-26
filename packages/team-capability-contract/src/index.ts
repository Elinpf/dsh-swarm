/**
 * 阶段 2 能力端口的**唯一类型契约**（SSOT）。
 *
 * 延续 ADR-0001（契约独立成包）：只含阶段 2 四个能力端口的类型与 `ctx.team*` 类型增强，
 * **不含任何实现**——编译产物是空模块。实现包（team-workspace / team-skills / team-memory /
 * team-compaction）只从这里 `import type`，编译期即无法触达实现内部。
 *
 * @module @elinpf/dsh-swarm-team-capability-contract
 */
export type * from './workspace.ts'
export type * from './skills.ts'
export type * from './memory.ts'
export type * from './compaction.ts'
