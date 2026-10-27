#!/usr/bin/env node
/**
 * team-distributed-journal-xproc.mjs — V3 崩溃恢复：**真实进程重启** + journal 落盘验证。
 *
 * 两个**不同的真实 OS 进程**：
 *   seed  进程：交付失败 → 消息落 queued 并原子写 journal 到磁盘 → 退出（模拟崩溃）
 *   recover 进程：复用同一 journalPath（从磁盘加载）→ recover() 重放 queued-minus-delivered → 幂等去重
 *
 * 这验证了 P15 登记为「内存 seam、未落盘」的 V3，现在（P25 后 `journalPath` 复用 dsh-atomic-write）
 * 在**真实跨进程重启**下成立。
 *
 * 运行：node scripts/team-distributed-journal-xproc.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PROC = resolve(HERE, 'team-distributed-journal-proc.mjs')
const JOURNAL = resolve(REPO_ROOT, '.runtime/probe/dist-journal.json')

function runChild(mode, failSend) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [PROC, mode, JOURNAL, failSend ? '1' : '0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let buf = ''
    child.stdout.on('data', (d) => (buf += String(d)))
    child.on('exit', (code) => {
      if (code !== 0) return rej(new Error(`child ${mode} exited ${code}`))
      try {
        res(JSON.parse(buf.trim().split('\n').pop()))
      } catch {
        rej(new Error(`child ${mode} bad output: ${buf}`))
      }
    })
  })
}

mkdirSync(resolve(REPO_ROOT, '.runtime/probe'), { recursive: true })
rmSync(JOURNAL, { force: true })

process.stdout.write('===== V3 崩溃恢复：真实进程重启 + journal 落盘 =====\n')
const seed = await runChild('seed', true)
process.stdout.write('[seed 进程] ' + JSON.stringify(seed) + '\n')
const recover = await runChild('recover', false)
process.stdout.write('[recover 进程] ' + JSON.stringify(recover) + '\n')

const pass = {
  twoDistinctProcesses: seed.pid !== recover.pid,
  seedQueuedAll: seed.pending === 3 && seed.statuses.every((s) => s.status === 'queued'),
  journalPersisted: seed.journalOnDisk?.queued?.length === 3,
  recoveredFromDisk: recover.pendingAtStart === 3,
  replayedExactlyQueued: recover.replayed === 3,
  dedupNoSecondSend:
    recover.sendsAfterDup === recover.sendsAfterRecover && recover.dedupDropped >= 1,
  drained: recover.pendingAfter === 0,
}
const allPass = Object.values(pass).every(Boolean)
process.stdout.write(`\n===== SUMMARY =====\n${JSON.stringify({ pass, allPass }, null, 2)}\n`)
process.stdout.write(`\n[${allPass ? 'PASS' : 'FAIL'}] V3 真实进程重启 + journal 持久化\n`)
process.exit(allPass ? 0 : 1)
