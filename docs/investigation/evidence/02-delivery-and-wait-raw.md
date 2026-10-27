# evidence/02：消息投递 / 等待 / 事件 原始证据（复核用）

## E6. `[S] team-core/src/index.ts` —— `delivery` 被接收但从不使用

```
271:   async send(
272:     caller: Agent,
273:     req: { range: MessageRange; content: ContentBlock[]; delivery: 'quiet' | 'wakeup' },
274:   ): Promise<{ messageId: string; status: 'accepted' | 'queued' }> {
275:     if (req.range.kind !== 'dm') {
276:       throw new TeamCoreError('TEAMCORE_RANGE_UNSUPPORTED', ...)
280:     }
281:     const seam = this.require()
282:     const controller = new AbortController()
283:     const res = await seam.sendMessage(caller, {
284:       target: req.range.to,
285:       content: req.content,
286:       signal: controller.signal,
287:     })
288:     return { messageId: res.messageId, status: 'accepted' }
289:   }
```

`req.delivery` 在 275-288 之间**无任何出现**。seam（`:37-94`）的 `sendMessage` 也没有 delivery 字段。

调用方给的都是 `'wakeup'` 或原样透传（`grep -rn delivery packages/*/src/`）：

- `team-bus/src/index.ts:325` `delivery: snap.delivery`（来自模型参数）
- `team-core/src/index.ts:508`、`team-review:201,304`、`team-scheduler:428,449,504`、`team-distributed:379`、`team-human:205,211` —— 全部硬编码 `'wakeup'`

全仓源码没有任何一处把 `'quiet'` 翻译成 `wakeup=false`。

## E7. `[S] team-bus/src/index.ts` —— 名字/ID 与自过滤

```
221:     const all = this.members(caller)
222:     this.assertTargets(
223:       req.targets,
224:       all.map((m) => m.id),        // ← 全部成员 id（SessionId），不是 name
225:     )
227:     const sender = this.senderOf(caller)
228:     const known = new Set(all.map((m) => m.id))
229:     for (const t of req.targets) {
230:       if (!known.has(t)) throw new TeamBusError('TEAMBUS_UNKNOWN_TARGET', `unknown target ${t}`)
231:     }
...
256:     await this.fanout(caller, req.targets, { ... })
...
318:   private async deliver(caller: Agent, targetId: string, snap: BroadcastSnapshot): Promise<void> {
319:     const member = this.members(caller).find((m) => m.id === targetId)   // ← 再按 id 找
320:     if (!member) return
322:       await this.ctx.teamCore.send(caller, {
323:         range: { kind: 'dm', to: member.name },                          // ← 只有这里用 name
```

broadcast 侧自洽（targetIds 由 `members().map(m => m.id)` 生成，`:188,206`）：

```
188:     const targets = this.members(caller).filter((m) => m.id !== sender.id)
```

`assertTargets`（`:364-389`）**不排除调用者自己**，仅在 targets 恰为全体时拒绝（`:383-388`）。
`deliver` 吞异常（`:327-334`）：

```
327:     } catch (e) {
328:       // 投递失败不打断扇出（内容已落库，可补投）；仅告警。
329:       this.ctx.logger?.warn?.('team-bus: deliver to %s failed: %s', ...)
332:       )
334:     }
```

`history` 跳过自己发的（`:312`）；`history` **没有任何模型工具暴露**（见 E2 表）。

## E8. `[S] team-core/src/index.ts:222-234` —— `listMembers` 的 id/name 语义

```
224:     return this.seam.listMembers(agent).map((m) => ({
225:       id: m.id,      // ← harness TeamMemberView.id = SessionId（UUID）
226:       name: m.name,  // ← kebab-case 成员名
```

harness 侧证据：`[H] agent-team/src/roster.ts:141-143`（`id: member.id, name: member.name`）与
`:242`（`const childId = brandString<SessionId>(randomUUID())`）、`:243-250`（`id: childId, name`）。

## E9. `[H] agent-team/src/index.ts` —— 投递入口与 notify

```
145:   async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
146:     if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
147:     return await this.lifecycle.track(this.sendAdmitted(caller, {
149:       signal: AbortSignal.any([request.signal, this.lifecycle.signal]),
151:   }
...
224:   private async sendAdmitted(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
225:     const membership = this.roster.membership(caller)
228:     const target = resolveActiveMember(root, this.journal.state(root), request.target)
229:     if (target.id === caller.id) throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
230:     const content = [
231:       { type: 'text' as const, text: `Team message from ${membership.name}:` },
232:       ...structuredClone(request.content),
233:     ]
234:     if (Buffer.byteLength(JSON.stringify(content), 'utf8') > this.config.maxMessageBytes) {
235:       throw new TeamError(`team message exceeds ${this.config.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
236:     }
237:     const source = { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: caller.id }
239:     if (target.id === root.id) {
240:       const input = createUserMessage({ content, source })
241:       root.steer(input)
242:       messageId = input.id
243:     } else {
244:       messageId = await steerHostSubagentPrompt(this.ctx.subagents, root, target.id, content, source, request.signal)
245:     }
246:     this.activity.notify(membership.id)
247:     return { messageId }
248:   }
```

notify 的三个来源（`index.ts:89`、`:94-97`、`:246`）：

```
89:     this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
94:     ctx.on('agent/status', ({ agent }) => {
95:       const membership = this.roster.tryMembership(agent)
96:       if (membership !== undefined) this.activity.notify(membership.id)
97:     })
```

## E10. `[H] agent-team/src/roster.ts:42-54` —— 只解析 `active`

```
47:   const name = rawName.trim()
48:   if (name === 'lead') return { id: root.id, name }
49:   const member = state.members.find(candidate => candidate.name === name)
50:   if (member === undefined || member.phase !== 'active') {
51:     throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
52:   }
53:   return { id: member.id, name }
```

`:126-157` 是 `list`：`:144-148` 把 `failed/provisioning` 映射成 status，且**仍然把它们列出来**
（模型侧因此看到一个「看起来可寻址」的 target）。

## E11. `[H] agent-team/src/activity.ts` —— waiter 生命周期

`:12` waiter Map；`:22-66` wait；`:23-25` 区间校验；`:27` closed 立即 `{timedOut:false}`；
`:50` abort → `TEAM_WAIT_ABORTED`；`:59` timeout → resolve(false)；`:72-77` notify 清空该 Team 全部 waiter；
`:79-86` close 唤醒全部。

## E12. `[H] agent-team/src/journal.ts` —— 提交点之后才发布

`:9` `MutableTeamEventType = 'team/member' | 'team/task'`（**唯一**可写类型）；
`:42-52` 按 rootId 串行；`:60-72`：

```
68:     const append = root.session.append.bind(root.session) as unknown as AppendTeamEvent
69:     append(type, data)
70:     await this.ctx.sessions.flush(root.session)
71:     this.onCommit(root)
```

## E13. `[H] agent-team/src/projection.ts` —— schema 保留死事件

`:292-305` 仍有 `team/message/queued` / `team/message/delivered` 的投影规则；
`:387-394` `stateVersion: 4`、key `agentTeam`；
`:226` failure 冻结；`:235-238` 失败即写终态 failure；
`:342-361` wire view 只有 roster + 非删除任务；`:371-384` mailbox 变化复用旧 view 引用。

## E14. 无 `team/message/*` 生产 emit

`grep -rn "team/message/queued\|team/message/delivered" .runtime/deepseek-harness/packages/`
只命中：`agent-team/src/{projection,types}.ts`、`core/session/src/known-event-types.ts`、
`api/session-controller/src/commands.ts`（旧日志渲染）、以及若干 format 迁移包与测试。
`[H] agent-team/tests/team.spec.ts:907` 断言 Lead 日志里 `team/message/*` 为空。

## E15. durable 事件没有落地桥（本工作区内）

产品层所有 `emitDurable` 都是 `ctx.emit('swarm/...')`（team-bus `:142-155`、team-core `:592-605`、
team-review `:245`、team-skills `:123`、team-memory `:128`、team-completion `:130`）。
全仓产品层 `grep "session.append\|sessions.flush"` **零命中**；
恢复侧监听的是 `ctx.on('session/event', ...)`（team-bus `:118-120`、team-core `:184-190`、
team-memory `:51`、team-skills `:84`、team-completion `:66`）。

约定文档声称的链路（`docs/state-durability.md:10,54`）：

```
10: 项目一贯约定是「durable 事件即真相」：包 emit('swarm/*') → 经 session 日志落地 → 恢复时折叠。
54: - **fold**：包 `recover(events)` 用统一折叠助手 ... 运行时经 `ctx.on('session/event')` 叠加；
```

而验证脚本是自己直接调用 `recover`（`scripts/verify-durability.mjs:79`：`c2.recover(captured)`）。
**更正（Lead 按 investigation/05-verification.md §2 FIX-1 修订本句）**：缺的是这条链的
**事件生产端**（`packages/*/src` 中 `session.append`/`sessions.flush` 零命中，`emitDurable` 只
`ctx.emit('swarm/*')`）；**恢复端在生产路径上已经接好**——`team-bus/src/index.ts:119`、
`team-core/src/index.ts:189`、`team-memory/src/index.ts:52`、`team-skills/src/index.ts:85` 均在
`ctx.on('session/event')` 内调用 `this.recover([ev])`（`team-completion/src/index.ts:66-75` 只监听、
不 recover）。故本工作区内「emit → session 日志 → session/event → recover」缺的是宿主侧落地桥
（生产端），**不是**恢复端实现；宿主是否存在该桥仍 `UNVERIFIED`。

## E16. 底层投递语义（harness）

- `[H] core/agent-loop/src/agent.ts:154-161` send/splice/wake；`:163-173` followup/steer/inject。
- `:361-366` step 结束后若 nextStep 非空则以 `target='next-step'` 继续，不结束 turn。
- `[H] core/agent-loop/src/inbox.ts:109-114` claim 取走全部 next-step（+至多 1 条 next-turn）。
- `inbox.ts:198-229` mutate 会 `session.append('agent/inbox/spliced', ...)`（`durable: true`，`:173`），
  但**没有 flush**；`send_message` 返回时目标日志可能尚未落盘。
- `[H] core/agent/src/runtime-types.ts:215` `send(message, target, wakeup): void`；`:224-231` steer 契约。
- `[H] subagent/subagent/src/internal.ts:94-109` `steerHostSubagentPrompt` → `'steer'`。
- `[H] subagent/subagent/src/manager.ts:604-611` `steerPrompt`；`:626` `local.handle.agent.steer(message)`；
  `:1230-1244` `deliverToChild`；`:1247-1281` `deliverFollowup`（`:1254-1256` resident 判定 / coldResume）；
  `:1329-1384` `coldResume`（`:1349-1355` continuable 校验）；`:1418-1437` `submitAdmitted`（`:1434` wake）。
- `[H] agent-team/tests/team.spec.ts`：`:907` 无 team/message；`:922-928` 必须 flush 才读回；
  `:931-958` 无 Team 级队列；`:1124-1128` 边沿触发；`:1131-1133` dispose 释放 waiter。
