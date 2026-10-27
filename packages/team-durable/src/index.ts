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
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'

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

/**
 * **唯一持久化入口**（P52，通道 A）：把 durable 事件经 DSH 正规第三方通道
 * **`appendPluginRecord("plugin:swarm/...", …)`** 真写入会话日志（而非仅 `ctx.emit` 进程内广播）。
 *
 * 依据 bench P50 + team-leader 裁定：第三方写会话日志的正规通道是 `appendPluginRecord` + `plugin:` 命名空间；
 * 直接 `session.append('swarm/…')` 需 `ignorable`、DSH 未必接受第三方扩展。
 * **事件名对外不变**（仍是 `swarm/<domain>/<action>`），只换落盘通道（记录类型 = `plugin:` 前缀）。
 *
 * 用法：写侧 `emitDurable(agent.session, 'swarm/core/review-entered', {…})`；
 * 回放侧用 {@link durableRecordOf} 从 `session/event`（或历史事件）取回 `{name,payload}` 再 fold。
 *
 * @returns 是否成功写入会话日志（无 session / 抛错时为 false，不阻断调用方）。
 */

/** 会话日志里的记录类型：`plugin:` 前缀 + 逻辑名（如 `plugin:swarm/core/review-entered`）。 */
export function pluginRecordType(name: string): string {
  return `plugin:${name}`
}

/** 逻辑名（`swarm/...`）→ 是否属于本命名空间。 */
export function isSwarmRecordType(type: string | undefined): boolean {
  return typeof type === 'string' && type.startsWith('plugin:swarm/')
}

/** 结构化 session seam（只取 appendPluginRecord 的调用形状，避免硬绑上游类型）。 */
export interface DurableSessionSeam {
  readonly __durableSession?: true
}

/** 单条可回放的 durable 记录（逻辑名 + 业务 payload）。 */
export interface DurableRecord {
  name: string
  payload: Record<string, unknown>
}

export function emitDurable(
  session: unknown,
  name: string,
  payload: Record<string, unknown>,
): boolean {
  if (!session) return false
  try {
    ;(appendPluginRecord as unknown as (s: unknown, t: string, d: unknown) => unknown)(
      session,
      pluginRecordType(name),
      { version: DURABLE_VERSION, name, ...payload },
    )
    return true
  } catch {
    // 持久化失败不阻断业务（宁降不升）；调用方可用返回值告警
    return false
  }
}

/** 从一条会话事件里取回 durable 记录（仅 `plugin:swarm/` 命名空间）；非本域返回 undefined。 */
export function durableRecordOf(event: unknown): DurableRecord | undefined {
  const rec = pluginRecordOf(event as never) as { type?: string; data?: unknown } | undefined
  if (!rec || !isSwarmRecordType(rec.type)) return undefined
  const name = (rec.type as string).slice('plugin:'.length)
  const data = (rec.data ?? {}) as Record<string, unknown>
  const { name: _n, ...rest } = data
  return { name, payload: rest }
}
