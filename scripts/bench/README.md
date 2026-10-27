# 基准 harness（scripts/bench）

> 「可复现、成本有界、可对比」的公共底座：后续所有 A/B、消融、以及与 JiuwenSwarm 的对比测试都跑在这上面。
> 责任：**可复现的实验**——一切结论都要有可复现命令与原始输出；不能复现的标【未采集/未验证】。

## 1. 快速开始

```bash
cd <项目>/dsh-swarm

# ① 离线桩模式（零模型成本，验证管道与口径；先跑这个）
bash scripts/bench/run.sh --no-model --scenario S1,S2,S3,S4,S5 --repeat 3

# ② 真实模型模式（复用 scripts/run-headless.sh 的 llm-pi-ai overlay）
bash scripts/bench/run.sh --scenario S1 --token-cap 300000

# ③ A/B 与消融（桩模式，零成本；开关只影响桩后端）
bash scripts/bench/run.sh --no-model --scenario S2 --repeat 7 --delivery n-dm
bash scripts/bench/run.sh --no-model --scenario S6 --sched-mode scheduled --scheduler on
bash scripts/bench/run.sh --no-model --scenario S4 --review none
bash scripts/bench/run.sh --no-model --scenario S5 --stale off

# 列出场景
bash scripts/bench/run.sh --list

# ④ 长驻观测（「空转唤醒」专题）：绕过 headless「root 轮结束即退出」的窗口截断
bash scripts/bench/exp-idle-wakeup.sh --self-test            # 零成本：合成 durable，验证采集管道
bash scripts/bench/exp-idle-wakeup.sh --arm both --members alice,bob,carol \
     --token-cap 500000 --timeout-ms 600000                 # 真实模型：广播臂 vs N-DM 对照臂
```

**A/B 与消融开关**（仅桩后端；默认=基线全开）：`--scheduler on|off`、`--review gate|none`、
`--delivery bus|n-dm`（广播实现：team-bus 扇出 / N 次 DM）、`--stale on|off`（stale 自愈）、
`--sched-mode autonomous|scheduled`、`--broadcast-fanout dm|record-only`（广播扇出：逐人 DM / 仅落库可拉取，
对应 `team-bus` 的 `fanout` 参数，见 `docs/optimization-log.md §2`）。它们只切换**配置/实现路径**，
不裁剪场景、不改指标口径。

`run.sh` 会 `source scripts/env.sh` 进入隔离环境（隔离 Node/HOME/`DSH_HOME`，无代理直连），
**不改 `/root/.dsh`，不影响现有运行实例**。密码/密钥仅经环境变量注入，不打印、不落盘。

结果落 `./.runtime/bench/<ts>-<backend>/`（已 gitignore）：每场景 `result.json`（全量含事件）、
`result.csv`（每样本一行，机器可读）、以及顶层 `SUMMARY.md`（人读摘要）。

## 2. 两种后端

| 后端                  | 触发         | 跑什么                                                                      | 成本                 | 给什么数字                                                                                                                                           |
| --------------------- | ------------ | --------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stub**（离线桩）    | `--no-model` | 真实 cordis 运行时加载**真实插件产物** + 端口 mock（模拟 `ctx.agentTeams`） | 0（无网络/无模型）   | 结构指标**真实**：投递、唤醒、空转唤醒、任务状态停留、重试、CAS、stale 自催、进程/磁盘。**LLM 轮次/token = 未采集**（无 LLM）                        |
| **model**（真实模型） | 默认         | 复用 `run-headless.sh` 驱动 `dsh headless --json`                           | 有（token 门禁保护） | 端到端时延、LLM 轮次、token(in/out/total)、工具调用计数、重试(=error 工具结果)、磁盘增量。**wakeups/空转唤醒/teammate token = 未采集**（见 §5 局限） |

> stub 与 model **不可直接互相比较轮次/token**：stub 没有 LLM。跨后端只能比「结构量」（如投递次数）在两端是否一致。

**长驻观测后端（`exp-idle-wakeup`，P17 新增）**：`scripts/bench/exp-idle-wakeup.{sh,mjs}` + `lib/longres.mjs`。
它专治「`dsh headless` 在 root 轮结束即退出 → teammate 可能在广播后被唤醒但来不及跑下一轮」的**窗口截断**：
让 lead 在广播/DM 后**反复 `wait_agent` 至静默**，再按成员归属读 durable 会话，逐成员给出 `turns / tokens / relayInbound(是否收到 team 转发消息) / 额外轮`。
- **口径**：teammate 初始轮 = spawn 初始 prompt 的 `turn=1`；**唤醒后额外轮 = `turns-1`**，并与 `relayInboundCount>0`（durable 里 `user/message.source.kind==='agent-message'`）交叉核对。
- **注意**：`wait_agent` 在**无活跃 peer** 时**立即**返回 `{"timedOut":false,"noProgress":{"reason":"no-active-peer"}}`（不等满 timeout）；对「唤醒事件」的观测体现为**返回非 `no-active-peer` 的一次变化**。
- 结论见 `docs/experiments-idle-wakeup.md`（含一个**高价值反例**：真实 profile 下协作插件栈与原生 `ctx.agentTeams` 未打通）。

## 3. 指标口径（每个数字到底怎么算）

**通用**

- `e2eMs`：一次场景从开始执行到结束的墙钟毫秒（stub=进程内耗时；model=子进程 `dsh` 启动到退出的耗时，含冷启动）。
- `messageDeliveries`：底层消息投递次数。
  - stub：`teamCore.send` 被调用次数（广播/多播的**每个收件人各算 1 次**，与真实扇出一致）。
  - model：`send_message` 工具调用数 + `multicast` 工具调用数（**广播扇出人数不在 root 流内**，故广播按 1 次调用计，不含扇出）。
- `broadcasts` / `multicasts`：广播 / 多播的**调用**次数。
- `retries`：
  - stub：`flakyDm` 步骤中底层投递抛错的次数（模拟瞬时失败重试）。
  - model：`tool_result.status == "error"` 的次数。

**唤醒（stub 专有，结构性）**

- `wakeups`：`delivery=='wakeup'` 的投递次数。
- `wakeupsDirect`：由**直接调用**（DM/nudge）产生的唤醒。
- `wakeupsFanout`：由**广播/多播扇出**产生的唤醒（`teamCore.send` 在 bus fanout 窗口内被调用）。
- `spinWakeups`（**空转唤醒**）：`wakeupsFanout` 中，收件人**既无自己的直接消息、也无自己名下任务**的那些——
  即「被广播叫醒但没有自己的事」的成员。按成员计数见 `spinWakeupsByMember`。
  > 这是本 harness 对「被叫醒但无自己消息不耗 LLM 轮」这一设计声明的**结构侧度量**；
  > LLM 轮侧是否真不耗，须由 model 后端/P13 用真实数据判定（stub 无 LLM）。

**任务**

- `tasks[]`：每任务的最终 `status/ready/owner`。
- `taskDwellMs`：按状态聚合的停留时长（相邻状态事件时间差），并给每任务的 `#<id>` 序列。
- `casConflicts`：`expectedRevision` 不匹配被拒的次数（乐观并发冲突）。
- `staleNudged`：`teamScheduler.scan()` 报告里 `staleNudged` 之和（卡住任务自催）。
- `escalations`：内容含 `[escalation]` 的投递数（stale 连续无果升级 Lead）。
- `reviewRounds`：评审裁决次数（`reviewSettle` / model 下 `review_submit`+`review_vote`）。

**LLM（model 专有）**

- `llmTurns`：JSON 流中 `status.turn_start` 的**最大 turn 值**（= root 会话的轮数）。
- `tokens.input/output/total`：累加每个 `status.step_end.usage`（来自官方 `dsh-headless/json-stream`；
  重试的 attempt usage 已被上游正确累计）。
- `toolCalls.byName`：`tool_call` 事件按工具名计数。

**teammateActivity（model 专有，来自 durable 会话日志）**

- `teammateCount` / `teammateTurns` / `teammateTokens`：root 会话通过 `subagent/catalog` 显式引用的**子会话**（= teammate）
  的轮次与 token 之和。**这是 `--json` 看不到的部分**——只投影 root。
- 口径：teammate token = 其 durable 日志 `assistant/message.usage` 累加（重试 attempt 的额外用量**未计**，属轻微低估）。
- durable 日志是**多帧 zstd**，用 `zstd -dc` 全量解（`node:zlib` 只解首帧 → 会漏数据）。
- **用途**：真实团队总成本 = `tokens.total`(root) + `teammateTokens`；实测 root-only **低估 18–36%**（见 `docs/experiments-stage1.md §4`）。

**开销**

- stub `process.rss*Bytes` / `heapUsed*Bytes`：场景执行前后 `process.memoryUsage()`。
- `disk`：stub 为沙箱目录字节差；model 为 `DSH_HOME/sessions` 目录字节差（durable 会话写入量）。

## 4. 成本门禁（真实模型模式）

- **默认上限 `--token-cap 5000000`（5M，用户指定）；`--token-cap` 可下调，绝不可上调**（硬顶在代码里拦截）。
- 量化：子进程流式运行中累加 `step_end.usage` 的 `totalTokens`，**一旦超限立即 `SIGKILL` 子进程并标记 `ABORTED`**，
  不等跑完。另设 `--turn-cap`（默认 64）作轮次兜底、`--timeout-ms` 作墙钟兜底。
- **超限后的实际消耗会略高于 cap**：usage 在 `step_end` 才返回，故最多超出「最后一个 step」的量（观测约 1 个 step）。
  报告会同时给出 `consumedTokens` 与 `cap` 及占比，绝不隐藏这个 overshoot。
- 每次运行打印并写入：`实际消耗 / cap`（比例），输入/输出/总 token，LLM 轮次，耗时。
- **纪律**：先 `--no-model` 跑通口径，再按「几千~几万 token」小规模验证采集，最后才考虑放大到接近上限。
  若某场景按设计必然超 5M，**不裁剪场景凑数**——先上报 Leader 裁决。

## 5. 如何新增场景

1. 在 `scripts/bench/scenarios.mjs` 的 `SCENARIOS` 加一项，**同时给出**：
   - `stub`：步骤计划（见下 ops 表）；需要自定义调度参数时加 `scheduler: {...}`。
   - `model`：交给 lead 会话的中文指令（要求模型逐步执行并原样回报工具结果）。
   - `modelExpect`：松断言（最少工具调用数、期望出现的工具名）。
2. stub 步骤 ops：`spawn / dm / broadcast / multicast / taskCreate / taskClaim / taskComplete /
taskSetDeps / reviewSubmit / reviewVote / reviewSettle / scan / sleep / flakyDm / wait`。
3. 跑 `--no-model` 验证；确认指标合理后，再用小 `--token-cap` 跑 model 验证。
4. 在 `docs/benchmark.md` 追加基线行与口径说明。

## 6. 已知局限（哪些指标不能直接跨系统对比）

1. **stub 无 LLM**：`llmTurns`/`tokens` 在 stub 为 `null`。任何「轮次/token」对比必须在 model 后端、且对齐模型与提示词规模。
2. **model 只投影 root 会话**：`dsh headless --json` 只输出 **lead（root）** 的事件；teammate 各自的 turn/token **不在流内**。
   现已用 `teammateActivity`（读 durable 会话日志，按 `subagent/catalog` 归属）补齐 teammate 轮次/token；
   但 `wakeups/spinWakeups`（结构性唤醒分类）在 model 仍记 `null`（不在任何日志）。
   且注意：headless 在 **root 轮结束即退出**，teammate 若在广播后被唤醒可能**来不及跑下一轮**（见 `docs/experiments-stage1.md §4`）。
   **P17 已用长驻观测解决该截断**（`exp-idle-wakeup`，见 §2 长驻观测后端）：能在同一次运行内观测到 teammate 唤醒后的额外轮。
3. **`e2eMs` 含冷启动**：model 模式首次启动含 DSH 冷启动（数秒~数十秒），跨系统比时延必须先剥离冷启动或只比同后端增量。
4. **广播扇出在 model 端不可见**：model 的 `messageDeliveries` 不含广播扇出人数，与 stub 的口径不同，**不可直接比**。
5. **投递语义为「调用即计数」**：stub 计 `teamCore.send` 调用，不校验真实网络/持久化成功；失败恢复只覆盖 mock 的瞬时失败路径。
6. **与 JiuwenSwarm 对比**：只有「结构量」（如一次广播的扇出投递数、任务状态机步数）在口径对齐后可比；
   时延/token 受实现、模型、提示词差异影响，**默认不可比**，须显式声明对齐项。详见 `docs/jsfw-comparison-fixture.md`。

## 7. 目录

```
scripts/bench/
  run.sh               # 一键入口（source 隔离环境后 exec bench-run.mjs）
  bench-run.mjs        # CLI 编排：场景×repeat×后端，成本门禁，导出
  scenarios.mjs        # 场景集 S1–S5（声明式，stub 计划 + model 指令）
  lib/stub-backend.mjs # 离线桩：真实插件 + 仪表化端口 mock
  lib/model-backend.mjs# 真实模型：dsh headless --json 解析 + 门禁
  lib/metrics.mjs      # 口径聚合 + JSON/CSV/markdown 导出
  lib/sessions.mjs     # durable 会话解析：按成员归属统计轮次/token/relayInbound（长驻观测用）
  exp-idle-wakeup.sh   # 长驻观测一键入口（source 隔离环境后 exec exp-idle-wakeup.mjs）
  exp-idle-wakeup.mjs  # 「空转唤醒」长驻实验驱动：广播臂 vs N-DM 对照 + --self-test
  lib/longres.mjs      # 长驻观测后端：静默等待 + 逐成员归因
  README.md            # 本文件
  jsfw/                # JiuwenSwarm 侧隔离对照夹具（P12；口径与结论见 docs/jsfw-comparison-fixture.md）
    probe_min_team.py       # STAGE-1：隔离 HOME 下构建 + 配置最小 leader TeamAgent
    probe_stage2_actions.py # STAGE-2：驱动建队/建成员/DM/广播/任务 DAG/评审闸 六个动作
    probe_out.log           # STAGE-1 实跑输出（证据，`[probe]` 行；exit=0）
    stage2_out.log          # STAGE-2 实跑输出（证据，`[stage2]` 行；exit=0）
    .gitignore              # 忽略运行态 .jsfw-home/ 与框架日志 logs/（均由探针重建，不入库）
```

**`jsfw/` 的两类产物**：

- **入库的证据**：两个 `*.py` 探针脚本 + `probe_out.log` / `stage2_out.log`（P12 验收证据，`docs/jsfw-comparison-fixture.md §2` 逐行引用）。
- **不入库的运行态**（`jsfw/.gitignore` 排除、由探针重建）：`.jsfw-home/`（隔离 `OPENJIUWEN_HOME`：sqlite DB + WAL/SHM + 会话消息 + 任务 + 锁）与 `logs/`（框架默认日志，相对进程 CWD 生成、自带一层 `logs/logs` 嵌套，属非证据的旁生产物）。复现命令见 `docs/jsfw-comparison-fixture.md §1.3`（跑前 `rm -rf .jsfw-home` 保证冷启动）。
