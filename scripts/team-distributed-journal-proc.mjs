#!/usr/bin/env node
/**
 * team-distributed-journal-proc.mjs — 一个**真实 OS 进程**里的 team-distributed（V3 崩溃恢复）。
 *
 * 两种模式（由父进程用不同进程两次 spawn，模拟「崩溃 → 重启」）：
 *   seed    ：交付全部失败 → 全部落 queued（并原子写 journal 到磁盘），进程退出（模拟崩溃）
 *   recover ：新进程复用**同一 journalPath**（从磁盘加载）→ recover() 重放 queued-minus-delivered；
 *             再重复投同一 messageId → 幂等去重（不二次交付）
 *
 * 用法：node team-distributed-journal-proc.mjs <seed|recover> <journalPath> <failSend 0|1>
 */

const { readFileSync } = await import('node:fs')
const { default: TeamDistributedService } = await import(
  '../packages/team-distributed/lib/index.js'
)

const mode = process.argv[2]
const journalPath = process.argv[3]
const failSend = process.argv[4] === '1'

const sendCalls = []
const registered = {}
const ctx = {
  logger: { debug() {}, info() {}, warn() {} },
  reflect: { provide: (n, v) => (registered[n] = v) },
  get: (n) => registered[n],
  effect: (fn) => {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  emit() {},
}
ctx.reflect.provide('teamCore', {
  send: async (_agent, req) => {
    sendCalls.push(req)
    if (failSend) throw new Error('simulated delivery failure (peer offline)')
    return { messageId: `ok-${sendCalls.length}`, status: 'accepted' }
  },
})

const agent = { id: 'lead', name: 'lead' }
const svc = new TeamDistributedService(ctx, {
  role: 'lead',
  ownerId: 'proc',
  deliveryTtlMs: 30000,
  journalPath,
})

const out = { mode, pid: process.pid, failSend }

if (mode === 'seed') {
  const ids = ['msg-1', 'msg-2', 'msg-3']
  out.statuses = []
  for (const id of ids)
    out.statuses.push(await svc.deliver(agent, 'bob', id, [{ type: 'text', text: id }]))
  out.pending = svc.pending
  out.journalOnDisk = JSON.parse(readFileSync(journalPath, 'utf8'))
  process.stdout.write(JSON.stringify(out) + '\n')
  process.exit(0)
}

// recover
out.pendingAtStart = svc.pending
const { replayed } = await svc.recover(agent)
out.replayed = replayed
const sendsAfterRecover = sendCalls.length
// 重复投同一 messageId → 幂等去重
const dup = await svc.deliver(agent, 'bob', 'msg-1', [{ type: 'text', text: 'msg-1' }])
out.dupStatus = dup.status
out.sendsAfterRecover = sendsAfterRecover
out.sendsAfterDup = sendCalls.length
out.dedupDropped = svc.state().dedupDropped
out.pendingAfter = svc.pending
out.journalOnDisk = JSON.parse(readFileSync(journalPath, 'utf8'))
process.stdout.write(JSON.stringify(out) + '\n')
process.exit(0)
