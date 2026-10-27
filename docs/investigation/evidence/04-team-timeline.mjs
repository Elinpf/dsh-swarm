// 04 证据脚本：从解压后的会话事件 JSONL 中抽取 team/* 事件时间线。
// 用法（先跑 04-extract-session.mjs 解压，再跑本脚本）：
//   node investigation/evidence/04-extract-session.mjs \
//     ".runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm--/$DSH_SESSION_ID/session.v4.jsonl.zstd" \
//     .runtime/investigation-live/session-events.jsonl
//   node investigation/evidence/04-team-timeline.mjs .runtime/investigation-live/session-events.jsonl
//
// 输出：seq | 事件类型 | 摘要，一行一条，可直接贴进调查报告。
import fs from 'node:fs'

const [, , file] = process.argv
if (!file) {
  console.error('usage: node 04-team-timeline.mjs <session-events.jsonl>')
  process.exit(2)
}

const events = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })

const short = (id) => (id ? String(id).slice(0, 8) : '-')

for (const e of events) {
  if (e.type === 'team/task') {
    const t = e.data.task
    console.log(
      `${e.seq}\t${e.type}\t${t.id}\trev=${t.revision}\tstatus=${t.status}\towner=${short(
        t.ownerId,
      )}\tblockedBy=${JSON.stringify(t.blockedBy)}`,
    )
  } else if (e.type === 'team/member') {
    const m = e.data.member
    console.log(`${e.seq}\t${e.type}\t${m.name}\tphase=${m.phase}\tid=${short(m.id)}`)
  } else if (e.type === 'tool/call' && /team|agent/.test(e.data.name)) {
    console.log(`${e.seq}\t${e.type}\t${e.data.name}`)
  }
}
