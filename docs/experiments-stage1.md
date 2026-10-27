# 对比 / A-B / 消融实验：差异定位报告（experiments-stage1）

> P13 ｜ 负责人：bench-qa-engineer ｜ 时间：2026-10-26 ｜ 项目 `dsh-swarm` @ `main c1db7d5`
> 纪律：结论必须可复现（命令 + 原始输出）；不能复现的标【未验证】；反例与「没看出差异」同样是结果。
> 工具：`scripts/bench/`（P11 harness）＋ `docs/jsfw-comparison-fixture.md`（P12 对照夹具）。

---

## 0. 结论速览与成本

| 项 | 结果 |
|---|---|
| **最重要发现** | **`--json` 只投影 root 会话 → 用它记账会低估真实团队 token 17.9%–36.2%**（S1/S2/S7 实测）；且 **DM 唤醒 inactive 成员确会 +1 LLM 轮**（S1 实证）。 |
| 空转唤醒 | **既未证实也未证伪**——广播后 teammates 未见额外轮，但 headless 单根轮会在成员下一轮前退出，观测无法区分「设计省轮」与「窗口截断」。见 §4。 |
| A/B（桩，repeat=7） | 广播 vs N次DM：**投递/唤醒人数零差异**（结构量方差=0）；有/无 scheduler、有/无评审闸：**确定性差异**（见 §2）。 |
| 消融 | stale 自愈、调度模式两个 swap 均**定位到具体环节**（见 §3）。 |
| 与 JiuwenSwarm 对比 | 仅报**可比微观指标**（状态机序列、DAG 解锁、评审裁决规则、广播扇出形态）；不可比一律不报数字（§1）。 |
| **本轮实际消耗** | 见 §5。P13 全程（含重跑）真实模型 **≈ 288k token ≈ 5.8% / 5M**。 |

---

## 1. 与 JiuwenSwarm 的对比（只报可比指标）

对照口径权威清单见 `docs/jsfw-comparison-fixture.md §4`（可比 C1–C8 / 不可比 N1–N6）。本节**只对 C1–C7 给对照**，N1–N6 不报数字。

**复现（零模型成本）：**
```bash
# 我的可复现副本（不改 P12 产物）：
mkdir -p .runtime/bench/jsfw-repro && cp scripts/bench/jsfw/probe_min_team.py scripts/bench/jsfw/probe_stage2_actions.py .runtime/bench/jsfw-repro/
cd .runtime/bench/jsfw-repro && rm -rf .jsfw-home logs && /opt/openjiuwen/workswarm-venv/bin/python -u probe_stage2_actions.py 2>&1 | grep '^\[stage2\]'
# dsh-swarm 侧：bash scripts/bench/run.sh --no-model --scenario S2,S3,S4 --repeat 1
```

| 可比指标 | JiuwenSwarm（jsfw 夹具，实测） | dsh-swarm（harness 桩，实测） | 判定 |
|---|---|---|---|
| **C3 任务状态机** | `pending → in_progress → completed`；带 reviewer 时 `in_progress → **in_review** → completed` | `pending → in_progress → completed`；**评审期间保持 `in_progress`**（评审态不进原生任务枚举） | **差异（可比）**：JSFW 有显式 `in_review` 态；dsh-swarm 无 |
| **C4 DAG 依赖解锁** | `t2=blocked` → 完成后 `t2=pending`（自动解锁） | 同：`blocked → ready`（`ready=true`）到 `pending→in_progress` | **一致（可比）** |
| **C7 评审裁决** | autonomous 模式**首票即决** | 二元池需 **verifier＋challenger 全投**、任一 fail 即 veto | **差异（可比）**：dsh-swarm 更严（多角色合议） |
| **C1 广播扇出形态** | `broadcast_message`：**1 条**消息记录 + 读者轮询（O(1) 写） | `team-bus`：**1 次落库 + N 次 DM 投递**（O(N) 扇出，实测 N=3→3 次投递） | **差异（可比，形态级）**：写放大 O(1) vs O(N) |
| C2 每动作 DB 往返 | 未逐条埋点 | 未逐条埋点 | 未采集（需两侧 DB 埋点，本轮不做） |
| C5 幂等 / C8 单动作墙钟 | 未测 | 桩 e2e 亚毫秒级，不可跨语言比 | 不可比（见下） |

**明确不报数字的不可比项（N1–N6）：** 绝对 token/模型延迟（N1）、进程/内存（N2，Python GIL vs Node 单线程）、DB 吞吐（N3）、跨进程/分布式（N4，DSH 阶段3才有）、冷启动（N5）、代码行/包数（N6）。**理由**：形态与语言边界不同，无同构部署，数字无意义。

> 注：C1 的「JSFW=1 条记录」来自其夹具 `broadcast message_id=... unread=True`（单条）+ 源码 `message_manager.broadcast_message`；dsh-swarm 侧 N 次投递为实测（S2 stub：`messageDeliveries=3`）。**形式不同故标注为形态级差异**，非精确同口径计数。

---

## 2. A/B 实验（桩模式，`--repeat 7`，含区间与噪声判断）

**复现：**
```bash
R=7
bash scripts/bench/run.sh --no-model --scenario S2 --repeat $R --delivery bus   --out .runtime/bench/ab-bus
bash scripts/bench/run.sh --no-model --scenario S2 --repeat $R --delivery n-dm  --out .runtime/bench/ab-ndm
bash scripts/bench/run.sh --no-model --scenario S6 --repeat $R --sched-mode scheduled --scheduler on  --out .runtime/bench/ab-sched-on
bash scripts/bench/run.sh --no-model --scenario S6 --repeat $R --scheduler off --out .runtime/bench/ab-sched-off
bash scripts/bench/run.sh --no-model --scenario S4 --repeat $R --review gate --out .runtime/bench/ab-rev-gate
bash scripts/bench/run.sh --no-model --scenario S4 --repeat $R --review none --out .runtime/bench/ab-rev-none
```

### AB1 广播 vs N 次 DM（同一条信息送达 3 人）
| 指标 | 广播（bus） | N 次 DM（n-dm） | 判断 |
|---|---|---|---|
| messageDeliveries | 3.00 | 3.00 | **无差异**（方差=0） |
| broadcasts | 1.00 | 1.00（记一次扇出） | 无差异 |
| wakeups（fanout/direct） | 3（3/0） | 3（0/3） | **唤醒人数相同**，仅分类标签不同 |
| spinWakeups（结构） | 3.00 | 0.00 | **口径产物**：只统计扇出唤醒（见 §6 风险） |
| e2eMs | 10.0 [4..41] | 9.86 [4..40] | **差异在噪声内**（区间重叠，均值差 <0.2ms） |

**结论**：dsh-swarm 的 `broadcast` 实现 = 「**1 次落库 + N 次 DM 扇出**」。相比手动发 N 次 DM，它**不减少投递次数、不减少被唤醒人数**，只在总线里多一条「广播」语义记录。→ 这直接解释了 §1 的 C1 形态差异，也是 §4 空转问题的根。

### AB2 有 / 无 scheduler 自动派发（S6，scheduled 模式，2 任务 × 2 空闲成员）
| 指标 | scheduler=on(scheduled) | scheduler=off | 判断 |
|---|---|---|---|
| scan.started | **2** | **0** | **确定性差异**（方差=0） |
| 任务状态 | job-1/job-2 = `in_progress`（已派给 alice/bob） | 两者 = `pending`（无人认领） | 确定性差异 |

**结论**：scheduler=off 时**没有任何自动派发**，ready 任务永远停在 pending。scheduler 是任务推进的唯一自动驱动力。

### AB3 有 / 无评审闸（S4）
| 指标 | review=gate | review=none | 判断 |
|---|---|---|---|
| reviewRounds | **2.00** | **0.00** | 确定性差异 |
| 任务终态 | completed（经 fail→pass 两轮） | completed（提交即完成） | 殊途同归 |

**结论**：评审闸不改变「任务最终 completed」，但**在中间插入 2 次裁决**（gate）vs 直接完成（none）。闸的价值在过程控制（不可自验、返工），不在终态。

---

## 3. 消融 / 调换测试（ablation / swap）

**复现：**
```bash
bash scripts/bench/run.sh --no-model --scenario S5 --repeat 7 --stale on  --out .runtime/bench/ab-stale-on
bash scripts/bench/run.sh --no-model --scenario S5 --repeat 7 --stale off --out .runtime/bench/ab-stale-off
bash scripts/bench/run.sh --no-model --scenario S6 --repeat 7 --scheduler on --sched-mode autonomous --out .runtime/bench/ab-mode-auto
```

### Ab1 去掉 stale 自愈分支（S5）
| 指标 | stale=on | stale=off | 定位 |
|---|---|---|---|
| staleNudged | **2.00** | **0.00** | stale 自愈是自催的**唯一**来源 |
| escalations | **1.00** | **0.00** | 升级 Lead 只发生在 stale 连续无果路径 |
| retries | 2.00 | 2.00 | **不受影响**（重试来自 `flakyDm` 投递层，与 stale 无关） |

**结论**：干净地**定位到「stale 自愈」这一环节**——它单独负责 2 次自催与 1 次升级；重试是另一条独立路径（投递层），互不耦合。

### Ab2 交换调度模式（S6，autonomous ↔ scheduled）
| 指标 | autonomous | scheduled |
|---|---|---|
| scan.started | **0**（只 nudge 空闲成员去认领） | **2**（作为唯一 dispatcher 直接 claim 启动） |

**结论**：**自动派发的行为差异定位在 team-scheduler 的 `mode`**：autonomous 只唤醒（人/成员自取），scheduled 才真正一键盘 claim。

### Ab3（= AB1 的投递路径 swap，事件级）
同一 S2 场景交换投递实现（`team-bus` 扇出 ↔ N 次 `teamCore.send`）：**结构投递数完全相同（3=3）**，差异只在唤醒的事件分类（fanout vs direct）。→ 投递路径是「语义等价的两条实现」，非性能差异源。

---

## 4. 「空转唤醒」专题（证伪 / 证实）

**设计声明**（JiuwenSwarm 侧主张）：被叫醒但**没有自己消息**的成员**不耗 LLM 轮**。
**dsh-swarm 现状**（源码）：`team-bus` 广播 = N 次 DM 扇出（§2 AB1），**每个收件人都收到一条 DM** → 按 `send_message` 语义（`docs/profile-e2e.md §6.1` 已证「对 inactive 成员启动/恢复一个 turn」），**每个被扇出的成员都会起一个 turn**。

**实测（真实模型，`DeepSeek-Flash`）：**
```bash
bash scripts/bench/run.sh --scenario S1,S2,S7 --token-cap 500000 --timeout-ms 700000 --out .runtime/bench/exp-model2
# teammate 轮次/token 由 harness 从 durable 会话日志（按 root 的 subagent/catalog 归属）统计
```

| 场景 | 语义 | root 轮 | teammate 数 | teammate 轮 | teammate token | 真实总 token | root-only 低估 |
|---|---|---|---|---|---|---|---|
| **S1** | spawn alice + **1 次 DM** | 1 | 1 | **2** | 20,612 | 56,967 | **36.2%** |
| **S2** | spawn×3 + **广播** | 1 | 3 | 1×3=3 | 20,423 | 65,143 | **31.4%** |
| **S7** | spawn×2 → 静置 → **广播** | 1 | 2 | 1×2=2 | 13,574 | 76,032 | **17.9%** |

**发现 A【事实】DM 唤醒 +1 轮**：S1 中 alice 先跑初始 prompt（turn1）→ 收到 DM 后**又跑 turn2**（token 20.6k 含 2 轮）。→ **对 inactive 成员发 DM 确实消耗 1 个额外 LLM 轮。**

**发现 B【事实】广播未观测到额外轮**：S2/S7 中 teammates 只有 spawn 初始轮（turn=1），其 durable 会话里**没有出现广播消息**（无 `agent/inbox/spliced` 广播正文、无第 2 个 `turn/start`）。

**判定【未证实 ≠ 证伪】**：上述 B **不能**推出「广播下空转不耗轮」，因为存在**混淆项**：
- S7 的两次 `wait_agent(timeout_ms=30000)` 在 17.5s 内返回（墙钟 < 2×30s）→ 等待提前结束，广播很可能在 teammate 仍处初始轮时下发，消息入队但**根轮结束即退出进程**，teammate 的下一轮从未开始。
- 即 headless **单根轮生命周期**会在 teammate 消费广播前截断运行。

→ **结论：用当前 headless harness，无法在真实模型下证实或证伪「广播下空转成员不耗轮」。** 要确证需**长驻运行**（让 teammates 在广播后继续存活并消费）或**显式驱动 teammate 处理其 inbox**。这是本报告**如实记录的反例/未决项**，也是 P14 若要优化广播前必须先补的实验。

**发现 C【事实·高价值】成本口径被 root-only 低估 18%–36%**：`dsh headless --json` 只投影 root 会话，**真实团队成本 = root + 所有 teammate**。三者低估幅度 17.9%–36.2%。→ 任何基于 `--json` 的成本核算都严重偏低；harness 现已补 `teammateActivity` 采集（见 §6 优化#2）。

---

## 5. 成本核算（本轮 / 5M）

| 批次 | 场景 | 消耗 token | 说明 |
|---|---|---|---|
| exp-model（首轮） | S1,S2,S7 | 144,793 | 旧归属逻辑，数据已弃用 |
| exp-model2（重跑） | S1,S2,S7 | 143,533 | 最终采信 |
| 桩模式全部 A/B+消融 | — | 0 | 离线，无模型调用 |
| JiuwenSwarm 夹具 | — | 0 | 桩模式 |
| **P13 小计（真实模型）** | | **≈ 288,326** | **≈ 5.77% / 5M** |

> 单次任务上限 5,000,000，**本轮 P13 真实模型消耗约 5.8%**，余量充足；全程未触发门禁（cap=500k/次，实际 36k–62k/次）。桩模式与 JSFW 夹具**零模型消耗**。

---

## 6. 优化候选清单（按「预期收益 × 实施难度」排序，每条附证据与风险）

| # | 候选 | 证据 | 预期收益 | 风险 / 反对 |
|---|---|---|---|---|
| 1 | **成本核算纳入 teammate**（已在 harness 落地，建议推广到所有成本台账） | §4 发现 C：root-only 低估 18–36% | 成本可见、防止超支误判 | 需读 durable 日志（多帧 zstd，已解决）；重试 attempt 的额外用量仍未计（略低估） |
| 2 | **广播改「信号+拉取」语义**（1 条记录 + 成员按需拉取），而非 N 次 DM 推送 | §2 AB1：broadcast=N 次投递、与 N DM 零差异；§1 C1：JSFW 为 O(1) 写 | 降投递与唤醒放大，**潜在**省 teammate 轮 | §4 空转省轮**未证实**；改拉取引入延迟与丢消息风险；需消费端配合 |
| 3 | **评审期显式 `in_review` 状态**（对齐 JSFW） | §1 C3：JSFW 有 in_review，dsh-swarm 隐藏为 in_progress | 可观测性 / 外部系统集成更清晰 | 改动原生任务枚举语义，需回归 scheduler/completion 判定 |
| 4 | **默认 `scheduled` 自动派发**（或提供一键开关） | §2 AB2 / §3 Ab2：off 时任务永远 pending | 无人值守场景吞吐↑ | autonomous 更适合 human-in-the-loop；误派风险 |
| 5 | **广播 delivery 增加「静默/仅信号」档** | §2 AB1：当前对所有成员强制 wakeup | 减少对无关成员的打扰 | §4 未证明确实省轮；可能被误用致漏读 |

---

## 7. 局限与未验证项（诚实清单）

1. **空转省轮**：未证实/未证伪（§4 混淆项：headless 单根轮截断）。【未验证】
2. **teammate token**：从 durable `assistant/message.usage` 累加；**重试 attempt 的额外用量未计**，属轻微低估（口径见 `scripts/bench/README.md`）。
3. **A/B 的 LLM 维度**：桩模式的 A/B 只有结构量（确定性）；LLM 维度受成本限制只做了 S1/S2/S7 单次真实运行，**未做 `--repeat`**，故 §4 的轮次数字**无区间**，单次取数——已如实标注，不据此下强结论。
4. **JSFW 侧 C1/C2 精确计数**未逐条埋点，C1 为形态级对照。
5. **桩后端**：`spinWakeups` 为**结构口径**（扇出唤醒且无自己任务/直接消息），非 LLM 轮；AB1 中 bus vs n-dm 的 spin 差异（3 vs 0）是**口径产物**，不代表真实轮次差异。

---

## 8. 复现清单

```bash
cd <项目>/dsh-swarm
# 桩 A/B + 消融（零成本）
bash scripts/bench/run.sh --no-model --scenario S2 --repeat 7 --delivery bus  --out .runtime/bench/ab-bus
bash scripts/bench/run.sh --no-model --scenario S2 --repeat 7 --delivery n-dm --out .runtime/bench/ab-ndm
bash scripts/bench/run.sh --no-model --scenario S6 --repeat 7 --sched-mode scheduled --scheduler on --out .runtime/bench/ab-sched-on
bash scripts/bench/run.sh --no-model --scenario S6 --repeat 7 --scheduler off --out .runtime/bench/ab-sched-off
bash scripts/bench/run.sh --no-model --scenario S4 --repeat 7 --review gate --out .runtime/bench/ab-rev-gate
bash scripts/bench/run.sh --no-model --scenario S4 --repeat 7 --review none --out .runtime/bench/ab-rev-none
bash scripts/bench/run.sh --no-model --scenario S5 --repeat 7 --stale on  --out .runtime/bench/ab-stale-on
bash scripts/bench/run.sh --no-model --scenario S5 --repeat 7 --stale off --out .runtime/bench/ab-stale-off
# 真实模型（空转专题，含 teammate 采集）
bash scripts/bench/run.sh --scenario S1,S2,S7 --token-cap 500000 --timeout-ms 700000 --out .runtime/bench/exp-model2
# JiuwenSwarm 对照（零成本）
cd .runtime/bench/jsfw-repro && /opt/openjiuwen/workswarm-venv/bin/python -u probe_stage2_actions.py 2>&1 | grep '^\[stage2\]'
```

机器可读结果：`.runtime/bench/<批次>/<场景>/result.json`（含 `teammateActivity`）与 `result.csv`。
