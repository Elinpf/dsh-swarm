# 第 3 部分：UI 投影、启用接线与文档漂移（task-3 实证版）

> **证据根**：
>
> - `[H]` = `.runtime/deepseek-harness/`（上游 harness checkout，**只读**；本次引用的 [H] 文件 mtime 均为 2026-10-27 11:29:36，sha256 见 `docs/investigation/evidence/03-file-fingerprints.txt`）。
> - `[W]` = 本仓工作区（workspace 根）；`[P]` = 本实例 profile 目录 `.runtime/dsh-home/profiles/dsh-swarm-demo/`。
> - 证据文件：`docs/investigation/evidence/03-{file-fingerprints,instance-assembly,composed-entries,bundle-patch-snapshot}.txt`、`03-compose-probe.mjs`。
>
> **方法与边界**：全程只读。未启动/重启任何 server，未重建 bundle，未修改源码、profile 或他人文件。本文不重复 task-2（bus/messaging）对 snapshot 分发与一致性的深潜，只在必要处引用其契约。
>
> **`[W]README.md` 快照约定（审计后补记）**：本文全部 `[W]README.md` 行号基于 sha256 `568cea4c8fcb4311…`（mtime 16:20）的快照。该文件已于 **16:56:02** 被并发写入者修改为 sha256 `45c39bc914e6bc5b…`（在 `:209` 起插入「集群模式 agent preset」等 7 行），行号整体平移：原 `:255/258/260` → 现 `:262/265/267`。**§5 C5 所述「README 自相矛盾」在现工作区已被修掉**（现行 `:267` 段已写明「默认即 `scheduled`」并自标旧写法为更正）；引用 README 时请以本快照号为准并核对平移后的行号。
>
> **并发写入警告（重要）**：调查期间 `[W]packages/bundle/cordis.patch.yml` 于 **16:39:44** 被其他成员修改（新增 `agent-preset-registry` 顶层 config 与第二个 patch 文件 `presets/swarm.patch.yml`）。本文对该文件的引用一律以 `docs/investigation/evidence/03-bundle-patch-snapshot.txt` 固定版（sha256 `b3de4c7f3137a067…`）为准，并在 §2.5 报告由此产生的装配异常。此外本文件所在目录中 `01-*`/`02-*`/`04-*` 证据不由我维护。

---

## 0. 结论摘要

1. **Web 团队面板是上游原生能力，dsh-swarm 未接入 UI**：`agentTeam` 会话投影由 `agent-team` 注册（`[H]packages/experimental/agent-team/src/index.ts:99`），只发布带 `wire` 块的投影（`[H]packages/experimental/agent-team/src/projection.ts:386-394`），面板经 slot `conversation.session.header.actions` 挂到会话头部（`[H]packages/experimental/client-ui-agent-team/src/client/mount.ts:53-62`）。
2. **UI 层零 Team RPC、零状态归属**：面板只从共享 Session store 的 `projectionsBySession[lead].values.agentTeam` 读值（`[H]…/client/TeamAction.tsx:193`），Host 半边 `apply()` 为空（`[H]…/client-ui-agent-team/src/index.ts:4`），`src/` 无任何 Remote 命名空间注册或 rpc 调用（详见 §1.4）。
3. **启用 = 一个 bundle 层**：`@deepseek-ai/dsh-experimental-agent-team-profile` 用 `dsh.bundle.patch` 一次 disabled 4 个 legacy 委派行并 insert `agent-team` + `tool-agent-team` + `ui-agent-team`（`[H]packages/experimental/agent-team-profile/cordis.patch.yml:4-32`）。
4. **本实例实测装配**：`[P]package.json:10-16` 的 `dsh.profile.bundles` 为 `dsh-base → dsh-web-app → agent-team-profile → @elinpf/dsh-swarm-bundle → inspector-profile`；只读复现得 **212 条有效 entry**，原生三行 + dsh-swarm 14 行 + 用户 patch 的 `preset-swarm` 均在位（`docs/investigation/evidence/03-composed-entries.txt:201-226`）。**运行中的 Lead 会话日志已产生 8 条 `team/member` + 12 条 `team/task` 事件**，projection 缓存里 `agentTeam` 行有 4 名成员 6 个任务。
5. **默认关闭、随装提供**：该 profile 在 `OPTIONAL_BUNDLES` 白名单（`[H]packages/boot/app-boot/src/profile.ts:229`），插件管理页的开关写 `dsh.profile.bundles`（`[H]packages/boot/plugin-manager/src/index.ts:509-515`、`:823-825`）。
6. **dsh-swarm 不新增 Web UI**：`[W]packages/*/package.json` 无 `dsh.client`，无 `.tsx`；自建 `in_review`/`planned` 叠加态**不会出现在原生面板**（面板只 switch 原生 4 态，`TeamAction.tsx:33-41`），只在 `team-core` 自己的端口读侧做 overlay（`[W]packages/team-core/src/index.ts:625-630`、`:298-304`）。
7. **文档漂移共 3 处**（细节见 §5 与 §8）：C5（workspace README 自相矛盾）、草稿 C1 的类型块行号、以及 `docs/verification.md` 早期章节的「插入行数 = 11 vs 现状 14」。

---

## 1. 团队状态如何到达 Web GUI

### 1.1 Host 侧：投影定义与注册

- `agent-team` 服务注入 5 个依赖：`agents / sessions / sessionPersistence / sessionProjections / subagents`（`[H]packages/experimental/agent-team/src/index.ts:57`）。
- 在根 fiber 注册投影定义，disposer 与 runtime 释放绑定（`[H]…/agent-team/src/index.ts:98-107`，注册调用 `:99`）。
- 定义四要素：`key:'agentTeam'`、`stateVersion:4`、`stateSchema`、`wire:{viewSchema,view}`（`[H]…/projection.ts:386-394`）。**只有带 `wire` 的 unit 才产出客户端值**：session 投影分发侧显式跳过无 wire 的注册（`[H]packages/session/session-projection/src/index.ts:347`、`:371`、`:457`），因此「内部投影不进 GUI」不是约定而是机制。
- 类型表两处合并：
  - host 折叠态 `SessionProjectionStateMap.agentTeam`（`[H]…/projection.ts:161-165`，类型体 `:156-159`）；
  - 客户端可见值 `SessionProjectionMap.agentTeam`（`[H]…/types.ts:121-126`，`agentTeam` 成员在 `:124`）。**草稿写 `:121-123` 不准确**（见 §8 更正 2）。
- state 与 wire 的差别有实测旁证：本实例 projection 缓存的 `agentTeam.val` 是 `TeamProjectionState`（含 `messages`/`delivered`/`nextTaskNumber`，`docs/investigation/evidence/03-instance-assembly.txt` §6），而 wire 视图只有 `members/tasks/failure`（`projection.ts:333-337`、`:342-361`）。
- 每个会话各有一份 `agentTeam` 状态：`init: header => emptyTeamState(header.id)`（`[H]…/projection.ts:391`），apply 时按 `selector.teamId !== state.id` 丢弃非本队事件（`[H]…/projection.ts:230`）。实测：teammate `wiring-ui` 自己的缓存里 `agentTeam.val.id` = **自己的** session id 且 members/tasks 为空（`docs/investigation/evidence/03-instance-assembly.txt` §7）——所以面板必须显式读 **Lead** 会话的那一行。
- UI 面向的转换集中在 `buildTeamProjection`（`[H]…/projection.ts:342-361`）：合成 `lead` 行（`id = rootId, role:'lead', phase:'active'`，`:344`）；任务视图过滤 `deleted` 墓碑（`:357`）；`failure` 原样透出（`:359`，`failure` 为终态见 `:226`）。
- `teamProjectionView` 用 WeakMap 按 `members`/`tasks` 引用缓存视图；仅 mailbox 变化时复用旧引用、不发布新快照（`[H]…/projection.ts:339-340`、`:371-384`）。
- 原生任务态**闭集 4 值**：`z.enum(['pending','in_progress','completed','deleted'])`（`[H]…/projection.ts:82`，wire 视图 schema 同 `:325`）——这是 §6 边界的根因。

### 1.2 snapshot 到 store 的一段（引用，不深潜）

- `ProjectionSnapshot.values` 的定义与语义在 `[H]packages/session/session-projection/src/index.ts:107-117`（`values: Partial<SessionProjectionMap>`，并入 `asOfSeq` 水位）。
- 客户端 Session 列表把每个会话的投影汇成 `projectionsBySession`（`[H]packages/api/session-controller/src/client/sessions/manager.ts:819-822`，类型 `:50-58`）。
- snapshot 的原子性、帧分发与断线重连归 task-2；本文只依赖「消费端拿到的是 wire 视图」这一契约。

### 1.3 客户端插件如何被发现与注册

- 发现：Loader 行的包 `package.json` 必须声明 `dsh.client`，由 `parseDshClient` 校验（`[H]packages/client/modules/src/client/manifest.ts:173-193`；`platform` 必填字符串在 `:179-181`）；`resolveMeta` 只把 `platform === 'web'` 的行当浏览器行（`[H]packages/client/modules/src/index.ts:858-865`），并要求 `exports["./client"]` 存在（`:866-869`）。**草稿的 `manifest.ts:165-197` 起止偏差**（见 §8 更正 3）。
- 声明：`[H]packages/experimental/client-ui-agent-team/package.json` 有 `exports["./client"]`（`:21-24`）与 `dsh.client = { inject:[api-session-controller, client-locale, ui-conversation, ui-primitives, ui-workspace], platform:'web' }`（`:29-40`）。
- 注册（`mount.ts`）：
  - `inject = ['sessions','uiWorkspace','slots','locale']`（`:21`）；
  - 注册中英字典 `ctx.locale.register(NS, { zh, en })`（`:30`；字典 `client/locales.ts`）；
  - `slots.inject('conversation.session.header.actions', () => slots.register({ name, id:'agent-team', order:-20, locale:NS, inject:() => actions }, TeamAction))`（`:53-62`）；
  - 唯一业务回调 `openTeammate`（`:38-50`）：先把当前 Session 归一到 lead（`:32-35`，读 `subagent.address.parentSessionId`），主视图未 retain 直接返回（`:40`），`childSessionId === parentSessionId` 时直接打开 lead 会话（`:41-44`），否则 `openSession({parentSessionId, childSessionId, mode:'continuable'})`（`:45-49`）。
- Host 半边空实现 `export function apply(): void {}`（`[H]…/client-ui-agent-team/src/index.ts:4`），对应该包 README 的 “root Host export is inert”（`[H]…/client-ui-agent-team/README.md:28`）。

### 1.4 组件消费与用户可见行为

- 取数（`TeamAction.tsx`）：`leadSessionId` 来自当前 Session 的 `subagent.address.parentSessionId`（`:192`）；`team` 来自 `projectionsBySession[leadSessionId]?.values.agentTeam`（`:193`）；加载态来自会话打开 state 与列表 phase（`:194-195`）。
- 成员行：`model` 取自各成员自己的 `modelSelection` 投影 `…?.next?.model`（`:81`）；`running` 取 `useSessionStatus` 并以列表 summary 兜底（`:82-83`）；状态派生 `active ? (running ? 'running' : 'inactive') : phase`（`:84-86`）；`inert` 条件（当前会话 / failed / provisioning）`:89`，点击打开非 inert 成员 `:97-103`；渲染 `:91-125`（当前会话 Tag `:113`，模型名 `:117-119`，成员错误诊断 `:121`）。
- 任务卡 `TaskCard`（`:129-176`）：subject + 状态点（`:147-152`）、两行截断与展开（`:133-144`、`:154-165`）、meta 行含 id/owner/unowned/ready/blocked/blockedBy/writeScopes/写域告警（`:167-172`）、**只读**（无任何变更控件）。
- 面板：hover 150ms 打开 / 离开 120ms 关闭（`:223-245`）、Escape 与外部点击关闭（`:247-261`）、Portal + 定位（`:290-301`）、compact 单列（`:263`、`:293`）、无 Team 值时按加载态给 loading/unavailable（`:306-311`）、`failure` 显示在最后有效状态上方（`:314-316`）。
- **零 Team RPC**：`mount.ts` JSDoc 声明 “this registration performs no Team RPC”（`:23-26`），`src/` 中没有任何 Remote 命名空间注册或 rpc 调用（唯一出现 “RPC” 字样的是 `src/index.ts:3` 的归属注释 “Host RPC domain” 与 `mount.ts:26` 的否定声明）；包 README 亦声明 “it mounts no Remote namespace”（`[H]…/client-ui-agent-team/README.md:50`）。这是「代码中不存在」的缺失证据，未做运行时抓包（见 §7.2）。
- **文案全部字典化**：NS = `agent-team`（`client/locales.ts:4`），zh `:7-33` / en `:39-65`。注意**任务态只有 3 个 key**（`status.pending/in_progress/completed`，`:30-32`），`deleted` 在 `statusKey` 里复用 `status.completed`（`TeamAction.tsx:38-40`）；成员态 4 个 key（`memberStatus.*`，`:26-29`）。**草稿「4 个任务态均有中英 key」不准确**（见 §8 更正 4）。

---

## 2. 本实例（DSH_PROFILE=dsh-swarm-demo）如何被启用（实测）

### 2.1 profile 侧：清单与 patch 层

| 事实                    | 证据                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本会话环境              | `DSH_PROFILE=dsh-swarm-demo`、`DSH_PROFILE_DIR=…/profiles/dsh-swarm-demo`、`DSH_WEB_URL=http://127.0.0.1:3099`（`docs/investigation/evidence/03-instance-assembly.txt` §1）                                          |
| profile 包清单与顺序    | `[P]package.json:10-16`：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-experimental-agent-team-profile`、`@elinpf/dsh-swarm-bundle`、`@deepseek-ai/dsh-experimental-inspector-profile` |
| 依赖安装方式            | `[P]package.json:5` 钉 `0.2.1-rc.3`；`:6` `@elinpf/dsh-swarm-bundle` 为 `link:` 指向 `[W]packages/bundle`（`node_modules/@elinpf/dsh-swarm-bundle -> ../../../../../../packages/bundle`）                       |
| 根 cordis.yml           | `[P]cordis.yml:4` 只有 `[]`：entry 树完全由 bundle patch + 用户 patch 组成                                                                                                                                      |
| 用户 patch 层           | `[P]cordis.patch.yml:4-130` insert `preset-swarm`；`:133-135` 覆盖 `agent-preset-registry.config.default = swarm`；`:136-139` 覆盖 `ui-settings-general`。**该层没有 disabled 任何 `tool-subagent*`**           |
| 运行时会话选中的 preset | 运行中 Lead 会话首行事件含 `"agentPreset":"swarm"`（`investigation-live/session-events.jsonl:1`，该文件是本次调查期间由队友导出的运行日志，非持久化会话文件本体）                                               |

### 2.2 bundle 层：原生三行从哪来

- `@deepseek-ai/dsh-experimental-agent-team-profile` 是 **dsh CLI 安装的运行时依赖**（该 CLI 清单不在 `[H]` 下，实为 `.runtime/dsh-cli-npm/node_modules/@deepseek-ai/dsh/package.json:41`），bundle 解析**安装优先**：`resolveBundleDir` 先安装锚点、再 profile 目录（`[H]packages/boot/app-boot/src/profile.ts:714-725`）。只读探针实测该 layer 解析到安装副本 `.pnpm/@deepseek-ai+dsh-experimental-agent-team-profile@0.2.1-rc.3_…`，其 `cordis.patch.yml` 与 `[H]` checkout 源**逐字节相同**（`docs/investigation/evidence/03-composed-entries.txt:8-9`、`03-compose-probe.mjs` 末尾断言）。
- 该 patch 的三件事（`[H]packages/experimental/agent-team-profile/cordis.patch.yml`）：
  - `:4-14` disabled `tool-subagent-control` / `tool-subagent-list-agents` / `tool-subagent` / `tool-subagent-fork`；
  - `:16-23` insert `agent-team`（`maxMembers:8 / maxTasks:256 / maxMessageBytes:65536 / disposalTimeoutMs:5000`）；
  - `:25-29` insert `tool-agent-team`（`freshProvider: spawn`、`forkProvider: fork`）；`:31-32` insert `ui-agent-team`。
- bundle 的运行时内容就是 patch 文档，`src/index.ts` 仅 `export {}`（`[H]…/agent-team-profile/src/index.ts:1-8`），`package.json` 的 `dsh.bundle.patch` 指向该文件。
- `@elinpf/dsh-swarm-bundle`（第二层）**不重复插入原生两行**，只在 `[W]packages/bundle/cordis.patch.yml` 重复同样 4 条 disabled（快照 `:10-17`），并 insert 14 行 dsh-swarm 自身包（快照 `:24` 起；`team-core :26`、`team-scheduler` 的 `mode: scheduled` 在快照 `:58`、`team-human :108`）。

### 2.3 实测有效 entry 列表（只读复现）

- 复现方式：`docs/investigation/evidence/03-compose-probe.mjs` 调用**与 dsh CLI 同一份** `@deepseek-ai/dsh-app-boot` 的 `loadProfileDirectory()` + `composeEntries()`（`[H]packages/boot/app-boot/src/profile.ts:740-774`、`:816-823`），只读文件、不写回、不启动 server。
- 结果：`skippedBundles: []`，**212 条有效 entry**（`docs/investigation/evidence/03-composed-entries.txt`）。关键行：
  - `:83-86` 4 条 legacy 委派行 `DISABLED`；
  - `:201` `agent-preset-registry`（web-app 提供；被用户 patch 覆盖 default）；
  - `:206-208` `agent-team` / `tool-agent-team` / `ui-agent-team` ← **本会话团队模式的三个根行**；
  - `:209-222` dsh-swarm 14 行（`team-core` … `team-human`）；
  - `:223` 与 `:226` **两条 `preset-swarm`**（见 §2.5）。

### 2.4 运行期实证：团队域确实在跑

- Lead 会话事件：`team/member` × 8、`team/task` × 12（`docs/investigation/evidence/03-instance-assembly.txt` §8；源 `investigation-live/session-events.jsonl`）——即原生 `agentTeam` 投影正在被这些事件驱动。
- projection 缓存（`.runtime/dsh-home/storages/session_projcache/sessions/session-4e0b08f3-….json`；**采样时刻 16:43**）中 `agentTeam` 行 `ver=4, seq=358`，成员 4 名（core-model / tools-messaging / wiring-ui / auditor，全 `active`、`provider=spawn`），任务 6 个（`task-1…task-6`，态取值为 `pending|in_progress`）（`03-instance-assembly.txt` §6）。**这就是 GUI 面板 `values.agentTeam` 的上游数据本体**（只是 state，wire 视图另由 `teamProjectionView` 生成）。
- 对照：`modelSelection.val` 在缓存里是 `{lastUsed,pending}`（state），而面板读的是 wire 的 `next`（`[H]packages/api/session-controller/src/model-selection-projection.ts:63-66`、`TeamAction.tsx:81`）——再次印证「缓存=state / 面板=wire」。

### 2.5 并发写入造成的装配异常（须 Lead 处置，非本文结论）

`[W]packages/bundle/cordis.patch.yml` 在 16:39:44 被其他成员改为「新增顶层 `agent-preset-registry.config.default = swarm`（快照 `:19-22`）+ `dsh.bundle.patch` 增加第二个文件 `presets/swarm.patch.yml`」，而 `[P]cordis.patch.yml:4-130` 仍保留自己的 `preset-swarm` insert，于是有效 entry 列表出现**两条同 id `preset-swarm`**（`03-composed-entries.txt:223`、`:226`；`packages/bundle/presets/swarm.patch.yml:3-4` 与 `[P]cordis.patch.yml:4-5`）。

- patch 语义不会去重：`applyEntryPatches` 对 insert 一律 `data.push(...insert)`（`[W]node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js:69-83`），仅 `entryMap.set(entry.id, entry)` 让**后出现的**条目成为后续 patch 的目标（`:59-66`）。
- 该重复在**已运行**的会话里不存在（本会话 `agentPreset:"swarm"` 正常）；但下次启动是否会因重复 id 报错，我**没有启动**验证 → `UNVERIFIED`（见 §7.4）。这是本轮最需要 Lead 决断的现场问题：两份 preset 定义必须收敛为一份。

---

## 3. 启用机制：native bundle 路径与 opt-in

### 3.1 权威路径

1. **装包 + 选层**：`dsh plugin --profile <name> add @deepseek-ai/dsh-experimental-agent-team-profile`（`[H]…/agent-team-profile/README.md:33`）；profile 必须已含 `@deepseek-ai/dsh-base`，同段还给出 remove 命令（同 README `:37`），因为该 patch 复用 base 的 Subagent 服务与 provider 行。
2. **插件页开关**：`setBundleEnabled(name, enabled)` 是 `@Remote` 入口（`[H]packages/boot/plugin-manager/src/index.ts:509-515`），内部 `selectBundle` 把名字追加/移出 `dsh.profile.bundles` 并写回 manifest（`:808-828`，写回在 `:823-825`）。
3. **列表呈现**：`listBundles()` 中 `optional = OPTIONAL_BUNDLES.includes(name)`（`:329`），`official = optional || offered`（`:333`），因此未选中的实验 bundle 以「已提供但关闭」的卡片呈现，可移除性由 `removable` 决定（`:349-351`）。
4. **层序**：`dsh.profile.bundles` 顺序逐层叠加，用户 patch 层最后（模块级说明 `[H]packages/boot/app-boot/src/profile.ts:1-22`；实现 `loadProfileDirectory` 的逐 bundle 循环 `:751-768`、用户层 `:769-773`，单次 `applyEntryPatches` 组合 `:816-823`）。**草稿在此处引的是文档注释而非实现**（见 §8 更正 5）。
5. **回退**：`dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-team-profile` 移除有序层（README `:37`）；README 另提示用户 patch 仍可按 id 覆盖 `ui-agent-team`（`:45`）。

### 3.2 哪些能力是 opt-in

| 能力                        | 开关 / 默认                                                    | 证据                                                                                                                             |
| --------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 团队域服务 `ctx.agentTeams` | 由 `agent-team` 行决定；无行即无服务                           | `[H]…/agent-team-profile/cordis.patch.yml:16-23`；服务注入 `[H]…/agent-team/src/index.ts:57`                                     |
| 模型侧团队工具              | `tool-agent-team` 行                                           | `[H]…/cordis.patch.yml:25-29`                                                                                                    |
| Web roster / task-board     | `ui-agent-team` 行 + `dsh.client` 声明                         | `[H]…/cordis.patch.yml:31-32`；`[H]…/client-ui-agent-team/package.json:29-40`                                                    |
| 容量与超时上限              | `Config.maxMembers/maxTasks/maxMessageBytes/disposalTimeoutMs` | 字段声明 `[H]…/agent-team/src/types.ts:152-162`（`Config` 接口 `:153`，字段 `:155-161`）；目录行 `[H]docs/config-catalog.md:841` |
| spawn / fork provider       | `freshProvider` / `forkProvider`                               | `[H]…/cordis.patch.yml:27-29`                                                                                                    |
| 原生直属 subagent 委派      | **被该 bundle 关闭**（代价项）                                 | `[H]…/cordis.patch.yml:4-14`                                                                                                     |
| 面板自身用户配置            | **无**                                                         | `[H]docs/config-catalog.md:4654` 配置列为 `—`；README `:28`                                                                      |
| bundle 自身配置             | **无**（profile bundle 只有 patch 文件，无 Config）            | `[H]docs/config-catalog.md:4741` 配置列为 `—`                                                                                    |

### 3.3 web 与 headless

三行 patch 内容与 profile 无关（同一文件）；差异只在客户端加载器是否会挂载浏览器半边：UI 插件的 Host 半边是 inert，只有 Web Client loader 挂 `/client`，所以 headless 不需要 Web server（`[H]…/agent-team-profile/README.md:62`）。

**边界补充（本实例特有，重要）**：legacy 行的 `disabled: true` 只作用于 **profile entry 树**（`composeEntries` → `applyEntryPatches`，`profile.ts:816-823`）。而 `preset-swarm` 的 `plugins` 是**另一棵树**：`mountPreset` 新建 `PresetTree(ctx)` 并 `tree.root.update(prepareProfileEntries(ctx, plugins))`（`[H]packages/preset/agent-preset-registry/src/mount.ts:204-215`，调用点 `…/src/index.ts:103-121`）。`[P]cordis.patch.yml:91-105`（及新 bundle 的 `presets/swarm.patch.yml:90-104`）在 preset 内重新声明了 `tool-subagent-control`/`tool-subagent`/`tool-subagent-fork`，**不受那 4 条 disabled 约束**。观察：本 teammate 会话的模型侧工具目录同时出现 `subagent`/`subagent_fork` 与 `spawn_teammate`/`send_message`/`team_task_*`（**观察，非源码证据**；结论是「preset 树与 profile 树的关闭语义不互通」，具体工具集应以运行期工具目录为准）。

---

## 4. 端到端启用链路图（文字版）

```
① 启动：dsh --profile dsh-swarm-demo
   └─ [P]package.json:10-16  dsh.profile.bundles = [dsh-base, dsh-web-app,
        agent-team-profile, @elinpf/dsh-swarm-bundle, inspector-profile]
        └─ loadProfileDirectory           [H]app-boot/src/profile.ts:740-774
             ├─ resolveBundleDir 安装优先  [H]app-boot/src/profile.ts:714-725
             ├─ 读每个 bundle 的 dsh.bundle.patch 文件（可多文件，按序）
             └─ 读用户层 [P]cordis.patch.yml                         :769-773
        └─ composeEntries → applyEntryPatches（空树为底，逐层叠加）  :816-823
             ⇒ 212 条有效 entry（evidence/03-composed-entries.txt）
                :83-86   tool-subagent* ×4 = DISABLED（profile 树内）
                :206     agent-team          ← [H]agent-team-profile/cordis.patch.yml:17-23
                :207     tool-agent-team     ← 同文件 :25-29
                :208     ui-agent-team       ← 同文件 :31-32
                :209-222 dsh-swarm 14 行（team-core … team-human）
                :223/226 preset-swarm ×2（用户层 + 新增 bundle preset 层；见 §2.5）

② Loader 挂载（Host 侧）
   ├─ agent-team 服务：注入 agents/sessions/sessionPersistence/sessionProjections/subagents
   │     [H]agent-team/src/index.ts:57
   │   └─ ctx.root.sessionProjections.register(teamProjectionDefinition)   :98-107 / :99
   │        definition: key=agentTeam, stateVersion=4, stateSchema, wire.view
   │                                                                       [H]projection.ts:386-394
   ├─ tool-agent-team：模型侧团队工具（spawn/send/task/wait/interrupt…）
   └─ ui-agent-team：Host 半边 inert（apply 为空）  [H]client-ui-agent-team/src/index.ts:4

③ 会话运行：Lead Session 落 durable 事件
   team/member + team/task（本实例实测 8 + 12 条；evidence/03-instance-assembly.txt §8）。
   team/message/{queued,delivered} 是历史只读类型，当前发送不再写入
        （见 01 §1.4、02 §2.6；实测该会话 0 条）。
        代码依据：写入路径只允许两个类型 [H]agent-team/src/journal.ts:9（MutableTeamEventType）
        与 :60（appendAndFlush 的泛型上界）；team/message/* 仅存于类型与回放折叠
        [H]agent-team/src/projection.ts:292-305。
   └─ applyProjectionEvent 按 TeamId 选中（selector.teamId === state.id）[H]projection.ts:225-239
        └─ buildTeamProjection（合成 lead 行 / 过滤 deleted / 透出 failure）
                                                          [H]projection.ts:342-361
             └─ teamProjectionView（WeakMap 复用引用，mailbox-only 不重发）
                                                          [H]projection.ts:371-384

④ 投影出网（客户端可见）
   ProjectionSnapshot.values = wire 视图（无 wire 的 unit 跳过）
        [H]session-projection/src/index.ts:107-117、:347、:457
   └─ 客户端 SessionManager: projectionsBySession[sessionId].values
        [H]api/session-controller/src/client/sessions/manager.ts:819-822

⑤ 浏览器装配
   ui-agent-team 行 → 包 package.json dsh.client{platform:'web'} + exports["./client"]
        [H]client/modules/src/index.ts:858-869；[H]…/client-ui-agent-team/package.json:21-40
   └─ mount.ts:29 registerAgentTeamUi
        ├─ locale.register(NS='agent-team')                     mount.ts:30 / locales.ts:4
        └─ slots.inject('conversation.session.header.actions',
                        register({id:'agent-team', order:-20}, TeamAction))   mount.ts:53-62

⑥ 面板取数与交互（React）
   TeamAction
     ├─ leadSessionId = useSession(s => s.subagent?.address.parentSessionId) ?? sessionId
     │                                                       TeamAction.tsx:192
     ├─ team = useSessions(s => s.projectionsBySession[leadSessionId]?.values.agentTeam)
     │                                                       TeamAction.tsx:193
     ├─ 成员模型名 = projectionsBySession[member.id]?.values.modelSelection?.next?.model  :81
     ├─ 成员运行态 = useSessionStatus (+ 列表 summary 兜底)             :82-86
     ├─ 点击成员 → openTeammate → uiWorkspace.openSession(continuable)  :97-103 / mount.ts:38-50
     └─ 任务卡只读（原生 3 个可见态，deleted 已被投影过滤 + ready/blockedBy/writeScopes/告警）  :129-176
```

---

## 5. 文档 vs 代码：5 条断言的复核结果

| #   | 文档断言（原文位置）                                                                                                                                                                              | 代码证据                                                                                                                                                                                                                | 复核结论                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| C1  | `[H]docs/subsystems/agent-team.md:80`（§Web projection，`:78` 起）：Lead Session 发布 `SessionProjectionMap.agentTeam`，含 durable roster 与**非 deleted** 任务视图；`failure` 与最后有效状态并存 | wire 定义 `[H]…/projection.ts:386-394`；过滤 deleted `:357`；failure `:359`+`:226`；类型块 `[H]…/types.ts:115-126`                                                                                                      | **一致**。但草稿把类型块引作 `types.ts:121-123`，实为 `:115-126`（声明合并 `:121-126`）→ 见更正 2 |
| C2  | `[H]…/client-ui-agent-team/README.md:28`（§Use this package）：Web Client loader 挂 `/client`；root Host export 无行为；包无用户配置字段                                                          | `package.json:21-24`（`./client`）、`:29-40`（`platform:'web'`）；`src/index.ts:4` 空 `apply()`；`[H]docs/config-catalog.md:4654` 配置列 `—`                                                                            | **一致**                                                                                          |
| C3  | `[H]…/agent-team-profile/README.md:12`（§Summary）与 `:104`（§Known Limitations）：bundle 随 dsh 提供但默认关闭，可从 Plugins 页开启或加入已初始化 profile                                        | `[H]app-boot/src/profile.ts:223-236`（`:229` 为该 bundle）；`plugin-manager/src/index.ts:329`（optional）、`:509-515`（开关入口）                                                                                       | **一致**                                                                                          |
| C4  | `[H]…/agent-team-profile/README.md:12` 与 `:62`：普通 subagent 委派与重叠的全局 child control 被禁用；Workflow 仍可建 fresh 子代理                                                                | `cordis.patch.yml:4-14` 只 disabled 4 个 `tool-subagent*`，未触碰任何 workflow 行（web-app 自带 preset 仍含 `workflow-ptc` 等行：`.runtime/dsh-cli-npm/…/@deepseek-ai/dsh-web-app/presets/standard.patch.yml:104-105`） | **一致**；但须加边界注：该 disabled 只覆盖 profile 树，preset 树内的同名行不受影响（§3.3）        |
| C5  | `[W]README.md:183-188` §任务派发模式：默认已是 `scheduled`（破坏性变更）；同文件 `:260`：默认**仍是** `autonomous`，P19 已取消                                                                    | `[W]packages/team-scheduler/src/index.ts:70` `default('scheduled')`；`:519` `defaultConfig()` 的 `mode:'scheduled'`；bundle 快照 `:58` `mode: scheduled`                                                                | **DRIFT（workspace 自相矛盾）**：`:183-188` 与代码一致；`:260` 过时。草稿判断正确，行号亦正确。**快照说明**：以上行号基于 sha256 `568cea4c…`（16:20）；该文件 16:56 被改（现 `45c39bc9…`，行号平移 `:255/258/260`→`:262/265/267`），**此矛盾在现工作区已被修掉**（现行 `:267` 已改为「默认即 `scheduled`」） |

补充核验（不计入上表 5 条，均为本次实读）：

- `[W]README.md:190`「`team-core` 是唯一接触实验性 `ctx.agentTeams` 的包」：全仓 `agentTeams` 命中仅 `packages/team-core/src/index.ts`（运行时，`:167`、`:173`、`:611` 等）与 `packages/team-core-contract/src/index.ts:65`（仅注释）→ **成立**（严格说是「唯一运行时接触」）。
- 「workspace 未写 Web UI」：正确位置是 `[W]README.md:258`（snapshot `568cea4c`；现为 `:265`；而非草稿写的 `:194`）；`[W]packages/*/package.json` 无 `dsh.client`，全仓无 `.tsx` → **成立**；但必须并列说明「Web 上确实有原生面板」（§1、§2）。
- `[W]docs/adr/0002` 抽查两条行号：`swarm/core/review-entered` emit 于 `[W]packages/team-core/src/index.ts:425`、fold 于 `:547` → **一致**。
- `[W]docs/verification.md` 的插入行数：早期章节记 11（`:350`、`:458`、`:517`、`:584`、`:666`），阶段 3 章节记 14（`:756`）；当前 bundle 实测 **14 行**（快照 `:24` 起，`awk` 计数 14），与 `[W]README.md:255`（snapshot `568cea4c`；现为 `:262`）一致 → 11 只应被读作历史记录，**不能当作现状**（见更正 9）。

---

## 6. native 与 dsh-swarm 的能力边界

| 关注点                                                                    | 归属                   | 证据                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 团队域服务 `ctx.agentTeams`（roster / inbox / task DAG / child 生命周期） | native                 | `[H]packages/experimental/agent-team`；`[H]docs/architecture.md:136` 以 opt-in 描述                                                                                                           |
| durable `team/*` 事件与 `agentTeam` wire 投影                             | native                 | `[H]…/agent-team/src/index.ts:99`；`[H]…/projection.ts:386-394`（事件白名单 `:192-197`）                                                                                                      |
| 模型侧团队工具                                                            | native                 | `[H]packages/experimental/tool-agent-team`（行 `cordis.patch.yml:25-29`）                                                                                                                     |
| Web roster / task-board / 成员导航                                        | native                 | `[H]packages/experimental/client-ui-agent-team`（§1.3-1.4）                                                                                                                                   |
| 一键启用与 legacy 委派关闭                                                | native                 | `[H]packages/experimental/agent-team-profile`（§3）                                                                                                                                           |
| 端口类型 SSOT（`TeamCore`/`TaskView`…）                                   | dsh-swarm              | `[W]packages/team-core-contract`（`status` 六态含叠加态，`:50-53`）                                                                                                                           |
| native seam 适配（不 import 实验包类型）                                  | dsh-swarm              | `[W]packages/team-core/src/index.ts:30-94`（JSDoc `:30-36`，`interface AgentTeamsSeam` `:37-94`）、`:167-176`（响应式挂接）                                                                   |
| `in_review` / `planned` 叠加态、评审闸、计划闸、调度派发                  | dsh-swarm              | `[W]packages/team-review/src/index.ts:6-11`；`[W]packages/team-scheduler/src/index.ts:55-57`、`:70-78`；`[W]packages/team-core-contract/src/index.ts:50-53`                                   |
| durable `swarm/*` 事件 + fold 恢复                                        | dsh-swarm              | `[W]docs/adr/0002-durable-state-convention.md`；`[W]packages/team-core/src/index.ts:425`、`:547`                                                                                              |
| **面板可见性**：dsh-swarm 的叠加态在 Web 上是否可见                       | **不可见（边界缺口）** | 面板只 switch 原生 4 态（`TeamAction.tsx:33-41`）；原生投影 schema 只接受 4 态（`[H]projection.ts:82`、`:325`）；dsh-swarm 无自己的投影/UI 包（`[W]packages/*/package.json` 无 `dsh.client`） |

**叠加态的精确落点**：`team-core` 在**自己的端口读侧**做 overlay——`getTask`（`[W]…/team-core/src/index.ts:298-300`）与 `listTasks`（`:302-304`）把 `reviewing`/`planning` 集合映射成 `in_review`/`planned`（overlay 实现 `:625-630`）。因此：

- 走 dsh-swarm 端口消费任务的人（`tool-swarm`、`team-scheduler` 等）看到六态；
- 浏览器面板读的是**原生投影**，永远只看到 `pending|in_progress|completed`（`deleted` 被过滤，`:357`），**看不到** `in_review`/`planned`；
- 本实例实测印证：projection 缓存中 6 个任务的态只出现 `pending|in_progress`，且任务快照键里**没有** `ownerName/ready/writeScopeWarnings`（这些由 `projectTaskView` 在 wire 视图生成）——`docs/investigation/evidence/03-instance-assembly.txt` §6。

结论（措辞收紧）：dsh-swarm 是在原生团队域之上**叠加治理能力**并**另开一条读侧语义**，两者共用同一份 native durable 日志与 roster，但**状态呈现分叉**：任何「看板/UI 上的任务态」都必须标注是 native 视角还是 dsh-swarm 端口视角，不可混引。

---

## 7. 残余不确定（UNVERIFIED）

1. **无运行时 UI 证据**：未打开浏览器验证 http://127.0.0.1:3099，§1.4 的可见行为来自源码 + 包 README 对照；截图/交互复验需 Lead 或后续轮次在**不重建 bundle** 的前提下进行。
2. **「面板不发起 RPC」**：证据是「`src/` 中不存在 Remote 命名空间注册或 rpc 调用」（全量 grep 仅命中 2 处 “RPC” 字样：`src/index.ts:3` 的归属注释与 `mount.ts:26` 的否定声明）与 README 声明（`:50`），**不是**抓包结论。
3. **插件页开关的 GUI 行为**：`setBundleEnabled`/`selectBundle` 的写入路径已读实（`plugin-manager/src/index.ts:509-515`、`:823-825`），但**未在真实 GUI 点击复验**。
4. **重复 `preset-swarm` 的启动后果**：patch 层不会去重（`cordis-plugin-include/lib/index.js:69-83`），但 Loader 对同 id 两行的处置（报错/后者生效）未启动验证 → 需 Lead 在收敛后复验。
5. **preset 树内的 legacy 工具是否真实可用**：结论「profile 树的 disabled 不覆盖 preset 树」有代码依据（`mount.ts:204-215`），但「本会话模型侧同时有 `subagent` 与 `spawn_teammate`」只是我的**工具目录观察**；精确工具集与 wire 描述归 task-2。
6. **`[W]docs/verification.md` 自报数据**（11/14 行、4 legacy disabled）来自其历史实跑输出，本次只重算了 bundle 插入行数（14），**未重跑** `scripts/e2e-profile.sh`。
7. **`[H]` 文档行号**基于本次 checkout 修订（sha256 见证据文件）；若上游 checkout 被更新，行号需重新核对。

---

## 8. 本轮更正清单（相对 03 草稿）

| #   | 位置（草稿）                  | 原写法                                                                                                                  | 更正为                                                                                                                                                    | 依据                                                                                 |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | §1.1、§0 结论 1               | `agentTeam` 注册于 `index.ts:99`                                                                                        | 保留（`:99` 正确），补「注册被包在 `ctx.effect` 内，`:98-107`」                                                                                           | `[H]…/agent-team/src/index.ts:98-107`                                                |
| 2   | §1.1、C1                      | `SessionProjectionMap.agentTeam` 在 `types.ts:121-123`                                                                  | `types.ts:121-126`（声明合并 `:121-126`，成员 `:124`）；类型块整体为 `:115-126`                                                                           | `[H]…/agent-team/src/types.ts:115-126`                                               |
| 3   | §1.2                          | `parseDshClient` 在 `manifest.ts:165-197`，`platform` 校验 `:180-182`                                                   | 函数 `:173-193`，`platform` 校验 `:179-181`；并补 Loader 侧 `resolveMeta`（`client/modules/src/index.ts:858-869`）                                        | 两文件实读                                                                           |
| 4   | §2.3（旧）                    | 「4 个任务态与 4 个成员态均有中英 key」                                                                                 | 任务态**只有 3 个 key**（`deleted` 复用 `status.completed`，`TeamAction.tsx:38-40`）；成员态 4 个                                                         | `client/locales.ts:26-32`、`TeamAction.tsx:33-41`                                    |
| 5   | §2.1 第 4 点、§2.3            | 「loader 按有序列表叠加 patch（`profile.ts:7-12`、`:95-107`）」「用户 patch 最后应用（`profile.ts:238-243` 模板注释）」 | 实现位置：`loadProfileDirectory` 逐层 `:751-768`、用户层 `:769-773`、`composeEntries`/`applyEntryPatches` `:816-823`；`:1-22` 与 `:238-243` 只是注释/模板 | `[H]packages/boot/app-boot/src/profile.ts`                                           |
| 6   | §1.4 旁路投影                 | `model-selection-projection.ts:78`「定义与注册」                                                                        | wire 视图（含 `next`）在 `:63-66`；注册函数 `:81-82`，`:78` 只是 JSDoc                                                                                    | 该文件实读                                                                           |
| 7   | §2.2 表                       | `agent-team/src/types.ts:153` 作为 Config 源                                                                            | 正确（`interface Config` 在 `:153`，字段 `:155-161`）；补 config-catalog 行号 `:841`                                                                      | 两文件实读                                                                           |
| 8   | §3 补充核验                   | 「`README.md:194` 与 `docs/verification.md` §H.4 说 Web UI 未写」                                                       | 「Web UI 未写」在 `[W]README.md:258`；`docs/verification.md` §H.4（`:436`）讲的是 team-skills 单测，与 Web UI 无关                                        | 两文件实读                                                                           |
| 9   | §3 补充核验 / §5 UNVERIFIED 4 | 「`docs/verification.md:347-357`：bundle 11 行」                                                                        | 11 行是**历史章节**记录（`:350`/`:458`/…），阶段 3 章节为 14（`:756`）；现状实测 14 行，与 `[W]README.md:255` 一致                                        | bundle patch 计数 + `docs/verification.md`                                           |
| 10  | §2 整体                       | 未记录本实例装配                                                                                                        | 新增 §2：profile 清单/用户 patch/层级/212 条 entry/运行期 team 事件与 projection 缓存实证                                                                 | `docs/investigation/evidence/03-*`                                                        |
| 11  | §2.3（旧）                    | 「两者对 `tool-subagent*` 的 disabled 是同向的」                                                                        | 保留同向判断，但补关键边界：disabled 只覆盖 **profile 树**，`preset-swarm` 在自己的 `PresetTree` 内重新声明同名行，不受约束                               | `[H]preset/agent-preset-registry/src/mount.ts:204-215`；`[P]cordis.patch.yml:91-105` |
| 12  | §5 UNVERIFIED                 | 缺并发写入项                                                                                                            | 新增 `UNVERIFIED 4`（重复 `preset-swarm` 的启动后果）与 §2.5 现场报告                                                                                     | `03-composed-entries.txt:223,226`、`cordis-plugin-include/lib/index.js:69-83`        |
| 13  | §0 结论 3                     | 「disabled 4 个 legacy subagent 委派行」                                                                                | 保留；行号 `:4-14` 正确，补 `agent-team` insert 的四个 config 值出处 `:17-23`                                                                             | `[H]…/agent-team-profile/cordis.patch.yml`                                           |
| 14  | 全文                          | 部分结论只引 README 章节名                                                                                              | 全部改为 README **行号**（C1 `agent-team.md:78-80`；C2 client-ui README `:28`/`:50`；C3 profile README `:12`/`:104`；C4 `:12`/`:62`）                     | 各 README 实读                                                                       |

### 8.1 独立核验（auditor）触发的新增更正

| #   | 位置        | 问题                                                                                                                                                                                        | 更正为                                                                                                                                                                                                                                                                                                                                                                                              | 依据                                                                                                                                |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 15  | §4 链路图 ③ | **WRONG**：把 `team/message/{queued,delivered}` 与 `team/member`/`team/task` 并列为「落盘 durable 事件」，与运行实测（该会话 0 条）冲突                                                       | 改为「`team/member` + `team/task`（本实例实测 8 + 12 条）。`team/message/{queued,delivered}` 是**历史只读类型**，当前发送不再写入（见 01 §1.4、02 §2.6；实测该会话 0 条）」；并补写入侧代码依据                                                                                                                                    | `[H]…/agent-team/src/journal.ts:9`（`MutableTeamEventType` 仅 2 型）、`:60`（`appendAndFlush` 泛型上界）；`:292-305` 仅回放折叠；实测 `session-events.jsonl` 中 `team/message/*` 事件为 0（raw 文本命中 7 处均在他人汇报正文，非事件类型） |
| 16  | §1.4        | **IMPRECISE**：「src 全文无 rpc 标识符」与实际情况不符（`src/index.ts:3` 出现 “Host RPC domain” 字样）                                                                                        | 精确化为「`src/` 中没有任何 Remote 命名空间注册或 rpc 调用；唯一出现 “RPC” 字样的是 `src/index.ts:3` 的归属注释与 `mount.ts:26` 的否定声明」                                                                                                                                                                                                                                                          | 全量 grep：`mount.ts:26`、`src/index.ts:3`                                                                                           |
| 17  | 文首/§5 C5  | **快照失效（非错误）**：全部 `[W]README.md` 行号基于 sha256 `568cea4c…`（16:20）；该文件 16:56:02 被并发写入（现 `45c39bc9…`，`:209` 起插入 7 行），行号平移且「README 自相矛盾」已被修掉 | 文首增加「`[W]README.md` 快照约定」段；§5 C5 与补充核验处标注：行号以 `568cea4c` 快照为准，平移为 `:255/258/260`→`:262/265/267`；该漂移在现工作区**已消除**（现行 `:267` 写明默认即 `scheduled`）                                                                                                                                                                                                  | `sha256sum README.md`（16:56:02 后为 `45c39bc9…`）、`sed -n '262p;265p;267p' README.md`                                              |
