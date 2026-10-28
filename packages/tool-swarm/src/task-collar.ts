/**
 * 任务写路径收口（P78）：把**原生 4 个 `team_task_*` 工具**对所有 agent 置为**不可执行**，
 * 迫使任务写操作只能走我们的 `swarm_task_*`（全经 `team-core`）⇒ B2/P74/P30 闸门**不可绕过**。
 *
 * 为什么用 **root/global `tools.guard`**（而非 restrict、也非 per-agent）：
 * - 原生 `team_task_*` 由 `tool-agent-team` 在**每个 agent 的 scope** 内 `scoped.tools.register`；
 *   `ctx.tools.restrict` 只遮**全局层**工具、对 scoped 注册**打不进**（会抛 unknown global tool）⇒ 弃用 restrict。
 * - `tools.guard` 走**执行期**拒绝；`guardReason` 先查 **global 层**、再查 agent scope 链
 *   ⇒ 在**插件自身（root）ctx** 挂一个 global guard 即**覆盖全体 agent（含 leader）**。
 *   「闸门不能被 leader 绕过」是有意为之，故**有意覆盖 leader**（spike 里「root 连 leader 一起拒」= 期望行为）。
 * - 实证：`.runtime/probe/p78-guard-spike.mjs`、`.runtime/probe/p78-collar-probe.mjs`。
 *
 * 行为边界：
 * - deny 名单**固定为原生名**（`team_task_create/list/get/update`）；P82 改名后与我们的 `swarm_task_*` **不同名**，
 *   故**不误伤**我们的工具，也不误伤 `list_agents`/`wait_agent`/`send_message`/`spawn_*`/`interrupt_agent`。
 * - guard 只**拒绝执行**、不移除可见性（调用被拒并给出清晰原因）。隐藏可见性属另一机制，restrict 打不进，暂不做。
 * - 跨进程：每个进程内 `tool-swarm` 各自加载 ⇒ 各进程各挂一个 global guard，覆盖该进程内全体 agent（含对端驻留成员）。
 *
 * @module @elinpf/dsh-swarm-tool-swarm/task-collar
 */

import type { Context } from '@deepseek-ai/cordis'

/** 原生 `tool-agent-team` 的 4 个任务工具名（收口目标）。 */
export const NATIVE_TASK_TOOLS = [
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
] as const

const NATIVE_TASK_TOOL_SET = new Set<string>(NATIVE_TASK_TOOLS)

/** `tools.guard` 回调收到的执行上下文（只用到 `name`）。 */
interface GuardExec {
  name?: string
}

/** 结构化 seam：`tools` 的 `guard`（不 import 上游类型）。 */
interface ToolsSeam {
  guard(check: (exec: GuardExec) => unknown): () => void
}

/**
 * 安装任务写路径收口：在**插件（root/global）** 层挂一个 guard，拒绝原生 4 个任务工具的执行。
 * **覆盖全体 agent（含 leader）** —— 闸门不可被任何角色绕过。
 * @param ctx - 插件 context（`tool-swarm` 在 bundle 顶层加载 ⇒ 其 guard 落 global 层）。
 * @returns guard 的 disposer。
 */
export function installTaskCollar(ctx: Context): () => void {
  const tools = ctx.get('tools') as ToolsSeam | undefined
  if (typeof tools?.guard !== 'function') return () => {} // 降级：无 tools 时不挂
  return tools.guard((exec) =>
    exec.name !== undefined && NATIVE_TASK_TOOL_SET.has(exec.name)
      ? `native tool "${exec.name}" is disabled in dsh-swarm; use \`swarm_task_*\` instead (team-core-backed, gate-enforcing)`
      : undefined,
  )
}
