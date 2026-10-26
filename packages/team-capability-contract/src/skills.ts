/**
 * 阶段 2 · 技能可见性端口 `ctx.teamSkills` 的类型契约。
 * @module @elinpf/dsh-swarm-team-capability-contract/skills
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamSkills: TeamSkills
  }
}

/** memberId | '*' → 允许的技能名；空数组 = 全禁止。 */
export interface SkillVisibility {
  [member: string]: string[]
}

/** 按团队/成员声明技能可见子集；缺失文档 = 无限制（`unrestricted`）。 */
export interface TeamSkills {
  declare(teamId: string, map: SkillVisibility): () => void
  visibleTo(agent: Agent): string[] | 'unrestricted'
  grant(agent: Agent, skillNames: string[]): () => void
}
