# @elinpf/dsh-swarm-team-ui — 右侧群聊面板（P55）

demo 实例「右侧群聊窗口」的客户端插件源码。**本目录不进 dsh-swarm 的 pnpm workspace**
（`pnpm-workspace.yaml` 的 glob 是 `packages/*`，本目录在顶层 `client/`，不被覆盖），因此
**不影响 `pnpm -r build`**。真正构建在 DSH 的 harness monorepo 内完成（那里才有 `tsdown` 与
`@deepseek-ai/dsh-client-ui-*`）。

## 它做了什么

- 注册一个右侧栏 tab 类型（`kind: 'swarmTeamChat'`，`id: '@elinpf/dsh-swarm-team-ui/chat'`），
  本体挂在槽位 `sidebar.right.pane.tab`；并向 **guide** 贡献一个入口胶囊，
  使「右侧栏 → 加号 → guide」能点开它。
- 内容读**只读投影**：roster 来自原生 `agentTeam` 投影，消息流来自 dsh-swarm 的
  `swarmBus` 投影（team-bus 的 `swarm/bus/broadcast` 折叠），经共享 Session store
  `state.projectionsBySession[leadId].values.<key>` 读到，无 RPC。

## 构建（必须在 harness monorepo 内）

把本目录拷进 harness monorepo **非 `packages/experimental/`** 的路径（`BundleInputIsolation`
拒绝 `packages/experimental/**` 的输入被非实验包引用），例如
`<harness>/packages/client/dsh-swarm-team-ui/`，然后：

```sh
cd <harness>                                   # .runtime/deepseek-harness（0.2.1-rc.3）
pnpm install --prefer-offline                  # 首次；装出 tsdown 与 client-ui 依赖

cd packages/client/dsh-swarm-team-ui
../../../node_modules/.bin/tsc -p tsconfig.json    # 1) 先出 host half：lib/types/index.js
../../../node_modules/.bin/tsdown                   # 2) 出 lib/client.js（浏览器 bundle）+ lib/index.js
```

### 踩坑（务必照做，否则构建红）

1. `tsdown.config.ts` 用 `import { clientBundle } from '../tsdown.client.ts'`（相对 `packages/client/`）。
2. **先 `tsc`** 出 `lib/types/index.js`：`clientBundle(dir, ['lib/types/index.js'])` 的 host 面要求该入口存在。
3. `tsconfig.json` **不要写 `references`**；host 面 `include` 只留 `src/index.ts`（client 半由 tsdown 转译，不走 tsc）。
4. `tsconfig.json` 的 `extends` 指到 **harness 根** `../../../tsconfig.base.client.json`。
5. 包放 `packages/client/**`（会被 `BundleInputIsolation` 判为非实验），**不要放 `packages/experimental/**`**。

## 接进 profile（原型/正式）

1. 把构建好的包链接进目标 profile 的 `node_modules/@elinpf/`：
   ```sh
   ln -sfn <harness>/packages/client/dsh-swarm-team-ui \
           $DSH_HOME/profiles/<profile>/node_modules/@elinpf/dsh-swarm-team-ui
   ```
2. 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: dsh-swarm-team-ui
         name: "@elinpf/dsh-swarm-team-ui"
   ```
3. 起实例（`DSH_HOME` 指向该 home）：`dsh --profile <profile> --port <port>`。

## 怎么点开看到（用户操作）

打开实例页面（带 token）→ 会话右上角**展开右侧栏**（会话头 corner 的展开按钮）→ 右侧栏
tab 条**加号** → **guide** 列表里点「**群聊**」胶囊 → 右侧出现群聊 tab，显示 roster + 广播/多播消息流。

## 验证记录（P55 原型，本机限无浏览器）

- `--dump-config` 含 `- id: dsh-swarm-team-ui`（组合进树）。
- 新端口实例启动**无加载错误**（日志仅 devtools + web 行）。
- 启动页客户端模块表含
  `{"id":"@elinpf/dsh-swarm-team-ui","url":"plugins/??@elinpf/dsh-swarm-team-ui/client.js&rev=<hash>", ...}`。
- 该 bundle 直接拉取 **HTTP 200（6648 bytes）**，含标记 `swarmTeamChat` / `swarmBus` / `群聊` / `window.__ModuleLoader__`。
- ⚠️ **视觉「点开」本机无浏览器，需人工按上面步骤点开确认**（DOM 断言待补）。

## 已知未验（环境受限待办）

- 自动化浏览器 DOM 断言（点击 → tab 出现 → 列表非空）未做，需在有浏览器的环境补；**当前需人工点开确认**。
- `TeamChatTab` 读取投影用的 `useSessions/useSession` hook 取自槽位运行时 props；已按上游
  `client-ui-agent-team` 同款写法，**但未在本环境做类型级核对**（tsdown 不做类型检查）。上生产前建议跑一次 `tsc` 类型核对。

## demo 实例接入记录（P55）

- 已接入 demo profile `dsh-swarm-demo`：`node_modules/@elinpf/dsh-swarm-team-ui` 软链 + `cordis.patch.yml` 追加该 row。
- `systemctl restart dsh-swarm-demo` 后：journal **无 error/fail/warn**；启动页客户端模块表含本插件；
  其 `client.js` **HTTP 200（6648 bytes）**，含 `swarmTeamChat`/`swarmBus`/`群聊`。
- 用户看板 URL：`http://127.0.0.1:3099/?token=<journal 里的 token>`（重启会换）。
