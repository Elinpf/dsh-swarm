/**
 * 阶段 3 · 人类成员席位端口类型（`ctx.teamHuman`）。
 *
 * 语义（spec §4.4）：让人类以**成员身份**进团队 roster、收发团队消息，并把宿主/Web 入站文本
 * 映射为投递语义（HITT）。人类**不跑 agent loop**，其 inbox 由宿主桥接面喂入。
 *
 * @module @elinpf/dsh-swarm-team-scale-contract
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamHuman: TeamHuman
  }
}

/** 人类席位类型：控制者（驱动团队的人）/ 受委托的用户（外部真人）。 */
export type HumanSeatKind = 'controller' | 'user'

/** HITT 来源标签（对齐源系统入站标签体系）。 */
export type HittOrigin = 'user' | 'controller'

export interface HumanSeat {
  seatId: string
  name: string
  kind: HumanSeatKind
  /** 宿主/前端是否有在线连接（离线席位消息保留待补投）。 */
  reachable: boolean
}

/** 出站到人类席位的消息封包（带 HITT 标签）。 */
export interface HumanOutbound {
  seatId: string
  from: HittOrigin | 'team'
  /** `for="controller"` 语义：该消息只应展示给控制者。 */
  for?: 'controller'
  content: unknown[]
}

export interface TeamHuman {
  seats(): HumanSeat[]
  /** 让一个人类以成员身份加入 roster。 */
  addSeat(caller: Agent, spec: { name: string; kind: HumanSeatKind }): Promise<HumanSeat>
  /** 宿主/Web 入站文本 → 投递语义（mention/channel 解析，见 spec §4.4）。 */
  inbound(seatId: string, text: string): Promise<{ target: string; delivered: boolean }>
  /** 团队消息 → 人类席位（有人在线则送达，离线则标记未达并保留待补投）。 */
  deliver(seatId: string, content: unknown[]): Promise<{ delivered: boolean }>
  /** 向人类发起阻塞式询问（复用 `ctx.userQuestions.ask`）。 */
  ask(seatId: string, question: string, signal?: AbortSignal): Promise<{ answer: string }>
}
