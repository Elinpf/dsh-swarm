/** Source-safe browser registration for the dsh-swarm right-Sidebar team chat panel. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { TEAM_CHAT_ID, teamChatDefinition } from './definition.ts'
import { TeamChatTab } from './TeamChatTab.tsx'
import { en, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-swarm team chat panel copy. */
    dshSwarmTeamUi: TeamKey
  }
}

/** Required browser services: slots, navigation controller, tab registry, copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sessions']

/**
 * Register the tab type, its body keyed by the type id, and the copy namespace.
 * @param ctx - Client Context carrying locale, tab registry, and slot services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-swarm-team-ui: dictionaries')
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register(
        teamChatDefinition(ctx.locale.bind(NS) as unknown as (k: 'title' | 'messages') => string),
      ),
    'dsh-swarm-team-ui: tab type',
  )
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: TEAM_CHAT_ID,
        locale: NS,
      },
      TeamChatTab,
    ),
  )
}
