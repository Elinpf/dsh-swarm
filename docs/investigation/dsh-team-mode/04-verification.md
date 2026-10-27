# 04 · 对 01–03 三节的独立核验（adversarial verification）

> 核验人：`verifier`（非 01/02/03 作者）。写盘范围：本文件 + `docs/investigation/05-verify-tmp/` 临时产物；**未改动**三节正文，更正以清单形式提交给 Lead。
> 冻结副本 md5（核验前实测，与 Lead 给定值逐一相符）：
> `01-core-model.md = 5040975d01883693928fcf517a9b5576`、`02-tools-and-messaging.md = 07ee233b4bf2075e9c988ed339c6257a`、`03-ui-wiring-and-docs.md = 1693f1753a01e399719c6ec9695b1aa6`。
> 核验方法：先在读三节之前独立通读 `agent-team/src/*`、`tool-agent-team/src/index.ts`、`client-ui-agent-team/src/client/*` 建立基线，再逐条打开被引行的文件与行号。行号相对 harness checkout 根 `.runtime/deepseek-harness`（工作区产品层标注 `[S]`）。

## 1. 检查 A：`04-live-session-evidence.md` 的来源（provenance）

用 `zstd -dc` 解压（多帧可正常解码，退出码 0，428 行）并抽取 `team/member` 事件：

- 目标 session `session-4e0b08f3-9cfa-43a8-bc0a-5b6debceea3f`（`.runtime/dsh-home/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm--/session-4e0b08f3-.../session.v4.jsonl.zstd`）的 `team/member` 事件中，`member.name` 恰为 **`core-model`、`tools-messaging`、`wiring-ui`、`auditor`** 四个（`teamId` = `session-4e0b08f3-...`；`auditor` 的 description 为「对抗式独立核验 01–04 关键论断（任务 task-4）」）。
- 对照本队 Lead session `session-a4df6b40-0887-4f01-affb-b87ec48bd7ab`，其 `team/member` 的 `member.name` 为 **`arch-core`、`bus-messaging`、`ui-wiring`、`verifier`**，`teamId` 为本 session。

**结论：`04-live-session-evidence.md` 是并发第二支调查队（Lead = `session-4e0b08f3-...`）的会话轨迹，不是本队 Lead session 的轨迹。** 该文件不构成 01–03 三节的证据来源；本报告对其内容不作事实采信。

## 2. 检查 B：三节是否依赖 `docs/investigation/evidence/**`

对三节全文 grep `evidence` / `04-live-session-evidence` 的结果：**只有一处**——`01-core-model.md:16` 引用 `docs/investigation/evidence/01-vitest-attempt.log`（§0 测试可运行性说明）。

- 该日志按 Lead 指令默认**非本队产物**，故该处的“引用支撑”记为 **UNSUPPORTED-BY-OUR-EVIDENCE**。
- 但我对其实质做了独立复现：工作区 `node_modules` 无 `vite-tsconfig-paths`（`ls` 证实），而 harness `vitest.config.ts:3` 确有 `import tsconfigPaths from 'vite-tsconfig-paths'`；日志内容与描述一致。**实质成立，仅引用物来源不属于本队。**
- `02-tools-and-messaging.md`、`03-ui-wiring-and-docs.md` **零处**依赖 `evidence/**`。

## 3. 抽样核验表（39 条，含每节 ≥5 条）

图例：**V** = VERIFIED，**W** = WRONG，**CM** = CITATION-MISMATCH（结论对、行号/术语偏差），**UB** = UNSUPPORTED-BY-OUR-EVIDENCE。

### 3.1 `01-core-model.md`

| #   | 被核验断言                                                                       | 打开的实际证据                                                                                                                                                                                                                                            | 判定   |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `TeamId(id)` 只 brand、原样返回同一字符串                                        | `agent-team/src/types.ts:16-18` 一致                                                                                                                                                                                                                      | V      |
| 2   | 空 Team 由根 Session id 构造                                                     | `projection.ts:145-153`（`emptyTeamState`）、`:391`（`init: header => emptyTeamState(header.id)`）一致                                                                                                                                                    | V      |
| 3   | `TeamMemberView` 字段与 `status` 四值、`diagnostics` 必填                        | `types.ts:59-69` 一致                                                                                                                                                                                                                                     | V      |
| 4   | `TeamTaskView` 不含 `ownerId`；release 后断言                                    | `types.ts:87-98`；`tests/team.spec.ts:675`、`:861` 均为 `expect('ownerId' in ...).toBe(false)`                                                                                                                                                            | V      |
| 5   | durable 成员转移只有 `provisioning→active\|failed`                               | `projection.ts:258-266`；`tests/projection-events.spec.ts:135-163` 断言 must begin provisioning / immutable identity / invalid active -> failed / name reused                                                                                             | V      |
| 6   | `inactive` 为运行时派生（`availability`），`:474` 是 JSDoc                       | `roster.ts:474-477`；`tests/team.spec.ts:186-189`（lead inactive）、`:230-232`（fork/fresh inactive）、`:407`（spawn 返回 inactive）                                                                                                                      | V      |
| 7   | CAS 顺序：存在 →revision→deleted                                                 | `task-board.ts:114`（存在）、`:115-120`（STALE_REVISION）、`:121`（DELETED）；`team.spec.ts:797-805`、`:653-655`                                                                                                                                          | V      |
| 8   | `TeamJournal.transact` 按 Lead 串行；append→flush→onCommit                       | `journal.ts:42-52`、`:60-72`（通知在 `:71`）一致                                                                                                                                                                                                          | V      |
| 9   | task-graph 全量校验的分类与调用点                                                | `task-graph.ts:6,26-52,37-49,54-68`；调用点 `task-board.ts:240-248`、`projection.ts:280` 一致                                                                                                                                                             | V      |
| 10  | reconcile 需 parent+continuable+provider 匹配+初始 prompt                        | `roster.ts:375-417`（`:388-392`）；`tests/persistence.spec.ts:198-273`、`:274-314` 断言 active/failed 两条路径                                                                                                                                            | V      |
| 11  | 任意成员可创建任务（只看 membership）                                            | `index.ts:159-161` 一致                                                                                                                                                                                                                                   | V      |
| 12  | deleted 墓碑不占 `maxTasks`                                                      | `task-board.ts:47-51`（过滤 status!=='deleted'）+ `README.md:136` 一致                                                                                                                                                                                    | V      |
| 13  | `failure` 终止且事件层引用冻结                                                   | `projection.ts:226`；`tests/projection-events.spec.ts:476` `apply(failed, queuedEvent) === failed`                                                                                                                                                        | V      |
| 14  | 客户端 model 取成员自身 `modelSelection`                                         | `client-ui-agent-team/src/client/TeamAction.tsx:81` 一致                                                                                                                                                                                                  | V      |
| 15  | 「4 个 `version:2` 事件注释**均写** stored only in the Team Lead Session」       | `types.ts:227-242`：仅 `:229`(member)、`:231`(task) 有此注释；`:233`(queued) 为 “Historical mailbox enqueue; new sends use the target Agent inbox.”，`:235`(delivered) 为 “Historical acknowledgement that the target Session recorded a queued message.” | **W**  |
| 16  | 「每个事件携带整体快照，无增量 patch」                                           | `types.ts:235-241`：`team/message/delivered` 只带 `messageId` + `targetId`，非整体快照                                                                                                                                                                    | **W**  |
| 17  | 「服务端 `list_members` 的 `TeamMemberView.model`」                              | 源码无 `list_members` 标识符；工具名是 `list_agents`（`tool-agent-team/src/index.ts:239-247`），服务方法是 `listMembers`（`agent-team/src/roster.ts:126`）                                                                                                | **W**  |
| 18  | 「`interrupt` 目标须为 `phase==='active'` 队友，否则抛 `TEAM_MEMBER_NOT_FOUND`」 | `roster.ts:48` 先把 `'lead'` 解析为 root；`roster.ts:192` 对 root 抛 `TEAM_INVALID_TARGET`（`team.spec.ts` 断言 `interrupt(lead,'lead')` → `TEAM_INVALID_TARGET`）。该断言对 `'lead'` 目标不成立                                                          | **W**  |
| 19  | §0 引用 `docs/investigation/evidence/01-vitest-attempt.log` 作为测试跑不通的证据      | 该日志非本队产物（见 §2）；实质经我独立复现成立                                                                                                                                                                                                           | **UB** |

### 3.2 `02-tools-and-messaging.md`

| #   | 被核验断言                                                                      | 打开的实际证据                                                                                                                                                                                                                | 判定   |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 20  | harness 只注册 9 个团队工具，无 `multicast/broadcast/team_summary`              | `tool-agent-team/src/index.ts:192-400` 列出 spawn/send/list/wait/interrupt + 4 个 task 工具；全文无 multicast/broadcast/team_summary。注：`interrupt_agent` 受 `config.interrupt` 控制（`:284`），严格说是「8 常驻 + 1 条件」 | V      |
| 21  | 发送正文加 `Team message from <name>:`、按 JSON UTF-8 限长、固定 source         | `agent-team/src/index.ts:230-237`、默认 65536 在 `:62`；`types.ts:186-189`                                                                                                                                                    | V      |
| 22  | `resolveActiveMember`：lead→root，队友必须 active，provisioning 不可寻址        | `roster.ts:42-54`（`:48`、`:50-52`）一致                                                                                                                                                                                      | V      |
| 23  | steer = next-step + wakeup；step 边界消费语义                                   | `core/agent-loop/src/agent.ts:154-173`（steer `:167-169`、inject `:171-173`）、`:361-366`；`core/agent-loop/src/inbox.ts:109-114`；`core/agent/src/runtime-types.ts:215,224-231`                                              | V      |
| 24  | 队友投递经 `steerHostSubagentPrompt(...,'steer')` → `coldResume`（continuable） | `subagent/subagent/src/internal.ts:94-109`；`manager.ts:604-612,1230-1244,1254-1256,1329-1384,1349-1355,1418-1437`（`wake` 在 `:1434`）                                                                                       | V      |
| 25  | 产品层 `quiet`/`wakeup` 行为相同，因 `team-core.send` 收 `delivery` 却不用      | `[S] packages/team-core/src/index.ts:271-289` 确实只使用 `req.range`/`req.content`；`[S] team-bus/src/index.ts:41,63,70` 暴露该参数                                                                                           | V      |
| 26  | Team 不做投递队列                                                               | `tests/team.spec.ts:931-958` 测试名 “passes concurrent attempts to the lower delivery owner without a Team queue”                                                                                                             | V      |
| 27  | 发送不 flush 目标；测试须显式 flush                                             | `tests/team.spec.ts:922-928` 内含 `await ctx.sessions.flush(lead.session)`；发送路径 `index.ts:224-248` 无 flush                                                                                                              | V      |
| 28  | mailbox 事件已废弃；Lead 日志 `team/message/*` 为空                             | `types.ts:233`；生产代码无 emit；`tests/team.spec.ts:907` 精确命中该断言                                                                                                                                                      | V      |
| 29  | `wait_agent`：活跃 peer 判定 + noProgress 短路；notify 三来源                   | `tool-agent-team/src/index.ts:44,269-279`；`agent-team/src/index.ts:89,94-97,246`；`activity.ts:22-66,79-86`                                                                                                                  | V      |
| 30  | 产品层工具「受 `enableBroadcast` 等 **Config 开关**控制（`:102,165,217,243`）」 | `[S] tool-swarm/src/index.ts:102`(enableBroadcast)、`:165`(enableReview)、`:243`(enableWorkspace) 是 Config 开关，但 **`:217` 是 `if (core) {`**（服务存在性判断，非 Config 字段）                                            | **CM** |

### 3.3 `03-ui-wiring-and-docs.md`

| #   | 被核验断言                                                        | 打开的实际证据                                                                                                                                                                                                                                       | 判定   |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 31  | agent-team 在 `:99` 注册投影；定义四要素                          | `agent-team/src/index.ts:99`；`projection.ts:387-394`（key/stateVersion 4/stateSchema/wire）                                                                                                                                                         | V      |
| 32  | `mount.ts` 注册字典与 slot（id/order）、`openTeammate` 归一化     | `client-ui-agent-team/src/client/mount.ts:21,30,32-35,38-50,53-62` 一致                                                                                                                                                                              | V      |
| 33  | Host 半边为空 `apply()`                                           | `client-ui-agent-team/src/index.ts:4` `export function apply(): void {}`                                                                                                                                                                             | V      |
| 34  | 面板取数与状态派生（phase + 实时 status）                         | `TeamAction.tsx:81,82-89,192,193` 一致                                                                                                                                                                                                               | V      |
| 35  | bundle patch：插 3 行、disabled 4 行 legacy 委派                  | `agent-team-profile/cordis.patch.yml:4-14`（4 行 disabled）、`:16-32`（agent-team / tool-agent-team / ui-agent-team）                                                                                                                                | V      |
| 36  | 默认关闭：`OPTIONAL_BUNDLES` + plugin-manager 标 optional         | `boot/app-boot/src/profile.ts:223,229`；`boot/plugin-manager/src/index.ts:329`                                                                                                                                                                       | V      |
| 37  | C5：workspace README 自相矛盾，代码为 `scheduled`                 | `README.md:183,185`（说默认 scheduled）vs `README.md:260`（说仍 autonomous、P19 已取消）；代码 `[S] team-scheduler/src/index.ts:70` `.default('scheduled')`、`:519` `mode: 'scheduled'`、`[S] packages/bundle/cordis.patch.yml:58` `mode: scheduled` | V      |
| 38  | `dsh.client.platform` 必填，`manifest.ts:180-182`                 | `client/modules/src/client/manifest.ts:179-180` 是实际检查行（`:180` 抛错）；结论对，行号偏 1–2 行                                                                                                                                                   | **CM** |
| 39  | modelSelection「定义与注册在 `model-selection-projection.ts:78`」 | `:78` 是 JSDoc，`:81` 函数、`:82` `ctx.sessionProjections.register(modelSelectionProjection)`；结论对，行号落在注释上                                                                                                                                | **CM** |

### 统计

- **VERIFIED = 31**（§01:14，§02:10，§03:7）
- **WRONG = 4**（§01:4）
- **CITATION-MISMATCH = 3**（§02:1，§03:2）
- **UNSUPPORTED-BY-OUR-EVIDENCE = 1**（§01:1，引用物非本队，实质已独立复现）
- 合计 **39** 条，每节均 ≥5 条。

## 4. 重点猎错：最值得警惕的 4 处

1. **把历史 mailbox 事件说成与成员/任务同级的“Lead Session 专属”事件（W，§01:49）**——这最容易误导读者以为 Team 仍自带出站队列。实际只有 `team/member`、`team/task` 带 “stored only in the Team Lead Session” 注释；`queued`/`delivered` 注释明确写“Historical”。
2. **“每个事件携带整体快照”（W，§01:49）**——`team/message/delivered` 只带 `messageId`+`targetId`，会让人误判重放/去重语义。
3. **不存在的工具名 `list_members`（W，§01:200）**——源码中只有 `list_agents` 工具与 `listMembers` 服务方法；跨节引用时也造成 §01 与 §02 术语不一致。
4. **`interrupt` 目标语义被过度概括（W，§01:110）**——`'lead'` 会先被解析为 root 再抛 `TEAM_INVALID_TARGET`，而非 `TEAM_MEMBER_NOT_FOUND`；照抄该句会写出与测试冲突的断言。

## 5. 跨节一致性

- §01 与 §02 对持久化模型（只有 `team/member`、`team/task` 由生产路径写入）**一致**；§02 的“已废弃 mailbox”与 §01 §1.4 的“类型仍在但非活跃投递路径”一致。
- §01 §5 的“failure 态 view 不走缓存”与 §03 §1.1 的“WeakMap 缓存、仅 mailbox 变化复用旧引用”**不矛盾**（§01 已显式限定 failure 分支）。
- 唯一术语分歧：§01 用 `list_members`，§02 用 `list_agents`（同一 API，见 §4.3）。
- 未发现会改变结论的跨节事实冲突。

## 6. 流程发现（共享看板）

`task-4` 在 revision 2 时 `status=in_progress`、`owner=arch-core`，但 `ready=false`（blockers 未完成）/owner 已停止，claim 未被释放；Lead 重新指派前，我的 `claim` 被拒（`team task "task-4" is owned by another member`）。即：**阻塞任务的 claim 可在 blocker 完成后被接受，但 owner 停止时没有自动释放，留下“已认领但无进展”的陈旧看板状态**。建议 Quick 记账/流程改进：owner 停止或 Lead 完成依赖时显式 `release`/`reassign`。

## 7. 必须更正清单（提交 Lead 在合并报告前应用；编号 M1–M7）

1. **M1（§01 §1.4）** 将“4 个事件注释**均写** stored only in the Team Lead Session”改为：_“`team/member` 与 `team/task` 的注释写 ‘stored only in the Team Lead Session’；`team/message/queued`/`delivered` 是历史 mailbox 事件，注释分别写 ‘Historical mailbox enqueue; new sends use the target Agent inbox.’ 与 ‘Historical acknowledgement…’。”_ 依据：`types.ts:229,231,233,235`。
2. **M2（§01 §1.4）** 删除“每个事件携带整体快照，无增量 patch”，改为：_“`team/member`/`team/task`/`team/message/queued` 携带整体快照；`team/message/delivered` 只携带 `messageId`+`targetId`，是投递确认而非快照。”_ 依据：`types.ts:235-241`。
3. **M3（§01 §6.3）** `list_members` → `list_agents`（模型侧工具）/ `listMembers`（服务方法）。依据：`tool-agent-team/src/index.ts:239`、`agent-team/src/roster.ts:126`。
4. **M4（§01 §2.6）** 改为：_“目标须为 `phase === 'active'` 的队友或名字 `'lead'`；名字 `'lead'` 解析为根后会被 `TEAM_INVALID_TARGET` 拒绝，非 active 的具名队友抛 `TEAM_MEMBER_NOT_FOUND`。”_ 依据：`roster.ts:48`、`:192`。
5. **M5（§02 §2.0）** “受 enableBroadcast 等 Config 开关控制（`:102,165,217,243`）”改为 _“`:102` enableBroadcast、`:165` enableReview、`:243` enableWorkspace、`:297` enableSkills、`:315` enableMemory 为 Config 开关；`:217` 是 `if (core)` 服务存在性判断”_（或删去 `:217`）。依据：`[S] packages/tool-swarm/src/index.ts:102,165,217,243`。
6. **M6（§03 §1.2）** 行号 `manifest.ts:180-182` → `:179-180`。依据：`manifest.ts:179-180`。
7. **M7（§03 §1.4）** “`model-selection-projection.ts:78`” → `:81-82`（定义/注册处）。依据：该文件 `:81` 函数、`:82` register。
8. **M0（§01 §0，引用来源）** 保留结论，但把“原始输出存于 `docs/investigation/evidence/01-vitest-attempt.log`”标注为 **非本队产物、仅作旁证**，或改引我复现的两条稳定事实：工作区 `node_modules` 无 `vite-tsconfig-paths`；harness `vitest.config.ts:3` 依赖它。

## 8. 残余不确定

1. **W/CM 之外的语义风险**：`02` 对 `[H] manager.ts` `locks.run` 的“per-child 串行”只核验了调用点，未展开锁实现，跨进程/多实例顺序保证仍未证；该节已自行标为残留不确定。
2. **§02 产品层 `swarm/*` 事件能否跨重启重放**依赖工作区之外的宿主桥；本次未读该宿主层，维持原节 UNVERIFIED。
3. **未做运行时 UI 复验**：未启动 127.0.0.1:3099，§03 §1.3 的可见行为仍是源码级结论。
4. 三节的测试断言均为**读源码**所得，非本轮实际执行；我未运行 harness 单测（工作区缺 `vite-tsconfig-paths`，与 §01 §0 结论一致）。
5. `04-live-session-evidence.md` 与 `evidence/**` 的归属由 Lead 给定，我只对 `session-4e0b08f3` 的成员名做了实证；未逐一鉴定 `evidence/**` 每个文件的实际作者。

## 9. 结论

**Verdict: PASS-WITH-CORRECTIONS。**

三节的主体结构、实体/状态机、CAS 与图校验、投递路径、UI/启用接线等核心论断经独立抽样核验成立（31/39 VERIFIED），无致命错误、无跨节事实冲突；但存在 **4 处 WRONG**（集中在 §01 对历史 mailbox 事件与 `interrupt` 目标的表述、以及一个不存在的工具名）与 **3 处行号偏差**，合并进最终报告前须按 §7 清单更正。其中 M1/M2/M3/M4 为必须项，M5–M7 为精确性修正，M0 为引用来源标注。
