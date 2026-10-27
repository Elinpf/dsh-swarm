import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as bundle from '../src/index.ts'

const pkgDir = dirname(fileURLToPath(import.meta.url)).replace(/\/tests$/, '')
const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

const SWARM_PLUGINS = [
  'team-core',
  'team-prompt',
  'team-bus',
  'team-review',
  'team-scheduler',
  'team-completion',
  'tool-swarm',
  'team-workspace',
  'team-skills',
  'team-memory',
  'team-compaction',
]
const LEGACY_ROWS = [
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
]

describe('@elinpf/dsh-swarm-bundle', () => {
  it('bundle 身份：dsh.bundle.patch（数组）+ 导出 ./cordis.patch.yml 与 swarm preset', () => {
    expect(manifest.dsh?.bundle?.patch).toEqual(['./cordis.patch.yml', './presets/swarm.patch.yml'])
    expect(manifest.exports['./cordis.patch.yml']).toBe('./cordis.patch.yml')
    expect(manifest.exports['./presets/swarm.patch.yml']).toBe('./presets/swarm.patch.yml')
  })

  it('swarm preset（P44）：id/name/order + 插件集（与 standard 同构由 dump-config 逐 id diff 校验）', () => {
    const swarm = readFileSync(join(pkgDir, 'presets/swarm.patch.yml'), 'utf8')
    expect(swarm).toMatch(/- id:\s*preset-swarm\b/)
    expect(swarm).toMatch(/^\s*id:\s*swarm\s*$/m)
    expect(swarm).toContain("name: '集群模式'")
    expect(swarm).toMatch(/^\s*order:\s*0\s*$/m)
    expect(swarm).toMatch(/^\s*plugins:\s*$/m)
    for (const k of ['persona', 'agent-instructions', 'tool-bash', 'tool-fs', 'tool-skill', 'tool-todo', 'tool-web', 'present']) {
      expect(swarm).toMatch(new RegExp(`- id:\\s*${k}\\b`))
    }
  })

  it('先 disabled 关掉 4 个 legacy tool-subagent* 行', () => {
    for (const id of LEGACY_ROWS) {
      // 形如 "- id: tool-subagent\n  disabled: true"
      const re = new RegExp(`-\\s*id:\\s*${id.replace(/[-]/g, '\\-')}\\s*\\n\\s*disabled:\\s*true`)
      expect(re.test(patch), `legacy 行 ${id} 应被 disabled`).toBe(true)
    }
  })

  it('insert 只覆盖 dsh-swarm 自身包行，不重复插入上游 agent-team 行', () => {
    expect(patch).toContain('- insert:')
    for (const id of SWARM_PLUGINS) {
      expect(patch).toMatch(new RegExp(`- id:\\s*${id}\\b`))
      expect(patch).toContain(`name: '@elinpf/dsh-swarm-${id}'`)
    }
    // 原生团队域由 agent-team-profile 提供，本 bundle 不得重复插入（P6 实测发现的瑕疵）
    expect(patch).not.toMatch(/- id:\s*agent-team\b/)
    expect(patch).not.toMatch(/- id:\s*tool-agent-team\b/)
  })

  it('实验包 peer 钉死 0.2.1-rc.3（防 latest 版本陷阱）', () => {
    expect(manifest.peerDependencies['@deepseek-ai/dsh-experimental-agent-team']).toBe('0.2.1-rc.3')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-experimental-tool-agent-team']).toBe(
      '0.2.1-rc.3',
    )
    expect(manifest.engines?.dsh).toBe('0.2.1-rc.3')
    expect(manifest.peerDependenciesMeta['@deepseek-ai/dsh-experimental-agent-team'].optional).toBe(
      true,
    )
  })

  it('bundle 运行时无代码（纯 patch），卸载零残留由各插件自证', () => {
    expect(Object.keys(bundle)).toHaveLength(0)
  })
})
