// 04 证据脚本：把 DSH 会话日志（多帧 zstd 追加写）解压成 JSONL。
// 用法：
//   node investigation/evidence/04-extract-session.mjs \
//     ".runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm--/$DSH_SESSION_ID/session.v4.jsonl.zstd" \
//     /tmp/dsh-session.jsonl
//
// 背景：session.v4.jsonl.zstd 不是单个 zstd 帧，而是「每批写入一个独立帧」追加
// （文件头即 magic 28 b5 2f fd，此后每帧自带 magic）。node:zlib 的
// zstdDecompressSync 只解第一帧，流式解压会在帧边界报 Unknown frame descriptor。
// 因此按 magic 切帧后逐帧解压；最后一帧可能正在写入，失败则丢弃。
import fs from 'node:fs'
import zlib from 'node:zlib'

const [, , src, dst] = process.argv
if (!src || !dst) {
  console.error('usage: node 04-extract-session.mjs <session.v4.jsonl.zstd> <out.jsonl>')
  process.exit(2)
}

const buf = fs.readFileSync(src)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) offsets.push(i)

const parts = []
let failed = 0
for (let k = 0; k < offsets.length; k++) {
  const slice = buf.subarray(offsets[k], offsets[k + 1] ?? buf.length)
  try {
    parts.push(zlib.zstdDecompressSync(slice))
  } catch {
    failed++ // 最后一帧通常尚未写完
  }
}
const out = Buffer.concat(parts).toString('utf8')
fs.writeFileSync(dst, out)
console.error(
  `frames=${offsets.length} decompressed=${offsets.length - failed} failed=${failed} bytes=${
    out.length
  } lines=${out.split('\n').filter(Boolean).length} -> ${dst}`,
)
