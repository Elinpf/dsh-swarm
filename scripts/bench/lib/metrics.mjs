/**
 * 指标口径与导出（JSON / CSV）。
 *
 * 口径一旦定义即固定、可解释；不得为「让指标好看」而改口径（见 README.md）。
 *
 * @module scripts/bench/metrics
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** 跨重复运行可直接聚合的标量指标（其余为明细字段，原样保留）。 */
export const SCALAR_KEYS = [
  'e2eMs',
  'llmTurns',
  'tokens.input',
  'tokens.output',
  'tokens.total',
  'messageDeliveries',
  'broadcasts',
  'multicasts',
  'wakeups',
  'wakeupsDirect',
  'wakeupsFanout',
  'spinWakeups',
  'retries',
  'casConflicts',
  'staleNudged',
  'escalations',
  'reviewRounds',
  'toolCalls.total',
  'process.rssAfterBytes',
  'process.heapUsedAfterBytes',
  'disk.sandboxDeltaBytes',
  'disk.sessionsDeltaBytes',
]

const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

/** 对一次 run 的多份样本求 mean/min/max（忽略 null/未采集）。 */
export function summarize(samples) {
  const out = {}
  for (const key of SCALAR_KEYS) {
    const vals = samples.map((s) => getPath(s.metrics, key)).filter((v) => typeof v === 'number' && Number.isFinite(v))
    if (vals.length === 0) {
      out[key] = { n: 0, mean: null, min: null, max: null }
      continue
    }
    out[key] = {
      n: vals.length,
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      min: Math.min(...vals),
      max: Math.max(...vals),
    }
  }
  return out
}

const flat = (obj, prefix = '') => {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flat(v, key))
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v
  }
  return out
}

/** 把一次 run（含 repeat 样本）写成 JSON，并另存一份 CSV（每样本一行）。 */
export function writeRun(outDir, run) {
  mkdirSync(outDir, { recursive: true })
  const jsonPath = resolve(outDir, 'result.json')
  writeFileSync(jsonPath, JSON.stringify(run, null, 2) + '\n', 'utf8')

  const rows = run.samples.map((s) => {
    const f = flat(s.metrics)
    // 只导出标量/短字段，事件明细已在 JSON
    return {
      runId: run.runId,
      scenario: run.scenario,
      repeatIndex: s.repeatIndex,
      ...f,
    }
  })
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const csv = [headers.join(',')]
    .concat(
      rows.map((r) =>
        headers
          .map((h) => {
            const v = r[h]
            if (v == null) return ''
            const s = String(v)
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          })
          .join(','),
      ),
    )
    .join('\n')
  const csvPath = resolve(outDir, 'result.csv')
  writeFileSync(csvPath, csv + '\n', 'utf8')
  return { jsonPath, csvPath }
}

/** 生成一段人类可读的 markdown 摘要（供 docs/benchmark.md 引用）。 */
export function markdownSummary(run) {
  const lines = []
  lines.push(`#### ${run.scenario} — ${run.title}`)
  lines.push('')
  lines.push(
    `- 后端：\`${run.backend}\` ｜ 重复：${run.samples.length} ｜ runId：\`${run.runId}\``,
  )
  if (run.backend === 'model') {
    const cap = run.costGate?.cap ?? ''
    const used = run.costGate?.consumedTokens ?? ''
    lines.push(
      `- token 门禁：cap=${cap}，实际消耗=${used}（占上限 ${cap ? ((used / cap) * 100).toFixed(4) + '%' : 'n/a'}），中止=${run.costGate?.aborted ?? false}`,
    )
  }
  const s = run.summary
  const fmt = (k, unit = '') => {
    const v = s[k]
    if (!v || v.n === 0) return '未采集'
    if (v.min === v.max) return `${round(v.mean)}${unit}`
    return `${round(v.mean)}${unit} (min ${round(v.min)} / max ${round(v.max)})`
  }
  lines.push(`- 端到端时延：${fmt('e2eMs', ' ms')}`)
  lines.push(`- LLM 轮次：${fmt('llmTurns')}`)
  lines.push(`- token（in/out/total）：${fmt('tokens.input')} / ${fmt('tokens.output')} / ${fmt('tokens.total')}`)
  lines.push(`- 消息投递：${fmt('messageDeliveries')} ｜ 广播：${fmt('broadcasts')} ｜ 多播：${fmt('multicasts')}`)
  lines.push(`- 唤醒：${fmt('wakeups')}（direct ${fmt('wakeupsDirect')} / fanout ${fmt('wakeupsFanout')}）｜ 空转唤醒：${fmt('spinWakeups')}`)
  lines.push(`- 任务重试：${fmt('retries')} ｜ CAS 冲突：${fmt('casConflicts')} ｜ stale 自催：${fmt('staleNudged')}`)
  lines.push(`- 进程 RSS（后）：${fmt('process.rssAfterBytes', ' B')} ｜ 磁盘增量：${fmt('disk.sandboxDeltaBytes', ' B')}`)
  lines.push('')
  return lines.join('\n')
}

const round = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n)
