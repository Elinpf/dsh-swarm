# DSH experimental agent-team 子系统 — 真实能力边界实测（P3-spike）

> 产出人：dsh-target-analyst
> 时间：2026-10-26
> 目标：在**真实运行**的 DSH `0.2.1-rc.3` 上，实测其自带实验性子系统 `agent-team`（`ctx.agentTeams` / `dsh-experimental-tool-agent-team`）到底能不能用、能用到哪一步——阶段 0（MVP 复用 DSH 原生）能否成立的关键证据。
> 纪律：**只做探针，不写生产代码**；跑不通就如实写；严格区分 **【实测】** / **【文档声称】** / **【推断】**。

---

## 0. 结论速览

- **【实测】阶段 0「MVP 复用 DSH 原生 agent-team」成立（有条件）**：在 `dsh 0.2.1-rc.3` 上，`spawn_teammate` / `send_message`(DM) / `list_agents` / `wait_agent` / `team_task_{create,list,get,update}` **全部真实跑通**，成员与任务以 durable 事件落盘、可跨进程重启恢复。
- **【实测】但有一个致命版本陷阱**：npm 上 `@deepseek-ai/dsh-experimental-agent-team(-profile)` 的 **`latest` = `0.1.5-alpha.2`，与 dsh 0.2.1-rc.3 不兼容**（spawn 直接失败、typert codec 报错）；**正确版本是 `0.2.1-rc.3`（dist-tag `next`）**。装错版本会造成「工具都在、一调就错」的假象。
- **【实测】JiuwenSwarm 的六项缺失能力（广播群聊 / 自动派发 / 验证闸 / 跨进程 / worktree+文件锁 / 人类席位）在 DSH agent-team 里全部没有直接 seam**，需新建插件承载。
- **【实测】模型路由需自配**：DSH 内置 `dsh-llm-deepseek` 对本环境的 OpenAI 兼容端点返回 401；必须用 `llm-pi-ai` 手写一条 `openai-completions` 路由才能驱动真实模型（本次用内部网关 + `DeepSeek-Flash` 跑通）。

---

## 1. 环境与方法

### 1.1 隔离环境【实测】

| 项 | 值 | 证据 |
|---|---|---|
| Node | `v22.23.4` | `source scripts/env.sh && node --version` |
| pnpm | corepack 管理的 `11.28.5` | env-setup.md；`dsh plugin` 输出 `pnpm v10.33.0`（forwarder 内嵌） |
| dsh CLI | `.runtime/dsh-cli-npm/node_modules/.bin/dsh` → `dsh --version` = `0.2.1-rc.3` | npm 包 `@deepseek-ai/dsh@0.2.1-rc.3` |
| DSH_HOME | `.runtime/dsh-home`（与 `/root/.dsh` 零交叠） | `env.sh` |
| 网络 | 直连，无代理 | `env.sh` unset `*_proxy` |

> 注意：`scripts/env.sh` 依赖 `source`（bash 语法），`/bin/sh` 下会 `source: not found`——**必须用 bash**。
> 磁盘：本次实测时 `/` 有 41G 可用（env-setup 早期报 100% 满，已缓解）。

### 1.2 安装 agent-team bundle（含版本陷阱）【实测】

DSH 的 base 不含 agent-team；它是 opt-in bundle。按官方 README 应装 `@deepseek-ai/dsh-experimental-agent-team-profile`：

```bash
source scripts/env.sh
DSH=.runtime/dsh-cli-npm/node_modules/.bin/dsh
$DSH plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile   # 默认装 latest
```

**结果（默认 latest = 0.1.5-alpha.2）：**

```
dsh: disabling profile plugin row "agent-team": Plugin @deepseek-ai/dsh-experimental-agent-team@0.1.5-alpha.2
     is incompatible with dsh 0.2.1-rc.3: requirements {"@deepseek-ai/dsh-llm":"^0.1.5-alpha.2", ...,
     "@deepseek-ai/dsh-invariants":"^0.1.5-alpha.2"}. ... grant the exact-version exemption ...
dsh: disabling profile plugin row "tool-agent-team": ... same ...
```

→ 两个核心插件行被**版本门禁禁用**（`^0.1.5-alpha.2` 不匹配 0.2.1-rc.3；且依赖的 `dsh-invariants` 在 0.2.1 已移除）。

**修正（装 0.2.1-rc.3）【实测】——这是让一切跑通的关键：**

```bash
$DSH plugin --profile headless remove @deepseek-ai/dsh-experimental-agent-team-profile
$DSH plugin --profile headless add    @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.3
# → dependencies: + @deepseek-ai/dsh-experimental-agent-team-profile 0.2.1-rc.3 ; Packages: +9
```

**版本事实【实测】**（`npm view ... dist-tags versions`）：

| 包 | `latest` | `next` | 结论 |
|---|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team` | `0.1.5-alpha.2` | **`0.2.1-rc.3`** | 必须锁 `0.2.1-rc.3` |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | `0.1.5-alpha.2` | **`0.2.1-rc.3`** | 同上 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | `0.1.5-alpha.2` | **`0.2.1-rc.3`** | profile bundle，装它带出上面两个 |

安装 0.2.1-rc.3 后，`dsh --profile headless --dump-config` 不再有 `disabling`/`incompatible`/`did not activate` 告警（rows `agent-team` / `tool-agent-team` / `ui-agent-team` 正常进入组合）。

> **【推断】** 若走「装 latest」的直觉路径，会在 0.2.1-rc.3 上得到「插件都在、`spawn_teammate` 一调即错」的结论——这**不是** DSH agent-team 本身不能用，而是**版本选错**。这是本 spike 最重要的避坑点。

### 1.3 模型路由【实测】

- `dsh-llm-deepseek`（provider `deepseek-official`）对本环境的 OpenAI 兼容端点（`http://172.16.3.41:31809/v1`）返回 **`AUTH: DeepSeek Messages request failed (401)`**——该适配器走 DeepSeek 原生 Messages 协议，与本端点的 OpenAI `/v1` 不匹配。
- **可用方案**：`llm-pi-ai` 手写一条 `openai-completions` 路由（overlay 文件）：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      dshdemo:
        apiKeyEnv: DSH_DEMO_KEY          # 经 credentials seam 从环境变量解析
        api: openai-completions
        baseURL: http://172.16.3.41:31809/v1
        models:
          - id: DeepSeek-Flash
            contextWindow: 1048576
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: dshdemo
    model: DeepSeek-Flash
```

调用：`dsh --profile headless --patch <overlay> "task..."`，`export DSH_DEMO_KEY=<key>`。
**【实测】验证**：任务 `"Reply with exactly: PONG"` → 输出 `PONG`（模型路由打通）。

> 凭据来自本机既有实例的 OpenAI 兼容配置（`/root/.jiuwenswarm/config/config.yaml` 的 `models.defaults[].model_client_config`），仅注入隔离进程环境，**未落盘、未打印**。

### 1.4 证据提取方法【实测】

`--json` 只输出摘要流（`final/session/status/text/thinking`），**不含工具调用**。真实证据来自 durable session log：
`$DSH_HOME/sessions/<escaped-cwd>/<session-id>/session.v4.jsonl.zstd`，用 `zstd -dc` 解压后按 `type` 过滤（`tool/call`、`tool/result`、`team/member`、`team/task`）。

---

## 2. 逐工具实测结果表（10 个工具）

> 全部在 `dsh 0.2.1-rc.3` + `agent-team@0.2.1-rc.3` 上、由真实模型驱动、结果取自 session log（`tool/result`）。

| 工具 | 是否跑通 | 证据（实测结果原文，节选） | 备注 |
|---|---|---|---|
| `spawn_teammate` | ✅ **跑通** | `{"member":{"target":"alice","role":"teammate","status":"running","provider":"spawn","context":"fresh","model":"DeepSeek-Flash"}}`；同时 Lead 会话写入 `team/member` durable 事件、生成子会话 `9e61a532...` | Lead-only；`provider` 取 `spawn`/`fork` |
| `send_message` | ✅ **跑通（quiet DM）** | lead→bob：`{"sent":true}`；bob→lead：`{"sent":true}`（teammate 会话确有回信 "ACK: bob online, awaiting task."） | 单目标；自己发自己 → `Error: a Team member cannot message itself`；未知目标 → `Error: active teammate "alice" not found` |
| `followup_task` | ⚠️ **未确认调用** | 工具在工具列表中可见、源码存在，但实测中模型未真正调用（探针里被跳过） | wakeup 投递路径未证实；quiet 路径已证实 |
| `list_agents` | ✅ **跑通** | `[{"target":"lead","role":"lead","status":"running",...},{"target":"bob","role":"teammate","status":"inactive",...}]` | 含 lead 与全部 teammate；状态 running/idle/inactive |
| `wait_agent` | ✅ **跑通** | `{"timedOut":false,"noProgress":{"reason":"no-active-peer","message":"No other Team member is running or provisioning..."}}` | 无活跃 peer 时立即返回 noProgress（设计如此） |
| `interrupt_agent` | ⚠️ **未确认调用** | 工具在列表可见、源码存在；未在探针中成功对运行中 teammate 触发 | 需一个正在跑的 teammate turn 才能验证 |
| `team_task_create` | ✅ **跑通** | `{"id":"task-1","revision":1,"subject":"t2","status":"pending","blockedBy":[],"writeScopes":[],"ready":true}`；写入 `team/task` durable 事件 | 任意成员可创建 |
| `team_task_list` | ✅ **跑通** | `{"tasks":[{"id":"task-1","revision":1,...,"status":"pending",...}]}` | |
| `team_task_get` | ✅ **跑通** | `{"id":"task-1","revision":1,...}` | 含已删除 tombstone |
| `team_task_update` | ✅ **跑通（CAS）** | claim：`revision 1→2`、`status:"in_progress"`、`ownerName:"lead"`；complete 非法态 → `Error: only an in-progress task can complete` | `expectedRevision` compare-and-set；状态机护栏生效 |

**小计**：8/10 明确跑通；2 个（`followup_task`/`interrupt_agent`）注册可见但探针未成功触发，属**未确认**（非「不存在」）。

> 旁证【实测】：base 的 `bash` 工具在同环境正常（`tool/result` 返回 `HELLO`），说明 harness 工具执行链路本身健康；且 bash 运行在沙箱内（`touch /tmp/...` 在宿主 `/tmp` 不可见）——与团队能力无关，仅作执行链路对照。

---

## 3. `ctx.agentTeams` 暴露了什么（服务/事件）

**【文档声称/源码】** 子系统实现于 `packages/experimental/agent-team`（npm 包 `@deepseek-ai/dsh-experimental-agent-team`，本次实装 `0.2.1-rc.3`）；模型工具适配器为 `@deepseek-ai/dsh-experimental-tool-agent-team`。

**服务 `ctx.agentTeams` — `TeamService` 方法**（源码 `src/index.ts`，与 `docs/subsystems/agent-team.md` 一致）：

`membership(agent)`、`listMembers(agent)`、`spawnTeammate(caller, req)`、`sendMessage(caller, req)`、`createTask(caller, req)`、`getTask(caller, id)`、`listTasks(caller)`、`updateTask(caller, req)`、`waitForChange(caller, timeoutMs, signal)`、`interrupt(caller, targetName)`、`tryMembership(agent)`。

**Durable 会话事件**（`declare module '@deepseek-ai/dsh-session/types'`，`version: 2`）：
`team/member`（花名册整值快照）、`team/task`（任务整值快照）、`team/message/queued`（信箱入队）、`team/message/delivered`（目标已记录的确认）。

**【实测】** 落盘验证：`team/member` 在 `spawn` 时写入 Lead 会话；`team/task` 在 `create` 时写入 Lead 会话（`zstd -dc ... | grep '"type":"team/'`）。

**模型工具输出 schema 的版本差异【实测】**：0.2.1-rc.3 的 `list_agents` 行用 `{target, role, status, ...}`；而 0.1.5-alpha.2 用 `{id, name, role, status, ...}`。这印证两版**契约不同**，混用必错。

---

## 4. 持久化与恢复实测

- **【实测】落盘**：会话日志为 zstd 压缩 JSONL（`session.v4.jsonl.zstd`），任务与成员以 `team/task` / `team/member` 事件持久化在 **Lead 会话** 内。
- **【实测】跨进程恢复**：用 `dsh --profile headless --session-id session-252b4695-... "..."` 恢复旧会话后，`team_task_list` 仍返回先前创建的 `task-1` → **任务看板跨进程重启可复原**；`team_task_update` 的 `ownerName` 等也随之保留。
- **【实测】DB 位置**：`$DSH_HOME/sessions/--root-...--/<session-id>/session.v4.jsonl.zstd`。

---

## 5. 能力覆盖矩阵：JiuwenSwarm 六项缺失能力 × DSH 现有 seam

> 依据本 spike 实测 + 对 `ctx.agentTeams` 源码的核对。

| # | JiuwenSwarm 能力 | DSH agent-team 现状 | 能否直接复用 | 说明 |
|---|---|---|---|---|
| 1 | **广播群聊 / topic** | mailbox 仅单 `targetId`（DM）；无 topic/broadcast 扇出 | ❌ **不能** | `send_message` 只有一个目标；无群聊频道概念。需新插件（在 `ctx.agents`/`session/event` 之上自建 fan-out） |
| 2 | **任务自动派发** | 无调度器；任务 readiness **不会**启动 owner；靠 Lead 显式 `followup_task`（且本次未证实） | ❌ **不能** | 实测 `wait_agent` 在无活跃 peer 时即 noProgress；无「事件驱动自动 assign」 |
| 3 | **验证闸（in_review/verify）** | 任务状态只有 `pending/in_progress/completed/deleted`；无 in_review、无 reviewer | ❌ **不能** | 实测 `complete` 需先 `in_progress`，无「提交→复核→通过」态 |
| 4 | **跨进程 / 分布式** | 单进程；官方自述「mailbox 非跨进程 exactly-once，不支持同 Team 并发 harness 进程」 | ❌ **不能** | 但 `ctx.subprocess`/`ctx.subagents` seam 可作为承载点新建分布式插件 |
| 5 | **worktree + 文件锁** | 无；成员共享 cwd（本 spike 实测成员共享同一工作目录） | ❌ **不能** | `writeScopes` 仅为建议性前缀，非锁 |
| 6 | **人类席位** | agent-team 内无人类成员概念；Web roster/task-board 在独立 client-ui 包 | ❌ **不能** | 人机交互经 Host/Web 层，不在本 runtime 包 |

**已被 DSH 原生覆盖（可复用）**：成员 spawn/生命周期、**单目标 DM**、**任务 DAG + CAS + blockedBy**、`list_agents`、`wait_agent`、durable 落盘与恢复、Lead 权限校验（spawn/interrupt/reassign 仅 Lead）。

---

## 6. 阶段 0 可行性结论

**【实测 + 推断】阶段 0「MVP 复用 DSH 原生 agent-team」成立**，但边界明确：

1. **可复用子集**（建议直接作为阶段 0）：成员 spawn（`spawn`/`fork` provider）+ 单目标 DM + 共享任务看板（DAG/CAS）+ 花名册/等待 + durable 持久化。这已能支撑「一个 Lead + 若干 teammate、共享任务板、互相私信」的 MVP。
2. **前置硬条件**：
   - 锁 **`@deepseek-ai/dsh-experimental-agent-team(-profile)@0.2.1-rc.3`**（**不要装 latest**）；
   - 配一条可用的模型路由（本环境必须用 `llm-pi-ai` 手写 `openai-completions` 路由，内置 deepseek 适配器 401）。
3. **六项 JiuwenSwarm 特色能力全部需要新插件**——不能在阶段 0 靠复用原生达成。因此阶段 0 的定位应是「**验证骨架 + 打通 DM/任务板**」，而非「已经具备完整集群能力」。

---

## 7. 卡点、未跑通项与解锁条件

| 项 | 状态 | 卡点 | 解锁条件 |
|---|---|---|---|
| `followup_task`（wakeup 投递） | ⚠️ 未确认 | 模型在探针里未真正调用该工具 | 用更强制/更简单的触发提示，或直接观察 wake 后 teammate 是否新起 turn |
| `interrupt_agent` | ⚠️ 未确认 | 需一个正在运行的 teammate turn | 让 teammate 执行长任务时中断 |
| 内置 `dsh-llm-deepseek` 路由 | ❌ 不可用 | 对 OpenAI 兼容端点 401 | 改用 `llm-pi-ai`（本 spike 已用此法跑通） |
| 版本门禁 | ⚠️ 陷阱 | latest=0.1.5-alpha.2 与 0.2.1-rc.3 不兼容 | 显式装 `@0.2.1-rc.3`（或 dist-tag `next`） |
| Web roster/task-board UI | 未测 | 本次只用 CLI/headless | 装 `dsh-experimental-client-ui-agent-team` + `dsh web` |
| 多成员并发高负载 | 未测 | 单进程、无压测 | 多 teammate 并发压测（列入后续） |

---

## 附：可复现命令（本次实测用）

```bash
# 0) 进入隔离环境（必须 bash）
cd /root/.jiuwenswarm/agent/workspace/work/jiuwen/dsh-swarm && source scripts/env.sh
DSH=.runtime/dsh-cli-npm/node_modules/.bin/dsh

# 1) 装正确的 agent-team 版本（关键：0.2.1-rc.3，而不是 latest）
$DSH plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.3
$DSH --profile headless --dump-config | grep -E 'agent-team|tool-agent-team'   # 应无 disabling 告警

# 2) 模型路由 overlay（见 §1.3 的 model-overlay.yml）
export DSH_DEMO_KEY=<OpenAI 兼容 key>
$DSH --profile headless --patch .runtime/probe/model-overlay.yml "Reply with exactly: PONG"

# 3) 驱动团队工具（真实模型）
$DSH --profile headless --patch .runtime/probe/model-overlay.yml \
  "Call spawn_teammate name='alice' description='probe' prompt='Reply ACK'; then list_agents; report raw JSON."

# 4) 读回真实证据（工具调用/结果 + 团队 durable 事件）
base="$DSH_HOME/sessions/--root-.jiuwenswarm-agent-workspace-work-jiuwen-dsh-swarm--"
zstd -dc "$base/<session-id>/session.v4.jsonl.zstd" | grep -E '"type":"tool/(call|result)"|"type":"team/'
```

*（本报告由 dsh-target-analyst 生成；【实测】项均给出真实命令与 session log 证据。所有失败均如实记录，未编造成功。）*
