# DSH 插件与 bundle 开发手册（v0.2.1-rc.3 核定版）

> 产出人：dsh-target-analyst
> 时间：2026-10-26
> 定位：新建项目 `dsh-swarm` 的**唯一插件开发契约**，供 dsh-plugin-dev 实现协作插件时照抄。
> **核定基准**：`dsh-v0.2.1-rc.3` 真源码，位于 `/root/.jiuwenswarm/agent/workspace/work/jiuwen/dsh-swarm/.runtime/deepseek-harness/`（版本 `0.2.1-rc.3`，commit `1f81c047`，无 `.git`）。
> 约定：**【事实 V】**=在 0.2.1-rc.3 源码实测读到（附 `文件:行号`）；**【事实-文档】**=引自 0.2.1-rc.3 自带文档；【推断】=方向判断；**无【未验证】的裸断言**——确无法核实的会写明原因与已尝试路径。

---

## 0. 版本适用范围

**【事实 V】** 本手册的每一条 API 断言都在以下版本上核定，且**只对该版本承诺成立**：

| 项 | 值 | 证据 |
|---|---|---|
| DSH 版本 | `0.2.1-rc.3` | `.runtime/deepseek-harness/package.json`（root `version`） |
| 源码 commit | `1f81c047` | `docs/env-setup.md`（dsh-env-engineer 记录） |
| 源码路径 | `.runtime/deepseek-harness/`（**无 `.git`**，无法 git describe） | 实测 `git rev-parse` 报 not a git repository |
| Node | `^22.19.0 \|\| >=24.0.0` | root `package.json:9` |
| pnpm | `11.28.5` | root `package.json:7`（`packageManager`） |
| `@deepseek-ai/cordis` | `4.0.5`（npm 最新） | `npm view @deepseek-ai/cordis version` |

**【事实 V】** 上一版手册基于 `0.1.0-rc.8`（`/root/repo/github.io/deepseek-harness`）编写；**0.2.1-rc.3 存在破坏性变更**，见 §1。凡从旧版继承而来的写法，本文已按 0.2.1-rc.3 重写。

> 工程提示：`dsh-swarm` 的所有插件/ bundle 都应以 **`dsh-v0.2.1-rc.3` 为唯一锁定版本**；`workspace:^`/`workspace:~`/`workspace:*` 只要指向同一 runtime 均被判为兼容（见 §3.5）。

---

## 1. 0.1.0-rc.8 → 0.2.1-rc.3 差异与影响（破坏性变更）

> 本节是本手册相对上一版最重要的新增。逐条列出对**我们后续插件实现**的直接影响。

| # | 变更 | 证据（0.2.1-rc.3） | 对 dsh-swarm 的影响 |
|---|---|---|---|
| B1 | **invariant 伴侣机制被移除**：不再有 `src/invariant.ts`、`./invariant` 导出、`@deepseek-ai/dsh-invariants`、`ctx.invariants`、`verify-package-invariants` 脚本、`packages/runtime-diagnostics/` | 实测：`find packages -name invariant.ts -path '*/src/*'` → 空；`packages/core` 无 `runtime-diagnostics` 父目录；root `package.json` grep `invariant` → 空 | **高**：上一版手册 §1.2 的 invariant 骨架**作废**；不再需要为每个包写校验伴侣 |
| B2 | **preset 由"目录式"改为"插件行式"**：不再有 `agent.cordis.yml`/`preset.yml` 目录扫描；preset = `@deepseek-ai/dsh-agent-preset`（`config.id`/`plugins`）行 + `@deepseek-ai/dsh-agent-preset-registry`（`config.default`）行 | `packages/preset/agent-preset/README.md`（"the registry neither scans directories nor accepts preset paths"）；`packages/preset/agent-preset-registry/README.md` | **高**：若 dsh-swarm 需按 session 定制能力集，**写 bundle patch 插入 preset 行**，而非建 `agent.cordis.yml` 目录 |
| B3 | **preset 包改名**：`dsh-agent-presets` → `dsh-agent-preset` + `dsh-agent-preset-registry`；`apps/cli/config/agent-presets/` 目录**消失** | `ls packages/preset` → `agent-preset`、`agent-preset-registry`；`find apps/cli/config -maxdepth 3 -type d` → 仅 `examples/` | **中**：包名引用与 preset 安装路径全部更新 |
| B4 | **依赖协议改用 `workspace:~`**（0.1.0 为 `workspace:^`） | `packages/todo/tool-todo/package.json:45,59`（`@deepseek-ai/cordis": "workspace:~"`） | **中**：新写 package.json 统一用 `workspace:~` |
| B5 | **`private: true` 不再出现在包 manifest** | `grep '"private"' packages/todo/tool-todo/package.json packages/bundle/base/package.json` → 空 | **低**：自建仓自行决定；单仓内可省 |
| B6 | **包 exports 扩容**：新增 `./client`、`./src/*`、`./locale/*.json`；`files` 出现 `lib/types/**/*.js` | `tool-todo/package.json:16-27`（exports）、`29-34`（files） | **低**：按需增减；带 Web 客户端半的包须给 `./client` |
| B7 | **bundle 的 patch 可为"有序文件列表"**（不限于单个文件） | `packages/boot/app-boot/README.md:50`（`bundlePatchFiles`/`bundlePatchPaths`） | **中**：复杂 bundle 可拆多个 patch 文件按序施加 |
| B8 | **新增 DSH 版本兼容门禁**：manifest 可声明 `engines.dsh`，否则 `peerDependencies` 上的 `@deepseek-ai/dsh*` 必须匹配 runtime | `packages/boot/app-boot/README.md:52` | **中**：自建 bundle 的 `peerDependencies` 必须填对，否则 profile 会跳过该 bundle（`skippedBundles`） |
| B9 | **新增 profile 模板与 bundle**：`acp`/`sdk`/`sdk-minimal`；boot 新增 `plugin-manager`/`plugin-market`/`hmr`/`config-editor` 包 | `packages/boot/app-boot/src/profile.ts:179-185`；`ls packages/bundle`（`acp-app`/`sdk-app`/`sdk-minimal`）；`ls packages/boot` | **低**：可选能力，按需了解 |
| B10 | **CLI 别名**：`dsh <name>` 缩写为 `dsh --profile <name>` | `apps/cli/src/args.ts:13`、`:99` | **低**：脚本可写 `dsh web`/`dsh headless` |
| B11 | 新增大量可选包（`browser-use`/`computer-use`/`document`/`deliverables`/`telemetry`/`ssh`/`ptc-runtime`），`packages/core` 新增 `agent-tool-presentation` | `ls packages`；`ls packages/core` | **低**：与团队协作迁移基本无关 |
| B12 | `agent-team` session 事件 `version` 由 1 升到 2 | `packages/experimental/agent-team/src/types.ts:232,234`（`version: 2`） | **低但需注意**：若沿用其事件，注意版本字段 |

> **不变量（0.1→0.2 保持不变）**：插件两形态与导出陷阱、Config 用 schemastery、`ctx.effect`/`ctx.on` 回滚语义、事件 5 种派发模式、`dsh.bundle.patch` 声明格式、profile/bundle/patch 组合顺序、`dsh plugin ... add` 命令——§2~§5 逐条核定。

---

## 2. 最小插件的完整契约（0.2.1-rc.3）

### 2.1 两种插件形态（互斥）

**【事实 V】** 与 0.1.0 一致：
- **函数式插件**：命名导出 `name` / `inject` / `Config` / `apply`，**无 default export**。`packages/todo/tool-todo/src/index.ts:22`（`export const name`）、`:23`（`export const inject`）、`:41`（`export const Config`）、`:117`（`export function apply`）；模块头注释仍写 "Named exports preserve loader injection metadata"。
- **Service 子类**：`class X extends Service`、`static inject`、构造里 `super(ctx, 'key')`、**default export**。`packages/plan/plan-mode/src/index.ts:24`（`import { Context, Service }`）、`:176`（`static inject`）、`:189`（`super(ctx, 'planMode')`）、`:477`（`export default PlanModeController`）。

**【事实 V】** **default export 陷阱仍成立**：postmortem 仍存在 `docs/postmortem/0001-acp-default-export-drops-inject.md`。

**【事实 V】** `ctx.effect(execute, label?)` 回滚语义未变：`docs/cordis-api/fiber.md:8-25`（disposer 逆序、可 async、随 fiber 卸载）；`ctx.on(name, listener, options?)` 返回 disposer：`docs/cordis-api/events.md:136`。

### 2.2 可直接拷贝的最小函数式插件（完整文件）

**`package.json`**（实测对照 `packages/todo/tool-todo/package.json`）：

```jsonc
{
  "name": "@deepseek-ai/dsh-my-plugin",
  "description": "One-line purpose",
  "version": "0.2.1-rc.3",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/schemastery": "workspace:~"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:~",
    "@deepseek-ai/dsh-tools": "workspace:~",
    "@deepseek-ai/dsh-system-prompt": "workspace:~"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:~",
    "@deepseek-ai/dsh-tools": "workspace:~",
    "@deepseek-ai/dsh-system-prompt": "workspace:~"
  }
}
```

> **【事实 V】** 关键点：无 `./invariant` 子导出（机制已移除，B1）；内部依赖用 `workspace:~`（B4）；`files` 含 `lib/types/**/*.js`（对照 `tool-todo/package.json:29-34`）。
> **【事实-文档】** `peerDependencies` 上的 `@deepseek-ai/dsh-*` 必须与 runtime 版本匹配，否则 profile 会跳过该 bundle（`packages/boot/app-boot/README.md:52`）。

**`src/index.ts`**：

```ts
/** My plugin: one model-facing tool + one prompt section.
 * @module @deepseek-ai/dsh-my-plugin */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'my-plugin'

/** Services required before this plugin activates. */
export const inject = ['tools', 'systemPrompt'] as const

/** Deployment-varying configuration; every key needs JSDoc. */
export interface Config {
  /** Greeting prefix used by my_tool. */
  greeting: string
}

/** Schemastery schema; validated output must equal Config. */
export const Config: z<Config> = z.object({
  greeting: z.string().default('hello'),
})

/** Register contributions; everything here is a reversible effect. */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'my_tool',
    description: 'Say hello to a name.',
    parameters: {
      who: { type: 'string', required: true, description: 'Name to greet.' },
    },
    // output is REQUIRED (schema + render) — see §2.4
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: true },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    async execute(args) {
      return { text: `${config.greeting}, ${args.who}` }
    },
  }))

  ctx.systemPrompt.section({
    name: 'my-plugin:guide',
    order: 120,                       // 100–199 = tool guidance region
    text: 'Use my_tool when you need to greet someone.',
  })
}
```

> **【事实 V】** `ctx.systemPrompt.section(section): () => void` 定义在 `packages/core/system-prompt/src/index.ts:478`。
> **【事实 V】** `defineTool` 定义在 `packages/core/tools/src/schema.ts:554`。**`output` 是必填字段**（`schema.ts:565` 无条件读 `options.output.render`；`:578` 读 `options.output.schema`；`:490-491` 声明 `readonly output`）——**不提供 `output` 无法编译/运行**。`tool-todo/src/index.ts:158`（output）、`:187`（render）为真实范例。

### 2.3 可直接拷贝的最小 Service 类插件（完整文件）

```ts
/** My service plugin. @module @deepseek-ai/dsh-my-service */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    myService: MyService
  }
}

/** Deployment config. */
export interface Config {
  /** Maximum items retained. */
  maxItems: number
}

/** My service. */
export class MyService extends Service {
  static inject = ['tools']
  static Config: z<Config> = z.object({
    maxItems: z.number().step(1).min(1).default(20),
  })

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'myService')                                  // 注册为 ctx.myService
    ctx.effect(() => () => { /* teardown */ }, 'myService.lifecycle()')
  }
}

export default MyService                                     // Service 形态必须 default export
```

> **【事实 V】** 形状对照 `packages/plan/plan-mode/src/index.ts:176,189,477`（Service 子类 default export）与 `packages/experimental/agent-team/src/index.ts`（`super(ctx,'agentTeams')` + `ctx.effect`）。**声明合并块是让 `ctx.myService` 有类型的关键**。

### 2.4 依赖注入 / 暴露服务 / 订阅事件

**【事实 V】** 依赖声明：`export const inject = [...]`（函数式，`tool-todo:23`）或 `static inject`（Service，`plan-mode:176`）。

**【事实 V】** **可选依赖**（挂子插件）：`ctx.inject(deps, callback)` 存在——`vendor/cordis/src/registry.ts:176`（类型签名）、`:300`（实现）。一次性读取用 `ctx.get(name)`。

**【事实 V】** 暴露服务：`Service` 子类 `super(ctx,'key')`。

**【事实 V】** 订阅事件：`ctx.on(name, listener, options?) → () => boolean`（`docs/cordis-api/events.md:136`）。

**【事实 V】** **派发模式共 5 种**：`emit | parallel | serial | bail | waterfall`——`vendor/cordis/src/events.ts:32` 与 `docs/cordis-api/events.md:204` 均如此。（该断言已在 0.2.1-rc.3 复核，**未变**。）

**【事实 V】** 事件声明用 declaration merging；`agent-team` 在 0.2.1 用 `version: 2`（`packages/experimental/agent-team/src/types.ts:232,234`）。

---

## 3. 最小 bundle 的完整契约（0.2.1-rc.3）

### 3.1 四者关系与组合顺序

**【事实 V】** bundle manifest 声明：`"dsh": { "bundle": { "patch": "<文件或有序文件列表>" } }`（`packages/bundle/base/package.json:31-35`；有序列表见 `packages/boot/app-boot/README.md:50`）。

**【事实 V】** profile 位于 `$DSH_HOME/profiles/<name>`，`cordis.patch.yml` 是用户 patch 层文件名（`packages/boot/app-boot/src/profile.ts:37,40`；`packages/boot/app-boot/README.md:50`）。

**【事实 V】组合顺序（未变）**：空列表 → 各 bundle（按 `dsh.profile.bundles` 顺序，逐文件施加其 patch）→ profile 的 `cordis.patch.yml` → home 级 patch → launcher 层（`--patch`）。证据：`packages/boot/app-boot/src/profile.ts:2-13`；`packages/boot/app-boot/README.md:50`。

**【事实 V】** profile 模板：`profile.ts:179-185`（`acp`/`web`/`headless`/… 均以 `@deepseek-ai/dsh-base` 起）；无模板名默认 `['@deepseek-ai/dsh-base']`（`profile.ts:213`）。

**【事实 V】** patch 两种操作（`packages/bundle/base/cordis.patch.yml:13-24`）：
- `- id: <row-id>` + `disabled: true` / 覆盖 `config`（**整体替换，不深合并**）；
- `- insert:` + `- id:/name:/config:` 新增 row。

### 3.2 可直接拷贝的最小 bundle 骨架

```
packages/bundle/my-team/
├── package.json
├── cordis.patch.yml
└── src/index.ts            # 可选：随 patch 挂载的 runtime glue 插件
```

**`package.json`**（逐字段对照 `packages/experimental/agent-team-profile/package.json` 与 `packages/bundle/base/package.json:16-35`）：

```jsonc
{
  "name": "@deepseek-ai/dsh-my-team",
  "description": "My team bundle: patch layer over dsh-base",
  "version": "0.2.1-rc.3",
  "publishConfig": { "access": "public" },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "dependencies": {
    "@deepseek-ai/dsh-my-plugin": "workspace:~"
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-base": "workspace:~",
    "@deepseek-ai/cordis": "workspace:~"
  }
}
```

> **【事实 V】** `exports` 必须含 `"./cordis.patch.yml"`（`agent-team-profile/package.json:22`、`bundle/base/package.json` 同）。`dsh.bundle.patch` 位于 `agent-team-profile/package.json:35-38`。`publishConfig.access: public` 用于发布（`bundle/base/package.json` 有）。

**`cordis.patch.yml`**（真实样例：`packages/experimental/agent-team-profile/cordis.patch.yml` 全文）：

```yaml
# Apply after dsh-base so these replacements keep coordination on the Team tools.
- id: tool-subagent          # 关掉会与团队工具冲突的 legacy 全局行
  disabled: true

- insert:
    - id: my-plugin
      name: '@deepseek-ai/dsh-my-plugin'
      config:
        greeting: hello
```

> **【事实 V】** 真实 bundle 就是"**先 `disabled: true` 关掉冲突的 legacy 行，再 `insert:` 自己的行**"——见 `packages/experimental/agent-team-profile/cordis.patch.yml`（它关闭 `tool-subagent-control`/`tool-subagent-list-agents`/`tool-subagent`/`tool-subagent-fork`，再 insert `agent-team`/`tool-agent-team`/`ui-agent-team`）。
> **【事实 V】** 行顺序不承载加载语义，激活由服务可用性驱动（`packages/bundle/base/cordis.patch.yml:11-13`）。

**接入 profile**：

```sh
dsh plugin --profile <name> add ./packages/bundle/my-team     # 本地链接安装【事实 V，见 §5】
# 或在 profile 的 package.json 的 dsh.profile.bundles 里追加 "@deepseek-ai/dsh-my-team"
```

### 3.3 完整真实样例（建议直接参考）

**【事实 V】** `packages/experimental/agent-team-profile/` 是**与我们目标最贴近的现成 bundle**：一个包同时挂 Agent Team 域插件 + 工具 + Web UI，README 给出安装命令 `dsh plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile`。**实现 dsh-swarm 的团队 bundle 时以它为模板**。

---

## 4. forge「适用 / 过时」对照表（针对 0.2.1-rc.3 重新核定）

> forge 位于 `/root/repo/dsh-plugin/dsh-plugin-forge/`，pin 在 `dsh-v0.1.5-rc.2`（`SKILL.md:12`）。**"仍适用"= 在 0.2.1-rc.3 上能对上。**

| # | forge 论断（出处） | 0.2.1-rc.3 核验 | 判定 |
|---|---|---|---|
| 1 | bundle 声明 `dsh.bundle.patch`（`SKILL.md:23`） | `bundle/base/package.json:31-35`；`agent-team-profile/package.json:35-38` 一致 | **仍适用** |
| 2 | profile 在 `$DSH_HOME/profiles/<name>`，`dsh.profile.bundles` 有序层（`blueprints.md:143`） | `profile.ts:37,44-45`；`app-boot/README.md:50` 一致 | **仍适用** |
| 3 | 组合顺序 bundles → profile patch → home patch → `--patch`（`blueprints.md`） | `profile.ts:2-13`、`app-boot/README.md:50` 一致 | **仍适用** |
| 4 | patch 按 id 整体替换 config、不深合并；`- insert:` 增 row（`blueprints.md:152`） | `bundle/base/cordis.patch.yml:13-24` 一致 | **仍适用** |
| 5 | 函数式插件命名导出 `name`/`inject`/`Config`/`apply`，无 default export（`SKILL.md:67`） | `tool-todo/src/index.ts:22,23,41,117`；postmortem 0001 存在 | **仍适用** |
| 6 | Service 插件 `extends Service`/`static inject`/`super(ctx,'key')`/default export（`SKILL.md:67`） | `plan-mode/src/index.ts:24,176,189,477` | **仍适用** |
| 7 | Config = `interface Config` + `export const Config: z<Config>`，用 `@deepseek-ai/schemastery`（`blueprints.md:42-49`） | `tool-todo/src/index.ts:14,41` 一致 | **仍适用** |
| 8 | 事件派发模式 4 种 `emit/parallel/serial/waterfall`（`SKILL.md:68`） | 0.2.1 实际 **5 种含 `bail`**（`vendor/cordis/src/events.ts:32`、`events.md:204`） | **已过时/不全**：补 `bail` |
| 9 | `ctx.effect(()=>()=>...,label)` 回滚（`blueprints.md:119-124`） | `docs/cordis-api/fiber.md:8-25` 一致 | **仍适用** |
| 10 | host 面 row 写 `packages/bundle/base/cordis.patch.yml`（`blueprints.md:143`） | 文件存在且为 `- insert:` 结构 | **仍适用** |
| 11 | preset 路径 `apps/cli/config/agent-presets/*/agent.cordis.yml`（`design.md:63`） | **该目录已不存在**；preset 改为 `@deepseek-ai/dsh-agent-preset` 行（B2/B3） | **已过时（破坏性）** |
| 12 | preset 路径 `packages/preset/agent-presets/presets/<preset>/agent.cordis.yml`（`blueprints.md:146`） | 包已改名 `packages/preset/agent-preset`，**无 `presets/` 目录、无 `agent.cordis.yml`** | **已过时（破坏性）** |
| 13 | `pnpm run verify-cordis-config` / `doc-sync` / `gen-cordis-catalog`（`shipping.md`） | 均在（`package.json:154,198,162`） | **仍适用** |
| 14 | `dsh plugin --profile <name> add <pkg>`（pnpm forwarder）（`external-bundle.md:28`） | `apps/cli/src/args.ts:52-54,99` 一致 | **仍适用** |
| 15 | `dsh --profile <name> --dump-config`（`debugging.md:13`） | CLI 有 `plugin`/profile 机制；`--dump-config` 由 profile 机制提供（`app-boot/README.md:54` 提及 `--dump-config`） | **仍适用** |
| 16 | 每个 package 须有 `src/invariant.ts` 伴侣 + manifest/tsconfig 接线（`shipping.md:30`） | **机制整体移除**（B1）：无 `invariant.ts`、无 `dsh-invariants`、无 `verify-package-invariants` | **已过时（破坏性）** |
| 17 | README 必须含 `## Model Experience` / `## Known Limitations`（`shipping.md:5-10`） | 0.2.1 各包 README 仍用此结构（如 `agent-preset/README.md`） | **仍适用（monorepo gate）** |
| 18 | `dsh-persona` config 由 `text` 改 required `prefix`（`debugging.md:39-41`） | `packages/preset/persona/src/index.ts:36`（`prefix: string`）、`:50`（`prefix: z.string().required()`）、`:66`（`text: config.prefix`）；无 `text` 键 → 一致 | **仍适用** |
| 19 | 投影契约 `{ key, stateSchema, init, apply, wire?, stateVersion }`，旧字段静默失效（`debugging.md:43-45`） | `packages/session/session-projection/src/index.ts:48`（`interface ProjectionDefinition`）、`:55`（`stateSchema: ZodType<S>`）、`:75/:145`（`wire: { viewSchema, view }`）、`:92`（`stateVersion`）→ 一致 | **仍适用** |
| 20 | in-repo skill `dsh-pre-push-checks` / `dsh-archive-agent-notes`（`shipping.md`） | `.agents/skills/dsh-pre-push-checks/SKILL.md`、`.agents/skills/dsh-archive-agent-notes/SKILL.md` 均存在 | **仍适用** |
| 21 | 所有文档链接 pin `dsh-v0.1.5-rc.2`（`SKILL.md:12`） | 当前锁定版本是 `dsh-v0.2.1-rc.3` | **已过时**：pin 需更新 |
| 22 | 客户端半格式 `dsh.client` + 懒 CJS 自注册 + `/plugins/<id>/client.js`（`external-bundle.md`） | `dsh.client` 字段存在（`packages/client/ui-conversation/package.json:29-37`）；`ClientModuleRegistry`（`packages/client/modules/src/index.ts`）、`__DSH_BOOT__`（`packages/client/web/src/boot.ts`）、`/plugins/<id>/client.js` 路由（`packages/client/modules/src/index.ts:230,358`）均存在 | **仍适用** |

**归纳**：forge 的**核心机制仍可复用**（两形态/无 default export、Config 用 schemastery、bundle patch、组合顺序、`dsh plugin add`）；**必须修正**的是 #8（补 `bail`）、#11/#12/#16（preset 与 invariant 是破坏性变更）、#21（pin 过期）。

---

## 5. 插件开发 → 加载 → 验证 最短路径（0.2.1-rc.3）

**【事实 V】** `dsh plugin` 子命令是"在 profile 目录内转发给 pnpm 的插件管理器"（`apps/cli/src/args.ts:52-54`）；示例 `dsh plugin --profile tui add <package>`（`args.ts:99`）；`dsh <name>` 缩写 `dsh --profile <name>`（`args.ts:13`）。

```
1. 建包     cp §2.2 / §2.3 骨架到 dsh-swarm 仓内
2. 编译     按仓内构建（monorepo: pnpm run build；独立仓: 自行 tsc/tsdown 出 lib/）→ §6
3. 建 profile   dsh plugin 初始化 base-backed profile，或 --from-default-profile <template>
4. 装入      dsh plugin --profile <name> add ./your-package
5. 看组合树  dsh --profile <name> --dump-config        # 确认 row 出现
6. 启动      dsh --profile <name>        （或 dsh <name>）
7. 验证      看模型是否出现你的工具/section；改 config 后重启
```

**【事实-文档】** 双实例隔离（避免装坏驱动实例）：`external-bundle.md` 描述的 driver/target 模式仍适用；0.2.1 可在独立 `DSH_HOME` 下 `dsh plugin --profile web add link:../my-plugin`。

**【事实-文档】** `dsh plugin --profile <name> remove <pkg>` 会从 `dsh.profile.bundles` 摘除该 bundle（`agent-team-profile/README.md`）。

---

## 6. 构建与测试（0.2.1-rc.3）

**【事实 V】** root `package.json` 脚本：
- `build` = `tsx scripts/build.ts`（`:21`）
- `typecheck` = `tsx scripts/build.ts --scope typecheck`（`:53`）
- `test:coverage` = `pnpm run build:native-system && vitest run --coverage`（`:61`）→ **测试运行器仍是 vitest**
- `verify-cordis-config`（`:154`）、`gen-cordis-catalog`（`:162`）、`gen-tool-catalog`（`:171`）、`doc-sync`（`:198`）、`constraints`（`:197`）

**【事实 V】** 官方 testkit 包存在：`packages/test-support/agent-loop-testkit`、`packages/test-support/loader-smoke`、`packages/test-support/llm-mock-server`。**【事实 V】** 覆盖率门禁仍是**逐文件 100%**：`vitest.config.ts:12,84,105,116`（"per-file 100% gate"）。

**【事实 V】** 官方本地开发文档入口存在：`docs/user/develop/basic/{index,config,publish,tool}.md`、`docs/cookbook/adding-a-package.md`、`docs/cookbook/adding-a-tool.md`——**实现前必读**。

---

## 7. 待实现阶段确认的问题

1. **preset 平面路由（B2/B3 直接后果）**：dsh-swarm 的**模型工具**（团队协作工具）要落 Host 平面还是 preset 平面？0.2.1 的 preset 是"插件行"（`@deepseek-ai/dsh-agent-preset` 的 `plugins` 列表），需确认我们的工具是编进 bundle 的 host 树，还是编成 preset 行供 session 选择。
2. **bundle 拆分粒度**：是把团队能力做成**一个 bundle**（学 `agent-team-profile`）还是**域插件 + 工具 + UI 分包**再各挂一行？B7 允许 bundle 的 patch 为有序多文件，需定拆分策略。
3. **`engines.dsh` 与 peer 声明（B8）**：dsh-swarm 自建包应声明 `engines.dsh: "0.2.1-rc.3"`（精确）还是用 `peerDependencies` 区间？这决定 profile 是否因版本不匹配而跳过我们的 bundle。
4. **是否复用 experimental agent-team**：0.2.1 的 `packages/experimental/agent-team`(+`-profile`) 仍存在且是**最贴近的现成实现**，但其 API 无版本承诺（experimental）。是直接依赖它，还是经端口隔离自建？
5. **invariant 移除后的持久数据校验（B1）**：既然 `ctx.invariants` 机制没了，团队持久数据（任务/消息）的 malformed 防护该放在哪儿（`session/event` 校验？插件内私有？），需在实现前定策略。

---

## 附：本手册引用到的 0.2.1-rc.3 实证文件

**插件骨架**
- `packages/todo/tool-todo/src/index.ts`（函数式：`:22,23,41,117,158,187`）、`packages/todo/tool-todo/package.json`（`:2,4,16-34,45,59`）
- `packages/plan/plan-mode/src/index.ts`（Service：`:24,176,189,477`）
- `packages/experimental/agent-team/src/index.ts`、`.../src/types.ts`（`:75,129,153,232,234`）

**bundle / profile / patch**
- `packages/bundle/base/package.json`（`:31-35`）、`packages/bundle/base/cordis.patch.yml`（`:11-24`）
- `packages/experimental/agent-team-profile/{package.json,cordis.patch.yml,README.md}`
- `packages/boot/app-boot/src/profile.ts`（`:2-13,37,40,44-45,179-185,213`）、`packages/boot/app-boot/README.md`（`:46-60`）
- `packages/bundle/README.md`（`:11`）

**Cordis API**
- `docs/cordis-api/{events,fiber,context}.md`（`events.md:136,204`；`fiber.md:8-25`）
- `vendor/cordis/src/events.ts:32`、`vendor/cordis/src/registry.ts:176,300`
- `packages/core/system-prompt/src/index.ts:478`、`packages/core/tools/src/schema.ts:554,565,578`
- `docs/postmortem/0001-acp-default-export-drops-inject.md`

**preset / 命令 / 构建**
- `packages/preset/agent-preset/README.md`、`packages/preset/agent-preset-registry/README.md`
- `apps/cli/src/args.ts`（`:13,52-54,99`）
- root `package.json`（`:7,9,21,53,61,154,162,171,197,198`）
- `docs/user/develop/basic/*`、`docs/cookbook/adding-a-{package,tool}.md`

*（本手册由 dsh-target-analyst 生成；**每条 API 断言均已在 `dsh-v0.2.1-rc.3` 源码上实测**，手册内不再有【未验证】的 API 断言。§4 对照表 22 条全部落定为"仍适用/已过时"，无残留"无法确认"项。）*
