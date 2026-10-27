# 跨包一致性审计（P40）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 方式：**只读机械核对**（命令 + 原始输出），改动仅限声明性文件。
> 目的：19 个包几乎全并行加出，交付前整体核对「拼在一起是否自洽」。

## 结论速览

| # | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 包名与作用域 | ✅ PASS | 全部 `@elinpf/dsh-swarm-*` |
| 2 | 可发布性 | ✅ PASS | `pnpm -r publish --dry-run` → **19 包**（example-plugin 私有被排除） |
| 3 | bundle patch 一致性 | ✅ PASS | insert **14 行 = 恰好 14 个插件**，无遗漏/多余/重复 |
| 4 | 事件契约一致性 | ⚠️ **1 处文档不一致** | 命名风格统一；但 ADR-0002 §3 事件表**未含阶段 3 / P31 新增事件** |
| 5 | 依赖图与分层 | ✅ PASS | 各包只依赖契约包（+ `team-durable`），**无插件间依赖、无循环** |
| 6 | 配置默认值三处一致 | ✅ PASS（1 处轻微） | `mode=autonomous`、`planGate=false` 源码/README 一致；bundle 未显式列 `planGate` |

**发现的不一致：2 条**（1 中·文档、1 低·文档）。**无行为语义性问题**（未发现有真 bug）。

---

## 1. 包名与作用域 — ✅ PASS

`packages/*/package.json` 全部 `@elinpf/dsh-swarm-*`（20 个包）：

```
bundle, example-plugin, team-bus, team-capability-contract, team-compaction, team-completion,
team-core, team-core-contract, team-distributed, team-durable, team-human, team-memory,
team-prompt, team-review, team-scale-contract, team-scheduler, team-skills, team-transport,
team-workspace, tool-swarm
```

无漏改、无遗留 `@dsh-swarm/*` 旧 scope。

## 2. 可发布性 — ✅ PASS

- **`pnpm -r publish --dry-run --no-git-checks` → exit 0，列出 19 个包**（= 20 目录 − `example-plugin`（`private:true`，有意私有））。
- 19 包均 `publishConfig.access=public`；`files` 白名单含 `lib`（`transport` 另含 `relay`、`bundle` 另含 `cordis.patch.yml`），**不含 `src`/`tests`**。
- 无「无 `publishConfig`/泄漏 src」的可发布障碍。

## 3. bundle patch 与实际包清单一致性 — ✅ PASS（重点项）

`packages/bundle/cordis.patch.yml` 的 `insert` 行（14）：`team-core` · `team-prompt` · `team-bus` · `team-review` · `team-scheduler` · `team-completion` · `tool-swarm` · `team-workspace` · `team-skills` · `team-memory` · `team-compaction` · `team-transport` · `team-distributed` · `team-human`。

对照「应有插件」= 20 目录 − 3 契约包 − `bundle` − `example-plugin` − `team-durable`（运行时助手，非插件） = **14** → **恰好一致**，无遗漏/多余/重复。
`disabled: true` 4 行（`tool-subagent` / `-control` / `-list-agents` / `-fork`）仍在，正确。

## 4. 事件契约一致性 — ⚠️ 1 处文档不一致

`swarm/*` 全部事件（grep 实测）命名风格统一为 `swarm/<domain>/<event>`，域：`bus/completion/core/distributed/human/member/memory/review/skills/task/team/transport`。

- **同义异名 / 同名异义**：未发现。`swarm/core/review-*`（叠加态出入）与 `swarm/review/*`（轮次/票/裁决）语义分明；`swarm/team/completed`（团队完成）与 `swarm/task/terminal`（任务终态，P31）分明。`swarm/task/plan-request` 用于 `open_plan` 与 `submit_plan`（同一语义「计划请求」），可接受。
- **ADR-0002 符合性**：P30 新增的 `swarm/task/{plan-request,plan-response,revision-requested}` 已补入 ADR-0002 §3，且各带 `recover` fold + 恢复测试 ✅。**但**：`swarm/task/{released,revoked,unblocked,list-drained,terminal}`、`swarm/member/status-changed`、`swarm/transport/peer`、`swarm/distributed/*`、`swarm/human/*`（阶段 3 / P31 新增，非本包）**未出现在 ADR-0002 §3 事件表**。

## 5. 依赖图与分层 — ✅ PASS

各包 `dependencies` 中的 `@elinpf/*`（grep 实测）**只指向契约包**（`team-core-contract` / `team-capability-contract` / `team-scale-contract`）**或 `team-durable`**；**无任何插件依赖另一个插件的实现包**。契约包与 `team-durable` 无 `@elinpf` 依赖 → **无循环**。`bundle` 依赖全部 14 插件 + `team-scale-contract`（正常，组合层）。三个契约包边界仍被遵守（消费方只经端口类型）。

> 说明：`team-durable` 是被 6 个包复用的**运行时助手**（ADR-0002 §4），非契约包也非插件；它被依赖是设计使然。

## 6. 配置默认值一致性 — ✅ PASS（1 处轻微）

| 默认值 | 源码 | bundle patch | README | 一致 |
|---|---|---|---|---|
| `team-scheduler.mode` | `'autonomous'`（`team-scheduler/src/index.ts:515`） | `mode: autonomous` | §253 明示「默认仍 autonomous」 | ✅ |
| `team-core.planGate` | `false`（`team-core/src/index.ts:121`） | **未显式列出**（依赖默认） | 「默认 `false`」 | ✅（见不一致 #2） |
| `team-scheduler.pollMs` | `30000` | `pollMs: 30000` | — | ✅ |

---

## 不一致清单（按严重程度排序）

### 🟡 #1（中·文档）ADR-0002 §3 事件表未覆盖阶段 3 / P31 新增事件

- **现象**：实际发射的 `swarm/task/{released,revoked,unblocked,list-drained,terminal}`、`swarm/member/status-changed`、`swarm/transport/peer`、`swarm/distributed/*`、`swarm/human/*` 不在 `docs/adr/0002-durable-state-convention.md §3` 事件表内。
- **影响**：ADR-0002 是「跨包事件契约的冻结 SSOT」；后来人若照 ADR §3 核对，会漏掉这批事件或误以为它们不合规。
- **建议修法**：把这些事件补入 ADR-0002 §3（或注明「阶段 3 / P31 事件见各自设计文档」）。
- **为何**不[自行修]：这些事件**属 dev-2 的阶段 3 / P31 包**（本审计只读他人包）；其「是否 durable / 是否需要 fold」需其作者确认，**属跨人契约语义**——按纪律**报 Leader 裁决**，不擅自替他人定契约。

### 🟢 #2（低·文档）bundle 未显式声明 `team-core.planGate: false`

- **现象**：`team-core` 的 `planGate` 默认 `false`（源码），但 bundle patch 的 `team-core.config` 未显式列出。
- **影响**：可读性/防漂移——将来若改源码默认，bundle 无对照点。
- **建议修法**：在 bundle `team-core.config` 显式加 `planGate: false`（纯声明，语义不变）。
- **处置**：✅ **已修**（改前 `git status` 确认 `bundle/cordis.patch.yml` 干净、无并发冲突）——在 `team-core.config` 显式加 `planGate: false`；`e2e-profile.sh` 复跑 **PASS=7 FAIL=0** 无回归。

---

## 已修 / 待裁

- **已修**：#2（bundle 显式 `planGate: false`，声明性、无并发冲突、e2e-profile 无回归）。
- **待 Leader 裁**：#1（ADR-0002 §3 补列阶段 3 / P31 事件）——**涉及他人事件契约语义**，按纪律报 Leader，不擅自替他人定。
- **未发现行为语义性不一致 / 真 bug**。
