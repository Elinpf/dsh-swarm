/**
 * 长驻观测后端（long-resident）——「空转唤醒」专题用。
 *
 * 背景：`dsh headless` 在 **root 轮结束即退出**。P13 的 S7 里广播下发后，teammate 的
 * 下一轮往往还没开始、进程就退了，于是 durable 日志里看不到广播消费 → 无法区分
 * 「设计真的省轮」与「窗口截断」。
 *
 * 本模块用**长驻观测窗口**绕过截断：让 lead 在广播后 **反复 `wait_agent` 直到静默**
 * （连续观察到一次 `timedOut=true` 即为静默），使 teammate 有足够时间消费 pending inbox，
 * 再把**每个成员**的 durable 会话（轮次 / token / 是否收到 team 转发消息）按成员归属统计出来。
 *
 * 归因口径：
 *   - teammate 的「初始轮」= spawn 时下发初始 prompt 触发的 turn 1；
 *   - 「广播/唤醒后额外轮」= turns - 1（≥0），并交叉核对 `relayInboundCount>0`（是否真收到转发消息）。
 *
 * @module scripts/bench/lib/longres
 */

import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '..', '..', '..')
const RUN_HEADLESS = resolve(REPO_ROOT, 'scripts', 'run-headless.sh')
const SESSIONS_DIR = resolve(REPO_ROOT, '.runtime', 'dsh-home', 'sessions')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 构造一个成员的 spawn 行。 */
const spawnLine = (i, name) =>
  `${i}) spawn_teammate name='${name}' description='idle-${i}' prompt='Reply with exactly ${String.fromCharCode(64 + i)} and then stop. Do nothing else.'`

/**
 * 构造长驻观测提示词。
 * @param {'broadcast'|'n_dm'} arm
 * @param {string[]} members
 */
export function buildPrompt(arm, members) {
  const lines = []
  lines.push('You are the team lead. Execute these steps IN ORDER, one tool call at a time.')
  lines.push('Do not send any direct message except where explicitly instructed below.')
  members.forEach((m, idx) => lines.push(spawnLine(idx + 1, m)))
  const n = members.length
  lines.push(`${n + 1}) Call wait_agent with timeout_ms=20000 (let the initial turns settle).`)
  if (arm === 'broadcast') {
    lines.push(
      `${n + 2}) Call broadcast with content='FYI standup moved to 5pm; no action required.' topic='announce'.`,
    )
  } else if (arm === 'broadcast_record') {
    lines.push(
      `${n + 2}) Call broadcast with content='FYI standup moved to 5pm; no action required.' topic='announce' fanout='record-only'.`,
    )
  } else {
    members.forEach((m, idx) =>
      lines.push(
        `${n + 2 + idx}) Call send_message with target='${m}' message='FYI standup moved to 5pm; no action required.'.`,
      ),
    )
  }
  const after = arm === 'n_dm' ? n + 2 + members.length : n + 3
  lines.push(
    `${after}) Now keep the run resident: repeatedly call wait_agent with timeout_ms=20000. Call it at least 4 times, and keep calling it while the returned result shows timedOut=false (i.e. until you observe one timedOut=true). This gives teammates time to finish before you stop.`,
  )
  lines.push(`${after + 1}) Call list_agents.`)
  lines.push(`${after + 2}) Reply exactly DONE.`)
  return lines.join('\n')
}

/**
 * 跑一个长驻 arm。
 * @param {'broadcast'|'n_dm'} arm
 * @param {{members?:string[], tokenCap:number, turnCap:number, timeoutMs:number, settleMs?:number}} opts
 */
export async function runArm(arm, opts) {
  const members = opts.members ?? ['alice', 'bob', 'carol']
  const { tokenCap, turnCap, timeoutMs } = opts
  const settleMs = opts.settleMs ?? 12000
  const prompt = buildPrompt(arm, members)

  const t0 = Date.now()
  const child = spawn('bash', [RUN_HEADLESS, '--json', prompt], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const events = []
  const rawLines = []
  const toolCalls = {}
  const toolSequence = []
  let turns = 0
  let tokensIn = 0
  let tokensOut = 0
  let tokensTotal = 0
  let aborted = false
  let abortReason = ''
  let buf = ''
  let rootSessionId = null
  let waitTimedOutTrue = 0
  let waitCalls = 0

  const onLine = (line) => {
    if (!line.trim()) return
    rawLines.push(line)
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    events.push(ev)
    if (ev.type === 'session' && ev.sessionId) rootSessionId = ev.sessionId
    if (ev.type === 'status' && ev.phase === 'turn_start') turns = Math.max(turns, ev.turn ?? turns + 1)
    if (ev.type === 'status' && ev.phase === 'step_end' && ev.usage) {
      tokensIn += ev.usage.inputTokens ?? 0
      tokensOut += ev.usage.outputTokens ?? 0
      tokensTotal += ev.usage.totalTokens ?? (ev.usage.inputTokens ?? 0) + (ev.usage.outputTokens ?? 0)
    }
    if (ev.type === 'tool_call') {
      toolCalls[ev.tool] = (toolCalls[ev.tool] ?? 0) + 1
      toolSequence.push(ev.tool)
      if (ev.tool === 'wait_agent') waitCalls += 1
    }
    if (ev.type === 'tool_result' && ev.tool === 'wait_agent') {
      const r = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '')
      if (/"timedOut"\s*:\s*true/.test(r)) waitTimedOutTrue += 1
    }
    if (!aborted && tokensTotal > tokenCap) {
      aborted = true
      abortReason = `token 超限：${tokensTotal} > cap ${tokenCap}`
      child.kill('SIGKILL')
    }
    if (!aborted && turns > turnCap) {
      aborted = true
      abortReason = `轮次超限：${turns} > cap ${turnCap}`
      child.kill('SIGKILL')
    }
  }

  const timer = setTimeout(() => {
    aborted = true
    abortReason = `超时：> ${timeoutMs}ms`
    child.kill('SIGKILL')
  }, timeoutMs)

  let stderrAll = ''
  await new Promise((resolvePromise) => {
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    child.stderr.on('data', (d) => (stderrAll += d.toString('utf8')))
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf)
      clearTimeout(timer)
      resolvePromise()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })

  const exitAt = Date.now()
  // 给 durable 落盘留一点时间（进程已退出，仍需文件 flush 完成）
  await sleep(settleMs)

  let teammateActivity = null
  let err = null
  try {
    const { collectRunSessions } = await import('./sessions.mjs')
    teammateActivity = collectRunSessions(SESSIONS_DIR, t0, rootSessionId, Date.now() + 5000)
  } catch (e) {
    err = e.message
  }

  const final = [...events].reverse().find((e) => e.type === 'final')
  const notes = []
  if (err) notes.push(`teammate 会话统计失败：${err}`)
  if (aborted) notes.push(`已中止：${abortReason}`)

  // 逐成员归因
  const perMember = (teammateActivity?.teammates ?? []).map((m) => ({
    name: m.name,
    id: m.id,
    turns: m.turns,
    tokens: m.tokens,
    tokensComplete: m.tokensComplete,
    relayInboundCount: m.relayInboundCount,
    relayInboundTurns: m.relayInboundTurns,
    inboxSpliceInserts: m.inboxSpliceInserts,
    consumedWakeup: m.relayInboundCount > 0,
    extraTurnsBeyondInitial: Math.max(0, (m.turns ?? 0) - 1),
  }))

  const metrics = {
    arm,
    members,
    e2eMs: exitAt - t0,
    rootTurns: turns,
    rootTokens: { input: tokensIn, output: tokensOut, total: tokensTotal },
    rootToolCalls: { total: toolSequence.length, byName: toolCalls },
    waitCalls,
    waitTimedOutTrue,
    quiescenceObserved: waitTimedOutTrue > 0,
    rootSessionId,
    teammateCount: teammateActivity?.teammateCount ?? null,
    teammateTurns: teammateActivity?.teammateTurns ?? null,
    teammateTokens: teammateActivity?.teammateTokens ?? null,
    perMember,
    // 汇总：teammate 在初始轮之外多跑的轮（= 广播/DM 唤醒带来的额外 LLM 轮）
    extraTeammateTurns: perMember.reduce((s, m) => s + m.extraTurnsBeyondInitial, 0),
    membersConsumedWakeup: perMember.filter((m) => m.consumedWakeup).length,
    totalTokensIncludingTeammates:
      tokensTotal + (teammateActivity?.teammateTokens ?? 0),
    finalText: final?.text ?? null,
    notes,
  }

  return {
    arm,
    prompt,
    raw: rawLines,
    stderr: stderrAll,
    teammateActivity,
    metrics,
    costGate: { cap: tokenCap, turnCap, consumedTokens: tokensTotal, aborted, abortReason },
  }
}
