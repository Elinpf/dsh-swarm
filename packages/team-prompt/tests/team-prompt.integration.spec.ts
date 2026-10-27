/**
 * 真实装配集成测试（P54）：用**真实的 `@deepseek-ai/dsh-system-prompt`** 服务
 * 在真实 cordis 运行时里装配系统提示词，断言 `team:leader` **确实进入渲染后的提示词**，
 * 且**不被 `leaderProgressiveDisclosure` 过滤**（团队未建时也在）。
 *
 * 与单测的区别：单测用假 ctx 记录注册；这里跑真实的 section 注册 + assemble + renderPrompt，
 * 直接堵住「以为加了、实际被藏 / 没进提示词」的静默失真。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../src/index.ts'

/** 起一个真实 cordis 上下文，挂真实 SystemPrompt 与 team-prompt 插件。 */
async function renderTeamPrompt(config: Record<string, unknown>): Promise<{
  names: string[]
  prompt: string
}> {
  const ctx = new Context()
  // team-prompt 的 inject 前置：提供 teamCore / sessions（本测试不触达其行为）。
  ctx.provide('teamCore', {} as never)
  ctx.provide('sessions', {} as never)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(plugin, config as never)
  const assembly = await ctx.systemPrompt.assemble({})
  return {
    names: assembly.sections.map((s) => s.name),
    prompt: renderPrompt(assembly),
  }
}

describe('P54 真实装配：team:leader 进入渲染后的系统提示词', () => {
  it('团队未建时：team:leader 已在，且注意——协作约定段被摘掉（对照组）', async () => {
    const { names, prompt } = await renderTeamPrompt({
      locales: 'cn',
      leaderProgressiveDisclosure: true,
      sections: [],
    })
    // ✅ 新 leader 段确实进了装配结果
    expect(names).toContain('team:leader')
    // ✅ 且真的渲染进了 prompt 文本（不是注册了却为空/被丢）
    expect(prompt).toContain('不亲自执行任务')
    expect(prompt).toContain('spawn_teammate')
    expect(prompt).toContain('不要自己去查')
    // ✅ P57：等待硬约束也在常驻段、团队未建时即渲染（不依赖被延迟的 team:dispatch）
    expect(prompt).toContain('默认禁止长阻塞')
    expect(prompt).toContain('结束你的轮次')
    // 对照组：证明渐进披露逻辑本身在工作（协作约定段确实被摘掉）
    expect(names).not.toContain('team:dispatch')
    expect(names).not.toContain('team:task-state')
  })

  it('团队已建（出现 teammate）后：team:leader 仍在，协作约定段也放出', async () => {
    const ctx = new Context()
    ctx.provide('teamCore', {} as never)
    ctx.provide('sessions', {} as never)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(plugin, {
      locales: 'cn',
      leaderProgressiveDisclosure: true,
      sections: [],
    } as never)
    // 模拟 teammate 出现（真实 team/member v2 形状：data = { version, teamId, member:{...} }）
    ctx.emit(
      'session/event',
      {},
      {
        type: 'team/member',
        data: {
          version: 2,
          teamId: 'team-1',
          member: {
            id: 'm1',
            name: 'alice',
            description: '',
            provider: 'spawn',
            context: 'fresh',
            phase: 'active',
          },
        },
      },
    )
    const assembly = await ctx.systemPrompt.assemble({})
    const names = assembly.sections.map((s) => s.name)
    expect(names).toContain('team:leader')
    expect(names).toContain('team:dispatch')
    expect(names).toContain('team:task-state')
    const prompt = renderPrompt(assembly)
    expect(prompt).toContain('不亲自执行任务')
    // P57：团队建成后，等待硬约束（team:dispatch 的 event-wake 口径）确实在渲染文本里
    expect(prompt).toContain('结束你的轮次')
  })

  it('关闭渐进披露：所有段常驻，team:leader 依旧在', async () => {
    const { names, prompt } = await renderTeamPrompt({
      locales: 'cn',
      leaderProgressiveDisclosure: false,
      sections: [],
    })
    expect(names).toContain('team:leader')
    expect(names).toContain('team:dispatch')
    expect(prompt).toContain('不亲自执行任务')
  })
})
