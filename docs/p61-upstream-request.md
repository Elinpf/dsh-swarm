# P61 上游改进请求（文档交付，**未外发**）

> 产出人：dsh-target-analyst　时间：2026-10-27
> 授权：team-leader（P61）。**状态：仓库内文本交付物**——是否提交至 DSH 上游 issue/PR 由用户决定，本文件不代为外发。
> 关联：`client/chat-fold/`（护栏资产）、`docs/p61-upstream-request.md`（本文件）。

---

## 背景

集群/团队会话中，正文被反复出现的「非人类触发卡」刷屏：`turn-trigger` 节点（"收到任务消息" / "子任务状态更新"）及其每 turn 的 "已完成，用时 X 秒" 头行。我们希望**只收口"团队来源"的触发卡**（`source.kind ∈ {agent-message, subagent-settled, team-message}`），而**完整保留**其它触发种类（request/goal/webhook/schedule/job/plugin…）、assistant 消息、交付卡、以及**最后/当前 turn 的终态答复**。

## 当前为何做不到（第三方 client 插件视角）

1. **keyed shadow 是整格替换、无逐节点弃权**：`conversation.chat.node` 为 keyed slot；shadow 取每 cell（同 `key`）"首个 live 条目、priority 升序最低渲染"（`ui-slots/src/index.ts:1340-1371`、`:1136-1143`）。顶掉 `key:'turn-trigger'` 即**接管全部种类** → 须忠实重绘（回归风险）。keyed **无** `select` 弃权（只有 chain 有）。
2. **内置渲染器未公共导出、无法委派**：`TurnTriggerNodeView` 不在 `@deepseek-ai/dsh-client-ui-chat/client` 公共入口（该入口仅 `export {apply,inject}` + 类型）；外部包**只 `import type`**（无运行时委派先例）→ 无法把非团队种类**委派**回内置。
3. **分组所需的有序节点列表对 node 视图无出口**：node 视图只收到自己的 node；`ChatStoreState` 仅暴露 `{turnProcesses}`（`contract/store.ts:15-18`）；`conversation.chat.flow` 为 `single` 且 ui-chat 独占（`apply.ts:215-216,235`）→ 无法计算"连续 run"。
4. 顺带：`presentation-policy`（`ui-chat/transcriptView` 等）**折不到** trigger 卡——trigger 渲染在 whole-Turn disclosure **之上**（`TurnTriggerNodeView.tsx:36`），不在任何策略字段控制内。

唯一"绕道"是对 ui-chat 源码的**未公开深源导入**（`@deepseek-ai/dsh-client-ui-chat/src/...`）——fragile、无先例，**不宜作为产品方案**。

## 诉求（二选一即可安全实现"仅团队卡收口"）

- **(a)** 公共导出内置 trigger 渲染器（或一个 node-renderer 契约），使覆盖实现可**委派**非团队种类、只变换团队种类；**或**
- **(b)** 提供受支持的 **team-only 装饰/分组出口**——例如在 `turn-trigger` kind 上提供一个装饰子 slot，和/或把**有序的 transcript 节点键**暴露给 node 视图，供插件计算 run。

## 建议 issue 正文（可复制）

> **Title**: Expose a supported way to compact only "team-source" `turn-trigger` cards in the transcript
>
> **Body**: In a team/swarm session the transcript fills with repeated non-human trigger cards (`turn-trigger`, e.g. "收到任务消息"/"子任务状态更新") and their per-turn "已完成，用时 X 秒" headers, making the conversation hard to read. We want to compact **only** the team-source triggers (`source.kind ∈ {agent-message, subagent-settled, team-message}`) while leaving every other trigger kind, assistant messages, deliverables, and the final answer turn untouched. This is not achievable from a third-party client plugin today: (1) `conversation.chat.node` is a keyed slot whose shadowing is whole-cell winner-takes-all, so taking over `key:'turn-trigger'` makes us own **all** trigger kinds, and keyed entries have no per-node abstain/select; (2) the built-in `TurnTriggerNodeView` is not exported from `@deepseek-ai/dsh-client-ui-chat/client` (types only), so we cannot delegate non-team kinds to it; (3) grouping consecutive triggers needs the ordered node list, which a node view does not receive (`ChatStoreState` exposes only `turnProcesses`; `conversation.chat.flow` is single and ui-chat-owned). Ask (either is enough): **(a)** publicly export the built-in trigger renderer (or a node-renderer contract) enabling delegate-style overrides; **or (b)** provide a supported team-only decoration/grouping outlet (a decoration child slot on the `turn-trigger` kind, and/or expose ordered transcript node keys to node views).

## 证据清单（文件:行）

- `packages/client/ui-chat/src/client/chat/register-node-renderers.ts:47` — 内置 `{name:'conversation.chat.node', key:'turn-trigger', locale}`（无 children 装饰位）。
- `packages/client/ui-slots/src/index.ts:1340-1371` / `:1136-1143` — keyed shadow 语义（最低渲染；无逐节点弃权）。
- `packages/client/ui-chat/src/client/index.ts` — 公共 `./client` 入口未导出 `TurnTriggerNodeView`。
- `packages/client/ui-chat/src/client/apply.ts:215-216,235` — `conversation.chat.flow` single + `store: chatStore`。
- `packages/client/ui-chat/src/client/contract/store.ts:15-18` — `ChatStoreState = { turnProcesses }`。
- `packages/client/ui-chat/src/client/chat/TurnTriggerNodeView.tsx:36` — trigger 在 whole-Turn disclosure 之上。
- 外部消费方仅 `import type`：`packages/client/ui-workflow-run/src/client/index.ts:6`、`packages/client/ui-deliverables/src/client/Deliverables.tsx:3`、`packages/client/ui-trajectory/tests/views.client.spec.tsx:23`。

## 我们保留的资产（上游一旦支持即可复用）

- `client/chat-fold/src/client/fold-core.ts` + `tests/fold-core.spec.ts`：纯逻辑护栏 + **9/9 单测**（`pnpm exec vitest run client/chat-fold/tests/fold-core.spec.ts`）。
