# P66 迁移 checklist（对照 `docs/jiuwen-chat-ui-spec.md` 逐条打勾）

> 产出人：dsh-target-analyst　时间：2026-10-28　范围：只改 `client/team-ui/`（右侧栏「群聊」tab 本体）。
> 图例：[x]=已迁移/已适配；[~]=不在本插件范围（显式列出+原因/去向）；[!]=需适配（已说明）。
> 说明：本插件是**右侧栏的一个 tab（群聊详情区）**，**不拥有** Jiuwen 的 team-area 左侧栏、主对话流、composer——故部分条目按「非本插件」处理。

## §5.1 群聊面板结构
- [x] **[可迁移|P0]** 群聊详情区布局：`team-group-chat-message-list px-7 py-6` + 内层 `mx-auto max-w-[820px] space-y-5`（gap 20px）。→ 已照抄（`TeamChatTab.tsx` 容器 `padding:24px 28px` + `maxWidth:820, gap:20`）。
- [x] **[可迁移|P0]** 空态「暂无群聊消息」（i18n `team.noGroupMessages`）。→ 已迁移（居中、13px、#808080）。
- [~] **[可迁移|P0]** 左 240px 侧栏 + 成员列表 + 成员/子话题 Tab。→ **不在本插件**（属 Jiuwen team-area，非右侧 tab）→ **已拆 P67**（在我们 pane 内复刻，属另一任务）。
- [~] **[可迁移|P0]** 群聊入口行（32×32 首字符头像 + 「群聊」+ 成员名 `、`）。→ 同属左栏 → **P67**。

## §5.2 消息项 / 头像 / @chip
- [x] **[可迁移|P0]** 消息行 `flex items-start gap-3`；发送者名 `text-base font-semibold leading-7`（16/28）；正文 `text-sm leading-6`（14/24）。→ 已照抄。
- [!] **[可迁移|P0]** 头像 `TeamMemberAvatar`（32×32 / rounded-xl / 5 类派生 / 24 色底哈希）。→ **已迁移派生逻辑**（`avatarKind` 5 类 + `AVATAR_BG_COLORS` 24 色 + FNV 哈希 + `avatarStyleFor`；cli 中性底 `#F2F3F5`）。**适配项**：Jiuwen 用 **svg 资产**（teamleader.svg/Team-2..6.svg…），本包**无这些资产**→ 改用**首字符+色底**（等价信息、无图）。**以代码 `h-8 w-8` 为准**（非 README 的 h-9）。
- [x] **[可迁移|P0]** @chip 样式：定向 chip `padding:1px 6px;border-radius:6px;font-size:11px;font-weight:600`，p2p 蓝 `rgba(37,99,235,.16)/#2563eb`、broadcast 橙 `rgba(217,119,6,.1)/#d97706`；正文 `@名字` 用链接蓝 `#0067d1`（群聊内覆盖）。→ 已照抄。
- [!] **[需适配|P0]** `@目标` / `@所有人` 判定：DSH 无 `.p2p/.broadcast` 事件类型 → **已由 `kind`/`targets` 推导**（`broadcast`→`@所有人`；`outbound`/`multicast`→`@<targets>`）。**不再依赖新数据流**。
- [!] **[需适配|P0]** 发送者/收件人展示名：DSH `name` 是 slug、id 是 UUID → **显示名解析**：`displayName`(数据侧) → 干净中文 `title` → **本地 `slug→中文名` 映射**（`LOCAL_DISPLAY_NAMES`，**可配置**，**标注「本地映射、非数据侧真值」**）→ 回退 ID。
- [~] **[可迁移|P1]** 主对话流 `team-member-message`（920px 卡）→ **不在本插件**（我们无主对话流）→ 待上游「协作消息进对话」。
- [~] **[可迁移|P1]** `.chat-avatar-name`（13px/600）→ 属主对话流 → N/A（本插件 sender 名按群聊 16/28）。
- [~] **[可迁移|P1]** 用户/助手气泡（24px 非对称圆角）→ 属主对话流 → N/A。

## §5.3 输入框 @
- [~] **[可迁移|P0]** `@`/`$` 触发正则 + 候选下拉。→ **不在本插件**（本面板**只读、无 composer**）→ **已拆 P68**（会让面板从只读变可发送，属功能扩展）。
- [~] **[可迁移|P0]** inline chip 样式 / 插入逻辑。→ 同 → P68。
- [~] **[需适配|P1]** 提交展开 `@member_id`。→ 同 → P68。
- [~] **[可迁移|P1]** 键盘导航/高亮/section 标题。→ 同 → P68。

## §5.4 交互规则
- [x] **[可迁移|P0]** 群聊列表**置底** + **40px 上滑阈值**（`scrollHeight - scrollTop - clientHeight >= 40` 暂停自动置底）。→ 已迁移（`onScroll` + `pinned` ref + `useEffect`）。
- [x] **[可迁移|P0]** 消息按**时间升序**（Jiuwen 群聊升序；排序/去重沿用 P61 `id`/`seq`，可见范围不变）。→ 已迁移（`orderMessages(..., false)`）。
- [~] **[可迁移|P1]** 主对话流分段/flush（遇用户/最终消息 flush）。→ 属主对话流 → N/A。
- [~] **[需适配|P1]** `team.event:` / `team.leader:` 前缀协议。→ **N/A**：我们用 `swarmBus` 投影的结构化消息（`kind`/`senderName`/`targets`），**不走 `team.event:` 文本协议**。

## §5.5 数据依赖
- [x] **[不可迁移→需先造数据|P0]** 「成员协作消息进对话」数据流 → **对本插件不成立**：`swarmBus` 投影（P61）**已提供**协作消息流（`broadcast/multicast/dm/relay/outbound`）→ 无需新数据流。
- [x] **[需适配|P0]** p2p/broadcast 标记 → 由 `kind`/`targets` 推导（见 §5.2）。
- [x] **[需适配|P1]** `from_member`/`to_member` → 投影已有 `senderName` + `targets`（结构化），无需前缀剥离。

## §6 缺口（逐条处置）
1. **中文 display_name** → **已用本地映射缓解**（可配置、显式标注非真值）；数据侧给字段即优先取用。**本轮不做数据侧改动**（team-leader 裁定）。
2. **p2p/broadcast 语义** → 由 `kind`/`targets` 推导 → **已解决（非缺口）**。
3. **协作消息进对话镜像** → **维持待上游**（见 `docs/p61-upstream-request.md` 记账）。
4. **消息正文字段** → 本插件用 `swarmBus` 的结构化正文（relay 已去 frame）→ 已适配。
5. **README/代码 h-9 vs h-8** → **以代码 h-8（32×32）为准**。

---

## 与 Jiuwen 逐项对比自查表（像素观感，需用户点开确认）

| 元素 | Jiuwen 规格 | 本包实现 | 状态 |
|---|---|---|---|
| 详情区内边距 | `px-7 py-6`(28/24) | `padding:24px 28px` | ✅ 一致 |
| 列表内层 | `max-w-[820px] space-y-5`(20) | `maxWidth:820 gap:20` | ✅ 一致 |
| 消息行 | `flex items-start gap-3`(12) | `gap:12` | ✅ 一致 |
| 发送者名 | 16/28/600 | 16/28/600 | ✅ 一致 |
| 正文 | 14/24 | 14/24 | ✅ 一致 |
| 头像 | 32×32 rounded-xl，svg+哈希底 | 32×32 rounded-xl，**首字符+24 色哈希底** | ⚠️ 形状/尺寸/色一致；**图用首字符替代 svg**（无资产） |
| 定向 chip | 6px/11/600；p2p 蓝/broadcast 橙 | 同 | ✅ 一致 |
| 正文 @ | 链接蓝 #0067d1 / 14px | 同 | ✅ 一致 |
| 空态 | 「暂无群聊消息」居中 muted | 同 | ✅ 一致 |
| 置底/阈值 | 40px | 同 | ✅ 一致 |
| 时间 | `HH:mm:ss` | `formatClock` → HH:mm:ss | ✅ 一致 |
| 左 240px 侧栏/成员列表/Tab | 有 | 无 | ❌ 不在本插件 → **P67** |
| 输入框 @ 候选下拉 | 有 | 无 | ❌ 不在本插件 → **P68** |
| 主对话流 team-member 镜像 | 有 | 无 | ❌ 待上游 |

**结论**：本插件范围内的**群聊详情区**已按数值像素级对齐；差异项均**显式归因**（无资产/非本插件/待上游），**不假装做到**。

---

## P67 增补：面板内左侧栏（成员列表 + 成员/子话题 Tab）

> 借 `docs/jiuwen-chat-ui-spec.md` §5.1（`TeamMembersPanel.tsx` 左栏行号）；在 pane 内做**左右两栏**（不改右栏 tab 外部契约）。

- [x] **[可迁移|P0]** 左 **240px** 侧栏（`w-[240px]`；`border-r`；`bg-card`）。→ 已迁移（`LeftRail`，`SIDEBAR_PX=240`）。
- [x] **[可迁移|P0]** Tab 切换「成员 / 子话题」（容器 `rounded-md p-1` + 底色；按钮 `h-8`，选中 `bg-card font-semibold shadow-sm`）。→ 已迁移。
- [x] **[可迁移|P0]** 群聊入口行（32×32 首字符头像 +「群聊」+ 成员名 `、` 分隔，`px-[8px] py-[9px]`）。→ 已迁移。
- [x] **[可迁移|P0]** 成员列表项（头像 `rounded-full` 32×32 + 显示名 `text-sm font-semibold` + 第二行 `@…` + 右侧状态点）。→ 已迁移。
- [~] **[需适配|不可迁移]** **「子话题」内容**：Jiuwen 子话题来自 `team.event:` 子话题流，**DSH 无该概念** → **Tab 保留但内容为空态 + 说明**（不造数据）。**解锁条件**：数据侧提供子话题镜像。
- [!] **[需适配]** 成员列表第二行 `@member_id`：**DSH id 是 UUID、不可读** → 以 **slug 名**替代（`@<slug>`），已在代码注释与本表标注。
- [!] **[降级|标注]** 响应式：**窄宽自动隐藏侧栏 + 一个展开/收起按钮**（`‹/›`）。**这是合理降级、非 Jiuwen 原生行为**（Jiuwen 未定义窄宽折叠）。
- [x] **【边界】** 左栏**只读**——**不含** P68 的 composer（一件一件来）。
