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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

console.log('\n== D. 对端入站 attach：另一进程各自跑本栈并真实消费（A→B 跨进程端到端）==')

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-attach-'))
  const sink = join(dir, 'consumed.jsonl')
  const DAEMON = join(root, 'scripts/xproc/peer-daemon.mjs')
  Object.assign(process.env, { PEER_SINK: sink })

  const ctx = new Context()
  await ctx.plugin(SubprocessLocal) // 真实 ctx.subprocess
  await ctx.plugin(TR.default, {
    backend: 'local-child',
    endpoint: 'leaderA',
    nodeBin: 'node',
    childRelayPath: DAEMON, // 对端不是回声 relay，而是「跑本栈的对端守护」
    ackTimeoutMs: 1000,
    reconnectIntervalMs: 0,
    autoReconnect: false,
  })
  // A 进程（leader）把一条 DM 投给自己的对端 B 进程
  await ctx.teamTransport.send('peerB', {
    kind: 'event',
    teamId: 'T',
    payload: { targetId: 'bob', messageId: 'x1', content: [{ type: 'text', text: 'hi-B' }] },
  })
  await sleep(400)
  const consumed = existsSync(sink)
    ? readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean)
    : []
  assert(
    consumed.some((l) => l.includes('"messageId":"x1"')),
    `A→B 跨进程：B 进程运行时真实消费到 x1（consumed=${consumed.length} 条）`,
  )
  assert(ctx.teamTransport.stats().acked >= 1, 'A 收到 B 的对端 ack（传输层确认）')

  // at-least-once：重复投同一 messageId → B 侧幂等，不二次消费
  await ctx.teamTransport.send('peerB', {
    kind: 'event',
    teamId: 'T',
    payload: { targetId: 'bob', messageId: 'x1', content: [{ type: 'text', text: 'hi-B' }] },
  })
  await sleep(400)
  const consumed2 = existsSync(sink)
    ? readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean)
    : []
  assert(consumed2.length === consumed.length, `重复投递不二次消费（仍有 ${consumed2.length} 条）`)

  await ctx.stop?.()
  delete process.env.PEER_SINK
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log('\n== E. local-listen：两个独立启动的进程自动互连并投递 DM ==')

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-listen-'))
  const sink = join(dir, 'sink.jsonl')
  const PEER = join(root, 'scripts/xproc/listen-peer.mjs')
  const bjson = join(dir, 'B.json')

  // 进程 B 独立启动：监听 + 注册端点
  const recv = nodeSpawn(process.execPath, [PEER, 'B', dir, 'receiver', sink], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  for (let i = 0; i < 120 && !existsSync(bjson); i++) await sleep(50)
  assert(existsSync(bjson), 'B 独立启动并注册端点（registry B.json 由监听服务端写出）')

  // 进程 A 独立启动：经 registry **发现** B → 拨号 → 投递 DM
  const send = nodeSpawn(process.execPath, [PEER, 'A', dir, 'sender', sink, 'B'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((res) => send.on('close', res))
  await sleep(300)

  const frames = existsSync(sink)
    ? readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean)
    : []
  assert(
    frames.some((l) => l.includes('dm-1')),
    `A 自动发现 B 并投递 DM，B 进程收到（${frames.length} 帧）`,
  )
  const doneFile = join(dir, 'A.done')
  assert(
    existsSync(doneFile) && readFileSync(doneFile, 'utf8').includes('"found":true'),
    'A 经 registry 发现到 B（found=true，无预置守护进程）',
  )
  recv.kill('SIGKILL')
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log('\n== F. local-listen 租约 GC + 握手鉴权（P32 遗留收紧）==')

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-'))
  const sink = join(dir, 'sink.jsonl')
  const PEER = join(root, 'scripts/xproc/listen-peer.mjs')

  // 预置**陈旧端点**（死进程 + 旧心跳）
  writeFileSync(
    join(dir, 'dead.json'),
    JSON.stringify({ endpoint: 'dead', path: join(dir, 'dead.sock'), pid: 999999, heartbeatAt: 0 }),
  )
  writeFileSync(join(dir, 'dead.sock'), '')

  // 进程 B 带令牌启动（同时触发启动期 GC）
  const recv = nodeSpawn(process.execPath, [PEER, 'B', dir, 'receiver', sink], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LISTEN_TOKEN: 'secret' },
  })
  for (let i = 0; i < 120 && !existsSync(join(dir, 'B.json')); i++) await sleep(50)
  assert(!existsSync(join(dir, 'dead.json')), '陈旧端点（死进程/超租约）被 GC 清理')

  // 未授权拨入（错误令牌）→ 被拒，不投递
  const bad = nodeSpawn(process.execPath, [PEER, 'A', dir, 'sender', sink, 'B'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LISTEN_TOKEN: 'wrong' },
  })
  await new Promise((res) => bad.on('close', res))
  await sleep(300)
  const after1 = existsSync(sink) ? readFileSync(sink, 'utf8').trim() : ''
  assert(after1.length === 0, '未授权拨入被拒绝（无投递，不静默接受）')

  // 正确令牌 → 投递
  const good = nodeSpawn(process.execPath, [PEER, 'A2', dir, 'sender', sink, 'B'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LISTEN_TOKEN: 'secret' },
  })
  await new Promise((res) => good.on('close', res))
  await sleep(300)
  const frames = existsSync(sink)
    ? readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean)
    : []
  assert(
    frames.some((l) => l.includes('dm-1')),
    '正确令牌可投递（鉴权通过）',
  )

  recv.kill('SIGKILL')
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

console.log(
  fails === 0
    ? '\n✅ 真实跨进程探针通过（真实 ctx.subprocess 子进程 + 真实进程杀死/重启 journal）'
    : `\n❌ 真实跨进程探针失败：${fails} 项`,
)
process.exit(fails === 0 ? 0 : 1)
