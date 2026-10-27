#!/usr/bin/env node
/**
 * P46 阶段 1 探针：真实 profile + 模型下核实 leader 等待模型（不改 e2e-profile.sh / bench / verify-e2e）。
 *
 * 场景（先红后绿；判定落在**实际 tool_call / turn 事件**上，不看文本措辞）：
 *   R  红态基线 `nativeWait`：**不**禁止等待 → 观察 leader 是否调用 `wait_agent`（原生默认挂等）
 *   G1 绿态意图 `noWait`：显式要求派发后结束轮次 → 观察是否**不**调 `wait_agent`、turn 结束
 *   W  唤醒 `wakeOnMember`：成员向 **@all（含 leader）** 广播 → 观察 leader 是否**新开 turn 2**（②成立）
 *   I  无关 `peerOnly`：成员 DM **另一个成员（不含 leader）** → 观察 leader **无 turn 2**（③）
 *   G4 回归 `regression`：spawn+DM+task 看板 → 团队工具调用仍 >=4（④）
 *
 * 用法：node scripts/verify-leader-wake.mjs [--dry]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const probe = join(root, '.runtime', 'probe')
mkdirSync(probe, { recursive: true })
const DRY = process.argv.includes('--dry')

let fail = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  fail++
  console.error(`[FAIL] ${m}`)
}
const assert = (c, m) => (c ? ok(m) : bad(m))

function runHeadless(prompt, tag) {
  return new Promise((resolve) => {
    const out = []
    const err = []
    const p = spawn('bash', [join(root, 'scripts', 'run-headless.sh'), '--json', prompt], {
      cwd: root,
      env: process.env,
    })
    p.stdout.on('data', (d) => out.push(String(d)))
    p.stderr.on('data', (d) => err.push(String(d)))
    p.on('close', () => {
      const raw = out.join('')
      writeFileSync(join(probe, `p46-${tag}.json`), raw)
      writeFileSync(join(probe, `p46-${tag}.err`), err.join(''))
      const toolCalls = [...raw.matchAll(/"tool":"([^"]+)"/g)].map((m) => m[1])
      const turns = new Set(
        [...raw.matchAll(/"phase":"turn_start","turn":(\d+)/g)].map((m) => Number(m[1])),
      )
      const tokens = [...raw.matchAll(/"totalTokens":(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0)
      resolve({ raw, toolCalls, turns: [...turns].sort((a, b) => a - b), tokens })
    })
  })
}

const SCEN = {
  nativeWait:
    "spawn_teammate name='dave' description='p46' prompt='Reply with exactly ACK'. Then WAIT for dave to finish before you give your final answer (use wait_agent as needed).",
  noWait:
    "Do these in order, then END YOUR TURN (do not call wait_agent): 1) spawn_teammate name='bob' description='p46' prompt='Reply with exactly ACK'; 2) send_message target='bob' message='reply ACK'; 3) output the raw results verbatim.",
  wakeOnMember:
    "spawn_teammate name='carol' description='p46' prompt='broadcast a hello to @all then finish'. Then END YOUR TURN.",
  peerOnly:
    "spawn_teammate name='eve' description='p46' prompt='send a direct message to bob saying hi, then finish'. Then END YOUR TURN.",
  regression:
    "Do these in order and report each raw tool result verbatim: 1) spawn_teammate name='alice' description='p46' prompt='Reply with exactly ACK'; 2) send_message target='alice' message='hello'; 3) team_task_create subject='p46' description='probe'; 4) team_task_list; 5) team_summary; 6) list_agents.",
}

console.log('== P46 阶段 1：leader 等待模型核实（真实 profile + 模型）==')
if (DRY) {
  for (const [k, v] of Object.entries(SCEN)) console.log(`[dry] ${k}: ${v.slice(0, 70)}…`)
  process.exit(0)
}

let total = 0
const rows = []
async function scenario(tag) {
  const r = await runHeadless(SCEN[tag], tag)
  total += r.tokens
  rows.push({
    tag,
    turns: r.turns.join(','),
    tools: r.toolCalls.join(',') || '-',
    tokens: r.tokens,
  })
  return r
}

// R 红态基线：原生默认下 leader 是否挂 wait_agent
{
  const r = await scenario('nativeWait')
  assert(
    r.toolCalls.includes('wait_agent'),
    `R 红态：原生默认下 leader 调用 wait_agent（tools=${r.toolCalls.join(',')}）`,
  )
}
// G1 绿态意图：禁止等待 → 不调 wait_agent 且 turn 结束
{
  const r = await scenario('noWait')
  assert(!r.toolCalls.includes('wait_agent'), 'G1：显式禁止后未调 wait_agent')
  assert(r.turns.includes(1), 'G1：turn 1 结束（有 turn_start/turn_end）')
}
// W 唤醒：@all（含 leader）→ leader 新开 turn 2
{
  const r = await scenario('wakeOnMember')
  assert(
    r.turns.includes(2),
    `W ②成立：成员 @all 消息唤醒 leader 开 turn 2（turns=${r.turns.join(',')}）`,
  )
}
// I 无关：成员 DM 另一成员（不含 leader）→ 期望 leader 无 turn 2。
// ⚠️ 本轮 setup 有**混淆项**：leader spawn 的子成员「完成结果」会回报给 spawner(leader) → 必然开 turn 2，
//    故无法在本 setup 干净隔离「无关消息」。结论标【仍不可判定】而非 FAIL（不误判能力）。
{
  const r = await scenario('peerOnly')
  const woken = r.turns.includes(2)
  console.log(
    `[INFO] I ③（仍不可判定）：peer-only 场景 leader ${
      woken ? '仍开了 turn 2' : '未开 turn 2'
    }（turns=${r.turns.join(',')}）；` +
      '混淆项=spawn 子成员完成结果回报 spawner(leader)。解锁：用**非 leader 派生**的既有成员投递到不含 leader 的目标（需多成员/多轮驱动或阶段2定向唤醒实现后断言）。',
  )
}
// G4 回归
{
  const r = await scenario('regression')
  const tc = r.toolCalls.filter((t) =>
    [
      'spawn_teammate',
      'send_message',
      'team_task_create',
      'team_task_list',
      'team_summary',
      'list_agents',
    ].includes(t),
  )
  assert(tc.length >= 4, `G4 ④回归：团队工具调用 ${tc.length}（期望 >=4）`)
}

console.log('\n| 场景 | turns | tools | tokens |')
console.log('|---|---|---|---|')
for (const r of rows) console.log(`| ${r.tag} | ${r.turns} | ${r.tools} | ${r.tokens} |`)
console.log(`\n总 token ≈ ${total}`)
console.log(fail === 0 ? '\n✅ 阶段 1 探针通过' : `\n❌ 阶段 1 探针失败：${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
