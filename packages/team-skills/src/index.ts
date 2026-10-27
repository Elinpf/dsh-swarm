/**
 * 技能可见性：按团队/成员声明技能可见子集，并**落到每个成员的 `ctx.skills` scope 层**，
 * 让「成员只见被授权的技能」在真实技能注册表上生效。
 *
 * 语义：
 * - `declare(teamId, map)` 注册可见性文档；`map[memberId]` 或 `map['*']` 给出允许的技能名，
 *   **空数组 = 全禁止**；**无文档 = 无限制（`unrestricted`）**。
 * - `visibleTo(agent)` 返回该成员可见技能名数组，或 `'unrestricted'`；并触发落层（reconcile）。
 * - `grant(agent, names)` 为该成员追加授权（文档之外的增量），返回 disposer。
 *
 * 落层机制（依据 0.2.1-rc.3 源码，见 docs/verification.md §H）：
 * - 每个 Agent 自带 scope：`agent-loop/src/agent.ts:130-131`
 *   （`this.scope=createScope(loopCtx,this); this.ctx=this.scope.ctx`）——**agent 自身就是它的 scope key**。
 * - `ctx.skills.register()` 把 runtime 技能落进**调用 context 的 scope 层**（`skill/src/index.ts:441,452,556`）；
 *   读取合并 global + 查看 scope 链，**最近层同名优先**。
 * - 模型侧读取用 `scope: agent`（`tool-skill/src/index.ts:135,188,224`）。
 * - 故把可见性落到 `agent.ctx` 的 scope 层 → 只对该成员可见 / 不可见。
 * - 取服务用 `agent.ctx.get('skills')` 而非属性 `agent.ctx.skills`：`get()` 走 root store，
 *   在「skills 服务与 agent 是**兄弟 fiber**」的真实拓扑下仍可解析；属性访问会抛 `without inject`。
 *
 * 端口隔离：只从 `@elinpf/dsh-swarm-team-*-contract` 取类型；不 import 上游 skills 类型。
 *
 * @module @elinpf/dsh-swarm-team-skills
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillVisibility, TeamSkills } from '@elinpf/dsh-swarm-team-capability-contract'
import type { TeamCore as _TeamCore } from '@elinpf/dsh-swarm-team-core-contract'
import {
  DURABLE_VERSION,
  emitDurable as appendDurable,
  durableRecordOf,
  foldDurableEvents,
  isDurableEvent,
} from '@elinpf/dsh-swarm-team-durable'
import type { DurableEvent } from '@elinpf/dsh-swarm-team-durable'

export interface Config {
  /** 无文档时是否视为无限制（对齐迁移设计）。 */
  unrestrictedWhenUndeclared: boolean
}

/** 结构化 seam：成员 agent scope 上的 `ctx.skills` 服务（不 import 上游类型）。 */
interface ScopedSkillRegistrar {
  register(skill: {
    name: string
    description: string
    source: string
    content: string
    invocation: { modelInvocable: boolean; userInvocable: boolean }
  }): () => void
  list?(options?: { scope?: object }): Promise<Array<{ name: string }>>
}

/** 一条已落层的可见性单元：`allow`=正例（可见），`deny`=抑制（非模型可见影子）。 */
interface Cell {
  kind: 'allow' | 'deny'
  off: () => void
}

const SKILL_SOURCE = 'team-skills'
const ALLOW_BODY = '（dsh-swarm team-skills：该技能的可见性由团队授权；正文由团队技能包提供。）'

export class TeamSkillsService extends Service implements TeamSkills {
  static inject = ['skills', 'agents', 'teamCore'] as const

  static Config: z<Config> = z.object({
    unrestrictedWhenUndeclared: z.boolean().default(true),
  })

  private readonly config: Config
  private readonly docs = new Map<string, SkillVisibility>()
  private readonly grants = new Map<string, Set<string>>()
  /** memberId → (skillName → 已落层的单元)。 */
  private readonly scoped = new Map<string, Map<string, Cell>>()
  /** memberId → 最近一次落层所用的 Agent（换 agent 时先撤旧 scope 的注册）。 */
  private readonly agentOf = new Map<string, Agent>()
  /** memberId → 串行化的 reconcile 链，避免并发重叠。 */
  private readonly pending = new Map<string, Promise<void>>()
  private disposed = false
  private warnedNoSkills = false

  constructor(ctx: Context, config: Config = { unrestrictedWhenUndeclared: true }) {
    super(ctx, 'teamSkills')
    this.config = config
    // 恢复（ADR-0002）：把历史 durable 可见性/授权事件折叠回 docs/grants。
    ctx.on?.('session/event', (_s: unknown, ev: unknown) => {
      if (isDurableEvent(ev) && ev.type.startsWith('swarm/skills/')) this.recover([ev])
      const rec = durableRecordOf(ev)
      if (rec && rec.name.startsWith('swarm/skills/'))
        this.recover([{ type: rec.name, payload: rec.payload }])
    })
    ctx.effect(
      () => () => {
        this.disposed = true
        this.disposeAll()
        this.docs.clear()
        this.grants.clear()
        this.agentOf.clear()
      },
      'teamSkills.lifecycle()',
    )
  }

  /** 恢复：折叠 `swarm/skills/*` durable 事件到 docs/grants（ADR-0002；幂等）。 */
  recover(events: Iterable<DurableEvent>): void {
    foldDurableEvents(
      undefined,
      events,
      {
        'swarm/skills/visibility': (_s, p) => {
          if (typeof p.teamId === 'string' && p.map)
            this.docs.set(p.teamId, p.map as SkillVisibility)
        },
        'swarm/skills/grant': (_s, p) => {
          if (typeof p.memberId !== 'string' || !Array.isArray(p.names)) return
          let set = this.grants.get(p.memberId)
          if (!set) {
            set = new Set()
            this.grants.set(p.memberId, set)
          }
          for (const n of p.names) if (typeof n === 'string') set.add(n)
        },
      },
      { onUnknownEvent: () => {}, onUnsupportedVersion: () => {} },
    )
  }

  /** durable 发射：进程内 `ctx.emit`（供 fold）**且** 真 append 会话日志（P52 通道 A）。 */
  private emitDurable(session: unknown, type: string, payload: Record<string, unknown>): void {
    try {
      ;(this.ctx as unknown as { emit?: (t: string, p: unknown) => void }).emit?.(type, {
        version: DURABLE_VERSION,
        ...payload,
      })
      appendDurable(session, type, payload)
    } catch (e) {
      this.ctx.logger?.warn?.(
        'team-skills: durable emit %s failed: %s',
        type,
        String((e as Error)?.message),
      )
    }
  }

  declare(teamId: string, map: SkillVisibility): () => void {
    this.docs.set(teamId, map)
    this.emitDurable(undefined, 'swarm/skills/visibility', { teamId, map }) // declare 无 agent；无 session 时仅进程内 emit
    this.reconcileKnown()
    return () => {
      if (this.docs.get(teamId) === map) this.docs.delete(teamId)
      this.reconcileKnown()
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
    if (added.length > 0)
      this.emitDurable((agent as unknown as { session?: unknown }).session, 'swarm/skills/grant', {
        memberId: id,
        names: added,
      })
    void this.reconcile(agent)
    return () => {
      added.forEach((n) => set!.delete(n))
      if (set!.size === 0) this.grants.delete(id)
      void this.reconcile(agent)
    }
  }

  visibleTo(agent: Agent): string[] | 'unrestricted' {
    const id = this.memberId(agent)
    const allow = this.allowOf(id)
    void this.reconcile(agent)
    return allow
  }

  /**
   * 把该成员当前的可见集**落到它自己的 agent scope**（幂等）：
   * - 授权但**非全局**的技能名 → 落正例（成员私有 / 团队虚拟技能）。
   * - 全局但**未授权**的技能名 → 落抑制影子（`modelInvocable:false`，不进模型目录、不可被 skill 工具加载）。
   * - 无文档（`unrestricted`）→ 撤销该成员全部落层，回到全局目录。
   *
   * 返回 Promise 供调用方/测试等待收敛；契约方法（`visibleTo`/`grant`/`declare`）内部以即发即忘方式触发。
   */
  async reconcile(agent: Agent): Promise<void> {
    const id = this.memberId(agent)
    const prev = this.pending.get(id) ?? Promise.resolve()
    const next = prev.then(
      () => this.doReconcile(id, agent),
      () => this.doReconcile(id, agent),
    )
    const settled = next.catch((error: unknown) => {
      this.ctx.logger?.warn?.(
        'team-skills: reconcile %s failed: %s',
        id,
        String((error as Error)?.message ?? error),
      )
    })
    this.pending.set(id, settled)
    return settled
  }

  // ── 内部 ───────────────────────────────────────────────────────────────────

  private async doReconcile(id: string, agent: Agent): Promise<void> {
    if (this.disposed) return
    const registrar = this.registrarOf(agent)
    if (!registrar) {
      if (!this.warnedNoSkills) {
        this.warnedNoSkills = true
        this.ctx.logger?.warn?.(
          'team-skills: agent scope has no ctx.skills; visibility stays declarative-only',
        )
      }
      return
    }
    if (this.agentOf.get(id) !== agent) {
      // 同一成员换了 agent 实例：旧 scope 的注册先撤，避免悬挂。
      this.disposeMember(id)
      this.agentOf.set(id, agent)
    }
    const allow = this.allowOf(id)
    const desired = new Map<string, 'allow' | 'deny'>()
    if (allow !== 'unrestricted') {
      const allowSet = new Set(allow)
      const global = await this.globalNames()
      for (const name of allowSet) if (!global?.has(name)) desired.set(name, 'allow')
      if (global) for (const name of global) if (!allowSet.has(name)) desired.set(name, 'deny')
    }
    this.apply(id, registrar, desired)
  }

  /** 全局技能名集合；`ctx.skills` 不可用或列举失败 → `undefined`（退化为仅保证授权集合可见）。 */
  private async globalNames(): Promise<Set<string> | undefined> {
    const skills = this.skillsService()
    if (!skills?.list) return undefined
    try {
      const list = await skills.list()
      return new Set(list.map((s) => s.name))
    } catch (error) {
      this.ctx.logger?.warn?.(
        'team-skills: skills.list() failed: %s',
        String((error as Error)?.message ?? error),
      )
      return undefined
    }
  }

  /** 差异落层：只增删变化项，保证幂等、避免触发无谓的 skills/change。 */
  private apply(
    id: string,
    registrar: ScopedSkillRegistrar,
    desired: Map<string, 'allow' | 'deny'>,
  ): void {
    let current = this.scoped.get(id)
    if (!current) {
      current = new Map()
      this.scoped.set(id, current)
    }
    for (const [name, cell] of [...current]) {
      if (desired.get(name) === cell.kind) continue
      safeOff(cell.off)
      current.delete(name)
    }
    for (const [name, kind] of desired) {
      if (current.has(name)) continue
      try {
        const off = registrar.register({
          name,
          description:
            kind === 'allow'
              ? `Team skill "${name}" visible to this member (dsh-swarm team-skills).`
              : `dsh-swarm team-skills: "${name}" hidden from this member.`,
          source: SKILL_SOURCE,
          content: kind === 'allow' ? ALLOW_BODY : '',
          invocation:
            kind === 'allow'
              ? { modelInvocable: true, userInvocable: true }
              : { modelInvocable: false, userInvocable: false },
        })
        current.set(name, { kind, off })
      } catch (error) {
        this.ctx.logger?.warn?.(
          'team-skills: scoped register %s failed: %s',
          name,
          String((error as Error)?.message),
        )
      }
    }
    if (current.size === 0) this.scoped.delete(id)
  }

  /** 结构化 seam：成员 agent scope 上的 skills 服务。 */
  private registrarOf(agent: Agent): ScopedSkillRegistrar | undefined {
    const actx = (agent as { ctx?: { get?: (name: string) => unknown } }).ctx
    if (!actx || typeof actx.get !== 'function') return undefined
    const skills = actx.get('skills') as ScopedSkillRegistrar | undefined
    return skills && typeof skills.register === 'function' ? skills : undefined
  }

  /** 本插件 ctx 上的 skills 服务（用于读全局目录；不依赖成员 scope）。 */
  private skillsService():
    | { list?: (options?: { scope?: object }) => Promise<Array<{ name: string }>> }
    | undefined {
    const get = (this.ctx as { get?: (name: string) => unknown }).get
    if (typeof get !== 'function') return undefined
    return get.call(this.ctx, 'skills') as
      | { list?: (options?: { scope?: object }) => Promise<Array<{ name: string }>> }
      | undefined
  }

  private reconcileKnown(): void {
    for (const agent of this.agentOf.values()) void this.reconcile(agent)
  }

  private disposeMember(id: string): void {
    const cells = this.scoped.get(id)
    if (!cells) return
    for (const cell of cells.values()) safeOff(cell.off)
    this.scoped.delete(id)
  }

  private disposeAll(): void {
    for (const id of [...this.scoped.keys()]) this.disposeMember(id)
    this.scoped.clear()
  }

  private allowOf(id: string): string[] | 'unrestricted' {
    const granted = this.grants.get(id)
    const doc = this.docFor(id)
    if (doc === undefined) {
      return this.config.unrestrictedWhenUndeclared ? 'unrestricted' : granted ? [...granted] : []
    }
    const allow = new Set(doc)
    if (granted) granted.forEach((n) => allow.add(n))
    return [...allow]
  }

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

function safeOff(off: () => void): void {
  try {
    off()
  } catch {
    /* disposer 可能已随 scope 一并失效 */
  }
}

export default TeamSkillsService
