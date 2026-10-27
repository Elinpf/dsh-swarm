#!/usr/bin/env node
/**
 * P52 · O2 确定性正控：验证 durable 落盘**通道**本身（免模型）。
 *
 * 单一问题：`appendPluginRecord("plugin:swarm/…")`（经 team-durable.emitDurable）
 *   ① 能不能**真落盘**（解压/直读会话日志确认，而非只看调用返回）；
 *   ② 能否**读回**（`durableRecordOf` 从回放事件取回 `{name,payload}`）。
 *
 * 用**真实** `@deepseek-ai/dsh-session` + jsonl 持久化装配最小 Session（对齐 DSH 官方 live-write 契约用法）。
 * 先红后绿：RED=不 emit（期望 0 条 plugin:swarm/…）；GREEN=emit（期望 1 条 + 能读回）。
 *
 * 用法：node scripts/verify-durable-channel.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { emitDurable, durableRecordOf } = await import(
  join(root, 'packages/team-durable/lib/index.js')
)

let fail = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  fail++
  console.error(`[FAIL] ${m}`)
}
const assert = (c, m) => (c ? ok(m) : bad(m))

async function mount(dir) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Jsonl, { root: dir, compression: 'none' })
  return ctx
}

async function readEvents(ctx, id) {
  const reader = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await reader.read()).events
  } finally {
    await reader.close()
  }
}

/** 直读落盘文件（compression: none ⇒ session 目录下 session.jsonl 等），grep 证据。 */
function scanDisk(dir, needle) {
  const hits = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.includes('session') && (e.name.endsWith('.jsonl') || e.name.endsWith('.json'))) {
        const txt = readFileSync(p, 'utf8')
        for (const line of txt.split('\n')) if (line.includes(needle)) hits.push(line)
      }
    }
  }
  walk(dir)
  return hits
}

console.log('== P52 O2：durable 落盘通道正控（真实 dsh-session + jsonl，免模型）==')

const NAME = 'swarm/core/review-entered'
const REC = `plugin:${NAME}`

// ── RED：不 emit ⇒ 期望 0 条 plugin:swarm/… ──────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'p52-o2-red-'))
  const ctx = await mount(dir)
  const session = ctx.sessions.create(SessionId('p52-red'))
  await ctx.sessionPersistence.create(session.header)
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(session)
  const events = await readEvents(ctx, session.id)
  const swarm = events.filter((e) => typeof pluginRecordOf(e)?.type === 'string' && pluginRecordOf(e).type.startsWith('plugin:swarm/'))
  const disk = scanDisk(dir, REC)
  assert(swarm.length === 0, `RED：未 emit 时日志无 plugin:swarm/…（events=${events.length}）`)
  assert(disk.length === 0, 'RED：落盘文件无 plugin:swarm/…')
  await ctx.stop?.()
  rmSync(dir, { recursive: true, force: true })
}

// ── GREEN：经 emitDurable ⇒ 期望真落盘 + 可读回 ──────────────────────────────
let greenDir
{
  const dir = mkdtempSync(join(tmpdir(), 'p52-o2-green-'))
  greenDir = dir
  const ctx = await mount(dir)
  const session = ctx.sessions.create(SessionId('p52-green'))
  await ctx.sessionPersistence.create(session.header)
  const returned = emitDurable(session, NAME, { taskId: 't-1' })
  assert(returned === true, 'GREEN：emitDurable 返回 true（appendPluginRecord 未抛错）')
  await ctx.sessions.flush(session)

  // ① 真落盘（读回 events）
  const events = await readEvents(ctx, session.id)
  const rec = events.map((e) => pluginRecordOf(e)).find((r) => r?.type === REC)
  assert(!!rec, `GREEN①：会话日志含 ${REC}（events=${events.length}）`)

  // ① 真落盘（直读磁盘文件，非仅返回）
  const disk = scanDisk(dir, REC)
  assert(disk.length >= 1, `GREEN①：落盘文件确有 ${REC}（${disk.length} 行）`)

  // ② 读回：durableRecordOf 取回逻辑名 + payload
  const one = events.find((e) => pluginRecordOf(e)?.type === REC)
  const got = one ? durableRecordOf(one) : undefined
  assert(got?.name === NAME, `GREEN②：durableRecordOf 取回逻辑名=${got?.name}`)
  assert(got?.payload?.taskId === 't-1', `GREEN②：payload.taskId=${JSON.stringify(got?.payload)}`)

  await ctx.stop?.()

  // ③ 模拟「重启」：新 Context 挂同一目录 → 重新读回历史事件 → durableRecordOf 仍可取回
  const ctx2 = await mount(dir)
  const replayed = await readEvents(ctx2, SessionId('p52-green'))
  const one2 = replayed.find((e) => pluginRecordOf(e)?.type === REC)
  const got2 = one2 ? durableRecordOf(one2) : undefined
  assert(got2?.name === NAME && got2?.payload?.taskId === 't-1', 'GREEN③：重启后重读仍能 durableRecordOf 取回（跨重启 replay 成立）')
  await ctx2.stop?.()
}
if (greenDir) rmSync(greenDir, { recursive: true, force: true })

console.log(
  fail === 0
    ? '\n✅ O2 正控通过：通道 A（appendPluginRecord plugin:swarm/…）真落盘 + 可跨重启读回'
    : `\n❌ O2 正控失败：${fail} 项`,
)
process.exit(fail === 0 ? 0 : 1)
