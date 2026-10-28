# `enableReview:true` 的「无 reviewer 放行 / leader 兜底」设计（只设计，暂不开）

> 产出人：dsh-plugin-dev-2 ｜ 触发：Leader 令「先设计先报，拍板后才动」。**0 token，未改代码。**

## 0. 现状（读码事实）

- **评审门只在配置了 `pools` 时生效**：`team-review.submitForReview` 若 `config.pools.length===0` → **直接 complete（无门）**（`team-review/src/index.ts:120-125`）。
- 有 `pools` 时：`submit_review` 令任务 `in_progress→in_review`（`team-core:456`），`team-core` 对 `in_review` 期间**直接 `complete` 硬拒**（`TEAMCORE_REVIEW_REQUIRED`，`:500-506`）——完成**唯一合法出口**是 `team-review.settle(pass)` → `completeAfterReview`（**B2 已实装**）。
- 投票：**作者不可自验**（`TEAMREVIEW_SELF_VOTE`，`:152`）。`adjudicate`（`:323`）：**池内每个 role 都投过才算 complete**；未投齐 → **`undecided`（不放行）**；veto 池任一 `fail` → `fail`。
- 卡住处理：`checkStall`（`:239`）超 `stallTimeoutMs` → **只** `escalate`（DM leader inbox + `swarm/review/escalated` 事件，**B4 有界升级**），**不自动放行**。

## 1. 四个问题的答案

**Q1｜开闸后是否所有任务都强制 `review_submit` 才能 `complete`？**
**否。** 两道前提：① 配置了非空 `pools`（否则 `submitForReview` 直接放行、无门）；② 调用方确实走了 `submit_review`。仅当任务**已进入 `in_review`** 时，直接 `complete` 才被硬拒。⇒ 门是「**进入评审态后**不可绕过」，不是「全体任务强制送审」。

**Q2｜单成员 / 无可用 reviewer 会不会卡死？判定条件？**
**会卡死（undecided 永久）。** 判定条件：对某任务，
`∃ pool` 使其 `roles` 集合中，**除任务作者外**没有任何可投票成员（含 leader 在池内但 leader=作者的情况）。
则该 pool 的 roles 永远投不齐 ⇒ `adjudicate=undecided` ⇒ 任务停在 `in_review`；`stallTimeoutMs` 后**仅升级通知**，**任务不解除**。

**Q3｜兜底谁做？推荐 + 代价**
推荐 **两级兜底（可配）**：
- **(A) leader 兜底（首选）**：若 leader **不是**该任务作者 → 允许 leader 以池内 role 投票，投齐即 settle（pass/fail 由 leader 判）。
- **(B) 超时自动放行（留痕，次选）**：若 leader **恰为作者**（连 leader 都无法补位）→ 超时后按策略 **`auto-pass` 并记录**：发 `swarm/review/auto-passed`（durable，含 `taskId/round/reason:'no-eligible-reviewer'/'stall'`）+ 任务 complete。
  - 备选：超时只 **escalate 到人**（更保守，但会真卡）。
- **不推荐**「无条件直接放行」（等于无门）。
**代价**：leader 既派又验 ⇒ 削弱「不可自验」强度（但**作者不可自验仍是硬约束**，leader≠作者时才兜底）；auto-pass 会**用留痕换取不卡死**（可审计、可回溯）。

**Q4｜与其它机制的关系 / `open_plan` 是否同批开**
- **P51 未读/兜底**：属**消息层**（未读台账、超时重投），与本评审门**正交**，无冲突。
- **P30 计划闸**（`planGate`/`open_plan`）：同属「执行前/完成前门禁」，但**语义不同**（计划审批 vs 验收裁决）；`planGate:false` 且 `open_plan` 未暴露（**已知缺口**）。
- **P74 B1/B2/B4**：**B2**=评审唯一完成出口（已实装）；**B4**=有界升级（已实装）；**本设计正是为 B2 补「无 eligible reviewer」出口**，与之**互补不冲突**。
- **`open_plan` 是否同批打开**：**建议分开**（不同门、不同风险）；先稳妥把 **review 兜底**落地，plan 另评（避免一次动两道门、难定位回归）。

## 2. 影响面

- **不开（现状）**：`pools=[]` 时评审门形同「无门」（submit 直接完成）；一旦配 pools 且无 eligible reviewer ⇒ **可卡死**（仅升级不解除）。
- **开（+ 本兜底）**：任务可「送审→裁决→（无 reviewer 时 leader 兜底 / 超时留痕放行）」，**不卡死**且可审计；代价见 Q3。
- **开关粒度建议**：`enableReview`（总开关）＋ `noReviewerPolicy: 'leader'|'auto-pass'|'escalate-only'`（默认 `leader` 若可行，否则 `auto-pass` 留痕）＋ `reviewStallMs`（复用 `stallTimeoutMs`）。

## 3. 落地清单（**待拍板后才动**；本稿不实现）

1. `team-review`：`noReviewerPolicy` 判定（哪条 pool 缺 eligible reviewer）＋ leader 补位投票入口 / 超时 `auto-pass`（durable 事件留痕）。
2. `team-core`：`completeAfterReview` 之外，为 auto-pass 提供**受控**的完成出口（仍走 team-core，保持「唯一写路径」）。
3. 单测先红后绿：①无 eligible reviewer 现为 `undecided`（红）→ 兜底后 pass（绿）；②leader=作者 → auto-pass 留痕；③有 eligible reviewer → 行为不变。
4. 文档：README/verification 记行为变更与留痕事件。

> **结论（一句话）**：门只对「已进入 in_review」硬；**无 eligible reviewer 会卡死**；推荐 **leader 兜底为主、超时留痕 auto-pass 为底**；与 P51/P30/B2/B4 正交或互补；`open_plan` **建议不同批**。
