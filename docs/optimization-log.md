# 优化日志（optimization-log）

> 负责人：dsh-plugin-dev ｜ 任务：P14-optimize ｜ 时间：2026-10-26 ｜ 项目 `dsh-swarm`
> 输入：`docs/experiments-stage1.md`（P13 差异定位报告，优化候选清单见其 §6）。
> 纪律：**每条优化单独一个 commit；必须用同一套基准做「前/后」复测；没有复测证据的优化不算完成；
> 复测无收益/变差的如实记录并回退。** 基线口径见 `scripts/bench/README.md §3`。

---

## 0. 候选清单复核（先纠偏）

P13 报告 §6 列了 5 条候选。动手前逐条核对现状，发现 **2 条已实现**，避免重复劳动：

| # | 候选 | 现状核实 | 结论 |
|---|---|---|---|
| 1 | 成本核算纳入 teammate | ✅ 已实现：`scripts/bench/` 已有 `teammateActivity`（`bench/README.md §3`） | 无需再做 |
| 5 | 广播「静默/仅信号」档 | ✅ 已实现：`team-bus` 支持 `delivery:'quiet'`（`packages/team-bus/src/index.ts:39/122`） | 无需再做 |
| 2 | 广播改「信号+拉取」 | ⏳ 见 O1 | 落地（opt-in） |
| 3 | 评审期显式 `in_review` | ⏸ 改原生任务枚举语义（影响 scheduler/completion），属可观测行为变更 | 暂缓，待 Leader 授权 |
| 4 | 默认 `scheduled` 自动派发 | ⏸ 改默认配置，属可观测行为变更；`--sched-mode`/`mode` 开关已存在 | 待 Leader 授权 |

> 遵守任务约束「若优化需改变可观测行为，先问 Leader」：O1 设计为**纯 opt-in、默认不变**，故先做；#3/#4 已 `send_message` 请示。

---

## 1. 基线与复现

复现基线（离线桩，零模型成本；与 `docs/benchmark.md §4` 一致）：

```console
$ bash scripts/bench/run.sh --no-model --scenario S1,S2,S3,S4,S5 --repeat 3 --out .runtime/bench/repro-baseline
# S1 投递=1/唤醒=1(direct) ；S2 投递=3/广播=1/fanout唤醒=3/空转唤醒=3
# S5 投递=6/重试=2/stale自催=2 ；S3/S4 结构量一致
```

✅ 与报告基线一致（S1/S2/S5 关键结构量逐一对上）。

---

## 2. O1：广播「信号+拉取」扇出模式（opt-in，默认不变）

### 2.1 证据（来自 P13 报告）
- §2 AB1：`broadcast` 现为「**1 次落库 + N 次 DM 扇出**」，与手动 N 次 DM **投递数零差异**（bus 3 = n-dm 3）。
- §1 C1：对照 JiuwenSwarm 的 `broadcast_message` 为 **O(1) 写**（1 条记录 + 读方轮询）。
- §4 发现 A：对 inactive 成员发 DM **确实消耗 +1 个 LLM 轮**（广播当前对每个非发送者都发 DM）。

→ 目标：让广播可退化为「**1 条记录 + 成员按需拉取**」，消除 O(N) 投递/唤醒放大。

### 2.2 改动（纯 opt-in，默认 `dm` 不变）
- `packages/team-bus/src/index.ts`：
  - `broadcast` 增加可选 `fanout?: 'dm' | 'record-only'`（**默认 `dm` = 现语义**）。
  - `record-only`：1 次落库 + **不逐人 DM**，仅通知本进程主题订阅者。
  - 新增 `history(caller, {topic?, sinceId?})`：成员**拉取**可见快照（不回投自己发的），与 `record-only` 配套。
- `packages/tool-swarm/src/index.ts`：`broadcast` 工具新增可选 `fanout` 参数（默认 `dm`），使能力可由 agent 使用。
- `scripts/bench/`（`bench-run.mjs` / `lib/stub-backend.mjs`）：新增 A/B 开关 `--broadcast-fanout dm|record-only`（**追加式**，默认 `dm`）。
- 单测：`team-bus` 增 2 例（record-only 零 DM + 订阅者仍通知；`history` 不回投/可按 topic/since 拉取）。

### 2.3 复测（同一套基准，桩，`--repeat 7`，零模型成本）

```console
$ bash scripts/bench/run.sh --no-model --scenario S2 --repeat 7 --broadcast-fanout dm           --out .runtime/bench/o2-dm
$ bash scripts/bench/run.sh --no-model --scenario S2 --repeat 7 --broadcast-fanout record-only  --out .runtime/bench/o2-recordonnly
```

| S2 指标 | 前（`fanout:'dm'`，默认） | 后（`fanout:'record-only'`） | 判定 |
|---|---|---|---|
| 消息投递 messageDeliveries | **3** | **0** | 确定性下降（方差 0） |
| 广播 broadcasts | 1 | 1 | 不变（仍落库 1 条） |
| fanout 唤醒 wakeupsFanout | **3** | **0** | 确定性下降 |
| 空转唤醒 spinWakeups | **3** | **0** | 确定性下降 |
| e2eMs（mean，n=7） | 10.0 [4..40] | 9.57 [3..38] | 差异在噪声内（区间重叠） |

### 2.4 结论
- **有效（结构性）**：启用 `record-only` 后，广播从 O(N) 投递/唤醒降为 **O(1) 写 + 拉取**——投递 3→0、fanout 唤醒 3→0、空转唤醒 3→0，且仍保留 1 条落库记录（可 `history` 拉取）。与 P13 §1 C1 的 JSFW 形态对齐。
- **保留**（非回退）：改动为 **opt-in**，默认 `dm` 不变 → **守恒不变量不受影响**（见 §5）。
- **诚实边界**：本改动消除的是**结构性投递/唤醒放大**；「空转成员是否真省 LLM 轮」在 P13 §4 记为**未证实**（headless 单根轮截断），本轮同样**不据此下强结论**——需长驻运行才能确证。e2eMs 差异在噪声内，不作为收益。

### 2.5 复测所需的极小 bench 补丁（可复现说明）
**（P16-repo-hygiene 更新）** 当时 `scripts/bench/` 是**他人在研的未跟踪目录**（P11/P13 harness），为避免把别人的 WIP 裹进 P14 提交，本 A/B 开关未随 P14 入库。**现 bench 作者已收工，整个 harness（含 `--broadcast-fanout`）已随 P16 正式入库**（见 `scripts/bench/bench-run.mjs` / `lib/stub-backend.mjs`），§2.3 的两条命令**可直接复现**，无需再打补丁。以下保留原始补丁说明仅供追溯：

```diff
# scripts/bench/bench-run.mjs
+    broadcastFanout: 'dm',                       // parseArgs 默认值
+    else if (k === '--broadcast-fanout') a.broadcastFanout = v, i++
+          broadcastFanout: args.broadcastFanout,  // 两处 runStubScenario opts / variant（stub 分支）
# scripts/bench/lib/stub-backend.mjs
+    broadcastFanout: opts.broadcastFanout ?? 'dm',   // variant 默认值
+            fanout: variant.broadcastFanout,          // broadcast op → teamBus.broadcast
```

> 注：入库版本（`packages/team-bus` / `packages/tool-swarm`）的**单元级 A/B** 已可复现同一结论——`team-bus` 单测断言：默认 `dm` 投递=2、`record-only` 投递=0、`history` 可拉取。`--broadcast-fanout dm|record-only` 的口径与 `team-bus` 的 `fanout:'dm'|'record-only'` 一一对应（开关只透传该参数）。

---

## 3. O2：广播扇出并发化 + 成员表一次取（**复测无收益，已回退**）

### 3.1 动机（代码级，非报告候选）
`team-bus.fanout` 原为**串行** `for … await deliver`，且 `deliver` 内部对每个目标各调一次
`this.members(caller)`（即 O(N²) 列成员）。尝试：一次取成员表 + `Promise.allSettled` 并发扇出。

### 3.2 复测（同基准，桩 S2，`--repeat 15`，`fanout:'dm'`）

| 指标 | 前（串行） | 后（并发） | 判定 |
|---|---|---|---|
| messageDeliveries | 3 | 3 | 不变 |
| wakeupsFanout | 3 | 3 | 不变 |
| e2eMs（mean，n=15） | 6.73 [3..38] | 7.80 [3..44] | **无收益**（区间重叠，后测均值反而略高） |

### 3.3 结论：**回退**（`git checkout -- packages/team-bus/src/index.ts`）
- 复测**无收益**（e2e 差异在噪声内，且后测均值未降）——按任务纪律「没有复测证据的优化不算完成」，**回退**。
- 另有**反对理由**：并发扇出会**打乱投递顺序**（原为确定性的逐成员顺序），收益不可测而引入语义风险 → 不保留。
- 该实验**未产生提交**（改动已回退），此处如实记录以体现「无效回退」同样是有价值的结果。

---

## 4. 待 Leader 裁决的候选（未实施）

| # | 候选 | 为何未做 | 需要的授权 |
|---|---|---|---|
| 4 | 默认 `scheduled` 自动派发 | 改默认 = 可观测行为变更（autonomy→自动 claim） | Leader 明确授权「改默认」 |
| 2b | 把广播**默认**改为 `record-only` | 同上（默认行为变更） | Leader 明确授权 |
| 3 | 评审期显式 `in_review` | 改原生任务枚举语义，影响 scheduler/completion 判定 | Leader 明确授权 |

> 若 Leader 授权任一，将按同一流程：单独 commit → 同基准复测 → 记入本文件 → 有效则留、无效则回退。

---

## 5. 守恒不变量复验（每次优化后必跑）

见 `docs/verification.md §Y`（P14 记录）。要点：`build` / `test` / `verify` / `verify:e2e` / `e2e-profile.sh`
全绿；`team-bus` 单测 11、`tool-swarm` 单测 8 通过；默认路径（`fanout:'dm'`）行为与改动前一致。

---

## 6. 成本核算

| 批次 | 消耗 |
|---|---|
| 基线复现（桩） | 0 token |
| O1 前/后复测（桩，`--repeat 7`） | 0 token |
| O2 尝试+回退复测（桩，`--repeat 15`×2） | 0 token |
| **P14 本轮真实模型消耗** | **0 token**（全部桩模式；O1 的结构性收益不需要真实模型即可判定，且报告 §4 的轮次收益在 headless 下不可证实，故不烧 token） |
