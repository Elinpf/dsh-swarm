#!/usr/bin/env node
/**
 * bench-run.mjs — 基准 harness 主入口。
 *
 * 用法（通常经 scripts/bench/run.sh 调用，以获得隔离环境）：
 *   node scripts/bench/bench-run.mjs --no-model --scenario S1,S2,S3 --repeat 3
 *   node scripts/bench/bench-run.mjs --scenario S1 --token-cap 20000
 *   node scripts/bench/bench-run.mjs --list
 *
 * 选项：
 *   --scenario <ids|all>   默认 all（S1..S5）
 *   --repeat <N>           每场景重复次数，默认 1
 *   --no-model             离线桩模式（零模型成本，验证管道）
 *   --token-cap <N>        真实模型 token 上限（默认 5,000,000，硬顶即 5M，不可上调）
 *   --turn-cap <N>         真实模型 LLM 轮次上限，默认 64
 *   --timeout-ms <N>       单场景真实模型墙钟超时，默认 600000
 *   --out <dir>            结果目录，默认 .runtime/bench/<ts>-<backend>
 *   --broadcast-fanout <dm|record-only>  广播扇出（桩）：dm=逐人 DM（默认）/ record-only=仅落库可拉取
 *   --list                 列出场景后退出
 *
 * @module scripts/bench/bench-run
 */

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { SCENARIOS, ALL_SCENARIO_IDS, DEFAULT_TOKEN_CAP, HARD_TOKEN_CAP } from './scenarios.mjs'
import { summarize, writeRun, markdownSummary } from './lib/metrics.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..')

function parseArgs(argv) {
  const a = {
    scenario: 'all',
    repeat: 1,
    noModel: false,
    tokenCap: DEFAULT_TOKEN_CAP,
    turnCap: 64,
    timeoutMs: 600000,
    out: null,
    list: false,
    scheduler: 'on',
    review: 'gate',
    delivery: 'bus',
    stale: 'on',
    schedMode: 'autonomous',
    broadcastFanout: 'dm',
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--scenario') (a.scenario = v), i++
    else if (k === '--repeat') (a.repeat = Math.max(1, parseInt(v, 10) || 1)), i++
    else if (k === '--no-model') a.noModel = true
    else if (k === '--token-cap') (a.tokenCap = parseInt(v, 10)), i++
    else if (k === '--turn-cap') (a.turnCap = parseInt(v, 10)), i++
    else if (k === '--timeout-ms') (a.timeoutMs = parseInt(v, 10)), i++
    else if (k === '--out') (a.out = v), i++
    else if (k === '--list') a.list = true
    else if (k === '--scheduler') (a.scheduler = v), i++
    else if (k === '--review') (a.review = v), i++
    else if (k === '--delivery') (a.delivery = v), i++
    else if (k === '--stale') (a.stale = v), i++
    else if (k === '--sched-mode') (a.schedMode = v), i++
    else if (k === '--broadcast-fanout') (a.broadcastFanout = v), i++
    else if (k.startsWith('--')) throw new Error(`未知参数：${k}`)
  }
  // 硬顶保护：token 上限绝不能超过 5M
  if (a.tokenCap > HARD_TOKEN_CAP) {
    throw new Error(
      `--token-cap ${a.tokenCap} 超过硬顶 ${HARD_TOKEN_CAP}（用户指定上限，不可上调）`,
    )
  }
  return a
}

function resolveScenarios(spec) {
  if (spec === 'all') return ALL_SCENARIO_IDS
  return spec
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .map((id) => {
      if (!SCENARIOS[id]) throw new Error(`未知场景：${id}（可用：${ALL_SCENARIO_IDS.join(',')}）`)
      return id
    })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.list) {
    for (const id of ALL_SCENARIO_IDS) console.log(`${id}\t${SCENARIOS[id].title}`)
    return
  }

  const backend = args.noModel ? 'stub' : 'model'
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outRoot = args.out
    ? resolve(args.out)
    : resolve(REPO_ROOT, '.runtime', 'bench', `${ts}-${backend}`)
  mkdirSync(outRoot, { recursive: true })

  const ids = resolveScenarios(args.scenario)
  const runId = `${backend}-${ts}`

  console.log(`[bench] backend=${backend} scenarios=${ids.join(',')} repeat=${args.repeat}`)
  console.log(`[bench] out=${outRoot}`)
  if (backend === 'model') {
    console.log(
      `[bench] tokenCap=${args.tokenCap} (hardCap=${HARD_TOKEN_CAP}) turnCap=${args.turnCap} timeoutMs=${args.timeoutMs}`,
    )
  }

  let totalTokensConsumed = 0
  const mdBlocks = []

  for (const id of ids) {
    const scenario = SCENARIOS[id]
    const samples = []
    for (let r = 0; r < args.repeat; r++) {
      process.stdout.write(`  - ${id} #${r + 1}/${args.repeat} ... `)
      if (backend === 'stub') {
        const { runStubScenario } = await import('./lib/stub-backend.mjs')
        const res = await runStubScenario(scenario, {
          scheduler: args.scheduler,
          review: args.review,
          delivery: args.delivery,
          stale: args.stale,
          schedMode: args.schedMode,
          broadcastFanout: args.broadcastFanout,
        })
        samples.push({
          repeatIndex: r,
          metrics: res.metrics,
          events: res.events,
          variant: res.variant,
        })
        console.log(`ok (${Math.round(res.metrics.e2eMs)} ms)`)
      } else {
        const { runModelScenario } = await import('./lib/model-backend.mjs')
        const res = await runModelScenario(scenario, {
          tokenCap: args.tokenCap,
          turnCap: args.turnCap,
          timeoutMs: args.timeoutMs,
        })
        totalTokensConsumed += res.metrics.tokens?.total ?? 0
        samples.push({
          repeatIndex: r,
          metrics: res.metrics,
          costGate: res.costGate,
          raw: res.raw,
        })
        console.log(
          `ok (${Math.round(res.metrics.e2eMs)} ms, turns=${res.metrics.llmTurns}, tokens=${
            res.metrics.tokens.total
          }${res.costGate.aborted ? ', ABORTED' : ''})`,
        )
      }
    }

    const run = {
      runId,
      backend,
      scenario: id,
      title: scenario.title,
      generatedAt: new Date().toISOString(),
      variant:
        backend === 'stub'
          ? {
              scheduler: args.scheduler,
              review: args.review,
              delivery: args.delivery,
              stale: args.stale,
              schedMode: args.schedMode,
              broadcastFanout: args.broadcastFanout,
            }
          : null,
      tokensCap: backend === 'model' ? args.tokenCap : null,
      samples,
      summary: summarize(samples),
      costGate:
        backend === 'model'
          ? {
              cap: args.tokenCap,
              consumedTokens: samples.reduce((s, x) => s + (x.metrics.tokens?.total ?? 0), 0),
              aborted: samples.some((x) => x.costGate?.aborted),
            }
          : null,
    }
    const { jsonPath, csvPath } = writeRun(resolve(outRoot, id), run)
    console.log(`    -> ${jsonPath}`)
    console.log(`    -> ${csvPath}`)
    mdBlocks.push(markdownSummary(run))
  }

  const md = [
    `# bench run ${runId}`,
    '',
    `- 后端：\`${backend}\``,
    `- 场景：${ids.join(', ')} ｜ 重复：${args.repeat}`,
    backend === 'model'
      ? `- token 门禁：cap=${args.tokenCap}；本轮实际消耗=${totalTokensConsumed}（占上限 ${(
          (totalTokensConsumed / args.tokenCap) *
          100
        ).toFixed(4)}%）`
      : '- token 门禁：不适用（桩模式无真实模型）',
    '',
    ...mdBlocks,
  ].join('\n')
  const mdPath = resolve(outRoot, 'SUMMARY.md')
  writeFileSync(mdPath, md, 'utf8')

  console.log('')
  if (backend === 'model') {
    console.log(
      `[bench] 本轮实际消耗 ${totalTokensConsumed} / ${args.tokenCap} token（${(
        (totalTokensConsumed / args.tokenCap) *
        100
      ).toFixed(4)}% of cap）`,
    )
  }
  console.log(`[bench] 汇总：${mdPath}`)
}

main().catch((e) => {
  console.error(`[bench][FATAL] ${e.message}`)
  process.exit(1)
})
