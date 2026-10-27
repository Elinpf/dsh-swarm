#!/usr/bin/env node
/**
 * 真实跨进程探针（零模型成本），验证 **不再是内存 mock**：
 *   A. 真实 `ctx.subprocess`（`@deepseek-ai/dsh-subprocess-local`）+ team-transport `local-child`
 *      真起 node 子进程，跑 V2（丢 ack→重发→恰好一次）与 V1（丢回声→重发→不丢不重）。
 *   B. 真实进程杀死/重启下的 journal 持久化（team-distributed + dsh-atomic-write）：
 *      leader 进程 SIGKILL 后重启，`recover()` 重放 queued-minus-delivered 且不重复。
 *
 * 用法：node scripts/verify-crossprocess.mjs   （需先 pnpm build）
 */
import { Context } from '@deepseek-ai/cordis'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { fileURLToPath } from 'node:url'
import { spawn as nodeSpawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const RELAY = join(root, 'packages/team-transport/relay/relay.mjs')
const TR = await import(join(root, 'packages/team-transport/lib/index.js'))

let fails = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  fails++
  console.error(`[FAIL] ${m}`)
}
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const frame = (n) => ({ kind: 'event', teamId: 'T', payload: { n } })

async function scenarioLocalChild(env, label, check) {
  Object.assign(process.env, env)
  const ctx = new Context()
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(TR.default, {
    backend: 'local-child',
    endpoint: 'lead',
    nodeBin: 'node',
    childRelayPath: RELAY,
    ackTimeoutMs: 40,
    reconnectIntervalMs: 0,
    autoReconnect: false,
  })
  assert(
    typeof ctx.teamTransport === 'object',
    `${label}: 真实 ctx.subprocess 驱动 local-child 起服务`,
  )
  const got = []
  ctx.teamTransport.onFrame((_pid, f) => got.push(f.payload.n))
  await ctx.teamTransport.send('worker', frame(1))
  await sleep(300)
  const stats = ctx.teamTransport.stats()
  check({ got, stats, ctx })
  await ctx.stop?.()
  for (const k of Object.keys(env)) delete process.env[k]
}

console.log('== A. 真实 ctx.subprocess（dsh-subprocess-local）驱动 local-child ==')

await scenarioLocalChild(
  { RELAY_DROP_ACKS: '1', RELAY_ACK_TIMEOUT_MS: '20' },
  'V2 丢 ack→重发→恰好一次',
  ({ got, stats }) => {
    assert(got.length === 1, `V2：目标恰好生效一次（收到回声 ${got.length} 次）`)
    assert(stats.retried >= 1, `V2：发生 ack 超时重发（retried=${stats.retried}）`)
    assert(stats.acked >= 1, `V2：最终收到子进程 ack（acked=${stats.acked}）`)
  },
)

await scenarioLocalChild(
  { RELAY_DROP_ECHOES: '1', RELAY_ACK_TIMEOUT_MS: '20' },
  'V1 丢回声→重发→不丢不重',
  ({ got }) => {
    assert(
      got.length === 1 && got[0] === 1,
      `V1：丢失回声被补齐且恰好一次（got=${JSON.stringify(got)}）`,
    )
  },
)

await scenarioLocalChild(
  { RELAY_ACK_TIMEOUT_MS: '20' },
  '基线 子进程 ack+回声',
  ({ got, stats }) => {
    assert(got.length === 1, `基线：子进程回声恰好一次（got=${got.length}）`)
    assert(stats.acked >= 1, `基线：子进程 ack（acked=${stats.acked}）`)
  },
)

console.log('\n== B. 真实进程杀死/重启下的 journal 持久化 ==')

const dir = mkdtempSync(join(tmpdir(), 'dsh-xproc-'))
const journal = join(dir, 'journal.json')
const sink = join(dir, 'sink.jsonl')

// leader 程序：第一次运行交付失败→queued；带 --recover 时交付成功→recover。
const leader = `
import { appendFileSync } from 'node:fs'
const [DIST, journal, sink, mode] = process.argv.slice(1)
const { default: TeamDistributedService } = await import(DIST)
const registered = { teamCore: {
  send: async (_a, req) => {
    if (process.env.SINK_DOWN === '1') throw new Error('sink down')
    appendFileSync(sink, JSON.stringify({ to: req.range.to }) + '\\n')
    return { messageId: 'x', status: 'accepted' }
  },
  listMembers: () => [], listTasks: () => [],
} }
const ctx = {
  logger: { debug(){}, info(){}, warn(){} },
  reflect: { provide(){} },
  get: (n) => registered[n],
  effect: (fn) => fn(),
  emit() {},
}
const svc = new TeamDistributedService(ctx, { role: 'lead', deliveryTtlMs: 30000, journalPath: journal })
svc.becomeLead({ id: 'lead' }, 'T')
if (mode === '--idle') {\n  process.stdout.write(JSON.stringify({ idle: true, pending: svc.pending }) + '\\n')\n  setInterval(() => {}, 1000) // 保持存活，等外部 SIGKILL\n} else if (mode === '--recover') {
  const r = await svc.recover({ id: 'lead' })
  process.stdout.write(JSON.stringify({ recovered: true, replayed: r.replayed, pending: svc.pending }) + '\\n')
} else {
  const r = await svc.deliver({ id: 'lead' }, 'worker', 'm-crash', [{ type: 'text', text: 'x' }])
  process.stdout.write(JSON.stringify({ status: r.status, pending: svc.pending }) + '\\n')
}
`

function runLeader(mode, sinkDown) {
  return new Promise((resolve) => {
    const p = nodeSpawn(
      process.execPath,
      ['--input-type=module', '-e', leader, DIST_FILE, journal, sink, mode],
      {
        env: { ...process.env, SINK_DOWN: sinkDown ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    let out = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.on('close', () => resolve(out.trim()))
  })
}

// 用文件 URL 传 lib 路径给子进程
const DIST_FILE = join(root, 'packages/team-distributed/lib/index.js')

const first = await runLeader('', true) // sink 离线 → queued
assert(first.includes('"status":"queued"'), `首次 leader：交付失败 → queued（${first}）`)
assert(existsSync(journal), `journal 已落盘（${journal}）`)

// 真实 SIGKILL 重启：把 leader 跑起来后杀掉
const p = nodeSpawn(
  process.execPath,
  ['--input-type=module', '-e', leader, DIST_FILE, journal, sink, '--idle'],
  { env: { ...process.env, SINK_DOWN: '0' }, stdio: ['ignore', 'pipe', 'inherit'] },
)
let idleOut = ''
p.stdout.on('data', (d) => (idleOut += String(d)))
await sleep(400)
assert(idleOut.includes('"pending":1'), `重启进程从磁盘恢复出 1 条 queued（${idleOut.trim()}）`)
p.kill('SIGKILL') // 真实杀死
const killed = p.killed
assert(killed || p.exitCode !== null, 'leader 进程被真实杀死（SIGKILL）')

// 重启：重建后 recover
const second = await runLeader('--recover', false)
assert(second.includes('"replayed":1'), `重启后 recover 重放 1 条（${second}）`)
assert(second.includes('"pending":0'), `重启后 pending 清空（${second}）`)

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log('\n== C. ssh-rpc 机制：真实 SSH 通道承载团队帧（不走本地 stdin/stdout）==')

function sshAvailable() {
  try {
    execFileSync(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'ConnectTimeout=5',
        'localhost',
        'true',
      ],
      { stdio: 'ignore', timeout: 10000 },
    )
    return true
  } catch {
    return false
  }
}

if (!sshAvailable()) {
  console.log('[SKIP] 本环境无可用 SSH 目标（BatchMode localhost 失败）——ssh-rpc 无法在此验证')
} else {
  const children = []
  // 真实 ssh 通道：本地起 `ssh localhost <node> <relay> <endpoint>`，帧经 SSH 承载（非本地 stdio 直连）
  const sshSeam = {
    async resolveExecutable() {
      return process.execPath
    },
    spawn(spec) {
      const remoteCmd = spec.argv.map((a) => String(a))
      const child = nodeSpawn(
        'ssh',
        [
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'ConnectTimeout=5',
          'localhost',
          ...remoteCmd,
        ],
        { stdio: ['pipe', 'pipe', 'inherit'] },
      )
      children.push(child)
      return {
        stdin: child.stdin ?? undefined,
        stdout: child.stdout ?? undefined,
        terminate: () => void child.kill('SIGKILL'),
        done: new Promise((res) =>
          child.on('close', (code, signal) => res({ exitCode: code, signal: signal ?? null })),
        ),
      }
    },
  }
  Object.assign(process.env, { RELAY_ACK_TIMEOUT_MS: '20' })
  const ctx = new Context()
  // 先注册 ssh seam 作为 ctx.subprocess，再加载 transport（local-child 在 start 时读取）
  await ctx.plugin({
    name: 'ssh-subprocess-host',
    apply(c) {
      c.provide('subprocess', sshSeam)
    },
  })
  await ctx.plugin(TR.default, {
    backend: 'local-child',
    endpoint: 'lead',
    nodeBin: 'node',
    childRelayPath: RELAY,
    ackTimeoutMs: 40,
    reconnectIntervalMs: 0,
    autoReconnect: false,
  })
  const got = []
  ctx.teamTransport.onFrame((_pid, f) => got.push(f.payload.n))
  await ctx.teamTransport.send('remote', frame(5))
  await sleep(700) // SSH 建链 + 帧往返
  const st1 = ctx.teamTransport.stats()
  assert(got.includes(5), `SSH 通道承载帧：父观察到远端回声（got=${JSON.stringify(got)}）`)
  assert(st1.acked >= 1, `SSH 通道：收到远端 ack（acked=${st1.acked}）`)

  const peerBefore = ctx.teamTransport.peers().find((p) => p.peerId === 'remote')
  assert(peerBefore.state === 'connected', `SSH peer connected（${peerBefore.state}）`)

  // 真实断链：杀掉 ssh 子进程 → degraded → reconnect → connected
  children[0]?.kill('SIGKILL')
  await sleep(300)
  assert(
    ctx.teamTransport.peers().find((p) => p.peerId === 'remote').state === 'degraded',
    'SSH 断链 → degraded',
  )
  await ctx.teamTransport.reconnect('remote')
  await sleep(700)
  assert(
    ctx.teamTransport.peers().find((p) => p.peerId === 'remote').state === 'connected',
    'SSH 重连 → connected',
  )
  got.length = 0
  await ctx.teamTransport.send('remote', frame(6))
  await sleep(700)
  assert(got.includes(6), `SSH 重连后仍可收发（got=${JSON.stringify(got)}）`)
  await ctx.stop?.()
  for (const c of children) c.kill('SIGKILL')
  delete process.env.RELAY_ACK_TIMEOUT_MS
}

console.log(
  fails === 0
    ? '\n✅ 真实跨进程探针通过（真实 ctx.subprocess 子进程 + 真实进程杀死/重启 journal）'
    : `\n❌ 真实跨进程探针失败：${fails} 项`,
)
process.exit(fails === 0 ? 0 : 1)
