/**
 * `swarmBus` Session 投影（P47 读取侧）：把团队消息折叠成**客户端可读的群聊消息列表**（wire view）。
 *
 * 与原生 `agentTeam` 投影同构——服务端注册、按会话日志折叠、wire 视图送达浏览器。
 *
 * **可见范围（MVP 口径，team-leader 裁定）**：
 * - `swarm/bus/broadcast`（全体广播 / 多播）：**全显示**（广播无 targets；多播带 targets）。
 * - `team/message/queued`（原生 DM）：**仅当 senderId 或 targetId === 本投影会话（Lead）时显示**。
 *   → 与 Lead 无关的成员私聊**不进本视图**，不泄露。含 Lead 自己发出的（senderId 区分）。
 *
 * **类型面最小化（重要）**：本文件**刻意不 import** `@deepseek-ai/dsh-session` /
 * `@deepseek-ai/dsh-session-projection` 的重类型，也不做 `SessionEventMap` /
 * `SessionProjectionMap` 声明合并（后者曾导致 team-bus `tsc` 类型膨胀 OOM）。
 * 投影契约以**结构化类型**（`ProjectionDefinition` 形状）满足，注册处在 index.ts 侧做窄类型断言。
 * 运行时行为与契约同构；代价是不具备对上游契约的编译期绑定（已在 P47 文档记明）。
 *
 * @module @elinpf/dsh-swarm-team-bus/projection
 */

import { z } from 'zod'
import { durableRecordOf } from '@elinpf/dsh-swarm-team-durable'

/** 一条进客户端视图的团队消息。 */
export interface SwarmChatMessage {
  /** 稳定消息 id（bus 用 `bcast-<n>`/`mcast-<n>`；DM 用原生 messageId）。 */
  id: string
  /** 形态：全体广播 / 多播 / 与 Lead 相关的 DM / 收到的 relay / Lead 发出的 outbound。 */
  kind: 'broadcast' | 'multicast' | 'dm' | 'relay' | 'outbound'
  /** bus 主题（仅 bus 消息有）。 */
  topic?: string
  senderId: string
  senderName: string
  content: unknown[]
  delivery?: string
  /** 多播时的目标名列表。 */
  targets?: string[]
  /** 源会话事件的 seq（排序权威）。 */
  seq: number
  /** 源会话事件的 time（毫秒）。 */
  ts: number
}

/** 投影内部状态（纯 JSON，可被持久化缓存）。 */
export interface SwarmBusState {
  readonly id: string
  readonly messages: readonly SwarmChatMessage[]
}

/** 投影线视图（送达浏览器的 payload）。 */
export interface SwarmBusView {
  readonly messages: readonly SwarmChatMessage[]
}

/** 视图上限：只保留最近 N 条。 */
export const MAX_SWARM_MESSAGES = 500

/** 结构化会话事件形状（只取投影折叠所需字段，避免引入上游重类型）。 */
export interface ProjectionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: boolean
}

const messageSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['broadcast', 'multicast', 'dm', 'relay', 'outbound']),
    topic: z.string().optional(),
    senderId: z.string(),
    senderName: z.string(),
    content: z.array(z.unknown()),
    delivery: z.string().optional(),
    targets: z.array(z.string()).optional(),
    seq: z.number().int().nonnegative(),
    ts: z.number().int().nonnegative(),
  })
  .strict()

const stateSchema = z
  .object({
    id: z.string(),
    messages: z.array(messageSchema),
  })
  .strict()

const viewSchema = z
  .object({
    messages: z.array(messageSchema),
  })
  .strict()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从事件中取出 bus 记录快照（经 team-durable 统一入口 `durableRecordOf`）。 */
function busSnapshot(event: ProjectionEvent): Record<string, unknown> | undefined {
  const record = durableRecordOf(event)
  if (record === undefined || record.name !== 'swarm/bus/broadcast') return undefined
  const data = record.payload
  if (data['version'] !== 1) return undefined
  const snap = data['snapshot']
  return isRecord(snap) ? snap : undefined
}

/** 把一条 bus 快照转成聊天消息。 */
export function busMessageFrom(
  snap: Record<string, unknown>,
  event: Pick<ProjectionEvent, 'seq' | 'time'>,
): SwarmChatMessage | undefined {
  const id = snap['id']
  const senderId = snap['senderId']
  const senderName = snap['senderName']
  const content = snap['content']
  if (
    typeof id !== 'string' ||
    typeof senderId !== 'string' ||
    typeof senderName !== 'string' ||
    !Array.isArray(content)
  ) {
    return undefined
  }
  const targets = Array.isArray(snap['targets'])
    ? (snap['targets'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined
  const targetId = snap['targetId']
  const topic = snap['topic']
  const delivery = snap['delivery']
  return {
    id,
    kind: targetId !== undefined || targets !== undefined ? 'multicast' : 'broadcast',
    ...(typeof topic === 'string' ? { topic } : {}),
    senderId,
    senderName,
    content,
    ...(typeof delivery === 'string' ? { delivery } : {}),
    ...(targets !== undefined ? { targets } : {}),
    seq: event.seq,
    ts: event.time,
  }
}

/**
 * 原生 DM 事件 `team/message/queued` → 消息；仅当与 Lead（`leadId`）相关时返回。
 * 结构化读取，不 import 实验包类型。
 */
export function dmMessageFrom(
  event: ProjectionEvent,
  leadId: string,
): SwarmChatMessage | undefined {
  if (event.type !== 'team/message/queued') return undefined
  const data = event.data
  if (!isRecord(data) || data['version'] !== 2 || data['teamId'] !== leadId) return undefined
  const msg = data['message']
  if (!isRecord(msg)) return undefined
  const senderId = msg['senderId']
  const targetId = msg['targetId']
  if (typeof senderId !== 'string' || typeof targetId !== 'string') return undefined
  // 可见范围：仅 Lead 为发送方或接收方的 DM。
  if (senderId !== leadId && targetId !== leadId) return undefined
  const id = msg['id']
  const senderName = msg['senderName']
  const content = msg['content']
  if (typeof id !== 'string' || typeof senderName !== 'string' || !Array.isArray(content))
    return undefined
  return { id, kind: 'dm', senderId, senderName, content, seq: event.seq, ts: event.time }
}

/**
 * 原生 relay 事件 `agent/inbox/spliced`（`source.kind='agent-message'`, `form='relay'`）
 * → 收到的团队消息。本轮真实流量（原生 `send_message` DM）就落在这里（P61 实测）。
 * 框首块形如 `Team message from <name>:`（可能带消息 id）；其后文本块为正文。
 * 结构化读取，不 import 实验包类型。返回 0..N 条（一次 splice 可含多条）。
 */
export function relayMessagesFrom(event: ProjectionEvent): SwarmChatMessage[] {
  if (event.type !== 'agent/inbox/spliced') return []
  const data = event.data
  if (!isRecord(data)) return []
  const inserted = data['inserted']
  if (!Array.isArray(inserted)) return []
  const out: SwarmChatMessage[] = []
  for (const item of inserted) {
    if (!isRecord(item)) continue
    const source = item['source']
    if (!isRecord(source) || source['kind'] !== 'agent-message' || source['form'] !== 'relay') continue
    const id = item['id']
    if (typeof id !== 'string') continue
    const content = item['content']
    if (!Array.isArray(content)) continue
    const texts = content
      .filter(
        (b): b is Record<string, unknown> =>
          isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string',
      )
      .map((b) => b['text'] as string)
    const frame = /^Team message(?: [0-9a-fA-F-]+)? from (.+?):\s*$/.exec(texts[0] ?? '')
    const senderId =
      typeof source['senderSessionId'] === 'string' ? source['senderSessionId'] : 'unknown'
    const senderName = frame?.[1]?.trim() ?? senderId
    const body = frame !== null ? texts.slice(1) : texts
    out.push({
      id,
      kind: 'relay',
      senderId,
      senderName,
      content: body.map((text) => ({ type: 'text', text })),
      seq: event.seq,
      ts: event.time,
    })
  }
  return out
}

/**
 * Lead 自己发出的消息：Lead 会话日志里的 `tool/call` 且 `name='send_message'`，
 * 参数 `{ target, message }`（`arguments` 为 JSON 串）。标 `kind:'outbound'`，
 * 与收到的 relay 区分展示；`targets` 记目标名。
 */
export function outboundMessageFrom(event: ProjectionEvent): SwarmChatMessage | undefined {
  if (event.type !== 'tool/call') return undefined
  const data = event.data
  if (!isRecord(data) || data['name'] !== 'send_message') return undefined
  const args = data['arguments']
  if (typeof args !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const target = parsed['target']
  const message = parsed['message']
  if (typeof target !== 'string' || typeof message !== 'string') return undefined
  const callId = data['callId']
  const id = typeof callId === 'string' ? `out-${callId}` : `out-seq-${event.seq}`
  return {
    id,
    kind: 'outbound',
    senderId: 'lead',
    senderName: 'lead',
    content: [{ type: 'text', text: message }],
    targets: [target],
    seq: event.seq,
    ts: event.time,
  }
}

/** 追加一条消息（去重 + 上限裁剪）；无变化时返回原引用。 */function appended(
  messages: readonly SwarmChatMessage[],
  message: SwarmChatMessage,
): readonly SwarmChatMessage[] {
  if (messages.some((m) => m.id === message.id)) return messages
  const next = [...messages, message]
  return next.length > MAX_SWARM_MESSAGES ? next.slice(next.length - MAX_SWARM_MESSAGES) : next
}

/** 视图缓存：状态引用未变时复用同一对象，满足投影契约的 `Object.is` 稳定要求。 */
const viewCache = new WeakMap<readonly SwarmChatMessage[], SwarmBusView>()

function buildView(messages: readonly SwarmChatMessage[]): SwarmBusView {
  let view = viewCache.get(messages)
  if (view === undefined) {
    view = { messages }
    viewCache.set(messages, view)
  }
  return view
}

/** `swarmBus` 投影定义（结构化满足 `ProjectionDefinition` 形状）。 */
export const swarmBusProjectionDefinition = {
  key: 'swarmBus',
  stateVersion: 1,
  stateSchema,
  init: (header: { id: string }): SwarmBusState => ({ id: header.id, messages: [] }),
  apply: (state: SwarmBusState, event: ProjectionEvent): SwarmBusState => {
    const candidates: SwarmChatMessage[] = []
    const snap = busSnapshot(event)
    if (snap !== undefined) {
      const message = busMessageFrom(snap, event)
      if (message !== undefined) candidates.push(message)
    } else {
      candidates.push(...relayMessagesFrom(event))
      const out = outboundMessageFrom(event)
      if (out !== undefined) candidates.push(out)
      const dm = dmMessageFrom(event, state.id)
      if (dm !== undefined) candidates.push(dm)
    }
    if (candidates.length === 0) return state
    let messages = state.messages
    for (const candidate of candidates) messages = appended(messages, candidate)
    return messages === state.messages ? state : { ...state, messages }
  },
  wire: { viewSchema, view: (state: SwarmBusState): SwarmBusView => buildView(state.messages) },
}
