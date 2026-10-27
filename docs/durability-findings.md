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
