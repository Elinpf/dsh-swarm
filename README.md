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
│   └── example-plugin/     # hello-world 插件包（插件 + 它自己的 bundle patch）
│       ├── src/index.ts        # 最小函数式插件：name/inject/Config/apply
│       ├── cordis.patch.yml    # bundle patch（dsh.bundle.patch 指向它）
│       ├── tests/…spec.ts      # vitest 单测（含导出形态 / HMR 安全）
│       ├── tsconfig.json
│       └── package.json
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
- [x] `pnpm build` / `pnpm test` / `pnpm verify` / `pnpm lint` / `pnpm format:check` 全部实跑通过
- [x] 真实 cordis 加载验证
- [ ] 团队协作插件族（消息总线 / 任务看板 / 验证闸 / 分布式 / worktree 锁 / 人类成员路由）——**下一阶段**

### 对手册的两处修正（真实 0.2.1-rc.3 实测）

1. **`output.schema` 的 `required`**：手册 §2.2 示例把 `required: true` 写在对象层，真实 value schema DSL **不支持**（抛 `JsonSchemaError`）。正确写法是把 `required: true` 写在**属性**上（见 `packages/example-plugin/src/index.ts`）。
2. **消费 DSH 声明需要 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`**：DSH 的 `.d.ts` 之间用 `.ts` 扩展名互相引用；不开启这两项，`declare module '@deepseek-ai/cordis'` 的类型增强会被静默丢弃（症状：`ctx.tools` / `ctx.systemPrompt` 不存在）。已写入 `tsconfig.base.json`。
