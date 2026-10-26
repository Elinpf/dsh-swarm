/**
 * 成员工作区隔离（**复用** `ctx.worktrees`）+ 文件锁/写域守卫（**新建**）。
 *
 * DSH seam 实测（0.2.1-rc.3）：
 * - worktree：`ctx.worktrees.create(agent, req?, signal?)` 已实现「建 Git worktree 并切 cwd」→ 直接复用。
 * - 文件锁：DSH 无锁机制；`fs/write-intent` / `fs/edit-intent` 是 **waterfall 决策槽**，
 *   **拒绝的正确写法是「在监听里 throw」**（见 `fs-observation-policy` 对 edit-intent 抛 `FS_NOT_OBSERVED`），
 *   **返回 `undefined` 等于「允许/无意图」**（`tool-fs/src/write.ts` 用 `() => undefined` 兜底）。
 *   且决策槽单占：**允许时必须 `next()` 让位**，否则会绕过其它策略监听（如 observation-policy）。
 *   → 本包守卫：**允许 = `return next()`；拒绝 = `throw FsWriteDenied`**。
 *
 * 端口隔离：只从 `@elinpf/dsh-swarm-team-capability-contract` 取类型；`ctx.worktrees` 用本地结构化 seam
 * 描述，不 import 实验包类型（ADR-0001 延续）。
 *
 * @module @elinpf/dsh-swarm-team-workspace
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamCore as _TeamCore } from '@elinpf/dsh-swarm-team-core-contract'
import type {
  LockHandle,
  LockRequest,
  TeamWorkspace,
  WorktreeRecord,
} from '@elinpf/dsh-swarm-team-capability-contract'

/** 本地结构化 seam：只覆盖我们用到的 ctx.worktrees.create。 */
interface WorktreeSeam {
  create(
    agent: Agent,
    req?: { name?: string; from?: string },
    signal?: AbortSignal,
  ): Promise<{ path: string; branch: string; baseCommit: string; repositoryRoot?: string }>
}

/** 事件 actor 上可能挂着的执行上下文（取 agent 用于身份判定）。 */
interface ActorLike {
  agent?: Agent
  name?: string
}

export interface Config {
  /** 锁默认 TTL（ms）。 */
  defaultTtlMs: number
  /** 是否启用写域守卫（false 时锁降为建议性）。 */
  enforceWriteGuard: boolean
  /** TTL 清扫间隔（ms）。 */
  sweepIntervalMs: number
}

export class TeamWorkspaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TeamWorkspaceError'
  }
}

function overlaps(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/')
}
function normalize(p: string): string {
  return p.replace(/\/+$/, '')
}

export class TeamWorkspaceService extends Service implements TeamWorkspace {
  static inject = ['teamCore', 'agents', 'sessions'] as const

  static Config: z<Config> = z.object({
    defaultTtlMs: z.number().step(1).min(1).default(900000),
    enforceWriteGuard: z.boolean().default(true),
    sweepIntervalMs: z.number().step(1).min(1).default(30000),
  })

  private readonly config: Config
  private readonly locks = new Map<string, LockHandle>()
  private readonly worktrees = new Map<string, WorktreeRecord>()
  private readonly seam: WorktreeSeam | undefined
  private seq = 0
  private timer: ReturnType<typeof setInterval> | undefined

  /** 观测用：当前是否降级（fs/worktrees 缺失时）。 */
  degraded = false

  constructor(
    ctx: Context,
    config: Config = { defaultTtlMs: 900000, enforceWriteGuard: true, sweepIntervalMs: 30000 },
  ) {
    super(ctx, 'teamWorkspace')
    this.config = config
    this.seam = ctx.get('worktrees') as WorktreeSeam | undefined
    if (!this.seam)
      ctx.logger?.warn?.('team-workspace: ctx.worktrees unavailable → createWorktree will fail')
    if (!ctx.get('fs')) {
      this.degraded = true
      ctx.logger?.warn?.(
        'team-workspace: ctx.fs unavailable → locks are advisory, write guard inactive',
      )
    }

    ctx.effect(() => {
      const guards: Array<() => void> = []
      if (this.config.enforceWriteGuard) {
        const on = ctx.on as unknown as (
          n: string,
          h: (target: unknown, actor: unknown, next: () => unknown) => unknown,
        ) => () => void
        // 允许 → next() 让位；拒绝 → throw（以 Promise reject 形式穿透 waterfall，绝不同步逃逸）
        const guard = (target: unknown, actor: unknown, next: () => unknown) =>
          Promise.resolve().then(() => this.onIntent(target, actor, next))
        guards.push(on('fs/write-intent', guard))
        guards.push(on('fs/edit-intent', guard))
      }
      this.timer = setInterval(() => this.sweep(), this.config.sweepIntervalMs)
      ;(this.timer as { unref?: () => void })?.unref?.()
      return () => {
        guards.forEach((d) => d())
        if (this.timer !== undefined) clearInterval(this.timer)
        this.timer = undefined
        this.locks.clear()
        this.worktrees.clear()
      }
    }, 'teamWorkspace.guards()')
  }

  // ── worktree ───────────────────────────────────────────────────────────────

  async createWorktree(
    caller: Agent,
    req?: { name?: string; from?: string },
  ): Promise<WorktreeRecord> {
    if (!this.seam) {
      throw new TeamWorkspaceError('TEAMWS_WORKTREE_UNAVAILABLE', 'ctx.worktrees is not mounted')
    }
    const created = await this.seam.create(caller, req, new AbortController().signal)
    const record: WorktreeRecord = {
      path: created.path,
      branch: created.branch,
      baseCommit: created.baseCommit,
      repositoryRoot: created.repositoryRoot ?? created.path,
    }
    this.worktrees.set(this.agentKey(caller), record)
    return record
  }

  currentWorktree(caller: Agent): WorktreeRecord | undefined {
    return this.worktrees.get(this.agentKey(caller))
  }

  // ── 锁 ─────────────────────────────────────────────────────────────────────

  async acquireLock(caller: Agent, req: LockRequest): Promise<LockHandle> {
    this.sweep()
    const owner = this.ownerName(caller)
    for (const l of this.locks.values()) {
      if (!overlaps(l.path, req.path)) continue
      if (l.owner === owner) continue
      const conflict = l.mode === 'exclusive' || req.mode === 'exclusive'
      if (conflict) {
        throw new TeamWorkspaceError(
          'TEAMWS_LOCK_CONFLICT',
          `path "${req.path}" conflicts with ${l.mode} lock ${l.id} held by ${l.owner}`,
        )
      }
    }
    const handle: LockHandle = {
      id: `lock-${++this.seq}`,
      path: req.path,
      mode: req.mode,
      owner,
      expiresAt: Date.now() + (req.ttlMs ?? this.config.defaultTtlMs),
    }
    this.locks.set(handle.id, handle)
    return handle
  }

  async releaseLock(caller: Agent, handle: LockHandle): Promise<void> {
    const existing = this.locks.get(handle.id)
    if (!existing) return
    if (existing.owner !== this.ownerName(caller)) {
      throw new TeamWorkspaceError('TEAMWS_NOT_OWNER', `${handle.id} is held by ${existing.owner}`)
    }
    this.locks.delete(handle.id)
  }

  listLocks(): LockHandle[] {
    return [...this.locks.values()]
  }

  dispose(): void {
    this.locks.clear()
    this.worktrees.clear()
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  /** 守卫主体：拒绝 → throw（占决策槽并中止）；允许 → next()（让位给其它策略）。 */
  private onIntent(target: unknown, actor: unknown, next: () => unknown): unknown {
    if (!this.config.enforceWriteGuard) return next()
    const path = (target as { path?: string })?.path
    if (typeof path !== 'string') return next()
    const owner = this.actorOwner(actor)
    this.sweep()
    for (const l of this.locks.values()) {
      if (l.mode !== 'exclusive') continue
      if (l.owner === owner) continue
      if (overlaps(l.path, path)) {
        this.ctx.logger?.warn?.(
          'team-workspace: write to %s denied (exclusive lock %s by %s)',
          path,
          l.id,
          l.owner,
        )
        throw new TeamWorkspaceError(
          'FS_WRITE_DENIED',
          `"${path}" is locked exclusively by ${l.owner} (lock ${l.id}) — coordinate or release first`,
        )
      }
    }
    return next()
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, l] of this.locks) {
      if (l.expiresAt <= now) this.locks.delete(id)
    }
  }

  private ownerName(agent: Agent): string {
    return (
      this.ctx.get('teamCore')?.tryMembership?.(agent)?.name ??
      String((agent as { name?: string })?.name ?? 'unknown')
    )
  }
  private actorOwner(actor: unknown): string {
    const a = actor as ActorLike | undefined
    if (a?.agent) return this.ownerName(a.agent)
    return String(a?.name ?? 'unknown')
  }
  private agentKey(agent: Agent): string {
    return (
      this.ctx.get('teamCore')?.tryMembership?.(agent)?.id ??
      String((agent as { id?: string })?.id ?? 'unknown')
    )
  }
}

export default TeamWorkspaceService
