# dsh-swarm

把 JiuwenSwarm 的「集群/多智能体协作精髓」迁移到 **DeepSeek Harness（DSH）** 的插件族仓库。

本仓当前处于 **骨架阶段（scaffold）**：只做两件事——

1. 搭好可复用的 pnpm workspace 骨架；
2. 用 `packages/example-plugin` 跑通「**插件能被构建 → 能被 DSH 内核加载 → 能观察到它注册的东西**」这条链路。

> 团队协作能力（消息总线 / 任务看板 / 验证闸等）是**下一阶段**任务，本仓目前**只包含 hello-world**，请勿在此阶段实现业务插件。

插件与 bundle 的开发契约以 [`docs/plugin-dev-guide.md`](docs/plugin-dev-guide.md)（`dsh-v0.2.1-rc.3` 核定版）为唯一依据；隔离开发环境见 [`docs/env-setup.md`](docs/env-setup.md)。

---

## 锁定版本

| 组件                  | 版本                     | 说明                                          |
| --------------------- | ------------------------ | --------------------------------------------- |
| DSH                   | `0.2.1-rc.3`             | 上游 tag `dsh-v0.2.1-rc.3`，commit `1f81c047` |
| Node                  | `^22.19.0 \|\| >=24.0.0` | 与 DSH `engines` 一致；隔离环境用 `v22.23.4`  |
| pnpm                  | `11.28.5`                | 锁在根 `package.json` 的 `packageManager`     |
| `@deepseek-ai/cordis` | `^4.0.1`（本机装 4.0.5） | DSH 的插件内核                                |

### 命名（npm scope）

本项目自有包统一发布在 **`@elinpf`** scope 下，命名规则 `@elinpf/dsh-swarm-<能力>`：

| 本项目包                         | 对应上游（DSH）                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `@elinpf/dsh-swarm-team-core` 等 | 编排/协作能力由本仓自建，**不**对应单个上游包                                                                   |
| `@elinpf/dsh-swarm-bundle`       | 组合层，叠加在上游 bundle（如 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-experimental-agent-team-profile`）之上 |

> 上游 DSH 包一律以 `@deepseek-ai/dsh-*` 命名（peer 依赖，不由本仓发布）。本仓的包名与上游**不混用同一 scope**：自建=`@elinpf/dsh-swarm-*`，上游=`@deepseek-ai/*`。
>
> `example-plugin` 是骨架阶段的 hello-world **演示包**，`package.json` 保留 `"private": true`，**不发布到 npm**（`pnpm -r publish` 会自动跳过它）。其余 14 个协作包可发布。

---

## 目录结构

```
dsh-swarm/
├── package.json            # 根 workspace：脚本 + 开发依赖 + packageManager 锁定
├── pnpm-workspace.yaml     # workspace 成员 + 链接器设置（hoisted / autoInstallPeers）
├── tsconfig.base.json      # 统一 TS 基座（含 DSH 声明文件所需的 allowImportingTsExtensions）
├── eslint.config.mjs       # 扁平 ESLint 配置
├── .prettierrc.json        # 格式化配置
├── .gitignore              # 忽略 .runtime/ 与本地环境/凭证
├── packages/
│   ├── example-plugin/          # hello-world 基线（P2 产出）；演示包，不发布到 npm（private）
│   ├── team-core-contract/      # 端口类型 SSOT（纯类型，无实现；ADR-0001）
│   ├── team-bus/                # 广播 / 多播 / 主题扇出（Service）
│   ├── team-prompt/             # 团队段落装配（函数式）
│   ├── team-scheduler/          # 幂等调度 + stale 自愈（Service）
│   ├── team-review/             # 验证闸 + 裁决数学（Service）
│   ├── team-completion/         # 团队完成判定（Service）
│   └── tool-swarm/              # 模型工具（函数式）
│   # 每个包：src/index.ts + tests/*.spec.ts + tsconfig.json + package.json
├── scripts/
│   ├── env.sh              # source 后进入隔离环境（P1-env-setup 产出）
│   ├── setup-env.sh        # 幂等搭建隔离环境（P1-env-setup 产出）
│   └── verify-load.mjs     # 真实 cordis 加载验证（pnpm verify 的核心）
└── docs/
    ├── plugin-dev-guide.md # 插件/bundle 开发手册（核定版）
    ├── env-setup.md        # 隔离环境方案与实测记录
    └── verification.md     # 本阶段构建/测试/加载验证的实测输出
```

---

## 快速开始

### 1. 进入隔离环境（**必须**，避免影响现有 DSH 实例）

```bash
cd dsh-swarm
source scripts/env.sh        # 切到项目内隔离的 Node / pnpm / DSH_HOME
node -v                      # v22.23.4
corepack pnpm -v             # 11.28.5
```

> 隔离环境由 `scripts/setup-env.sh` 幂等搭建（详见 `docs/env-setup.md`）。首次或换机器时先跑：`bash scripts/setup-env.sh`。

### 2. 安装依赖

```bash
corepack pnpm install
```

### 3. 构建 / 测试 / 验证

```bash
corepack pnpm build      # tsc 编译所有包到 lib/
corepack pnpm test       # vitest 单测
corepack pnpm verify     # build + 用真实 cordis 加载插件并断言注册结果
corepack pnpm typecheck  # 仅类型检查
corepack pnpm lint       # ESLint
corepack pnpm format:check
```

实测输出见 [`docs/verification.md`](docs/verification.md)。

---

## example-plugin 是什么

一个**最小可运行的 DSH 函数式插件**，用来证明链路通畅：

- 命名导出 `name` / `inject` / `Config` / `apply`，**没有 default export**（default export 会让 loader 丢掉 `inject`）；
- `apply` 里注册一个模型可见工具 `greet` 和一个系统提示词 section `example-plugin:guide`；
- `package.json` 通过 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明自己是 bundle，patch 用 `- insert:` 往组合树里加一行。

**加载验证**（`scripts/verify-load.mjs`）用**真实的 cordis 运行时**（DSH 的内核）把构建产物 `ctx.plugin()` 进去，断言：无 default export、工具与 section 被注册、工具可执行、fiber 卸载进入 `DISPOSED`、`ctx.effect` 注册会随卸载回滚。

---

## 阶段 1 协作插件（P4a）

在 `example-plugin` 之外，新增 7 个协作能力包（一个能力一个包，包间**只经端口通信**）：

| 包                                     | 形态    | 服务键               | 职责                                                            |
| -------------------------------------- | ------- | -------------------- | --------------------------------------------------------------- |
| `@elinpf/dsh-swarm-team-core-contract` | 纯类型  | —                    | 端口类型 **SSOT** + `ctx.teamCore` 类型增强（无实现，ADR-0001） |
| `@elinpf/dsh-swarm-team-bus`           | Service | `ctx.teamBus`        | 广播 / 多播 / 主题扇出（自过滤、原子多播、防滥用）              |
| `@elinpf/dsh-swarm-team-prompt`        | 函数式  | —                    | 稳定段 + cache-safe context + 渐进披露                          |
| `@elinpf/dsh-swarm-team-scheduler`     | Service | `ctx.teamScheduler`  | 幂等扫描调度 + stale 自催/升级 + 降级                           |
| `@elinpf/dsh-swarm-team-review`        | Service | `ctx.teamReview`     | 验证闸 + 裁决数学（一票否决 / 打分阈值 / 自投拒绝）             |
| `@elinpf/dsh-swarm-team-completion`    | Service | `ctx.teamCompletion` | 完成判定三条件 + 上升沿去重                                     |
| `@elinpf/dsh-swarm-tool-swarm`         | 函数式  | —                    | 暴露 broadcast/multicast/review\_\*/team_summary 模型工具       |
| `@elinpf/dsh-swarm-team-core`          | Service | `ctx.teamCore`       | **TeamCorePort** 落地：native 薄适配 + no-op 降级               |
| `@elinpf/dsh-swarm-bundle`             | bundle  | —                    | 组合层：先 disabled 关 legacy，再 insert 团队行                 |

### 阶段 2 能力供给包（能力供给补全）

| 包                                           | 形态    | 服务键               | 职责                                                                    |
| -------------------------------------------- | ------- | -------------------- | ----------------------------------------------------------------------- |
| `@elinpf/dsh-swarm-team-capability-contract` | 纯类型  | —                    | 4 个能力端口类型 SSOT（无实现）                                         |
| `@elinpf/dsh-swarm-team-workspace`           | Service | `ctx.teamWorkspace`  | worktree 隔离（复用 `ctx.worktrees`）+ 文件锁/写域守卫（`fs/*-intent`） |
| `@elinpf/dsh-swarm-team-skills`              | Service | `ctx.teamSkills`     | 技能可见性声明 + 权限隔离（缺失文档=无限制）                            |
| `@elinpf/dsh-swarm-team-memory`              | Service | `ctx.teamMemory`     | 共享只读 + 成员私有记忆，`ctx.systemPrompt.context` 注入（cache-safe）  |
| `@elinpf/dsh-swarm-team-compaction`          | Service | `ctx.teamCompaction` | 团队上下文预算，委托 `ctx.compaction`（幂等，默认关闭）                 |

`tool-swarm` 增量暴露 `workspace_lock/unlock/worktree`、`skills_visible`、`memory_recall`（`Config` 里 `enableWorkspace/enableSkills/enableMemory`，默认 false）。

**端口隔离（ADR-0001，方案 C）**：6 个能力包**只从 `@elinpf/dsh-swarm-team-core-contract` 取类型**，不得 import `@elinpf/dsh-swarm-team-core` 的内部实现——契约与实现物理分离，约束在编译期成立。`team-core` 是**唯一**接触实验性 `ctx.agentTeams` 的包，且用本地结构化的 seam 接口描述它（不 import 实验包类型）。

### 后端选择（`team-core`）

**后端 = `native`**：P3-spike 实测 DSH 原生 `ctx.agentTeams` 在 `0.2.1-rc.3` 上可用（8/10 工具跑通、durable 事件落盘、`--session-id` 重启可复原）。阶段 0/1 **不实现 `owned` 自建后端**，但端口保留 `backend` 选择点：`backend: 'owned'` 显式抛 `TEAMCORE_BACKEND_UNAVAILABLE`；`ctx.agentTeams` 缺失时进入 **no-op 模式**（读返回空、写抛 `TEAMCORE_UNAVAILABLE`），**不阻断单 agent**。

### 如何启用团队 bundle

> ⚠️ 实验包**必须钉 `0.2.1-rc.3`**（npm `latest` 是 `0.1.5-alpha.2`，不兼容会被版本门禁禁用）。

```sh
source scripts/env.sh
DSH=.runtime/dsh-cli-npm/node_modules/.bin/dsh
$DSH plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.3
$DSH plugin --profile headless add ./packages/bundle
$DSH --profile headless --dump-config | grep -E "team-core|team-bus|tool-swarm"
$DSH --profile headless remove @elinpf/dsh-swarm-bundle    # 关闭即回退（零残留）
```

---

## 环境注意

正常路径就是标准 pnpm 流程：

```bash
source scripts/env.sh          # 隔离 Node v22.23.4 + pnpm 11.28.5 + 独立 DSH_HOME
corepack pnpm install          # 默认 store 即可
corepack pnpm verify
```

> **网络**：不要挂 Clash 之类本地代理（实测大 body 会 `SSL_ERROR_SYSCALL`）。npm 直连或走 npmmirror 均可（见 `docs/env-setup.md`「网络注意事项」）。
>
> **推送凭证**：若需 `git push`，**不要**先 `source scripts/env.sh`——它会把 `HOME` 改到项目内隔离目录，
> 导致凭证助手找不到 `/root/.git-credentials`。推送请用：
> `git -c credential.helper=/root/repo/jiuwen/.proxy-config/git-cred-helper.sh push`。

<details>
<summary>可选：磁盘紧张时的临时规避（开发过程中曾用到，现磁盘已充足，通常不需要）</summary>

若根盘接近占满，可把依赖与 store 放到 tmpfs，避免写满根盘：

```bash
mkdir -p /dev/shm/dsh-swarm/node_modules
ln -sfn /dev/shm/dsh-swarm/node_modules node_modules
corepack pnpm install --store-dir=/dev/shm/dsh-swarm-store --prefer-offline
```

`/dev/shm` 是易失内存，重启后需重建（`node_modules` 已在 `.gitignore` 中）。

</details>

---

## 当前阶段状态

- [x] pnpm workspace 骨架（根 package.json / pnpm-workspace.yaml / tsconfig 基座 / lint+format / .gitignore）
- [x] hello-world 插件包 + bundle 声明
- [x] 阶段 0/1 协作插件 7 包（team-core-contract / team-bus / team-prompt / team-scheduler / team-review / team-completion / tool-swarm）
- [x] `team-core`（TeamCorePort，native 后端）+ `bundle` 组装 —— 阶段 0/1 全部 9 个包就位
- [x] **阶段 2 能力供给 5 包**（team-capability-contract / team-workspace / team-skills / team-memory / team-compaction）—— 共 **14 个包**
- [x] `pnpm build` / `pnpm test` / `pnpm verify` / `pnpm verify:e2e` / `pnpm lint` / `pnpm format:check` 全部实跑通过
- [x] 真实 cordis 加载验证覆盖**全部 14 个包**（`scripts/verify-load.mjs`）；集成冒烟覆盖「成员 → 消息 → 任务 → 评审 → 完成」+ 阶段 2「锁互斥/技能隔离/记忆授权」（`scripts/verify-e2e.mjs`）
- [x] 真实 profile 回归（`scripts/e2e-profile.sh --no-model`）：bundle 11 行 + 4 legacy disabled + 原生行来自 agent-team-profile，PASS=4
- [ ] 整机 profile 级联调（完整 `dsh-base` + 实验包 + 可用模型端点）—— 见 `docs/verification.md` 边界说明
- [ ] 阶段 2/3：worktree+文件锁 / 跨进程分布式 / 技能与记忆 / 人类成员席位 / Web UI

### 依赖版本陷阱（重要）

安装 DSH 原生实验包时**必须显式带 `@0.2.1-rc.3`**（dist-tag `next`）：

```bash
pnpm add @deepseek-ai/dsh-experimental-agent-team@0.2.1-rc.3
```

npm 上这两个实验包的 `latest`（`0.1.5-alpha.2`）与我们的运行时不兼容，会被版本门禁直接禁用，强行打开会在 `spawn`/typert codec 上报错。详见 `docs/agent-team-spike.md`。

### 对手册的两处修正（真实 0.2.1-rc.3 实测）

1. **`output.schema` 的 `required`**：手册 §2.2 示例把 `required: true` 写在对象层，真实 value schema DSL **不支持**（抛 `JsonSchemaError`）。正确写法是把 `required: true` 写在**属性**上（见 `packages/example-plugin/src/index.ts`）。
2. **消费 DSH 声明需要 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`**：DSH 的 `.d.ts` 之间用 `.ts` 扩展名互相引用；不开启这两项，`declare module '@deepseek-ai/cordis'` 的类型增强会被静默丢弃（症状：`ctx.tools` / `ctx.systemPrompt` 不存在）。已写入 `tsconfig.base.json`。
