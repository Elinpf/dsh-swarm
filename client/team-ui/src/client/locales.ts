/** Copy namespace for the dsh-swarm team chat panel. */
export const NS = 'dshSwarmTeamUi'

export interface TeamKey {
  title: string
  roster: string
  messages: string
  empty: string
}

export const zh: TeamKey = {
  title: '群聊',
  roster: '成员',
  messages: '消息（广播 / 私信）',
  empty: '暂无消息',
}

export const en: TeamKey = {
  title: 'Team chat',
  roster: 'Members',
  messages: 'Messages (broadcast / multicast)',
  empty: 'No messages yet',
}
