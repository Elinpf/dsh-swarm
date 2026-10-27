# 第 3 部分：UI 投影、启用接线与文档交叉核验

> 范围：UI 消费路径 + 启用/装配路径 + 文档交叉核验 + native 与 dsh-swarm 边界。
> 事件/发射模型（谁 emit、seq、wire 语义）归 `bus-messaging`（task-2），本文只在必要处引用其产物，不重复深潜。
> 代码引用相对 checkout 根 `.runtime/deepseek-harness/`；文档按「文件 + 章节标题」引用。全程只读，未启动 server、未重建 bundle。

## 0. 结论摘要

1. **Web GUI 的团队面板是上游原生能力**：`agentTeam` Session projection 由 `agent-team` 注册（`packages/experimental/agent-team/src/index.ts:99`），经 slot `conversation.session.header.actions` 挂到会话头部（`packages/experimental/client-ui-agent-team/src/client/mount.ts:53-62`）。
2. **UI 层零 RPC、零状态归属**：面板只从共享 Session store 的 `projectionsBySession[lead].values.agentTeam` 读值（`TeamAction.tsx:193`）；Host 半边 `apply()` 为空（`client-ui-agent-team/src/index.ts:4`）。
3. **启用 = 一个 bundle 层**：`@deepseek-ai/dsh-experimental-agent-team-profile` 用 `dsh.bundle.patch` 一次插入 `agent-team` + `tool-agent-team` + `ui-agent-team` 三行，并 disabled 4 个 legacy subagent 委派行（`packages/experimental/agent-team-profile/cordis.patch.yml:4-32`）。
4. **默认关闭、随装提供**：该 profile 在 `OPTIONAL_BUNDLES` 白名单里（`packages/boot/app-boot/src/profile.ts:229`），由插件管理页“开启”写入 `dsh.profile.bundles`（`packages/boot/plugin-manager/src/index.ts:329`）。
5. **dsh-swarm 不新增 Web UI**：workspace 全部 `packages/*/package.json` 无 `dsh.client` 声明，roster/task-board 完全复用原生面板；dsh-swarm 自建的 `in_review`/`planned` 等叠加态**不会出现在该面板**（面板只消费原生 4 态投影，`TeamAction.tsx:33-41`）。
6. **核验出 1 处 workspace 文档自相矛盾**：README §「任务派发模式」说默认已是 `scheduled`，§「当前阶段状态」末尾却说默认仍是 `autonomous`——代码为 `scheduled`（见 §3.C5）。

---

## 1. 团队状态如何到达 Web GUI

### 1.1 Host 侧：projection 定义与注册

- `agent-team` 注入 `sessions` / `sessionProjections` 等（`packages/experimental/agent-team/src/index.ts:57`），在根 fiber 注册投影定义：`ctx.root.sessionProjections.register(teamProjectionDefinition)`（同文件 `:99`）。
- 定义四要素：`key: 'agentTeam'`、`stateVersion: 4`、`stateSchema`、`wire.{viewSchema, view}`（`packages/experimental/agent-team/src/projection.ts:387-394`）。
  **`wire` 块决定该 key 对客户端可见**——没有 wire 的内部投影不会进 GUI。
- 两张类型表分别合并：host 折叠态 `SessionProjectionStateMap.agentTeam`（`projection.ts:161-165`）与客户端可见值 `SessionProjectionMap.agentTeam`（`packages/experimental/agent-team/src/types.ts:121-123`）。
- UI 面向的转换集中在 `buildTeamProjection`（`projection.ts:342-361`）：
  - 合成一行 `lead`（`id = rootId, role: 'lead', phase: 'active'`，`:344`）；
  - 任务视图过滤掉 `deleted` 墓碑（`:357`）；
  - `failure` 原样透出，members/tasks 停在最后一次有效状态（`:354-360`）。
- `teamProjectionView` 用 WeakMap 按 members/tasks 引用缓存视图；仅 mailbox 变化复用旧引用，因此不发布新快照（`projection.ts:371-384`）。
- **到达浏览器前的一段**（snapshot 分发/一致性切面）属 `bus-messaging` 深潜范围；本文只确认消费端契约是 `SessionProjectionSnapshot.values`。

### 1.2 客户端插件如何被发现与注册

- 发现机制：包的 `package.json` 声明 `dsh.client`，由 `parseDshClient` 校验（`packages/client/modules/src/client/manifest.ts:165-197`；`platform` 必填字符串校验在 `:179-180`，**行号更正（verifier 检查 6）**）。`client-ui-agent-team/package.json` 声明 `"platform": "web"`、`inject`（api-session-controller / client-locale / ui-conversation / ui-primitives / ui-workspace）与 `exports["./client"]`。
- 注册内容（`mount.ts`）：
  - `inject = ['sessions', 'uiWorkspace', 'slots', 'locale']`（`:21`）；
  - 注册中英文字典 `ctx.locale.register(NS, { zh, en })`（`:30`，字典见 `client/locales.ts:7-65`）；
  - 向 slot `conversation.session.header.actions` 注册 `id: 'agent-team'`、`order: -20` 一个组件（`:53-62`）；
  - 唯一的业务回调 `openTeammate`（`:38-50`）：先把当前 Session 归一到 lead（`:32-35`，读 `subagent.address.parentSessionId`），主视图未 retain 则直接返回（`:40`），否则 `uiWorkspace.openSession({parentSessionId, childSessionId, mode: 'continuable'})`；`childSessionId === parentSessionId` 时直接打开 lead Session（`:41-44`）。
- Host 半边是空实现：`export function apply(): void {}`（`client-ui-agent-team/src/index.ts:4`）——README 所述 “root Host export is inert”。

### 1.3 组件消费与用户可见行为

- 取数（`TeamAction.tsx`）：`leadSessionId` 来自当前 Session 的 `subagent.address.parentSessionId`（`:192`）；`team` 来自 `projectionsBySession[leadSessionId]?.values.agentTeam`（`:193`）；加载态来自 Session 打开状态与列表 phase（`:194-195`）。
- store 来源：客户端 Session 列表状态由 `projectionStores` 汇总为 `projectionsBySession`（`packages/api/session-controller/src/client/sessions/manager.ts:819`）；组件经 `useSessions` 订阅，因此面板打开期间更新自动出现。
- 状态派生：成员行 = 原生 `phase` + 实时 Session status，`active` 且正在运行才显示 running，否则 inactive（`:82-89`）；模型名来自各成员自己的 `modelSelection` 投影（`:81`、`:117-119`）。
- 用户看到/可做：
  - 会话头部一个「智能体团队」触发器（hover 150ms 或点击固定在 Portal 面板，`TeamAction.tsx:223-247`、`:290-355`）；
  - 「成员」区：名称、状态点/人形图标、`当前会话` 标签、模型名、成员错误诊断（`:91-125`）；点击非当前、非 failed/provisioning 成员打开其 continuable 子会话（`:89`、`:97-103`）；
  - 「共享任务」区：subject、status、两行截断+展开（`:129-176`）、owner/unowned、ready/blocked、blockedBy、writeScopes、写域冲突告警（`:167-172`）；**只读**，无任何任务变更控件；
  - 无 Team 值且加载结束后显示 unavailable，投影 `failure` 时在最后有效状态上方显示错误条（`:306-316`）。
- **零 Team RPC**：`mount.ts` 的 JSDoc 明确“this registration performs no Team RPC”（`:24-26`），组件内也没有 Remote 命名空间调用；`client-ui-agent-team/README.md` §Understand the implementation 亦如此声明（本次以“代码中不存在 Remote 注册”作旁证核验，未做运行时抓包）。

### 1.4 端到端链路（调用点）

```
cordis.yml 行 ui-agent-team ──▶ client bundle loader
   └─ package.json dsh.client{platform:web} + exports["./client"]   manifest.ts:165-197
        └─ mount.ts:29 registerAgentTeamUi
             ├─ locale.register(NS)                        mount.ts:30
             └─ slots.register('conversation.session.header.actions', id='agent-team')
                                                           mount.ts:53-62
                  └─ TeamAction (React)
                       └─ useSessions → projectionsBySession[lead].values.agentTeam
                                                           TeamAction.tsx:193
                            ▲
host: agent-team 注册 agentTeam 投影（wire.view）  agent-team/src/index.ts:99
      projection.ts:387-394 → 客户端 Session store     manager.ts:819
```

- 旁路投影：成员行的模型名走 `modelSelection`（`TeamAction.tsx:81`），其定义与注册在 `packages/api/session-controller/src/model-selection-projection.ts:81-82`（**行号更正（verifier 检查 7）**：`:78` 是 JSDoc）——即面板同时消费**两个**投影，只有 `agentTeam` 是团队域自己的。
- 因此“团队状态到 GUI”不存在单独的 Team 传输通道：它与其它 Session projection 共用同一条 snapshot 通道，UI 端只是按 key 取值。

---

## 2. 如何启用团队模式

### 2.1 权威路径：插件页开关 / CLI 加 bundle

1. `agent-team-profile` 的运行时内容就是 patch 文档，`src/index.ts` 仅 `export {}`（`packages/experimental/agent-team-profile/src/index.ts:8`；`package.json` 的 `dsh.bundle.patch`）。
2. patch 的三件事（`cordis.patch.yml`）：
   - disabled 4 行 legacy 直属委派：`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`（`:4-14`）；
   - insert `agent-team`，配置 `maxMembers: 8 / maxTasks: 256 / maxMessageBytes: 65536 / disposalTimeoutMs: 5000`（`:17-23`）；
   - insert `tool-agent-team`（`freshProvider: spawn`、`forkProvider: fork`，`:25-29`）与 Web UI 行 `ui-agent-team`（`:31-32`）。
3. 默认关闭：该 bundle 被列入 `OPTIONAL_BUNDLES`（`packages/boot/app-boot/src/profile.ts:223-236`，其中 `:229` 为 agent-team-profile）；插件管理服务据此把它标成 `optional`（`packages/boot/plugin-manager/src/index.ts:329`），即以“已提供但未开启”的卡片呈现，不进入任何 shipped profile 模板。
4. 打开动作写 `dsh.profile.bundles`；loader 按该有序列表逐层叠加 patch（`packages/boot/app-boot/src/profile.ts:7-12`、`:95-107`）。
5. CLI（README §Use this package → §Install into a profile 给出）：`dsh plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile`、`dsh plugin --profile web add ...`。**前提**：profile 必须已含 `@deepseek-ai/dsh-base`（同章节），因为该 patch 复用 base 的 Subagent 服务与 provider 行。

### 2.2 哪些能力是 opt-in

| 能力                         | 开关/默认                                                                    | 证据                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 团队域服务 `ctx.agentTeams`  | 由 `agent-team` 行决定；行不存在即无服务                                     | `cordis.patch.yml:17-23`                                                                                 |
| 团队工具（spawn/send/task…） | `tool-agent-team` 行 opt-in                                                  | `cordis.patch.yml:25-29`                                                                                 |
| Web roster/task-board        | `ui-agent-team` 行 + `dsh.client` 声明                                       | `cordis.patch.yml:31-32`                                                                                 |
| 容量/超时上限                | `Config` 字段：`maxMembers`/`maxTasks`/`maxMessageBytes`/`disposalTimeoutMs` | `docs/config-catalog.md` §`@deepseek-ai/dsh-experimental-agent-team`（源 `agent-team/src/types.ts:153`） |
| spawn/fork provider          | `freshProvider`/`forkProvider`                                               | `cordis.patch.yml:25-29`                                                                                 |
| 原生直属 subagent 委派       | **被该 bundle 关闭**（代价项，非收益项）                                     | `cordis.patch.yml:4-14`                                                                                  |

注意：panel/config 侧 `client-ui-agent-team` 无用户配置字段（`docs/config-catalog.md` 行 `:4654` 的配置列为 “—”）。

### 2.3 装配顺序、回退与覆盖点

- **层序**：loader 以空的 entry 列表为底，按 `dsh.profile.bundles` 顺序逐层 apply patch（`profile.ts:7-12`）；用户 patch 层最后应用（`profile.ts:238-243` 的模板注释）。因此 agent-team-profile 必须先于 dsh-swarm bundle，且两者对 `tool-subagent*` 的 disabled 是**同向**的（`packages/bundle/cordis.patch.yml` 重复了同样 4 行，见其文件头注释“原生团队域由 agent-team-profile 提供，本 bundle 不重复插入”）。
- **回退**：`dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-team-profile` 会把它从有序层列表移除（README §Install into a profile），行随之消失；`ui-agent-team` 也可继续被用户 patch 按 id 覆盖（README 同章节：“User patches targeting `ui-agent-team` still apply”）。
- **web 与 headless 差异**：CLI 安装命令分 `--profile web` / `--profile headless`（README §Install into a profile），但**三行 patch 内容相同**；差异只在于 web profile 是否实际渲染客户端插件——`ui-agent-team` 行在 headless 下不产生 UI，`dsh.client.platform: 'web'` 声明只被 Web 客户端模块加载器消费。
- **用户可见文案**全部走字典（`client/locales.ts:7-65`，NS=`agent-team`）：触发器「智能体团队 / Agent Team」、`roster`=成员、`tasks`=共享任务、`failure`=「团队持久记录无效：{message}」；4 个任务态与 4 个成员态均有中英 key，无硬编码文案（对齐 AGENTS.md 的 locale-owned 约束）。

---

## 3. 文档 vs 代码：5 条具体断言

| #   | 文档断言                                                                                                                                                                         | 代码证据                                                                                                                                                                      | 结论                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1  | `docs/subsystems/agent-team.md` §Web projection：Lead Session 发布 `SessionProjectionMap.agentTeam`，含 durable roster 行与**非 deleted** 任务视图；`failure` 与最后有效状态并存 | `projection.ts:387-394`（key/wire）、`:357`（过滤 deleted）、`:354-360`（failure 透出）、`types.ts:121-123`（SessionProjectionMap 合并）                                      | **一致**（类型块逐字等于 `types.ts:115-119`）                                     |
| C2  | `client-ui-agent-team/README.md` §Use this package：Web Client loader 挂载 `/client`；root Host export 无行为；包无用户配置字段                                                  | `package.json` `exports["./client"]` + `dsh.client.platform=web`；`src/index.ts:4` 空 `apply()`；config-catalog `:4654` 配置列 “—”                                            | **一致**                                                                          |
| C3  | `agent-team-profile/README.md` §Summary：bundle 随 dsh 提供但默认关闭，可从 Plugins 页开启或加入已初始化 profile                                                                 | `profile.ts:229`（OPTIONAL_BUNDLES）、`plugin-manager/src/index.ts:329`（optional 判定）                                                                                      | **一致**                                                                          |
| C4  | `agent-team-profile/README.md` §Summary：普通 subagent 委派与重叠的全局 child control 被禁用；Workflow 仍可建 fresh 子代理                                                       | `cordis.patch.yml:4-14` 只 disabled 4 个 `tool-subagent*` 行，未触碰任何 workflow 行                                                                                          | **一致**                                                                          |
| C5  | workspace `README.md` §任务派发模式：默认已是 `scheduled`（破坏性变更）；§当前阶段状态末尾：默认**仍是** `autonomous`，P19 已取消                                                | `packages/team-scheduler/src/index.ts:70` `union([...]).default('scheduled')`，`:519` 默认配置 `mode: 'scheduled'`；`packages/bundle/cordis.patch.yml` 亦写 `mode: scheduled` | **DRIFT（workspace 自相矛盾）**：§任务派发模式 与代码一致；§当前阶段状态 末段过时 |

补充核验（同属“文档断言 vs 代码”，不计入上表 5 条）：

- workspace `README.md:190` “`team-core` 是唯一接触实验性 `ctx.agentTeams` 的包”：grep 全仓仅 `team-core/src/index.ts` 与 `team-core-contract/src/index.ts` 命中；后者只用类型增强、无运行时接触，故**基本成立**（严格说是“唯一运行时接触”）。
- workspace `README.md:194` 与 `docs/verification.md` §H.4 “Web UI 未写”：workspace 所有 `packages/*/package.json` 均无 `dsh.client`，无一 `.tsx`/slot 消费代码 → **成立**；但须注明这是“dsh-swarm 自己没写”，Web 上其实**有**原生面板（§4）。
- workspace `docs/adr/0002` §3 抽查两条行号：`swarm/core/review-entered` emit `team-core/src/index.ts:425`、fold `:547` — 实读命中 → **一致**（该 ADR 自称经 P41 同步，抽查支持该说法）。

---

## 4. native 与 dsh-swarm 的扩展边界

| 关注点                                                              | 归属                   | 证据 / 说明                                                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 团队域服务 `ctx.agentTeams`（roster/inbox/task DAG/child 生命周期） | **native**             | `packages/experimental/agent-team`；`docs/architecture.md` §（Agent Teams 段，`:136`）称其为 opt-in                                                              |
| 事件与快照（`team/*` durable 事件、projection wire）                | **native**             | `agent-team/src/index.ts:99`；细节归 task-2                                                                                                                      |
| 模型侧团队工具                                                      | **native**             | `packages/experimental/tool-agent-team`（`cordis.patch.yml:25-29`）                                                                                              |
| Web roster / task-board / 成员导航                                  | **native**             | `client-ui-agent-team`（本文 §1）                                                                                                                                |
| 一键启用与 legacy 委派关闭                                          | **native**             | `agent-team-profile`（§2）                                                                                                                                       |
| 端口类型 SSOT（`TeamCore`/`TaskView` 等）                           | **dsh-swarm**          | `packages/team-core-contract`（ADR-0001 §3 方案 C）                                                                                                              |
| native seam 适配（`AgentTeamsSeam`，不 import 实验包类型）          | **dsh-swarm**          | `packages/team-core/src/index.ts:31-60`；JSDoc `:5-10`                                                                                                           |
| `in_review` / `planned` 等叠加态、评审闸、计划闸、调度派发          | **dsh-swarm**          | README §任务状态机 / §计划闸 / §任务派发模式                                                                                                                     |
| durable `swarm/*` 事件 + fold 恢复                                  | **dsh-swarm**          | `docs/adr/0002-durable-state-convention.md` §3-4；`packages/team-durable`                                                                                        |
| **面板可见性**：dsh-swarm 的任务叠加态是否显示在 Web                | **不显示（边界缺口）** | 面板只用原生 4 态投影；`TeamAction.tsx:33-41` 只 switch `pending/in_progress/completed/deleted`，无 `in_review`/`planned`；dsh-swarm 也无自己的 projection/UI 包 |

结论：dsh-swarm 是**在原生团队域之上叠加治理能力**（契约、评审/计划闸、调度、持久化约定），**没有**接入 Web 投影链路，因此原生面板展示的仍是 native 视角的 roster 与任务状态；两者状态必须分开读。

---

## 5. 残余不确定（UNVERIFIED）

1. **无运行时 UI 证据**：未启动 http://127.0.0.1:3099 做浏览器验证，§1.3 的可见行为均来自源码与 README 对照；投影 wire 的实时一致性（snapshot 原子性、加载态切换）属 task-2 结论。
2. **“面板不发起 RPC”** 为代码缺失证据（无 Remote namespace 注册）而非抓包结论。
3. 插件管理页“开启即写 `dsh.profile.bundles`”依据 host 服务与单测（`plugin-manager/tests/manager.spec.ts:1135` “offers ... switched off and never removable”），未在真实 GUI 点击复验。
4. workspace 的 profile 回归数字（`docs/verification.md:347-357`：bundle 11 行 + 原生 2 行 + legacy 4 行 disabled）来自其自报实跑输出，本次未重跑。
5. `docs/adr/0002` 只抽查 2 条行号，其余事件表行号未逐一核对。
