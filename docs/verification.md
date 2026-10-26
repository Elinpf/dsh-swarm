# 骨架阶段验证记录（P2-scaffold）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-26
> 目标：证明「插件能被构建 → 能被 DSH 内核（cordis）加载 → 能观察到它注册的东西」这条链路可用。
> 环境：隔离 Node `v22.23.4` + pnpm `11.28.5`（`source scripts/env.sh` 后）。

本文件记录的都是**实际执行过的命令与其原始输出**（ANSI 颜色码已去除）。复现方式见 `README.md`。

---

## 0. 环境

```console
$ node -v
v22.23.4
$ corepack pnpm -v
11.28.5
```

---

## 1. 构建 `pnpm build`

```console
$ corepack pnpm build
$ pnpm -r run build

> @elinpf/dsh-swarm-example-plugin@0.0.1 build .../packages/example-plugin
> tsc -p tsconfig.json
```

产物：

```console
packages/example-plugin/lib/index.js
packages/example-plugin/lib/index.d.ts
packages/example-plugin/lib/index.js.map
packages/example-plugin/lib/index.d.ts.map
```

---

## 2. 单测 `pnpm test`（vitest）

```console
$ corepack pnpm test
$ pnpm -r run test

> @elinpf/dsh-swarm-example-plugin@0.0.1 test .../packages/example-plugin
> vitest run

 RUN  v4.1.11 .../packages/example-plugin

 ✓ tests/example-plugin.spec.ts (5 tests) 11ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

覆盖点：导出形态（命名导出 / 无 default export）、Config 默认值与校验、`apply` 注册工具与 section、工具执行与 render、HMR 安全（disposer 撤销注册）。

---

## 3. 加载验证 `pnpm verify`

`pnpm verify` = `pnpm build` + `node scripts/verify-load.mjs`。后者**用真实 cordis 运行时**加载构建产物。

```console
$ corepack pnpm verify
$ pnpm run build && node scripts/verify-load.mjs

== 加载构建产物 ./packages/example-plugin/lib/index.js ==
[OK]   导出 apply（函数式插件入口）
[OK]   导出 inject = ["tools","systemPrompt"]
[OK]   无 default export（否则 loader 会丢 inject）

== 用真实 cordis 加载 example-plugin ==
[OK]   ctx.plugin() 返回 fiber
[OK]   观察到 1 个工具（实际 1）
[OK]   工具名为 greet（实际 greet）
[OK]   观察到 1 个 prompt section（实际 1）
[OK]   section 名为 example-plugin:guide（实际 example-plugin:guide）
[OK]   工具执行结果 = {"text":"hello, DSH"}

== 卸载 fiber ==
[OK]   fiber 提供 dispose
[OK]   fiber 卸载后状态为 DISPOSED（2 → 4）

== 验证 cordis effect 回滚 ==
[OK]   探针工具已注册
[OK]   探针 fiber 卸载后注册被撤销（cordis effect 回滚生效）

✅ 加载验证通过：插件可被真实 cordis 运行时加载并观察到预期行为。
```

> 说明：`ctx.plugin()` 加载的是 `packages/example-plugin/lib/index.js`（构建产物），不是 TS 源码；断言的是「加载后能观察到 `greet` 工具与 `example-plugin:guide` section」。cordis 是 DSH 的插件内核，故这即「能被 DSH 加载」的最小证据。

---

## 4. 类型检查 / Lint / 格式

```console
$ corepack pnpm typecheck
$ pnpm -r run typecheck
> tsc -p tsconfig.json --noEmit        # 无输出 = 通过

$ corepack pnpm lint
$ eslint .                            # 无输出 = 通过

$ corepack pnpm format:check
$ prettier --check .
Checking formatting...
All matched files use Prettier code style!
```

---

## 5. 过程中修正的两处真实契约差异

1. **`output.schema` 不支持对象层 `required`**：首次 `pnpm test` 抛
   `JsonSchemaError: unsupported JSON schema: schema.required is not supported by the value schema DSL`。
   手册 §2.2 示例把 `required: true` 写在对象层；真实 0.2.1-rc.3 要求写在**属性**上
   （对照 `packages/todo/tool-todo/src/index.ts` 的真实 `output.schema`）。已修正。

2. **消费 DSH 声明需要 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`**：
   未开启时 `pnpm build` 报 `Property 'tools' does not exist on type 'Context'`，
   因为 DSH 的 `.d.ts` 之间用 `.ts` 扩展名互引，导致 `declare module '@deepseek-ai/cordis'` 类型增强被丢弃。
   对照 `.runtime/deepseek-harness/tsconfig.base.json` 补齐后通过。

---

## 6. Git 与远端推送

- 仓库初始化：`git init -b main`，remote `origin = https://github.com/Elinpf/dsh-swarm`
- 首次提交：`70dae04`（`refs/heads/main`）
- 推送：直连 `github.com:443` 的前两次尝试分别 `Failed to connect ... after ~135s`；
  经本地代理则 `gnutls_handshake() failed`。**重试后直连成功**：

  ```console
  To https://github.com/Elinpf/dsh-swarm
   * [new branch]      main -> main
  ```

  远端确认：`git ls-remote origin` → `70dae04… HEAD` / `70dae04… refs/heads/main`。
- 凭证：使用团队指定的助手 `git -c credential.helper=/root/repo/jiuwen/.proxy-config/git-cred-helper.sh`
  （读取 `/root/.git-credentials`）。**注意**：该助手依赖真实 `$HOME`，因此**推送时不要 `source scripts/env.sh`**
  （它会把 `HOME` 改到项目内隔离目录，导致助手找不到凭证）。
- 仓库内**未写入任何凭证/token**。

---

## 7. 标准安装复验（磁盘恢复后）

开发过程中一度因根盘 100% 满而用 tmpfs 规避；磁盘恢复后改用**默认安装路径**复验，全部通过：

```console
$ source scripts/env.sh
$ corepack pnpm install --prefer-offline
Progress: resolved 0, reused 0, downloaded 154, added 155, done
Done in 7.6s using pnpm v11.28.5

$ # build / test / verify / typecheck / lint / format:check  —— 全部 OK
```

即：**换任意磁盘充足的机器，`source scripts/env.sh` + `corepack pnpm install` + `corepack pnpm verify`
即可从零跑起来**，无需任何本机特殊处理。

---

## 8. 未覆盖 / 下一步

- **未做**完整的 `dsh --profile <name> --dump-config` 组合验证：该路径需要先在 profile 内安装
  整个 `@deepseek-ai/dsh-base`（数百个包），超出「骨架 + hello-world」阶段的范围。
  当前以「真实 cordis 运行时加载 + 观察注册」作为加载验证（cordis 即 DSH 的插件内核）。
  待进入团队协作插件实现阶段、确需整机联调时再补 profile 级验证。
- 团队协作插件族（消息总线 / 任务看板 / 验证闸 / 跨进程 / worktree 锁 / 人类成员路由）属于下一阶段任务。

---

# P4a 阶段 1 协作插件：验证记录

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-26
> 范围：`team-core-contract` + 6 个 backend-独立插件（team-bus / team-prompt / team-scheduler / team-review / team-completion / tool-swarm）。
> 环境：隔离 Node `v22.23.4` + pnpm `11.28.5`（`source scripts/env.sh` 后）。

## A. 构建 / 单测 / 加载验证（全量）

```console
$ corepack pnpm build            # tsc：8 个包全部 Done
$ corepack pnpm test             # vitest：见下
$ corepack pnpm verify           # build + 真实 cordis 加载全部 8 个包
$ corepack pnpm lint             # eslint：0 error
$ corepack pnpm format:check     # prettier：All matched
```

各包单测（行为级，覆盖关键不变量）：

| 包 | 用例数 | 覆盖的不变量 |
|---|---|---|
| team-core-contract | 2 | 运行时零导出；端口形状冻结（`expectTypeOf`） |
| team-bus | 9 | 广播自过滤/不重不漏；多播 N 条 durable；多播全体拒绝；`*`/`user` 拒绝；超限零落库；topic 订阅；HMR 归零 |
| team-prompt | 5 | 稳定段按 order 升序；identity/roster 走 context；渐进披露；dispose 归零 |
| team-scheduler | 6 | autonomous nudge；scheduled 启动且幂等；stale nudge→升级；降级；定时器清理 |
| team-review | 10 | 无门直完成；拦截为评审；二元一票否决；全 pass 完成；打分阈值；undecided；自投拒绝；后写覆盖；maxRounds 升级 |
| team-completion | 5 | 三条件合取；上升沿仅一次；未读阻断与恢复；Lead-only |
| tool-swarm | 6 | 5 工具注册；缺 teamBus 不注册；enableReview=false 不暴露；广播委托；HMR 归零 |

## B. 加载验证输出（`pnpm verify`）

```console
== @elinpf/dsh-swarm-team-core-contract ==   [OK] 纯类型包：运行时零导出（无实现）
== @elinpf/dsh-swarm-example-plugin ==       [OK] 观察到工具 greet / section example-plugin:guide / fiber DISPOSED
== @elinpf/dsh-swarm-team-bus ==             [OK] 观察到服务 ctx.teamBus；卸载后消失
== @elinpf/dsh-swarm-team-prompt ==          [OK] 观察到 section team:role/team:inbound；卸载后归零
== @elinpf/dsh-swarm-team-scheduler ==       [OK] 观察到服务 ctx.teamScheduler；卸载后消失
== @elinpf/dsh-swarm-team-review ==          [OK] 观察到服务 ctx.teamReview；卸载后消失
== @elinpf/dsh-swarm-team-completion ==      [OK] 观察到服务 ctx.teamCompletion；卸载后消失
== @elinpf/dsh-swarm-tool-swarm ==           [OK] 观察到 broadcast/multicast/review_submit/review_vote/team_summary；卸载后归零

✅ 加载验证通过：全部插件可被真实 cordis 运行时加载并观察到预期行为。
```

## C. 实现期发现的两条真实契约细节

1. **`defineTool` 的 value schema：可选参必须「省略」`required`**，写 `required: false` 会抛 `parameterSchemaSpecToJsonSchema` 错误（`required` 只接受 `true`）；可选即不写。这与「对象层不接受 `required`」是同一 DSL 约束的两面。
2. **Service 形态插件经 `ctx.plugin()` 加载时要传 `mod.default`**：功能式插件（命名 `apply`）可直接传 ESM namespace，但 Service 的入口在 `default` 导出上，传 namespace 会报 `invalid plugin ... received object`。

---

# P4-impl-core：team-core + bundle + 集成验收

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-26
> 范围：`@elinpf/dsh-swarm-team-core`（TeamCorePort）、`@elinpf/dsh-swarm-bundle`（组装）、9 包全量验收。

## A. 后端选择（与 agent-team-spike.md 一致）

**后端 = `native`**。理由：`docs/agent-team-spike.md` 实测 DSH 原生 `ctx.agentTeams` 在 `0.2.1-rc.3`
上可用（`spawn_teammate` / DM / `team_task_*` 等 8/10 工具跑通、durable 事件落盘、`--session-id` 重启可复原）。
故阶段 0/1 **不实现 `owned` 自建后端**；`team-core` 保留 `backend: 'native'|'owned'|'auto'` 选择点：
- `auto`（默认）：有 `ctx.agentTeams` → native；无 → no-op。
- `owned`：显式抛 `TEAMCORE_BACKEND_UNAVAILABLE`（未实现）。
- no-op 模式：`listMembers/listTasks` 返回空、其余写操作抛 `TEAMCORE_UNAVAILABLE`，**不阻断单 agent**。

端口隔离：`team-core` 是**唯一**接触实验性 API 的包，且用**本地结构化 seam 接口**描述 `ctx.agentTeams`
（不 import 实验包类型），避免 spike 揭示的版本脆弱性（npm latest 与 0.2.1-rc.3 不兼容）。端口类型 SSOT 仍在 `team-core-contract`。

## B. 全量命令（实跑）

```console
$ corepack pnpm build       # tsc：11 个 workspace 项目（9 包 + 根 + …）全部 Done
$ corepack pnpm test        # vitest：10 个测试文件 / 60 用例全通过
$ corepack pnpm verify      # 真实 cordis 加载全部 9 包（见 C）
$ corepack pnpm verify:e2e  # 进程内集成冒烟（见 D）
$ corepack pnpm lint        # eslint：0 error
$ corepack pnpm format:check# prettier：All matched
```

各包单测：team-core-contract 2、example-plugin 5、team-core 7、team-bus 9、team-prompt 5、team-scheduler 6、team-review 10、team-completion 5、tool-swarm 6、bundle 5 = **60**。

## C. 加载验证（`pnpm verify`，覆盖 9 包）

```console
== @elinpf/dsh-swarm-team-core-contract ==  [OK] 纯类型包：运行时零导出
== @elinpf/dsh-swarm-team-core ==           [OK] 观察到服务 ctx.teamCore；卸载后消失
== @elinpf/dsh-swarm-example-plugin ==      [OK] 工具 greet / section；fiber DISPOSED
== @elinpf/dsh-swarm-team-bus ==            [OK] 服务 ctx.teamBus；卸载后消失
== @elinpf/dsh-swarm-team-prompt ==         [OK] section team:role/team:inbound；卸载后归零
== @elinpf/dsh-swarm-team-scheduler ==      [OK] 服务 ctx.teamScheduler；卸载后消失
== @elinpf/dsh-swarm-team-review ==         [OK] 服务 ctx.teamReview；卸载后消失
== @elinpf/dsh-swarm-team-completion ==     [OK] 服务 ctx.teamCompletion；卸载后消失
== @elinpf/dsh-swarm-tool-swarm ==          [OK] 5 工具；卸载后归零
== @elinpf/dsh-swarm-bundle ==              [OK] 纯 patch（运行时零代码）；dsh.bundle.patch；4 个 legacy 行 disabled；insert 团队行
✅ 加载验证通过
```

**bundle「可装卸、零残留」证据**：① bundle 运行时代码为空（`export {}`），运行时内容只有 `cordis.patch.yml`；
② 9 个插件在真实 cordis 上加载后卸载，服务/工具/section **全部归零**（上面每行「卸载后消失/归零」）；
③ bundle 测试断言 patch 结构（禁用 4 个 legacy 行 + insert 9 行）与实验包 peer 钉死 `0.2.1-rc.3`。

## D. 进程内集成冒烟（`pnpm verify:e2e`）

真实 cordis + **端口 mock**（模拟 `ctx.agentTeams` 结构），串起 team-core/bus/review/completion/tool-swarm：

```console
[OK] team-core 激活（native 端口）
[OK] 创建成员 alice（id=m1）
[OK] 花名册含 lead + alice
[OK] 广播扇出 1 条到 alice（自过滤 lead）
[OK] 任务创建且 ready / 认领 → in_progress
[OK] 进入评审 round=1 → 二元池全 pass → 评审裁决 pass → 任务 completed
[OK] 完成判定 → completed=true（重复评估仍 true，上升沿只发一次）
✅ 集成冒烟通过：成员 → 消息 → 任务 → 评审 → 完成 链路打通（端口 mock 后端）。
```

## E. 边界（未做 / 受限，如实说明）

1. **未做整机 profile 级联调**（`dsh plugin add ./packages/bundle` + `--dump-config`）：需要先安装完整 `dsh-base`
   与实验包（数百包、重），且**本环境内置 `dsh-llm-deepseek` 对 OpenAI 兼容端点返回 401**，真实模型驱动需
   spike 报告里的 `llm-pi-ai` + `openai-completions` overlay。故本阶段的端到端以 **D 的进程内冒烟**为准。
2. **`followup_task` / `interrupt_agent` 未做真机探针**（spike 中两个未确认工具）：二者需要模型驱动才能触发，
   受 (1) 的模型端点限制未执行。`interrupt` 已在 `team-core` 适配（native `interrupt` → 端口 `interrupt`）并被单测覆盖；
   真实触发留待 profile 级联调。

---

# P7-impl-stage2：阶段 2 能力供给插件 + scope 迁移 + bundle 收敛

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-26
> 范围：`team-capability-contract` + `team-workspace` + `team-skills` + `team-memory` + `team-compaction`（9 → 14 包）；`tool-swarm` 增量工具；bundle 追加 4 行并收敛重复插入；npm scope 迁移到 `@elinpf/dsh-swarm-*`。

## A. 全量命令（实跑，14 包）

```console
$ corepack pnpm build       # tsc：14 个包全部 Done
$ corepack pnpm test        # vitest：全部通过（14 个测试文件）
$ corepack pnpm verify      # 真实 cordis 加载 14 包（见 B）
$ corepack pnpm verify:e2e  # 集成冒烟（阶段1链路 + 阶段2链路，见 C）
$ corepack pnpm lint        # 0 error
$ corepack pnpm format:check# All matched
```

各包单测：team-capability-contract 2、team-workspace 7、team-skills 6、team-memory 5、team-compaction 7、tool-swarm 8；阶段 0/1 九包不变（共 **60+** 用例）。

## B. 加载验证（`pnpm verify`，14 包）

```console
== @elinpf/dsh-swarm-team-capability-contract ==  [OK] 纯类型包：运行时零导出
== @elinpf/dsh-swarm-team-workspace ==            [OK] 观察到服务 ctx.teamWorkspace；卸载后消失
== @elinpf/dsh-swarm-team-skills ==               [OK] 观察到服务 ctx.teamSkills；卸载后消失
== @elinpf/dsh-swarm-team-memory ==               [OK] 观察到服务 ctx.teamMemory；卸载后消失
== @elinpf/dsh-swarm-team-compaction ==           [OK] 观察到服务 ctx.teamCompaction；卸载后消失
…（阶段 0/1 九包同前）
✅ 加载验证通过：全部插件可被真实 cordis 运行时加载并观察到预期行为。
```

## C. 集成冒烟（`pnpm verify:e2e`）

阶段 1 链路 + 阶段 2 链路全通过：

```console
[OK] 成员 → 广播（自过滤）→ 任务 → 评审 pass → 完成判定（上升沿一次）
[OK] 技能可见性：lead 可见 arch-design；bob 为空（不泄露）
[OK] 共享记忆允许 bob 读；成员不可写共享记忆（授权拒绝）
[OK] 写域锁互斥：bob 与 lead 的独占锁冲突；释放后无锁
```

## D. 真实 profile 回归（`scripts/e2e-profile.sh --no-model`）

```console
[PASS] @elinpf/dsh-swarm-bundle 自身插入行数 = 11 (期望 11)
[PASS] 原生 agent-team / tool-agent-team 行存在（来自 agent-team-profile） = 2
[PASS] legacy tool-subagent* 为 disabled 的行数 = 4 (期望 4)
[PASS] dump-config 无禁用/不兼容告警
结果：PASS=4 FAIL=0
```

**bundle 重复插入已收敛**：移除了此前重复插入的 `agent-team` / `tool-agent-team`（它们由 `agent-team-profile` 提供），bundle 只 disabled 4 个 legacy 行 + insert 11 个 dsh-swarm 自身行。

## E. scope 迁移（`@dsh-swarm/*` → `@elinpf/dsh-swarm-*`）

- 机械迁移覆盖：所有 `package.json` 的 `name`、源码/测试的 import 与 describe、`cordis.patch.yml` 的插件行、README/docs/ADR/规格里的包名、以及**隔离 profile** 的 bundle 引用（`dsh plugin remove` 旧 + `add` 新）。
- 全链路（build/test/verify/verify:e2e/lint/format）+ `e2e-profile.sh` 迁移后重跑通过。
- 各发布的包补 `publishConfig.access=public` 与 `files` 白名单（`lib` 进包、`src`/`tests`/`.runtime` 不进包）。
- README 增加「与上游 `@deepseek-ai/dsh-*` 的命名对应关系」。

## F. 规格 §9「待实现期核验」的实测结论

1. **`fs/write-intent` 的拒绝语义**：实测**返回 `undefined` = 允许/无意图**（`tool-fs/src/write.ts` 用 `() => undefined` 兜底），**拒绝 = 监听里 throw**（`fs-observation-policy` 对 edit-intent 抛 `FS_NOT_OBSERVED`）；且决策槽**单占**，允许时必须 `next()` 让位。→ `team-workspace` 守卫据此实现（允许 `next()`，拒绝 `throw FS_WRITE_DENIED`，并 defer 为 Promise reject）。
2. **`ctx.skills` 的 per-agent scope API**：`register()` 落在**调用 context 的 scope**，从全局 Service 无法安全地把技能注册进**成员各自 scope**。→ `team-skills` 先实现为**声明注册表 + `visibleTo` 事实源**（`tool-swarm.skills_visible` 消费）；真正落到 `ctx.skills` 成员 scope 的过滤**留待确认 scope API**（未做，如实登记）。
3. **`ctx.worktrees` / `ctx.workingDirectory` 可用性**：`team-workspace` 用**本地结构化 seam** 探测 `ctx.worktrees`（不 import 实验包类型）；缺失时 `createWorktree` 抛 `TEAMWS_WORKTREE_UNAVAILABLE`，**文件锁守卫仍生效**。
4. **`ctx.storage` forms**：`team-memory` 未强制依赖 storage（记忆存活于内存/会话事件），保持轻量；持久化 forms 留待阶段 3。

## G. 边界（如实说明）

- **`team-skills` 未真正写入 `ctx.skills` 的成员 scope**（§F.2），仅提供声明 + `visibleTo`；这是本阶段唯一未完全按规格落地的点。
- `team-workspace` 的 `ctx.worktrees` / `ctx.fs` 以**可选 seam** 接入（未在真实 profile 内触发 worktree 创建）；锁守卫逻辑经单测与集成冒烟验证。
- `team-compaction` 默认 `enabled:false`（不开启硬门控）；真实 token 计量依赖 `ctx.tokenMeter`（未挂载时 `usedTokens=0`）。
- 整机 profile 的**真实模型**阶段 2 交互（如经模型取锁）未跑；`e2e-profile.sh` 默认 `--no-model` 通过，真实模型路径见 `docs/profile-e2e.md`。

---

# P7b：team-skills 成员级技能隔离（**落地**，覆盖 §F.2 / §G 的旧结论）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-26
> 结论：**上游可达**——成员级技能隔离已在真实 `ctx.skills` scope 层生效（非仅声明）。§F.2 / §G 里
> 「从全局 Service 无法把技能注册进成员各自 scope」的旧判断**被证伪并作废**；根因是当时只试了
> **属性访问 `agent.ctx.skills`**，而未试 `agent.ctx.get('skills')`（`get()` 走 root store，不受
> fiber 祖先链限制）。

## H.1 源码依据（0.2.1-rc.3，读源码非推断）

| 事实 | 位置 |
|---|---|
| Agent 自带 scope，**agent 自身即 scope key** | `core/agent-loop/src/agent.ts:130-131`：`this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx` |
| `createScope` 把 key 写成 `ctx` 上的 `kScope` 标签 | `core/scope/src/index.ts:137-147`（`:140` `fiber.ctx.extend({ [kScope]: key })`）、`scopeOf` `:154-156` |
| 注册落进**调用 ctx 的 scope 层** | `skill/skill/src/index.ts:439-460`（`:441` `scopeOf(this.ctx)`、`:452` `this.layers.effect(this.ctx, …)`） |
| 读取合并 global + 查看 scope 链、**最近层同名优先** | `skill/skill/src/index.ts:551-565`（`:556` `[this.layers.global, ...chainLayers(options.scope)]`） |
| 模型侧读取用 `scope: agent` | `skill/tool-skill/src/index.ts:135`（skill 工具 execute）、`:188`（用户显式调用）、`:224`（目录装配） |
| `ctx.get()` 走 **root store**，不受 fiber 祖先链限制 | `cordis/src/reflect.ts:233-244`（`get(name)` → `this.store[key]`，与属性 getter 的 fiber 上溯 `:145-163` 不同） |
| scoped runtime 条目会**影子化**同名全局条目（含 provider 承载） | `skill/skill/src/index.ts:556` 合并语义；上游自测 `skill/skill/tests/skill.spec.ts:1146-1168,1219-1246` |

**因此**：把可见性落到 `agent.ctx`（其 `scopeOf === agent`）后，`list({scope:agent})` 只对该成员生效。

## H.2 实测探针（真实 cordis + 真实 `@deepseek-ai/dsh-skill` + 真实 `dsh-scope`）

`.runtime/probe/scope-probe*.mjs`（临时探针，不入库）实测输出摘要：

```console
# scope-probe4：skills 服务与 agent 是「兄弟 fiber」时两条路
sibling 下 property access FAILED: cannot get property "skills" without inject
sibling 下 get(): OK
A sees: [ 'p-get' ]

# scope-probe3：抑制「provider 承载」的全局技能
before: A sees [ [ 'prov-skill', 'fs' ] ]
after suppress: A catalog []            # A 被压制
after suppress: B catalog [ 'prov-skill' ]  # B 不受影响

# scope-probe2：正例/抑制/隔离
A sees [ 'g-skill', 'p1', 'p2', 'p3' ] ; B sees [ 'g-skill' ]
A catalog: [ 'p1', 'p2', 'p3' ]          # g-skill 被抑制，不进模型目录
B catalog: [ 'g-skill' ]
```

关键：**属性访问 `agent.ctx.skills` 在真实拓扑下会抛 `without inject`**，必须用 `agent.ctx.get('skills')`。

## H.3 落地方案（`packages/team-skills/src/index.ts`）

- `reconcile(agent)`（新增公开方法，**不改契约 `TeamSkills`**）：把该成员可见集落到 `agent.ctx` 的 scope 层，幂等、按 member 串行化：
  - 授权但**非全局**的技能名 → 落**正例**（成员私有 / 团队虚拟技能）。
  - 全局但**未授权**的技能名 → 落**抑制影子**（`invocation.modelInvocable=false`）→ 不进模型目录、不可被 skill 工具加载，且影子掉同名全局技能。
  - 无文档（`unrestricted`）→ 撤销该成员全部落层，回到全局目录。
- `visibleTo` / `grant` / `declare` 内部以即发即忘触发 `reconcile`（保留 `visibleTo` 的同步返回值语义，契约不变）。
- 失败降级：`agent.ctx` 缺失或 `ctx.skills` 不可用 → 仅声明 + 日志告警，不抛、不阻断。

## H.4 行为级单测（真实注册表，非 mock）

`packages/team-skills/tests/team-skills-scope.spec.ts`（真实 `Context` + 真实 `SkillRegistry` + 真实 `createScope`）：

```console
$ corepack pnpm --filter @elinpf/dsh-swarm-team-skills test
 ✓ tests/team-skills.spec.ts (8 tests)
 ✓ tests/team-skills-scope.spec.ts (6 tests)
 Test Files  2 passed (2)
      Tests  14 passed (14)
```

覆盖不变量：**B 私有技能只落 B 的 scope（A 看不到、加载不到）** / **未授权技能不进模型目录（连同名全局技能也压制）** / **grant 后立即可见、撤销后不可见** / **无文档=全局目录** / **scope 释放（HMR）后落层归零** / **reconcile 幂等**。

## H.5 全链路复验

```console
$ corepack pnpm build       # 全部包 Done
$ corepack pnpm test        # 全包通过（team-skills 14 用例）
$ corepack pnpm verify      # 真实 cordis 加载全部包，通过
$ corepack pnpm verify:e2e  # 集成冒烟通过（含「技能可见性：lead 可见 arch-design；bob 为空」）
$ bash scripts/e2e-profile.sh --no-model
  [PASS] bundle 自身插入行 = 11 (期望 11)
  [PASS] 原生 agent-team / tool-agent-team 行 = 2 (期望 2)
  [PASS] legacy tool-subagent* 为 disabled 的行数 = 4 (期望 4)
  [PASS] dump-config 无禁用/不兼容告警
  结果：PASS=4 FAIL=0
$ corepack pnpm lint && corepack pnpm format:check   # 本包（packages/team-skills）0 error / All matched
```

> 说明：全仓 `lint`/`format:check` 期间，**其他成员并行开发中的未提交文件**（`scripts/bench/*`、
> `scripts/check-publish-workflow.mjs` 等）存在告警；**与本次改动无关**，`packages/team-skills/**`
> 单包 lint/format 全绿。该问题应在各自任务合并前由其作者修复。

## H.6 结论与剩余边界

- **结论**：成员级技能隔离**真实生效**（写入 `ctx.skills` 成员 scope 层），非声明层。
- 边界 1：正例注册的虚拟技能**正文为占位体**——`team-skills` 只拥有可见性、不拥有技能正文；正文应由团队技能包/提供方承载。
- 边界 2：实时触发依赖契约方法（`visibleTo`/`grant`/`declare`）被消费方调用（`tool-swarm.skills_visible` 等）；整机 profile 级「每步自动 reconcile」联调留待阶段 3。
- 边界 3：`reconcile` 是 `TeamSkillsService` 的增量方法，**未进 `TeamSkills` 契约**（避免契约变更）。
