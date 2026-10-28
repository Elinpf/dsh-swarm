import { describe, expect, it } from 'vitest'
import {
  avatarBackground,
  avatarInitial,
  avatarKind,
  avatarStyleFor,
  displayNameOf,
  formatClock,
  isCjk,
  knownNamesOf,
  orderMessages,
  parseMentions,
  renderMessage,
  textOf,
  type MessageLike,
} from '../src/client/chat-format.ts'

const msg = (over: Partial<MessageLike> & { id: string }): MessageLike => ({
  kind: 'relay',
  seq: 0,
  ...over,
})

describe('P63 chat-format（发言人 / @chip / 定向 / 排序）', () => {
  it('isCjk：中英文判定', () => {
    expect(isCjk('提示词工程分析师')).toBe(true)
    expect(isCjk('researcher-models')).toBe(false)
    expect(isCjk(undefined)).toBe(false)
  })

  it('① 发言人：优先中文 displayName，次选 title，再本地映射，最后回退英文 ID', () => {
    expect(displayNameOf({ name: 'researcher-models', displayName: '提示词工程分析师' })).toBe('提示词工程分析师')
    expect(displayNameOf({ name: 'researcher-models', title: '调研分析师' })).toBe('调研分析师')
    expect(displayNameOf({ name: 'x', displayName: 'Bob', title: '调研员' })).toBe('调研员')
    // 无数据侧真值 → 本地 slug→中文 映射
    expect(displayNameOf({ name: 'researcher-models' })).toBe('模型调研员')
    expect(displayNameOf({ name: 'synthesizer' })).toBe('汇总员')
    // 本地映射可禁用（传 {}）→ 回退英文 ID
    expect(displayNameOf({ name: 'researcher-models' }, {})).toBe('researcher-models')
    expect(displayNameOf({ name: 'unknown-slug' })).toBe('unknown-slug')
    // 空 displayName 忽略 → 本地映射
    expect(displayNameOf({ name: 'synthesizer', displayName: '  ' })).toBe('汇总员')
    // sessionTitle 是 spawn 提示前缀（含空白/过长）→ 拒绝，落到本地映射
    expect(displayNameOf({ name: 'researcher-models', title: '你是团队中的调研成员 researche' })).toBe('模型调研员')
  })

  it('头像派生：类别 + 确定性底色 + 首字母', () => {
    expect(avatarKind('lead', 'lead')).toBe('leader')
    expect(avatarKind('team-leader')).toBe('leader')
    expect(avatarKind('claude')).toBe('cli')
    expect(avatarKind('user')).toBe('user')
    expect(avatarKind('researcher-models')).toBe('member')
    // 确定性：同 id 同色；不同 id 大概率不同
    expect(avatarBackground('a')).toBe(avatarBackground('a'))
    const st = avatarStyleFor({ id: 'a', name: 'researcher-models', role: 'teammate' }, '模型调研员')
    expect(st.initial).toBe('模')
    expect(st.kind).toBe('member')
    expect(st.background).toMatch(/^#[0-9A-Fa-f]{6}$/)
    // cli 中性底
    expect(avatarStyleFor({ id: 'c', name: 'claude' }, 'Claude').background).toBe('#F2F3F5')
  })

  it('头像首字母：中文取首字、英文取首字母大写、空取 ?', () => {
    expect(avatarInitial('提示词工程分析师')).toBe('提')
    expect(avatarInitial('researcher-models')).toBe('R')
    expect(avatarInitial('  ')).toBe('?')
  })

  it('② parseMentions：无 @ → 单段 text；@提及 → mention 段（已知标记 known）', () => {
    expect(parseMentions('普通文本')).toEqual([{ type: 'text', value: '普通文本' }])
    expect(parseMentions('@team-leader 收到', ['team-leader'])).toEqual([
      { type: 'mention', value: 'team-leader', known: true },
      { type: 'text', value: ' 收到' },
    ])
    // 中文名
    expect(parseMentions('@提示词工程分析师 请核对', ['提示词工程分析师'])).toEqual([
      { type: 'mention', value: '提示词工程分析师', known: true },
      { type: 'text', value: ' 请核对' },
    ])
    // 空串
    expect(parseMentions('')).toEqual([])
  })

  it('② 多目标名称各成 chip；未知 @名不崩（chip 但 known=false）', () => {
    const segs = parseMentions('@a @b @未知人 好的', ['a', 'b'])
    expect(segs.filter((s) => s.type === 'mention').map((s) => [s.value, s.known])).toEqual([
      ['a', true],
      ['b', true],
      ['未知人', false],
    ])
  })

  it('③ outbound → 前导「@目标」定向 chip（p2p 色调）；正文照常出 chip', () => {
    const m = renderMessage(
      msg({ id: 'o1', kind: 'outbound', senderName: 'lead', targets: ['researcher-models', 'synthesizer'], content: [{ type: 'text', text: '@researcher-models 开工' }] }),
      ['researcher-models', 'synthesizer'],
      'lead',
    )
    expect(m.senderName).toBe('lead')
    expect(m.leading.map((s) => [s.type, s.value, s.tone])).toEqual([
      ['mention', 'researcher-models', 'p2p'],
      ['text', ' ', undefined],
      ['mention', 'synthesizer', 'p2p'],
    ])
    expect(m.body[0]).toEqual({ type: 'mention', value: 'researcher-models', known: true })
  })

  it('③ broadcast → 前导「@所有人」（broadcast 色调）', () => {
    const m = renderMessage(msg({ id: 'b1', kind: 'broadcast', senderName: 'lead', content: [{ type: 'text', text: '大家好' }] }), [])
    expect(m.leading).toEqual([{ type: 'mention', value: '所有人', known: false, tone: 'broadcast' }])
    expect(m.body).toEqual([{ type: 'text', value: '大家好' }])
  })

  it('formatClock → HH:mm:ss', () => {
    const ts = new Date(2026, 9, 28, 9, 5, 7).getTime()
    expect(formatClock(ts)).toBe('09:05:07')
    expect(formatClock(undefined)).toBe('')
  })

  it('③ task 指派形态（防御式）→「@某人 收到任务：<标题>」', () => {
    const m = renderMessage(msg({ id: 't1', senderName: 'lead', task: { assignee: 'synthesizer', subject: '汇总近况' } }), ['synthesizer'])
    expect(m.body).toEqual([
      { type: 'mention', value: 'synthesizer', known: true },
      { type: 'text', value: ' 收到任务：汇总近况' },
    ])
  })

  it('relay/broadcast 正文：直接解析 @chip，无前导', () => {
    const m = renderMessage(msg({ id: 'r1', kind: 'relay', senderName: 'synthesizer', content: [{ type: 'text', text: '@team-leader 已就绪' }] }), ['team-leader'])
    expect(m.leading).toEqual([])
    expect(m.body[0]).toEqual({ type: 'mention', value: 'team-leader', known: true })
  })

  it('④ 排序/去重不变：按 seq 升序、同 id 去重；newestFirst 反转', () => {
    const list = [
      msg({ id: 'a', seq: 2 }),
      msg({ id: 'b', seq: 1 }),
      msg({ id: 'a', seq: 2 }), // 重复 id
    ]
    expect(orderMessages(list, false).map((m) => m.id)).toEqual(['b', 'a'])
    expect(orderMessages(list, true).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('knownNamesOf：含成员 name 与中文显示名', () => {
    const names = knownNamesOf([
      { id: '1', name: 'researcher-models', displayName: '提示词工程分析师' },
      { id: '2', name: 'synthesizer' },
    ])
    expect(names).toContain('researcher-models')
    expect(names).toContain('提示词工程分析师')
    expect(names).toContain('synthesizer')
  })

  it('textOf：拼接文本块', () => {
    expect(textOf(msg({ id: 'x', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }))).toBe('ab')
  })
})
