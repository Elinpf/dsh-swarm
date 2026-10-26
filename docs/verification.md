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
