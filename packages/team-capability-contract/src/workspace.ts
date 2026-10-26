/**
 * 阶段 2 · 工作区端口 `ctx.teamWorkspace` 的类型契约。
 * @module @elinpf/dsh-swarm-team-capability-contract/workspace
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamWorkspace: TeamWorkspace
  }
}

/** 一个成员的隔离工作区（worktree）记录。 */
export interface WorktreeRecord {
  path: string
  branch: string
  baseCommit: string
  repositoryRoot: string
}

export type LockMode = 'exclusive' | 'shared'

export interface LockRequest {
  path: string
  mode: LockMode
  ttlMs?: number
}

export interface LockHandle {
  id: string
  path: string
  mode: LockMode
  owner: string
  expiresAt: number
}

/** 成员工作区隔离（worktree）+ 文件锁/写域守卫。 */
export interface TeamWorkspace {
  /** 复用 DSH ctx.worktrees：为 caller 成员建/进 worktree（隔离 checkout）。 */
  createWorktree(caller: Agent, req?: { name?: string; from?: string }): Promise<WorktreeRecord>
  /** 当前成员所处 worktree（无则 undefined）。 */
  currentWorktree(caller: Agent): WorktreeRecord | undefined

  /** 申请写域锁；独占冲突时抛 TEAMWS_LOCK_CONFLICT。 */
  acquireLock(caller: Agent, req: LockRequest): Promise<LockHandle>
  releaseLock(caller: Agent, handle: LockHandle): Promise<void>
  listLocks(): LockHandle[]
}
