# P52 durable 持久化：通道判定与事件清单核实

> 产出人：dsh-plugin-dev-2 ｜ 任务：P52-durable-persistence-fix（P50 定性「`swarm/*` 从未 append」的修复）

## 1. 修复通道（Leader 裁定 A）

第三方写会话日志的**正规通道** = **`appendPluginRecord("plugin:swarm/…")`**（`@deepseek-ai/dsh-session`），
**不是** `session.append('swarm/…')`（后者非已知事件类型、需 `ignorable`，DSH 未必接受）。

统一入口落 `@elinpf/dsh-swarm-team-durable`：
- `emitDurable(session, name, payload)` → `appendPluginRecord("plugin:"+name, { version, name, ...payload })`（**事件名对外不变**，仍 `swarm/<domain>/<action>`）；
- `durableRecordOf(ev)` → 回放从事件取回 `{ name, payload }`（payload 去 `name`、保留 `version` 与业务字段）。

**正控（先红后绿，确定性免模型）** `scripts/verify-durable-channel.mjs`（真实 `dsh-session`+jsonl 装配最小 Session）：
```
RED  ：不 emit → 日志/磁盘 0 条 plugin:swarm/…
GREEN：emitDurable(session,'swarm/core/review-entered',{taskId}) → true；
       读回 events 含该记录；直读磁盘文件确有该行；
       durableRecordOf 取回 {name,payload}；新 Context 挂同目录重读仍可取回（跨重启 replay 成立）
```
正交证据：analyst 在真 Session 上验证 `plugin:swarm/bus/broadcast` 落盘（`ignorable=true`、`pluginRecordOf` 读回 snapshot.id）。
⇒ **通道 A 成立**。

## 2. 逐类 durable 事件判定

| 事件域 | 现状 | 判定 |
|---|---|---|
| `swarm/core/*`（review-entered/left）、`swarm/task/{plan-request,plan-response,revision-requested}` | 已接入通道 A（`team-core`） | **真持久【成立】** |
| `swarm/review/*`（submitted/vote/settled/round） | 已接入（`team-review`） | **真持久【成立】** |
| `swarm/memory/*`（shared/private） | 已接入（`team-memory`） | **真持久【成立】** |
| `swarm/skills/*`（grant；visibility 无 agent 时仅进程内 emit） | 已接入（`team-skills`） | **部分成立**（visibility 依赖有 agent 时） |
| `swarm/bus/broadcast` | analyst 已接入同一入口（P47） | **真持久【成立】** |
| `swarm/completion/unread` | 已接入（`team-completion`） | **真持久【成立】** |
| **原生 `team/message/{queued,delivered}`** | 仅在 `agent-team/src/projection.ts` 与 `types.ts` 声明，**全仓无任何 append**；真实日志无 | **【推翻：非 durable】** |

## 3. 关键结论：`team/message/{queued,delivered}` 非 durable ⇒ 影响 P51

- 证据：全仓 grep 无 append；`journal.ts:9` 可变 team 事件仅 `'team/member'|'team/task'`；真实会话日志实测无 `team/message/queued`。
- ⇒ `team-completion` 现有未读台账（监听 `team/message/queued/delivered`）在真机上**永不 +1** ⇒ `blockOnUnread` 永不触发。
- ⇒ **P51 由「复用原生事件」改为「自建 durable 未读台账」**（走通道 A 的 `plugin:swarm/...`；`swarm/bus/broadcast` 落盘可作底座）。

## 4. 未完成（诚实登记）

- **O1 式真实 profile 端到端 + 真实重启 replay**（先红后绿）待跑（预算先报）。
- 文档修正未做：`ADR-0002 §3` / `docs/state-durability.md` / `docs/final-acceptance.md` 的「durable/已修复」表述。
- `team-bus` 摺合待 analyst P47 push 后 rebase 复核。

## 5. 证据分级（口径 · 宁降不升）

- **【session 级 已验证】**：真实 `@deepseek-ai/dsh-session` + jsonl 持久化，`emitDurable → appendPluginRecord("plugin:swarm/…")` **真落盘**（直读磁盘文件确认），`durableRecordOf` 可读回，且**新 Context 重挂载重读仍可取回**（O2 GREEN③）。analyst 的真 Session 验证为互补旁证。
- **【profile 级 端到端 未验】**：**无可达的 swarm emit 触发点**（默认工具集不触达 `team-core/review/plan`、`team-memory`、`team-skills` 的 emit；原生 `team/message/*` 又非 durable），故未做 profile 级端到端。**不将其升级为【已验证】**。待 **P49 后 tool-swarm 可用**时顺带补（或在 demo profile 下免模型直调插件 API）。

## 6. 未接完（诚实登记）

- `team-bus`：已由 analyst 接同一入口；**待其 P47 push 后 rebase 复核一致性**。
- `team-skills.visibility`（`declare` 无 agent）：**仅进程内 emit**（无 session 可 append）。
- `team-review` 无 `session/event` replay 订阅（其 `recover()` 由外部调用；本任务未改其恢复入口）。

## 7. profile 级免模型触发的尝试结论（不可判定）

**尝试**：写了一个 patch 插件（激活即 `emitDurable`），经 `dsh --patch <overlay> --dump-config` 与 boot 触发（均免模型）：
- `--dump-config` 会把该行加载进真实 profile 组合（dump 输出含该行），但**只打印配置、不完成插件的异步写入**；
- boot 触发下**插件确实在真实 profile 上下文中激活并建了会话**（`sessions/_no-cwd/p52-probe-<pid>/session.v4.jsonl.zstd`），但进程因 `MISSING_CREDENTIAL` **在异步 flush 前退出** ⇒ 日志仅有 session header，**无 `plugin:swarm/probe/durable`**。

**结论：【profile 级 端到端 仍不可判定/未验】**。原因：**dsh 无「免模型完整运行」入口**（`--dump-config` 不跑插件异步；boot 无凭证即快速退出）。**通道本身已由 O2（session 级）证成**；profile 级待 **P49 后 tool-swarm 可达触发**，或上游提供免模型执行入口。探针脚本未入库（避免死代码）。

## 8. team-bus 写入侧/读取侧一致性复核（P52 收尾）

- **写入侧（我）**：`packages/team-bus/src/index.ts` — `broadcast`/`multicast` → `emitDurable(caller.session,'swarm/bus/broadcast',{ snapshot })`；`session/event` 用 `durableRecordOf` 折叠 `plugin:swarm/bus/…`。
- **读取侧（analyst，`28bd221`）**：`projection.ts` — `durableRecordOf(event)` → `name==='swarm/bus/broadcast'` → `payload['snapshot']`；构造函数 `ctx.inject(['sessionProjections'])` 延迟注册。
- **一致性结论 ✅**：**同一事件名/命名空间**（`swarm/bus/broadcast` ↔ `plugin:swarm/bus/broadcast`）、**同一 payload**（`{snapshot}`）；**无重复/遗漏**；两侧 `recover` 均经 `durableRecordOf` 识别 `plugin:` 命名空间。证据：`team-bus` 单测 **14/14**、`verify-load` ✅（观察到 `ctx.teamBus`）。
- **有意偏离（明写，防后人误读为漏做）**：analyst 的读取侧**放弃了任务描述的「`SessionEventMap`/`SessionProjectionMap` declaration merging」**——它引发类型膨胀→`tsc` OOM。改用**结构化类型 + `durableRecordOf` 识别 `plugin:` 命名空间**。**功能等价**（落盘 + replay 已由 O2 证成）；代价=无上游契约编译期绑定（已记入 P47 文档）。**这不是漏做，是经权衡的有意偏离。**
