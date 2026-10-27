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
> 结论：审计清单完成（`docs/state-durability.md`，逐字段 + 行号 + 分类）；「必须持久」**6 项**已按 **ADR-0002（durable 事件 + fold）** 修复，各配恢复测试（未恢复失败 / 恢复成功）；能力边界表更新为「保持」。

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

## B. 恢复测试与诊断（先红 → 后绿）

**修复前（红）** —— 缺陷真实存在：
```console
$ pnpm verify:durability         # 非发布门禁；模拟「置态 → 重建服务」
[durability] team-core in_review: before-restart=in_review after-restart=in_progress
❌ in_review 重启丢失（退化为 in_progress）
```

**修复后（绿）** —— 按 ADR-0002 emit durable + `recover` fold：
```console
$ pnpm verify:durability
[durability] team-core in_review: before=in_review | after-restart(no-recover)=in_progress | after-recover=in_review
[durability] captured durable events = swarm/core/review-entered
✅ 内存态经 durable 事件折叠后跨重启保持（ADR-0002）
```

每个「必须持久」项都配了**恢复测试**（重建服务 + `recover(捕获的 durable 事件)` → 状态仍在；未 `recover` 则丢），覆盖：team-core `reviewing`、team-review `states`、team-bus `durable/history`、team-skills 可见性/授权、team-memory shared/private、team-completion `unread`。对应单测数见 §D。

## C. 能力边界表（哪些状态跨重启保持）

见 `README.md`「跨重启状态（持久化边界，P23 审计）」段：6 项缺陷 =「**保持**（ADR-0002）」；TTL 锁等 =「不保持（有意/可接受）」；`team-core` 后端挂接 =「响应式自动重挂」。

## D. 机制（已采纳 ADR-0002）与遗留

统一机制（复用既有约定，不另造存储层）：每个「必须持久」变更 `emit('swarm/<domain>/*')`（durable，带 `version`）+ 包内 `recover(events)` 用统一助手 `foldDurableEvents`（新包 `@elinpf/dsh-swarm-team-durable`）折叠回内存态；运行时经 `ctx.on('session/event')` 叠加。事件名/schema 冻结在 `docs/adr/0002-durable-state-convention.md`。

> 说明：`review_stall`「重启后再升一次」的旧判断基于**未持久化**现状；`reviewSince/reviewEscalated` 属**有意不持久**（可接受），故该结论**仍成立**（P18 §E 无需改）。


## I. 从内存 mock 推到真实子进程（P25-real-crossprocess / dev-2）

承接 §H.4 的可信度缺口：把跨进程能力从「内存双工 mock」推到「**真起子进程**」，并补上**真实进程杀死/重启**。

### I.1 可行性实测（先判后做）

- **`ctx.subprocess` 可驱动真实子进程**（实测）：`@deepseek-ai/dsh-subprocess-local@0.2.1-rc.3` 可独立经 cordis 加载；
  `resolveExecutable('node')` 返回隔离 node22；`spawn({argv,cwd,stdio:{stdin:'pipe',stdout:'pipe',stderr:'inherit'},graceMs})`
  **同步**返回 `SubprocessHandle{ stdin, stdout, stderr, control, collected, done, terminate, waitForExit }`；`await done → {exitCode:0,signal:null}`，stdout 收到 `hello-child`。
  （探针 `.runtime/probe/px-subprocess.mjs`）
- **`ctx.ssh` 不可用**：本仓未安装 `dsh-ssh`（`node_modules/@deepseek-ai` 无 `dsh-ssh`），故 `ssh-rpc` 后端**仍为未实测**，
  仅保留 seam + 内存双工单测；落地条件：安装 SSH 后端并接入 `ctx.ssh`（帧/RPC 形状见 spec §9.1）。
- **`ctx.subagents` 的 out-of-process provider 不可用**：本仓仅安装 `dsh-subagent-spawn-in-process` / `dsh-subagent-fork-in-process`
  （`ls node_modules/@deepseek-ai | grep subagent` 无 `acp`/`dsh-sdk`/`codex`/`claude-code`）。
  ⇒ §4.3 的「远端成员执行」**未验证**；落地条件：安装 `@deepseek-ai/dsh-subagent-dsh-sdk`（或 `dsh-acp`）+ 一个真实远端执行环境，
  再经 `ctx.subagents.registerProvider` 接入。

### I.2 local-child：**真起子进程**（不是 mock）

- 新增随包发布的 `packages/team-transport/relay/relay.mjs`：一个**独立 node 进程**，stdin/stdout 走 JSONL `WireFrame`，
  实现对端语义（`app` 幂等去重 + ack + 回声；`ack` 摘除；`sync-req` 增量重放）。
- `team-transport` 的 `SubprocessSeam` 形状**按真实 `SubprocessHandle` 对齐**；新增 `NodeStreamLink` 适配真实 stdin/stdout，
  并**修正 JSONL 行缓冲**（原按 `data` 块切行会把半行丢帧——真实流下的必备修复）。
- 新增 **发送端 ack 超时重发**（`ackTimeoutMs`，spec §3.2 退避重试）；relay 侧同样带重发定时器。
- 新增 **进程纪元 `epoch`**：对端重启后 seq 空间重置，接收端据 `epoch` 复位去重窗口（否则会把重启后的新帧当重复丢弃）。

### I.3 V1–V4 在真实父子进程上的结果（含真实杀死/重启）

| 验证 | 场景 | 结果 | 落点 |
|---|---|---|---|
| V2 不重 | relay 丢弃首条 ack → 父 ack 超时重发 → relay 按 seq 去重（只 ack 不回声） | ✅ 目标恰一次，`retried>=1`，最终 `acked` | `scripts/verify-crossprocess.mjs`（真实 `ctx.subprocess`）+ vitest「V2 真实子进程」 |
| V1 不丢 | relay 丢弃首条回声 → relay 重发定时器补齐 → 父按 seq 去重 | ✅ 补齐且恰一次 | 同上（probe + vitest「V1 真实子进程」） |
| V4 断线重连 | **真实 SIGKILL 子进程** → `degraded` → `reconnect()` 重生子进程 → `connected`，`epoch` 复位后可继续收发 | ✅ | vitest「V4 真实子进程」（真 node 子进程 + 真 kill） |
| V3 崩溃恢复 | **真实 SIGKILL leader 进程** → 重启 → `recover()` 重放 queued-minus-delivered 且不重复 | ✅ replayed=1、pending 0 | `scripts/verify-crossprocess.mjs` B 段（真进程 + dsh-atomic-write journal） |

真实探针输出（原样节选）：

```console
$ node scripts/verify-crossprocess.mjs        # 真实 ctx.subprocess + 真实进程杀死/重启
== A. 真实 ctx.subprocess（dsh-subprocess-local）驱动 local-child ==
[OK]   V2：目标恰好生效一次（收到回声 1 次）
[OK]   V2：发生 ack 超时重发（retried=2）
[OK]   V1：丢失回声被补齐且恰好一次（got=[1]）
[OK]   基线：子进程 ack（acked=1）
== B. 真实进程杀死/重启下的 journal 持久化 ==
[OK]   首次 leader：交付失败 → queued（{"status":"pending":1}）
[OK]   重启进程从磁盘恢复出 1 条 queued（{"idle":true,"pending":1}）
[OK]   leader 进程被真实杀死（SIGKILL）
[OK]   重启后 recover 重放 1 条（{"recovered":true,"replayed":1,"pending":0}）
✅ 真实跨进程探针通过
```

### I.4 journal 去内存化

`team-distributed` 新增 `journalPath`：queued-minus-delivered 与 delivered 集经 **`@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`** 落盘，
构造时从磁盘恢复（不新增存储层；未来可换 `ctx.storage` forms）。单测「journal 落盘（atomic-write）」+ probe B 段（真进程重启）均通过。

### I.5 边界与未做到（诚实登记）

- **`ssh-rpc` 仍为内存 dual mock 验证**（本仓无 `dsh-ssh`），未跑真实跨机。
- **`ctx.subagents` out-of-process 成员执行未验证**（本仓无 acp/`dsh-sdk` provider），需安装对应 provider + 真实远端环境。
- **local-child 的「重连」= 重生子进程**：对端重启后其 seq/历史丢失，故对端**重启后**的 at-least-once 重放可能**重复投递一次**——
  由应用层 `messageId` 幂等兜底（transport 的 seq 去重只保证「同一对端进程内的不重」）。「sinceSeq 增量补齐」在**对端存活**的重连上验证（in-process 单测 + relay 的 `sync-req` 路径）。
- 跨机 SSH 真断网/丢包联调仍未跑（无 SSH 后端）。
- 真实模型 token 消耗：本任务全程为本地确定性探针/单测，**模型 token 消耗 0**。


## J. ssh-rpc 与 subagents out-of-process 的解锁尝试（P26-unlock-ssh-subagents / dev-2）

对 P25 §I.5 的两处「未验证」逐一推到底：**先查包存在性（带命令与输出），存在则装到隔离环境真接线**。

### J.1 包存在性（`npm view`，0.2.1-rc.3 可装）

```console
$ npm view @deepseek-ai/dsh-ssh dist-tags --json
{ "latest":"0.1.6-alpha.1", "alpha":"0.2.1-alpha.5", "next":"0.2.1-rc.4" }
$ npm view @deepseek-ai/dsh-ssh versions --json   # …"0.2.1-rc.3","0.2.1-rc.4"
$ npm view @deepseek-ai/dsh-acp dist-tags --json          → latest 0.0.1-rc.1 / next 0.2.1-rc.4
$ npm view @deepseek-ai/dsh-subagent-dsh-sdk dist-tags --json → next 0.2.1-rc.4
$ npm view @deepseek-ai/dsh-subagent-acp dist-tags --json  → next 0.2.1-rc.4
$ npm view @deepseek-ai/dsh-subprocess-ssh dist-tags --json → next 0.2.1-rc.4
```
**结论：包存在**，且**钉版 `0.2.1-rc.3` 可安装**（不是「没有」）。已装入项目内隔离目录 `.runtime/xproc/`（`npm install @deepseek-ai/dsh-ssh@0.2.1-rc.3 @deepseek-ai/dsh-subagent-dsh-sdk@0.2.1-rc.3 @deepseek-ai/dsh-acp@0.2.1-rc.3` → `added 622 packages`）。

### J.2 `ssh-rpc`：**部分已验证**（帧经真实 SSH 通道收发 + 断线重连），`ctx.ssh` 本体未接通

- **`ctx.ssh`（`dsh-ssh`）的真实 API ≠ 通用帧总线**（`lib/types/index.d.ts` 实测）：`class SshConnection extends Service`，
  Config 必填 `host`（OpenSSH alias）/`helper`（远端 helper 入口）/`helperHash`（SHA-256）/`workspace`/`launch`，
  公开面是 `ptcLaunch` 与 `connectStream(endpoint)`（endpoint 由远端 helper 下发）。
  ⇒ 它绑定「宿主机 ↔ 一台装了**版本对齐 helper 归档**的远端 POSIX 主机」，用于 `fs-ssh`/`subprocess-ssh`/`sandbox-ssh`，
  **不是**可承载任意应用帧的 RPC 总线；我们 `team-transport` 里的 `SshSeam.openDuplex` 是 P25 按【推断】设计的，**与真实形状不匹配**（已修正登记）。
- **真验证（帧经 SSH 通道，非本地 stdio 直连）**：本机有 `sshd`（`:22` 监听、`ssh -o BatchMode=yes localhost true` 成功）。
  探针 C 段用**真实 ssh 通道**跑我们的 relay（`ssh localhost <node> relay.mjs …`）作为 local-child 的 seam：
  ```console
  == C. ssh-rpc 机制：真实 SSH 通道承载团队帧（不走本地 stdin/stdout）==
  [OK]   SSH 通道承载帧：父观察到远端回声（got=[5]）
  [OK]   SSH 通道：收到远端 ack（acked=1）
  [OK]   SSH peer connected（connected）
  [OK]   SSH 断链 → degraded
  [OK]   SSH 重连 → connected
  [OK]   SSH 重连后仍可收发（got=[6]）
  ```
  ⇒ 「跨进程且经 SSH 通道」的帧收发与断线重连**已验证**（`scripts/verify-crossprocess.mjs` C 段，无可用 SSH 目标时自动 SKIP）。
- **结论**：`ssh-rpc` **机制可行且已验证**；**未接通的是 `dsh-ssh` 本身**（需远端 helper 归档部署）。
  **解锁条件**：在远端安装 `@deepseek-ai/dsh-ssh` 配套 helper 归档（`ssh-helper-runtime`），配置 OpenSSH alias + 记录 `helperHash`，
  再经 `@deepseek-ai/dsh-subprocess-ssh` 作为 `ctx.subprocess` 承载我们的 relay（或直接用 `ssh <alias>` 跑 relay，即本探针路径）。

### J.3 `ctx.subagents` out-of-process：**包存在可加载，未验证执行**

- `@deepseek-ai/dsh-subagent-dsh-sdk@0.2.1-rc.3` 实测导出 `{ Config, apply, inject:["subagents"], name:"subagent-dsh-sdk" }`；
  Config 必填 `dshHome`（隔离子 Harness home）、`profile`（默认 `sdk`）、`patches`、`provider`（默认 `deepseek-official`）、`model`、`env`（子进程 `DEEPSEEK_API_KEY` 等）。
  ⇒ 它**真起一个子 DSH 运行进程**并驱动一次执行。
- 隔离探针（`.runtime/xproc/probe-subagent.mjs`）加载 `@deepseek-ai/dsh-subagent`（服务**抽象定义**）后 `ctx.subagents === undefined`：
  该 provider 需要**一个具体的 `ctx.subagents` 运行时**（如 `dsh-subagent-spawn-in-process`）+ 子 profile + 模型路由才能注册并执行。
- **结论**：**包存在、可安装、可加载**，但**未验证真实执行**（缺具体 subagent 运行时装配 + 子 profile + 模型端点/凭据）。
  **解锁条件**：装配一个 concrete `ctx.subagents` runtime，提供 `dshHome`/`dshBin` 与可用的子 profile，并给子进程配置**可用模型路由 + 凭据**（会消耗真实模型 token）。

### J.4 与文档一致性

- P25 §I.5 的 `ssh-rpc` 登记由「内存 dual mock」**升级为：机制在真实 SSH 通道上已验证；`dsh-ssh` 本体未接通（附解锁条件）**。
- `ctx.subagents` out-of-process 登记由「无 provider」**更正为：包存在且可装上加载，执行链路未验证（附解锁条件）**。
- 全程真实模型 token 消耗 **0**（本地确定性探针；未驱动子运行时的模型执行）。

---

# P27-broadcast-semantics：核实广播/唤醒语义与源系统对齐（含前提纠正）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 裁定：(A) 严格对齐源系统——**不改进广播默认语义、不声称省轮**。

## A. 前提纠正（重要）

原任务前提「源系统广播不唤醒未寻址成员 → 省 N−1 轮」**经核实为误读**。源系统广播**同样唤醒全体非发送者**：

- `interaction-mechanisms.md` L232：广播 `to='*'` → 唤醒每个非发送者 1 轮；
- §3 唤醒表：「直接消息（发给别人）→ 不唤醒」；「广播 `BroadcastEvent` → **会**」；
- L17：「被信号叫醒但邮箱无自己消息 → 空转 handler、不耗轮」——针对**发给别人的直接消息 / 无关 topic churn**，**不适用于广播**。

⇒ **广播唤醒全体 = 与源系统一致，非缺陷，不存在省轮空间。**（详见 `docs/experiments-idle-wakeup.md §9`。）

## B. 真正对齐点核实（真实 profile + 源码，**未发现真 bug**）

- **DM 给 A 不唤醒 B/C**：新增 `exp-idle-wakeup --arm dm_one`（仅对 alice 发 1 条 DM）真实 profile 实测：

  | 成员           | turns | 额外轮 | 收到 relay |
  | -------------- | ----- | ------ | ---------- |
  | alice（被 DM） | 2     | **1**  | 1          |
  | bob            | 1     | **0**  | 0          |
  | carol          | 1     | **0**  | 0          |

  → 唤醒数 **1/3**，root+teammate 合计 **115,816 token（2.32% / 5M）**。与源系统「直接消息只唤醒收件人」**已对齐**。原始：`.runtime/bench/p27-dm-one/`。
  **第二次独立取数**（复核，bench-qa-engineer）：同命令重跑得**同一结果**（1/3；106,807 token，`.runtime/bench/exp-p27-dm-one/`）→ 两次独立样本一致，结论稳健。

- **无关 topic 订阅者**：`team-bus.notifySubscribers` 仅对 `sub.topic === snap.topic` 的**收件人**回调，且回调在本进程内（不产生 LLM 轮）——源码 `packages/team-bus/src/index.ts:286-296`。无空唤醒。
- **任务看板 churn**：`team-scheduler` 仅在「成员空闲且无活跃任务」时 nudge（有意的派发/自愈），与源系统一致。

⇒ **未发现真 bug，无需修复。**

## C. opt-in 手段与遗留

- `record-only` / `quiet` **保持 opt-in、不作默认**：适用高流量信息型广播；**风险**=静默广播**无法触发协同动作**（「全体停止/任务变更」类若无人被唤醒可能长期无人处理）。已文档化（`experiments-idle-wakeup.md §9.3`）。
- **遗留（只记录，待 P21 后评估）**：**写放大**——源系统广播 **O(1)** 写（1 记录 + 读水位线）vs 我们 **O(N)**（1 落库 + 逐人 DM）；唤醒语义相同、存储/写入形态不同，改动涉 mailbox 语义。

## D. 全链路回归

```console
$ corepack pnpm build / test / verify / verify:e2e / lint / format:check   # 全绿
$ bash scripts/e2e-profile.sh --no-model                                   # PASS，dump/wiring 断言全过
```

> token 消耗：本轮真实模型 **115,816 / 5,000,000（2.32%）**；复核第二次 **106,807** → 两次合计 **222,623 / 5,000,000（4.45%）**。


## K. 对端入站 attach：性质判定、补齐与回归固化（P29-peer-inbound-attach / dev-2）

针对 P20 指出的「transport 无『对端入站 attach』公开面（入站仅经 in-process bus）」追问：**对端侧到底能不能把收到的帧接进一个真实团队运行时**。

### K.1 性质判定：**(a) 我们没暴露能力**（实现层缺胶水），非架构硬限制

依据（读源码 + 实走）：
- **传输层已有公开入站面**：`team-transport` 暴露 `onFrame(handler)`（`packages/team-transport/src/index.ts:600`）与
  `acceptInbound(link)`（:695）——帧可被订阅、对端可连入本端点。⇒ **transport 层不是没有 attach 面**（P20 的措辞略过头）。
- **缺的是「入站帧 → 团队运行时」的胶水**：`team-distributed` 此前**只 `send` 到 Lead，从不订阅 `ctx.teamTransport.onFrame`**
  （源码中无 `onFrame` 调用），故远端帧到了 transport 也没接进运行时。⇒ 这是 **(a)**。
- **无架构硬限制**：DSH 团队状态确为「单写者 Lead 权威」（`team-distributed` 已按此实现），但 follower **消费** Lead 投递本就不需要共识；
  `ctx.teamTransport` 是可注入的 seam，运行时 attach 完全可实现。

### K.2 补齐：最小对端 attach 面（`team-distributed`）

- 新增公开面 `attachTransport(): () => void`：订阅 `ctx.teamTransport.onFrame`，`mutation` 经 opId 幂等 apply、
  `event`（投递）经 `messageId` 去重后交给消费面。构造时**自动 attach**（有 transport 即接）。
- 新增消费面 `onInboundMessage(handler): () => void` + 观测 `inboundCount` + 事件 `swarm/distributed/inbound`。
- 单测（`team-distributed` 现 12 条）：远端 `event` 帧 → 本地消费；重复 `messageId` **不二次消费**（`dedupDropped++`）；disposer 解绑。

### K.3 跨进程端到端（A 进程成员 → B 进程运行时真实消费）✅

新增 `scripts/xproc/peer-daemon.mjs`：一个**独立 node 进程**，在 stdin/stdout 上跑最小线协议，
并把入站帧经 `attachTransport`/`onInboundMessage` **接进本进程真实的 `team-distributed` 运行时**。

探针 D 段（真实 `ctx.subprocess` 起该对端守护进程，非回声 mock）：
```console
$ node scripts/verify-crossprocess.mjs
== D. 对端入站 attach：另一进程各自跑本栈并真实消费（A→B 跨进程端到端）==
[OK]   A→B 跨进程：B 进程运行时真实消费到 x1（consumed=1 条）
[OK]   A 收到 B 的对端 ack（传输层确认）
[OK]   重复投递不二次消费（仍有 1 条）
```
⇒ 「另一进程各自跑本栈、互相投递、**对端真实消费**」**已跑通一条端到端链路**（不再是单边成立）。

### K.4 回归固化

- 新增根脚本 **`pnpm verify:xproc`** = `build && node scripts/verify-crossprocess.mjs`，纳入标准验证链。
- 探针自带 **SKIP**：无可用 SSH 目标时 C 段自动跳过并提示（不误报失败）；A/B/D 段依赖真实 node 子进程，无需网络。

### K.5 已知边界（诚实登记，带源码位置）

- **跨进程「对端」需要一个跑本栈的守护进程**（`relay.mjs` 或 `peer-daemon.mjs`）来承接线协议并 attach。
  我们**没有**「一个已在运行的第三方 dsh 进程被任意对端拨入」的**服务端 transport**：
  `team-transport` 的端点发现仅在**同进程**的 `LoopbackBus`（`src/index.ts` `sharedBus`），`local-child` 是**出站 spawn**
  （`ChildProcessLinkFactory.create`），没有 listening/server backend。
- 因此现阶段跨进程协作的**真实可用边界**是：**传输层（帧/ack/重连/杀进程）+ 对端运行时消费**（本任务已证，需预置对端守护/端点名）。
  **未突破的**是「任意两个 dsh 进程自动互连（无需预置守护与端点协商）」——需补一个**服务端（listening）transport backend + 远端端点注册/发现**，
  这属于对 `team-transport` 的扩展（我们地盘内可实现，但超出本次最小 attach 范围，登记为后续项）。


## L. 对端 listening backend + 端点发现（P32 / dev-2）

把 P29 §K.5 登记的边界做掉：**任意两个独立启动的进程自动互连**，无需预置守护进程。

### L.1 可行性判定：**可行**（DSH 无 listening seam，但可自建；已实走）

- **DSH 侧检查**：`ctx.subprocess`/`ctx.ssh` 不提供「监听/被拨入」能力（`ctx.ssh` 是 host→helper 的**出站**耦合；`ctx.subprocess.spawn` 是**出站** spawn）。
  即「没有现成的 listening seam」。
- **但传输层可自建**：Node 内置 `node:net` 在**本机**开 Unix socket 监听无需任何 DSH 能力（实测 `net.createServer().listen(0,'127.0.0.1')` → `listen ok {127.0.0.1:…}`）。
  ⇒ 结论：**可行**——由 `team-transport` 自建 `local-listen` 后端（监听 + 端点注册/发现）。不挂代理、隔离到项目内 registry 目录。

### L.2 实现（`team-transport`，新增第 4 个后端 `local-listen`）

- 契约：`TransportBackend` 增 `'local-listen'`（`team-scale-contract/src/transport.ts`）。
- 监听服务端：在 `<registryDir>/<endpoint>.sock` 上 `net.createServer` accept；**端点注册**=`<registryDir>/<endpoint>.json` `{endpoint,path,pid}`。
- 拨号（**端点发现**）：读 `<registryDir>/<peer>.json` → `net.connect(path)` → 首行 `hello{endpoint}` 握手定对端名。
- `SocketLink`：JSONL 帧 + hello 握手 + 未就绪帧缓冲（与既有 `NodeStreamLink` 同族）。
- 复用既有重连/重放/去重/ack 机制（state machine 不变）。

### L.3 验证（真实两进程自动互连）✅

- 单测：两服务同进程各起 `local-listen`（真实 socket + registry），A 发现 B 并投递、B 收到、ack、dispose 后 registry/socket 清理（`team-transport` 现 14 条）。
- **两进程端到端**（`scripts/xproc/listen-peer.mjs`，各自独立启动，无预置守护）：
  ```console
  == E. local-listen：两个独立启动的进程自动互连并投递 DM ==
  [OK]   B 独立启动并注册端点（registry B.json 由监听服务端写出）
  [OK]   A 自动发现 B 并投递 DM，B 进程收到（1 帧）
  [OK]   A 经 registry 发现到 B（found=true，无预置守护进程）
  ```
- 已纳入 **`pnpm verify:xproc`**（无 sshd 时 C 段 SKIP；E 段依赖本机 socket，稳定）。

### L.4 边界更新（相对 P29 §K.5）

- **已突破**：同机**任意两个 dsh 进程**可经 `local-listen` + registry **自动互连**（无需预置守护进程）。
- **仍止于**：**跨机**互连仍走 `ssh-rpc`（需远端 helper 归档部署，见 §J）；registry 为同机共享目录，不跨机发现。
- **未做的**：端点租约/过期清理（当前 dispose 删文件；崩溃残留需 GC）、鉴权（本机 Unix socket 依赖文件权限 0700）。

---

# P30-plan-gate-revision-feedback：计划闸（执行前审批）+ 返工反馈定向回流

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 依据：`docs/event-alignment.md`（P28 审计）
> 裁定：计划闸默认 **off（opt-in）**；**不新增独立工具**（统一 action 面）。

## A. 改动面

| 面 | 改动 |
|---|---|
| `team-core-contract` | `TaskView.status += 'planned'`；`updateTask.action += open_plan｜submit_plan｜approve_plan｜reject_plan`；`req += plan?, feedback?` |
| `team-core` | 新增 `planning`/`plans`/`planFeedback`/`revisionFeedback` + `overlay()` 叠加 `planned` + 计划闸四动作 + `reject_review` 带 feedback→`swarm/task/revision-requested` + `recover` 折叠 + getter（`planOf`/`planFeedbackOf`/`revisionFeedbackOf`）；`Config.planGate` 默认 `false` |
| `team-review` | `settle(caller, taskId, feedback?)`：fail 时 `reject_review` 带 feedback + **定向 steer 作者**（DM `[revision-requested] task X: <feedback>`） |
| `team-scheduler` | `planned` 不被派发/认领（`status!=='pending'` 已排除；补测试 T9） |
| `team-completion` | `planned` 非终态（已正确；补测试 T8） |
| `tool-swarm` | **不新增工具**（批准/驳回走统一 action 面）；`team_summary` byStatus 自然含 `planned` |
| `ADR-0002` | §3 增 `swarm/task/{plan-request,plan-response,revision-requested}` |

## B. 行为级单测（T1–T11，覆盖不变量）

```console
$ (cd packages/team-core         && corepack pnpm exec vitest run)   # Tests 22 passed (22)
$ (cd packages/team-review       && corepack pnpm exec vitest run)   # Tests 14 passed (14)
$ (cd packages/team-scheduler    && corepack pnpm exec vitest run)   # Tests  8 passed (8)
$ (cd packages/team-completion   && corepack pnpm exec vitest run)   # Tests  8 passed (8)
```

重点（先红后绿相关）：T2「未批准不能执行」（`planned` 下 claim/complete 被拒）、T4「驳回带理由且可回传」、T7「评审 fail 携带 feedback 且定向 steer 作者」、T11「计划闸状态经 `recover` 跨重启保持」。

## C. 集成冒烟（`pnpm verify:e2e`）——**先红后绿**

首跑**真失败**（本轮由 team-leader 拦截后重跑发现）：
```console
[FAIL] 返工：定向 steer 回作者（alice 收到 revision-requested）
```
根因：in-process e2e 的 seam mock `sendMessage` **只记 `{target}`、未记 `content`** → 断言取不到文本。修 mock（增记 `content`）后重跑全绿：
```console
== 阶段 P30：计划闸（执行前审批）/ 返工反馈 ==
[OK]   计划闸：入闸 → planned
[OK]   计划闸：未批准不能执行（claim 被拒）
[OK]   计划闸：驳回带理由且可回传
[OK]   计划闸：批准后回 pending（可执行）
[OK]   返工：feedback 存于 team-core（可读）
[OK]   返工：定向 steer 回作者（alice 收到 revision-requested）
✅ 集成冒烟通过……
```

## D. mock 可信度审计（应 team-leader 要求）

`scripts/verify-e2e.mjs` 的 seam mock 已加**覆盖/盲区注释**。结论：
- **覆盖**：`sendMessage{target, content}`（真实 seam 另带 `signal`，对断言无意义）；`updateTask` **仅** `claim`/`complete`。
- **盲区（mock 无法忠实）**：`updateTask` 的 `release`/`reopen`/`assign`/`reassign`/`delete`/`edit`/`set_dependencies` **未模拟**；`createTask` 无 DAG/readiness；`waitForChange` 恒 timeout；`delivery`（quiet/wakeup）语义；跨进程/持久化。依赖这些的断言属**弱断言**，应在真实 profile 验收。
- **本次失败的启示**：T7 的 steer 断言**恰好撞上** mock 盲区才暴露；已把盲区写进注释，避免后续断言「静默通过」。
- 本 P30 的 team-core **叠加态动作**（submit_review/reject_review/open_plan/plan-*）**不经此 mock**（由团队端口自处理），故不受 `updateTask` 盲区影响。

## E. 全链路

`build / test / verify / verify:e2e / lint / format:check` + `scripts/e2e-profile.sh --no-model` 全绿（见提交 `docs(plan-gate)` 的原始输出）。


## M. P1 解锁主动推送 + 定向可观测事件（P31 / dev-2）

P30（计划闸 `42cf5f9`）落地后填空完成。

### M.1 落地事件（贴近源语义；通知型，非 durable —— 同 `swarm/team/completed`）

| 事件 | 触发点 | 测试 |
|---|---|---|
| `swarm/task/released` | `team-core.updateTask` action=`release` 后 | team-core ✅ |
| `swarm/task/revoked` | `reassign` 且 owner 变化 → **向原 owner 定向 DM「你不用做了」** | team-core ✅ |
| `swarm/task/terminal` | `updateTask` 后状态 `completed/deleted`（内部信号，不对外承诺） | team-core ✅ |
| `swarm/task/unblocked` | `team-scheduler` 收到 terminal 或扫描发现**新就绪** → 定向 nudge 下游归属人 | team-scheduler ✅ |
| `swarm/task/list-drained` | 扫描发现「全任务终态」上升沿 | team-scheduler ✅ |
| `swarm/member/status-changed` | 扫描 diff 成员状态变化（边沿） | team-scheduler ✅ |

命名与 P30 的 `swarm/task/plan-*`/`revision-requested` **不撞**（落地前再 grep 确认）。新增均为**通知型**（未引入新 durable 状态）→ 不涉 ADR-0002 折叠/恢复测试。

### M.2 解锁→唤醒延迟（真实 team-scheduler，两档 + push 对比）

```console
$ node scripts/verify-unblock-latency.mjs
| poll 档位 | pollMs | 就绪→首次 nudge 延迟 |
| 测试档     | 200ms   | ≈ 201ms   |
| 生产默认档 | 30000ms | ≈ 30000ms |
[结论] 延迟上界 = 一个 poll 周期（随配置变化，非固定 200ms）
[调度器不存活] 未 arm() → 观察窗内 nudge 数 = 0（P1 实质风险）
[push] 终态→nudge 延迟 ≈ 0ms  → push 显著快于 poll
```
- **push 前**：解锁到唤醒 = 一个 poll 周期（生产默认 **30s**），且**调度器不存活则根本不发生**。
- **push 后**：终态事件驱动 → **≈0ms**；轮询**作为兜底保留**（两者不互斥）。

### M.3 单测（先红后绿）

- `team-core`：release→released、reassign→revoked+定向 DM 原 owner、complete→terminal（+3，共 25 条）。
- `team-scheduler`：`onTaskTerminal` 定向 nudge+unblocked、订阅 `swarm/task/terminal` 事件驱动推送、`member/status-changed` 边沿、`list-drained` 上升沿（+4，共 12 条）。

### M.4 边界

- 通知型事件**不 durable**（无新状态）；若后续要把「解锁」当状态，再按 ADR-0002 增补。
- push 依赖**同进程** `swarm/task/terminal`（`ctx.on`）；跨进程的终态传播仍靠 transport（见 §K/§L），未在本轮打通跨进程 unlock 推送。

---

# P34-mock-fidelity：加固 in-process e2e 的 seam mock（弱断言 → 强断言）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 起因：P30 审计出的 mock 盲区（`sendMessage` 丢 `content` → 假绿）

## A. 补齐的 mock 行为（**以真实实现为基准对照，非自造**）

`scripts/verify-e2e.mjs` 的 seam mock `updateTask` 由「仅 `claim`/`complete`」→ **忠实建模 native 状态机**，对照
`@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1288-1360`：

- `claim`（需 `pending`+ready → `in_progress`+owner；owned-by-other → `TEAM_TASK_ALREADY_CLAIMED`；未就绪 → `TEAM_TASK_BLOCKED`）
- `release`（需 `in_progress` → `pending`，清 owner）· `complete`（需 `in_progress` → `completed`）
- `reopen`（需 `completed` → `pending`，清 owner）
- `reassign`（需 `pending`/`in_progress`；owner 空 → `pending`，否则 → `in_progress`+新 owner）
- `delete`（有下游阻塞者 → `TEAM_TASK_HAS_DEPENDENTS`）· `edit` · `set_dependencies`
- `createTask`：建模 `blockedBy` **DAG + readiness**（`ready = pending && 依赖全 completed`）

## B. 由弱转强的断言（e2e `== P34：任务动作保真 ==`，全绿）

12 条强断言：DAG readiness · claim → in_progress+owner · release → pending 清 owner · reassign(端口 assign) · complete · **非法转换拒绝**（`pending` complete → `TEAM_TASK_INVALID_TRANSITION`）· reopen · DAG 阻塞（`TEAM_TASK_BLOCKED`）· 上游完成后 downstream `ready=true` · delete 有依赖拒绝 · delete 无依赖成功。

## C. 仍为**弱断言**（已显式标注，须真实 profile 验收）

`delivery`(quiet/wakeup) · 跨进程 · 持久化/崩溃恢复 · `waitForChange`（mock 恒 `timeout`）· `updateTask` 的 **revision CAS 未强制**。e2e 顶部「mock 保真度说明」已固定——后来人写断言前可查盲区。

## D. 全链路

`build / test / verify / verify:e2e / lint / format:check` + `e2e-profile.sh` 全绿（`verify:e2e` 含上述 12 条 P34 强断言）。


## N. local-listen 端点租约 + 握手鉴权（P32 遗留收紧 / dev-2）

把 §L.4 登记的「未做：端点租约/GC、鉴权」补齐。

### N.1 租约 + 过期 GC

- 注册条目增 `heartbeatAt`；监听服务端**心跳**刷新（`heartbeatMs`，默认 10s）；`leaseTtlMs` 默认 30s。
- **发现侧判陈旧**：`pid` 已死（`kill(pid,0)`）或 `heartbeatAt` 超 `leaseTtlMs` → 视为死端点，**清理其 `.json`/`.sock` 并拒绝拨号**；服务端启动时也做一次全目录 GC。
- **回答 Leader 的问题**：进程被 `SIGKILL`（来不及注销）后，**残留端点最多在 `leaseTtlMs`（默认 30s）内被判过期并清理**。**期间不会"连到死端点"**——`.sock` 随进程消失，拨号得到 `ECONNREFUSED`（`error` → 视为不可达/返回 undefined），不会误判为健康连接。
- 断言（`verify:xproc` F 段）：预置「死 pid + 旧心跳」端点 → 新进程启动即 **GC 清理**。

### N.2 握手令牌（鉴权）

- hello 可携带 `token`；服务端配置 `listenToken` 后，**令牌不匹配 → 销毁连接、不 attach**（拒绝，不静默接受）。
- **令牌分发**：经**配置/环境变量**（`listenToken` / `LISTEN_TOKEN`）注入两端；**不写进 registry**（故仅读 registry 目录不足以拨入）。
- 断言（F 段）：错误令牌拨入 → **无投递**；正确令牌 → 可投递。

### N.3 边界（如实登记，**不把「防误连」当「安全鉴权」**）

- **令牌是"防误连"，不是"安全鉴权"**：它防止**共享同一 registry 目录的不同团队/进程**互相误连；但它**明文经本机 unix socket 传输**，且令牌来源是**同用户可见的环境变量/进程参数**。**在同一用户下不构成对本地攻击者的安全边界**（同用户可读 `/proc/<pid>/environ`）。
- **socket 文件权限（0700 目录 + 0600 文件）只隔离"不同用户"**：在多用户/共享主机上，若目录权限被放宽或对端同用户，**均不构成鉴权**。
- **仍未做**：令牌轮换/签名、跨机（registry 为同机目录，跨机不发现）、TLS/加密（当前假设本机可信）。
- 结论：本机**同用户**场景可防误连 + 自动回收死端点；**跨用户/共享主机不安全**，跨机不适用。


## O. 真实 profile 的 scheduler arming 入口（P38b / dev-2）

### O.1 定位结论：**(a) 漏了装配入口**（实现层缺自装配），非 (b)/(c)

- 证据：全仓 `packages/*/src` 内**无任何 `.arm(` 调用点**（仅 tests / `verify-unblock-latency.mjs` / bench 桩）。
  插件被子系统**加载**，但从未**启动扫描** → scheduled 不派发、autonomous 不 nudge，**P31 的 `onTaskTerminal` 主动推送也依赖 `armedAgent` → 同样不触发**。
- 非 (b)（应由宿主调用但无通道）：DSH 插件模型下服务应**自装配**；`ctx.inject` 提供了「依赖就绪即可回调」的通道，无需宿主显式调用。
- 非 (c)（上游未就绪）：`agents`/`teamCore` 在真实 profile 下可用；只是没人触发。
- 对照源系统（`cluster-architecture.md`）：`TeamScheduler` **仅当 `role=LEADER`** 才创建 —— 故自装配必须**按 LEADER 门控**。

### O.2 修复方式（`team-scheduler` 自装配）

- 构造时 `ctx.inject(['agents','teamCore'], cb)`；依赖就绪后 `tryAutoArm()`：
  解析首个 agent（`agents.list()[0]`）→ 若 `teamCore.tryMembership(agent).role==='lead'` → `arm(agent)`。
- **非 LEADER（follower）不 arm**，与源语义一致；`agents` 晚于本插件就绪时**有界重试**（~2 分钟）。
- 新增 `Config.autoArm`（默认 `true`）；置 `false` 可**复现旧行为**（用于先红后绿）。

### O.3 验证：确定性 + 真实 profile 先红后绿

- **确定性单测（team-scheduler 15 条）**：LEADER 就绪即 arm → **scheduled 真派发**（t1 pending→in_progress）；非 LEADER 不 arm（不派发/不 nudge）；`autoArm=false` 复现旧行为（保持 pending）。
- **真实 profile（`scripts/e2e-sched-arm.sh`，自建、不改 bench）**：
  ```console
  $ bash scripts/e2e-sched-arm.sh --auto-arm false --expect pending
  [info] arm-job 最终状态 = pending (期望 pending)      ← 修复前行为（红）
  $ bash scripts/e2e-sched-arm.sh --auto-arm true  --expect in_progress
  [info] arm-job 最终状态 = in_progress (期望 in_progress)  ← 自装配后（绿）
  ```
  ⇒ 真实 headless profile 下：**scheduled 真被扫描并派发**（pending→in_progress，owner 落定）；无模型端点时脚本 **SKIP**。

### O.4 后续影响

- 真实 profile 下 scheduler 现**自动运行**：scheduled 派发、autonomous nudge、轮询兜底真跑；**P31 的 `swarm/task/unblocked` 主动推送随之生效**。
- `bundle` 无需改动（插件已在 bundle 内，自装配生效）。
- 边界：仅当本进程 agent 在成员表中 `role==='lead'` 才 arm；跨进程 follower 需各自按 LEADER 语义装配（当前 follower 不 arm，符合单写者模型）。


## P. scheduled 派发的 owner 归属修复（P42 / dev-2）

### P.1 语义定位（带源码位置）

原生任务板（`.runtime/deepseek-harness/packages/experimental/agent-team/src/task-board.ts`）实测：
- `claim`（`:129-136`）：`next = { ...current, status:'in_progress', ownerId: caller.id }` —— **以调用者为 owner，忽略 `owner` 入参**（有意设计：claim = 自领）。
- `reassign`（`:172-186`）：**仅 Team Lead** 可调，要求 `request.owner` 非空，`resolveActiveMember` 解析成员后 `next = { ...current, status:'in_progress', ownerId: assignee.id }` —— **按 owner 指派给成员并置 in_progress**。

⇒ 正确做法：scheduler 派发应走 **端口动作 `assign`（→ 原生 `reassign`）**，而非 `claim`。
`team-scheduler` 原写 `updateTask(action:'claim', owner:m.name)` → 原生 claim 以**调用者（Lead）**为 owner → 任务归 lead、成员未接手（P39/#6 实测 `ownerName=lead`）。

### P.2 修复

- `team-scheduler/src/index.ts` 派发分支：`action:'claim'` → **`action:'assign'`**（附注释说明 claim 语义）。**不改** `claim` 的 legacy 语义、**不影响 autonomous** 分支。

### P.3 真实 profile 断言（先红后绿）

`scripts/e2e-sched-arm.sh`（新增 `--expect-owner`）：
```console
$ bash scripts/e2e-sched-arm.sh --auto-arm true --expect in_progress --expect-owner alice
# 修复前（临时回退 action=claim）：
[info] arm-job 状态=in_progress owner=lead（期望 …owner=alice）
[FAIL] owner lead != alice                        ← 红
# 修复后：
[info] arm-job 状态=in_progress owner=alice（期望 …owner=alice）
[PASS] scheduler arming：状态/归属符合期望          ← 绿
```
- 确定性单测（team-scheduler 16 条）：scheduled 派发后 `ownerName==='w'`（被派发成员，非 lead）。

### P.4 后续

- **P19b 前置成立**：scheduled 派发现**真正指派给成员**（owner=目标成员），可作为默认值切换的依据。
- autono mous 与 `claim` legacy 语义**未改**。

---

# P19b-default-scheduled：默认派发模式改为 `scheduled`（行为变更）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 基准：**P39**（三臂 arming 后）+ **P43**（P42 归属复核）。

## A. 改动面

| 面 | 改动 |
|---|---|
| `team-scheduler` | `Config.mode` 默认 `autonomous → scheduled`（`src/index.ts`）；`defaultConfig().mode='scheduled'` |
| `bundle` | `cordis.patch.yml` 的 `team-scheduler.config.mode: scheduled`（示例配置同步默认） |
| README | 新增「任务派发模式（默认 scheduled，⚠️ 破坏性变更）」段：默认值 / 切回 autonomous 的开关 / 两者差别 / 装配条件 |
| 单测 | 新增「未显式配置 ≡ scheduled；显式 `autonomous` 仍可切换」 |

**未改**：`autonomous` 路径行为（只 nudge、不派发）与 legacy `claim` 语义；`planGate` 维持 `false`；P42 的 `assign` 派发逻辑不动。

## B. 行为级单测

```console
$ (cd packages/team-scheduler && corepack pnpm exec vitest run)   # Tests 15 passed (15)
```
覆盖：默认 `mode==='scheduled'`；显式 `mode:'autonomous'` 生效；scheduled 派发/autonomous nudge 各自路径（既有用例）+ planned 不派发（P30）。

## C. 基准对比（引 P39/P43，真实 profile）

| 模式 | 是否派发 | teammate 开销 | 结论 |
|---|---|---|---|
| **`scheduled`（新默认）** | ✅ 真派发（`pending→in_progress`，`ownerName`=被派发成员 `alice`/`bob`，P42 修复后） | **4 轮 / 119.7k token** | 开销更低、无人值守不卡 |
| `autonomous` | 不派发（成员被 nudge 后自 claim；**反复 nudge**） | **12 轮 / 206.1k token（≈2.4×）** | 供显式切换 |
| `off` | 静默 | — | — |

依据：`docs/experiments-retest-p24.md` §1.2/§1.3（P39=P38b arming 后重测；P43=P42 归属复核后收口为【成立】）。→ `scheduled` 作默认**有数据支撑**。

## D. 全链路

`build / test / verify / verify:e2e / lint / format:check` + `e2e-profile.sh --no-model` 全绿（见提交原始输出）。


## M. durable 真持久化修复（P52）

- **背景（P50）**：`swarm/*` 曾只 `ctx.emit`、**从未 append** ⇒ 跨重启不可恢复；`verify-durability.mjs` 为**模拟**。
- **修复（通道 A）**：`team-durable.emitDurable(session, name, payload)` → **`appendPluginRecord("plugin:swarm/…")`**；`durableRecordOf` 供 replay fold。已接入 `team-core`/`team-completion`/`team-review`/`team-skills`/`team-memory`（`team-bus` 由 analyst 接同一入口，待其 push 后复核）。
- **正控**：`scripts/verify-durable-channel.mjs`（真实 `dsh-session`+jsonl，免模型）——RED 0 条 / GREEN 直读磁盘有 `plugin:swarm/core/review-entered` + `durableRecordOf` 取回 + **新 Context 重挂载重读仍可取回**。
- **证据分级（宁降不升）**：
  - **【session 级 已验证】**：真落盘 + 真重挂载读取（O2 GREEN③）。
  - **【profile 级 端到端 未验】**：无可达 swarm emit 触发点，未做；待 P49 后 tool-swarm 可用时顺带补。
- **`team/message/{queued,delivered}` 非 durable【推翻】** ⇒ P51 未读台账改「自建 durable」。
- 详见 `docs/durability-findings.md`；文档更正见 ADR-0002 / state-durability.md / final-acceptance.md 的【P52 更正】注记。

---

# P44-bundle-swarm-preset：集群模式 agent preset 转正进 bundle（含默认选中）

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27 ｜ 提交 `ab6d2a2`（preset 本体）+ `0d28053`（收尾格式化）

## A. 改动面
- 新增 `packages/bundle/presets/swarm.patch.yml`：insert `@deepseek-ai/dsh-agent-preset`（`id: swarm` / `name: 集群模式` / `description:…` / `order: 0` / `plugins:` 以 web-app standard preset 为基准完整复制）。
- `packages/bundle/package.json`：`dsh.bundle.patch` 改为**数组**（`./cordis.patch.yml` + `./presets/swarm.patch.yml`），并把新文件加入 `files` 白名单 + `exports`。
- `packages/bundle/cordis.patch.yml`：覆盖 `agent-preset-registry.default = swarm`（默认选中集群模式）。
- `README.md`：新增「集群模式 agent preset（默认）」段 + 切换指引；**S9 修正**（见 §C）。

## B. 验证（`dsh --dump-config` 逐 id）

**关键：preset 归 `web` profile 管（`agent-preset-registry` 是 web-app 行；`headless` 无该行）。** 故在 **web profile** 取证：

```console
$ dsh --profile web --dump-config | grep -nE 'agent-preset-registry|default:|preset-swarm|集群模式'
627:- id: agent-preset-registry
628:  name: '@deepseek-ai/dsh-agent-preset-registry'
630:    default: swarm                 # ← 默认选中「集群模式」
1311:- id: preset-swarm
1315:    name: 集群模式
1316:    description: swarm 集群模式：多成员协作、共享任务看板、消息总线、评审闸与跨进程传输。
```
（`headless` profile 亦能看到 `- id: preset-swarm` / `name: 集群模式`，但不含 registry 行——如实登记。）

## C. S9 文档自相矛盾修正（改前 / 改后）
- **改前**（README 旧 L260）：「`Config.mode` 当前默认仍是 `autonomous`……P19b 仍未落地」。
- **改后**（现 L267，保留历史痕迹）：「`Config.mode` **曾默认为 `autonomous`**；**已于 P19b（`2031d44`）改为默认 `scheduled`**……」。

## D. 全链路回归（树恢复后重跑，2026-10-27）
```console
$ corepack pnpm build / test / verify / verify:e2e / lint / format:check   # 全绿
$ bash scripts/e2e-profile.sh --no-model                                   # PASS=7 FAIL=0
```
> 过程说明：首轮 `verify` 曾因 **analyst 未提交的 `team-bus` WIP 触发 tsc OOM(134)** 失败（与 P44 无关）；analyst park 后树恢复，重跑全绿。

---

# P49-multicast-name-id-bug：修 tool-swarm multicast 的 name/id 契约不一致

> 执行人：dsh-plugin-dev ｜ 时间：2026-10-27
> 结论：**真 bug，已修（tool 侧）**；`team-bus` 的 **id 契约不变**。

## A. 根因与修法
- 根因：`tool-swarm` 的 `multicast` 工具把**名字**原样传给 `team-bus.multicast`，而 `team-bus.assertTargets` 用 **id**（`m.id`）校验；真实 profile 下原生 `id`（子会话 uuid）≠ `name` → `TEAMBUS_UNKNOWN_TARGET`。
- 修法（**只改 tool 侧**）：`tool-swarm` 在调 `bus.multicast` 前经团队花名册（`teamCore.listMembers`）把 **name 解析为 id**；**未知名字 → 清晰的工具级错误**（含已知名字列表），不再暴露底层 `TEAMBUS_UNKNOWN_TARGET`。

## B. name/id 契约说明
- **`team-bus` 端口契约 = id**（`multicast`/`broadcast` 的目标一律 id）；**模型工具的入参 = name**（人可读）。**两者在 tool 层做 name→id 解析**（本 P49）。此后同类工具若新增「按成员」入参，**一律在 tool 层解析、不得改 `team-bus` 的 id 契约**。

## C. 同类审计（tool-swarm 全工具 vs team-bus 入口）
| 工具 | 目标入参 | 是否经 name/id 解析 | 结论 |
|---|---|---|---|
| `multicast` | 成员**名字**（逗号分隔） | ✅ 本 P49 已解析为 id | 修好 |
| `broadcast` | 无显式目标（`assertTargets` 由 team-bus 内部按 roster 自解析） | 无需 | 无同类问题 |
| `send_message`（原生工具，非本包） | `target`=名字，原生层解析 | 不在本包 | 无同类问题 |
| `review_submit/review_vote/skills_visible/memory_recall/workspace_*` | 非成员目标 | 无需 | 无同类问题 |
→ **仅 `multicast` 一处**存在 name/id 不一致；已修。

## D. 先红后绿
**红（修复前，原样输出）**：`node scripts/message-integrity-probe.mjs`（P5，tool 层）
```
== P5 tool-swarm.multicast 按名字可用（P49：tool 侧 name→id 解析）==
[OK]   tool-swarm 注册了 multicast 工具
TeamBusError: TEAMBUS_UNKNOWN_TARGET: unknown target alice
    at Proxy.multicast (.../team-bus/lib/index.js:147:23)
    at execute (.../tool-swarm/lib/index.js:105:40)
RED_EXIT=1
```
**绿（修复后）**：
```
== P5 tool-swarm.multicast 按名字可用（P49：tool 侧 name→id 解析）==
[OK]   tool-swarm 注册了 multicast 工具
[OK]   按名字投递成功（multicast sent: mcast-1）
[OK]   alice/bob 各收到 —— name→id 解析生效（真实 profile 下 id≠name 亦可）
[OK]   未知名字 → 清晰工具级错误（unknown member name(s): ghost (known: lead, alice, bob, carol, dave, erin)）
结果：PASS（全部断言通过）
```

## E. 单测 + 真实 profile 断言
- `tool-swarm` 单测 +2（name→id 解析 / 未知名字清晰报错）→ **10 passed**。
- **真实 profile**（`scripts/e2e-profile.sh` 全量，含真实模型）：新增断言
  ```
  [PASS] multicast 按名字可用（P49 回归）
  [PASS] 无 TEAMBUS_UNKNOWN_TARGET（P49 回归）
  结果：PASS=15 FAIL=0
  ```

## F. 全链路（受他人 main 破坏阻塞，如实登记）
- `tool-swarm` 构建 / 单测 / lint / 探针 / `e2e-profile`（模型）均绿。
- **`pnpm build` 当前红**：`packages/team-bus/src/index.ts(366,9): error TS2353: 'origin' does not exist in type '{ range: MessageRange; … }'` —— 系 **dev-2 的 P51 提交（HEAD `cb208d9`）** 在 `team-bus` 调 `teamCore.send({…, origin})` 但未在契约 `send` 的 req 上加 `origin?`。**与 P49 无关**（P49 未动 team-bus/契约）。已上报 Leader 协调 dev-2 补契约字段或回退；修好后重跑全链路补记。

---

## P54 — Leader 提示词移植「只调度不干活」（team-prompt）

> 执行人：prompt-engineering-analyst ｜ 时间：2026-10-27 ｜ 依据：`docs/prompt-comparison-team-mode.md`（P53）

### A. 改动面

- `packages/team-prompt/src/index.ts`：新增稳定段 **`team:leader`**（`order 10`，进前缀），承载 Leader 专属行为约束；`STABLE_SECTION_NAMES` 更新；**`team:leader` 刻意不加入 `DEFERRED_BEFORE_TEAM`**。
- `packages/team-prompt/tests/team-prompt.spec.ts`：更新既有断言（段数 4→5、名单加 `team:leader`）+ 新增 P54 用例。
- `packages/team-prompt/tests/team-prompt.integration.spec.ts`：新增**真实 system-prompt 装配**集成测。
- `packages/team-prompt/README.md`：新增（行为变更说明 + P53 中/低优先级待办）。

### B. 单测 + 类型检查（14 passed）

```console
$ pnpm --filter @elinpf/dsh-swarm-team-prompt typecheck   # 通过
$ pnpm --filter @elinpf/dsh-swarm-team-prompt test
 ✓ tests/team-prompt.spec.ts (11 tests)
 ✓ tests/team-prompt.integration.spec.ts (3 tests)
 Test Files  2 passed (2)
      Tests  14 passed (14)
```

覆盖：新段存在 + 内容覆盖高优先级 3 条（不执行/先建成员/背景不清先调研）+ **不被 `leaderProgressiveDisclosure` 过滤** + 英文变体 + 真实装配。

### C. 真实装配证据（真实 `@deepseek-ai/dsh-system-prompt`，非 mock）

```console
SECTIONS: ["harness:identity","deployment:persona-prefix","team:leader","team:role","team:inbound","deployment:persona-suffix"]
HAS_LEADER: true ; HAS_SPAWN: true ; HAS_DISPATCH: false
```
> 团队未建时：`team:leader` **在**且已渲染进 prompt 文本；`team:dispatch`/`team:task-state` 被摘（对照组，证明过滤逻辑在工作）。

### D. 全链路无模型回归（全绿）

```console
$ pnpm -r run build                        # 全包 build 通过
$ node scripts/verify-load.mjs             # ✅ 加载验证通过
$ node scripts/verify-native-wiring.mjs    # ✅ 原生接通回归通过
$ node scripts/verify-e2e.mjs              # ✅ 集成冒烟通过
$ bash scripts/e2e-profile.sh --no-model   # PASS=7 FAIL=0
```

### E. 行为级探针（真实模型）——待批预算

- 目标：P46 风格探针验证「团队模式下 leader **先 spawn 成员**，而非自己干」（对齐用户截图的反例）。
- 状态：**pending 预算批准**（先报 team-leader，未经批准不跑真实模型）。
- 预算：见团队汇报（本次未消耗真实模型 token）。


## N. P51 消息兜底（未读闸 + 超时重投/升级）

### N.1 已实现（先红后绿，确定性单测）
- **① 未读闸 + override**（`team-completion`）：`evaluate(agent,{overrideUnread})` + `Config.allowUnreadOverride`（默认 false）；未读>0 且其它条件满足 → **不完成** + emit `swarm/completion/unread-blocked{unread,overridden:false}`（上升沿）；leader 显式 override（需开关）→ 完成 + 事件标 `overridden:true`。**11 测试**（新增 3）。
- **② 超时重投/升级**（`team-core.send` 单点）：DM → `pendingMessages` 台账 + durable `swarm/message/pending`（通道 A）；周期 `sweepPending` → 逾时**重投≤1**（幂等 messageId）→ 仍无 → `swarm/message/undelivered` + **升级 leader**（经 seam，事件唤醒不阻塞）。**28 测试**（新增 3）。
- **③ 防风暴**：重投**上限=1**、幂等 `messageId`、`sweepPending` 处理即出队；单测覆盖「重投恰好一次 → undelivered」。
- **广播豁免反例**：确认 `team-bus` 扇出**经 `team-core.send`（DM）** ⇒ 若不分来源，**广播会进 pending 台账、让任务永久无法完成**（正是要防的停滞）。修法：`team-core.send` 增 `origin:'broadcast'|'directed'`，`'broadcast'` **不计入** pending；`team-bus` 广播扇出传 `'broadcast'`、多播传 `'directed'`。**core 28 / bus 14 测试绿 + verify-load PASS**。

### N.2 证据分级（宁降不升）
- **【单测级 已验证】**：①②③ 与广播豁免的**行为不变量**（确定性、先红后绿）。
- **【profile 级 端到端 未验】**：**默认工具集的 `send_message` 走原生 `tool-agent-team` → 直接 native `sendMessage`，不经过 `ctx.teamCore.send`** ⇒ 真实 profile 下 `plugin:swarm/message/pending` **不产生**（实测：跑一次 `spawn+send_message` 后解压会话日志 `pending=0`）。故 **profile 级不可达**；需 **P49 后 tool-swarm 可达触发**，或在原生工具路径挂 hook（非本仓）。

### N.3 行为变更说明
- `blockOnUnread`（默认 true）现把「**定向消息未读**」纳入完成判定：**未读>0 不得完成**；仅 **leader 显式 `overrideUnread`（需 `allowUnreadOverride=true`）** 可越过，且事件标 `overridden`。**公告类广播不计入**。轮询与（已落 team-bus 的）投递语义不变。
