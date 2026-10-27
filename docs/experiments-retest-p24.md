# #5/#6 真实 profile 重测结论（experiments-retest-p24 / P33）

> P33 ｜ 负责人：bench-qa-engineer ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm` @ `main 31bc72a`
> ⚠️ **P33 范围变更**：#5（scheduler 三臂）已移交 **P39-rerun-sched-arms**；本任务**只做 #6**。第 1 节保留为「#5 未 arm 历史记录」（**不作结论**）。
> 承接：`docs/experiments-stage1.md §9`（#5/#6 标「未重测/不可判定」）+ `team-workspace/retest-plan-p24-scheduler-review.md`（方案）。
> 口径：判定表每条标 **【成立】/【推翻】/【仍不可判定 + 原因 + 解锁条件】**，并**按时序标注**
> （【no-op 时代】=P22 前；【P22 后】；【P30·P31 后】=本次）。原始数字一律保留、不篡改。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| **#5 scheduler 三臂（P39，arming 后）** | 前置成立：`scheduled` **真派发**（→`in_progress`）、`autonomous` **真 nudge**、`off` 静默。**`scheduled` 开销更低**（teammate 3 轮 vs autonomous 反复 nudge **9 轮**）→ **默认必选倾向【成立】（附前置：claim 归属 `owner=lead` 异常待确认）**。旧「无差异」记录见 §1.0。 |
| **#6 计划闸** | 真实 profile **无工具入口**：`team_task_update action='open_plan'` 被原生工具 enum 直接拒绝（`must be one of [claim,release,edit,set_dependencies,complete,reopen,reassign,delete]`）。→ **仍不可判定（前置缺失）**。 |
| **#6 评审闸** | 可 `review_submit`→任务进 `in_review`✅；但 **`settle()` 无调用入口**（无工具、无自动触发），且 lead 认领导致自验被拒。→ **仍不可判定（前置缺失）**。 |
| **#6 stale 自愈** | 依赖 `teamScheduler.scan` → 因 **未 arm** 而不运行。→ **仍不可判定（前置缺失，同 #5）**。 |
| **解锁→唤醒延迟** | 机制级探针（零成本）**成立**：延迟上界=1 个 poll 周期（测试档≈201ms／生产默认 30000ms）；**不 arm() ⇒ nudge=0**；pull 对比 push（`onTaskTerminal`）≈0ms。 |
| **本轮消耗** | 真实模型 **≈ 329,684 ≈ 6.59% / 5M**（#5 237,714 + #6 91,970）；桩/探针 0。 |

> **一句话**：#6 的计划闸/评审闸在真实 profile **缺触发入口 → 仍不可判定（前置缺失）**；#5 的三臂数据因 **`teamScheduler` 未 arm**（no-op 时代）**只作历史存档、不作结论**，移交 P39。

---

## 1. #5 scheduler 三臂（真实 profile）——**【仅供存档 · 不作结论；结论移交 P39】**

> ⚠️ **§1.0 为旧记录（`teamScheduler` 从未 `arm()` 的 no-op 时代）**：三臂「无差异」**不是模式差异，而是都没跑起来**，**不得作为结论**。
> **当前有效结论见 §1.2（P39：P38b `26f98a8` 补 arming 后重测）**。§1.0 保留为「未 arm 的历史记录」与根因定位。

### 1.0 旧记录（未 arm 时代）：三臂无差异

**复现**（自带 scheduler 配置 overlay；`scripts/bench/exp-sched.sh`）：

```bash
bash scripts/bench/exp-sched.sh --mode scheduled  --out .runtime/bench/p33-sched/scheduled
bash scripts/bench/exp-sched.sh --mode autonomous --out .runtime/bench/p33-sched/autonomous
bash scripts/bench/exp-sched.sh --mode off        --out .runtime/bench/p33-sched/off
```

场景：spawn `alice`/`bob`（空闲）→ 建 2 个 ready 任务 → 长驻 `wait_agent` → `team_task_list`。

| 臂 | `team-scheduler.mode` | 最终任务状态 | teammate 轮 | root token |
|---|---|---|---|---|
| A | `scheduled` | **task-1/task-2 = `pending`** | 各 1 初始轮（0 nudge） | 100,302 |
| B | `autonomous` | **`pending`** | 各 1 初始轮 | 68,598 |
| C | disabled | **`pending`** | 各 1 初始轮 | 68,814 |

原始：`.runtime/bench/p33-sched/<arm>/raw.jsonl`（`team_task_list` 原文：两任务 `status":"pending","ready":true`）。

**判定【推翻（前置缺失）】**：原桩结论（P13 §2 AB2/§3 Ab2）「`scheduled` 自动 claim 派发（`scan.started=2`）、`autonomous` 只 nudge」**在真实运行不复现**——三臂同为零动作。
**根因（源码级）**：`teamScheduler` 被加载但**从未 `arm()`**；`grep` 全仓 `packages/*` 无 `.arm(`/`onTeamEdge` 调用点（仅 tests/`scripts/verify-unblock-latency.mjs`/bench 桩有）。未 `arm` ⇒ 周期扫描不跑；且 P31 的 `swarm/task/unblocked` 主动推送也依赖 `armedAgent` ⇒ **同样不触发**。
**解锁条件**：补一个**真实 profile 下的 arming/触发入口**（谁、何时调 `teamScheduler.arm(agent)`），之后三臂方可重测。

### 1.1 解锁→唤醒延迟（机制级，零成本，成立）

`node scripts/verify-unblock-latency.mjs`（in-process 驱动真实 `team-scheduler` 产物）：

| poll 档位 | pollMs | 就绪→首次 nudge 延迟 |
|---|---|---|
| 测试档 | 200ms | ≈ 201ms |
| 生产默认档 | 30000ms | ≈ 30000ms |

- **【成立】** 延迟上界 = **一个 poll 周期**（随配置变化，非固定 200ms）。
- **【成立·独立成条】** **调度器不存活 ⇒ 解锁根本不发生**：未 `arm()` 时观察窗内 nudge = **0**（这是比延迟更重要的 P1 实质风险；**真实 profile 正是此状态**，见 §1）。
- **【成立】** push 路径（`onTaskTerminal`）≈ **0ms**，显著快于 poll。
  > 注意：该探针是 **in-process 机制级**，非真实 headless；真实 profile 因未 arm 而不触发。

---

### 1.2 arming 修复后重测（P39，P38b `26f98a8` 后）——**#5 当前有效结论**

P38b 给 `team-scheduler` 加了**自装配**（LEADER agent 就绪即 `arm()`）。同命令、同场景重跑三臂（`pollMs=3000`）：

```bash
for m in scheduled autonomous off; do
  bash scripts/bench/exp-sched.sh --mode $m --out .runtime/bench/p39/$m
done
```

**① 前置是否成立（先验，再比指标）**

| 臂 | 前置 | 证据 |
|---|---|---|
| `scheduled` | ✅ **真派发** | `team_task_list`：task-1/task-2 = **`in_progress`**（由 `pending` 变） |
| `autonomous` | ✅ **真 nudge** | 空闲成员收到 nudge：alice `relay=4`、bob `relay=4` |
| `off` | ✅ 对照 | 任务恒 `pending`、0 nudge（`relay=0`），仅 2 个初始轮 |

→ **P38b 生效**：三种模式终于产生**可观测差异**（与 §1.0 旧「无差异」形成对照）。

**② 真差异对比**

| 臂 | 任务终态 | teammate 轮 / token | root token | 观察 |
|---|---|---|---|---|
| `scheduled` | **`in_progress`**（已派发） | 3 / 29,386 | 68,426 | 派发成功，1 名成员被 nudge |
| `autonomous` | `pending`（不派发） | **9 / 71,288** | 81,082 | **nudge 反复**（每 `pollMs` 重催空闲成员）→ teammate LLM ≈ **2.4×** scheduled |
| `off` | `pending` | 2 / 13,680 | 73,246 | 静默基线 |

原始：`.runtime/bench/p39/<arm>/raw.jsonl`。

**③ 判定与异常**

- **`scheduled` 默认必选 → 倾向【成立】（附前置）**：scheduled **能真派发**，且 teammate 开销（3 轮）**远低于** autonomous 的 nudge 反复（9 轮）→ 无人值守场景下 scheduled 的**开销/信噪更好**。
- ⚠️ **异常（待确认，非我改码）**：scheduled 派发后任务 **`ownerName=lead`**（非空闲成员 alice/bob）。源码意图是 `updateTask(action='claim', owner:m.name)`（`team-scheduler/src/index.ts:371`），但**原生 `claim` 以「调用者」为 owner、忽略 `owner` 参数**（同 #6 评审探针：`claim owner='alice'` → `ownerName:"lead"`）⇒ **“派发”可能未真正指派到成员**（任务归 lead、成员未被赋予），**存在停滞风险**。
- **【结论】**：scheduled 在**能派发 + 开销低**上成立，可作默认候选；但在**「claim 归属」确认/修复前，不写成“完全成立”**——建议 dev 侧核 `team-scheduler` 派发的 owner 语义（是否应改用 native 支持的 reassign，或领任务用成员身份）。

> **停滞**：本窗口内 scheduled 的 2 个任务停在 `in_progress` 未 `completed`（作业本身未完成，属预期）；但**因 owner=lead，成员未真正接手**——这是上面那条异常，需先确认再谈“是否停滞”。

---

## 2. #6 计划闸 / 评审闸 / stale（真实 profile）

**复现**（通用配置 overlay；`scripts/bench/exp-headless.sh`）：

```bash
# 计划闸探针（planGate=on）
bash scripts/bench/exp-headless.sh --plan-gate on  --enable-review off \
     --prompt-file .runtime/bench/prompt-plan.txt   --out .runtime/bench/p33-q-plan
# 评审探针（enableReview=on）
bash scripts/bench/exp-headless.sh --plan-gate off --enable-review on \
     --prompt-file .runtime/bench/prompt-review.txt --out .runtime/bench/p33-q-review
```

### 2.1 计划闸：**无工具入口 → 仍不可判定**

`team_task_update action='open_plan'` 的真实返回（原文）：

```text
Error: invalid arguments: "action" must be one of ["claim","release","edit","set_dependencies","complete","reopen","reassign","delete"]
```

→ 原生 `tool-agent-team` 的 `team_task_update` **action enum 不含计划闸动作**（`open_plan/submit_plan/approve_plan/reject_plan`），而 `tool-swarm` **不提供任务工具** ⇒ 模型**无法驱动计划闸**。
**判定【仍不可判定（前置缺失）】**。桩侧 S8 已验证端口行为（`planTransitions`、`illegalRejected=1`）——但**桩结论不可外推**，真实运行无入口。
**解锁条件**：把计划闸动作**暴露到真实 profile 的工具面**（扩 `team_task_update` enum，或由 `tool-swarm` 增任务动作工具）。

### 2.2 评审闸：可入闸，但 **`settle` 无入口 → 仍不可判定**

真实链路（`enableReview=on`，原文摘录）：

```text
team_task_update action='claim' → status:"in_progress" (ownerName:"lead")
review_submit                    → task task-1 under review (status=in_review)     ✅
review_vote (verifier)           → Error: TEAMREVIEW_SELF_VOTE: lead cannot review own task task-1
review_vote (challenger)         → Error: TEAMREVIEW_SELF_VOTE: ...
team_task_get                    → status:"in_progress"（未推进）
```

- **P18 `in_review` 态真实生效**（`review_submit` → `in_review`）✅。
- **【前置缺失-1】** `team-review.settle()` **无调用入口**（`packages/*` 内无 `.settle(` 调用点；`tool-swarm` 只暴露 `review_submit`/`review_vote`）⇒ **裁决无法触发**，任务停在 `in_review`。
- **【前置缺失-2】** 本次 `claim` 归 lead（`ownerName:"lead"`），触发**不可自验**（正确设计）——要端到端验证需**作者是成员**且由其认领（headless 下需成员自身跑一轮，观测更难）。
**判定【仍不可判定（前置缺失）】**。解锁条件：暴露 `settle`（或 auto-settle 触发点）+ 构造「作者=成员」的真实链路。

### 2.3 stale 自愈：**依赖未 arm 的 scheduler → 仍不可判定**

stale 由 `teamScheduler.scan` 的 `staleSweep` 产生；#5 已证 **scheduler 未 arm** ⇒ stale sweep 不运行。
**判定【仍不可判定（前置缺失，同 §1）】**。解锁条件：与 §1 同一个 arming 入口。

### 2.4 #6-F 四象限（真实只跑 3；`both off` 桩基线）

| 象限 | 结果（真实/桩） | 判定 |
|---|---|---|
| (plan on, review off) | 计划动作被 enum 拒（无入口） | 仍不可判定（前置缺失） |
| (plan off, review on) | review_submit→in_review ✅；vote 自验拒绝 + settle 无入口 | 仍不可判定（前置缺失） |
| (both on) | 同左（计划无入口）+ 评审前置缺失 | 仍不可判定（前置缺失） |
| **(both off)＝基线** | 桩 `S4 --review none --plan-gate off` → ok（零成本） | 基线 |

---

## 3. 判定表（带时序标注）

| # | 结论（出处） | 原结论（时序） | 真实 profile 重测（【P30·P31 后】） | 判定 |
|---|---|---|---|---|
| 1 | scheduler `scheduled` 自动派发（P13 §2 AB2/§3 Ab2） | 桩 `scan.started=2`【stub】；旧真实=无差异(未 arm)【no-op 时代】 | **P39（arming 后）**：真派发（→`in_progress`）✅ | **【成立】（附前置：claim 归属异常待确认）** |
| 2 | scheduler `autonomous` 只 nudge | 桩 `scan.started=0`【stub】；旧真实=无差异 | **P39**：真 nudge ✅；但**反复 nudge**（9 轮 vs scheduled 3 轮） | **【成立】**（并记录 autonomous 的 nudge 开销更高） |
| 3 | 解锁→唤醒延迟上界 + 不存活风险 + push | 未采集 | 机制级：测试档≈201ms／生产 30000ms；不 arm()⇒0；push≈0ms | **成立（机制级）**；真实 profile 未触发 |
| 4 | 计划闸合法性 + 「未批不能执行」（P30 新） | 桩 S8：`open_plan→planned…approve→pending`；`illegalRejected=1`【stub】 | 真实：`action='open_plan'` 被 enum 拒绝 → **无工具入口** | **仍不可判定（前置缺失）** |
| 5 | 评审闸 `in_review` + 裁决（P18/P30） | 桩 `reviewRounds=2`【stub】 | 真实：`review_submit→in_review`✅；`settle` 无入口 + 自验拒绝 | **仍不可判定（前置缺失）** |
| 6 | stale 自愈（P13 §2 AB3/§3 Ab1） | 桩 `staleNudged=2`/`escalations=1`【stub】 | 真实：scheduler 未 arm ⇒ 不运行 | **仍不可判定（前置缺失）** ⚠️ 受 **P38b arming 缺口**影响 |
| 7 | 广播 ≡ N DM（P13 §2 AB1） | 桩零差异【no-op 时代】 | 已由 P24 真实重测（见 `experiments-idle-wakeup.md §7`） | **仍成立**（等价，3=3） |
| 8 | bench model `messageDeliveries`（广播按 1 次计） | 口径限制 | 未变 | **仍成立**（口径限制） |

**小计**：**#1/#2（scheduler 派发 / nudge）=【成立】**（P39 arming 后；附 claim 归属待确认）；**#3（延迟，机制级）成立**；**#7/#8 成立**；
**#4/#5（计划闸/评审闸）= 仍不可判定（前置缺失）**；**#6（stale）= 仍不可判定（受 P38b arming 缺口影响）**。

---

## 4. 成本（本轮 / 5M）

| 批次 | 消耗 token | 时序 |
|---|---|---|
| #5 scheduled / autonomous / off | 100,302 / 68,598 / 68,814 | 【P30·P31 后】 |
| #6 计划闸探针 / 评审探针 | 28,535 / 63,435 | 【P30·P31 后】 |
| **P39 #5 三臂（arming 后）** | scheduled 68,426 / autonomous 81,082 / off 73,246（root；另 teammate 29,386/71,288/13,680） | 【P38b 后】 |
| 桩 S1–S8 + 四象限基线 | 0 | — |
| P31 延迟探针 | 0 | 机制级 |
| **P33 实测小计** | **≈ 329,684** | **≈ 6.59% / 5M** |
| **P39 #5 重测小计** | **≈ 337,108**（root 222,754 + teammate 114,354） | **≈ 6.74% / 5M** |

> 未触门禁（每臂 cap 500k；实际 28k–100k）。P17+P24+P27+P33 真实模型累计 ≈ 1.22M ≈ **24.4% / 5M**。

---

## 5. 复现清单

```bash
cd <项目>/dsh-swarm
# #5 三臂（真实 profile）
bash scripts/bench/exp-sched.sh --mode scheduled  --out .runtime/bench/p33-sched/scheduled
bash scripts/bench/exp-sched.sh --mode autonomous --out .runtime/bench/p33-sched/autonomous
bash scripts/bench/exp-sched.sh --mode off        --out .runtime/bench/p33-sched/off
# #6 探针（真实 profile）
bash scripts/bench/exp-headless.sh --plan-gate on  --enable-review off --prompt-file .runtime/bench/prompt-plan.txt   --out .runtime/bench/p33-q-plan
bash scripts/bench/exp-headless.sh --plan-gate off --enable-review on  --prompt-file .runtime/bench/prompt-review.txt --out .runtime/bench/p33-q-review
# 零成本
bash scripts/bench/run.sh --no-model --scenario S1,S2,S3,S4,S5,S6,S7,S8 --repeat 1
node scripts/verify-unblock-latency.mjs
```

---

## 6. 局限与诚实边界

1. **#5 三臂**为**单次取数**（每臂 1 次）；但三臂结果一致（全 pending）、且与源码（无 arming）互证，方向稳健。
2. **前置缺失**类判定（#2/#4/#5/#6）不是「测不出」，而是**真实 profile 缺入口/装配**——一旦补齐（arming 入口、工具动作、settle 入口），可立即按本报告 §1/§2 命令重测。
3. 观察面限制：P31 新增事件为**通知型（不 durable）**，故 durable 日志看不到 `swarm/task/unblocked` 等；本次以**任务状态（`team_task_list`）+ teammate 轮次（durable）**为主证。
4. 未做 `--repeat`；未做跨进程解锁推送（P31 自陈亦未打通跨进程）。
