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
5. 包放 `packages/client/**`（会被 `BundleInputIsolation` 判为非实验），**不要放 `packages/experimental/**`\*\*。

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
         name: '@elinpf/dsh-swarm-team-ui'
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
- ✅ **类型核对：已做**（原「未验」项已升级）。方式与结果见下。

## 类型核对（已做，P55）

`tsdown` 不做类型检查，故单独用 harness 的 `tsc` 对本包 `src/**` 做了一次核对：

```sh
cd <harness>/packages/client/dsh-swarm-team-ui
../../../node_modules/.bin/tsc -p tsconfig.typecheck.json   # extends harness tsconfig.base.client.json
```

- **本包源码（`src/**`）错误数 = 0**（修正项：删去未用的 `TeamKey` 导入；`props.t`以显式键联合签名收窄，避免`PropsLocale`键推导在本 build 下不收`roster/messages/empty`）。
- 输出中仍会看到大量**其它包**（`packages/api/**`、`packages/attachment/**` 等）的错误——那是 harness 全量 `paths→src` 解析 + 未构建 `*/remote` 声明造成的**既有环境噪声**，与本包无关（本包零错误）。
- `tsconfig.typecheck.json` 随本目录交付，便于复跑。

## demo 实例接入记录 + 回滚（P55）

- 已接入 demo profile `dsh-swarm-demo`（**只加一行，未动其它配置**）：
  1. `ln -sfn <harness>/packages/client/dsh-swarm-team-ui $DSH_HOME/profiles/dsh-swarm-demo/node_modules/@elinpf/dsh-swarm-team-ui`
  2. `$DSH_HOME/profiles/dsh-swarm-demo/cordis.patch.yml` 追加：
     ```yaml
     - insert:
         - id: dsh-swarm-team-ui
           name: '@elinpf/dsh-swarm-team-ui'
     ```
  3. `systemctl restart dsh-swarm-demo`。
- 自证：journal **无 error/fail/warn**；启动页客户端模块表含本插件；其 `client.js` **HTTP 200（6648 bytes）**，含 `swarmTeamChat`/`swarmBus`/`群聊`。
- 用户看板 URL：`http://127.0.0.1:3099/?token=<journal 里的 token>`（重启会换）。
- **回滚（移除该 tab）**：删除 `cordis.patch.yml` 里那段 `- insert: … dsh-swarm-team-ui`（或加 `disabled: true`）→ `systemctl restart dsh-swarm-demo`；如需彻底移除再删软链。**一行 patch + 重启即可**。

## 可复跑验证命令（一条条复现当前证据）

设：`H=<harness 绝对路径>`（如 `.runtime/deepseek-harness`）、`PROF=dsh-swarm-demo`、`PORT=3099`、`DSH_HOME=<...>/.runtime/dsh-home`。

```sh
# 0) 前置：harness 已装依赖（首次）
cd $H && pnpm install --prefer-offline

# 1) 重建 bundle（先 tsc 出 host 入口 lib/types/index.js，再 tsdown 出 lib/client.js）
cd $H/packages/client/dsh-swarm-team-ui
../../../node_modules/.bin/tsc -p tsconfig.json
../../../node_modules/.bin/tsdown

# 2) 组合树确实含本行
DSH_HOME=$DSH_HOME node $H/../dsh-cli-npm/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile $PROF --dump-config | grep -n dsh-swarm-team-ui

# 3) 取当前实例 token（重启会变）
T=$(journalctl -u $PROF --no-pager -n 80 | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1 | cut -d= -f2)

# 4) 拉启动页（带 token）→ 断言 200 且客户端模块表含本插件
curl -sL -c /tmp/cj -b /tmp/cj -o /tmp/page.html -w "page=%{http_code}\n" \
  "http://127.0.0.1:$PORT/?token=$T"
grep -c '@elinpf/dsh-swarm-team-ui' /tmp/page.html          # 期望 >=1
REV=$(grep -oE "dsh-swarm-team-ui/client\.js&rev=[a-f0-9]+" /tmp/page.html | head -1 | sed 's/.*rev=//')

# 5) 直接拉该客户端 bundle → 断言 200 且含我们的标记
curl -s -b /tmp/cj -o /tmp/bundle.js -w "bundle=%{http_code} bytes=%{size_download}\n" \
  "http://127.0.0.1:$PORT/plugins/??@elinpf/dsh-swarm-team-ui/client.js&rev=$REV"
grep -oE 'swarmTeamChat|swarmBus|群聊|window.__ModuleLoader__' /tmp/bundle.js | sort | uniq -c

# 6) 日志无加载错误
journalctl -u $PROF --no-pager -n 80 | grep -iE 'error|fail|warn' || echo '(none)'
```

**判定**：步骤 4 `page=200` 且 grep≥1；步骤 5 `bundle=200` 且打印出 `swarmTeamChat`/`swarmBus`/`群聊`/`__ModuleLoader__`；步骤 6 无 error/fail/warn。**本环境无浏览器**，故「点开看到」需人工按上文「怎么点开看到」操作；DOM 断言待补。
