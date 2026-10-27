/**
 * P61 正文团队状态卡「收口」的**纯逻辑核心**（无 React / 无 DSH 依赖，便于单测护栏）。
 *
 * 目标：把会话正文里**连续**的团队来源 `turn-trigger`（收到任务消息 / 子任务状态更新）
 * 折叠为 run 首行的一行聚合，其余渲染 null。
 *
 * **§5 四条硬护栏（team-leader 硬约束）**：
 * ① 只折**团队来源** trigger（`agent-message` / `subagent-settled` / `team-message`）；其它来源不折。
 * ② **永不折当前/最后一个 turn**（承载 leader 终态答复的 turn）。
 * ③ `turn-process` 折叠（二期）仅当其前驱是被折 trigger——本期不涉及。
 * ④ 任何判定不确定 / 字段缺失 → **不折（fail-open）**。
 *
 * @module @elinpf/dsh-swarm-chat-fold/core
 */

/** 认定为「团队来源」的 trigger `source.kind`。 */
export const TEAM_TRIGGER_KINDS = ['agent-message', 'subagent-settled', 'team-message'] as const

/** 是否是团队来源 trigger。 */
export function isTeamTriggerKind(kind: string | undefined): boolean {
  return kind !== undefined && (TEAM_TRIGGER_KINDS as readonly string[]).includes(kind)
}

/** 折叠器看到的一个节点（只取判定所需字段）。 */
export interface FoldNode {
  /** 稳定节点 key（同一 key 唯一）。 */
  readonly key: string
  /** `ContextMessageNode.source.kind`（非 trigger 或不可读时 undefined）。 */
  readonly sourceKind?: string | undefined
  /** 事件时间（毫秒），用于聚合行展示「最后一次 HH:MM」。 */
  readonly time?: number | undefined
  /** 该节点是否属于**当前/最后一个 turn**（护栏②）。 */
  readonly isLastTurn?: boolean | undefined
}

/** 单节点折叠判定。 */
export type FoldDecision =
  /** 不折：原样渲染（原生样式）。 */
  | { readonly kind: 'render' }
  /** 被折、且非 run 首行：渲染 null。 */
  | { readonly kind: 'hidden' }
  /** run 首行：渲染聚合行。 */
  | { readonly kind: 'aggregate'; readonly count: number; readonly lastTime?: number | undefined }

/**
 * 单节点是否「可折」。护栏①②④ 都落在这里；不确定即 false（fail-open）。
 */
export function isFoldable(node: FoldNode): boolean {
  if (node.isLastTurn === true) return false // ② 永不折最后 turn
  if (!isTeamTriggerKind(node.sourceKind)) return false // ① 只折团队来源
  if (typeof node.key !== 'string' || node.key.length === 0) return false // ④ fail-open
  return true
}

/**
 * 对**有序**节点列表计算每节点判定。run = 极长的**连续可折**节点序列。
 * - run 长度 ≥ 2：首行 `aggregate`、其余 `hidden`；
 * - run 长度 == 1：不折（`render`）——不隐藏孤立卡片（也降低误伤）；
 * - 非可折节点：`render`。
 * 不修改入参；返回 key→判定 的 Map（未出现的 key 视为 `render`）。
 */
export function foldRuns(nodes: readonly FoldNode[]): Map<string, FoldDecision> {
  const out = new Map<string, FoldDecision>()
  let i = 0
  while (i < nodes.length) {
    const node = nodes[i]
    if (node === undefined) {
      i += 1
      continue
    }
    if (!isFoldable(node)) {
      out.set(node.key, { kind: 'render' })
      i += 1
      continue
    }
    // 收集一段连续可折 run [i, j)
    let j = i
    let lastTime: number | undefined
    while (j < nodes.length) {
      const c = nodes[j]
      if (c === undefined || !isFoldable(c)) break
      if (typeof c.time === 'number') lastTime = c.time
      j += 1
    }
    const count = j - i
    if (count === 1) {
      out.set(node.key, { kind: 'render' })
    } else {
      out.set(node.key, { kind: 'aggregate', count, ...(lastTime === undefined ? {} : { lastTime }) })
      for (let k = i + 1; k < j; k += 1) {
        const h = nodes[k]
        if (h !== undefined) out.set(h.key, { kind: 'hidden' })
      }
    }
    i = j
  }
  return out
}
