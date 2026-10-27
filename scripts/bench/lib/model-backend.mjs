/**
 * 真实模型后端：复用已跑通的 `scripts/run-headless.sh`（本机 llm-pi-ai overlay），
 * 驱动 `dsh headless --json`，解析官方 JSON 流并施加**成本门禁**。
 *
 * JSON 流 schema（来自 dsh-headless/lib/json-stream）：
 *   {"type":"session",...}
 *   {"type":"status","phase":"turn_start","turn":N}
 *   {"type":"status","phase":"step_end","turn","step","usage":{inputTokens,outputTokens,totalTokens?}}
 *   {"type":"tool_call","callId","tool","input"}
 *   {"type":"tool_result","callId","status":"completed|error","result"}
 *   {"type":"text"|"thinking","text"}
 *   {"type":"final","text"}
 *
 * 边界（诚实标注）：`--json` 只投影 **root（lead）会话**；teammate 各自的 turn 不在本流内，
 * 故 wakeups / 空转唤醒 / teammate token 在 model 模式记 `null`（未采集），原因写入 notes。
 *
 * @module scripts/bench/model-backend
 */

import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, statSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '..', '..', '..')
const RUN_HEADLESS = resolve(REPO_ROOT, 'scripts', 'run-headless.sh')

const now = () => Date.now()

function dirSize(dir) {
  let total = 0
  try {
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = resolve(d, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else total += st.size
      }
    }
    walk(dir)
  } catch {
    /* ignore */
  }
  return total
}

/**
 * @param {import('./scenarios.mjs').SCENARIOS[string]} scenario
 * @param {{tokenCap:number, turnCap:number, timeoutMs:number, profile?:string}} opts
 */
export async function runModelScenario(scenario, opts) {
  const notes = []
  const { tokenCap, turnCap, timeoutMs } = opts
  const sessionsDir = resolve(REPO_ROOT, '.runtime', 'dsh-home', 'sessions')
  const diskBefore = dirSize(sessionsDir)

  const t0 = now()
  const child = spawn('bash', [RUN_HEADLESS, '--json', scenario.model], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const events = []
  const rawLines = []
  const toolCalls = {}
  let turns = 0
  let steps = 0
  let tokensIn = 0
  let tokensOut = 0
  let tokensTotal = 0
  let aborted = false
  let abortReason = ''
  let buf = ''
  let rootSessionId = null

  const dataDir = resolve(REPO_ROOT, '.runtime', 'bench', '_sandbox')
  // 保证沙箱存在（磁盘采样基准）
  try { readdirSync(dataDir) } catch { /* ignore */ }

  const onLine = (line) => {
    if (!line.trim()) return
    rawLines.push(line)
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      return // 非 JSON（如 [info] overlay ...）忽略
    }
    events.push(ev)
    if (ev.type === 'session' && ev.sessionId) rootSessionId = ev.sessionId
    if (ev.type === 'status' && ev.phase === 'turn_start') turns = Math.max(turns, ev.turn ?? turns + 1)
    if (ev.type === 'status' && ev.phase === 'step_start') steps = Math.max(steps, ev.step ?? 0)
    if (ev.type === 'status' && ev.phase === 'step_end' && ev.usage) {
      tokensIn += ev.usage.inputTokens ?? 0
      tokensOut += ev.usage.outputTokens ?? 0
      tokensTotal += ev.usage.totalTokens ?? (ev.usage.inputTokens ?? 0) + (ev.usage.outputTokens ?? 0)
    }
    if (ev.type === 'tool_call') toolCalls[ev.tool] = (toolCalls[ev.tool] ?? 0) + 1

    // ── 成本门禁：token / 轮次超限立即中止 ──
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

  await new Promise((resolvePromise) => {
    let stderr = ''
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf)
      clearTimeout(timer)
      notes.push(`child exit=${code}${stderr.trim() ? '; stderr=' + stderr.trim().slice(0, 300) : ''}`)
      resolvePromise()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      notes.push(`child spawn error: ${e.message}`)
      resolvePromise()
    })
  })

  const e2eMs = now() - t0
  const diskAfter = dirSize(sessionsDir)

  // ── teammate durable 会话统计（--json 看不到的部分；空转唤醒专题关键）──
  let teammateActivity = null
  try {
    const { collectRunSessions } = await import('./sessions.mjs')
    teammateActivity = collectRunSessions(sessionsDir, t0, rootSessionId, now() + 5000)
    notes.push(
      `teammate durable 会话：count=${teammateActivity.teammateCount} turns=${teammateActivity.teammateTurns} tokens=${teammateActivity.teammateTokens}`,
    )
  } catch (e) {
    notes.push(`teammate 会话统计失败：${e.message}`)
  }

  const toolTotal = Object.values(toolCalls).reduce((a, b) => a + b, 0)
  const errors = events.filter((e) => e.type === 'tool_result' && e.status === 'error').length
  const final = [...events].reverse().find((e) => e.type === 'final')

  // 消息投递近似：send_message 每次 1 条；broadcast/multicast 记调用次数（扇出人数不在流内）
  const sends = toolCalls.send_message ?? 0
  const broadcastCalls = toolCalls.broadcast ?? 0
  const multicastCalls = toolCalls.multicast ?? 0

  notes.push(
    'wakeups(spin) 逐成员口径见 teammateActivity；逐 teammate 的 turn/token 由 durable 日志统计（--json 无）',
  )

  const metrics = {
    backend: 'model',
    e2eMs,
    llmTurns: turns,
    steps,
    tokens: { input: tokensIn, output: tokensOut, total: tokensTotal },
    toolCalls: { total: toolTotal, byName: toolCalls },
    messageDeliveries: sends + multicastCalls, // send_message + multicast 调用（广播另计）
    broadcasts: broadcastCalls,
    multicasts: multicastCalls,
    wakeups: null, // 未采集：teammate 唤醒不在 root 流内
    wakeupsDirect: null,
    wakeupsFanout: null,
    spinWakeups: null,
    teammateActivity,
    retries: errors,
    casConflicts: null,
    staleNudged: null,
    escalations: null,
    reviewRounds: (toolCalls.review_submit ?? 0) + (toolCalls.review_vote ?? 0),
    members: null,
    tasks: null,
    taskDwellMs: null,
    process: null,
    disk: { sessionsDeltaBytes: diskAfter - diskBefore },
    finalText: final?.text ?? null,
    notes,
  }

  return {
    metrics,
    events,
    raw: rawLines,
    costGate: { cap: tokenCap, turnCap, consumedTokens: tokensTotal, aborted, abortReason },
  }
}
