// auditor check-3: 抽取 01–04 中引用的文件路径并验证其真实存在。
// 运行: node investigation/05-verify-tmp/check3-paths.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const WS = resolve(new URL('../../', import.meta.url).pathname)
const H = join(WS, '.runtime/deepseek-harness')
const P = join(WS, '.runtime/dsh-home/profiles/dsh-swarm-demo')

const docs = [
  '01-core-model.md',
  '02-tools-and-messaging.md',
  '03-ui-wiring-and-docs.md',
  '04-live-session-evidence.md',
]

// 收集候选路径（含 [H]/[S]/[W]/[P] 前缀与 `…` 缩写）
const _EXT = /\.(?:tsx|ts|md|jsonl|json|ya?ml|mjs|cjs|js|sh|txt|zstd|jsonl)$/
const _tokenRe = /(?:\[(H|S|W|P)\])?\s*`?((?:\.{0,3}\/)?[\w@./…-]*?[\w./-])`?(?::\d+(?:-\d+)?)?/g

const seen = new Map() // rawToken -> { orig, docs:Set }
for (const d of docs) {
  const text = readFileSync(join(WS, 'investigation', d), 'utf8')
  for (const m of text.matchAll(
    /(?:\[(H|S|W|P)\])?`?([A-Za-z0-9_@./…-]+\.(?:tsx|ts|md|jsonl|json|ya?ml|mjs|cjs|sh|txt|zstd|jsonl))`?(?::\d+(?:-\d+)?)?/g,
  )) {
    const prefix = m[1]
    const raw = m[2]
    if (/^https?:/.test(raw)) continue
    if (!raw.includes('/')) continue
    const key = (prefix ?? '') + '|' + raw
    if (!seen.has(key)) seen.set(key, { prefix, raw, docs: new Set() })
    seen.get(key).docs.add(d)
  }
}

// 递归索引 harness 与工作区（按 basename 后缀匹配，用于 `[H]…/` 缩写）
function index(dir, out = new Map(), depth = 0) {
  if (depth > 12) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.pnpm') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) index(p, out, depth + 1)
    else {
      const arr = out.get(e.name) ?? []
      arr.push(p)
      out.set(e.name, arr)
    }
  }
  return out
}
const hIndex = index(H)
const wIndex = index(WS)

const missing = []
const ok = []
for (const { prefix, raw, docs: dset } of seen.values()) {
  const cleaned = raw.replaceAll('…', '')
  const cands = []
  if (prefix === 'H') cands.push(join(H, cleaned.replace(/^\.{0,3}\//, '')))
  else if (prefix === 'P') cands.push(join(P, cleaned.replace(/^\.{0,3}\//, '')))
  else if (prefix === 'S' || prefix === 'W') cands.push(join(WS, cleaned.replace(/^\.{0,3}\//, '')))
  else cands.push(join(WS, cleaned), join(H, cleaned))
  if (cands.some((p) => existsSync(p) && statSync(p).isFile())) {
    ok.push(raw)
    continue
  }
  // 后缀/basename 匹配（`[H]…/` 缩写）
  const base = basename(cleaned)
  const pool = prefix === 'H' ? hIndex : prefix === 'P' ? index(P) : wIndex
  const hits = pool.get(base) ?? []
  const tail = cleaned
    .split('/')
    .filter((s) => s && s !== '.')
    .slice(-3)
    .join('/')
  const good = hits.some((p) => p.endsWith(tail)) || (hits.length > 0 && cleaned.includes('…'))
  if (good) ok.push(raw)
  else
    missing.push({
      prefix: prefix ?? '-',
      raw,
      docs: [...dset].join(','),
      tried: cands[0],
      suffixHits: hits.length,
    })
}

console.log(
  `唯一被引文件路径：${seen.size}；直接/后缀验证通过：${ok.length}；未找到：${missing.length}\n`,
)
for (const m of missing.sort((a, b) => a.raw.localeCompare(b.raw))) {
  console.log(
    `MISSING [${m.prefix}] ${m.raw}  (docs: ${m.docs})  tried=${m.tried} suffixHits=${m.suffixHits}`,
  )
}
process.exitCode = missing.length ? 1 : 0
