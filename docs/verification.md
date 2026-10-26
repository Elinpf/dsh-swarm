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

> @dsh-swarm/example-plugin@0.0.1 build .../packages/example-plugin
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

> @dsh-swarm/example-plugin@0.0.1 test .../packages/example-plugin
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
== @dsh-swarm/team-core-contract ==   [OK] 纯类型包：运行时零导出（无实现）
== @dsh-swarm/example-plugin ==       [OK] 观察到工具 greet / section example-plugin:guide / fiber DISPOSED
== @dsh-swarm/team-bus ==             [OK] 观察到服务 ctx.teamBus；卸载后消失
== @dsh-swarm/team-prompt ==          [OK] 观察到 section team:role/team:inbound；卸载后归零
== @dsh-swarm/team-scheduler ==       [OK] 观察到服务 ctx.teamScheduler；卸载后消失
== @dsh-swarm/team-review ==          [OK] 观察到服务 ctx.teamReview；卸载后消失
== @dsh-swarm/team-completion ==      [OK] 观察到服务 ctx.teamCompletion；卸载后消失
== @dsh-swarm/tool-swarm ==           [OK] 观察到 broadcast/multicast/review_submit/review_vote/team_summary；卸载后归零

✅ 加载验证通过：全部插件可被真实 cordis 运行时加载并观察到预期行为。
```

## C. 实现期发现的两条真实契约细节

1. **`defineTool` 的 value schema：可选参必须「省略」`required`**，写 `required: false` 会抛 `parameterSchemaSpecToJsonSchema` 错误（`required` 只接受 `true`）；可选即不写。这与「对象层不接受 `required`」是同一 DSL 约束的两面。
2. **Service 形态插件经 `ctx.plugin()` 加载时要传 `mod.default`**：功能式插件（命名 `apply`）可直接传 ESM namespace，但 Service 的入口在 `default` 导出上，传 namespace 会报 `invalid plugin ... received object`。
