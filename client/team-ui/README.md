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

## P63：对齐 Jiuwen 观感（发言人 / `@chip` / 定向可视化）

- 新增纯逻辑 `src/client/chat-format.ts` + 单测 `tests/chat-format.spec.ts`（**11/11**）：
  - **发言人显示名** `displayNameOf`：**中文优先** —— ① 含 CJK 的 `displayName` → ② 像人名的**短中文标题** → ③ 其它 `displayName` → ④ 回退英文 ID（`name`）；
  - **头像首字母** `avatarInitial`（中文取首字、英文取首字母大写）；
  - **`@chip`** `parseMentions`：正文 `@名字` 切段，命中已知成员名高亮、未知也成 chip 不崩；
  - **定向/指派可视化**（**只做展示**）`renderMessage`：`outbound` → 前导「→ @目标…」；`task` 指派形态 → 「@某人 收到任务：<标题>」（**防御式**，当前数据流可能无此输入）；
  - **排序/去重不变** `orderMessages`：`seq` 升序 + 同 `id` 去重（`newestFirst` 反转）。
- `TeamChatTab.tsx`：头像 + 显示名 + `@chip` 渲染；成员补 `sessionTitle` 候选。**可见范围/排序去重沿用 P61，不变。**

### 已知缺口：中文显示名缺「干净数据源」

1. **现状**：面板**显示英文 ID**（如 `researcher-models`/`synthesizer`/`lead`），**不是** Jiuwen 那样的干净中文名。
2. **成因（实测依据）**：`agentTeam` 投影的成员**只有 `name`（kebab 英文）**，无中文 `display_name`；而成员会话的 `sessionTitle` **虽是中文，却是 spawn 提示前缀**（实例：`"你是团队中的调研成员 researche…"`、`"你是 doc-writer，一个团队中的…"`，见 `.runtime/dsh-home-verbose/sessions/**` 的 `session/title` 事件）——**不适合当显示名**，故解析器**拒绝**这类长/含空白标题。
3. **解锁条件**：**由数据侧在成员上暴露一个真正的中文 `display_name` 字段**（或把中文角色名写进 wire 可读字段）。届时 **本包解析器已就绪、`零代码改动`即可优先取用**（`displayNameOf` 的 ① 分支）。
4. **不建议**为此改 `team-bus`：spawn 走原生 `tool-agent-team`，我们**截不到 spawn 参数**，改 bus 也解决不了。

## P66：像素级对齐 Jiuwen 群聊详情区

- 按 `docs/jiuwen-chat-ui-spec.md` 在 `TeamChatTab.tsx` 重建**群聊详情区**：容器 `px-7 py-6` + 内层 `max-w-[820px] space-y-5`、消息行 `gap-3`、发送者名 16/28/600、正文 14/24、头像 32×32 rounded-xl、定向 chip（p2p 蓝/broadcast 橙）、正文 `@` 链接蓝、空态「暂无群聊消息」、置底+40px 阈值、时间 `HH:mm:ss`。
- **逐条 checklist + 与 Jiuwen 对比自查表**：见 [`P66-CHECKLIST.md`](./P66-CHECKLIST.md)（含 in/out-of-scope 归因）。
- **中文显示名（本地映射，非数据侧真值）**：`chat-format.ts` 的 `LOCAL_DISPLAY_NAMES`（`slug→中文名`）在数据侧无真值时兜底；**可配置**（传参覆盖/传 `{}` 禁用）；数据侧若提供 `displayName`/中文 `title` 则**优先取用**。**显式标注：本地映射、非数据侧真值。**
- **头像适配**：Jiuwen 用 svg 资产；本包**无资产**，改用**首字符 + 24 色哈希底**（形状/尺寸/色值对齐）。
- **不在本插件范围**（显式，见 checklist）：左 240px 侧栏/成员列表/成员·子话题 Tab → **P67**；输入框 composer 的 `@`/`$` 候选下拉 → **P68**；主对话流 `team-member-message` 镜像 → **待上游**。

## P67：面板内左侧栏（成员列表 + 成员/子话题 Tab）

- 在 pane 内做**左右两栏**：左 **240px** 侧栏（`LeftRail`）+ 右群聊详情；**不改右栏 tab 外部契约**。
- 左栏含：Tab「成员 / 子话题」（`rounded-md p-1`、选中 `bg-card font-semibold shadow-sm`、`h-8`）+ 群聊入口行（32×32 首字符头像 +「群聊」+ 成员名 `、`）+ 成员列表项（头像 `rounded-full` 32×32 + 显示名 + 第二行 `@slug` + 状态点）。数据源：`agentTeam` 投影（`id/name/role/phase`）+ P66 本地显示名映射。
- **需适配/不可迁移（不造数据）**：
  - **「子话题」**：DSH 无该概念（Jiuwen 来自 `team.event:` 子话题流）→ **Tab 保留、内容为空态 + 说明**；解锁条件=数据侧提供子话题镜像。
  - 成员列表第二行 `@member_id`：**DSH id 是 UUID、不可读** → 以 **slug 名**（`@<slug>`）替代。
  - **响应式**：窄宽用「**自动隐藏侧栏 + 一个展开/收起按钮**」的**合理降级**（**非 Jiuwen 原生行为**）。
- 左栏**只读**（不含 composer；composer 属 P68）。
- 逐条见 [`P66-CHECKLIST.md`](./P66-CHECKLIST.md) 的「P67 增补」。

## P68-A：composer（输入框 + `@` 候选下拉）——功能扩展，**已于 P72 经用户确认移除**

> ⚠️ **状态：已移除（P72）**。以下为历史记录（保留以示「曾实现 → 经用户确认移除」）。

- **通道（A）**：复用**会话提示 seam**（`dsh-api-session-controller/client` 的 `ctx.sessions.binding(id).session.prompt(text,'queue')`，与**主 composer 同源**）→ 把输入作为**一条 user 消息注入 Lead 会话**。**零后端、可逆**。
- **⚠️ 语义限制（composer 上方显眼标注，非藏 README）**：此输入 = **向团队 Lead 说话**（等价主输入框）；**≠ 向某成员直发**；**不计入本栈未读/兜底**（P51 边界）；**会触发 Lead 一轮、计入 token**。
- **UI（照 spec 数值）**：候选下拉 `min(360px,100%)` / 圆角 **14px** / item 高 **44px** / header **34px** / list `max-h 266px` / avatar **26×26**；inline chip 高 **24px** / 圆角 **6px** / 蓝渐变底；触发正则 `/([@$])([\p{L}\p{N}_\-\u4e00-\u9fa5]*)$/u`。
- **`@` 语义**：候选来自成员名册；选中**插入 inline chip 文本**（展开为 **`@<name>`**，**非 UUID**——DSH id 不可读，**已标注**）；**A 只落文本**，结构化 `multicast targets` **仅 B（需后端）能做**。
- **硬要求（已实现）**：**仅人工显式提交**（无自动发送）；**turn 进行中禁用**（读 `byId[id].running`）；**去重/限速**（1500ms，防 send→turn→send 自激）；**失败可见**（`role=alert` 错误行，不静默）；取不到 session 句柄时给**明确错误**（「会话通道不可用…未发送」）。
- **B（全保真，需后端）暂缓**：结构化 `targets` + human seat/lead 身份 → 超出「只改 `client/team-ui`」，归属待定（见 [`P68-PROPOSAL.md`](./P68-PROPOSAL.md)）。

## P72：移除 composer（面板恢复只读）

- **背景（用户拍板）**：P68-A 的 composer 语义 =「**向团队 Lead 说话（等价主输入框）**」——**不能定向发成员、不进本栈、不覆盖兜底**，**与主输入框冗余**，故**用户确认后移除**（**B 方案也未选**）。
- **改动**：删除 `Composer.tsx` / `composer.ts` / `session-prompt.ts` 及其挂载与 `inject`（`TeamChatTab.tsx` / `index.ts`）；删除 `composer.spec.ts`。**保留 P66/P67 成果**（详情区 + 240px 左栏 + 成员/子话题 Tab），**只去掉底部输入区**。
- **验证**：`chat-format.spec.ts` **14/14 绿**；原型 bundle **HTTP 200** 且 **composer 标记为 0**（`chat-composer-suggestion`/`向团队 Lead 说话` 均无），`子话题`/`swarmTeamChat` 保留。
- **保留的两条登记**：
  1. **B（真·定向发成员 / 结构化 targets / human seat 或 lead 身份）→ 需新增服务端 remote**（超出只改 `client/team-ui`，归属待定；见 [`P68-PROPOSAL.md`](./P68-PROPOSAL.md)）；
  2. **主对话流 `team-member-message` 协作消息镜像 → 待上游**（见 [`docs/p61-upstream-request.md`](../../docs/p61-upstream-request.md)）。

## P75：群聊消息开启 Markdown 渲染（复用宿主 + XSS 防护）

- **渲染方式：复用宿主渲染器**（非自实现）——`@deepseek-ai/dsh-client-ui-primitives` 的 **`MarkdownText`**（**与主对话流同源**；doc 自称 "**Untrusted** assistant-Markdown renderer"，mdast→React 管线）。群聊消息**正文**由 `<MarkdownText text={…} labels={MARKDOWN_LABELS} variant="compact" />` 渲染 ⇒ 支持 粗体/斜体/行内代码/代码块/列表/标题/链接/段落（GFM）。
- **样式**：沿用宿主 prose；消息行**发送者名 16/28/600、正文 14/24 不变**。
- **⚠️ 安全（硬要求，内容视为不可信）**：① **禁 raw HTML**——宿主无 HTML 解析入口（`render.tsx` `case 'html'`：raw HTML 保持**字面文本**）；② **链接安全化**——`sanitizeUrl`（`render.tsx:53`）仅放行 `http/https/mailto`（挡 `javascript:`），外链 `rel="noopener noreferrer"`；③ **XSS 反例单测** `tests/markdown-safety.spec.ts`（**2/2**）。
- **取舍（如实标注）**：复用宿主 ⇒ 正文 `@name` 随 Markdown 渲染为**文本**；`@chip` 仅保留于前导定向段。
- **验证**：`markdown-safety` 2/2 + `chat-format` 14/14；原型 bundle HTTP 200 含 `MarkdownText` 引用、composer 标记=0。

