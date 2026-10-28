# Jiuwen 群聊 UI 规格（像素级迁移用）—— 组件 / 样式数值 / 交互 / 数据契约 / 迁移 checklist

> 产出人：interaction-analyst ｜ 任务：P65-jiuwen-chat-ui-spec ｜ 时间：2026-10-28
> 性质：**只读调研 + 新写一份文档，不改任何 `packages/*/src`**（实现归 P66）。
> Jiuwen 前端权威源：`/root/repo/jiuwenswarm/jiuwenswarm/channels/web/frontend/src/`（下称 `src/`）
> DSH 侧数据模型旁证：`docs/investigation/01-core-model.md`（引用其 `path:line`，均为 harness checkout `.runtime/deepseek-harness` 内）
> 约定：**【事实】**=读到源码；**【推断】**=合理推出未逐行验证；**【需适配】**=DSH 缺对应字段/语义。
> 说明：Jiuwen 的「群聊」**不是一个跨成员聊天频道**，而是**团队区（team area）里的一个只读协作过程视图**（tab「子话题 / group」）+ **每个成员的协作消息都镜像进主对话流**。下文先给群聊面板，再给主对话流消息，再给输入框 @。

---

## 0. 一句话总览

- **群聊面板**：团队区展开态左侧栏选「子话题（group）」，右侧 `GroupChatDetail` 按时间升序**逐条不折叠**展示所有成员协作消息（`team.event:` 中非 leader→user 的消息）。
- **主对话流**：协作消息被分组成 `teamEventGroup`，**不折叠**逐条展开；leader→user 的消息单独作为 `team.leader:` 卡片。
- **@ 机制**：输入框打 `@`（成员）/`$`（角色）触发候选下拉，候选来自当前会话成员名册（排除 `user`），选中插入一个 inline chip（展开为 `@member_id`）。
- **头像**：`TeamMemberAvatar` 按成员 id 确定性派生（leader/user/cli/human/member 五类），不入库。

---

## 1. 组件树 + DOM 结构

### 1.1 群聊面板（团队区展开态）

```
TeamMembersPanel (variant='expanded')                       src/components/teamArea/TeamMembersPanel.tsx:194-274
└─ div[data-testid=team-area-members-panel][data-variant=expanded]  .flex.min-w-0.flex-1.overflow-x-auto
   ├─ aside[data-testid=team-area-members-sidebar]          :200-253   .w-[240px].shrink-0.border-r.bg-card
   │  ├─ div.px-[24px].pt-[24px]
   │  │  └─ DetailTabSwitch   [data-testid=team-area-detail-tab-switch]  :277-309
   │  │     └─ button「成员」(members) / button「子话题」(group)  :291-306
   │  └─ div.space-y-3.px-[24px].py-4  [team-area-members-sidebar-list]
   │     └─ 【group tab】群聊入口行 [data-testid=team-area-member-item][data-variant=group-chat]  :209-236
   │        ├─ span 群聊头像  h-8 w-8 rounded-full（首字符 + getSkillAvatar 底色）  :216-221
   │        ├─ span「群聊」(team.groupChat)  text-sm font-semibold  :225-227
   │        └─ span 群成员名（leader + 各成员 display name，`、` 分隔）text-xs  :229-234
   └─ 【group tab】GroupChatDetail                            :311-355
      └─ section[data-testid=team-area-group-chat]  .flex.min-w-0.flex-1.flex-col.bg-card
         └─ div.team-group-chat-message-list.min-h-0.flex-1.overflow-y-auto.px-7.py-6
            [data-testid=team-area-group-chat-message-list]  :332-336
            ├─ 空态 div[team-area-group-chat-empty] .flex.h-full.items-center.justify-center.text-sm.text-text-muted  :338-344
            └─ div.mx-auto.max-w-[820px].space-y-5        :346
               └─ GroupChatMessage ×N                     :357-400
                  └─ div.flex.items-start.gap-3 (+justify-end 若 user)
                     ├─ TeamMemberAvatar h-8 w-8           :364
                     ├─ div.min-w-0 (user: max-w-[72%].text-right | 否则 flex-1)
                     │  ├─ div.pb-2.text-base.font-semibold.leading-7  [team-area-group-chat-message-sender]  :366-371
                     │  └─ div.text-sm.leading-6 (user: inline-block rounded-lg bg-accent-subtle px-3 py-2)  :372-375
                     │     ├─ span.team-event-group-chip.team-event-group-chip--p2p      @<to>      :375-382
                     │     ├─ span.team-event-group-chip.team-event-group-chip--broadcast @所有人     :383-390
                     │     └─ MarkdownMessageBody.team-message-markdown.--inline                     :391-394
                     └─ TeamMemberAvatar h-8 w-8 (仅 user，右侧)  :397
```

**【事实】侧栏团队列表行（成员 tab）** `MemberListItem`（`src/components/teamArea/MemberListItem.tsx:38-121`）：`button[team-area-member-item]` `.flex.w-full.items-center.gap-3.rounded-md`（`px-[8px] py-[9px]`）；头像 `TeamMemberAvatar h-8 w-8 rounded-full`（`:51-56`）；主行 display name `text-sm truncate font-semibold`（`:60-66`）；**第二行固定 `@member_id`** `text-xs text-[var(--color-team-member-item-id-text)]`（`:71-76`）；右侧状态/进度环 32×32（`:84-114`）。

### 1.2 主对话流中的团队消息

```
MessageList → buildRenderItems → 三类渲染项：message / toolGroup / teamEventGroup
   src/components/ChatPanel/TEAM_MESSAGE_DISPLAY_LOGIC.md:55-84
TeamEventGroupDisplay   (teamEventGroup)                    src/components/ChatPanel/TeamEventGroupDisplay.tsx
MessageItem             (单条 system 消息，按 content 前缀分派)   src/components/ChatPanel/MessageItem.tsx:369-1020
├─ content 以 `team.event:` 开头  :682
│  ├─ event.isLeaderToUser 或 isTeamP2PMessageToUser → TeamLeaderPlainTextMessage  :686-699
│  └─ 否则（p2p / broadcast）→ TeamMemberMessageFrame          :703-728
│     └─ div.team-member-message__card                          .w-fit.max-w-[min(82%,720px)]
│        └─ div.team-member-message__content
│           ├─ span.team-event-group-chip--p2p      @<toMember>      :711-715
│           ├─ span.team-event-group-chip--broadcast <t('chat.teamBroadcastTarget')>  :716-720
│           └─ MarkdownMessageBody.team-message-markdown.--inline    :721-724
├─ id 以 `team-leader-` 开头 → TeamLeaderPlainTextMessage      :739-768
└─ id 以 `team-member-` 开头 → TeamLeaderPlainTextMessage(member=…)  :773-788
```

**【事实】`TeamMemberMessageFrame`**（`MessageItem.tsx:121-182`）：
```
div.team-member-message.animate-fade-in                     :165   （.width:min(100%,920px); margin:0 auto 12px; flex column; gap:6px）
├─ div.team-member-message__header  （showAvatar 时）        :167-176  .flex.items-center.gap:8px
│  ├─ AgentAvatar | TeamMemberAvatar
│  └─ span.chat-avatar-name                                  （font-size 13px; font-weight 600）
└─ div.team-member-message__body (+contentClassName)         :177-179
   └─ div.team-member-message__plain  （纯文本/markdown 正文）  :226
      └─ A2UIMessageContent
   └─ div[chat-panel-message-meta].text-sm.text-text-meta    :234-241  时间戳
```

### 1.3 输入框（`$`/`@` 触发）

```
InputArea  src/components/ChatPanel/InputArea.tsx
├─ contenteditable div（输入区）  → 插入 inline chip
│  └─ span.chat-input-chip-inline.chat-input-chip-inline--member   :2551-2560
│     ├─ span.chat-input-chip-inline__prefix  文本 `@`（role 时 `$`）  :2556-2558
│     ├─ span.chat-input-chip-inline__label   展示名                 :2560-2562
│     └─ button.chat-input-chip-inline__remove  删除（close svg）    :2564-2567
└─ 候选下拉 ComposerSuggestion（:5045-5240）
   └─ div.chat-composer-suggestion[data-testid=chat-panel-composer-suggestion]  :5124-5130
      ├─ div.chat-composer-suggestion__header              :5133-5139
      └─ div.chat-composer-suggestion__list                :5140-5144
         └─ div.chat-composer-suggestion__item(._--active)  :5174-5183
            ├─ span.chat-composer-suggestion__avatar → TeamMemberAvatar.chat-composer-suggestion__team-avatar :5222-5224
            └─ span.chat-composer-suggestion__text
               ├─ span.chat-composer-suggestion__label  展示名   :5226
               └─ span.chat-composer-suggestion__meta   `@member_id`  :5227
```

---

## 2. 样式数值（像素级）

> 变量定义：`src/styles/foundation.css`（shape/typography）、`src/styles/themes/default/light.css`（颜色）。Tailwind 类（如 `gap-3`=12px、`px-7`=28px、`py-6`=24px、`max-w-[820px]`）按 Tailwind v3 默认刻度。

### 2.1 全局 token

| token | 值 | 来源 |
|---|---|---|
| `--radius-sm` | **6px** | `foundation.css:8` |
| `--radius-md` | 8px | `foundation.css:9` |
| `--radius-lg` | **12px** | `foundation.css:10` |
| `--radius-xl` | 16px | `foundation.css:11` |
| `--radius-full` | 9999px | `foundation.css:13` |
| `--font-size-2xs` | **11px** | `foundation.css:39` |
| `--font-size-xs` | 12px | `foundation.css:38` |
| `--font-size-sm` | **13px** | `foundation.css:37` |
| `--font-size-base` | 14px | `foundation.css:35` |
| `--font-size-lg` | 16px | `foundation.css:36` |
| `--font-body` | `"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif` | `foundation.css:4` |
| `--color-text-primary` | **#191919** | `light.css:43` |
| `--color-text-strong` | #18181b | `light.css:45` |
| `--color-text-secondary` | **#777777** | `light.css:47` |
| `--color-text-meta` | **#808080** | `light.css:53` |
| `--color-text-placeholder` | #808080 | `light.css:52` |
| `--color-text-link` | **#0067d1** | `light.css:59` |
| `--color-border-default` | **#e4e4e7** | `light.css:64` |
| `--color-action-primary` | **#2563eb** | `light.css:85` |
| `--color-action-primary-rgb` | 37,99,235 | `light.css:86` |
| `--color-action-secondary` | #f4f4f5 | `light.css:93` |
| `--color-action-secondary-rgb` | 244,244,245 | `light.css:94` |
| `--color-surface-card` | **#ffffff** | `light.css:24` |
| `--color-feedback-info` / `-rgb` | **#2563eb** / 37,99,235 | `light.css:119-120` |
| `--color-feedback-warning` / `-subtle` | **#d97706** / rgba(217,119,6,.1) | `light.css:109-111` |
| `--color-team-status-*` | waiting #777777 / running #5e7ce0 / completed #088c58 / cancelled #c84646 | `light.css:315-322` |

### 2.2 群聊面板

| 元素 | 数值 | 来源 |
|---|---|---|
| 侧栏宽 | **240px**（`w-[240px]`） | `TeamMembersPanel.tsx:201` |
| 侧栏内边距 | `px-[24px]`（左右24）/ 列表 `py-4` | `:204,208` |
| Tab 切换容器 | `rounded-md p-1`，底色 `var(--color-tag-surface)` | `:288` |
| Tab 按钮 | `h-8`（32px）`rounded text-center`；选中 `bg-card font-semibold shadow-sm` | `:294,302` |
| 群聊入口行 | `rounded-md px-[8px] py-[9px]`；选中底色 `var(--color-tool-tab-active-bg)` | `:211` |
| 群聊头像 | **32×32（h-8 w-8）`rounded-full`**，文字=群聊名首字符 | `:216-221` |
| 群聊天列表容器 | `px-7 py-6`（28/24），`overflow-y-auto` | `:334` |
| 列表内层 | `mx-auto max-w-[820px] space-y-5`（下间距**20px**） | `:346` |
| 消息行 | `flex items-start gap-3`（**gap 12px**） | `:363` |
| 消息头像 | **h-8 w-8**（32×32） | `:364,397` |
| 发送者名 | `pb-2 text-base font-semibold leading-7`（**16px/28px，下内边距 8px**） | `:366-371` |
| 正文本体 | `text-sm leading-6`（**14px/24px**） | `:372-373` |
| user 气泡 | `inline-block rounded-lg bg-accent-subtle px-3 py-2 text-left`，列 `max-w-[72%] text-right` | `:365,373` |
| 群聊内 @chip | 背景 transparent；色 `var(--color-text-link)` **#0067d1**；`font-size:14px; font-weight:400` | `index.css:1770-1776` |
| 群聊内 markdown | `font-size:14px; line-height:22px` | `index.css:1778-1781` |
| 空态 | `h-full flex items-center justify-center text-sm text-text-muted` | `:339-343` |

### 2.3 @chip（通用，非群聊列表内）

`.team-event-group-chip`（`index.css:1748-1757`）：`display:inline-flex; align-items:center; margin-right:6px; padding:1px 6px; border-radius:var(--radius-sm)=6px; font-size:var(--font-size-2xs)=11px; font-weight:600; line-height:1.5`。
- `--p2p`：`background:rgba(var(--color-feedback-info-rgb),0.16); color:var(--color-feedback-info)`（蓝 #2563eb）`index.css:1759-1762`。
- `--broadcast`：`background:var(--color-feedback-warning-subtle); color:var(--color-feedback-warning)`（橙 #d97706）`index.css:1764-1767`。
- 目标文案：p2p = `@<getMemberDisplayName(toMember)>`（`TeamMembersPanel.tsx:380` / `MessageItem.tsx:713`）；broadcast = `@所有人`（`chat.teamBroadcastTarget`=`@所有人`，`zh.json:1011`；群聊面板用 `@{team.allMembers}`→`@所有人`，`TeamMembersPanel.tsx:388`）。

### 2.4 主对话流团队消息（`team-member-message` 家族）

| 元素 | 数值 | 来源 |
|---|---|---|
| 容器 | `width:min(100%,920px); margin:0 auto 12px; flex column; gap:6px` | `index.css:1457-1464` |
| header | `flex items-center gap:8px` | `index.css:1466-1470` |
| `__card`（p2p/broadcast 卡） | `width:fit-content; max-width:min(82%,720px); border-radius:12px(var(--radius-lg)); border:1px solid #e4e4e7; background:rgba(244,244,245,0.72); padding:10px 12px; font-size:13px; line-height:1.65` | `index.css:1482-1494` |
| `__plain` | `font-size:13px; line-height:1.75; white-space:pre-wrap; color:#191919` | `index.css:1501-1509` |
| `__plain.chat-markdown` | `white-space:normal` | `index.css:1511-1513` |
| `chat-avatar-name` | `font-size:13px; font-weight:600; color:#191919` | `index.css:1973-1977` |
| 富文本文件列表 | `chat-message-file-list { width:100% }` | `index.css:1478-1480` |

### 2.5 通用聊天气泡（用户/助手，供参考对齐）

`.chat-bubble`（`index.css:950-957`）：`background:var(--color-chat-bubble-default); border-radius:24px 0 24px 24px; padding:16px 20px; color:#191919`。
- `.chat-bubble.user`：`width:fit-content; max-width:calc(100% - 88px); margin-left:auto`（`index.css:959-965`）。
- `.chat-bubble.assistant`：`background:transparent; border-radius:0; padding:0`（`index.css:967-973`）。
- `.assistant-row { gap:10px; align-items:flex-start }`；`.assistant-row__avatar { width:32px; margin-top:2px }`（`index.css:998-1011`）。

### 2.6 头像 `TeamMemberAvatar`

- 容器默认：`h-8 w-8 shrink-0 overflow-hidden rounded-xl`；`<img>` 默认 `rounded-2xl`（`kind==='user'` 时 `rounded-xl`；`kind==='cli'` 时 `scale-[0.72] object-contain`）（`src/components/TeamMemberAvatar/index.tsx:48-68`）。
- ⚠️ 数值不一致（**【事实】**）：`README.md:56` 说默认 `h-9 w-9`，代码实际 `h-8 w-8`（`index.tsx:53`）。**以代码 h-8 w-8 为准**。
- 派生规则（`src/utils/teamMemberAvatar.ts`）：规范化 `trim→lower→[空格/-]转_`（`:72-74`）；`team_leader|teamleader`→`teamleader.svg`（`:137-143`）；`user`→`user-in-team.svg`（`:145-151`）；CLI（claude/codex）→ 品牌 svg + 中性底 `#F2F3F5`（`:155-163,31`）；human→`user-in-team.svg`+哈希底（`:169-176`）；其余→`Team-2..6.svg` 哈希（`:178-183`）。
- 底色池 `TEAM_MEMBER_BACKGROUND_COLORS` 24 色（`#D7F4EE`,`#FCE0E0`,…），FNV 哈希 `id:avatar-bg`（`:33-58,102-105`）。
- 列表项不同形态：`MemberListItem` 用 **`rounded-full`**（`MemberListItem.tsx:51-56`）；群聊消息/主对话用默认 **`rounded-xl`**（`TeamMembersPanel.tsx:364`）。

### 2.7 输入框 chip 与候选下拉

`.chat-input-chip-inline`（`ChatPanel.css:897-913`）：`gap:4px; height:24px; margin:0 2px; padding:0 8px 0 6px; border-radius:6px; font-size:12px; line-height:1.4`。
- `--member/--role`：`background-image:linear-gradient(rgba(37,99,235,.12),rgba(37,99,235,.12)); color:#2563eb`（`ChatPanel.css:915-922`）。
- `__prefix`：`font-weight:700`；`__label`：`max-width:200px` ellipsis；`__remove`：`14×14`（`ChatPanel.css:924-963`）；member/role 的删除按钮为静态定位、色 `#2563eb`（`:987-993`）。
- `.chat-composer-suggestion`（`ChatPanel.css:1039-1050`）：`position:absolute; left:16px; bottom:calc(100% + 8px); z-index:35; width:min(360px,calc(100% - 32px)); border:1px solid var(--color-chat-card-border); border-radius:14px; background:#fff; box-shadow:var(--effect-chat-select-shadow)`。
- `__header`：`height:34px; padding:0 12px; font-size:12px; font-weight:650`（`:1052-1062`）。
- `__list`：`max-height:266px; margin:6px 0; padding:0 6px`（`:1064-1069`）。
- `__item`：`gap:10px; height:44px; border-radius:9px; padding:0 10px`（`:1075-1089`）；hover/active `background:rgba(37,99,235,.08)`（`:1091-1096`）。
- `__avatar`：`26×26; border-radius:9px; color:#2563eb; background:var(--color-action-primary-subtle)`（`:1102-1112`）。
- `__label`：`font-size:13px; line-height:18px; color:var(--color-text-suggestion-label)=#282828`（`:1134-1140`，`light.css:56`）。
- `__meta`：`font-size:11px; line-height:14px; color:var(--color-text-placeholder)=#808080`（`:1141-1145`）。

---

## 3. 交互行为

### 3.1 `@` / `$` 触发与候选

**【事实】触发**（`InputArea.tsx:2334-2360`）：对光标前文本做正则 `/([@$])([\p{L}\p{N}_\-\u4e00-\u9fa5]*)$/u`：
- `@` → `kind:'member'`；`$` → `kind:'role'`。查询串 `query` = `@` 后的已输入字符（支持中英文/数字/`_`/`-`）。
- 另支持 `/` 触发 slash 命令（`/>([a-zA-Z][\w-]*)`）。
- **候选来源**：`mentionableMembers` = 当前会话 `teamMembers` 过滤（id 非空且 `id !== 'user'`），映射 `{id: member_id, label: name || member_id, status}`（`InputArea.tsx:1058-1066`）。**无可 @ 成员时不弹**（`:2357-2360`）。

**【事实】候选下拉渲染**（`InputArea.tsx:5124-5230`）：分 section（成员/角色/技能/命令）。成员项显示头像 `TeamMemberAvatar`、`__label`=展示名、`__meta`=`@` + `member_id`（`:5222-5227`）；role 项前缀 `$`，其余 `@`（`:5074`）。

**【事实】选中后插入**（`InputArea.tsx:2530-2570`）：先在 contenteditable 中删除已输入的触发文本（`trigger.query.length + 1` 个字符，`:2548-2556`），再插入 `<span class="chat-input-chip-inline chat-input-chip-inline--member" contenteditable=false data-composer-token="member" data-value="<member_id>">`，内含 prefix `@`、label 展示名、删除按钮；末尾补一个空格；光标移到空格后。
- **提交时展开**：`extractPlainText` 把 chip 还原为 `@{data-value}`（role 为 `${data-value}`）（`:2021-2028`）。即最终发给后端的是 `@member_id` 文本，由后端做 mention 路由（对应 Jiuwen `interaction/router.py` 的 `@` 语法）。

### 3.2 发送 / 分组 / 聚合 / 折叠

- **发送**：输入区 contenteditable 提取纯文本；chip 展开为 `@member_id`（见上）。发送后进对话流与团队协作流。
- **主对话流分段排列**（`TEAM_MESSAGE_DISPLAY_LOGIC.md:55-84`）：`buildRenderItems` 产出 `message` / `toolGroup` / `teamEventGroup`。一个「段」累积工具执行与协作消息，遇**用户消息**或**最终消息**（`assistant` 非流式，或 `team-leader-*` 且 `team.leader:`）即 flush。典型顺序：`用户消息 → 工具执行组 → 成员协作消息组 → 中间过程消息 → team_leader 最终消息`。
- **协作消息组**（`TeamEventGroupDisplay`）：**不折叠**，按原顺序逐条展开；每条用 `from_member` 的头像+名称；**连续同一成员的事件可隐藏重复头像**（`TEAM_MESSAGE_DISPLAY_LOGIC.md:86-100`）。组可「展开群聊」跳转团队区 group tab（`TeamEventGroupDisplay.tsx:487-493,537`，i18n `chatUi.teamActivity.openGroupChat`=展开群聊）。
- **群聊面板**：`buildGroupMessageItems` 取 `mergeUniqueMessages(history + messages)`，解析 `team.event:`，**过滤掉 `isLeaderToUser`**，按时间升序（`TeamMembersPanel.tsx:59-72`）。→ leader 面向用户的消息**不进群聊**，留在主对话流（`TEAM_MESSAGE_DISPLAY_LOGIC.md:114-116`）。

### 3.3 时间显示

- 消息 meta 时间戳：`formatTimestamp(timestamp)`（`MessageItem.tsx:927`）。
- 群聊事件时间：`formatTeamEventTime` → `HH:mm:ss`（`zh-CN`）（`teamEventUtils.ts:15-23`）。
- 成员列表时间：`formatTime` → `HH:mm`（`zh-CN`/`en-US`）（`shared.tsx:318-324`）。

### 3.4 滚动 / 置底

**【事实】** `GroupChatDetail`（`TeamMembersPanel.tsx:311-328`）：
- 首次/新增消息时，若用户**未手动上滑**则 `el.scrollTop = el.scrollHeight`（置底）。
- `handleScroll`：距底 `scrollHeight - scrollTop - clientHeight >= 40`（**40px 阈值**）判定「用户上滑」→ 暂停自动置底。

### 3.5 空态

- 群聊空：`team.noGroupMessages`=「暂无群聊消息」（`zh.json` 邻近 `team.groupChat`，`TeamMembersPanel.tsx:343`）。
- 成员空：`team.noMemberData`=「暂无成员数据」（`zh.json:616`）。

### 3.6 文案（i18n，zh）

| key | 值 | 位置 |
|---|---|---|
| `team.groupChat` | 群聊 | `zh.json:624` |
| `team.detailTabs.members` / `.group` | 成员 / 子话题 | `zh.json:619,620` |
| `team.allMembers` | 所有人 | `zh.json:625` |
| `team.leader` | Team leader | `zh.json:622` |
| `team.memberSeparator` | 、 | `zh.json:623` |
| `team.noGroupMessages` | 暂无群聊消息 | `zh.json:626` |
| `team.noMemberData` | 暂无成员数据 | `zh.json:616` |
| `chat.teamBroadcastTarget` | @所有人 | `zh.json:1011` |
| `chatUi.teamActivity.openGroupChat` | 展开群聊 | `zh.json:3337` |
| `team.process.broadcastMessage/sentMessage/receivedMessage` | 广播消息 / 发送消息 / 接收消息 | `zh.json:678,682,683` |

---

## 4. 数据契约对照（Jiuwen ↔ DSH）

### 4.1 Jiuwen 前端数据模型（UI 直接消费）

| 实体 | 字段 | 位置 |
|---|---|---|
| 团队消息（system 消息体） | `team.event:{ event:{ type, message_id, from_member, to_member?, content, timestamp } }` | `teamEventUtils.ts:25-58` |
| 解析结果 `ParsedTeamEvent` | `type, messageId, fromMember, toMember?, content, timestamp?, isP2P, isBroadcast, isLeaderToUser`；`isP2P=type.endsWith('.p2p')`、`isBroadcast=type.endsWith('.broadcast')`、`isLeaderToUser=from_member==='team_leader' && !p2p && !broadcast` | `teamEventUtils.ts:3-13,45-58` |
| leader 消息 | `team.leader:{ content, timestamp }` | `MessageItem.tsx:745-752`；`teamLeaderMessages.ts:39-51` |
| 成员（store）`TeamMember` | `id, member_id, status, timestamp, name?, execution_status?, mode?` | `teamArea/shared.tsx:19-27` |
| 消息（store）`Message` | `id, role, content, timestamp, isStreaming?, teamStream?{requestId}, …` | `types/message.ts:91-130` |

### 4.2 DSH 数据模型（旁证 `docs/investigation/01-core-model.md`，行号在 harness checkout）

| 实体 | 字段 | 位置 |
|---|---|---|
| `TeamMemberSnapshot`（durable） | `id, name, description, provider, context:'fresh'\|'fork', phase:'provisioning'\|'active'\|'failed', error?` | `agent-team/src/types.ts:48-56` |
| `TeamMemberView`（runtime） | `id, name, role:'lead'\|'teammate', status:'running'\|'inactive'\|'provisioning'\|'failed', description?, provider?, context?, model?, diagnostics:string[]` | `types.ts:59-69` |
| `TeamMemberProjection`（wire） | `id, name, role, phase, error?` | `types.ts:101-108` |
| `TeamTaskSnapshot` | `id, revision, subject, description, status:'pending'\|'in_progress'\|'completed'\|'deleted', ownerId?, blockedBy, writeScopes` | `types.ts:75-84` |
| `TeamTaskView` | snapshot 字段 + `ownerName?, ready:boolean, writeScopeWarnings:string[]`（**不暴露 ownerId**） | `types.ts:87-98` |
| `TeamMessageSnapshot` / `TeamMessageSource` | mailbox 快照 / `{kind:'agent-message',form:'relay',senderSessionId}` | `types.ts:129-144`；发送源 `index.ts:237-245` |
| 会话事件 | `team/member`、`team/task`、`team/message/queued`、`team/message/delivered`（后两者为历史只读） | `types.ts:227-242` |
| wire 投影 | `agentTeam`，`stateVersion:4` | `projection.ts:386-394` |

### 4.3 「面板每个视觉元素的数据来源」映射表

| 视觉元素 | Jiuwen 来源 | DSH 对应 | 判定 |
|---|---|---|---|
| 群聊行发送者名 | `member.name`(display) → fallback `member_id`（`shared.tsx:168-193`） | `TeamMemberProjection.name`/`TeamMemberView.name` | **【需适配】** DSH `name` 是 slug（`/^[a-z0-9-]+$/`，`roster.ts:25`），**无中文 display_name** |
| 头像 | 由 `from_member` 哈希派生（`teamMemberAvatar.ts`） | 无 avatar 字段 | **【可迁移】**（前端派生，零后端依赖） |
| `@目标` chip | `to_member` + `type.endsWith('.p2p')` | `sendMessage(target)` 的 target；无事件类型标记 | **【需适配】** DSH 无 `.p2p/.broadcast` 事件类型 |
| `@所有人` chip | `type.endsWith('.broadcast')` | 产品层 `team-bus` 广播（1 落库+逐人 DM） | **【需适配】** 用 bus 的 `origin:'broadcast'` 判 |
| 消息正文 | `event.content` | relay 正文（前缀 `Team message from <name>:`） | **【需适配】** 需剥离前缀 |
| 时间 | `event.timestamp` | 会话事件时间戳 | **【可迁移】** |
| p2p/broadcast 语义 | `type` 后缀 | 无 | **【需适配】** |
| 成员状态点 | `member.status`（派生 running/idle/…） | `TeamMemberView.status` | **【可迁移】** 语义基本对齐 |
| `@member_id` 第二行 | `member.member_id` | `TeamMemberProjection.id`（SessionId/UUID） | **【需适配】** DSH id 是 UUID，不可读 |
| 群聊消息流 | `team.event:` 镜像消息 | DSH **无 mailbox 消息流进对话**（`team/message/*` 已废） | **【需适配/不可直接迁移】** 需先让 DSH 产出「协作消息进对话」的数据 |

---

## 5. ★ 迁移 checklist（逐条可勾）

> 标记：【可迁移】= 结构/样式可直接照搬；【需适配】= 需映射 DSH 数据或补字段；【不可迁移】= 无对应数据来源，需先造数据。
> 优先级：P0 = 首屏观感/核心交互；P1 = 完整性；P2 = 打磨。

### 5.1 群聊面板结构

- [ ] **[可迁移|P0]** team-area 展开态：左 240px 侧栏 + 右详情，`rounded-md p-1` Tab 切换（成员/子话题）——照抄 `TeamMembersPanel.tsx:194-309`。
- [ ] **[可迁移|P0]** 群聊详情 `section.team-area-group-chat` + `team-group-chat-message-list px-7 py-6` + 内层 `mx-auto max-w-[820px] space-y-5`——照抄 `:311-355`。
- [ ] **[可迁移|P0]** 群聊入口行（32×32 首字符头像 + 「群聊」+ 成员名 `、` 分隔）——`:209-236`。
- [ ] **[可迁移|P0]** 空态「暂无群聊消息」——`:338-344`。

### 5.2 消息项 / 头像 / @chip

- [ ] **[可迁移|P0]** 群聊消息行 `flex items-start gap-3`；发送者名 `text-base font-semibold leading-7`；正文 `text-sm leading-6`——`:357-400`。
- [ ] **[可迁移|P0]** 头像组件 `TeamMemberAvatar`（5 类派生 + 24 色底哈希 + 32×32/rounded-xl）——`TeamMemberAvatar/index.tsx` + `utils/teamMemberAvatar.ts`（**注意 README 说 h-9，代码是 h-8**）。
- [ ] **[可迁移|P0]** @chip 样式 `team-event-group-chip`（6px 圆角 / 11px / 600）+ p2p 蓝 / broadcast 橙——`index.css:1748-1767`；群聊内覆盖为链接蓝 14px——`index.css:1770-1781`。
- [ ] **[需适配|P0]** `@目标` / `@所有人` 的判定：DSH 无 `.p2p/.broadcast` 事件类型 → 需从 `sendMessage(target)` 与 `team-bus.origin` 推导。
- [ ] **[需适配|P0]** 发送者/收件人展示名：DSH `name` 是 slug、id 是 UUID → 需补中文 `display_name`（见 §6 缺口#1）或做 id→显示名映射。
- [ ] **[可迁移|P1]** 主对话流 `team-member-message`（920px 居中 / 12px 下距 / 卡 12px 圆角、82%·720px 上限）——`index.css:1457-1513`。
- [ ] **[可迁移|P1]** `.chat-avatar-name`（13px/600/#191919）——`index.css:1973-1977`。
- [ ] **[可迁移|P1]** 用户气泡 / 助手气泡样式（24px 非对称圆角、用户 88px 右留白）——`index.css:950-973`。

### 5.3 输入框 @

- [ ] **[可迁移|P0]** `@`/`$` 触发正则 + 候选下拉（360px / 14px 圆角 / item 44px / label 13px / meta 11px）——`InputArea.tsx:2341,1039-1145`；候选来源 `mentionableMembers`——`:1058-1066`。
- [ ] **[可迁移|P0]** inline chip 样式（24px 高 / 6px 圆角 / 蓝色渐变底 / 前缀 700 / 删除按钮）——`ChatPanel.css:897-993`；插入逻辑——`InputArea.tsx:2530-2570`。
- [ ] **[需适配|P1]** 提交展开 `@member_id`：DSH 成员 id 是 UUID，`@UUID` 不可读 → 需决定用 name 还是引入可读 handle。
- [ ] **[可迁移|P1]** 键盘导航 / 高亮（`--active`）、section 标题、空态——`ChatPanel.css:1178-1196`。

### 5.4 交互规则

- [ ] **[可迁移|P0]** 群聊列表置底 + 40px 上滑阈值——`TeamMembersPanel.tsx:311-328`。
- [ ] **[可迁移|P1]** 主对话流分段：遇用户/最终消息 flush，协作消息组**不折叠**、连续同成员隐藏重复头像——`TEAM_MESSAGE_DISPLAY_LOGIC.md:55-102`。
- [ ] **[需适配|P1]** `team.event:` / `team.leader:` 前缀协议：DSH 若沿用，需在会话转发层构造同形 payload（见 §6 缺口#3）。

### 5.5 数据依赖（迁移前需先解决）

- [ ] **[不可迁移→需先造数据|P0]** **DSH 目前没有「成员协作消息进对话」的数据流**：`team/message/*` 已废弃，实际发送走 target Agent inbox（`01-core-model.md §1.4`）。要复刻群聊**必须先有**一条「协作消息 → 前端可见流」的产出路径。
- [ ] **[需适配|P0]** 消息类型（p2p/broadcast）在 DSH 无结构化标记 → 需在消息产出侧补 `type`。
- [ ] **[需适配|P1]** `from_member` / `to_member` 字段：DSH relay 只有 `senderSessionId` + 正文前缀 → 需结构化。

---

## 6. 关键缺口（「缺失字段」显式标出）

1. **【需适配｜P0】中文 display_name 缺失**：Jiuwen 展示名由 leader 起（`shared.tsx:157-193`），DSH 成员只有 slug 名（`roster.ts:25` 正则）+ UUID id。→ 面板上会显示 slug/UUID，观感差。**解锁**：在 DSH 成员模型补 `displayName`，或前端做 id→中文名映射表。
2. **【需适配｜P0】p2p/broadcast 语义缺失**：Jiuwen 靠 `event.type` 后缀（`.p2p`/`.broadcast`）区分 `@目标` vs `@所有人`（`teamEventUtils.ts:45-46`）；DSH 无此事件类型。→ 需从 `team-core.send`（DM-only，`leader-wait-model.md §7.3`）与 `team-bus` 广播推导。
3. **【不可迁移｜P0】协作消息的对话镜像缺失**：Jiuwen 把队友内容镜像进「会话+team」对话视图（`teamLeaderMessages.ts:16-25` 的 `team-member-` 气泡）；DSH 当前**没有**协作消息进对话的数据（`01-core-model.md §1.4`）。→ 复刻群聊的前提是先建立该数据流。
4. **【需适配｜P1】消息正文字段**：Jiuwen 有结构化 `event.content`；DSH relay 正文带前缀 `Team message from <name>:`（`02-tools-and-messaging.md §2.2`）→ 需结构化剥离。
5. **【信息｜P2】README 与代码不一致**：`TeamMemberAvatar/README.md:56` 说默认 `h-9 w-9`，代码是 `h-8 w-8`（`index.tsx:53`）——迁移以代码为准。

---

## 附 A：关键视觉差异 Top5（Jiuwen vs DSH 现状）

1. **Jiuwen 有「群聊」只读面板 + 协作消息进主对话**；DSH 无协作消息进对话的数据流（最根本差距）。
2. **Jiuwen 展示名是 leader 起的中文 display_name**；DSH 只有 slug + UUID。
3. **Jiuwen 的 `@目标`/`@所有人` chip 由 `type` 后缀驱动**；DSH 无 p2p/broadcast 事件类型。
4. **Jiuwen 输入框 `@`/`$` 有成熟候选下拉 + inline chip**；DSH 尚无对应组件。
5. **Jiuwen 头像系统完整**（5 类 + 24 色哈希 + 多尺寸/形状）；DSH 无前端头像派生。

## 附 B：源码锚点速查

- 群聊面板：`src/components/teamArea/TeamMembersPanel.tsx:112-400`
- 成员列表项：`src/components/teamArea/MemberListItem.tsx:38-121`
- 共享工具（显示名/状态/时间/任务映射）：`src/components/teamArea/shared.tsx:19-583`
- 主对话消息：`src/components/ChatPanel/MessageItem.tsx:121-1020`
- 团队事件解析：`src/components/ChatPanel/teamEventUtils.ts:3-78`
- 显示逻辑说明：`src/components/ChatPanel/TEAM_MESSAGE_DISPLAY_LOGIC.md`
- 头像：`src/components/TeamMemberAvatar/index.tsx`、`src/utils/teamMemberAvatar.ts`
- 输入框：`src/components/ChatPanel/InputArea.tsx`（`:1058-1066,2334-2360,2530-2570,5045-5240`）
- 样式：`src/index.css:1457-1513,1748-1781,1973-1977,950-1011`；`src/components/ChatPanel/ChatPanel.css:897-1145`；`src/styles/foundation.css`；`src/styles/themes/default/light.css`
- DSH 侧模型：`docs/investigation/01-core-model.md §1`（+ 其引用的 `agent-team/src/types.ts`）
