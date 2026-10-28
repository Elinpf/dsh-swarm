# P76 任务写路径收口方案（原生 `team_task_*` 绕过 `team-core`）

> 产出人：dsh-plugin-dev-2 ｜ 任务：P76-task-write-path-spec ｜ **阶段 1 = 只出方案，不改码（0 token）**
> 触发：P74 profile 探针（`docs/verification.md §N.1`）证明 **B2 硬闸被绕过**。

## 0. 事实（已验）

- 原生 `@deepseek-ai/dsh-experimental-tool-agent-team` 提供 4 个任务工具：**`team_task_create` / `team_task_list` / `team_task_get` / `team_task_update`**（源码 `tool-agent-team/src/index.ts:299/323/355/370`）。
- 它们**直接写 native `agentTeams`**（journal→session），**不经 `team-core`**。
- 我们的约束（**B2 硬闸 `TEAMCORE_REVIEW_REQUIRED`**、**P30 计划闸**、review 叠加态）**活在 `team-core`**（`packages/team-core/src/index.ts` 的 `reviewing` 叠加 + updateTask 分支）；只有**我们的工具**（`tool-swarm` 的 `review_submit`/`review_vote`）经 `team-core`。
- ⇒ **原生任务工具可绕过 team-core 的一切约束**（P74 探针实证：`review_submit → in_review` 后，`team_task_update complete` 仍 `completed`）。

## 1. 收口手段（推荐 = (a) 主 + (c) 过渡）

| 手段 | 说明 | 可行性 | 代价 |
|---|---|---|---|
| **(a) 自建任务工具集 + preset disable 原生** | 新包（或并入 `tool-swarm`）实现 `team_task_create/list/get/update`，**全部经 `ctx.teamCore`**；preset/bundle **disabled 原生 4 行** + 启用我们的 | **可行·推荐** | 工具数**净增≈0**（原生 4 被 disable，新增 4 替代） |
| (b) 原生工具转发/经过 team-core | 让原生工具改走 team-core | **不可行**：那是**上游**插件（非我们代码），需改 DSH 上游 | — |
| (c) 仅提示词约束 | 提示 leader「不要用原生任务工具」 | 弱、**可绕过** | 仅过渡，不能作为收口 |

## 2. 若选 (a)：新增 / 兼容 / 代价

- **新增**：`team_task_create / list / get / update` 4 个工具（落点建议 **并入 `tool-swarm`** 或新包 `@elinpf/dsh-swarm-tool-task`，二选一）。
- **动作对齐**：`team_task_update(action=…)` **复用 `team-core.updateTask` 现有动作集**（`claim/release/assign/complete/reopen/set_dependencies/submit_review/reject_review/edit/delete` + `plan-*`）；参数（`task_id/expected_revision/action/owner/…`）与返回 schema **尽量对齐原生**，降低迁移摩擦。
- **兼容**：`review_submit/review_vote` 已在 `tool-swarm`；新 task_update 经 `team-core` ⇒ **B2/P30/review 叠加态生效**（这正是收口目的）。
- **代价/风险**：
  - 工具数 **净增≈0**（disable 原生 4 + 新增 4）；每轮输入 **基本持平**（不叠加）。
  - 风险：① 参数/返回与原生有差异 → 迁移摩擦；② 需 e2e 回归确认 **disable 原生 4 行后无「工具缺失/重复 id」**；③ 与 P49（multicast name→id）**无关**（本任务只做 task 工具）。

## 3. 与现有结论的边界

- **不改 P42**：新工具**只转发** `team-core`，`assign` 语义原样。
- **不破坏 P51**：未读闸走 `send` 路径，本任务不动。
- **不重复 P49**：只做任务工具，不碰 `multicast` name→id。

## 4. 实施落点归属（关键）

- **属我（授权内）**：新任务工具实现 + 单测（`tool-swarm` 增量或新包）。
- **属 dev/bundle/preset（须报 leader，不擅动）**：**preset/bundle 里 `disabled: true` 原生 4 行 + 启用我们的工具**（`packages/bundle/cordis.patch.yml` 属 P44/dev 地盘；preset 亦然）。⇒ **建议 leader 另立「收口接线」任务给 dev 或授权我动 bundle/preset**。

## 5. 若暂不做（如实登记）

在 `docs/verification.md` / `README` 标注**已知限制**：

> **【已知可绕过】** 原生 `team_task_create/list/get/update` **不经 `team-core`** ⇒ 我们的 **B2 硬闸 / P74 验收闸 / P30 计划闸**在真实使用中**可被绕过**（探针 §N.1）。**解锁条件**：采 (a) 收口（自建任务工具 + preset disable 原生）落地，或在 preset 禁用原生任务工具。**仅调 `tool-swarm.enableReview` 默认值不解决**。

## 6. 结论（三句话）

1. **推荐 (a)**：自建任务工具集（全走 `team-core`）+ preset disable 原生 4 个任务工具；(b) 不可行（上游），(c) 仅过渡。
2. **代价低**：工具数净增≈0、每轮输入基本持平；主要风险是迁移摩擦与「disable 后回归」。
3. **落点分界**：工具实现=我；**preset/bundle 接线=dev/P44 地盘，报 leader 裁决**；不采则按 §5 登记「已知可绕过」+解锁条件。
