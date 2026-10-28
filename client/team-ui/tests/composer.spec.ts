import { describe, expect, it } from 'vitest'
import {
  detectTrigger,
  filterCandidates,
  mentionedNames,
  serializeComposer,
  type Candidate,
} from '../src/client/composer.ts'

describe('P68 composer（纯逻辑）', () => {
  it('detectTrigger：@成员 / $角色 / 无', () => {
    expect(detectTrigger('你好 @researcher')).toEqual({ prefix: '@', kind: 'member', query: 'researcher' })
    expect(detectTrigger('@提示词')).toEqual({ prefix: '@', kind: 'member', query: '提示词' })
    expect(detectTrigger('$designer')).toEqual({ prefix: '$', kind: 'role', query: 'designer' })
    expect(detectTrigger('普通文本')).toBeNull()
    expect(detectTrigger('a@b ')).toBeNull() // 空格结尾 → 不再触发
  })

  it('filterCandidates：按 name/显示名匹配；空 query 全量', () => {
    const cands: Candidate[] = [
      { name: 'researcher-models', displayName: '模型调研员' },
      { name: 'synthesizer', displayName: '汇总员' },
    ]
    expect(filterCandidates(cands, '').length).toBe(2)
    expect(filterCandidates(cands, 'model')).toEqual([cands[0]])
    expect(filterCandidates(cands, '汇总')).toEqual([cands[1]])
    expect(filterCandidates(cands, 'zzz')).toEqual([])
  })

  it('serializeComposer：chip → @name；去尾空白', () => {
    expect(
      serializeComposer([
        { kind: 'chip', name: 'researcher-models' },
        { kind: 'text', text: ' 请核对 ' },
      ]),
    ).toBe('@researcher-models 请核对')
    expect(serializeComposer([{ kind: 'text', text: 'hi  ' }])).toBe('hi')
  })

  it('mentionedNames：抽取 @名（去重）', () => {
    expect(mentionedNames('@a 和 @b 和 @a')).toEqual(['a', 'b'])
    expect(mentionedNames('无')).toEqual([])
  })
})
