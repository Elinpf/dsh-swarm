# 发布（publishing）

本文档说明 dsh-swarm 如何把 `@elinpf/dsh-swarm-*` 系列包发布到 npm，以及**用户需要亲自完成的那几步**。

- 工作流文件：[`.github/workflows/publish.yml`](../.github/workflows/publish.yml)
- 自检脚本：[`scripts/check-publish-workflow.mjs`](../scripts/check-publish-workflow.mjs)
- 发布的包：**14 个**协作包（见下）。`example-plugin` 是骨架阶段的 hello-world **演示包**，`package.json` 保留 `"private": true`，**不发布**（`pnpm -r publish` 自动跳过它）。

> ⚠️ 本仓**不存放任何凭证**。仓库根的 `.npmrc` 只含 registry；发布凭证一律从 GitHub Secret 读取。工作流里有一个预检步骤，一旦仓库 `.npmrc` 混入 `_authToken` 之类内容会直接让流水线失败。

---

## 1. 工作流怎么跑

触发方式二选一：

| 触发 | 说明 |
| --- | --- |
| `push` tag `v*` | **打 tag 即发布**（推荐，发布可追溯到 tag） |
| `workflow_dispatch`（手动） | 在 Actions 页面点 `Run workflow`，可选 `dry_run`（只打包不上传）和 `provenance`（是否开启证明） |

单次运行的阶段（顺序执行，**任一门禁失败就中止，绝不会走到发布**）：

```
检出 → 校验 NPM_TOKEN → 装 pnpm/Node → 预检 .npmrc 无凭证
     → pnpm install --frozen-lockfile
     → 门禁①  构建   pnpm run build
     → 门禁②  测试   pnpm run test
     → 门禁③  加载验证 pnpm run verify      （起真实 cordis 运行时加载构建产物）
     → 打包预检 pnpm -r publish --dry-run
     → 发布      pnpm -r publish --no-git-checks --access public
```

要点：

- **验证门禁在发布之前**：门禁不过 → 流程在发布前退出，不会误发。
- **凭证只有 `NPM_TOKEN` 一个来源**；缺失时第一步就 `exit 1` 并打印可操作提示，**不会静默跳过**。
- `--no-git-checks`：tag 触发时 `HEAD` 处于 detached 状态，pnpm 默认的「当前分支必须是发布分支」检查会误报失败，故显式关闭（工作流内已有注释说明）。
- `--access public`：`@elinpf` scope 下公开发布（各包 `publishConfig.access = "public"` 也已声明）。
- `--frozen-lockfile`：锁文件必须与 `package.json` 一致才能安装，防止 CI 悄悄改依赖。**`pnpm-lock.yaml` 必须提交入库。**

### 本地等价复现门禁

```bash
source scripts/env.sh          # 隔离 node/pnpm/HOME/缓存，见 docs/env-setup.md
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm run test
corepack pnpm run verify
corepack pnpm -r publish --dry-run --no-git-checks --access public   # 只打包，不上传
```

---

## 2. 用户需要在 GitHub 上配置的几步

发布前**你必须完成**下面两步，否则流水线会在「校验 NPM_TOKEN」处按预期失败：

### 步骤 ① 在 npmjs.com 建一个发布用 token

1. 登录 <https://www.npmjs.com/> → 账号头像 → **Access Tokens** → **Generate New Token** → 选 **Automation**（不要选 Classic/Publish，Automation 适合 CI）。
   - 若担心越权，可在 token 的 **Packages and scopes** 里限定到 `@elinpf` scope、权限选 *Read and write*。
2. 复制生成的 token（形如 `npm_xxxxxxxx...`，**只显示一次**）。

### 步骤 ② 把 token 存成仓库 Secret

1. 打开 GitHub 仓库 → **Settings → Secrets and variables → Actions**。
2. 点 **New repository secret**。
3. Name 填 **`NPM_TOKEN`**（大小写必须一致），Secret 粘贴上一步的 token。
4. 保存。

> 就这样。工作流会自动把它注入为 `NODE_AUTH_TOKEN`，pnpm/npm 经 `~/.npmrc` 的占位符读取。**不要把 token 写进任何文件提交。**

### （可选）步骤 ③ 首次演练

真正发版前，建议先在 Actions 页面手动跑一次带 **`dry_run = true`** 的运行：它会完整跑安装 + 三个门禁 + 打包预检，但不真的上传。

### （可选）步骤 ④ provenance

- 仓库**公开**时：默认开启 `--provenance`（`id-token: write` 已在工作流声明），npm 会记录「包由哪次 CI 构建、对应哪个 commit」；建议保持开启。
- 仓库**私有**、或 registry 不支持 provenance 时：手动运行时把 `provenance` 输入设为 **`false`** 降级重发即可（去掉证明，正常发布）。
- 若发布 step 报与 provenance / OIDC 相关的错误，先按上面降级重试；仍失败再检查仓库可见性与 runner 是否 GitHub 托管。

---

## 3. 版本与发布策略

**采用「统一版本 + tag 驱动」**：所有可发布包共用一个版本号，版本号即 git tag。理由：

- 14 个包彼此经 `workspace:*` 强耦合、由 `bundle` 统一组装，消费者通常整族安装，独立版本只会制造不存在的“兼容矩阵”。
- 实现简单、零额外工具链，符合「打 tag 就能发」的目标。

### 怎么发下一个版本（例如 0.0.1 → 0.0.2）

```bash
# 1) 改版：把 14 个可发布包的 version 全部改成目标版本（example-plugin 不动）
#    例如用 pnpm 的递归命令（会同时更新 workspace 引用）：
source scripts/env.sh
corepack pnpm -r --filter '!@elinpf/dsh-swarm-example-plugin' exec \
  node -e 'const fs=require("fs");const p=process.env.npm_package_json;const j=JSON.parse(fs.readFileSync(p));j.version=process.env.NEW_VER;fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' NEW_VER=0.0.2
#    （也可直接手改各 packages/*/package.json 的 "version"，或引入 changesets 自动化）

# 2) 提交
git add -A && git commit -m "release: 0.0.2"

# 3) 打 tag 并推送 —— 这一步触发发布
git tag v0.0.2
git push origin main
git push origin v0.0.2
```

推送 `v0.0.2` 后，Actions 会自动：装依赖 → 跑三门禁 → dry-run 预检 → 发布 14 个包。

> 想更自动化可后续引入 [changesets](https://github.com/changesets/changesets)（生成 changelog + 自动改版 + 自动打 tag）。当前阶段不必，tag 驱动已足够。

---

## 4. 发布前预检（本地实测）

在隔离环境实测 `pnpm -r publish --dry-run`（移除 `private` 之后，`2026-10-26`）：

```text
📦 @elinpf/dsh-swarm-team-capability-contract@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-capability-contract@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-core-contract@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-core-contract@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-bus@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-bus@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-compaction@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-compaction@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-completion@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-completion@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-core@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-core@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-memory@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-memory@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-prompt@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-prompt@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-review@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-review@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-scheduler@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-scheduler@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-skills@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-skills@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-team-workspace@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-team-workspace@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-tool-swarm@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-tool-swarm@0.0.1 (dry run)
📦 @elinpf/dsh-swarm-bundle@0.0.1 → https://registry.npmjs.org/
[WARN] Skip publishing @elinpf/dsh-swarm-bundle@0.0.1 (dry run)
```

**恰好 14 个包，`example-plugin` 未出现（符合预期）。** 退出码 `0`。

### 打包内容核对（`npm pack --dry-run --json`，逐包）

pnpm 的 dry-run 不打印 tarball 清单，故另用 `npm pack --dry-run` 逐包列出实际入包文件。结论：

| 包 | 入包文件 | `lib/` | `src/`/`tests/`/`.runtime/` |
| --- | --- | --- | --- |
| 12 个普通包（team-*、tool-swarm 等） | `lib/*.js`、`lib/*.d.ts`、`lib/*.js.map`、`lib/*.d.ts.map`、`package.json` | ✅ | ❌ 不存在 |
| `bundle` | 同上 + `cordis.patch.yml` | ✅ | ❌ 不存在 |
| `example-plugin`（不发布） | 同 `bundle` | ✅ | ❌ 不存在 |

- **`lib/` 全部在包里**（`main`/`types`/`exports` 指向的产物齐全）。
- **`src/`、`tests/`、`.runtime/`、`tsconfig.json`、`.npmrc`、锁文件均不在包内**（`files` 白名单生效，逐包 grep 校验为 0 命中）。
- 说明：包内含 `*.js.map`/`*.d.ts.map`，其中 `sourcesMapping` 指向 `../src/...`（源码本身不入包）。这是 `files: ["lib"]` 的自然结果，对运行时无影响；如后续要去掉 sourcemap，可在各包 `tsconfig.json` 关掉 `sourceMap`（属发布配置任务范畴）。

---

## 5. 回滚 / 撤包

npm **不允许覆盖已发布版本**；版本号一旦发布就被占用。回滚手段按场景：

### 场景 A：刚发错、且发布时间 < 72 小时、无其它包依赖它

```bash
npm unpublish @elinpf/dsh-swarm-team-core@0.0.2            # 单个包
npm unpublish @elinpf/dsh-swarm-team-core@0.0.2 --force    # 若被依赖/超阈值需强制
```

> `unpublish` 会触发 npm 策略限制（72 小时、下载量、被依赖数），且**不留痕迹**，能不用就不用。

### 场景 B：已超过 72 小时，或不想删除版本（推荐）

1. **发一个新补丁版**修复问题（`0.0.3`），打 tag 重新走流水线。消费者升级即可。
2. 对被污染的版本，用 **deprecate** 打“废弃”标记，让 `npm install` 时给出警告，而不是删除：

```bash
npm deprecate '@elinpf/dsh-swarm-team-core@0.0.2' "已知问题：xxx，请升级到 0.0.3"
```

### 场景 C：只想回滚“最新 tag 指向”

`npm dist-tag` 控制 `latest` 指向哪个版本（不进版本历史）：

```bash
npm dist-tag add @elinpf/dsh-swarm-team-core@0.0.1 latest   # 把 latest 指回旧版
```

> 提醒：本仓是「整族发布」，回滚最好**整族一起**（14 个包同版本），否则会出现版本错配。

---

## 6. 风险与须知

### 6.1 依赖安装脚本被跳过（重要）

`pnpm-workspace.yaml` 显式声明：

```yaml
ignoredBuiltDependencies:
  - '@deepseek-ai/dsh-subprocess-local'
  - '@google/genai'
  - koffi
  - node-pty
  - protobufjs
strictDepBuilds: false
```

原因：pnpm 10+ 默认阻止依赖执行安装/构建脚本。上述依赖经 `autoInstallPeers` 被间接带入且带 native/生命周期脚本，会让 `pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 失败——而 CI 的发布门禁要求 install 步骤必须过，所以显式忽略并把 `strictDepBuilds` 关成「只告警不报错」。

**这带来的真实副作用，必须讲清楚：**

- 本仓自身的 `build` / `test` / `verify` **不需要**这些原生能力——已实测在此配置下三者 `rc=0`（构建、测试、加载验证全过）。
- 但 `node-pty` / `koffi` 是**原生模块**（需编译）。跳过它们的构建只是让**本仓**不受影响；**如果消费者在运行时真的需要这些原生能力，那是消费者自己的安装过程**（在其环境内装全、编译原生模块），与本仓库的发布产物无关。
- 因此：本仓的包**不承诺**替消费者完成任何原生依赖的构建；`@elinpf/dsh-swarm-*` 发布的是纯 JS/TS 产物，原生依赖由消费者自行满足。
- 若将来本仓确实需要其中某个原生构建，应把它加入 `onlyBuiltDependencies` 并在 CI 补齐对应工具链（届时同步更新本文档）。

### 6.2 凭证

- 仓库内**任何文件**都不得出现 token/凭证；不要把本机 `~/.npmrc` 内容拷进仓库。工作流已有预检拦截。
- 建议给 `NPM_TOKEN` 用 **Automation token + 限定 `@elinpf` scope**；定期轮换，轮换只需在 GitHub Secret 里更新值，无需改代码。

### 6.3 不要用系统环境跑发布

本机跑流水线等价命令时**先 `source scripts/env.sh`**，让 node/pnpm/HOME/缓存都在项目 `.runtime/` 内，避免污染系统环境或现有 DSH 实例（见 `docs/env-setup.md`）。

---

## 7. 自检

工作流随仓库提供离线自检脚本（网络受限环境无法下载 `actionlint` 时的等价替代）：

```bash
source scripts/env.sh
node scripts/check-publish-workflow.mjs
```

它校验：YAML 可解析、触发器（`v*` tag + 手动）、`uses` 已钉版本、声明了 `permissions`、无明文凭证、门禁顺序 `build < test < verify < publish`、存在 `NPM_TOKEN` 缺失显式失败、发布参数（`--no-git-checks` / `--access public` / dry-run 预检）。当前结果为 **全部通过**。
