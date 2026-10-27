#!/usr/bin/env node
/**
 * exp-idle-wakeup.mjs — 「空转唤醒」长驻实验驱动（P17）。
 *
 * 回答命题：广播后，未被寻址的成员会不会真的产生额外 LLM 轮？即「被叫醒但无自己消息 →
 * 不耗 LLM 轮」这一设计声明，**成立 / 证伪 / 不可判定**。
 *
 * 做法（长驻观测，绕过 `dsh headless` 的 root 轮结束即退出截断）：
 *   - Arm `broadcast`：spawn N 成员 → 静置 → **1 次 broadcast** → lead 反复 wait_agent 直到静默 → 收尾。
 *   - Arm `n_dm`     ：同场景改发 **N 次 send_message(DM)**（对照组）→ 同样长驻收尾。
 *   逐成员从 durable 会话统计：轮次、token、是否收到 team 转发消息（relayInbound）。
 *
 * 用法（经 scripts/bench/exp-idle-wakeup.sh 调用以获得隔离环境）：
 *   bash scripts/bench/exp-idle-wakeup.sh --self-test          # 零成本：合成 durable 日志，验证采集管道
 *   bash scripts/bench/exp-idle-wakeup.sh --arm both --members alice,bob,carol \
 *        --token-cap 500000 --timeout-ms 600000 --out .runtime/bench/exp-idle-wakeup
 *
 * 约束：token 硬顶 5,000,000（用户指定），不可上调；真实模型模式逐条流式施加门禁，超限即杀。
 *
 * @module scripts/bench/exp-idle-wakeup
 */

import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { HARD_TOKEN_CAP } from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(here, '..', '..')

function parseArgs(argv) {
  const a = {
    arm: 'both',
    members: 'alice,bob,carol',
    tokenCap: 500000,
    turnCap: 40,
    timeoutMs: 600000,
    settleMs: 12000,
    out: null,
    selfTest: false,
    list: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--arm') {
      a.arm = v
      i++
    } else if (k === '--members') {
      a.members = v
      i++
    } else if (k === '--token-cap') {
      a.tokenCap = parseInt(v, 10)
      i++
    } else if (k === '--turn-cap') {
      a.turnCap = parseInt(v, 10)
      i++
    } else if (k === '--timeout-ms') {
      a.timeoutMs = parseInt(v, 10)
      i++
    } else if (k === '--settle-ms') {
      a.settleMs = parseInt(v, 10)
      i++
    } else if (k === '--out') {
      a.out = v
      i++
    } else if (k === '--self-test') a.selfTest = true
    else if (k === '--list') a.list = true
    else if (k.startsWith('--')) throw new Error(`未知参数：${k}`)
  }
  if (a.tokenCap > HARD_TOKEN_CAP) {
    throw new Error(`--token-cap ${a.tokenCap} 超过硬顶 ${HARD_TOKEN_CAP}（不可上调）`)
  }
  return a
}

const nowIso = () => new Date().toISOString().replace(/[:.]/g, '-')

// ── 零成本自检：合成 durable 会话日志，验证「按成员归属统计轮次」的采集管道 ──────────
function selfTest() {
  const { collectRunSessions } = await0Import()
  const tmp = resolve(REPO_ROOT, '.runtime', 'bench', '_selftest-sessions')
  rmSync(tmp, { recursive: true, force: true })
  const dir = join(tmp, 'escaped-cwd')
  const mk = (id, events) => {
    const d = join(dir, id)
    mkdirSync(d, { recursive: true })
    const _jsonl =
      events.map((e, i) => JSON.stringify({ seq: i, time: Date.now() + i, ...e })).join('\n') + '\n'
    const p = join(d, 'session.v4.jsonl.zstd')
    // 多帧 zstd（与真实 durable 一致）：逐行一帧
    const frames = events.map((e) =>
      execFileSync('zstd', ['-q', '-c'], { input: JSON.stringify({ ...e }) + '\n' }),
    )
    writeFileSync(p, Buffer.concat(frames))
    return p
  }
  const rootId = 'session-root-selftest'
  const childA = 'child-a-selftest'
  const childB = 'child-b-selftest'
  const t = Date.now()
  mk(rootId, [
    { type: 'session', version: 4, id: rootId, createdAt: t, cwd: REPO_ROOT },
    { type: 'team/member', data: { member: { id: childA, name: 'alice' } } },
    { type: 'team/member', data: { member: { id: childB, name: 'bob' } } },
    { type: 'subagent/catalog', data: { childId: childA } },
    { type: 'subagent/catalog', data: { childId: childB } },
  ])
  // alice：初始轮 + 广播唤醒的额外轮（收到 relay 消息）
  mk(childA, [
    {
      type: 'session',
      version: 4,
      id: childA,
      createdAt: t + 1,
      parentSession: rootId,
      origin: 'subagent',
    },
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'spawn prompt' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, usage: { inputTokens: 100, outputTokens: 2, totalTokens: 102 } },
    },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } },
    {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: 'Team message from lead:' }],
        source: { kind: 'agent-message' },
      },
    },
    {
      type: 'assistant/message',
      data: { turn: 2, usage: { inputTokens: 200, outputTokens: 3, totalTokens: 203 } },
    },
    { type: 'turn/end', data: { turn: 2 } },
  ])
  // bob：只有初始轮，没有 relay
  mk(childB, [
    {
      type: 'session',
      version: 4,
      id: childB,
      createdAt: t + 2,
      parentSession: rootId,
      origin: 'subagent',
    },
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'assistant/message',
      data: { turn: 1, usage: { inputTokens: 90, outputTokens: 1, totalTokens: 91 } },
    },
    { type: 'turn/end', data: { turn: 1 } },
  ])

  const res = collectRunSessions(dir, 0, rootId)
  const byName = Object.fromEntries(res.teammates.map((x) => [x.name, x]))
  const checks = [
    ['teammate 数 = 2', res.teammateCount === 2],
    ['alice turns = 2', byName.alice?.turns === 2],
    ['alice 收到 relay = 1', byName.alice?.relayInboundCount === 1],
    ['alice relay 轮 = [2]', JSON.stringify(byName.alice?.relayInboundTurns) === '[2]'],
    ['alice tokens total = 305', byName.alice?.tokens?.total === 305],
    ['bob turns = 1', byName.bob?.turns === 1],
    ['bob 无 relay', byName.bob?.relayInboundCount === 0],
    ['按成员归属名映射正确', byName.alice != null && byName.bob != null],
  ]
  let fail = 0
  for (const [m, ok] of checks) {
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${m}`)
    if (!ok) fail++
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log(`\n自检结果：${fail === 0 ? '全部通过' : `${fail} 项失败`}`)
  return fail === 0
}

// 让 selfTest 能用同步动态 import 的替代（Node ESM 顶层无同步 require）
let _collect = null
function await0Import() {
  return { collectRunSessions: _collect }
}

function summarizeRun(run, _args) {
  const lines = []
  lines.push(`### Arm \`${run.arm}\` — ${run.metrics.members.length} 成员`)
  lines.push('')
  lines.push(
    `- 观测窗口：root 轮 ${run.metrics.rootTurns}；wait_agent 调用 ${run.metrics.waitCalls}（其中 timedOut=true ${run.metrics.waitTimedOutTrue}）；静默观测=${run.metrics.quiescenceObserved}`,
  )
  lines.push(
    `- root 消耗：turns=${run.metrics.rootTurns} token=${run.metrics.rootTokens.total}（in ${run.metrics.rootTokens.input}/out ${run.metrics.rootTokens.output}）`,
  )
  lines.push(
    `- 中止=${run.costGate.aborted}${
      run.costGate.aborted ? `（${run.costGate.abortReason}）` : ''
    }`,
  )
  lines.push('')
  lines.push('| 成员 | turns | 额外轮(>初始) | 收到 relay | relay 轮 | tokens |')
  lines.push('|---|---|---|---|---|---|')
  for (const m of run.metrics.perMember) {
    lines.push(
      `| ${m.name ?? m.id} | ${m.turns} | ${m.extraTurnsBeyondInitial} | ${
        m.relayInboundCount
      } | ${JSON.stringify(m.relayInboundTurns)} | ${m.tokens?.total ?? 'n/a'} |`,
    )
  }
  lines.push('')
  lines.push(
    `- **额外 teammate LLM 轮合计 = ${run.metrics.extraTeammateTurns}**；消费唤醒的成员数 = ${run.metrics.membersConsumedWakeup}/${run.metrics.members.length}`,
  )
  lines.push(
    `- teammate token 合计 = ${run.metrics.teammateTokens}；root+teammate 总 token = ${run.metrics.totalTokensIncludingTeammates}`,
  )
  lines.push('')
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfTest) {
    const { collectRunSessions } = await import('./lib/sessions.mjs')
    _collect = collectRunSessions
    const ok = selfTest()
    process.exit(ok ? 0 : 1)
  }
  if (args.list) {
    console.log('arms: broadcast, n_dm')
    return
  }

  const members = args.members
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const arms = args.arm === 'both' ? ['broadcast', 'n_dm'] : [args.arm]
  const outRoot = args.out
    ? resolve(args.out)
    : resolve(REPO_ROOT, '.runtime', 'bench', `exp-idle-wakeup-${nowIso()}`)
  mkdirSync(outRoot, { recursive: true })

  const { runArm } = await import('./lib/longres.mjs')

  console.log(
    `[exp] arms=${arms.join(',')} members=${members.join(',')} tokenCap=${args.tokenCap} turnCap=${
      args.turnCap
    }`,
  )
  console.log(`[exp] out=${outRoot}`)

  const runs = []
  let totalConsumed = 0
  for (const arm of arms) {
    console.log(`\n>>> arm=${arm} ...`)
    const res = await runArm(arm, {
      members,
      tokenCap: args.tokenCap,
      turnCap: args.turnCap,
      timeoutMs: args.timeoutMs,
      settleMs: args.settleMs,
    })
    totalConsumed += res.metrics.totalTokensIncludingTeammates
    writeFileSync(resolve(outRoot, `raw-${arm}.jsonl`), res.raw.join('\n') + '\n', 'utf8')
    writeFileSync(resolve(outRoot, `stderr-${arm}.log`), res.stderr ?? '', 'utf8')
    writeFileSync(
      resolve(outRoot, `result-${arm}.json`),
      JSON.stringify(
        { metrics: res.metrics, costGate: res.costGate, prompt: res.prompt },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    // CSV（逐成员一行）
    const rows = [
      ['arm', 'member', 'turns', 'extra_turns', 'relay_inbound', 'relay_turns', 'tokens_total'],
    ]
    for (const m of res.metrics.perMember)
      rows.push([
        arm,
        m.name ?? m.id,
        m.turns,
        m.extraTurnsBeyondInitial,
        m.relayInboundCount,
        JSON.stringify(m.relayInboundTurns),
        m.tokens?.total ?? '',
      ])
    writeFileSync(
      resolve(outRoot, `result-${arm}.csv`),
      rows.map((r) => r.join(',')).join('\n') + '\n',
      'utf8',
    )
    runs.push(res)
    console.log(
      `    ok: extraTeammateTurns=${res.metrics.extraTeammateTurns} consumed=${
        res.metrics.membersConsumedWakeup
      }/${members.length} tokens(total)=${res.metrics.totalTokensIncludingTeammates}${
        res.costGate.aborted ? ' ABORTED' : ''
      }`,
    )
  }

  const md = [
    `# exp-idle-wakeup run ${nowIso()}`,
    '',
    `- members: ${members.join(', ')} ｜ arms: ${arms.join(', ')}`,
    `- token 门禁：cap/arm=${
      args.tokenCap
    }（硬顶 ${HARD_TOKEN_CAP}）；本轮 root+teammate 合计消耗=${totalConsumed}（占 5M ${(
      (totalConsumed / HARD_TOKEN_CAP) *
      100
    ).toFixed(4)}%）`,
    '',
    ...runs.map((r) => summarizeRun(r, args)),
  ].join('\n')
  writeFileSync(resolve(outRoot, 'SUMMARY.md'), md, 'utf8')
  console.log(
    `\n[exp] 本轮 root+teammate 合计消耗 ${totalConsumed} / ${HARD_TOKEN_CAP} token（${(
      (totalConsumed / HARD_TOKEN_CAP) *
      100
    ).toFixed(4)}% of 5M 硬顶）`,
  )
  console.log(`[exp] 汇总：${resolve(outRoot, 'SUMMARY.md')}`)
}

main().catch((e) => {
  console.error(`[exp][FATAL] ${e.message}`)
  process.exit(1)
})
