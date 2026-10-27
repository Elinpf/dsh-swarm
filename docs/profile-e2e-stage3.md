# 阶段 3 真实 profile 端到端验证（跨进程 + 人类席位）

> 执行人：dsh-env-engineer ｜ 任务：P20-e2e-stage3 ｜ 项目：`dsh-swarm`
> 时间：2026-10-27 ｜ 隔离环境：项目内 `.runtime/`（不碰 `/root/.dsh`、不改系统 node、不挂代理）

## 0. 结论（先说要点）

**P15 交付时诚实登记的限制已被推进。** P15 的四条「不丢不重」（V1–V4）与重连状态机当初只在**内存双工 mock**上验证，
`ctx.ssh`/`ctx.subprocess` 真实帧 API 未实测、真机跨进程未跑、journal 是内存 seam。本轮把它们搬到**真实 OS 进程边界**上重验：

| 验证 | 落点 | 结果 | 真实程度 |
|---|---|---|---|
| V1 不丢（丢 ack → 重连重放 → 终态补齐） | `team-transport-xproc.mjs` | ✅ PASS | **真实**：真实 `ctx.subprocess` spawn 真实子进程 + 真实 stdio；**真实 terminate 杀进程**后重连重放 |
| V2 不重（重复帧 → 恰好一次） | `team-transport-xproc.mjs` | ✅ PASS | **真实**：协议探针在真实子进程里重复发帧，接收端真实去重（`dedupDropped=3`） |
| V3 崩溃恢复（queued-minus-delivered 重放） | `team-distributed-journal-xproc.mjs` | ✅ PASS | **真实**：**两个不同 OS 进程**，journal 原子落盘 → 重启后从磁盘 `recover()`，`replayed=3` 且重复投递幂等 |
| V4 断线重连（sinceSeq 增量补齐） | `team-transport-xproc.mjs` | ✅ PASS | **真实连接**（真杀进程→degraded→重连）；增量补齐的对端历史由探针模拟保留（原因见 §3.4） |
| 有界队列（未 ack 超上界不隐式丢） | `team-transport-xproc.mjs` | ✅ PASS | **真实**：真实 relay 不回 ack，`queueDropped=2, pending=3` |
| 人类席位：路由 + 阻塞→输入→继续 + 离线补投 | `team-human-xproc.mjs` | ✅ PASS | 产品代码真实；「人类输入」来自**真实独立子进程**（原因见 §5） |

**一键复现**：`bash scripts/e2e-stage3.sh` → `PASS=4 FAIL=0`。

**真实模型调用消耗：0 / 5M token**（本轮全部用 `--no-model` 与离线 harness 打通管道，未触发真实模型）。

**仍未在真实环境证到 / 无法在此环境验证的项**（详见 §6.2）：ssh-rpc 后端（缺 `dsh-ssh`）、完整 dsh peer 作为对端
（transport 无「对端入站 attach」公开面）、人类真实 UI（profile 装配了 `dsh-user-questions` 服务但无 answerer/UI）。

---

## 1. 前置与可复现命令

阶段 3 实现（P15/P25）与本地隔离环境就绪后：

```bash
cd <repo>
bash scripts/e2e-stage3.sh          # 一键：profile 回归 + 跨进程 + 崩溃恢复 + 人类席位
```

单步：

```bash
bash scripts/e2e-profile.sh --no-model                    # 真实 profile 回归（离线）
node scripts/team-transport-xproc.mjs                     # 跨进程 transport（真实子进程）
node scripts/team-distributed-journal-xproc.mjs           # V3 真实进程重启 + journal
node scripts/team-human-xproc.mjs                         # 人类席位
```

> 所有 harness 均 `import` **构建产物** `packages/*/lib/`，因此运行前需 `pnpm build`（`e2e-stage3.sh` 依赖已构建库）。

全链路门禁（本轮实测）：

```console
$ pnpm test
packages/team-transport  Tests 13 passed / packages/team-distributed  Tests 10 passed / packages/team-human  Tests 9 passed
…（各包 vitest 全绿）                                        TEST_RC=0
$ pnpm verify
✅ 加载验证通过：全部插件可被真实 cordis 运行时加载并观察到预期行为。  VERIFY_RC=0
```

> 注：嵌套 `pnpm`（scripts 里写死的 `pnpm -r …`）须解析到**项目内 pnpm**，否则会命中系统 pnpm → corepack 联网下载卡死。
> 本环境用 `.runtime/bin/pnpm` shim（`.runtime/bin` 在 `scripts/env.sh` 中已置 PATH 最前）解决；均在 `.runtime/` 内，不影响系统。

依赖到的真实 DSH 服务（来自本仓 `node_modules`，与 profile 内一致）：
`@deepseek-ai/dsh-subprocess-local`（`ctx.subprocess`）。传输对端默认用**产品自带** `packages/team-transport/relay/relay.mjs`。

---

## 2. 真实 profile 回归（`--dump-config`）

命令：`bash scripts/e2e-profile.sh --no-model`

```console
>>> [2/4] --dump-config 断言
  [PASS] @elinpf/dsh-swarm-bundle 自身插入行数 = 14 (期望 14；阶段3 追加 transport/distributed/human)
  [PASS] 阶段3 新增插件行逐一存在 = 3 (期望 3: transport/distributed/human)
  profile 服务可用性: subprocess=1 ssh=0 user-questions=1
  [PASS] profile 提供 ctx.subprocess（local-child 后端前置） = 1 (期望 1)
  [PASS] 原生 agent-team / tool-agent-team 行存在（来自 agent-team-profile） = 2 (期望 2)
  [PASS] legacy tool-subagent* 为 disabled 的行数 = 4 (期望 4)
  [PASS] dump-config 无禁用/不兼容告警
>>> [wiring] 零成本原生接通回归（scripts/verify-native-wiring.mjs）
  [PASS] 原生接通（team-core ↔ ctx.agentTeams，P22 回归）
结果：PASS=7 FAIL=0
```

要点：
- 阶段 3 三行 `team-transport` / `team-distributed` / `team-human` **确实出现在展开后的 dump 里**，且**无禁用/不兼容告警**；
- profile **提供** `ctx.subprocess`（`@deepseek-ai/dsh-subprocess-local`，`- id: subprocess`），这是 local-child 后端的前置；
- profile **不提供** `ctx.ssh`（`ssh=0`）→ ssh-rpc 后端在本环境无法验证（§6.2）；
- profile **提供** `user-questions` 服务行，但**无 answerer/UI 行**（§5、§6.2）。

（`scripts/e2e-profile.sh` 本轮新增了「阶段3 三行逐一存在」「profile 服务可用性」两条断言。）

---

## 3. 跨进程 `team-transport`（真实 OS 进程）

命令：`node scripts/team-transport-xproc.mjs`

架构（真实程度逐项标注）：

- **主角**：真实产品代码 `TeamTransportService`（`packages/team-transport/lib/index.js`），backend=`local-child`；
- **链路**：真实 `ctx.subprocess`（`dsh-subprocess-local`）`spawn` 出**真实子进程**，stdio 走 **JSONL `WireFrame`**；
- **对端**：默认是**产品自带** `packages/team-transport/relay/relay.mjs`（另一真实进程，讲同一协议）；
  确定性注入场景（重复帧、增量历史）用 `scripts/team-transport-xproc-peer.mjs`（协议探针，同协议、真实进程）；
- **断线**：对子进程 handle 调 `terminate()` —— **真杀进程**，非同实例注入。

原始输出：

```console
[env] real ctx.subprocess: spawn=function resolveExecutable=function

[RESULT] {"name":"V1 真实 relay 不丢：丢 ack→真杀进程→重连重放→终态全 ack",
          "stateAfterKill":"degraded","before":{"acked":0,"pending":3},
          "after":{"acked":3,"pending":0,"replayed":6},
          "stateTransitions":["resyncing","connected","degraded","resyncing","connected"],"pass":true}

[RESULT] {"name":"有界队列：真实 relay 不回 ack，maxQueue=3 连发 5 → queueDropped=2, pending=3",
          "queueDropped":2,"pending":3,"pass":true}

[RESULT] {"name":"V2 不重：对端重复发 seq=1 → 接收端幂等去重恰好一次",
          "distinctSeqs":[1,2],"frameCount":2,"dedupDropped":3,"pass":true}

[RESULT] {"name":"V4 断线重连：重连后按 sinceSeq 增量补齐",
          "sinceBefore":5,"sinceAfter":8,"distinctFrames":[1,2,3,4,5,6,7,8],
          "stateTransitions":["resyncing","connected","degraded"],"pass":true}

[PASS] 跨进程 xproc 验证：4/4
```

### 3.1 V1（不丢）
真实 relay 首开丢弃全部 ack（`RELAY_DROP_ACKS=999`）→ 父进程 3 帧全部未确认（`acked=0, pending=3`）；
**真杀子进程** → 父进程进 `degraded`；`reconnect()` 重新 spawn → 重放 queued-minus-acked → 终态 `acked=3, pending=0, replayed=6`。
状态机迁移可观测：`resyncing→connected→degraded→resyncing→connected`。

### 3.2 V2（不重）
对端（真实子进程）对 `seq=1` **重复发两次**；接收端真实 `TeamTransportService` 按 `seq` 幂等去重：
`frameCount=2`（非 3）、`distinctSeqs=[1,2]`、`dedupDropped=3`。

### 3.3 V3（崩溃恢复）
另见 §4 的「distributed 崩溃恢复」小节（独立脚本，真实进程重启 + journal 落盘）。

### 3.4 V4（断线重连增量）—— 附诚实边界
真实链路：父进程从对端收到 `seq 1..5`（`sinceSeq=5`）→ 真杀进程 → `degraded` → 重连 → 父进程发 `sync-req{sinceSeq:5}`
→ 对端重放 `seq>5`（`6,7,8`）→ `sinceSeq=8`。
**边界**：重连会 **spawn 一个新子进程**，而真实 relay 每次是全新进程、**内存历史不跨进程重启保留**。因此「对端保留历史」
由探针 `byAttempt` **模拟**（attempt2 预置 `historyLen=8`）。真实对端要跨重启保留历史，需对端侧持久化——属 P23/P25 的持久化议题（§6.2）。

---

## 4. `team-distributed` 崩溃恢复（V3，真实进程重启 + journal 落盘）

命令：`node scripts/team-distributed-journal-xproc.mjs`

两个**不同 OS 进程**，共享同一 `journalPath`：

```console
[seed 进程]    {"mode":"seed","pid":1531894,"statuses":[{"status":"queued"},{"status":"queued"},{"status":"queued"}],
               "pending":3,"journalOnDisk":{"queued":[["msg-1",…],["msg-2",…],["msg-3",…]],"delivered":[]}}
[recover 进程] {"mode":"recover","pid":1531906,"pendingAtStart":3,"replayed":3,"dupStatus":"accepted",
               "sendsAfterRecover":3,"sendsAfterDup":3,"dedupDropped":1,"pendingAfter":0,
               "journalOnDisk":{"queued":[],"delivered":["msg-1","msg-2","msg-3"]}}
[PASS] V3 真实进程重启 + journal 持久化
```

- `pid` 不同（1531894 ≠ 1531906）⇒ **真实进程重启**，不是同实例注入；
- journal 经 `@deepseek-ai/dsh-atomic-write` **原子落盘**，新进程从磁盘加载（`pendingAtStart=3`）；
- `recover()` 重放 `queued-minus-delivered`：`replayed=3`，`pendingAfter=0`；
- 重复投同一 `messageId` → **幂等**（`sendsAfterDup == sendsAfterRecover`，`dedupDropped=1`）。

这直接回应了 P15 §H.4「journal 为内存 seam、未实测」——P25 引入 `journalPath` 后，该条已在**真实跨进程重启**下成立。

---

## 5. 人类席位（`team-human`）

命令：`node scripts/team-human-xproc.mjs`

```console
[addSeat(alice,user)] {"seatId":"roster-alice","name":"alice","kind":"user"}
[addSeat(non-lead) forbidden] true
[parseInbound routes] @alice→{target:"alice"}; @all→{target:"all"}; #status→{target:"lead"}; $alice→{target:"roster-alice"}; plain→{target:"lead"}  (全部 pass)
[inbound @all] {"r1":{"target":"all","delivered":true},"busBroadcastCalls":1}
[inbound @alice] {"r2":{"target":"alice","delivered":true},"lastRange":{"kind":"dm","to":"alice"}}
[ask blocked-then-continued] {"answer":"APPROVED:deploy to pr","elapsedMs":348,"blocked":true,"realExternalProcess":true}
[offline retention] {"deliverWhileOffline":{"delivered":false},"pendingBefore":1,"flushed":1,"bridgeSendCalls":1}
[PASS] 人类席位验证
```

覆盖：
1. **HITT 路由**：`@name`→DM、`@all`→广播、`#...`→Lead、`$name`→另一人类化身、纯文本→Lead；并**实投**
   （`@all` 触发 `teamBus.broadcast`；`@alice` 触发 `teamCore.send({range:{kind:'dm',to:'alice'}})`）。
2. **阻塞询问 → 输入 → 继续**：`ask()` 阻塞 348ms，直到**一个真实独立子进程**把回答写到 stdout 才返回 `APPROVED:...`。
3. **离线不丢**：桥离线时 `deliver()` 返回 `delivered:false` 并保留待补投（`pending=1`）；上线 `flush()` 补投 1 条。
4. 权限：仅 Lead 可 `addSeat`（非 Lead 抛错）。

**诚实边界（另见 §6.2）**：产品里 `ctx.userQuestions.ask()` 是 UI 支撑的 seam。本 profile **装配了 `dsh-user-questions` 服务行，
但没有 answerer/UI 行**；真实 `@deepseek-ai/dsh-user-questions` 是 `TypertRemoteService`，需 Session/Agent 的 answerer 瀑布，
无法在无 UI 栈时单独装配。故此处以**真实独立子进程**充当人类输入源，使「阻塞/输入/继续」**跨真实进程边界**。
`teamCore`/`teamBus`/`teamHumanBridge` 同为产品 seam（薄适配面），以记录型 seam 注入并断言其被正确调用。

---

## 6. 真跑通 / 没跑通 / 无法验证

### 6.1 真跑通（真实进程边界）
- 跨进程 JSONL 帧搬运 + ack + 幂等去重 + 重连重放 + 有界队列（真实 `ctx.subprocess` + 真实子进程 + 真杀进程）；
- V3 崩溃恢复：真实进程重启 + journal 原子落盘 + `recover()` 恰好一次；
- 人类席位：HITT 路由、阻塞→输入→继续（真实输入进程）、离线保留→补投。

### 6.2 未能在此环境验证（附原因与所需条件）
1. **ssh-rpc 后端**：本 profile **无 `ctx.ssh`**（dump 中 `ssh=0`，profile 未装配 `@deepseek-ai/dsh-ssh`）。
   本地仓 `node_modules` 亦无 `dsh-ssh`。**所需条件**：一个装配了 `@deepseek-ai/dsh-ssh` 且配置了 OpenSSH alias
   （复用其鉴权/主机身份）的部署；随后用 `SshSeam`（`openDuplex`）走一遍同样 4 条。
2. **完整 dsh peer 作为对端**：`team-transport` 目前**没有「对端入站 attach / self-link」公开面**——入站帧只经
   in-process `LoopbackBus` 被接受；`local-child` 方向由父进程 spawn 对端、经**同一条双工管道**收发。
   因此「leader 与远端成员**各跑整套 bundle**」的两端对称链路，当前只能在**传输层**用产品自带 relay/探针验证
   （帧/ack/重连是真的），**不是**两个进程各加载完整 team 插件栈。**所需条件**：为生成端补一个「把进程 stdio 包成
   `RawLink` 并自 attach」的入口（或由 `ctx.subagents` out-of-process provider，spec §9.2 未实测）后，再端到端验证。
3. **对端侧历史跨重启保留（V4 的完全体）**：见 §3.4；需对端侧持久化（P23/P25 议题）。
4. **人类真实 UI / 宿主桥**：见 §5；`Web UI 未写`（spec §2.2 明确不做）。

### 6.3 未做的取舍
- **未跑真实模型**：全部用 `--no-model` 与离线 harness，**0 / 5M token**。真实模型驱动的团队交互（`spawn_teammate` 等）
  由 `e2e-profile.sh`（不带 `--no-model`）覆盖，本轮为控成本未触发。

---

## 7. 环境与磁盘

- 全程隔离在项目 `.runtime/`，未改 `/root/.dsh`、未动系统 node、未挂代理（`no_proxy=*`）；
- 本仓实验包显式钉 `@0.2.1-rc.3`；
- 日志写入 `.p20-logs/`（临时，不入库），未产生大体积轨迹；磁盘未吃紧。

## 8. 附：本任务新增/改动文件

| 文件 | 作用 |
|---|---|
| `scripts/e2e-stage3.sh` | 阶段 3 一键复现入口（profile 回归 + 跨进程 + 崩溃恢复 + 人类席位） |
| `scripts/team-transport-xproc.mjs` | 真实子进程 transport 验证（V1/V2/V4/有界队列）+ 真实 `ctx.subprocess` 适配器 |
| `scripts/team-transport-xproc-peer.mjs` | 确定性故障注入的线协议探针（真实子进程） |
| `scripts/team-distributed-journal-xproc.mjs` / `…-proc.mjs` | V3 真实进程重启 + journal 落盘验证 |
| `scripts/team-human-xproc.mjs` | 人类席位验证（路由/阻塞询问/离线补投） |
| `scripts/e2e-profile.sh` | 新增「阶段3 三行逐一存在」「profile 服务可用性」断言 |
