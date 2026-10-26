# 真实 DSH profile 端到端联调记录（profile-e2e）

> 任务：P6-e2e-profile ｜ 负责人：dsh-env-engineer ｜ 执行时间：2026-10-26
> 目标：把验证从「进程内」推进到「**真实 DSH profile 级联调**」——在隔离环境里装齐一个可运行的
> `dsh` profile（`dsh-base` + 团队 bundle），跑通 `--dump-config`、真实模型驱动、最小团队交互，
> 并补做两个工具的**真机探针**。
> 配套脚本：`scripts/run-headless.sh`（真实模型一键启动）、`scripts/e2e-profile.sh`（端到端断言，幂等）
> 证据目录：`.runtime/probe/e2e-*`（真实命令输出）

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 隔离环境（Node/pnpm/DSH_HOME） | ✅ 复用 P1 产出，`/root/.dsh` 零改动 |
| 装齐 headless profile（npm 已发布包，未构建单仓） | ✅ `dsh-base + dsh-headless + agent-team-profile@0.2.1-rc.3 + @elinpf/dsh-swarm-bundle` |
| `--dump-config`：9 行团队插件 | ✅ **实测出现**（见 §3） |
| `--dump-config`：4 行 legacy `tool-subagent*` disabled | ✅ **实测全部 disabled** |
| 真实模型驱动（`llm-pi-ai` overlay） | ✅ `Reply with exactly: PONG` → `PONG`；固化为 `scripts/run-headless.sh` |
| 最小团队交互（spawn + DM + 任务看板） | ✅ 全部真实跑通（见 §5） |
| `interrupt_agent` 真机探针 | ✅ `{"previousStatus":"running"}`（见 §6.2） |
| `followup_task` 真机探针 | ❌ **该工具在 `0.2.1-rc.3` 中不存在**；等价能力由 `send_message` 唤醒 inactive 成员，**已实测**（见 §6.1） |
| `scripts/e2e-profile.sh` 断言 | ✅ `PASS=8 FAIL=0` |

---

## 1. 隔离方案（复用 P1，不破硬隔离）

* 隔离环境由 P1 的 `scripts/setup-env.sh` + `scripts/env.sh` 提供：
  Node `v22.23.4`、pnpm `11.28.5`、`DSH_HOME=.runtime/dsh-home`、无代理直连。
* 本次所有 profile/会话/证据都落 `.runtime/` 内：
  * profile：`.runtime/dsh-home/profiles/headless/`
  * 会话日志：`.runtime/dsh-home/sessions/<escaped-cwd>/<id>/session.v4.jsonl.zstd`
  * 证据：`.runtime/probe/e2e-*`
* 实测 `/root/.dsh` 全程 mtime 停在 `2026-10-23 11:28:58`（早于本次操作），**零写入**。
* 系统 node 未使用（`source scripts/env.sh` 后 `node -v` = `v22.23.4`，解析到项目内隔离发行版）。

> ⚠️ `scripts/env.sh` 是 bash 语法；`/bin/sh`(dash) 下必须用 `bash` 跑（否则 `source: not found`）。

---

## 2. 安装与启动命令

```bash
cd /root/.jiuwenswarm/agent/workspace/work/jiuwen/dsh-swarm
source scripts/env.sh                                  # 必须 bash
DSH=.runtime/dsh-cli-npm/node_modules/.bin/dsh         # dsh 0.2.1-rc.3（npm 已发布包，未构建单仓）

# 2.1 装 opt-in 的 agent-team profile（关键：显式钉 0.2.1-rc.3，不要用 latest）
$DSH plugin --profile headless add @deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.3

# 2.2 接入我们自己的团队 bundle（本地 link）
$DSH plugin --profile headless add ./packages/bundle
```

安装后 profile 声明（`.runtime/dsh-home/profiles/headless/package.json`）：

```json
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-headless",
    "@deepseek-ai/dsh-experimental-agent-team-profile",
    "@elinpf/dsh-swarm-bundle"
  ] } },
  "dependencies": {
    "@deepseek-ai/dsh-experimental-agent-team-profile": "0.2.1-rc.3",
    "@elinpf/dsh-swarm-bundle": "link:/root/.../dsh-swarm/packages/bundle"
  }
}
```

> 说明：`dsh plugin add ./packages/bundle` 时 pnpm 会对 profile 的 peer 依赖报警（`cordis`、`dsh-agent`…），
> 这些 peer 由 `dsh-base` 在运行时提供，属正常；`--dump-config` 无「禁用/不兼容」告警。

一次性跑完安装 + 断言：`bash scripts/e2e-profile.sh --no-model`

---

## 3. `--dump-config` 证据（9 行插件 + 4 行 disabled）

命令：`$DSH --profile headless --dump-config > .runtime/probe/e2e-dump-config.yml`
（stderr 为空，无 `disabling`/`incompatible`/`did not activate` 告警）

**`@elinpf/dsh-swarm-bundle` 段落展开出的 9 行**（原文摘录）：

```yaml
# == @elinpf/dsh-swarm-bundle
- id: agent-team        # name: '@deepseek-ai/dsh-experimental-agent-team'
- id: tool-agent-team   # name: '@deepseek-ai/dsh-experimental-tool-agent-team'
- id: team-core         # name: '@elinpf/dsh-swarm-team-core'         (backend: auto)
- id: team-prompt       # name: '@elinpf/dsh-swarm-team-prompt'       (locales: cn)
- id: team-bus          # name: '@elinpf/dsh-swarm-team-bus'          (maxFanout: 64)
- id: team-review       # name: '@elinpf/dsh-swarm-team-review'       (veto/challenger)
- id: team-scheduler    # name: '@elinpf/dsh-swarm-team-scheduler'    (mode: autonomous)
- id: team-completion   # name: '@elinpf/dsh-swarm-team-completion'   (blockOnUnread: true)
- id: tool-swarm        # name: '@elinpf/dsh-swarm-tool-swarm'        (enableBroadcast: true)
```

**4 行 legacy `tool-subagent*` 全部 `disabled: true`**（原文摘录）：

```yaml
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true
```

脚本化断言结果（`bash scripts/e2e-profile.sh --no-model`）：

```
[PASS] 团队插件行数 = 9 (期望 9)
[PASS] legacy tool-subagent* 为 disabled 的行数 = 4 (期望 4)
[PASS] dump-config 无禁用/不兼容告警
结果：PASS=3 FAIL=0
```

**模型视角的工具面**（真实模型自报，证明我们的插件确实注册进了运行时）：

```json
["broadcast","interrupt_agent","list_agents","multicast","send_message",
 "spawn_teammate","team_summary","team_task_create","team_task_get",
 "team_task_list","team_task_update","wait_agent","workflow"]
```

其中 `broadcast`/`multicast`/`team_summary` 来自 `@elinpf/dsh-swarm-tool-swarm`（`enableReview:false`，故无 `review_*`）。

---

## 4. 真实模型 overlay 用法（可复现脚本）

**问题**：DSH 内置 `dsh-llm-deepseek` 对本环境的 OpenAI 兼容端点返回 `401`（该适配器走 DeepSeek 原生
Messages 协议，与端点 `/v1` 不匹配）。**解法**：用 `llm-pi-ai` 手写一条 `openai-completions` 路由（overlay）。

固化为 `scripts/run-headless.sh`，一键用法：

```bash
bash scripts/run-headless.sh "Reply with exactly: PONG"
bash scripts/run-headless.sh --json "..."          # 透传 dsh headless 参数
DSH_PROFILE=web bash scripts/run-headless.sh ...   # 换 profile
```

脚本行为：
1. `source scripts/env.sh` 进入隔离环境；
2. 解析模型端点/密钥：优先环境变量 `DSH_MODEL_BASEURL`/`DSH_MODEL_KEY`，否则从本机
   `/root/.jiuwenswarm/config/config.yaml` 的 `models.defaults[is_default=true]` 读取（`api_base`/`api_key`）；
   **密钥只注入进程环境，不落盘、不打印**；
3. 生成 overlay 到 `.runtime/model-overlay.yml`（内容见下）；
4. `exec dsh --profile <profile> --patch <overlay> "$@"`。

生成的 overlay：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      dshdemo:
        apiKeyEnv: DSH_DEMO_KEY
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

实测输出（`--json`）：

```json
{"type":"session","sessionId":"session-5ed93b5b-...","cwd":".../dsh-swarm"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"text","text":"PONG"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"PONG"}
```

→ **真实模型路由打通**（`usage` 报 `inputTokens:6680, outputTokens:4`）。

---

## 5. 最小团队交互输出（真实模型驱动）

命令（等价于 `scripts/e2e-profile.sh` 的步骤 3）：

```bash
bash scripts/run-headless.sh --json "Do these in order and report each raw tool result verbatim:
  1) spawn_teammate name='bob' description='dm-probe' prompt='Reply with exactly ACK';
  2) send_message target='bob' message='hello from lead';
  3) team_task_create subject='demo-task' description='task board probe';
  4) team_task_list."
```

真实工具结果（节选自 `--json` 流，`tool_result` 原文）：

```json
{"tool":"spawn_teammate","result":"{\"member\":{\"target\":\"bob\",\"role\":\"teammate\",\"status\":\"running\",\"description\":\"dm-probe\",\"provider\":\"spawn\",\"context\":\"fresh\",\"model\":\"DeepSeek-Flash\",\"diagnostics\":[]}}"}
{"tool":"send_message","result":"{\"sent\":true}"}
{"tool":"team_task_create","result":"{\"id\":\"task-1\",\"revision\":1,\"subject\":\"demo-task\",\"description\":\"task board probe\",\"status\":\"pending\",\"blockedBy\":[],\"writeScopes\":[],\"ready\":true,\"writeScopeWarnings\":[]}"}
{"tool":"team_task_list","result":"{\"tasks\":[{\"id\":\"task-1\",\"revision\":1,\"subject\":\"demo-task\",...,\"status\":\"pending\",...}]}"}
```

另一次 `spawn_teammate` + `list_agents`：

```json
{"tool":"list_agents","result":"[{\"target\":\"lead\",\"role\":\"lead\",\"status\":\"running\",\"model\":\"DeepSeek-Flash\",\"diagnostics\":[]},{\"target\":\"alice\",\"role\":\"teammate\",\"status\":\"inactive\",\"description\":\"probe\",\"provider\":\"spawn\",\"context\":\"fresh\",\"model\":\"DeepSeek-Flash\",\"diagnostics\":[]}]"}
```

**结论**：`spawn_teammate` / `send_message`(DM) / `team_task_create` / `team_task_list` / `list_agents`
在**真实 DSH profile + 真实模型**上全部跑通；成员与任务 durable 落盘（lead 会话含 `team/member` 事件）。

---

## 6. 两个待确认工具的**真机探针**

### 6.1 `followup_task` — ❌ 该工具在 0.2.1-rc.3 中**不存在**

排查（对已安装的实验包逐一 grep）：

```console
$ grep -rhoE "followup_task" .runtime/dsh-home/profiles/headless/node_modules/ | sort -u
（无任何输出）
$ grep -rhoE "(spawn_teammate|send_message|list_agents|wait_agent|interrupt_agent|team_task_[a-z]+)" \
    .../dsh-experimental-tool-agent-team/lib/index.js | sort -u
interrupt_agent / list_agents / send_message / spawn_teammate / wait_agent /
team_task_create / team_task_get / team_task_list / team_task_update
```

→ `@deepseek-ai/dsh-experimental-tool-agent-team@0.2.1-rc.3` **只注册 9 个工具，没有 `followup_task`**。
（此前 spike 记「工具可见、源码存在」，在 0.2.1-rc.3 上**不能复现**——据源码，唤醒 inactive 成员的机制就是
`send_message`：「an inactive target starts or resumes a turn」。）

**等价能力实测（唤醒 inactive 成员 → 新起一个 turn）**：

```bash
bash scripts/run-headless.sh --json "1) spawn_teammate name='bob' ... prompt='Reply with exactly FIRST';
  2) wait_agent timeout_ms=20000; 3) list_agents;
  4) send_message target='bob' message='Reply with exactly SECOND';
  5) wait_agent timeout_ms=20000; 6) list_agents."
```

关键真实结果：

```json
{"tool":"list_agents","result":"[..., {\"target\":\"bob\",...,\"status\":\"inactive\",...}]"}   // 第 1 轮后 inactive
{"tool":"send_message","result":"{\"sent\":true}"}
{"tool":"wait_agent","result":"{\"timedOut\":false}"}                                          // 有变化 → bob 被唤醒
```

读回 **bob 的子会话** durable 日志（`.runtime/dsh-home/sessions/.../22a1e30b-.../session.v4.jsonl.zstd`）：

```
user/message      turn1  "Reply with exactly FIRST"
assistant/message turn1  "FIRST"
user/message      turn2  "Team message from lead: Reply with exactly SECOND"  (source: agent-message/relay)
assistant/message turn2  "SECOND"
```

→ **`send_message` 对 inactive 成员确实会「启动/恢复一个 turn」**，即 JiuwenSwarm 意义的「followup/唤醒投递」
在本版本由 `send_message` 承载，**已实测**（跨 turn 回复链完整）。

### 6.2 `interrupt_agent` — ✅ 真机探针跑通

`interrupt_agent` 由 `tool-agent-team` 注册，且其 config schema 为
`interrupt: z.boolean().default(true)`（默认开启）。探针：

```bash
bash scripts/run-headless.sh --json "1) spawn_teammate name='dave' description='interrupt probe'
  prompt='Count from 1 to 300, one number per line, then write DONE.';
  2) immediately call interrupt_agent target='dave'; 3) list_agents."
```

真实结果：

```json
{"tool":"spawn_teammate","result":"{\"member\":{\"target\":\"dave\",...,\"status\":\"running\",...}}"}
{"tool":"interrupt_agent","result":"{\"previousStatus\":\"running\"}"}        // ← 中断了正在运行的 turn
{"tool":"list_agents","result":"[..., {\"target\":\"dave\",...,\"status\":\"inactive\",...}]"}
```

→ **`interrupt_agent` 真机跑通**：对一个正在运行的 teammate turn 触发中断，返回 `previousStatus:running`，
随后 `list_agents` 显示 `dave` 转为 `inactive`。

---

## 7. 仍未跑通 / 未覆盖的项与原因

| 项 | 状态 | 原因 / 说明 |
|---|---|---|
| `followup_task` 工具 | ❌ **不存在** | 0.2.1-rc.3 的 `tool-agent-team` 只注册 9 个工具，无此工具名；等价能力见 §6.1 |
| Web roster / task-board UI | 未测 | 本次仅 CLI/headless；需另装 `dsh-experimental-client-ui-agent-team` + `dsh web` |
| 多成员并发高负载 / 压测 | 未测 | 单进程、无压测，列入后续 |
| 跨进程分布式 / worktree+文件锁 | 未涉及 | 属阶段 2/3 能力，本任务只做 e2e 联调 |
| 团队 bundle 重复插入 `agent-team`/`tool-agent-team` | ⚠️ 观察项 | `@elinpf/dsh-swarm-bundle` 的 insert 里再次插入了这两个 id（与 agent-team-profile 重复）。`--dump-config` 与真实运行均未见冲突，但**建议 P2 复核**是否应改为「仅 disabled legacy + 插入 dsh-swarm 自身 7 行」以避免潜在重复 id 语义歧义 |

> 纪律：以上「跑通」项均附真实命令与输出；`followup_task` 记为**不存在**而非「成功」，未编造。

---

## 8. 一键复现（新机器）

```bash
cd <项目>/dsh-swarm
bash scripts/setup-env.sh --npm-cli     # 隔离 Node/pnpm + 发布版 dsh CLI（P1）
bash scripts/e2e-profile.sh             # 装 profile+bundle、dump-config 断言、真实模型团队交互、interrupt 探针
# 单独跑真实模型：
bash scripts/run-headless.sh "Reply with exactly: PONG"
```

前置：bash、可访问外网（或内网镜像）、能读到模型端点/密钥（`DSH_MODEL_*` 或本机 config.yaml）。
`scripts/e2e-profile.sh --no-model` 可在无模型/无网络时只做 profile + `--dump-config` 断言。

---

*（本记录由 dsh-env-engineer 生成；所有「跑通」结论均来自真实命令输出，证据落 `.runtime/probe/e2e-*`；
失败项如实标注。）*
