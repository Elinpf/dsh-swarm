// auditor check-2: 独立解析运行中 Lead 会话日志与 preojection 缓存，核对 04 的事件级论断。
// 运行: node investigation/05-verify-tmp/check2-live.mjs
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import assert from 'node:assert/strict'

const ROOT = new URL('../../', import.meta.url)
const SID = 'session-4e0b08f3-9cfa-43a8-bc0a-5b6debceea3f'
const LOG = new URL(
  `.runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm--/${SID}/session.v4.jsonl.zstd`,
  ROOT,
)
const CACHE = new URL(`.runtime/dsh-home/storages/session_projcache/sessions/${SID}.json`, ROOT)

// 多帧 zstd：按 magic 28 b5 2f fd 切帧，逐帧解压（末帧可能半写，失败即丢弃）。
function decodeFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let i = buf.indexOf(MAGIC)
  while (i !== -1) {
    starts.push(i)
    i = buf.indexOf(MAGIC, i + 4)
  }
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      out.push(
        zstdDecompressSync(buf.subarray(starts[k], end), { maxOutputLength: 1 << 30 }).toString(
          'utf8',
        ),
      )
    } catch {
      /* 末帧半写，丢弃 */
    }
  }
  return { text: out.join(''), frames: starts.length, decoded: out.length }
}

const buf = readFileSync(LOG)
const { text, frames, decoded } = decodeFrames(buf)
const events = text
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const byType = (t) => events.filter((e) => e.type === t)
const teamMember = byType('team/member')
const teamTask = byType('team/task')
const teamMsg = events.filter((e) => e.type.startsWith('team/message/'))
const splices = byType('agent/inbox/spliced')

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push(['PASS', name])
  } catch (e) {
    results.push(['FAIL', name + ' :: ' + (e?.message ?? e)])
  }
}

check('zstd 多帧解码成功且事件序列化可解析', () => {
  assert.ok(frames >= 1, 'no zstd frame found')
  assert.ok(decoded >= 1, 'no frame decoded')
  assert.ok(events.length > 200, `suspiciously few events: ${events.length}`)
  assert.ok(events[0]?.type === 'session', 'first line is not the session header')
})

check('[F1] team/* 事件的 data.teamId 恒等于根会话 id', () => {
  const all = [...teamMember, ...teamTask]
  assert.ok(all.length > 0)
  for (const e of all)
    assert.equal(e.data.teamId, SID, `${e.type}@${e.seq} teamId=${e.data.teamId}`)
})

check('[F2] 每条 team/task 都是完整快照且 data.version===2', () => {
  for (const e of teamTask) {
    assert.equal(e.data.version, 2)
    for (const k of [
      'id',
      'revision',
      'subject',
      'description',
      'status',
      'blockedBy',
      'writeScopes',
    ])
      assert.ok(k in e.data.task, `task snapshot missing ${k} @${e.seq}`)
  }
})

check('[F5] 每个队员各有 provisioning→active 两跳；Lead 无 team/member 事件', () => {
  const byId = new Map()
  for (const e of teamMember) {
    const arr = byId.get(e.data.member.id) ?? []
    arr.push(e.data.member.phase)
    byId.set(e.data.member.id, arr)
  }
  assert.ok(byId.size >= 4, `expected >=4 teammates, got ${byId.size}`)
  for (const [id, phases] of byId) {
    assert.deepEqual(phases, ['provisioning', 'active'], `${id}: ${phases}`)
  }
  assert.ok(
    !teamMember.some((e) => e.data.member.id === SID),
    'Lead must not appear as a durable member',
  )
})

check('[02 §2.6] Lead 日志中没有任何 team/message/* 事件', () => {
  assert.deepEqual(teamMsg, [])
})

check('[F12] 成员→Lead 消息以 relay + next-step 落 inbox', () => {
  const relay = splices.filter((s) =>
    (s.data.inserted ?? []).some(
      (m) => m.source?.kind === 'agent-message' && m.source?.form === 'relay',
    ),
  )
  assert.ok(relay.length >= 1, 'no relay splice found')
  for (const s of relay)
    assert.equal(s.data.target, 'next-step', `seq ${s.seq} target=${s.data.target}`)
  const msg = relay[0].data.inserted.find((m) => m.source?.kind === 'agent-message')
  assert.equal(msg.source.senderSessionId !== undefined, true)
  assert.equal(msg.role, 'user')
})

check('[F13] 投递正文首块是 "Team message from <name>:"', () => {
  const relay = splices.find((s) =>
    (s.data.inserted ?? []).some((m) => m.source?.kind === 'agent-message'),
  )
  const msg = relay.data.inserted.find((m) => m.source?.kind === 'agent-message')
  assert.match(msg.content[0].text, /^Team message from .+:$/)
})

check('[F16] task-1 以 completed 的完整快照收尾（rev 递增），并记录真实 owner', () => {
  const t1 = teamTask.filter((e) => e.data.task.id === 'task-1')
  assert.ok(t1.length >= 3, `task-1 events: ${t1.length}`)
  const revs = t1.map((e) => e.data.task.revision)
  assert.deepEqual(
    revs,
    [...revs].sort((a, b) => a - b),
    'revision not monotonic',
  )
  for (let i = 1; i < revs.length; i++) assert.equal(revs[i], revs[i - 1] + 1, 'revision gap')
  const completed = t1.at(-1).data.task
  assert.equal(completed.status, 'completed')
  assert.ok(completed.ownerId, 'completed task lost ownerId')
})

check('[交叉验证] 会话日志的 ownerId 与 projection 缓存中的 member id 集合一致', () => {
  const cache = JSON.parse(readFileSync(CACHE, 'utf8'))
  const val = cache.record.rows.agentTeam.val
  assert.equal(val.id, SID)
  const memberIds = new Set(val.members.map((m) => m.id))
  memberIds.add(SID) // lead 也可作为 owner
  for (const e of teamTask) {
    const owner = e.data.task.ownerId
    if (owner !== undefined)
      assert.ok(memberIds.has(owner), `ownerId ${owner} not in roster @${e.seq}`)
  }
  assert.ok(
    val.members.every(
      (m) => m.phase === 'active' || m.phase === 'failed' || m.phase === 'provisioning',
    ),
  )
  // projection 状态含 messages/delivered/nextTaskNumber，但任务快照不含 view 字段
  assert.ok(Array.isArray(val.messages) && Array.isArray(val.delivered))
  for (const t of val.tasks) {
    assert.ok(
      !('ready' in t) && !('ownerName' in t) && !('writeScopeWarnings' in t),
      'state leaked view fields',
    )
  }
})

const memberIds = [...new Set(teamMember.map((e) => e.data.member.id))]
const taskIds = [...new Set(teamTask.map((e) => e.data.task.id))]
console.log(`frames=${frames} decoded=${decoded} events=${events.length}`)
console.log(
  `team/member=${teamMember.length} team/task=${teamTask.length} team/message/*=${
    teamMsg.length
  } relay-splices=${
    splices.filter((s) => (s.data.inserted ?? []).some((m) => m.source?.kind === 'agent-message'))
      .length
  }`,
)
console.log(
  `members=${memberIds.length} tasks=${taskIds.length} seq-range=${events[0].seq ?? 0}..${
    events.at(-1).seq
  }`,
)
console.log(`member ids: ${memberIds.join(', ')}`)
const t1 = teamTask.filter((e) => e.data.task.id === 'task-1')
console.log(
  `task-1 seqs/rev/status/owner: ${t1
    .map(
      (e) =>
        `${e.seq}:r${e.data.task.revision}:${e.data.task.status}:${e.data.task.ownerId ?? '-'}`,
    )
    .join(' | ')}`,
)
for (const [s, n] of results) console.log(s.padEnd(4), n)
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\ncheck2: ${results.length - failed}/${results.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
