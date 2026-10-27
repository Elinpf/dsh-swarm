# @elinpf/dsh-swarm-team-prompt

团队段落装配插件：把团队策略/角色/下发/入站标签注册为**稳定 section**（进系统提示词前缀），
把身份/roster/团队信息注册为 **cache-safe context**（不进前缀，作为用户消息侧快照）。
函数式插件（只注册贡献，无新服务），只从契约包取类型（ADR-0001）。

## 稳定段（进前缀）与顺序

| order | 段名              | 说明                                      |
| ----- | ----------------- | ----------------------------------------- |
| 10    | `team:leader`     | **Leader 专属行为约束**（P54，见下）      |
| 11    | `team:role`       | 团队角色（通用）                          |
| 15    | `team:dispatch`   | 任务下发（含 leader 等待模型 event-wake） |
| 16    | `team:task-state` | 任务状态流转                              |
| 18    | `team:inbound`    | 入站消息标签说明                          |

cache-safe context（不进前缀）：`team:identity` / `team:roster` / `team:info`。

## 渐进披露

`leaderProgressiveDisclosure=true`（默认）时，在**团队尚未建成**（还没出现 teammate 成员）前，
把协作约定两段 `team:dispatch` / `team:task-state` 从装配结果里摘掉，避免 Lead 在单 agent 阶段
被无用的协作指南占预算（对照 T7 F_76）。

> ⚠️ **`team:leader` 刻意不在被摘名单里**：它承载「Leader 只调度不干活」的身份约束，
> 必须在团队未建时也留在前缀——那正是最需要它的时刻。若把它放进会被过滤的 `team:dispatch`，
> 约束会在最需要时被静默藏掉（P53 结论）。

## P54 行为变更说明（默认提示词变更 — 行为引导）

**变更内容**：新增 `team:leader` 段，移植/改写自 JiuwenSwarm 的 Leader 硬约束：

1. **负向禁令**：你不亲自执行任务；点名「不要自己查资料 / 读代码 / 写报告」
   （对齐 `openjiuwen/.../cn/leader_bootstrap.md:1`、`cn/leader_policy.md:21`）。
2. **起手动作**：先 `spawn_teammate` + `team_task_create`，成员先于任务存在
   （对齐 `cn/leader_bootstrap.md:4` 的强制 `build_team` 起手）。
3. **背景不清先建专职调研成员**：不要自己去查
   （对齐 `cn/leader_workflow.md:6-7` + `cn/leader_policy.md:22,24`）。

**为什么**：DSH swarm preset 的 persona 仍是通用「You are a coding agent…」
（`packages/bundle/presets/swarm.patch.yml:15`），且原生 `team:policy`
（`tool-agent-team/src/index.ts:34-42`）只讲机制、不含"leader 不该自己做"的约束。
实测（用户截图）：leader 面对可自行完成的请求时默认自己做（自己去搜），未先派成员。
本段以负向禁令 + 起手动作直接纠正该默认倾向。详见 `docs/prompt-comparison-team-mode.md`（P53）。

**语种**：随 `locales`（cn/en）双语；段为全局注册，以条件主语
「如果你是本团队的 Team Lead（lead）」保证语义只对 lead 生效。

## 验证

- 单测 `tests/team-prompt.spec.ts`（含新段存在/内容、**不被渐进披露过滤**、英文变体）。
- 集成测 `tests/team-prompt.integration.spec.ts`：用**真实 `@deepseek-ai/dsh-system-prompt`**
  装配 + `renderPrompt`，断言 `team:leader` 确实进入渲染后的提示词、且团队未建时不被过滤。
- **真实 profile 行为探针（headless + 真实模型，先红后绿）**：纯用户请求
  「收集一下最近最新的 AI 相关近况，给我一份简报。」下，leader 的工具序列为
  `... list_agents → spawn_teammate×4 → team_task_create×5 → send_message...`，
  **先派成员、成员先于任务、全程未调用 `web_search`**（对齐并修复用户截图反例）。
  详见 `docs/verification.md` §P54-E。

```console
$ pnpm --filter @elinpf/dsh-swarm-team-prompt test
$ pnpm --filter @elinpf/dsh-swarm-team-prompt typecheck
```

## 待办（P53 中/低优先级，本轮未做）

> 出处：`docs/prompt-comparison-team-mode.md` §4。经评审后再排期。

- [ ] （中）兜底禁令：「没有合适的人就造一个——任务不允许因'没人适合'停滞，更不允许由你自己动手」。
- [ ] （中）汇总收口：「复杂产物由独立汇总成员整合成稿，你只读结论并汇报」。
- [ ] （中）任务状态段补 `planned`（计划闸）/ `in_review`（评审闸）语义（对齐 `team-core` 叠加态）。
- [ ] （中）验收规则：「成员汇报后你亲自审阅，必要时要求返工」。
- [ ] （低-中）广播成本警示：「优先单播；广播会唤醒全体成员各跑一轮，慎用」。
- [ ] （低）响应节奏：「成员 idle 是正常状态，不要催促或重发启动消息」。
- [ ] （低）接管引导：「先 `list_agents` 看名册，别重复建成员」。
- [ ] （待定，需先报）`swarm.patch.yml:15` persona 从「coding agent」调整为团队 Lead 语境——**须先报 team-leader**（bundle 归属他人）。
