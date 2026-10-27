/**
 * task-3 证据探针：只读复现 dsh-swarm-demo profile 的有效 entry 列表。
 *
 * 使用与 dsh CLI 同一份 @deepseek-ai/dsh-app-boot 的 loadProfileDirectory()
 * 与 composeEntries()（不启动 server、不写任何 profile 文件；loadProfileDirectory
 * 只读 manifest / bundle patch / 用户 patch，dropRetiredBundles 在无 retired bundle
 * 时不写回）。逐行对照可用 `dsh --profile dsh-swarm-demo --dump-config` 复核。
 *
 * 运行：node investigation/evidence/03-compose-probe.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url).pathname
const profileDir = `${root}.runtime/dsh-home/profiles/dsh-swarm-demo`
const installAnchor = `${root}.runtime/dsh-cli-npm/node_modules/@deepseek-ai/dsh/package.json`

const require = createRequire(installAnchor)
const appBootPath = require.resolve('@deepseek-ai/dsh-app-boot')
const { loadProfileDirectory, composeEntries } = await import(appBootPath)

const profile = loadProfileDirectory('dsh', profileDir, installAnchor)

console.log('# profile:', profile.name, profile.dir)
console.log('# 用户 patch 文件:', profile.patchPath, '条目数:', profile.patches.length)
console.log('# skipped bundles:', JSON.stringify(profile.skippedBundles))
for (const layer of profile.layers) {
  console.log(`# layer ${layer.packageName} <- ${layer.packageDir}`)
  console.log(`#   patch files: ${layer.patchPaths.join(', ')}`)
}
const entries = composeEntries([
  ...profile.layers.map((layer) => layer.patches),
  ...(profile.patches.length === 0 ? [] : [profile.patches]),
])
console.log('# 有效 entry 数:', entries.length)
for (const entry of entries) {
  console.log(
    [entry.id, entry.name, entry.disabled === true ? 'DISABLED' : ''].filter(Boolean).join('\t'),
  )
}

// 安装副本 vs checkout 源：agent-team-profile 的 patch 是否同源
const installed = readFileSync(
  `${profileDir}/node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml`,
  'utf8',
)
const checkout = readFileSync(
  `${root}.runtime/deepseek-harness/packages/experimental/agent-team-profile/cordis.patch.yml`,
  'utf8',
)
console.log('# profile 内安装副本 patch == checkout 源 patch :', installed === checkout)
