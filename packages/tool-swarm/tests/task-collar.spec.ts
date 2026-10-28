import { describe, expect, it } from 'vitest'
import { installTaskCollar, NATIVE_TASK_TOOLS } from '../src/task-collar.ts'

type Guard = (exec: { name?: string }) => unknown

/** 造一个只提供 `ctx.get('tools').guard` 的极简 ctx，并捕获注册的 guard。 */
function makeCtx() {
  const guards: Guard[] = []
  const ctx: any = {
    get: (n: string) =>
      n === 'tools'
        ? {
            guard: (cb: Guard) => {
              guards.push(cb)
              return () => {
                const i = guards.indexOf(cb)
                if (i >= 0) guards.splice(i, 1)
              }
            },
          }
        : undefined,
  }
  return { ctx, guards }
}

describe('@elinpf/dsh-swarm-tool-swarm · task-collar（P78）', () => {
  it('deny 名单固定为原生 4 个', () => {
    expect([...NATIVE_TASK_TOOLS]).toEqual([
      'team_task_create',
      'team_task_list',
      'team_task_get',
      'team_task_update',
    ])
  })

  it('root/global guard：挂一个；拒原生 4 个；不误伤 list_agents/wait_agent/我们的 swarm_task_*', () => {
    const { ctx, guards } = makeCtx()
    const off = installTaskCollar(ctx)
    expect(guards.length).toBe(1) // 一次挂载覆盖全体
    const g = guards[0]!
    for (const n of NATIVE_TASK_TOOLS) {
      expect(g({ name: n })).toMatch(/disabled in dsh-swarm/)
    }
    expect(g({ name: 'list_agents' })).toBeUndefined()
    expect(g({ name: 'wait_agent' })).toBeUndefined()
    expect(g({ name: 'send_message' })).toBeUndefined()
    expect(g({ name: 'swarm_task_update' })).toBeUndefined()
    off()
  })

  it('覆盖全体 agent（含 leader）：global guard 不区分 agent（无 per-agent 过滤）', () => {
    const { ctx, guards } = makeCtx()
    installTaskCollar(ctx)
    const g = guards[0]!
    // guard 只按工具名判定 → 任何 agent（含 leader）的原生任务工具都被拒（这正是期望行为）
    expect(g({ name: 'team_task_update' })).toMatch(/disabled/)
  })

  it('降级：无 tools → 不挂、不抛、disposer 可调用', () => {
    const ctx: any = { get: () => undefined }
    expect(() => installTaskCollar(ctx)).not.toThrow()
    expect(installTaskCollar(ctx)()).toBeUndefined()
  })

  it('disposer 撤销 guard', () => {
    const { ctx, guards } = makeCtx()
    const off = installTaskCollar(ctx)
    expect(guards.length).toBe(1)
    off()
    expect(guards.length).toBe(0)
  })
})
