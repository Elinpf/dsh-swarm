/** Stage one of the team chat tab type's registration: what it IS (a page type opened by kind). */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** This implementation's identity in the tab system: the key its body registers under. */
export const TEAM_CHAT_ID = '@elinpf/dsh-swarm-team-ui/chat'

/** The tab kind this package owns. */
export const TEAM_CHAT_KIND = 'swarmTeamChat'

/**
 * The team chat type's registry definition.
 *
 * A page type opened by kind. It contributes a **guide entry**, so the right
 * Sidebar's add-control → guide lists it and picking the capsule opens the tab
 * (`ctx.sidebarRight.openTab('swarmTeamChat')`) — this is the panel's entry point.
 * @param t - namespace-bound translate.
 * @returns the definition to register.
 */
export function teamChatDefinition(t: (key: 'title' | 'messages') => string): SidebarRightTabDefinition {
  return {
    id: TEAM_CHAT_ID,
    kind: TEAM_CHAT_KIND,
    priority: 'extension',
    title: () => t('title'),
    guide: [{
      id: TEAM_CHAT_ID,
      order: 20,
      title: () => t('title'),
      description: () => t('messages'),
    }],
  }
}
