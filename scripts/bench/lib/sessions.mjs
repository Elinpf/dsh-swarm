/**
 * 读取 DSH durable 会话日志（`session.v4.jsonl.zstd`），用于统计 **teammate** 的
 * LLM 轮次 / token —— 这是 `dsh headless --json`（只投影 root 会话）看不到的部分，
 * 也是「空转唤醒」专题的关键数据。
 *
 * 会话目录默认 `DSH_HOME/sessions/<escaped-cwd>/<sessionId>/session.v4.jsonl.zstd`。
 * root 会话里的 `subagent/catalog` 事件给出子会话 id（teammate）。
 *
 * @module scripts/bench/lib/sessions
 */

import { readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'

/** 递归收集 sessn 文件（带 mtime）。 */
export function listSessionFiles(root) {
  const out = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (n === 'session.v4.jsonl.zstd') out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  walk(root)
  return out
}

/** 解析一个会话文件 → 事件数组（容忍截断/坏行）。 */
export function loadSessionEvents(path) {
  // durable 日志是**多帧 zstd**（追加写），node:zlib 只解首帧 → 用 zstd CLI 全量解；失败再退回单帧。
  let raw
  try {
    raw = execFileSync('zstd', ['-dc', path], { maxBuffer: 256 * 1024 * 1024 })
  } catch {
    try {
      raw = zstdDecompressSync(readFileSync(path))
    } catch {
      return []
    }
  }
  const events = []
  for (const line of raw.toString('utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      events.push(JSON.parse(t))
    } catch {
      /* 尾部截断行忽略 */
    }
  }
  return events
}

/** 统计一个会话的轮次/token/工具调用，并返回其引用的子会话 id。
 *
 * 额外采集（「空转唤醒」专题用）：
 * - `relayInboundTurns`：收到 **team 转发消息**（`user/message` 且 `source.kind==='agent-message'`，
 *   即来自 lead/其他成员的 DM 或广播扇出）的轮次号数组。空 = 该会话从未收到团队转发消息。
 * - `relayInboundCount`：收到的团队转发消息条数。
 * - `inboxSpliceInserts`：`agent/inbox/spliced` 中被**插入**（`inserted` 非空）的次数。
 * - `descriptorLabel`：`subagent/descriptor.label`（spawn 时的 description，辅助归属）。
 * - `isSubagent` / `parentSession`：从 header 判定归属。
 */
export function summarizeSession(path) {
  const evs = loadSessionEvents(path)
  const header = evs.find((e) => e.type === 'session')
  const id = header?.id ?? null
  const createdAt = header?.createdAt ?? null
  const parentSession = header?.parentSession ?? null
  const isSubagent = header?.origin === 'subagent' || parentSession != null
  let turns = 0
  let steps = 0
  let currentTurn = 0
  let tokensIn = 0
  let tokensOut = 0
  let tokensTotal = 0
  let hasUsage = false
  let inputTokensSeen = false
  let outputTokensSeen = false
  const toolCalls = {}
  const childIds = []
  const relayInboundTurns = []
  let relayInboundCount = 0
  let inboxSpliceInserts = 0
  let descriptorLabel = null

  for (const e of evs) {
    if (e.type === 'turn/start') {
      turns = Math.max(turns, e.data?.turn ?? turns)
      currentTurn = e.data?.turn ?? currentTurn
    } else if (e.type === 'step/start') steps = Math.max(steps, e.data?.step ?? steps)
    else if (e.type === 'subagent/descriptor') descriptorLabel = e.data?.label ?? descriptorLabel
    else if (e.type === 'agent/inbox/spliced') {
      const inserted = e.data?.inserted
      if (Array.isArray(inserted) && inserted.length > 0) inboxSpliceInserts += 1
    } else if (e.type === 'assistant/message' && e.data?.usage) {
      // durable 里用法在 committed 的 assistant/message 上；重试 attempt 的额外用量不计（见 README 局限）
      hasUsage = true
      if (e.data.usage.inputTokens != null) inputTokensSeen = true
      if (e.data.usage.outputTokens != null) outputTokensSeen = true
      tokensIn += e.data.usage.inputTokens ?? 0
      tokensOut += e.data.usage.outputTokens ?? 0
      tokensTotal += e.data.usage.totalTokens ?? (e.data.usage.inputTokens ?? 0) + (e.data.usage.outputTokens ?? 0)
    } else if (e.type === 'tool/call') {
      const name = e.data?.name ?? '?'
      toolCalls[name] = (toolCalls[name] ?? 0) + 1
    } else if (e.type === 'subagent/catalog') {
      if (e.data?.childId) childIds.push(e.data.childId)
    } else if (e.type === 'user/message') {
      // durable 里 user/message 的 data = { content, source, role, id }
      const srcKind = e.data?.source?.kind
      if (srcKind === 'agent-message') {
        relayInboundCount += 1
        relayInboundTurns.push(currentTurn || 0)
      }
    }
  }
  return {
    id,
    createdAt,
    parentSession,
    isSubagent,
    descriptorLabel,
    path,
    turns,
    steps,
    tokens: hasUsage ? { input: tokensIn, output: tokensOut, total: tokensTotal } : { input: null, output: null, total: null },
    tokensComplete: hasUsage && inputTokensSeen && outputTokensSeen,
    toolCalls,
    childIds: [...new Set(childIds)],
    relayInboundTurns,
    relayInboundCount,
    inboxSpliceInserts,
  }
}

/**
 * 从 root 会话事件里提取 `childId → memberName` 映射（`team/member` 事件）。
 * @param {Array<object>} rootEvents
 * @returns {Map<string,string>}
 */
export function memberNamesFromRootEvents(rootEvents) {
  const m = new Map()
  for (const e of rootEvents) {
    if (e.type === 'team/member' && e.data?.member?.id) {
      m.set(e.data.member.id, e.data.member.name)
    }
  }
  return m
}

/**
 * 收集一次运行窗口内（mtime >= sinceMs）新建/更新的会话，解析并区分 root / teammate。
 * @param {string} sessionsRoot
 * @param {number} sinceMs
 * @param {string|null} rootSessionId 从 `--json` 流的 session 事件取
 */
export function collectRunSessions(sessionsRoot, sinceMs, rootSessionId, untilMs = Infinity) {
  // 以会话自身 createdAt 判定是否属于本次运行窗口 [sinceMs, untilMs]（比文件 mtime 稳，避免相邻运行串味）
  const files = listSessionFiles(sessionsRoot)
  const parsed = files.map((f) => ({ ...summarizeSession(f.path), mtimeMs: f.mtimeMs, bytes: f.size }))
    .filter((p) => p.createdAt != null && p.createdAt >= sinceMs && p.createdAt <= untilMs)
  const byId = new Map(parsed.filter((p) => p.id).map((p) => [p.id, p]))
  const root = rootSessionId ? byId.get(rootSessionId) : undefined
  // teammate = **仅** root 会话通过 subagent/catalog 显式引用的子会话（精确归属，避免相邻运行串味）
  const childIds = new Set(root ? root.childIds : [])
  const teammates = root
    ? parsed.filter((p) => childIds.has(p.id))
    : parsed.filter((p) => p.childIds.length === 0)
  // childId → memberName（来自 root 的 team/member 事件；含 lead 与全部 teammate）
  const nameMap = root ? memberNamesFromRootEvents(loadSessionEvents(root.path)) : new Map()
  const teammateTurns = teammates.reduce((s, p) => s + (p.turns ?? 0), 0)
  const teammateTokens = teammates.reduce((s, p) => s + (p.tokens.total ?? 0), 0)
  return {
    root: root
      ? {
          id: root.id,
          turns: root.turns,
          steps: root.steps,
          tokens: root.tokens,
          toolCalls: root.toolCalls,
          bytes: root.bytes,
        }
      : null,
    teammates: teammates.map((p) => ({
      id: p.id,
      name: nameMap.get(p.id) ?? p.descriptorLabel ?? null,
      turns: p.turns,
      steps: p.steps,
      tokens: p.tokens,
      tokensComplete: p.tokensComplete,
      toolCalls: p.toolCalls,
      bytes: p.bytes,
      relayInboundCount: p.relayInboundCount,
      relayInboundTurns: p.relayInboundTurns,
      inboxSpliceInserts: p.inboxSpliceInserts,
    })),
    memberNames: Object.fromEntries(nameMap),
    teammateCount: teammates.length,
    teammateTurns,
    teammateTokens,
  }
}
