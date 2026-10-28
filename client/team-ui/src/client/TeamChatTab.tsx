/**
 * The team chat tab body (P63 "Jiuwen-like"): the Lead Session's live roster plus
 * the group-chat message stream folded by the server-side `swarmBus` Session
 * projection (and the native `agentTeam` projection for the roster).
 *
 * Rendering (display-only, no data change):
 * - speaker = avatar initial + **display name** (prefers a Chinese name:
 *   `displayName` → the member Session's `sessionTitle` → kebab ID fallback);
 * - body text renders `@name` as chips (known members highlighted);
 * - outbound messages show a leading "→ @target…";
 * - visibility/order/dedupe unchanged (P61 `id`/`seq`; see `chat-format.ts`).
 *
 * Both projections reach the browser through the shared Session store
 * (`state.projectionsBySession[sessionId].values.<key>`), so this body performs
 * no RPC — it only reads.
 *
 * NOTE (env-limited): not covered by an automated browser assertion here.
 */
import { useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from './locales.ts'
import {
  avatarInitial,
  displayNameOf,
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

function titleOf(projections: Projections, memberId: string): string | undefined {
  const v = projections?.[memberId]?.values?.['sessionTitle']
  if (typeof v === 'string' && v.trim().length > 0) return v
  if (typeof v === 'object' && v !== null) {
    const t = (v as { title?: unknown }).title
    if (typeof t === 'string' && t.trim().length > 0) return t
  }
  return undefined
}

function Chip({ seg }: { seg: Segment }): JSX.Element {
  const mention = seg.type === 'mention'
  if (!mention) return <>{seg.value}</>
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 6px',
        margin: '0 1px',
        borderRadius: 10,
        fontSize: 12,
        background: seg.known === true ? '#e6f0ff' : '#eef0f2',
        color: seg.known === true ? '#0b5fce' : '#555',
      }}
    >{`@${seg.value}`}</span>
  )
}

function Avatar({ name }: { name: string }): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        width: 22,
        height: 22,
        borderRadius: 11,
        background: '#dbe4f0',
        color: '#3a4a63',
        fontSize: 12,
        lineHeight: '22px',
        textAlign: 'center',
      }}
    >{avatarInitial(name)}</span>
  )
}

/** Render the roster and the folded group-chat message stream. */
export function TeamChatTab(props: TeamChatTabProps): JSX.Element {
  const t = props.t as unknown as (key: 'title' | 'roster' | 'messages' | 'empty') => string
  const runtime = props as unknown as {
    sessionId?: SessionId
    useSession?: (
      selector: (snapshot: {
        subagent?: { address?: { parentSessionId?: SessionId } }
      }) => SessionId | undefined,
    ) => SessionId | undefined
    useSessions?: (
      selector: (state: { projectionsBySession?: Projections }) => unknown,
    ) => unknown
  }
  const leadId = (runtime.useSession?.((s) => s.subagent?.address?.parentSessionId) ??
    runtime.sessionId) as SessionId | undefined

  const projections = runtime.useSessions?.(
    (state) => state.projectionsBySession,
  ) as Projections

  const team = (leadId === undefined ? undefined : projections?.[leadId]?.values?.['agentTeam']) as
    | { members?: MemberRow[] }
    | undefined
  const bus = (leadId === undefined ? undefined : projections?.[leadId]?.values?.['swarmBus']) as
    | { messages?: MessageLike[] }
    | undefined

  // 成员：补上 sessionTitle（中文显示名候选）后交给 chat-format 解析显示名。
  const members: MemberRow[] = useMemo(
    () => (team?.members ?? []).map((m) => ({ ...m, title: titleOf(projections, m.id) })),
    [team?.members, projections],
  )
  const knownNames = useMemo(() => knownNamesOf(members), [members])
  const leadName = useMemo(
    () => displayNameOf(members.find((m) => m.role === 'lead') ?? { name: 'lead' }),
    [members],
  )
  const messages = useMemo(() => orderMessages(bus?.messages ?? [], true), [bus?.messages])

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, overflow: 'auto', height: '100%' }}
    >
      <section>
        <h4 style={{ margin: '0 0 6px' }}>{t('roster')}</h4>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {members.map((m) => (
            <li
              key={m.id}
              title={`${m.role} · ${m.phase}`}
              style={{
                border: '1px solid #d0d0d0',
                borderRadius: 12,
                padding: '2px 8px',
                fontSize: 12,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Avatar name={displayNameOf(m)} />
              {displayNameOf(m)}
              {m.role === 'lead' ? ' (lead)' : ''}
            </li>
          ))}
        </ul>
      </section>
      <section style={{ flex: 1, minHeight: 0 }}>
        <h4 style={{ margin: '0 0 6px' }}>{t('messages')}</h4>
        {messages.length === 0 ? (
          <div style={{ color: '#888', fontSize: 12 }}>{t('empty')}</div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {messages.map((m) => {
              const model = renderMessage(m, knownNames, leadName)
              return (
                <li
                  key={m.id}
                  style={{ border: '1px solid #e0e0e0', borderRadius: 6, padding: '6px 8px', fontSize: 13 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Avatar name={model.senderName} />
                    <strong style={{ fontSize: 12, fontWeight: 600 }}>{model.senderName}</strong>
                    {m.topic === undefined ? null : (
                      <span style={{ fontSize: 11, color: '#888' }}>· {m.topic}</span>
                    )}
                  </div>
                  <div style={{ lineHeight: 1.5 }}>
                    {model.leading.map((seg, i) => (
                      <Chip key={`l${i}`} seg={seg} />
                    ))}
                    {model.leading.length > 0 ? ' ' : null}
                    {model.body.map((seg, i) => (
                      <Chip key={`b${i}`} seg={seg} />
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
