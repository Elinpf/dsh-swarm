/**
 * The team chat tab body: the Lead Session's live roster plus the group-chat
 * message stream (broadcast / multicast) folded by the server-side `swarmBus`
 * Session projection (and the native `agentTeam` projection for the roster).
 *
 * Both projections reach the browser through the shared Session store
 * (`state.projectionsBySession[sessionId].values.<key>`), so this body performs
 * no RPC — it only reads. A teammate tab resolves its Lead by the same
 * `subagent.address.parentSessionId` fallback the shipped Agent Teams UI uses.
 *
 * NOTE (env-limited): written against the 0.2.1-rc.3 client APIs mirroring
 * `@deepseek-ai/dsh-experimental-client-ui-agent-team`; load-verified in the
 * demo, but not covered by an automated browser assertion in this environment.
 */
import { useMemo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NS } from './locales.ts'

/** Full props of the team chat tab body. */
export type TeamChatTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS>

interface MemberRow {
  id: string
  name: string
  role: string
  phase: string
}

interface ChatMessage {
  id: string
  kind: 'broadcast' | 'multicast' | 'dm'
  senderName?: string
  topic?: string
  content?: ReadonlyArray<{ type?: string; text?: string }>
  targets?: readonly string[]
}

function textOf(message: ChatMessage): string {
  const blocks = message.content ?? []
  return blocks
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim()
}

/** Render the roster and the folded group-chat message stream. */
export function TeamChatTab(props: TeamChatTabProps): JSX.Element {
  // Namespace-bound translate; widened so key literals resolve regardless of how
  // PropsLocale derives its key union in this build.
  const t = props.t as unknown as (key: 'title' | 'roster' | 'messages' | 'empty') => string
  // The slot runtime exposes the shared Session store hooks; read defensively.
  const runtime = props as unknown as {
    sessionId?: SessionId
    useSession?: (
      selector: (snapshot: {
        subagent?: { address?: { parentSessionId?: SessionId } }
      }) => SessionId | undefined,
    ) => SessionId | undefined
    useSessions?: (
      selector: (state: {
        projectionsBySession?: Record<string, { values?: Record<string, unknown> }>
      }) => unknown,
    ) => unknown
  }
  const leadId = (runtime.useSession?.((s) => s.subagent?.address?.parentSessionId) ??
    runtime.sessionId) as SessionId | undefined

  const team = runtime.useSessions?.((state) =>
    leadId === undefined ? undefined : state.projectionsBySession?.[leadId]?.values?.['agentTeam'],
  ) as { members?: MemberRow[] } | undefined

  const bus = runtime.useSessions?.((state) =>
    leadId === undefined ? undefined : state.projectionsBySession?.[leadId]?.values?.['swarmBus'],
  ) as { messages?: ChatMessage[] } | undefined

  const members = team?.members ?? []
  const messages = useMemo(() => (bus?.messages ?? []).slice().reverse(), [bus?.messages])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 10,
        overflow: 'auto',
        height: '100%',
      }}
    >
      <section>
        <h4 style={{ margin: '0 0 6px' }}>{t('roster')}</h4>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
          }}
        >
          {members.map((m) => (
            <li
              key={m.id}
              title={`${m.role} · ${m.phase}`}
              style={{
                border: '1px solid #d0d0d0',
                borderRadius: 12,
                padding: '2px 8px',
                fontSize: 12,
              }}
            >
              {m.name}
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
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {messages.map((m) => (
              <li
                key={m.id}
                style={{
                  border: '1px solid #e0e0e0',
                  borderRadius: 6,
                  padding: '4px 8px',
                  fontSize: 13,
                }}
              >
                <div style={{ fontSize: 11, color: '#666' }}>
                  {m.senderName}
                  {m.topic === undefined ? '' : ` · ${m.topic}`}
                  {m.kind === 'multicast' && m.targets !== undefined
                    ? ` → ${m.targets.join(', ')}`
                    : ''}
                </div>
                <div>{textOf(m)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
