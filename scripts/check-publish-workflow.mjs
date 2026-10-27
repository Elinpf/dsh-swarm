#!/usr/bin/env node
/**
 * check-publish-workflow.mjs — 对 .github/workflows/publish.yml 做「无需联网」的结构自检。
 *
 * 为什么不是 actionlint：本机网络对大体积 HTTPS 拉取不稳定，actionlint 二进制下载超时。
 * 这里用等价的静态检查覆盖最容易出错、也最关键的几点：
 *   1) YAML 能解析，且含 name / on / jobs；
 *   2) 每个 step 恰好有 run 或 uses 之一；
 *   3) `uses:` 必须钉版本（`@ref`），不接受浮动（无 @ 或 @main/@master 等未钉主版本）；
 *   4) 声明了 permissions；
 *   5) 凭证只能经 `${{ secrets.* }}` 引用——任何 step 的 run/env 里不得出现明文 token 形态；
 *   6) 发布步骤必须排在三个验证门禁（build/test/verify）之后，且门禁存在；
 *   7) NPM_TOKEN 的显式缺失检查存在。
 *
 * 退出码非 0 表示自检失败。用法： node scripts/check-publish-workflow.mjs [workflow路径]
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const wfPath = process.argv[2] ?? resolve(root, '.github/workflows/publish.yml')

let failures = 0
const ok = (m) => console.log(`[OK]   ${m}`)
const bad = (m) => {
  failures++
  console.error(`[FAIL] ${m}`)
}
const check = (cond, m) => (cond ? ok(m) : bad(m))

const raw = readFileSync(wfPath, 'utf8')
let doc
try {
  doc = yaml.load(raw)
  ok('YAML 可解析')
} catch (e) {
  bad(`YAML 解析失败：${e.message}`)
  process.exit(1)
}

check(typeof doc?.name === 'string' && doc.name.length > 0, '存在顶层 name')
check(doc?.on != null, '存在 on 触发器')
check(doc?.jobs && typeof doc.jobs === 'object', '存在 jobs')

// 触发器
const onKeys = Object.keys(doc.on ?? {})
check(onKeys.includes('push'), '触发器含 push（tag 触发）')
check(onKeys.includes('workflow_dispatch'), '触发器含 workflow_dispatch（手动触发）')
check(JSON.stringify(doc.on?.push?.tags ?? []).includes('v*'), 'push 由 v* tag 触发')

// 权限
const jobNames = Object.keys(doc.jobs ?? {})
const hasPerms = doc.permissions != null || jobNames.some((j) => doc.jobs[j]?.permissions != null)
check(hasPerms, '声明了 permissions（least-privilege）')

// 收集所有 step
const steps = []
for (const j of jobNames) {
  for (const s of doc.jobs[j]?.steps ?? []) steps.push({ job: j, ...s })
}
check(steps.length > 0, `共解析到 ${steps.length} 个 step`)

for (const [i, s] of steps.entries()) {
  const label = s.name ?? s.uses ?? `#${i}`
  const hasRun = typeof s.run === 'string' && s.run.trim().length > 0
  const hasUses = typeof s.uses === 'string' && s.uses.trim().length > 0
  check(hasRun !== hasUses, `step「${label}」恰有 run 或 uses 之一`)
  if (hasUses) {
    check(
      /@[^/\s]+$/.test(s.uses) && !/@(main|master)$/.test(s.uses),
      `step「${label}」的 uses 已钉版本（${s.uses}）`,
    )
  }
}

// 凭证：出现明文 token 形态即失败；secret 只能经 ${{ secrets.* }}
const plaintextToken = /(npm_[A-Za-z0-9]{20,}|_authToken\s*=\s*[^{$\s])/
check(!plaintextToken.test(raw), '工作流文本中无明文 token 形态')
const allStepText = steps.map((s) => `${s.run ?? ''}\n${JSON.stringify(s.env ?? {})}`).join('\n')
check(!plaintextToken.test(allStepText), 'step 的 run/env 中无明文 token')

// 门禁顺序：build → test → verify → 发布
const idx = (pred) => steps.findIndex(pred)
const iBuild = idx((s) => /run.*\bbuild\b/.test(s.run ?? '') || /门禁.*构建/.test(s.name ?? ''))
const iTest = idx(
  (s) => /vitest|run.*\btest\b/.test(s.run ?? '') || /门禁.*测试/.test(s.name ?? ''),
)
const iVerify = idx((s) => /verify/.test(s.run ?? '') || /门禁.*verify/.test(s.name ?? ''))
const iPublish = idx((s) => /pnpm -r publish/.test(s.run ?? '') && !/dry-run/.test(s.run ?? ''))
check(iBuild >= 0, '存在「构建」门禁 step')
check(iTest >= 0, '存在「测试」门禁 step')
check(iVerify >= 0, '存在「verify」门禁 step')
check(iPublish >= 0, '存在真正发布 step（pnpm -r publish）')
check(
  iBuild >= 0 && iTest > iBuild && iVerify > iTest && iPublish > iVerify,
  '顺序满足 build < test < verify < publish',
)

// secret 显式失败检查
const tokenGuard = steps.find(
  (s) => /NODE_AUTH_TOKEN|NPM_TOKEN/.test(s.run ?? '') && /exit 1/.test(s.run ?? ''),
)
check(tokenGuard != null, '存在 NPM_TOKEN 缺失时显式失败（exit 1）的检查')

// 发布相关参数
check(/--no-git-checks/.test(raw), '发布使用 --no-git-checks（tag 下 detached HEAD）')
check(/--access public/.test(raw), '发布使用 --access public')
check(/dry-run/.test(raw), '含发布前 dry-run 预检')

if (failures === 0) {
  console.log('\n✅ publish.yml 自检通过。')
} else {
  console.error(`\n❌ publish.yml 自检失败：${failures} 项。`)
  process.exit(1)
}
