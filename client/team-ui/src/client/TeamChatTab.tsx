/**
 * Team chat tab body — **P66 像素级对齐 Jiuwen 群聊详情区**（`GroupChatDetail`）。
 *
 * 迁移范围（P66 in-scope，对照 `docs/jiuwen-chat-ui-spec.md` §5.1/§5.2/§5.4/§3.3）：
 * - 详情区容器：`px-7 py-6`（28/24）+ 内层 `mx-auto max-w-[820px] space-y-5`（gap 20px）；
 * - 消息行 `flex items-start gap-3`；发送者名 16px/28px semibold；正文 14px/24px；
 * - 头像 32×32 rounded-xl，底色由成员 id 确定性派生（Jiuwen 24 色哈希）；类目派生 5 类；
 * - 定向 chip：`@目标`（p2p 蓝）/`@所有人`（broadcast 橙）；正文 `@名字` 用链接蓝；
 * - 空态「暂无群聊消息」；置底 + 40px 上滑阈值；时间 `HH:mm:ss`。
 *
 * **不在本插件范围（显式列出，见 checklist doc）**：左侧 240px 侧栏/成员列表/成员·子话题 Tab（→P67）、
 * 输入框 composer 的 `@`/`$` 候选下拉（→P68）、主对话流 `team-member-message` 镜像（待上游）。
 *
 * 数据：只读 `agentTeam`（roster/显示名）+ `swarmBus`（消息流）两个投影；可见范围/排序/去重
 * 沿用 P61（`orderMessages`，`id`/`seq`）**不变**。
 *
 * NOTE (env-limited)：无自动化浏览器断言；像素观感由用户点开确认。
 */
import { useEffect, useMemo, useRef } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from './locales.ts'
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

function titleOf(projections: Projections, memberId: string): string | undefined {
  const v = projections?.[memberId]?.values?.['sessionTitle']
  if (typeof v === 'string' && v.trim().length > 0) return v
  if (typeof v === 'object' && v !== null) {
    const t = (v as { title?: unknown }).title
    if (typeof t === 'string' && t.trim().length > 0) return t
  }
  return undefined
}

/** 正文 `@名字`：链接蓝、无底（Jiuwen §2.2 群聊内覆盖）。 */
function BodyMention({ seg }: { seg: Segment }): JSX.Element {
  return <span style={{ color: '#0067d1' }}>{`@${seg.value}`}</span>
}

/** 定向 chip：p2p 蓝 / broadcast 橙（Jiuwen `.team-event-group-chip` §2.3）。 */
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
        background: p2p ? 'rgba(37,99,235,0.16)' : 'rgba(217,119,6,0.1)',
        color: p2p ? '#2563eb' : '#d97706',
      }}
    >{`@${seg.value}`}</span>
  )
}

/** 头像 32×32 rounded-xl（Jiuwen `TeamMemberAvatar` 默认；代码口径 h-8 w-8）。 */
function Avatar({ id, name, role, displayName }: { id: string; name: string; role?: string; displayName: string }): JSX.Element {
  const st = avatarStyleFor({ id, name, role }, displayName)
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        width: 32,
        height: 32,
        borderRadius: 12,
        background: st.background,
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

/** Render the Jiuwen-aligned group-chat detail (message list + empty state). */
export function TeamChatTab(props: TeamChatTabProps): JSX.Element {
  const t = props.t as unknown as (key: 'title' | 'roster' | 'messages' | 'empty') => string
  const runtime = props as unknown as {
    sessionId?: SessionId
    useSession?: (
      selector: (s: { subagent?: { address?: { parentSessionId?: SessionId } } }) => SessionId | undefined,
    ) => SessionId | undefined
    useSessions?: (selector: (s: { projectionsBySession?: Projections }) => unknown) => unknown
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
  // 显示名解析：name/显示名 → 成员（用于 sender 头像/角色归位）。
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

  // 升序（Jiuwen 群聊按时间升序）；排序/去重沿用 P61（id/seq）。
  const ordered = useMemo(() => orderMessages(bus?.messages ?? [], false), [bus?.messages])

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#fff' }}>
      <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '24px 28px' }}>
        {ordered.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#808080' }}>
            {t('empty')}
          </div>
        ) : (
          <div style={{ margin: '0 auto', maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {ordered.map((m) => {
              const model = renderMessage(m, knownNames, leadName)
              const sender = byName.get(model.senderName)
              const member: MemberRow =
                sender ?? ({ id: model.senderName, name: model.senderName, role: 'teammate', phase: 'active' } as MemberRow)
              const clock = formatClock(m.ts)
              return (
                <div key={m.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <Avatar id={member.id} name={member.name} role={member.role} displayName={model.senderName} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ paddingBottom: 8, fontSize: 16, lineHeight: '28px', fontWeight: 600, color: '#191919' }}>
                      {model.senderName}
                      {clock === '' ? null : (
                        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: '#808080' }}>{clock}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 14, lineHeight: '24px', color: '#191919', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {model.leading.map((seg, i) =>
                        seg.type === 'mention' ? <TargetChip key={`l${i}`} seg={seg} /> : <span key={`l${i}`}>{seg.value}</span>,
                      )}
                      {model.body.map((seg, i) =>
                        seg.type === 'mention' ? <BodyMention key={`b${i}`} seg={seg} /> : <span key={`b${i}`}>{seg.value}</span>,
                      )}
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
