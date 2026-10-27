# `swarm/*` 是否真 durable（可跨重启恢复）？——独立核实（durability-truth）

> P50 ｜ 负责人：bench-qa-engineer ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm` @ 当前 main（P30/P31/P47 后）
> 触发：P47（dsh-target-analyst）怀疑 `swarm/*` 事件**根本不是真的 durable 会话事件**。本报告**独立核实**，不采信既有结论。
> 纪律：**事实 / 推断分离**，区分**真日志 / 真重启**与**模拟**；**未改任何 `packages/*/src`**。
> 结论一句话：**「`swarm/*` = durable 事件（emit + fold + 跨重启可恢复）」不成立——它们是 `ctx.emit` 的进程内广播，从未 append 到会话日志，故跨重启不可恢复。ADR-0002 §3 / P23 / P41 的相关标注需修正。**

---

## 0. 结论速览

| 命题 | 判定 |
|---|---|
| `swarm/<domain>/<action>` 是 **durable 会话事件**（写入 session log） | **推翻**——全仓无任何 `session.append` / `appendPluginRecord`；`emitDurable` 只是 `ctx.emit`。 |
| `swarm/*` 可**跨重启恢复**（replay → `session/event` → `recover()`） | **推翻**——恢复链依赖 `session/event`，而该事件**只在真实 append 时触发**；`swarm/*` 从未 append，真日志里 0 条（182 份实测），replay 不可能送达。 |
| P23「内存态重启丢失**已修复**」 | **需修正**——P23 的验证是**模拟**（内存捕获 emit → 手动 `recover`），**未**证明真会话日志 replay。真实语义是「**仍会在重启后丢失**」。 |
| P41 / ADR-0002 §3「durable 标注」 | **需修正**——`swarm/*` 应标注为「**进程内事件（in-process emit），非 durable**」，或改走真正的持久化通道（`appendPluginRecord` / `session.append`）。 |

**证据方法声明**：本报告用**真实 durable 会话日志**（182 份，来自真实 profile 运行）+ **真实构建产物源码**；**未**构造「真重启 + 真 replay」（§1.F5 说明为何由 F1–F4 逻辑上已可判定，无需额外真重启）。**真实模型消耗 0 token**。

---

## 1. 事实层（F1–F6，均可复现）

### F1 全仓没有任何「真 append」调用【事实】

```console
$ grep -rnE "session\.append|\.append\(|appendPluginRecord" packages/*/src/*.ts | grep -vE "test|spec"
（无输出）
```

`packages/*/src` 里**搜不到**任何把事件写入会话日志的调用（`.append(` 0 处、`appendPluginRecord` 0 处）。

### F2 `emitDurable` / `emitEvent` **只是 `ctx.emit`**【事实】

```ts
// packages/team-bus/src/index.ts:142
private emitDurable(type, payload) {
  (this.ctx as { emit?: ... }).emit?.(type, { version: DURABLE_VERSION, ...payload })
}
```
`team-core/src/index.ts:592`、`team-completion/src/index.ts:130`、`team-core/src/index.ts:517`（`emitEvent`）同构——**一律是 `ctx.emit`**（cordis 进程内事件），**不 append**。
→ `team-bus` 里那个命名为 `durable` 的 `this.durable.push(snap)`（`index.ts:133/204`）确实是**内存数组**（`BroadcastSnapshot[]`），不是会话日志。

### F3 恢复链依赖 `session/event`，而它只在**真实 append** 时触发【事实】

- 各包的恢复入口：`ctx.on('session/event', (_s, ev) => { if (isDurableEvent(ev) && ev.type.startsWith('swarm/...')) this.recover([ev]) })`（`team-bus:119`、`team-core:189`、`team-completion:66`）。
- DSH `Session.commit()` **仅在 append 提交时**通知 `session/event`（`node_modules/@deepseek-ai/dsh-session/lib/index.js` `commit(...)`：`collectSessionCallbacks(entry.emitCtx, [carrier, "session/event", session, event])`）。
- ⇒ `ctx.emit('swarm/x')` **不会**触发 `session/event`。**没有 append ⇒ 没有 `session/event` ⇒ `recover()` 永不执行**。

### F4 真实 durable 会话日志里 **0 条 `swarm/*`**【事实·真日志】

对 `.runtime/dsh-home/sessions` 下 **182 份真实 `session.v4.jsonl.zstd`**（真实 profile 多轮运行：P24/P27/P48 及他人批次）：

```console
$ # 遍历全部 durable 日志，统计 swarm/* 事件
>>> 未在任何 durable 会话日志中发现 swarm/* 事件      # 0 / 182
$ # 对照：原生 team/* 事件存在（经 session.append 落盘）
  17 "type":"team/member"
   7 "type":"team/task"
```

→ 原生 agent-team 的 `team/member`/`team/task` **真在日志里**（它经 `journal.appendAndFlush(root, "team/member", …)` → `session.append(...)`，见 `.runtime/.../dsh-experimental-agent-team/lib/index.js:156-157`）；**我们的 `swarm/*` 一条都没有**。P47 的「demo 里无 swarm/*」结论**被独立复现并放大到 182 份日志**。

### F5 `verify-durability.mjs` 是**模拟**，不是真重启 / 真日志【事实】

`scripts/verify-durability.mjs`：
- 用 `root.on(t, (p) => captured.push({type:t, payload:p}))` **在内存里捕获 `ctx.emit` 的事件**（行 59）；
- "重启" = `const c2 = await boot(undefined)`（**没有会话日志**，行 77）；
- 恢复 = `c2.recover(captured)`——**手动把内存捕获的事件喂回去**（行 79）。

⇒ 它证明的是「**给定事件，fold 逻辑正确**」，**不是**「事件真的落盘且能 replay」。**未涉及真实会话日志 replay**。
> 为何仍不需再构造「真重启」：由 F1–F4，日志里根本没有 `swarm/*`，replay 无物可送；真重启只会复现「丢」。

### F6 DSH 的 append 契约：`swarm/*` 既不属已知类型、也不属插件记录【事实】

- `session.append(type, data)` 的 `type` 应为 `SessionEventMap` 键（`dsh-session/lib/index.js:1488` 注释；`KNOWN_SESSION_EVENT_TYPES` 白名单在 `:79`）。
- 非已知类型只有在 **`ignorable === true`** 时才被容忍（`:301`）；第三方实验态的正规通道是 **`appendPluginRecord(session, "plugin:<...>", data)`**——类型必须匹配 **`plugin:` + 小写斜杠段**（`isPluginRecordType`，`:1250+`），且有 `verify-plugin-record-callers` 门禁。
- `swarm/*` **两者都不满足**（既非已知类型，也无 `plugin:` 前缀，也无 `ignorable`）。⇒ 即便有人想 append，也走不通现有校验/约定。

---

## 2. 逐类判定（ADR-0002 §3 被列为 durable 的事件）

| 事件 | 发射点 | 真持久吗 | 说明 |
|---|---|---|---|
| `swarm/bus/broadcast` | `team-bus:205/249` `emitDurable` | **否**（仅 emit） | 广播快照只在内存 `this.durable[]`；重启后 `history()` 空。**P47 群聊 `projection.ts` 按会话日志折叠 → 同样拿不到**。 |
| `swarm/core/review-entered`/`review-left` | `team-core:425/436/457` | **否** | 评审态 `reviewing` 内存态，重启丢失（P23 声称已修，实未）。 |
| `swarm/task/plan-request`/`plan-response`/`revision-requested` | `team-core:359-440` | **否** | 计划闸/返工反馈态内存态。 |
| `swarm/task/released`/`revoked`/`terminal` | `team-core:493/499/512` `emitEvent` | **否** | 通知型 `ctx.emit`。 |
| `swarm/review/submitted`/`vote`/`settled`/`round` | `team-review:126-236` | **否** | 评审事件仅 emit。 |
| `swarm/skills/visibility`/`grant` | `team-skills:105-157` | **否** | 技能可见性内存态。 |
| `swarm/memory/shared`/`private` | `team-memory:79-110` | **否** | 记忆内存态（`team-memory` 无 append）。 |
| `swarm/completion/unread` | `team-completion:70/73` | **否** | 未读台账内存态。 |
| `swarm/task/unblocked`/`list-drained`、`swarm/member/status-changed` | `team-scheduler:96-287` | **否** | 通知型 emit。 |
| `swarm/transport/peer` | `team-transport:1022` | **否**（emit） | 传输层**自带独立 journal**（team-distributed `atomic-write`），与 session 无关（见 §4 注）。 |
| `swarm/distributed/*` | `team-distributed:186-334` | **否**（emit） | 同上；distributed 的跨重启靠**自己的 journal 文件**，不靠 session 日志。 |
| `swarm/human/*` | `team-human:138-228` | **否** | 通知型 emit。 |

**共同结论**：**ADR-0002 §3 列出的 `swarm/*` 全部是「仅 emit、未 append」**——`foldDurableEvents` 的 reducer 正确，但**没有事件源喂给它**（除测试/脚本手动注入）。

---

## 3. 判定与被影响结论

### 3.1 命题判定【推翻】

> **「`swarm/<domain>/<action>` 是 durable 事件（emit + fold + 跨重启可恢复）」= 推翻。**
> 事实是：`swarm/*` 是 `ctx.emit` 的**进程内事件**；`fold/recover` 只在「有人把事件交给它」时工作（测试手动注入）。**无 append ⇒ 无 replay ⇒ 无跨重启恢复。**

### 3.2 P23 / P41 / ADR-0002 是否需修正

- **P23（`docs/state-durability.md`/`verify-durability.mjs`）**：**需修正**。它把「内存捕获 + 手动 recover 的模拟」当作「重启丢失已修复」的**证据**。真实语义应为：**读取型内存态在真实重启后仍会丢失**（因为事件没落盘）。建议改名/加显著声明：「**fold 正确性验证（模拟），非持久化验证**」。
- **P41 / ADR-0002 §3**：**需修正**。`swarm/*` 的「durable」标注应为「**in-process event（非 durable）**」，或明确其持久化**未落地**。
- **P47（群聊 projection）**：受连带影响——`swarm/bus/broadcast` 投影「按会话日志折叠」，而日志里没有它 ⇒ **重启/回放后 bus 消息不进群聊视图**（当前进程内或可，跨会话不保证）。**需复核**。

### 3.3 系统性缺口严重度排序【推断·基于影响面】

1. **高**：`swarm/bus/broadcast` —— 广播**内容历史**跨重启丢失（`history()` 拉取在重启后空），且 P47 群聊面板依赖它。
2. **高**：`swarm/core/*` + `swarm/task/{plan-*,revision-requested}` —— **评审态/计划态**跨重启丢失（直接推翻 P23 的「已修复」）。
3. **中**：`swarm/completion/unread`、`swarm/review/*` —— 完成判定/评审进度重启丢失。
4. **中**：`swarm/skills/*`、`swarm/memory/*` —— 可见性/记忆内存态。
5. **低/信息**：`swarm/task/{released,revoked,terminal,unblocked,list-drained}`、`swarm/member/status-changed`、`swarm/human/*` —— 通知型，丢一般只影响提醒。
6. **注**：`team-distributed`/`team-transport` 的跨重启**另有独立 journal**（atomic-write，见其测试「journal 落盘活过重启」），**不受本缺口影响**——这是**少数真正持久**的路径，与 session 日志无关。

---

## 4. 方案（**先报 leader，未实现**）

**要真正 durable，二选一（归属 dev-1，需 ADR 决策）：**

- **方案 A（推荐，贴合 DSH 契约）**：把要持久的状态改走 **`appendPluginRecord(session, "plugin:swarm-<domain>-<action>", data)`**（`plugin:` 命名空间、`ignorable=true`、有 `verify-plugin-record-callers` 门禁），恢复侧改为从会话日志 fold `plugin:*` 记录。需评估与 ADR-0002 命名（`swarm/*`）的关系与迁移。
- **方案 B（保留 `swarm/*` 名）**：为 `swarm/*` 做 **`declare module '@deepseek-ai/dsh-session' { interface SessionEventMap { 'swarm/...': ... } }` 合并** + 调 `session.append('swarm/...', data)`。但 `append` 对未知类型要求 `ignorable`，且需确认 DSH 是否接受第三方 `SessionEventMap` 扩展（当前**未落地**，见 F1）。
- **方案 C（诚实的降级）**：**不声称 durable**——把 `swarm/*` 明确标注为「进程内事件」，并把「跨重启恢复」改为「依赖上层（如 session）自身机制」，去掉 `fold/recover` 的持久化叙事（或保留为「同会话内重放」）。

> 无论 A/B/C，**在修正前，任何「`swarm/*` durable / 跨重启恢复」的表述都不可引用**（含 P23/P41/ADR-0002 §3）。

---

## 5. 复现（全部可复现，零模型）

```bash
cd <项目>/dsh-swarm
# F1：无任何 append
grep -rnE "session\.append|\.append\(|appendPluginRecord" packages/*/src/*.ts | grep -vE "test|spec"
# F2：emitDurable = ctx.emit
grep -n "emitDurable" packages/team-bus/src/index.ts packages/team-core/src/index.ts
# F4：真实 durable 日志里 0 条 swarm/*（遍历全部会话日志）
for f in $(find .runtime/dsh-home/sessions -name 'session.v4.jsonl.zstd'); do
  zstd -dc "$f" 2>/dev/null | grep -c '"type":"swarm/'; done | paste -sd+ | bc
# → 0
# F4 对照：team/* 存在
for f in $(find .runtime/dsh-home/sessions -name 'session.v4.jsonl.zstd'); do
  zstd -dc "$f" 2>/dev/null | grep -oE '"type":"team/[a-z/]+"'; done | sort | uniq -c
# F5：P23 验证脚本是模拟
sed -n '52,80p' scripts/verify-durability.mjs
# F6：DSH append 契约
grep -nE "isPluginRecordType|KNOWN_SESSION_EVENT_TYPES|ignorable" node_modules/@deepseek-ai/dsh-session/lib/index.js | head
```

原始输出见 §1 各条（本地实跑）。

---

## 6. 局限

1. **未构造「真重启 + 真 replay」端到端**：由 F1–F4 逻辑上已可判定（日志无 `swarm/*`，replay 无物可送）。若 leader 要求「最严」证据，可在真实 profile 重启后**从日志 replay** 再断言 `session/event` 里无 `swarm/*`（成本 ≥0，纯 replay）。
2. **`team-distributed`/`team-transport`** 的持久化**另成一路**（自有 journal），本报告**未逐行核其文件实现**，仅据其测试与源码注释认定其为真持久；如需，可另立小任务核实。
3. **真实模型消耗 0 token**（全确定性 + 真日志检索）。
