/**
 * 技能可见性：按团队/成员声明技能可见子集，保证「成员只见被授权的技能」。
 *
 * 语义（对照迁移设计）：
 * - `declare(teamId, map)` 注册可见性文档；`map[memberId]` 或 `map['*']` 给出允许的技能名，
 *   **空数组 = 全禁止**；**无文档 = 无限制（`unrestricted`）**。
 * - `visibleTo(agent)` 返回该成员可见技能名数组，或 `unrestricted`。
 * - `grant(agent, names)` 为该成员追加授权（覆盖文档之外的增量），返回 disposer。
 *
 * 端口隔离：只从 `@elinpf/dsh-swarm-team-*-contract` 取类型。
 *
 * **已知边界（规格 §9.2）**：DSH `ctx.skills` 是「按调用 context 的 scope 分层」的注册表，
 * 从**全局** Service 无法安全地把技能注册进**成员各自的 scope**（`register()` 落在调用者的 scope）。
 * 因此本包先把可见性作为**声明注册表 + `visibleTo` 事实源**（供 `tool-swarm` 的 `skills_visible`
 * 与消费方使用）；真正落到 `ctx.skills` 的成员 scope 过滤留待确认 scope API 后接入（见 verification.md）。
 *
 * @module @elinpf/dsh-swarm-team-skills
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillVisibility, TeamSkills } from '@elinpf/dsh-swarm-team-capability-contract'
import type { TeamCore as _TeamCore } from '@elinpf/dsh-swarm-team-core-contract'

export interface Config {
  /** 无文档时是否视为无限制（对齐迁移设计）。 */
  unrestrictedWhenUndeclared: boolean
}

export class TeamSkillsService extends Service implements TeamSkills {
  static inject = ['skills', 'agents', 'teamCore'] as const

  static Config: z<Config> = z.object({
    unrestrictedWhenUndeclared: z.boolean().default(true),
  })

  private readonly config: Config
  private readonly docs = new Map<string, SkillVisibility>()
  private readonly grants = new Map<string, Set<string>>()

  constructor(ctx: Context, config: Config = { unrestrictedWhenUndeclared: true }) {
    super(ctx, 'teamSkills')
    this.config = config
    ctx.effect(
      () => () => {
        this.docs.clear()
        this.grants.clear()
      },
      'teamSkills.lifecycle()',
    )
  }

  declare(teamId: string, map: SkillVisibility): () => void {
    this.docs.set(teamId, map)
    return () => {
      if (this.docs.get(teamId) === map) this.docs.delete(teamId)
    }
  }

  grant(agent: Agent, skillNames: string[]): () => void {
    const id = this.memberId(agent)
    let set = this.grants.get(id)
    if (!set) {
      set = new Set()
      this.grants.set(id, set)
    }
    const added = skillNames.filter((n) => !set!.has(n))
    added.forEach((n) => set!.add(n))
    return () => {
      added.forEach((n) => set!.delete(n))
      if (set!.size === 0) this.grants.delete(id)
    }
  }

  visibleTo(agent: Agent): string[] | 'unrestricted' {
    const id = this.memberId(agent)
    const granted = this.grants.get(id)
    const doc = this.docFor(id)
    if (doc === undefined) {
      // 无文档：若已 grant 则限定为 grant 集合 + 无限制语义冲突 → 以文档缺失为准，返回 unrestricted
      return this.config.unrestrictedWhenUndeclared ? 'unrestricted' : granted ? [...granted] : []
    }
    const allow = new Set(doc)
    if (granted) granted.forEach((n) => allow.add(n))
    return [...allow]
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  /** 逐条容错：malformed 文档（非字符串数组）跳过该条并计数。 */
  private docFor(memberId: string): string[] | undefined {
    for (const map of this.docs.values()) {
      const raw = map[memberId] ?? map['*']
      if (raw === undefined) continue
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
        this.ctx.logger?.warn?.('team-skills: malformed visibility entry for %s skipped', memberId)
        continue
      }
      return [...raw]
    }
    return undefined
  }

  private memberId(agent: Agent): string {
    return (
      this.ctx.get('teamCore')?.tryMembership?.(agent)?.id ??
      String((agent as { id?: string })?.id ?? 'unknown')
    )
  }
}

export default TeamSkillsService
