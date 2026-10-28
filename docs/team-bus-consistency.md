# team-bus 契约一致性独立复核（P80）

> 执行人：interaction-analyst ｜ 时间：2026-10-28 ｜ 方式：**只读审计**（读源码，未改动任何 `packages/*/src`）
> 范围：`team-core` ↔ `team-bus` ↔ `tool-swarm` 的消息字段契约（`origin` / `in_review` / `target`(name vs id) / `form`）+
> 未读/兜底路径覆盖 + 原生 DM 不经 team-bus 的已知边界。
> 承接：P40 跨包审计、P48/P49/P51/P52 残留。
> 纪律：发现真缺陷**不自行修改**，回报 Leader 由 dev-2 处理。

---

## 0. 结论速览

| # | 对账项 | 结论 | 证据 |
|---|---|---|---|
| 1 | `origin`（`'broadcast'` 不计入未读/pending 台账） | ⚠️ **发现 1 处真缺陷**：`team-bus.broadcast` **未传 `origin='broadcast'`**，广播被当作定向计入 pending 台账 | §2.1 |
| 2 | `in_review` 叠加态 | ✅ 一致（契约/实现/消费三方对齐） | §2.2 |
| 3 | `target`（name vs id） | ✅ 一致（team-bus 端口按 id；tool-swarm 按 name→id 解析，P49 修复） | §2.3 |
| 4 | `form` | ✅ 不属三方发送契约，仅存在于读取侧投影（native relay） | §2.4 |
| 5 | 未读/兜底路径覆盖 + 原生 DM 边界 | ✅ 已知边界如实重申（**非 bug**） | §3 |

**净结论：1 处真缺陷（origin/broadcast），其余对账项一致；不含「为交差报的缺陷」，也不遗漏。**

---

## 1. 契约文档基线（三处字段声明的 SSOT）

| 字段 | 声明处 | 声明内容 |
|---|---|---|
| `origin` | `team-core-contract/src/index.ts:91-92` | `origin?: 'broadcast' \| 'directed'`；`'broadcast'`=公告类，**不计入未读/pending 台账**；`'directed'`=默认，计入 |
| `MessageRange` | `team-core-contract/src/index.ts:39-42` | `{dm;to:string}` \| `{multicast;targets:string[]}` \| `{broadcast}` |
| `in_review` | `team-core-contract/src/index.ts:50-53`、`121-132` | `TaskView.status` 含 `in_review`/`planned`；`updateTask.action` 含 `submit_review`/`reject_review`/`open_plan`/… |
| `target`（id） | `team-core-contract/src/index.ts:30-37` | `MemberView.id`（唯一标识）与 `name`（显示名）分离 |

**发送契约链**：`tool-swarm`（模型工具，入参=**名字**）→ `team-bus`（端口，寻址=**id**）→ `team-core.send`（`range.dm.to`=**name**）→ native `seam.sendMessage(target=name)`。

---

## 2. 三处契约对账（逐项）

### 2.1 `origin` —— ⚠️ **真缺陷：`broadcast` 未传 `origin='broadcast'`**

**【事实】声明与设计口径**（「广播不计入台账」）：
- 契约：`team-core-contract/src/index.ts:91-92`「`'broadcast'`（公告类，**不计入未读/pending 台账**）」。
- 实现侧门：`team-core/src/index.ts:328-331` — `if (req.origin !== 'broadcast') this.notePending(...)`，注释明写「公告类（origin='broadcast'）不计入（否则任意公告都会让任务永久无法完成）」。
- 设计口径：`docs/message-fallback-design.md §9` —「**范围口径实现**：`origin:'broadcast'` 不计入台账；**`team-bus` 广播=广播、多播=定向**」。

**【事实】实现（`team-bus/src/index.ts`）**：
- `fanout(..., origin: 'broadcast' | 'directed' = 'directed')`（**L311-316**，默认 `'directed'`）。
- `deliver(..., origin: ... = 'directed')`（**L358-363**，默认 `'directed'`）→ 传给 `ctx.teamCore.send({..., origin})`（**L368-373**）。
- `broadcast()` 的扇出调用：**L237** `await this.fanout(caller, targetIds, snap)` —— **未传第 4 个参数 → origin 取默认 `'directed'`**。
- `multicast()` 的扇出调用：**L286-299** `await this.fanout(caller, req.targets, {...}, 'directed')` —— 显式 `'directed'`。

**【事实】后果**：
- 广播（默认 `fanout:'dm'`）对每个非发送者都走 `deliver→teamCore.send(origin='directed')` → **`notePending` 入账**（`team-core/src/index.ts:582`）。
- `sweepPending()` 会在 `messageAckTimeoutMs` 后对**广播消息**执行「重投 ≤1 → 升级 leader」（`team-core/src/index.ts:590-618`）→ 与「公告不该被当作待处理/不制造噪音」的意图相悖，并存在**升级噪音/自激**风险。
- `record-only` 广播不走 DM（`team-bus:233-235` only `notifySubscribers`），**不受影响**。

**【推断】根因**：`multicast` 显式传了 `'directed'`（与默认值相同，属冗余写法），而 `broadcast` 漏传第 4 参——**不对称**，指向「broadcast 本应传 `'broadcast'` 但被遗漏」。
**【事实】无测试覆盖**：全仓 `*.spec.ts` grep `origin` **零命中**（本缺陷未被任何测试断言）。

**【最小修复点】**（供 dev-2；本审计不改）：
```
// team-bus/src/index.ts:237
- await this.fanout(caller, targetIds, snap)
+ await this.fanout(caller, targetIds, snap, 'broadcast')
```
并补 1 条断言：广播后 `team-core.pendingMessageCount === 0`（record-only 与 dm 两路），多播后 `> 0`。

> ⚠️ 报 Leader 裁决点：修复前需确认设计口径无误（「广播=不计入」）；若产品有意让广播也计入，则应改为在契约/文档层面澄清，而非保留当前「声明不计入、实现却计入」的矛盾。按纪律**不在本任务自行改码**。

### 2.2 `in_review` —— ✅ 一致

**【事实】** 三方对齐：
- 契约声明：`team-core-contract/src/index.ts:50-53`（`TaskView.status` 含 `in_review`/`planned`）、`121-132`（`submit_review`/`reject_review` action）。
- 实现（team-core）：叠加态集 `reviewing` + `overlay()`（`team-core/src/index.ts:767-769` 读侧呈现 `in_review`）；合法转换校验（`:464`、`:479`、`:500-511`「in_review 期间硬拒绝直接 complete」）；唯一合法完成出口 `completeAfterReview`（`:641-648`）。
- 消费方：`team-review/src/index.ts:129`（`submit_review` 进入评审）、`:200`（fail→`reject_review` 返工）；`team-scheduler/src/index.ts:55-56,75-76` 把 `in_review` 计入「一人一活跃任务」的 busy 集。
- **tool-swarm 不直接操作任务**（仅 `team_summary` 读 `listTasks` 计数，`tool-swarm/src/index.ts:250-273`）——状态字符串原样透传，无契约冲突。

### 2.3 `target`（name vs id）—— ✅ 一致（P49 修复）

**【事实】** 分层清晰、已一致：
- `team-bus` 端口按 **id** 校验：`multicast` 用 `assertTargets(req.targets, all.map(m=>m.id))`（`team-bus/src/index.ts:247-251`）+ `known.has(t)`（`:254-257`）；广播扇出 `targets.map(m=>m.id)`（`:232`）。
- `team-bus.deliver` 解析 member 后向 team-core 发 **name**：`range:{kind:'dm', to: member.name}`（`:358-373`）。
- `tool-swarm.multicast` 在 **工具层做 name→id**：`resolveMemberIds()`（`tool-swarm/src/index.ts:85-105`）+ 调用点 `:185`；未知名字抛**工具级清晰错误**（`:100-103`）。
- `team-core.send` 只接受 `range.kind==='dm'`，`to` 为 name，透传 native `target`（`team-core/src/index.ts:315-327`）。

**【事实】已知边界（重申，非 bug）**：`team-bus` 的 `subscribe/history` 也按 id（`:186-199`、`:342-356`），与工具层 name 语义的分工是**有意设计**（底层不弱化）。

### 2.4 `form` —— ✅ 不属三方发送契约

**【事实】** `form` **未出现**在 `team-core` / `team-bus` / `tool-swarm` 的任何 `send` 契约里；它只作为**读取侧投影**的输入：
- `team-bus/src/projection.ts:31,72` 定义投影项 `kind: 'broadcast'|'multicast'|'dm'|'relay'|'outbound'`；
- `:175,190` 从 native `agent/inbox/spliced`（`source.kind==='agent-message'` 且 `source.form==='relay'`）**派生** `kind:'relay'` 条目。

**【推断】** `form:'relay'` 是 **DSH 原生**的消息来源标记（`00-overview.md §3-④`），team-bus 只读不改；故三方发送契约中**没有 `form`**，不存在「声明未实现/实现未声明」。✅

---

## 3. 未读/兜底路径覆盖 + 原生 DM 已知边界（重申，非 bug）

**【事实】team-bus 的覆盖范围**：
- team-bus 的 `broadcast`/`multicast`（`fanout:'dm'`）经 `deliver→teamCore.send` 进入 pending 台账；`record-only` 广播只 `notifySubscribers`（`team-bus/src/index.ts:233-235`）→ 不入台账。
- `team-core.send` 的 pending 台账 + `sweepPending`（重投≤1→升级）见 `team-core/src/index.ts:582,590-618`。

**【事实】已知边界（PON，重申，**不得误判为 bug**）**：
- **原生 DM 不经 team-bus**：模型直接调 native `send_message` 工具时**不经过 `ctx.teamCore.send`**，故真实 profile 下 `pending` 常为 0（`docs/message-fallback-design.md §9`：「默认 `send_message` 走原生工具、不经 `ctx.teamCore.send`，故真实 profile 不产生 pending（实测 pending=0）；待 P49」）。⇒ 兜底台账**只覆盖 team-bus 来源的发送**，这是**已知边界**。
- 与之相关：`team/message/{queued,delivered}` 为**历史只读类型、当前发送不再写入**（`00-overview.md K10`；`team-bus` 亦不 emit 之）——观察「未读闸」时须以此为前提。

**【推断】** 因此 §2.1 的 `origin` 缺陷**影响面**是：经 team-bus 广播（dm 扇出）才受影响；纯原生 DM 路径不受影响（因其本就不入台账）。

---

## 4. 已确认一致项（供 checklist）

- [x] `origin` 字段在**契约**（`team-core-contract:91-92`）与**实现门**（`team-core:330`）一致；
- [x] `in_review`/`planned` 叠加态：契约声明 ↔ team-core 实现 ↔ team-review/scheduler 消费 三方对齐；
- [x] `multicast` name→id：tool-swarm 解析 ↔ team-bus 按 id 校验（P49）一致；
- [x] `form`：仅读取侧投影（native relay），非三方发送契约字段；
- [x] `MessageRange.dm.to` = name 链路一致（team-bus→team-core→native seam）。

## 5. 缺陷清单（按严重程度）

### 🔴 #1（高·行为）`team-bus.broadcast` 未按声明传递 `origin='broadcast'`

- **现象**：`broadcast()` 调 `fanout()` 未传 origin → 取默认 `'directed'`（`team-bus/src/index.ts:237` + `:311-316`/`:358-363` 默认值），广播消息被 `team-core` 计入 pending 台账（`team-core/src/index.ts:330-331`）。
- **与声明冲突**：契约/设计口径均要求广播 origin=`'broadcast'`（不计入）（`team-core-contract:91-92`、`message-fallback-design.md §9`）。
- **影响**：每次广播对每个非发送者 `notePending` → `sweepPending` 可能对公告重投/升级 leader（`team-core:590-618`）→ 噪音/自激；与「公告不应计入」相悖。
- **修复**：`team-bus/src/index.ts:237` 补第 4 参 `'broadcast'`；补断言（广播后 `pendingMessageCount===0`，多播后 `>0`）。
- **为何不自行修**：属 `team-bus`（dev-2 地盘）+ 需确认设计口径，按 P80 纪律**回报 Leader 由 dev-2 修**。

**未发现其它行为语义性缺陷。**

## 6. 方法 / 复现命令

```bash
cd <项目>/dsh-swarm
# 广播扇出未传 origin（默认 directed）
grep -n "fanout(caller" packages/team-bus/src/index.ts          # 期望看到 :237 无第4参、:286 有 'directed'
grep -n "origin" packages/team-bus/src/index.ts                 # :311-316,:358-363 默认 'directed'
# 声明：'broadcast' 不计入
grep -n "origin" packages/team-core-contract/src/index.ts       # :91-92
grep -n "notePending\|req.origin" packages/team-core/src/index.ts # :330-331
# 无测试覆盖
grep -rn "origin" packages/*/tests                            # 零命中
```

## 7. 不确定 / 待确认

- **待 Leader/产品确认设计口径**：广播是否**应当**不计入台账（契约与设计文档均称「应当」）。若确认，则 #1 为需修缺陷；若产品有意计入，则应改文档/契约澄清——本审计只呈证据与最小修复点，不替他人定契约。
- **未展开**：`team-transport`/`team-distributed` 的跨进程投递是否复用同一 `origin` 语义，本次未纳入（超出 P80 指定范围）。
