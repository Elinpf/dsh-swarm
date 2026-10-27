# 「空转唤醒」长驻实验结论（experiments-idle-wakeup）

> P17 ｜ 负责人：bench-qa-engineer ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm` @ `main da032be`
> 纪律：结论必须可复现（命令 + 原始输出）；不能复现/跑不通的一律标【未采集】；反例优先。
> 承接：`docs/experiments-stage1.md §4`（P13 遗留的「空转唤醒」未决项）。
> 工具：`scripts/bench/exp-idle-wakeup.{sh,mjs}` + `scripts/bench/lib/longres.mjs`（长驻观测后端）。

---

## 0. 结论速览（TL;DR）

| 命题 | 判定 |
|---|---|
| **1. 广播后，未被寻址的成员会不会产生额外 LLM 轮（「被叫醒但无自己消息→不耗轮」）？** | **【证伪·但原因与设计无关】真实 profile 下广播根本不是「省轮」，而是「压根没叫醒任何人」**——`team-bus.broadcast` 扇出到 **0 个成员**。因此「额外轮=0」是**后端未接通的产物**，不是设计声明的实现。 |
| **2. 省下的轮次量级** | 不适用。对照组（原生 **N 次 DM**）实测：**每个 inactive 成员 +1 LLM 轮**（3/3，各 ~13.8k token）。若广播真按 `dm` 扇出，等价于 N 次 DM → **不省轮**；唯一「不唤醒」的模式是 `record-only`（仅落库可拉取）→ **完全不唤醒**，也就没有「被叫醒」这回事。当前实现中间**不存在**「唤醒但不投消息」的原语。 |
| **3. 找回窗口截断** | **已解决**：长驻观测（lead 反复 `wait_agent` 至静默）+ 按成员归属读 durable 会话，能完整观测 teammate 在 broadcast/DM 之后的轮次与 token。 |

**高价值反例（比原命题更重要）**：真实 headless profile 下，**dsh-swarm 协作插件栈（team-core/bus/review/completion/scheduler/tool-swarm）与原生 `ctx.agentTeams` 未打通**——
本 harness 自己的工具 `team_summary` 实测 `members=0`，而同一次运行里**原生** `list_agents` 显示 `lead+alice+bob` **3 人**。
这解释了为何广播在真实运行下无任何效果；此前所有 A/B 都在 **stub**（端口 mock）下做，故从未暴露。**详见 §3。**

**本轮实际消耗（真实模型）**：**≈ 428k token ≈ 8.6% / 5M**（另有一次被 `timeout` 杀死的早期探针，流被 block-buffering 吞掉，**未采集**，上限估计 ≲0.11M）。见 §5。

---

## 1. 方法：长驻观测（为什么、怎么做）

**截断问题（P13 遗留）**：`dsh headless` 在 **root 轮结束即退出**。P13 的 S7 里广播下发后，teammate 的下一轮往往还没开始、进程就退了，durable 日志里看不到广播消费 → 无法区分「省轮」与「截断」。

**长驻观测**：让 lead 在广播/DM 之后**反复 `wait_agent` 直到静默**，使 teammate 有时间消费 pending inbox，再按成员归属统计 durable 会话。
关键实现细节（实测发现，已固化进 `lib/longres.mjs`）：

- `wait_agent` 在**没有活跃 peer**时**立即**返回 `{"timedOut":false,"noProgress":{"reason":"no-active-peer"}}`（不会等满 20s）；
  因此在「teammate 已空闲」的情况下，它对**唤醒事件**的观测体现在「返回非 `no-active-peer` 的一次变化」上。
- teammate 的**初始轮** = spawn 时下发初始 prompt 触发的 `turn=1`；**唤醒后额外轮** = `turns-1`，并与「是否收到 team 转发消息」（durable 里 `user/message.source.kind==='agent-message'`）交叉核对。
- teammate token/turn 从 durable 会话 `assistant/message.usage` 累加（多帧 zstd，用 `zstd -dc` 全量解）。

**复现命令**（经隔离环境入口；真实模型模式默认 cap=500k/arm，硬顶 5M 不可上调）：

```bash
cd <项目>/dsh-swarm
# 零成本自检：合成 durable 会话，验证「按成员归属统计轮次」采集管道
bash scripts/bench/exp-idle-wakeup.sh --self-test

# 真实模型（长驻观测）：广播臂 + N-DM 对照臂
bash scripts/bench/exp-idle-wakeup.sh --arm both --members alice,bob,carol \
     --token-cap 500000 --turn-cap 30 --timeout-ms 600000 --out .runtime/bench/exp-idle-wakeup
```

自检输出（零模型成本）：

```text
[PASS] teammate 数 = 2
[PASS] alice turns = 2
[PASS] alice 收到 relay = 1
[PASS] alice relay 轮 = [2]
[PASS] alice tokens total = 305
[PASS] bob turns = 1
[PASS] bob 无 relay
[PASS] 按成员归属名映射正确
自检结果：全部通过
```

---

## 2. 原始证据

> members = `alice,bob,carol`（3 人），模型 `DeepSeek-Flash`，各成员初始 prompt 均为「Reply with exactly X and then stop」。

### 2.1 广播臂（长驻）

`bash scripts/bench/exp-idle-wakeup.sh --arm broadcast --members alice,bob,carol --token-cap 500000 --timeout-ms 600000`

root 工具序列（`--json` 流，`tool_call`/`tool_result` 原文摘录）：

```json
call spawn_teammate {"name":"alice",...}
  res {"member":{"target":"alice","role":"teammate","status":"running",...}}
call spawn_teammate {"name":"bob",...}      -> res status":"running"
call spawn_teammate {"name":"carol",...}    -> res status":"running"
call wait_agent {"timeout_ms":20000}
  res {"timedOut":false,"noProgress":{"reason":"no-active-peer","message":"No other Team member is running or provis..."}}
call broadcast {"content":"FYI standup moved to 5pm; no action required.","topic":"announce"}
  res broadcast sent: bcast-1
call wait_agent {"timeout_ms":20000}  -> res {"timedOut":false,"noProgress":{"reason":"no-active-peer",...}}   (x4)
call list_agents {} -> res [{"target":"lead",...,"status":"running"},{"target":"alice",...,"status":"inactive"},...]
```

逐成员归因（`result-broadcast.json` / `result-broadcast.csv`）：

| 成员 | turns | 额外轮(>初始) | 收到 relay | relay 轮 | tokens |
|---|---|---|---|---|---|
| alice | 1 | 0 | 0 | [] | 6833 |
| bob | 1 | 0 | 0 | [] | 6850 |
| carol | 1 | 0 | 0 | [] | 6833 |

- **额外 teammate LLM 轮合计 = 0**；消费唤醒的成员数 = **0/3**。
- root token 80,282（in/out 视流），root+teammate total = **100,829**。
- 直接检查三名 teammate 的 durable 会话：`agent/inbox/spliced` **只有初始 prompt 一条插入**，**广播消息从未进入其 inbox**（`relayInbound=0`）。

### 2.2 对照臂：N 次 DM（同场景）

`bash scripts/bench/exp-idle-wakeup.sh --arm n_dm --members alice,bob,carol --token-cap 500000 --timeout-ms 600000`

root 工具序列摘录：

```json
call spawn_teammate (alice/bob/carol)  -> 3x status":"running"
call wait_agent timeout_ms=20000       -> {"timedOut":false,"noProgress":{"reason":"no-active-peer",...}}
call send_message {"target":"alice",...} -> {"sent":true}
call send_message {"target":"bob",...}   -> {"sent":true}
call send_message {"target":"carol",...} -> {"sent":true}
call wait_agent timeout_ms=20000       -> {"timedOut":false}     <-- 有变化：teammate 被唤醒
call wait_agent ...                    -> {"timedOut":false,"noProgress":{"reason":"no-active-peer",...}} (x3)
```

逐成员归因：

| 成员 | turns | 额外轮(>初始) | 收到 relay | relay 轮 | tokens |
|---|---|---|---|---|---|
| alice | **2** | **1** | **1** | **[2]** | 13,926 |
| bob | **2** | **1** | **1** | **[2]** | 13,871 |
| carol | **2** | **1** | **1** | **[2]** | 13,837 |

- **额外 teammate LLM 轮合计 = 3**；消费唤醒的成员数 = **3/3**。
- root+teammate total = **149,448**。

**对照结论**：同场景下，**原生 N 次 DM 让 3/3 个 inactive 成员各多跑 1 个 LLM 轮（各 ~13.8k token）；广播 0/3。**
两者差 3 个 LLM 轮、约 41.6k teammate token。**但**这**不是**「广播设计省轮」——见 §3。

### 2.3 定位：广播为什么 0 唤醒？

**诊断探针**（spawn 2 成员 → `team_summary` → `broadcast` → `team_summary` → `list_agents`）：

```text
CALL spawn_teammate {"name":"alice",...} -> {"member":{"target":"alice",...,"status":"running",...}}
CALL spawn_teammate {"name":"bob",...}   -> {"member":{"target":"bob",...,"status":"running",...}}
CALL team_summary {}                     -> members=0; tasks=0          <-- 本 harness 工具（走 team-core）
CALL broadcast {"content":"hello team"}  -> broadcast sent: bcast-1
CALL team_summary {}                     -> members=0; tasks=0
CALL list_agents {}                      -> [{"target":"lead",...},{"target":"alice",...,"status":"inactive"},{"target":"bob",...}]
```

**同一次运行**里：
- **本仓库插件工具** `team_summary`（内部 `ctx.teamCore.listMembers`）报告 **`members=0`**；
- **原生** `list_agents`（`ctx.agentTeams`）报告 **3 人**。

`team-bus.broadcast` 的扇出目标正是 `ctx.teamCore.listMembers(caller)`；`listMembers` 返回空 ⇒ `targets=[]` ⇒ **扇出到 0 人**（`broadcast` 仍返回 `bcast-N`，因为落库发生在扇出之前，且 `deliver` 对空目标静默）。
故真实运行下**广播不投递给任何成员**，自然不产生额外轮。

> 旁证：两臂的 root durable 会话里都**没有** `team/message/*` 事件（该序列由 agent-team 记录），且广播臂 stderr **空**（`team-bus.deliver` 的失败会被 `catch` 吞成 `logger.warn`，未落到 stderr）——与「扇出到 0 人、无异常」一致。

---

## 3. 结论与判定

### 3.1 命题 1 的判定

**「被叫醒但无自己消息 → 不耗 LLM 轮」在真实 profile 下未被证实为设计属性；观察到的「广播 0 额外轮」是后端未接通的产物（反例）。**

两种设计路径都与该声明不符：

- **`fanout: 'dm'`（默认）**：1 次落库 + **逐人 DM**。DM 对 inactive 成员会**启动一个 turn**（§2.2 实证 + P13 §4 发现 A）。⇒ 若后端接通，广播会让**全体 N 个成员各 +1 轮**，与「N 次 DM」**等价，不省轮**。
- **`fanout: 'record-only'`**（`packages/team-bus/src/index.ts:167`，opt-in）：**不逐人 DM**、仅落库 + 通知本进程订阅者，成员按需 `history()` 拉取。⇒ **完全不唤醒**任何成员（没有任何信号送达），也就**不存在**「被叫醒」这一状态。

⇒ 当前实现里**不存在**「唤醒成员但不投递内容」的原语，因此「被叫醒但无自己消息不耗轮」这一声明**在实现层面无对应机制**（既非证实也非仅截断，而是**不适用/证伪于当前实现**）。

### 3.2 命题 3：窗口截断

**已解决**。长驻观测（§1）在同一次运行内成功观测到 N-DM 臂的 3 个「唤醒后额外轮」（relay 轮=[2]），证明观测窗口**足以**涵盖 teammate 消费唤醒后的下一轮。广播臂的「0 轮」是**真 0**（消息从未入 inbox），不是截断。

### 3.3 解锁条件（若要判定「设计意图」本身）

要判定「唤醒但不投消息是否省轮」这一**设计意图**，需要先：
1. **修复 §3.4 的后端接通问题**（否则广播恒为 no-op，任何实验都无意义）；
2. 增加一个**真正的「信号-only 唤醒」原语**（唤醒成员但 inbox 无内容，随后该成员决定不跑 turn）——当前 `record-only` 是「不唤醒」，`dm` 是「唤醒+内容」，都不是该原语；
3. 或在**设计层**明确否认该声明（把 `record-only` 定位为「按需拉取」而非「省轮唤醒」）。

### 3.4 【高优先级缺陷】协作插件栈与原生 agentTeams 未打通

- **事实**：真实 headless profile 下，`team-core` 的 `listMembers` 返回空（`team_summary` → `members=0`），而原生 `list_agents` 显示 3 人。
- **影响**：`team-bus`（broadcast/multicast）、`team-review`、`team-completion`、`team-scheduler`、`tool-swarm` 的 team-core 依赖能力在真实运行下**全部实质失效**（no-op）；它们此前只在 **stub（端口 mock）** 与 **进程内 verify**（也带 mock seam）下被验证过，从未在真实 profile 功能验证。
- **最可能根因（推断，待插件 owner 证实）**：`team-core` 用**非响应式** `ctx.get('agentTeams')` 在**构造期**取服务（`packages/team-core/src/index.ts:138`），而 `agentTeams` 未列入其 `inject`；若该服务在 `team-core` 构造时尚未发布（或作用域不可见），即落入 no-op。
- **建议修复方向**：把 `agentTeams`（或经 `TeamCorePort` 收敛后的端口名）加入 `team-core` 的 `inject`，以**响应式**方式获取；或显式在 bundle patch 中保证 `agent-team` 先于 `team-core` 完成激活。修好后**必须**在真实 profile 上复跑本实验以重判命题 1。
- **责任边界**：本报告只提出**可复现证据与推断**；实现修改属插件 owner（非本角色）。

---

## 4. 成本核算（本轮 / 5M）

| 批次 | 场景 | 消耗 token | 说明 |
|---|---|---|---|
| 早期探针（被 `timeout` 杀） | 广播-长驻 | **未采集** | stdout block-buffering，被杀时流丢失；上限估计 ≲0.11M |
| 诊断探针 | spawn2+team_summary+broadcast | 52,764（root）+ ~13.6k（teammate） | `probe-summary` |
| 广播臂（run#1） | broadcast ×3 成员 | 100,829（root+teammate） | 最终采信之一 |
| 对照臂 | n_dm ×3 成员 | 149,448（root+teammate） | 对照 |
| 广播臂（run#2，带 stderr 复核） | broadcast ×3 成员 | 100,829 | 复现 |
| 桩模式自检 | — | 0 | 合成 durable，无模型 |
| **本轮实测小计** | | **≈ 428k** | **≈ 8.6% / 5M**；另加 1 次被杀探针【未采集】 |

> 单次任务上限 5,000,000；**本轮真实模型实测约 0.43M ≈ 8.6%**，余量充足；全程未触发门禁（cap=500k/arm，实际 100k–149k/arm）。桩模式**零模型消耗**。

---

## 5. 局限与未验证项

1. **广播臂的「0 轮」不可解读为「省轮」**：它是 §3.4 后端 no-op 的产物。修复后端后必须重跑。
2. **`record-only` 未在真实模型下测**（需后端接通 + 该横幅无 DM，按定义即 0 唤醒，无「被叫醒」可言）。
3. **teammate token** 从 durable `assistant/message.usage` 累加；**重试 attempt 的额外用量未计**，属轻微低估。
4. **单次取数**（未做 `--repeat`）：受成本约束，每臂单跑；两组关键数字（0/3 vs 3/3）差异极大、且在两次独立广播运行中一致，方向稳健，但仍无区间。
5. **根因属推断**：§3.4 的「构造期非响应式取服务」为最可能解释，未由插件 owner 最终确认。

---

## 6. 复现清单

```bash
cd <项目>/dsh-swarm
# 零成本：采集管道自检
bash scripts/bench/exp-idle-wakeup.sh --self-test
# 真实模型：广播臂 + N-DM 对照（长驻观测；cap 500k/arm）
bash scripts/bench/exp-idle-wakeup.sh --arm both --members alice,bob,carol \
     --token-cap 500000 --turn-cap 30 --timeout-ms 600000 --out .runtime/bench/exp-idle-wakeup
# 定位诊断（原生 vs 本插件可见成员数）
bash scripts/run-headless.sh --json "$(cat <<'P'
You are the team lead. Do in order, one tool call at a time, report raw results:
1) spawn_teammate name='alice' description='w1' prompt='Reply with exactly A and stop.'
2) spawn_teammate name='bob' description='w2' prompt='Reply with exactly B and stop.'
3) team_summary. 4) broadcast content='hello team' topic='team'. 5) team_summary. 6) list_agents. 7) reply DONE.
P
)"
# 期望：team_summary=members=0 而 list_agents 显示 3 人 → 复现 §3.4
```

机器可读结果：`.runtime/bench/exp-idle-wakeup/result-<arm>.{json,csv}`、`raw-<arm>.jsonl`、`stderr-<arm>.log`、`SUMMARY.md`。

> 诚实边界：本报告给出**明确结论（证伪于当前实现；真因是后端 no-op）**，而非「不可判定」——因为广播的 0 唤醒已由「同运行 `team_summary=0` vs `list_agents=3`」定位到明确原因，可直接复现。
