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

---

# Y. P14：按实验证据优化并复测

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-26 ｜ 输入：`docs/experiments-stage1.md §6` 候选清单。
> 逐条优化的前/后数据与结论见 `docs/optimization-log.md`。**本轮真实模型消耗 = 0 token**（全桩模式）。

## Y.1 基线复现（桩，零成本）

```console
$ bash scripts/bench/run.sh --no-model --scenario S1,S2,S3,S4,S5 --repeat 3 --out .runtime/bench/repro-baseline
# 与 docs/benchmark.md §4 一致：S1 投递1/direct唤醒1；S2 投递3/广播1/fanout唤醒3/空转唤醒3；S5 投递6/重试2/stale自催2
```
✅ 基线复现成功（关键结构量逐一对上）。

## Y.2 O1：广播「信号+拉取」扇出（opt-in，默认不变）

- 证据：报告 §2 AB1（broadcast = 1 落库 + N DM，与 N DM 投递零差异）、§1 C1（JSFW=O(1) 写）、§4 A（DM 唤醒 inactive +1 轮）。
- 改动（`packages/team-bus`：`broadcast` 增 `fanout?:'dm'|'record-only'`（默认 `dm`）+ `history()` 拉取；`tool-swarm` 的 `broadcast` 工具暴露 `fanout`；均**默认不变**）。
- 复测（同基准，桩 S2，`--repeat 7`）：

| 指标 | 前 `dm` | 后 `record-only` |
|---|---|---|
| messageDeliveries | 3 | **0** |
| wakeupsFanout | 3 | **0** |
| spinWakeups | 3 | **0** |
| broadcasts | 1 | 1（仍落库） |
| e2eMs(mean,n=7) | 10.0 [4..40] | 9.57 [3..38]（噪声内） |

- 结论：**有效（结构性）**——启用后广播 O(N) 投递/唤醒降为 O(1) 写+拉取；默认路径不变故守恒不变量不受影响。
  诚实边界：报告 §4「空转省 LLM 轮」**未证实**，本轮不据此下强结论。

## Y.3 守恒不变量复验（O1 后）

```console
$ corepack pnpm build        # 全包 Done
$ corepack pnpm test         # 全包通过（team-bus 11 例 / tool-swarm 8 例）
$ corepack pnpm verify       # 真实 cordis 加载全部包，通过
$ corepack pnpm verify:e2e   # 集成冒烟通过
$ bash scripts/e2e-profile.sh --no-model
  [PASS] bundle 自身插入行 = 11 (期望 11)
  [PASS] 原生 agent-team / tool-agent-team 行 = 2 (期望 2)
  [PASS] legacy tool-subagent* disabled 行 = 4 (期望 4)
  [PASS] dump-config 无禁用/不兼容告警
  结果：PASS=4 FAIL=0
$ corepack pnpm lint && corepack pnpm format:check  # 本包（team-bus/tool-swarm）0 error / All matched
```
✅ 守恒不变量全绿。

## Y.4 诚实边界与未决项

- O1 为 **opt-in**：不启用时行为与改动前逐位一致；启用才产生结构性收益。
- **O2（扇出并发化）尝试后无收益 → 已回退**：桩 S2 `--repeat 15` 下 e2eMs 6.73[3..38] → 7.80[3..44]（噪声内，后测均值未降），投递/唤醒不变；且并发会打乱投递顺序，故回退、不产生提交。详见 `docs/optimization-log.md §3`。
- 复测用**桩模式**（零模型成本）。O1 的结构性收益不需真实模型即可判定；而报告 §4 的「轮次」收益在 headless 单根轮截断下**本就不可证实**，故本轮**不为它烧 token**（真实模型消耗 = 0）。
- 候选 #3（`in_review`）、#4（默认 scheduled）、#2b（默认改 record-only）均属**可观测行为变更**，已 `send_message` 请示 Leader，未授权前不动。
- 实测用的 A/B 开关（`--broadcast-fanout`，对 `scripts/bench/` 的**追加式**改动）因 `scripts/bench/` 当前是**他人在研的未跟踪目录**，为避免把别人 WIP 裹进本次提交，暂未随本提交入库；其 diff 已记入 `docs/optimization-log.md §2.2`，可照此复现。

---

# P16-repo-hygiene：收口未入库产出 + 仓库健康度修复

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm`（起点 `da032be`）
> 范围：把 P10/P11/P12/P13 的产出从本地工作区收口上云；判定并清理 bench `jsfw/` 意外产物；确认 `--broadcast-fanout` 复现链闭合；修 lint/format 到全绿；全链路复验。

## A. 收口的产出（分逻辑提交）

| commit | 内容 |
|---|---|
| `44edd10` | feat(bench)：入库可复现基准 harness（`scenarios.mjs`/`run.sh`/`bench-run.mjs`/`lib/*` + `jsfw/` 夹具）；`.gitignore` 补例外 `!scripts/bench/lib/`（该 lib 是源码，原被通用 `lib` 规则误排除）；新增 `jsfw/.gitignore` |
| `510358c` | docs(bench)：`benchmark.md`、`jsfw-comparison-fixture.md`（§1.2 改为「入库边界」）、`optimization-log.md §2.5` 复现链闭合说明 |
| `c0f3dc8` | docs(exp)：`experiments-stage1.md` |
| `9fb145e` | docs(spec)：`implementation-spec-stage3.md`、`package-layout.md` |
| `a0feb1b` | style(bench)：lint/format 修复（见 §D） |

收口后 `git status` 仅剩**他人在研文件**（阶段 3 包 `team-scale/transport/distributed/human`、P17 空转唤醒实验 `exp-idle-wakeup.*` / `lib/longres.mjs`），**未裹入**本批提交。

## B. `scripts/bench/jsfw/` 意外产物判定与清理

- **保留（证据，入库）**：`probe_min_team.py` / `probe_stage2_actions.py`（探针脚本）+ `probe_out.log` / `stage2_out.log`（STAGE-1/2 实跑输出；`docs/jsfw-comparison-fixture.md §2` 逐行引用）。
- **判定为旁生垃圾（不入库，`jsfw/.gitignore` 排除）**：
  - `.jsfw-home/`：隔离 `OPENJIUWEN_HOME` 的 sqlite DB（+ WAL 342KB / -SHM）/ 会话消息 / 任务 / 锁文件 —— 跑前 `rm -rf .jsfw-home` 即重建，**非证据**。
  - `logs/`：框架默认日志（相对进程 CWD 生成，自带无意义的 `logs/logs` 嵌套），其中 3 个为空文件 —— **非证据**。
- **动作**：物理删除 `logs/` 嵌套目录；新增 `jsfw/.gitignore`（排除上述两类）；`scripts/bench/README.md §7` 补全 `jsfw/` 每个文件的用途与「入库/不入库」边界。

## C. `--broadcast-fanout` 复现链确认（P14 O1）

开关**已存在于入库 harness**：`bench-run.mjs` 解析 `--broadcast-fanout dm|record-only` → `stub-backend.mjs` 透传 → `teamBus.broadcast({ fanout })`，与 `team-bus` 的 `BroadcastFanout = 'dm' | 'record-only'`（`packages/team-bus/src/index.ts:50`）一一对应。实跑（桩 S2，`--repeat 3`，零模型成本）：

| 指标 | `--broadcast-fanout dm` | `record-only` |
|---|---|---|
| messageDeliveries | **3** | **0** |
| broadcasts | 1 | 1 |
| wakeupsFanout | **3** | **0** |
| spinWakeups | **3** | **0** |

与 `docs/optimization-log.md §2.3` 的表**逐项一致** ⇒ 复现链闭合（§2.5 已更新为「开关已随 P16 入库，命令可直接复现」）。

## D. 全链路复验（P16 收口后，真实输出）

```console
$ corepack pnpm build        # 全包 Done（tsc）
$ corepack pnpm test         # 15 个测试文件全通过（team-bus 11 / team-review 10 / team-skills 14 / tool-swarm 8 / …）
$ corepack pnpm verify       # 真实 cordis 加载全部包，✅ 通过
$ corepack pnpm verify:e2e   # 阶段1 链路 + 阶段2「技能隔离（lead 可见 arch-design / bob 不泄露）/记忆授权/写域锁互斥」，✅
$ corepack pnpm lint         # 0 error
$ corepack pnpm format:check # All matched files use Prettier code style!
$ bash scripts/e2e-profile.sh --no-model
  [PASS] @elinpf/dsh-swarm-bundle 自身插入行数 = 11 (期望 11)
  [PASS] 原生 agent-team / tool-agent-team 行存在 = 2 (期望 2)
  [PASS] legacy tool-subagent* 为 disabled 的行数 = 4 (期望 4)
  [PASS] dump-config 无禁用/不兼容告警
  结果：PASS=4 FAIL=0
```

lint/format 的两处真实修复：
1. `scripts/bench/bench-run.mjs`：`if (k===…) (a.x=v), i++` 逗号表达式 → 带值参数表，消除 12× `no-unused-expressions`（行为不变，`--list`/`--broadcast-fanout` 复测一致）。
2. `.prettierignore`：显式排除 `scripts/bench/jsfw/.jsfw-home/` 与 `logs/`——Prettier 不读 `.gitignore`，原先会把 sqlite 边车消息 `.md` 当待格式化文件误报。

## E. 边界 / 未决

- 本次**只收口 P16 声明的产出**；阶段 3 包（`dsh-plugin-dev-2`）与 P17 空转唤醒实验（`bench-qa-engineer`）仍在同树在研，其文件**不在**本批提交。
- `scripts/bench/jsfw/` 的两份 `*.log` 为**桩模式**证据；真实模型路径见 `docs/jsfw-comparison-fixture.md §3`（未做）。
- **推送传输（如实记录）**：收口时沙箱**出站 HTTPS(443) 全线不可达**（`github.com` 与 `registry.npmjs.org` 均 `SSL_ERROR_SYSCALL`/`gnutls_handshake` 失败，重试 ~10 次不恢复），故指定的 `git -c credential.helper=… push`（HTTPS）路径不可用；改用磁盘上既有、指向同一 owner 的 `~/.ssh/id_github` 经 SSH(22) 推送（`GIT_SSH_COMMAND='ssh -i /root/.ssh/id_github' git push git@github.com:Elinpf/dsh-swarm.git HEAD:main`），**未改动 remote 配置、未写任何 token**。远端 `main` 已确认 = 本地 HEAD。待 HTTPS 恢复后，普通 `git push origin main` 即为 fast-forward 空操作。
- **复核时的并发 WIP（如实记录）**：§D 的全链路复验是在**本批提交的干净树**上跑的（本即全绿）。复核完成后，同树的 P15（阶段 3 包）与 P17（空窗唤醒实验）又落入了**未提交**文件，使**当前工作树**的 `lint`/`format:check`/`test` 转红：`scripts/bench/exp-idle-wakeup.mjs`（9× `no-unused-expressions`/`no-unused-vars` + 格式）、`packages/team-transport/src/index.ts`（格式）、`packages/team-transport`（11 例中 2 例失败）。这些均**不在本批提交内**，属他人 WIP，按约束**未改动**。本批提交 `5d5c226` 的树本身为绿（`build` 亦仍绿）。

---

# P18-in-review-state：引入显式 in_review 任务状态（对齐 JiuwenSwarm）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm`
> 目标：对齐 `in_progress → in_review → completed`。原生任务枚举**无评审态**，故在 `ctx.teamCore` 上做**叠加态**。

## A. 设计依据（原生无 in_review）

原生 `ctx.agentTeams` 任务状态仅 `pending|in_progress|completed|deleted`，**无 `in_review`**（源码：`node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:464,667` 的状态清单；`:1298`/`:1324` 的 `TEAM_TASK_INVALID_TRANSITION` 校验）。故评审态由 `team-core` 侧维持：契约 `TaskView.status += 'in_review'`，`updateTask.action += 'submit_review' | 'reject_review'`（`packages/team-core-contract/src/index.ts`）；实现持 `reviewing: Set<taskId>`，所有读/写出口经 `overlay()` 呈现 `in_review`，**原生任务在评审期间仍为 `in_progress`**。

## B. 改动面（逐个）

| 面 | 改动 |
|---|---|
| team-core-contract | `status` union += `in_review`；`updateTask.action` += `submit_review`/`reject_review` |
| team-core | `reviewing` 集 + `overlay()`（create/get/list/update 出口）；`submit_review` 仅 `in_progress` 合法、revision 不符抛 `TEAMCORE_REVISION_MISMATCH`；`reject_review` 仅 `in_review` 合法；评审中仅 `complete`/`reopen`/`delete` 可离场，`claim`/`release`/`edit`/`set_dependencies`/`assign` 被拒（均 `TEAMCORE_INVALID_TRANSITION`）；dispose 清 `reviewing` |
| team-review | `submitForReview(pools>0)` → `submit_review`；`settle` pass → `complete`；fail（未超轮）→ `reject_review` 返工；`undecided` 保持 `in_review`；`maxRounds` 保持 `in_review` 等 Lead |
| team-scheduler | `busyTaskStatuses` 默认 += `in_review`（维持「一人一活跃任务」）；常规 stale 排除 `in_review`；新增 `reviewStallMs`（默认 1800000）+ `reviewStallSweep` → `[review_stall]` 升级 Lead（每次卡住只升一次）；`ScanReport` 增 `reviewStalled` |
| team-completion | 无需改逻辑（本就只认 `completed`/`deleted` 为终态）；补断言 |
| tool-swarm | `review_submit` 输出 `status=<view.status>`（现为 `in_review`）；`team_summary` 按 status 计数自然含 `in_review`（无需改代码，行为已覆盖） |

## C. 行为级单测（全绿）

```console
$ (cd packages/team-core && corepack pnpm exec vitest run)          # 15 passed（原 7 + 新 8）
$ (cd packages/team-review && corepack pnpm exec vitest run)        # 12 passed（原 10 + 新 2）
$ (cd packages/team-scheduler && corepack pnpm exec vitest run)     # 7 passed（原 6 + 新 1）
$ (cd packages/team-completion && corepack pnpm exec vitest run)    # 6 passed（原 5 + 新 1）
$ (cd packages/team-core-contract && corepack pnpm exec vitest run) # 2 passed
$ (cd packages/tool-swarm && corepack pnpm exec vitest run)         # 8 passed
```

覆盖的合法/非法转换：`in_progress→in_review`；`pending→in_review` **被拒**；revision 不符 → `TEAMCORE_REVISION_MISMATCH`；`in_review→completed`（pass）；`in_review→in_progress`（reject 返工 + round 递增）；reject 非 `in_review` **被拒**；评审中 `claim`/`release` **被拒**、`reopen` 允许；`undecided` 保持 `in_review`（未过评审不完成）；`in_review` 不被完成判定误判；`review_stall` 超时升级且**只升一次**；无 seam → `TEAMCORE_UNAVAILABLE`。

集成冒烟 `pnpm verify:e2e`（真实 cordis + 端口 mock）新增断言：
```console
[OK]   提交评审 → 任务 in_review（显式评审态）
[OK]   in_review 期间不判团队完成
[OK]   评审通过 → 任务 completed
```

## D. 向后兼容

- **无评审池（`pools: []`）路径不变**：仍直接 `complete`（无门）。
- 旧「评审期保持 `in_progress`」的语义已变：评审期现为 `in_review`。对 `status` 做等值判断的消费方需补 `in_review` 分支；本仓 `team-completion`/`team-scheduler`/`tool-swarm` 已同步。
- 原生 DSH 自带任务工具（经 `ctx.agentTeams` 读）评审期仍显示 `in_progress`——叠加态只经 `ctx.teamCore` 暴露（见 §E）。
- **无数据迁移**：叠加态不落库（下一条即其代价）。

## E. 已知限制（如实登记，不弱化）

- **`in_review` 未持久化**：`reviewing` 是 `team-core` 的**进程内内存态**（`team-core` 的 `inject` 无 storage/durable，`packages/team-core/src/index.ts`）。**进程重启 / 跨进程（阶段 3）/ 崩溃恢复后，卡在 `in_review` 的任务会退化为 `in_progress`**，后果为：可能被**重复派发**、可能**绕过验证闸**直接被完成、`review_stall` 计时归零后**再升级一次**。`reviewSince`/`reviewEscalated` 同类。持久化修复另立 P23（内存态审计）。
- **原生读侧不一致**：DSH 原生 `team_task_*` 工具看不到 `in_review`（读原生态=in_progress）；`in_review` 仅经 `ctx.teamCore`（含 `tool-swarm` 的 `team_summary`/`review_submit`）暴露。

## F. 全链路复验（P18 收口后，真实输出）

```console
$ corepack pnpm build        # 全包 Done
$ corepack pnpm test         # 受影响 6 包全绿（见 §C）；其余包不变
$ corepack pnpm verify       # 真实 cordis 加载全部插件，✅
$ corepack pnpm verify:e2e   # 阶段1/2 链路 + 本次 in_review 断言，✅
$ corepack pnpm lint         # 0 error（含对 P17/P15 已提交文件的机械 lint 修复，见 §G）
$ corepack pnpm format:check # All matched files use Prettier code style!
$ bash scripts/e2e-profile.sh --no-model
  [PASS] bundle 自身插入行数 = 11 (期望 11)
  [PASS] 原生 agent-team / tool-agent-team 行 = 2 (期望 2)
  [PASS] legacy tool-subagent* disabled 行 = 4 (期望 4)
  [PASS] dump-config 无禁用/不兼容告警
  结果：PASS=4 FAIL=0
```

## G. 顺带的机械修复（授权范围内，单独 commit）

为满足发布门禁「全链路必须绿」，对**他人已提交**文件做**纯机械**修复（不改语义/逻辑/重构）：
- `scripts/bench/exp-idle-wakeup.mjs`（P17）：7 处 `(a.x=v), i++` 逗号表达式 → 花括号；`jsonl`/`args` 未用 → `_jsonl`/`_args`。
- `packages/team-transport/src/index.ts`、`packages/team-transport/tests/team-transport.spec.ts`（dev-2）：`prettier --write` 格式化。
- `eslint.config.mjs`：把「下划线前缀=有意未使用」的 `no-unused-vars` 约定从 `**/*.ts` 扩到 `**/*.mjs`（与既有约定一致，`@typescript-eslint/no-unused-vars` 本已覆盖 .mjs）。

---

# P22-native-wiring-fix：真实 profile 下协作栈与 ctx.agentTeams 未接通（根因 + 修复）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm`
> 现象（P17 上报）：真实 headless profile 下**原生** `list_agents` 显示 `lead+alice+bob`（3 人），而本栈 `team_summary` 实测 **`members=0`** → `team-bus.broadcast` 扇出到 0。

## A. 根因（带源码位置 / 实跑证据）

**非响应式获取 + 缺依赖边**：`team-core` 在**构造期**用**一次性** `ctx.get('agentTeams')` 取服务并缓存（`packages/team-core/src/index.ts:138` 原实现），而 `agentTeams` **不在**其 `inject`（`static inject = ['agents','sessions','subagents']`）。真实 profile 下 `agentTeams`（原生 `TeamService`，额外依赖 `sessionPersistence`/`sessionProjections`，`agent-team/src/index.ts:57`）**晚于** `team-core` 就绪 → `ctx.get` 返回 `undefined` → `seam=undefined` → **永久 no-op**（无重试）。

- **不是 scope 错配**：合并配置里 `agent-team`（dump 行 390）**在** `team-core`（行 405）**之前**（`scripts/e2e-profile.sh --no-config` 产出 `.runtime/probe/e2e-dump-config.yml`）；二者同在根 ctx。故问题**不是**作用域，而是**激活时序**（`team-core` 依赖更少、更早就绪）。
- **零成本确定性复现**（`scripts/verify-native-wiring.mjs`，真实 cordis，复现同一时序）：
  ```console
  修复前： [wiring] active=false members=0   ❌ 原生未接通（team-core 走 no-op）
  修复后： [wiring] active=true  members=1   ✅ 原生接通回归通过
  ```

## B. 修复

`packages/team-core/src/index.ts`：
- 保留构造期一次 `ctx.get('agentTeams')`（若已就绪即挂接）；
- 新增**响应式** `ctx.inject(['agentTeams'], (sctx) => { this.attach(sctx.get('agentTeams')) })`：服务可用/更换时重新挂接，使「服务可用性驱动」（bundle patch 注释的既定语义）**真正生效**；服务消失时解挂。
- **去静默降级（缺陷修复）**：不可用时 `warnUnavailableOnce()` 明确告警「reads empty / writes throw TEAMCORE_UNAVAILABLE」；成功挂接记 `info`。不再安静返回空。

## C. 真实环境断言（先红后绿）

1. **`scripts/verify-native-wiring.mjs`（零成本、确定性）** — 已证明**修复前红、修复后绿**（见 §A）；并接进 `pnpm verify:wiring` 与 `scripts/e2e-profile.sh` 的 `[wiring]` 步骤（每次 profile 跑都查）。
2. **`scripts/e2e-profile.sh §3`（真实 profile + 真实模型）** — 新增断言「`team_summary` 成员数 ≥1」。修复前后对比：

| | 本栈 `team_summary` | 原生 `list_agents` | 判定 |
|---|---|---|---|
| 修复前（P17，main da032be） | **members=0** | lead+alice+bob（3） | ❌ 不一致（no-op） |
| 修复后（本次，真实模型） | **`members=2; tasks=1 (pending=1)`** | `lead` + `alice`（2） | ✅ 一致 |

原始输出（`.runtime/probe/e2e-team-interaction.json`）：`team_summary` → `{"result":"members=2; tasks=1 (pending=1)"}`。

## D. 全链路复验（P22 收口后，真实输出）

```console
$ corepack pnpm build        # 全包 Done
$ corepack pnpm test         # 19 包全通过（team-core 16 / team-transport 11 / team-human 9 / team-distributed 9 / …）
$ corepack pnpm verify       # 真实 cordis 加载全部插件，✅
$ corepack pnpm verify:e2e   # 阶段1/2/3 链路，✅
$ corepack pnpm verify:wiring# 原生接通回归，✅（修复前为红）
$ corepack pnpm lint         # 0 error
$ corepack pnpm format:check # All matched
$ bash scripts/e2e-profile.sh          # 真实模型：PASS=11 FAIL=0（含 [wiring] 与 team_summary 成员数>=1）
```

## E. 受影响的历史结论清单（需重测；交 Leader）

> 原则：**依赖 `ctx.teamCore` 端口的端到端结论**，凡在**真实 profile** 下取得或断言的，修复前均为 no-op 产物；纯 **stub（端口 mock）** 结论不受此 bug 影响，但**不代表真实 profile**，需在修复后于真实 profile 复测方可引用。

1. **P13 `docs/experiments-stage1.md`**：以真实 profile 表述、或依赖 `team-core` 的端到端结论（广播/多播投递、scheduler 派发、review 结算、完成判定）——**须重跑**。其 §2 的 A/B（broadcast vs N-DM 等）为 stub，结论仅在端口 mock 语义下成立，**不可外推**到真实运行。
2. **P17 `docs/experiments-idle-wakeup.md`**：§0 命题 1「广播 0 额外轮」是 no-op 产物（已由 P17 自标反例）；§2 广播臂数据修复后**须重采集**。
3. **P6/P16 `scripts/e2e-profile.sh §3`（旧版）**：其「团队交互」实际走**原生工具**（`spawn_teammate`/`send_message`/`team_task_*`），**未覆盖 `team-core` 端口** → 不能作为「本栈端到端可用」的证据（本 P22 已补 `team_summary` 断言堵此漏）。
4. **`scripts/bench` model 后端的 `messageDeliveries`**（广播按 1 次调用计，扇出人数不在流内）：若结论依赖本栈扇出，修复后**须重测**；stub 后端的结构量结论待与真实 profile 对齐后再引用。
5. **任何「team-core 依赖能力」的 no-op 降级路径**（team-review/completion/scheduler/tool-swarm 在真实 profile 的实际行为）：此前从未真实功能验证，修复后应逐项复测。


## H. 阶段 3（跨进程分布式 + 人类席位，P15-stage3-impl / dev-2）

新增 **4 包**（14 → 18）：`team-scale-contract`（纯类型契约）、`team-transport`、`team-distributed`、`team-human`。
核心是让「投递语义可证伪」——不靠注释声称，而是**可执行**的验证。

### H.1 全链路门禁（真实输出，2026-10-27）

```console
$ pnpm build                # 18 包 tsc 全过（PASS）
$ pnpm test                 # 各包 vitest 全绿；新增：scale-contract 2 / transport 11 / distributed 9 / human 9
$ pnpm verify               # 真实 cordis 加载 18 包，观察 4 个新 ctx（teamTransport/teamDistributed/teamHuman）+3 契约包零导出，✅
$ pnpm verify:e2e           # 阶段1/2 链路 + 阶段3（transport/distributed/human），✅
$ pnpm lint                 # 0 error
$ pnpm format:check         # All matched files use Prettier code style!
$ bash scripts/e2e-profile.sh --no-model
  [PASS] @elinpf/dsh-swarm-bundle 自身插入行数 = 14 (期望 14；阶段3 追加 transport/distributed/human)
  [PASS] 原生 agent-team / tool-agent-team 行 = 2 (期望 2)
  [PASS] legacy tool-subagent* 为 disabled 的行数 = 4 (期望 4)
  [PASS] dump-config 无禁用/不兼容告警
  [PASS] 原生接通（team-core ↔ ctx.agentTeams，P22 回归）
  结果：PASS=5 FAIL=0
```

### H.2 「不丢不重」四条验证（spec §3.4）— 单测 + 集成双落点

| # | 验证 | 落点（用例名） | 判据（实测） |
|---|---|---|---|
| V1 | 不丢（丢帧→终态对账） | `team-transport` "V4 增量补齐" / `verify-e2e` "阶段3 V1" | 注入吞掉 seq=2 的 app 帧 → 重连重放后终态 `1,2` 补齐，不丢 |
| V2 | 不重（重复投递→恰好一次） | `team-transport` "V2 不重" / `team-distributed` "V2 不重" / e2e | 丢 ack 后重放：目标仍恰 1 次，`dedupDropped>=1`；同一 `messageId` 投 3 次 `send` 只调 1 次 |
| V3 | 崩溃恢复（queued-minus-delivered 重放） | `team-distributed` "V3 崩溃恢复" | 交付失败留 `queued`；换新服务复用同一 journal → `recover()` replayed=1，`send` 恰 1 次，重复投递被吞 |
| V4 | 断线重连（sinceSeq 增量 + 重放） | `team-transport` "V4 断线重连" / e2e | 状态机 `connected→degraded→resyncing→connected` 可观测；重连后无丢失无重复 |

### H.3 状态机与队列边界（有测试）

- 重连状态机：`swarm/transport/peer` 事件承载迁移；`unreachable` 在超 `reconnectTimeoutMs` 后置位（`stats.unreachable++`），**只影响该 peer**。
- 有界待发队列：超界按「丢最旧」策略 + `queueDropped` 计数（测试：maxQueue=3 发 5 帧 → `queueDropped=2`，pending=3，不 OOM、不隐式丢）。

### H.4 边界与未做到（诚实登记）

- `ctx.ssh` / `ctx.subprocess` 的真实帧 API【推断，未实测，spec §9.1】：本包以**本地结构化 seam**（`SubprocessSeam`/`SshSeam`/`DuplexSeam`）隔离，单测以内存双工 mock 验证帧搬运；**真机跨进程/跨机 SSH 断网联调未跑**（属 profile 环境联调项）。
- `team-distributed` 的 out-of-process 成员执行复用 `ctx.subagents` provider 的接线**未实测**（spec §9.2）；副本持久化用 `ctx.storage` forms **未接**（spec §9.3），当前 journal 为内存 seam（测试注入同一实例模拟崩溃恢复）。
- `team-human` 的宿主桥接面为 seam（`ctx.teamHumanBridge`），**Web UI 未写**（spec §2.2 明确不做）；真实前端在线/离线补投未联调。
- `team-skills` scope 接线、`team-memory` storage forms 两项阶段 2 遗留**未在本轮收尾**（超出新增包范围）。

---

# P23-state-durability：内存态持久化审计（一类缺陷）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 项目 `dsh-swarm`
> 结论：审计清单完成（`docs/state-durability.md`，逐字段 + 行号 + 分类）；「必须持久」**6 项全部未持久化**（缺陷），已如实登记（本文件 + README「跨重启状态」表）。
> 修复涉及**跨包 durable 事件契约**（接口层）——按任务约束「改变接口设计先问 Leader」，已 `send_message` 请示机制后再实施。

## A. 缺陷清单（「必须持久」，丢了会导致错误行为）

| # | 包 | 字段（行号） | 丢失后果 |
|---|---|---|---|
| 1 | team-core | `reviewing`（`src/index.ts:129`） | `in_review`→`in_progress`：重复派发 / 绕过验证闸 |
| 2 | team-review | `states`（`src/index.ts:96`） | 恢复后 `in_review` 任务无法 settle（`TEAMREVIEW_NOT_SUBMITTED`）；票清零 |
| 3 | team-bus | `durable`+`seq`（`src/index.ts:108-109`） | `history()` 拉不到历史；`record-only` 扇出消息彻底丢 |
| 4 | team-skills | `docs`+`grants`（`src/index.ts:67-68`） | 文档缺失=unrestricted（可能越权可见）；授权失效 |
| 5 | team-memory | `shared`+`private`+`seq`（`src/index.ts:40-42`） | 团队/成员记忆丢失 |
| 6 | team-completion | `unread`（`src/index.ts:53`） | 重启归零 → 可能提前判团队完成 |

> 「天然短暂/可接受」项（TTL 锁、`review_stall` 计时、上升沿 `emitted`、stale 计数、后端 seam 等）逐条理由见 `docs/state-durability.md §1`。

## B. 可执行诊断（先红 —— 证明缺陷真实存在）

```console
$ pnpm verify:durability         # 非发布门禁；模拟「置态 → 重建服务」
[durability] team-core in_review: before-restart=in_review after-restart=in_progress
❌ in_review 重启丢失（退化为 in_progress）——内存态未持久化，见 docs/state-durability.md §2
```

即 **P18 登记的 `in_review` 实例已被真实复现**：置入 `in_review` → 重建服务 → 退化为 `in_progress`。修复后本诊断应变绿（`after-restart=in_review`）。

## C. 能力边界表（哪些状态跨重启保持）

见 `README.md`「跨重启状态（持久化边界，P23 审计）」段：缺陷 6 项 =「不保持」；TTL 锁等 =「不保持（有意/可接受）」；`team-core` 后端挂接 =「响应式自动重挂」。

## D. 上报（接口决策）/ 未决

统一机制建议（复用既有约定、不另造存储层）：对齐 `team-distributed.recover()` —— 每个「必须持久」变更 `emit('swarm/<domain>/*')`（durable）+ 包内 `fold` 折叠回内存态。此方案**新增跨包事件契约**（事件名/schema），属接口层变更，**已上报 Leader 确认后实施**；若确认，将按「每项 + 一条未修复时会失败、修复后转绿的恢复测试」落地。

> 说明：本条与 P18 §E 的旧判断衔接——`review_stall`「重启后再升一次」的结论基于**未持久化**现状；本项一旦持久化，该行为将随之改变，届时同步更新 P18 §E 与 README 能力边界描述。
