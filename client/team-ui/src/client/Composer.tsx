/**
 * P68-A composer：输入框 + `@` 候选下拉（像素照 Jiuwen `InputArea` / `chat-composer-suggestion`）。
 *
 * **功能扩展**：面板由只读变为**可发送**——但走的是 **P68-A 通道**：把文本作为一条 user 消息
 * **注入 Lead 会话**（等价主输入框）。
 *
 * **语义限制（显眼标注，非藏 README）**：`≠ 向某成员直发`；`不经本栈未读/兜底`；`会触发 Lead 一轮（计费）`。
 * **硬要求**：仅人工显式提交；turn 进行中禁用；去重/限速；失败**可见**（不静默）；提交展开 chip → `@<name>`（非 UUID）。
 */
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import {
  detectTrigger,
  filterCandidates,
  MENTION_TRIGGER_RE,
  serializeComposer,
  type Candidate,
  type ComposerPart,
  type Trigger,
} from './composer.ts'
import { NS } from './locales.ts'

export interface ComposerProps {
  readonly members: readonly Candidate[]
  /** turn 进行中/不可发送时禁用。 */
  readonly disabled: boolean
  /** 提交：返回 `{ok:false,error}` 时 UI 显示错误（不静默）。 */
  readonly onSubmit: (text: string) => Promise<{ ok: boolean; error?: string }>
}

const RATE_LIMIT_MS = 1500

const S: Record<string, CSSProperties> = {
  root: { borderTop: '1px solid #e4e4e7', padding: '10px 28px 14px', background: '#fff' },
  notice: { fontSize: 11, color: '#8a6d3b', background: '#fff8e6', border: '1px solid #f2e2b5', borderRadius: 6, padding: '4px 8px', marginBottom: 6, lineHeight: 1.5 },
  wrap: { position: 'relative' },
  editor: { minHeight: 40, maxHeight: 120, overflowY: 'auto', border: '1px solid #d9d9d9', borderRadius: 8, padding: '8px 10px', fontSize: 14, lineHeight: '22px', outline: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 },
  send: { marginLeft: 'auto', height: 30, padding: '0 14px', borderRadius: 6, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, cursor: 'pointer' },
  err: { fontSize: 12, color: '#c84646', marginTop: 6 },
  menu: { position: 'absolute', left: 0, bottom: 'calc(100% + 8px)', zIndex: 35, width: 'min(360px, 100%)', border: '1px solid #e4e4e7', borderRadius: 14, background: '#fff', boxShadow: '0 6px 24px rgba(0,0,0,0.12)' },
  menuHeader: { height: 34, lineHeight: '34px', padding: '0 12px', fontSize: 12, fontWeight: 650, color: '#666' },
  menuList: { maxHeight: 266, overflowY: 'auto', margin: '6px 0', padding: '0 6px' },
  item: { display: 'flex', alignItems: 'center', gap: 10, height: 44, borderRadius: 9, padding: '0 10px', cursor: 'pointer', border: 'none', width: '100%', background: 'transparent', textAlign: 'left' },
  itemActive: { background: 'rgba(37,99,235,0.08)' },
  avatar: { width: 26, height: 26, borderRadius: 9, background: 'rgba(37,99,235,0.12)', color: '#2563eb', fontSize: 12, lineHeight: '26px', textAlign: 'center', flex: '0 0 auto' },
  label: { fontSize: 13, lineHeight: '18px', color: '#282828' },
  meta: { fontSize: 11, lineHeight: '14px', color: '#808080' },
}

function chipStyle(): CSSProperties {
  return { display: 'inline-block', height: 24, lineHeight: '24px', padding: '0 6px', margin: '0 2px', borderRadius: 6, fontSize: 12, color: '#2563eb', background: 'rgba(37,99,235,0.12)', fontWeight: 500 }
}

/** Jiuwen 观感的 composer（内容 editable，含 inline chip）。 */
export function Composer({ members, disabled, onSubmit }: ComposerProps): JSX.Element {
  const editorRef = useRef<HTMLDivElement | null>(null)
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [active, setActive] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastSent = useRef(0)

  const candidates = useMemo(
    () => (trigger === null ? [] : filterCandidates(members, trigger.query)),
    [trigger, members],
  )

  function textBeforeCaret(): string {
    const sel = window.getSelection()
    if (sel === null || sel.rangeCount === 0) return ''
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    return node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').slice(0, range.startOffset) : ''
  }

  function onInput(): void {
    setTrigger(detectTrigger(textBeforeCaret()))
    setActive(0)
  }

  function insertChip(c: Candidate): void {
    const sel = window.getSelection()
    if (sel === null || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return
    const text = node.textContent ?? ''
    const before = text.slice(0, range.startOffset)
    const m = MENTION_TRIGGER_RE.exec(before)
    if (m === null) return
    const start = range.startOffset - m[0].length
    node.textContent = text.slice(0, start) + text.slice(range.startOffset)
    const r = document.createRange()
    r.setStart(node, start)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
    const chip = document.createElement('span')
    chip.setAttribute('contenteditable', 'false')
    chip.setAttribute('data-name', c.name)
    chip.textContent = `@${c.displayName}`
    Object.assign(chip.style, chipStyle())
    const cr = sel.getRangeAt(0)
    cr.insertNode(chip)
    const space = document.createTextNode('\u00a0')
    chip.after(space)
    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
    setTrigger(null)
  }

  function serialize(): string {
    const el = editorRef.current
    if (el === null) return ''
    const parts: ComposerPart[] = []
    el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        parts.push({ kind: 'text', text: n.textContent ?? '' })
      } else if (n instanceof HTMLElement && n.dataset.name !== undefined) {
        parts.push({ kind: 'chip', name: n.dataset.name })
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        parts.push({ kind: 'text', text: n.textContent ?? '' })
      }
    })
    return serializeComposer(parts)
  }

  async function submit(): Promise<void> {
    if (disabled || sending) return
    const text = serialize()
    if (text.trim().length === 0) return
    const now = Date.now()
    if (now - lastSent.current < RATE_LIMIT_MS) {
      setError('发送过快，请稍候再试')
      return
    }
    lastSent.current = now
    setSending(true)
    setError(null)
    const r = await onSubmit(text)
    setSending(false)
    if (r.ok) {
      if (editorRef.current !== null) editorRef.current.innerHTML = ''
      setTrigger(null)
    } else {
      setError(r.error ?? '发送失败')
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (trigger !== null && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(a + 1, candidates.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(a - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const c = candidates[active]
        if (c !== undefined) insertChip(c)
        return
      }
      if (e.key === 'Escape') {
        setTrigger(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div style={S.root}>
      {/* 语义限制：显眼标注（非藏 README） */}
      <div style={S.notice}>
        此输入 = 向团队 Lead 说话（等价主输入框）；≠ 向某成员直发；不计入本栈未读/兜底；会触发 Lead 一轮、计入 token。
      </div>
      <div style={S.wrap}>
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-disabled={disabled}
          contentEditable={!disabled}
          onInput={onInput}
          onKeyDown={onKeyDown}
          style={{ ...S.editor, ...(disabled ? { background: '#f7f7f7', color: '#aaa' } : {}) }}
          data-placeholder={disabled ? '（Lead 正在处理，稍后可发送）' : '输入消息，@ 提及成员…'}
        />
        {trigger !== null && candidates.length > 0 ? (
          <div style={S.menu} role="listbox">
            <div style={S.menuHeader}>{trigger.kind === 'member' ? '成员' : '角色'}</div>
            <div style={S.menuList}>
              {candidates.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className="chat-composer-suggestion__item"
                  style={{ ...S.item, ...(i === active ? S.itemActive : {}) }}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => insertChip(c)}
                >
                  <span style={S.avatar} aria-hidden>{c.displayName.slice(0, 1)}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={S.label}>{c.displayName}</span>
                    <span style={S.meta}>@{c.name}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div style={S.row}>
        <span style={{ fontSize: 11, color: '#aaa' }}>Enter 发送 · Shift+Enter 换行</span>
        <button type="button" style={{ ...S.send, ...(disabled || sending ? { background: '#9db8e8', cursor: 'default' } : {}) }} disabled={disabled || sending} onClick={() => { void submit() }}>
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      {error !== null ? <div style={S.err} role="alert">{error}</div> : null}
    </div>
  )
}
