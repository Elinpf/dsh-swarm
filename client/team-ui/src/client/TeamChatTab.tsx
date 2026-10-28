/**
 * Team chat tab body — **P66 像素级对齐 Jiuwen 群聊详情区** + **P67 面板内左侧栏** + **P85 主题 token 化**。
 *
 * P66（详情区）：容器 `px-7 py-6` + 内层 `mx-auto max-w-[820px] space-y-5`；消息行 `gap-3`；
 * 发送者名 16/28/600；正文 14/24；头像 32×32 rounded-xl（首字符+24 色哈希底）；`@目标`(p2p 蓝)/
 * `@所有人`(broadcast 橙) 定向 chip；正文 `@名字` 链接蓝；空态；置底+40px 阈值；时间 `HH:mm:ss`。
 *
 * P67（左侧栏，借 `docs/jiuwen-chat-ui-spec.md` §5.1/§2.2）：pane 内**左右两栏**，左 **240px**：
 * Tab「成员 / 子话题」(rounded-md p-1 / 选中 bg-card+semibold+shadow / h-8) + 群聊入口行
 * （32×32 首字符头像 + 「群聊」+ 成员名 `、` 分隔）+ 成员列表项（头像 rounded-full 32×32 +
 * 显示名 text-sm/600 + 第二行 `@<id>` + 状态点）。窄宽降级：侧栏可折叠（一个切换按钮），**标注**。
 *
 * P85（主题 token 化，用户实测「正文发灰」）：**去除所有硬编码前景/背景色**，改用宿主设计 token
 * （`packages/client/ui-theme/src/styles/design-platform.css` 的 `--dsw-alias-*`），使群聊正文
 * **与主对话同色**并**自动跟随 light / dark 主题**（宿主选择器 `body[data-ds-dark-theme]`）：
 *   - 正文/发送者名：`--dsw-alias-label-primary`（light=rgb(15,17,21)，**与主对话逐字节相同**；dark=rgb(249,250,251)）
 *   - 次级信息（时间 / `@slug` / 成员名列表 / 空态 / 子话题说明）：`--dsw-alias-label-tertiary`（light=rgb(129,133,140)；dark=rgb(173,178,184)）
 *   - 面板底 / 左栏底：`--dsw-alias-bg-base`（light=白；dark=rgb(21,21,23)）
 *   - Tab 选中底：`--dsw-alias-bg-layer-3`；Tab 轨道 / 群聊入口行 / 折叠按钮底：`--dsw-alias-interactive-bg-hover`
 *   - 分隔线：`--dsw-alias-border-l2`
 * 附带修正：宿主 `MarkdownText variant="compact"` 的 `.compact` 规则自带 `color: var(--dsw-alias-label-tertiary)`
 * （MarkdownText.module.css:335），会把 Markdown 正文**再调淡一档**、与纯文本路径不一致 —— 本文件用
 * {@link MD_COLOR_SCOPE} 在局部把 `label-tertiary` **重指向 `label-primary`**，使两条路径颜色完全一致。
 *
 * **需适配/不可迁移（不造数据）**：① 「子话题」——DSH 无该概念（Jiuwen 是 `team.event:` 子话题镜像）
 * → Tab 保留但内容为空态 + 说明；② 成员列表第二行 `@member_id`——DSH id 是 UUID 不可读 → 用 slug 名。
 *
 * **仍为字面量（有意保留 + 理由）**：定向 chip 的蓝/橙品牌强调色、成员状态点语义色（成功/失败/中性）、
 * 头像哈希底色（24 色浅色 chip，两种主题下配深色首字母均清晰）。这些是**语义品牌色**而非正文/底色，
 * 不随主题翻转，故不 token 化（token 表无对应橙/绿/红别名）。
 *
 * 数据：只读 `agentTeam` + `swarmBus` 投影；可见范围/排序/去重沿用 P61（`id`/`seq`）**不变**。
 * NOTE (env-limited)：无浏览器断言；像素观感由用户点开确认。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from './locales.ts'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  avatarStyleFor,
  displayNameOf,
  formatClock,
  knownNamesOf,
  orderMessages,
  renderMessage,
  type MemberLike,
  type MessageLike,
  type Segment,
} from './chat-format.ts'

/**
 * Markdown chrome labels（复用宿主 `MarkdownText`）。**reference-stable**（模块级常量），
 * 以免流式渲染缓存被新 identity 丢弃。**内容视为不可信**：宿主渲染器**禁 raw HTML、链接安全化**。
 */
const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
}

/**
 * Scoped token override（见文件头 P85 说明）：宿主 `MarkdownText variant="compact"` 的 `.compact`
 * 规则把正文色写死为 `var(--dsw-alias-label-tertiary)`（比主对话浅一档）。CSS 变量按**最近祖先**解析，
 * 故在本 wrapper 上把 `label-tertiary` 重指向 `label-primary`，使 Markdown 正文与纯文本路径、
 * 以及与主对话完全同色（light/dark 均成立）。仅影响本 wrapper 内的 markdown 子树。
 */
const MD_COLOR_SCOPE = { '--dsw-alias-label-tertiary': 'var(--dsw-alias-label-primary)' } as CSSProperties

/** Full props of the team chat tab body. */
export type TeamChatTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS>

interface MemberRow extends MemberLike {
  id: string
  name: string
  role: string
  phase: string
}

type Projections = Record<string, { values?: Record<string, unknown> }> | undefined

const GAP_PX = 40 // 上滑阈值（Jiuwen `TeamMembersPanel.tsx:319`）
const SIDEBAR_PX = 240 // 左栏宽（Jiuwen `TeamMembersPanel.tsx:201`）

/* ---- P85 主题 token（宿主 `--dsw-alias-*`；随 light/dark 自动切换） ---- */
const C_LABEL_PRIMARY = 'var(--dsw-alias-label-primary)' // 正文/标题前景（light=rgb(15,17,21)）
const C_LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary)' // 次级信息（light=rgb(129,133,140)）
const C_BG_BASE = 'var(--dsw-alias-bg-base)' // 面板底（light=白；dark=rgb(21,21,23)）
const C_BG_LAYER3 = 'var(--dsw-alias-bg-layer-3)' // 选中 Tab 底
const C_BG_SUBTLE = 'var(--dsw-alias-interactive-bg-hover)' // 轨道/入口行/折叠按钮底
const BORDER = 'var(--dsw-alias-border-l2)' // 分隔线

function titleOf(projections: Projections, memberId: string): string | undefined {
  const v = projections?.[memberId]?.values?.['sessionTitle']
  if (typeof v === 'string' && v.trim().length > 0) return v
  if (typeof v === 'object' && v !== null) {
    const t = (v as { title?: unknown }).title
    if (typeof t === 'string' && t.trim().length > 0) return t
  }
  return undefined
}

/**
 * 成员状态点色（Jiuwen `--color-team-status-*` §2.1）。**语义色，有意保留字面量**：
 * token 表无对应「成功/失败」别名，且状态点是小色块、两种主题下均清晰。见文件头说明。
 */
function statusColor(phase: string): string {
  switch (phase) {
    case 'provisioning':
      return '#777777'
    case 'failed':
      return '#c84646'
    case 'active':
      return '#088c58'
    default:
      return '#777777'
  }
}

function TargetChip({ seg }: { seg: Segment }): JSX.Element {
  const p2p = seg.tone !== 'broadcast'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        marginRight: 6,
        padding: '1px 6px',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.5,
        // 定向强调色：p2p 蓝跟随宿主 link token；broadcast 橙为品牌强调（无对应 token，保留字面量）。
        background: p2p ? 'rgba(37,99,235,0.16)' : 'rgba(217,119,6,0.1)',
        color: p2p ? 'var(--dsw-alias-link)' : '#d97706',
      }}
    >{`@${seg.value}`}</span>
  )
}

function Avatar({ id, name, role, displayName, round = false }: { id: string; name: string; role?: string; displayName: string; round?: boolean }): JSX.Element {
  const st = avatarStyleFor({ id, name, role }, displayName)
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        width: 32,
        height: 32,
        borderRadius: round ? 9999 : 12,
        background: st.background,
        // 头像底为 24 色浅色哈希 chip（两种主题下均为浅色），首字母固定深色才清晰 —— 有意保留。
        color: '#3a4a63',
        fontSize: 14,
        fontWeight: 600,
        lineHeight: '32px',
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >{st.initial}</span>
  )
}

/** 左栏：Tab「成员 / 子话题」+ 群聊入口行 + 列表。 */
function LeftRail({ members, tab, setTab }: { members: MemberRow[]; tab: 'members' | 'subtopic'; setTab: (v: 'members' | 'subtopic') => void }): JSX.Element {
  const names = members.map((m) => displayNameOf(m))
  const btn = (active: boolean): CSSProperties => ({
    height: 32,
    flex: 1,
    textAlign: 'center',
    borderRadius: 6,
    fontSize: 13,
    border: 'none',
    cursor: 'pointer',
    background: active ? C_BG_LAYER3 : 'transparent',
    fontWeight: active ? 600 : 400,
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
    color: C_LABEL_PRIMARY,
  })
  return (
    <aside style={{ width: SIDEBAR_PX, flex: '0 0 auto', borderRight: `1px solid ${BORDER}`, background: C_BG_BASE, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '24px 24px 0' }}>
        <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 8, background: C_BG_SUBTLE }}>
          <button type="button" style={btn(tab === 'members')} onClick={() => setTab('members')}>成员</button>
          <button type="button" style={btn(tab === 'subtopic')} onClick={() => setTab('subtopic')}>子话题</button>
        </div>
      </div>
      <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', minHeight: 0 }}>
        {/* 群聊入口行（TeamMembersPanel.tsx:209-236） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 6, padding: '9px 8px', background: C_BG_SUBTLE }}>
          {/* 群头像：浅色 chip + 深色首字母（同 Avatar，有意保留字面量） */}
          <span aria-hidden style={{ width: 32, height: 32, borderRadius: 9999, background: '#dbe4f0', color: '#3a4a63', fontSize: 14, lineHeight: '32px', textAlign: 'center' }}>群</span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C_LABEL_PRIMARY }}>群聊</span>
            <span style={{ fontSize: 12, color: C_LABEL_TERTIARY, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{names.join('、')}</span>
          </span>
        </div>
        {tab === 'members' ? (
          members.map((m) => {
            const dn = displayNameOf(m)
            return (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 6, padding: '9px 8px' }}>
                <Avatar id={m.id} name={m.name} role={m.role} displayName={dn} round />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C_LABEL_PRIMARY, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dn}{m.role === 'lead' ? ' (lead)' : ''}</span>
                  {/* 第二行：Jiuwen 用 @member_id；DSH id 是 UUID 不可读 → 用 slug 名（需适配） */}
                  <span style={{ fontSize: 12, color: C_LABEL_TERTIARY, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>@{m.name}</span>
                </span>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 9999, background: statusColor(m.phase), flex: '0 0 auto' }} />
              </div>
            )
          })
        ) : (
          <div style={{ fontSize: 12, color: C_LABEL_TERTIARY, lineHeight: 1.6 }}>
            子话题：DSH 侧暂无对应概念（需适配）<br />Jiuwen 的子话题来自 `team.event:` 子话题流，本栈无该数据。
          </div>
        )}
      </div>
    </aside>
  )
}

/** Render the Jiuwen-aligned team chat pane (left rail + group detail). */
export function TeamChatTab(props: TeamChatTabProps): JSX.Element {
  const t = props.t as unknown as (key: 'title' | 'roster' | 'messages' | 'empty') => string
  const runtime = props as unknown as {
    sessionId?: SessionId
    useSession?: (
      selector: (s: { subagent?: { address?: { parentSessionId?: SessionId } } }) => SessionId | undefined,
    ) => SessionId | undefined
    useSessions?: (
      selector: (s: { projectionsBySession?: Projections; byId?: Record<string, { running?: boolean }> }) => unknown,
    ) => unknown
  }
  const leadId = (runtime.useSession?.((s) => s.subagent?.address?.parentSessionId) ?? runtime.sessionId) as
    | SessionId
    | undefined
  const projections = runtime.useSessions?.((s) => s.projectionsBySession) as Projections

  const team = (leadId === undefined ? undefined : projections?.[leadId]?.values?.['agentTeam']) as
    | { members?: MemberRow[] }
    | undefined
  const bus = (leadId === undefined ? undefined : projections?.[leadId]?.values?.['swarmBus']) as
    | { messages?: MessageLike[] }
    | undefined

  const members: MemberRow[] = useMemo(
    () => (team?.members ?? []).map((m) => ({ ...m, title: titleOf(projections, m.id) })),
    [team?.members, projections],
  )
  const byName = useMemo(() => {
    const map = new Map<string, MemberRow>()
    for (const m of members) {
      map.set(m.name, m)
      map.set(displayNameOf(m), m)
    }
    return map
  }, [members])
  const knownNames = useMemo(() => knownNamesOf(members), [members])
  const leadName = useMemo(
    () => displayNameOf(members.find((m) => m.role === 'lead') ?? { name: 'lead' }),
    [members],
  )
  const ordered = useMemo(() => orderMessages(bus?.messages ?? [], false), [bus?.messages])

  const [tab, setTab] = useState<'members' | 'subtopic'>('members')
  const [railOpen, setRailOpen] = useState(true) // 窄宽降级：可折叠（按钮切换）

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < GAP_PX
  }
  useEffect(() => {
    const el = scrollRef.current
    if (el !== null && pinned.current) el.scrollTop = el.scrollHeight
  }, [ordered.length])

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', minHeight: 0, background: C_BG_BASE }}>
      {/* 折叠按钮（窄宽降级；展开/收起 240px 侧栏） */}
      <button
        type="button"
        aria-label={railOpen ? '收起侧栏' : '展开侧栏'}
        aria-expanded={railOpen}
        onClick={() => setRailOpen((v) => !v)}
        style={{ flex: '0 0 auto', width: 20, border: 'none', borderRight: `1px solid ${BORDER}`, background: C_BG_SUBTLE, color: C_LABEL_TERTIARY, cursor: 'pointer', fontSize: 12 }}
      >{railOpen ? '‹' : '›'}</button>
      {railOpen ? <LeftRail members={members} tab={tab} setTab={setTab} /> : null}

      {/* 右侧：群聊详情（P66） */}
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '24px 28px' }}>
        {ordered.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: C_LABEL_TERTIARY }}>
            {t('empty')}
          </div>
        ) : (
          <div style={{ margin: '0 auto', maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {ordered.map((m) => {
              const model = renderMessage(m, knownNames, leadName)
              const bodyText = model.body.map((s) => (s.type === 'mention' ? `@${s.value}` : s.value)).join('')
              const sender = byName.get(model.senderName)
              const member: MemberRow =
                sender ?? ({ id: model.senderName, name: model.senderName, role: 'teammate', phase: 'active' } as MemberRow)
              const clock = formatClock(m.ts)
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Avatar id={member.id} name={member.name} role={member.role} displayName={model.senderName} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ paddingBottom: 8, fontSize: 16, lineHeight: '28px', fontWeight: 600, color: C_LABEL_PRIMARY }}>
                      {model.senderName}
                      {clock === '' ? null : (
                        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: C_LABEL_TERTIARY }}>{clock}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 14, lineHeight: '24px', color: C_LABEL_PRIMARY, wordBreak: 'break-word' }}>
                      {model.leading.map((seg, i) =>
                        seg.type === 'mention' ? <TargetChip key={`l${i}`} seg={seg} /> : <span key={`l${i}`}>{seg.value}</span>,
                      )}
                      {/* 正文：复用宿主 MarkdownText（与主对话流同源；禁 raw HTML / 链接安全化）。
                          wrapper 用 MD_COLOR_SCOPE 抵消 compact 变体的 tertiary 调淡，与纯文本路径同色。 */}
                      <div style={MD_COLOR_SCOPE}>
                        <MarkdownText text={bodyText} labels={MARKDOWN_LABELS} variant="compact" />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
