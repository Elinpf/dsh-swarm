# 基准基线（benchmark）

> 责任：可复现实验。**一切数字都附可复现命令与原始输出；跑不通/观测不到的记「未采集」并说明原因。**
> 口径定义见 `scripts/bench/README.md §3`；本页只落**基线数据 + 原始输出 + 成本核算**。
> 生成时间：2026-10-26 ｜ 项目 `dsh-swarm` @ `main c1db7d5` ｜ 后端：离线桩 + 真实模型（`DeepSeek-Flash`）。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| `scripts/bench/` 可实际运行 | ✅ `--no-model`（S1–S5）与真实模型（S1–S3）均跑通，附原始输出（§4/§5） |
| 结果可机器读取 | ✅ 每场景 `result.json`（全量含事件）+ `result.csv`（每样本一行） |
| 成本门禁 | ✅ 默认 cap=5,000,000（用户指定）；超限立即中止并报告；实测超限即停（§6.2） |
| 本轮真实模型消耗 | **154,197 token（占 5M 的 3.08%）**；未触发任何上限 |
| 桩 vs 真实模型 | 桩：结构指标真实、LLM 指标「未采集」；模型：LLM 指标真实、teammate 唤醒「未采集」 |
| 关键观察 | S2 广播下 3 名收件人全部被扇出唤醒、且**均无自己的直接消息/任务** → 空转唤醒=3（结构侧） |

---

## 1. 复现命令

```bash
cd <项目>/dsh-swarm

# 基线 A：离线桩（零模型成本，验证管道与口径）
bash scripts/bench/run.sh --no-model --scenario S1,S2,S3,S4,S5 --repeat 3 --out .runtime/bench/baseline-stub

# 基线 B：真实模型（小规模；先桩跑通再开真模型）
bash scripts/bench/run.sh --scenario S1,S2,S3 --token-cap 400000 --timeout-ms 700000

# 成本门禁验证（超限即停）
bash scripts/bench/run.sh --scenario S1 --token-cap 5000 --timeout-ms 300000
```

结果目录：`.runtime/bench/<ts>-<backend>/`（`result.json` / `result.csv` / `SUMMARY.md`）。
> `.runtime/` 已 gitignore（体积大、机器强相关）；本页已把**原始输出**内联，故基线可审查。

---

## 2. 口径说明（摘要）

完整定义见 `scripts/bench/README.md §3`。要点：

- `e2eMs` 端到端墙钟；model 含 `dsh` 冷启动。
- `messageDeliveries`：stub=底层投递调用数（扇出**每收件人各 1**）；model=`send_message`+`multicast` 调用（**不含广播扇出**，广播另计 `broadcasts`）。
- `wakeups` / `spinWakeups`：**stub 专有**结构量。`spinWakeups` = 由广播扇出被叫醒、且无自己直接消息/任务的成员数。
- `tokens`：累加官方 JSON 流 `status.step_end.usage`（`dsh-headless/json-stream` 投影）。
- `retries`：stub=模拟瞬时投递失败次数；model=`tool_result.status=="error"` 次数。
- **桩与模型不可直接比「轮次/token」**（桩无 LLM）。

---

## 3. 未采集项与原因（诚实标注）

| 指标 | stub | model | 原因 |
|---|---|---|---|
| `llmTurns` / `tokens.*` | 未采集 | ✅ | stub 无真实 LLM；model 从 `step_end.usage` 采集 |
| `wakeups` / `spinWakeups` | ✅（结构侧） | 未采集 | `dsh headless --json` **只投影 root（lead）会话**，teammate 唤醒/turn 不在流内 |
| teammate 级 token | 未采集 | 未采集 | 同上；需另读 teammate durable 会话日志（P13 范围） |
| `process.rss*`（model） | ✅ | 未采集 | model 为独立子进程，`--json` 流不含其内存；stub 为同进程可测 |
| `disk.sandboxDeltaBytes`（stub） | 0 | — | stub 端口 mock 不落durable；无磁盘写入（如实记 0） |
| `casConflicts` / `staleNudged` / `escalations`（model） | ✅ | 未采集 | 这些由stub可靠的 scan/事件计数；model 端无对应流字段 |

---

## 4. 基线 A：离线桩（`--no-model`，S1–S5，repeat=3）

### 4.1 汇总表

| 场景 | 端到端时延(ms) | 消息投递 | 广播 | 唤醒(direct/fanout) | **空转唤醒** | 重试 | stale 自催 | 升级 | 评审轮 | 任务终态 |
|---|---|---|---|---|---|---|---|---|---|---|
| S1 单成员 spawn+DM | 16 (5–37) | 1 | 0 | 1 (1/0) | 0 | 0 | 0 | 0 | 0 | — |
| S2 多成员广播 | 5.3 (5–6) | 3 | 1 | 3 (0/3) | **3** | 0 | 0 | 0 | 0 | — |
| S3 任务 DAG | 4.7 (4–5) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | t1/t2=completed |
| S4 评审闸 | 4.7 (4–5) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | completed |
| S5 失败恢复 | 146 (145–147) | 6 | 0 | 6 (6/0) | 0 | **2** | **2** | **1** | 0 | in_progress(卡住) |

> S5 时延含刻意 `sleep`(60ms×2) 以触发 stale 阈值，不代表系统开销。
> S2 的 3 次空转唤醒按成员：`{alice:1, bob:1, carol:1}`（三人均被广播唤醒、无自己任务/消息）。
> S4 的 2 轮 = 第1轮 verifier `fail`（返工）→ 第2轮全 `pass` → 任务 completed（不可自验、一票否决均生效）。

### 4.2 原始输出（`SUMMARY.md` 摘录，逐字）

```
# bench run stub-2026-10-26T12-19-25-933Z

- 后端：`stub`
- 场景：S1, S2, S3, S4, S5 ｜ 重复：3
- token 门禁：不适用（桩模式无真实模型）

#### S1 — 单成员 spawn + 一次 DM
- 端到端时延：16 ms (min 5 / max 37)
- LLM 轮次：未采集
- token（in/out/total）：未采集 / 未采集 / 未采集
- 消息投递：1 ｜ 唤醒：1 ｜ 空转唤醒：0
- 任务重试：0 ｜ CAS 冲突：0 ｜ stale 自催：0
- 进程 RSS（后）：62772565.333 B (min 61898752 / max 63602688) ｜ 磁盘增量：0 B

#### S2 — 多成员广播（含被叫醒但无自己消息的空转成员）
- 端到端时延：5.333 ms (min 5 / max 6)
- LLM 轮次：未采集
- 消息投递：3 ｜ 唤醒：3 ｜ 空转唤醒：3
- 任务重试：0 ｜ CAS 冲突：0 ｜ stale 自催：0
- 进程 RSS（后）：65116842.667 B (min 64589824 / max 65646592) ｜ 磁盘增量：0 B

#### S3 — 任务 DAG：创建 → 阻塞 → 解锁 → 完成
- 端到端时延：4.667 ms (min 4 / max 5)
- 消息投递：0 ｜ 唤醒：0 ｜ 空转唤醒：0
- 任务重试：0 ｜ CAS 冲突：0 ｜ stale 自催：0

#### S4 — 评审闸往返（提交 → 评审 → 通过/返工）
- 端到端时延：4.667 ms (min 4 / max 5)
- 消息投递：0 ｜ 唤醒：0 ｜ 空转唤醒：0

#### S5 — 失败/卡住恢复（超时、重试、stale 自催）
- 端到端时延：146.333 ms (min 145 / max 147)
- 消息投递：6 ｜ 唤醒：6 ｜ 空转唤醒：0
- 任务重试：2 ｜ CAS 冲突：0 ｜ stale 自催：2
```

### 4.3 原始明细（`result.json` 关键字段，逐字）

```json
// S2 samples[0].metrics（节选）
{ "messageDeliveries": 3, "broadcasts": 1, "wakeupsFanout": 3,
  "spinWakeups": 3, "spinWakeupsByMember": {"alice":1,"bob":1,"carol":1} }

// S3 samples[0].metrics.tasks
[{"id":"task-2","subject":"A: build","status":"completed","owner":"alice"},
 {"id":"task-3","subject":"B: test","status":"completed","owner":"alice"}]

// S5 samples[0].metrics.scans
[{"label":"stale#1","staleNudged":1,"converged":true},
 {"label":"stale#2","staleNudged":1,"converged":true}]
```

---

## 5. 基线 B：真实模型（S1–S3，`DeepSeek-Flash`）

### 5.1 汇总表

| 场景 | 端到端时延(ms) | LLM 轮次 | token(in/out/total) | 工具调用 | 消息投递 | 广播 | 重试 | 会话磁盘增量(B) |
|---|---|---|---|---|---|---|---|---|
| S1 | 9138 | 1 | 35354 / 723 / **36077** | spawn_teammate×1, send_message×1, list_agents×1 | 1 | 0 | 0 | 40498 |
| S2 | 13558 | 1 | 44510 / 1099 / **45609** | spawn_teammate×3, broadcast×1, list_agents×1 | 0 | 1 | 0 | 56247 |
| S3 | 24507 | 1 | 70316 / 2195 / **72511** | spawn×1, task_create×2, task_list×1, task_get×2, task_update×2 | 0 | 0 | 0 | 40532 |

> 三者均 `turns=1`：模型在**单轮内**完成多步工具调用（`step` 数 5/6/9）。输入 token 占绝对多数（含系统提示词+工具定义）。
> `messageDeliveries`(model) 不含广播扇出，故 S2 显示 0，广播另计 `broadcasts=1`（口径见 README §3，**不可与 stub 直接比**）。

### 5.2 原始输出（`SUMMARY.md` 摘录，逐字）

```
# bench run model-2026-10-26T12-18-50-742Z

- 后端：`model`
- 场景：S1, S2, S3 ｜ 重复：1
- token 门禁：cap=400000；本轮实际消耗=154197（占上限 38.5493%）

#### S1 — 单成员 spawn + 一次 DM
- token 门禁：cap=400000，实际消耗=36077（占上限 9.0192%），中止=false
- 端到端时延：9138 ms
- LLM 轮次：1
- token（in/out/total）：35354 / 723 / 36077
- 消息投递：1 ｜ 唤醒：未采集 ｜ 空转唤醒：未采集
- 任务重试：0 ｜ CAS 冲突：未采集 ｜ stale 自催：未采集

#### S2 — 多成员广播（含被叫醒但无自己消息的空转成员）
- token 门禁：cap=400000，实际消耗=45609（占上限 11.4023%），中止=false
- 端到端时延：13558 ms
- LLM 轮次：1
- token（in/out/total）：44510 / 1099 / 45609
- 消息投递：0 ｜ 唤醒：未采集 ｜ 空转唤醒：未采集

#### S3 — 任务 DAG：创建 → 阻塞 → 解锁 → 完成
- token 门禁：cap=400000，实际消耗=72511（占上限 18.1278%），中止=false
- 端到端时延：24507 ms
- LLM 轮次：1
- token（in/out/total）：70316 / 2195 / 72511
```

### 5.3 说明

- **model 端 wakeups/空转唤醒为「未采集」**：`--json` 只投影 root 会话，广播扇出到 teammate 的唤醒/turn 不在流内。
  要测「广播下 teammate 是否真的空转耗轮」，须读 teammate durable 日志 → 交给 P13（对比/消融）。
- S2 的 3 个 teammate 在真实运行时**确会被广播唤醒并各起一个 turn**（`docs/profile-e2e.md §6.1` 已验证
  `send_message` 对 inactive 成员会启动/恢复一个 turn）；本基线的 root 流观测不到这部分成本，属**已知盲区**。

---

## 6. 成本核算与门禁

### 6.1 本轮总消耗

| 运行 | 场景 | 消耗 token | 占 5M |
|---|---|---|---|
| 基线 B（`S1,S2,S3`） | S1+S2+S3 | **154,197** | **3.08%** |
| 探针（PONG） | — | 6,701 | 0.13% |
| 门禁验证（S1, cap=5000） | S1(中止) | 6,889 | 0.14% |

> 合计约 **167,787 token**（含探针与门禁验证），**占单次任务 5M 上限的 ~3.4%**，余量充足。
> 全部真实模型运行均 **未触发** `--token-cap`/`--turn-cap`/timeout 中止（门禁验证那次是**主动设小 cap 验证门禁**，属预期中止）。

### 6.2 门禁行为（实测）

```
$ bash scripts/bench/run.sh --scenario S1 --token-cap 5000 --timeout-ms 300000
  - S1 #1/1 ... ok (3414 ms, turns=1, tokens=6889, ABORTED)
[bench] 本轮实际消耗 6889 / 5000 token（137.7800% of cap）
```

- 子进程运行中累加 `step_end.usage`，**超过 cap 立即 `SIGKILL`**，不等跑完（3.4s 即停）。
- 超限后实际消耗略高于 cap（6889 > 5000）：usage 在 `step_end` 才返回，最多超出「最后一个 step」的量。**如实报告，不隐藏。**

---

## 7. 对后续（P13）的支撑

- **可支撑 A/B**：同一场景在 `--repeat N` 下端到端时延/投递/唤醒给出区间；`--token-cap` 保证成本可控。
  A/B 建议：`broadcast vs N 次 DM`（比 `messageDeliveries`/`wakeupsFanout`/`spinWakeups`）、`有/无 scheduler`（比 `scans`/`staleNudged`）、`有/无评审闸`（比 `reviewRounds`/任务终态）。
- **可支撑消融**：stub 后端可在真实插件链路上做「换端口实现/去降级分支」的结构对比（零成本、可重复）。
- **跨系统对比的红线**：只有**结构量**（扇出投递数、状态机步数）在口径对齐后可比；时延/token 受实现+模型+提示词差异影响，**默认不可比**（见 README §6、`docs/jsfw-comparison-fixture.md`）。
- **待补盲区**：teammate 级 token / 空转是否耗轮 —— 需扩展 model 后端读取 `DSH_HOME/sessions` 的 teammate durable 日志（本基线未做，如实标注）。
