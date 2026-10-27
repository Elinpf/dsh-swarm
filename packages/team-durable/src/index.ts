/**
 * 内存态持久化约定（ADR-0002）的**统一折叠助手**。
 *
 * 约定：状态变更 `emit('swarm/<domain>/<action>')`（durable，payload 带 `version`）；
 * 恢复时把历史 durable 事件按序折叠（fold）回内存态。
 *
 * 为什么独立成包（ADR-0002 §4）：6 个包若各自手写 fold，必然在乱序/未知事件/版本兼容上发散；
 * 统一一份后，契约与行为一致。本包**只有运行时助手**，无 cordis/上游依赖，也不依赖任何具体 journal 实现。
 *
 * @module @elinpf/dsh-swarm-team-durable
 */

/** 当前 durable 事件 schema 版本（ADR-0002 §3）。 */
export const DURABLE_VERSION = 1

/** 一条 durable 事件；`type` 形如 `swarm/<domain>/<action>`。 */
export interface DurableEvent {
  readonly type: string
  readonly payload?: unknown
}

/** 单事件 reducer：就地更新 state（fold 的原子步骤）。 */
export type DurableReducer<S> = (state: S, payload: Record<string, unknown>) => void

export interface FoldOptions {
  /** 遇到未注册的事件名（前向兼容）时回调。 */
  onUnknownEvent?: (type: string) => void
  /** 遇到不支持的 version 时回调。 */
  onUnsupportedVersion?: (type: string, version: unknown) => void
}

/** 形状守卫：是否为 `swarm/*` durable 事件。 */
export function isDurableEvent(value: unknown): value is DurableEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('swarm/')
  )
}

/**
 * 按序把 durable 事件折叠进 `state`（就地更新并返回同一引用）。
 *
 * 前向兼容（ADR-0002 §3）：未知事件名 / 非 `DURABLE_VERSION` 的事件**跳过 + 回调告警**，
 * 绝不抛出——旧读者遇到新事件不应崩。非 durable 形状的事件也被跳过。
 */
export function foldDurableEvents<S>(
  state: S,
  events: Iterable<DurableEvent>,
  reducers: Readonly<Record<string, DurableReducer<S>>>,
  options: FoldOptions = {},
): S {
  for (const ev of events) {
    if (!isDurableEvent(ev)) continue
    const reduce = reducers[ev.type]
    if (!reduce) {
      options.onUnknownEvent?.(ev.type)
      continue
    }
    const payload = (ev.payload ?? {}) as Record<string, unknown>
    if (payload.version !== DURABLE_VERSION) {
      options.onUnsupportedVersion?.(ev.type, payload.version)
      continue
    }
    reduce(state, payload)
  }
  return state
}
