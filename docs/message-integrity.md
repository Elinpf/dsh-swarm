# 消息并发完整性核实 + 与 JiuwenSwarm 对照（message-integrity）

> P48 ｜ 负责人：bench-qa-engineer ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm` @ 当前 main（P30/P31 后）
> 目标（用户诉求）：核实「消息**不会**被乱序 / 吞掉 / 不回应」——① 用户发送时；② 多个 subagent 同时向 leader 发消息时；③ 并发下是否串味/丢失/无回应。并对照 JiuwenSwarm。
> 纪律：**事实 / 推断分离**，逐条带证据（源码位置 / 探针输出 / 测试）与判定（成立 / 推翻 / 仍不可判定 + 原因 + 解锁条件）。
> 时序标注：【源系统】= JiuwenSwarm 现源码；【当前 main】= dsh-swarm P30/P31 后；【no-op 时代】= P22 前（本报告不采用）。
> 边界：**未改任何 `packages/*/src`**；发现真 bug 已先报 leader（见 §5）。

---

## 0. 结论速览（TL;DR）

| 维度 | 判定 |
|---|---|
| **并发不丢/不串味（dsh-swarm 插件层）** | **成立**：40 并发 DM→leader 不丢不串味；25 并发 broadcast、20×3 并发 multicast durable/投递均不丢、不误投（确定性探针全绿）。 |
| **跨进程投递** | **成立**：`team-transport` 明确 **at-least-once + seq 幂等去重**，有界队列「丢最旧并计数」（绝不隐式丢），重连增量重放（16 项测试）。 |
| **「发出去必有回应」** | **推翻（无保证）**：dsh-swarm 插件层**无 ack/超时/重发语义**；原生 `sendMessage` **接受即返回、不等待处理**。与我们不同，Jiuwen 有「未读台账 + 完成闸门」间接兜底（见 §2.3）。 |
| **用户消息 vs 成员消息并发** | **仍不可判定（dsh-swarm）**：该仲裁发生在 **DSH 原生 session inbox**（非本栈插件）；本栈不参与。需真实 profile 实测才能定论（解锁条件见 §4-D2）。 |
| **真 bug（已报 leader）** | **`tool-swarm` 的 `multicast` 工具按「名字」发送，`team-bus` 按「id」校验 → 真实 profile 必抛 `TEAMBUS_UNKNOWN_TARGET`**（§5，显式报错，非静默丢失）。 |

---

## 1. 场景与口径

- **场景①**：外部用户向团队发消息（落到 leader / 人类化身 / `user` 伪成员）。
- **场景②**：多个 teammate **同时**向 leader 发 DM。
- **场景③**：并发下（广播扇出、多播、跨进程）是否串味 / 丢失 / 无回应。
- **「不丢」** = 每条已发送的消息最终被投递到目标信箱（可持久/可重放），或显式报错。
- **「不串味」** = 投递记录的（发送者, 收件人, 内容）自洽，无跨消息错配。
- **「必有回应」** = 存在机制保证「发出即被处理/回复」（ack/超时重发/完成闸门），而非依赖成员自觉。

---

## 2. JiuwenSwarm 侧机制（对照，带源码位置）

源码根：`/opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen/agent_teams/`（下称 `…/agent_teams/`）。

### 2.1 入站消息**不丢**：落库先行 + 邮箱拉取（事件只是信号）【源系统·事实】

- **内容先落库**：`send_message` → `db.message.create_message(... is_read=False)` **成功后才** `publish(MessageEvent)`；落库失败直接返回 `None`（不产生"幽灵事件"）。`tools/message_manager.py:85-98`；`broadcast_message` 同构（`:134-144`）。
- **广播 = 1 行 + 水位线**；**多播 = 一次事务 N 行**（`create_direct_messages`，`:196-206`）。
- **事件丢失不致命**：事件仅是"信号"，成员**自拉邮箱**（`get_messages` / `get_broadcast_messages`）——`tools/message_manager.py:227-291`。⇒ **durable 行是唯一真源**，事件丢了也能在下次 poll 补上。

### 2.2 并发**串行化**：进程级单写锁 + 瞬态重试 + 看门狗【源系统·事实】

- **进程级写锁**：`DbSessions.write()` 持有非重入 `self._write_lock`，**所有写串行**；读走独立 read session。`tools/database/engine.py` `DbSessions.read()/write()`（write 见 `:116-138`）。
- **瞬态重试**：`retry_on_locked(op, ...)` 对 `OperationalError("database is locked")` 与连接池 `TimeoutError` 做**指数退避**重试（有界），失败返回 `on_locked_result`。`engine.py:142-190`；被 `create_message`（`message_dao.py:219`）、`create_direct_messages`（`:307`）、`mark_*_read`（`:556/611`）复用。
- **看门狗**：read/write session 包在 `asyncio.timeout(_DB_SESSION_WATCHDOG_SECONDS)`，驱动卡死 → 响亮 `TimeoutError`（不静默挂起）。`engine.py`。
- ⇒ 并发写**不会丢/不会交错损坏**：要么串行成功，要么退避重试，要么显式失败。

### 2.3 是否**必有回应**：**无硬保证**，但有间接兜底【源系统·事实】

- **无 per-message 的 ack/超时重发**：没有"发出 N 秒未回应则重发"的机制。
- **间接兜底**：
  - **未读台账 + 完成闸门**：`has_unread_messages(...)`（`tools/message_manager.py:304-316`）参与团队**完成判定**——**有未读就不算完成**，倒逼消息被消费。
  - **leader 代 ack user 伪成员**：`user` 伪成员无进程轮询邮箱，由 leader `_ack_user_bound_message` 代表标记已读，避免卡完成。`agent/coordination/handlers/message.py:44-46, 76`；`message_dao.py:619-624`（"user 可 ack 任意 direct"）。
  - **关闭时排空**：`on_member_shutdown_drain` 在成员 teardown 前 `_process_unread_messages(use_steer=True)` 再排空一次，保证"最后一条"也进运行轮。`handlers/message.py:58-83`。
- ⇒ **「不发丢、最终会被处理」成立**；**「必有主动/及时回应」不成立**（无 ack/超时保证；依赖成员存活且轮询）。

### 2.4 **忙碌成员**的消息：**排队**（不丢弃）【源系统·事实】

- 未读消息**持久在 DB**；成员忙时消息留待下次消费。
- 消费路径 `_process_unread_messages(member_name, use_steer=True)`：**逐条**投喂 harness，循环直到无新消息（`handlers/message.py:141-149`）。
- **有 in-flight 轮**时用 `use_steer=True` **steer 进运行轮**（不新起一轮）；**空闲**时才新起轮。
- **唯一"丢弃"**：harness 已死/正在关闭且无在飞轮（`_harness_input_blocked`，`handlers/message.py:89-139`）——**丢给死进程**，不丢活进程。

### 2.5 顺序【源系统·事实/推断】

- 单写锁串行写 + `timestamp` 落库；`_process_unread_messages` **逐条**处理 ⇒ 同一收件人看到的是**写入序**。
- in-process 传输是**直接 handler 调用、无队列**（`messager/inprocess.py:46-54`），顺序 = 调用序；某 subscriber 抛错被 catch&log，**不阻断其他 subscriber**（`:53-54`）。

---

## 3. dsh-swarm 侧核实（源码 + 确定性探针 + 测试）【当前 main】

### 3.1 投递路径（源码）

- **DM**：`team-core.send` → 原生 `agentTeams.sendMessage`（单目标 `target`）。`packages/team-core/src/index.ts`；**只发给 `range.to` 一人**，非目标无投递行。
- **broadcast**：`team-bus.broadcast` = **1 次落库**（`durable.push` + `emitDurable('swarm/bus/broadcast')`）+ **逐人 DM 扇出**（`fanout`→`deliver`）。`packages/team-bus/src/index.ts:176-213, 275-...`。
- **multicast**：**原子批写**（逐行 `durable.push`，任一步失败 `rollback`）+ 逐目标扇出。`team-bus/src/index.ts:215-265`。
- **跨进程**：`team-transport` 帧层。

### 3.2 确定性探针（零模型成本）

`node scripts/message-integrity-probe.mjs`（真实 cordis 运行时 + 端口 mock 记录每条投递）：

```text
[info] 成员 id 映射：alice=m1, bob=m2, carol=m3, dave=m4, erin=m5（id ≠ name，与真实 profile 一致）
== P1 多成员并发 DM → leader（不丢/不串味）==
[OK]   收到 = 期望 40（实收 40）
[OK]   消息 id 无重复（40/40）
[OK]   无串味（content 与 sender 自洽；异常 0）
[OK]   发送者覆盖全部 5 名成员
== P2 并发 broadcast ==
[OK]   durable 新增 = 25（实测 25）—— 不丢
[OK]   每个非发送者收到 25 条
[OK]   broadcast 自过滤：发送者 lead 不收到自己的广播
== P3 并发 multicast（按 id）==
[OK]   durable 新增 = 20×3（实测 60）
[OK]   每个目标收到 20 条
[OK]   非目标（dave,erin）0 条 —— 不误投
== P4 tool-swarm.multicast 用「名字」当目标 ==
[OK]   按名字投递被拒（TEAMBUS_UNKNOWN_TARGET）—— 证实：bus 契约=id，tool 传 name
[OK]   按 id 投递正常
结果：PASS（全部断言通过）
```

### 3.3 测试证据（确定性）

`node_modules/.bin/vitest run packages/team-transport packages/team-bus packages/team-core` → **3 files / 53 tests passed**。相关用例名：

- **transport**：`V2 不重：丢 ack 后重连重放 → 目标恰好生效一次（dedupDropped++）`、`V1/V4 增量补齐：B→A 丢帧后重连，A 终态无丢失、无重复`、`有界待发队列：超界丢最旧并计数`、`V2 真实子进程：子进程丢弃 ack → 父重发 → 目标恰好一次`。
- **bus**：`broadcast：除发送者外每成员各 1 条（自过滤、不重不漏）`、`multicast：产生 N 条 durable 消息，且逐目标投递`、`恢复（ADR-0002）：重建 bus + recover(durable)`。
- **distributed**：`V2 不重：同一 messageId 重复投递 → 只交付一次`、`V3 崩溃恢复：queued-minus-delivered 重启后重放且不重复`、`对端入站 attach…重复 messageId 不二次消费`、`journal 落盘（atomic-write）活过重启`。

### 3.4 跨进程投递语义（源码）【当前 main·事实】

`packages/team-transport/src/index.ts`（头注释 + 实现）明确：**at-least-once + 按 `seq` 幂等去重**；发送端**未 ack 前保留**、**队列满丢最旧并计数**（绝不隐式丢）；接收端**按 seq 去重**、重复帧**仍回 ack**（停止对端重发）；**进程纪元 `epoch`** 让对端重启后复位去重窗口。

---

## 4. 判定表（逐条：命题 → 证据 → 判定 + 解锁条件）

| # | 命题 | 证据 | 判定 |
|---|---|---|---|
| **J1** | Jiuwen 入站消息**不丢** | 落库先行 `message_manager.py:85-98`；邮箱拉取 `:227-291` | **成立**【源系统】 |
| **J2** | Jiuwen 并发写**串行化** | 单写锁 `engine.py:116-138` + `retry_on_locked:142` | **成立**【源系统】 |
| **J3** | Jiuwen **必有回应** | 无 ack/超时；靠未读台账+完成闸门 `message_manager.py:304-316`、leader 代 ack `handlers/message.py:44-46` | **部分成立**：不丢、最终被处理成立；**主动/及时回应无保证**【源系统】 |
| **J4** | Jiuwen 忙碌成员：**排队不丢** | `_process_unread_messages` 逐条+steer `handlers/message.py:141-149`；仅丢给死 harness `:89-139` | **成立**【源系统】 |
| **D1** | dsh 多成员并发 DM→leader **不丢/不串味** | 探针 P1（40 并发全绿） | **成立**【当前 main】 |
| **D2** | dsh 用户消息 × 成员消息**并发** | 本栈不仲裁；仲裁在 DSH 原生 session inbox | **仍不可判定**（解锁：真实 profile 实测，见下） |
| **D3** | dsh broadcast 并发**不丢**（含自过滤） | 探针 P2 + bus 测试 | **成立**【当前 main】 |
| **D4** | dsh multicast 并发**不丢/不误投**（按 id） | 探针 P3 + bus 测试 | **成立**【当前 main】 |
| **D4b** | dsh multicast **工具按名字**可用 | 探针 P4 抛 `TEAMBUS_UNKNOWN_TARGET`；源码 tool 传 name / bus 校验 id | **推翻 → 真 bug**（§5）【当前 main】 |
| **D5** | dsh **「发出去必有回应」** | 本栈无 ack/重发；原生 `sendMessage` 接受即返回（`agent-team` `sendAdmitted` 注释「does not await model processing」） | **推翻（无保证）**【当前 main】 |
| **D6** | dsh 跨进程投递 **at-least-once + 幂等** | `team-transport` 源码 + 16 测试 | **成立**【当前 main】 |
| **D7** | dsh 进程崩溃后消息**不丢** | bus：durable 事件 + `recover()`；transport：journal 重放 | **成立（有 recovery 路径）**；**未覆盖**：未 `recover()` 时 in-memory `durable` 为空——需确认装配是否必 recover（标注待核） |

- **D2 的解锁条件**：在**真实 profile** 下并发注入「用户消息 + 成员 DM」（如 root 收到 user 输入的同时有 teammate DM），观察 leader 会话是否**串行处理、无丢失**、有无交错损坏；需真实模型（≈80k–150k/次）。当前**未采集**（成本/入口依赖）。
- **D7 的待核项**：`team-bus`/`team-core` 的 `recover(durable)` 是否在**真实 profile 装配时必被调用**（否则重启后内存态丢失，durable 事件仍在但未被折叠）。属代码装配核查（只读），非本轮阻塞。

---

## 5. 差距与方案（先报 leader，不自行改码）

**Gap-1（真 bug，已报，已由 leader 裁决）**：`tool-swarm.multicast` 传 **name**，`team-bus.multicast` 校验 **id** → 真实 profile 抛 `TEAMBUS_UNKNOWN_TARGET`。
- 影响：`multicast` 工具按名字**不可用**（显式报错，非静默丢失）。
- **裁决（leader，2026-10-27）：修 `tool-swarm` 侧**（调 `bus.multicast` 前经 roster 做 name→id 解析；保持 `team-bus` 的 id 契约不变；未知名字给**工具级清晰错误**；并做同类审计）。已立 **P49** 指派 `dsh-plugin-dev`，含「先红后绿 + 真实 profile 断言」。**本报告不再重复复现该 bug 的真实 profile 版本**（避免与 P49 重复花钱）。

**Gap-2（能力差距，非缺陷）**：dsh **无「必有回应」保证**（D5）。Jiuwen 亦无硬 ack，但有「未读→完成闸门」兜底。
- 方案（可选，评估后做）：给团队 DM 增加**读回执/未读台账**（对齐 Jiuwen 的 `has_unread_messages` 完成闸门）——把「未处理」纳入 `team-completion` 判定。**需先确认需求**，避免引入阻塞。

**Gap-3（待实测）**：用户消息 × 成员消息并发仲裁（D2）。
- 方案：待 P33/后续真实 profile 批次，加一条「并发入站」探针（user 输入 + teammate DM 同时）观测 leader 串行性。

---

## 6. 复现

```bash
cd <项目>/dsh-swarm
source scripts/env.sh
# 确定性并发探针（零模型成本）
node scripts/message-integrity-probe.mjs
# 关键包测试（确定性）
node_modules/.bin/vitest run packages/team-transport packages/team-bus packages/team-core
```

原始输出见 §3.2 / §3.3。Jiuwen 侧证据为源码位置（§2），未跑真实模型。

---

## 7. 局限

1. **用户×成员并发（D2）未实测**：本栈不参与该仲裁，结论标「仍不可判定」，未臆断。
2. **探针为端口 mock**：验证的是**我们插件层**的并发行为（不丢/不串味/自过滤/原子批），**不含**原生 agent-team 的真实信箱与 session inbox 行为（那属 D2/D5，另证）。
3. **「必有回应」按源码判定**：`sendMessage` 接受即返回（不 await 处理）为**源码事实**；未做端到端"无回应"反例的真实模型实测（可用 P17 长驻观测补）。
4. **成本**：本报告**真实模型消耗 0 token**（全确定性）；如需 D2 实测，需另报预算。
