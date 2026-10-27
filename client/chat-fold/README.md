# @elinpf/dsh-swarm-chat-fold（P61）

会话正文里「团队状态卡」收口的**护栏核心 + 单测**。

## 状态：**A（正文侧覆盖收口）待上游，非放弃**

- 方案 A（覆盖 `conversation.chat.node` 的 `turn-trigger`，G2 连续成组）经 spike 判定**在当前 DSH 0.2.1-rc.3 上不可安全实现**：keyed shadow 是整格替换（无逐节点弃权）、内置 `TurnTriggerNodeView` 未公共导出（无法委派非团队种类）、且分组所需的有序节点列表对 node 视图无出口。→ 详见 `team-workspace/p61-spike-conclusion.md`。
- 已向上游提出诉求（导出内置渲染器 **或** 给 team-only 装饰/分组出口）：见 `team-workspace/p61-upstream-issue.md`。
- **一旦上游提供上述任一出口，本包的 `fold-core` 可直接复用来实现 G2。**

## 本包内容

- `src/client/fold-core.ts`：**纯逻辑**（无 React/DSH 依赖）——`isTeamTriggerKind` / `isFoldable` / `foldRuns`，实现 §5 四条硬护栏：
  ① 只折团队来源（`agent-message`/`subagent-settled`/`team-message`）；
  ② 永不折当前/最后 turn（且末 turn 会**打断** run）；
  ③ `turn-process` 折叠（二期）仅当前驱被折——本期不涉及；
  ④ 不确定即不折（fail-open）。
- `tests/fold-core.spec.ts`：**9 条护栏单测（全绿）**。

## 运行单测

```sh
# 在 dsh-swarm 仓库根
pnpm exec vitest run client/chat-fold/tests/fold-core.spec.ts
```

> 本包**不在 pnpm workspace**（glob 为 `packages/*`，本目录在顶层 `client/`），故**不影响 `pnpm -r build`**。
