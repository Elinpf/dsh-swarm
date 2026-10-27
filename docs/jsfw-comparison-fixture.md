# JiuwenSwarm 侧隔离对照夹具（P12-jswarm-fixture）

> 产出人：cluster-impl-analyst（集群实现分析师）
> 任务：P12-jswarm-fixture
> 结论：**可行（框架层微型夹具）** —— 已用**零模型调用（桩模式）**在**完全隔离**环境下跑通「建队 / 建成员 / DM / 广播 / 任务 DAG / 评审闸」六个可观测动作。
> 权威源：`/opt/openjiuwen/workswarm-venv/lib/python3.12/site-packages/openjiuwen`（openjiuwen 0.1.19）
> 约定：`【事实】`= 实跑命令 + 输出 + 源码位置；`【推断】`= 未实测的判断。

---

## 0. 一句话结论与 token 消耗

- **可行性**：**【事实】** 可以在隔离环境直接 `import openjiuwen` 起一个最小团队并驱动六个可观测动作，**全程不连网络 / 不启 IM / 不启 cron / 不启 gateway / 不写 `/root/.dsh`**，且不触碰运行中的实例。
- **本轮实际消耗 / 5M 上限 = 0 / 5,000,000 token**（**桩模式 / `--no-model`**：夹具从不发起模型调用，见 §3 证据）。真实模型调用**未开启**，符合 leader 的成本门禁先判可行性的要求。
- **端到端 LLM 驱动**（让 leader 的 DeepAgent 自主调工具完成同样动作）**未在本轮执行**——这是**推断**可行的路径，但需要真实模型，本轮按门禁先不做。

---

## 1. 隔离方案

### 1.1 隔离手段

| 维度 | 手段 | 证据 |
|---|---|---|
| 运行态 HOME | 子进程内设 `OPENJIUWEN_HOME=<项目内目录>`；框架 `get_openjiuwen_home()` 依次取 task-local → 显式 override → **环境变量** → `~/.openjiuwen` | `agent_teams/paths.py:42-71` |
| 独立 DB | 默认 sqlite 落 `get_agent_teams_home()/team.db` = `$OPENJIUWEN_HOME/.agent_teams/team.db`，随 HOME 一起隔离 | `schema/blueprint.py:719-734`（`resolve_db_config`）、`paths.py:76-78` |
| 独立工作区 | 成员 `WorkspaceSpec.root_path` 指向项目内 `.jsfw-home/ws` | 夹具 `build_spec()` |
| 消息传输 | `spawn_mode="inprocess"` 强制进程内 messager（无外部 MQ） | `schema/blueprint.py:~700`（inprocess 才物化 inprocess 传输；`process` 需真实跨进程后端） |
| 不启服务 | 直接调用框架 Python API，不经过产品入口 `jiuwenswarm/app.py` / `start_services.py`，无 gateway/cron/IM | 夹具仅 import `openjiuwen.*` |
| 不干扰运行实例 | 子进程级 `OPENJIUWEN_HOME` 与运行实例的 HOME 不同；不改共享文件；只读源码 | §3 输出 |

### 1.2 落盘位置（全部在项目内）

```
dsh-swarm/scripts/bench/jsfw/
├── probe_min_team.py          # STAGE-1：隔离下构建+配置 leader TeamAgent      # 入库
├── probe_stage2_actions.py    # STAGE-2：驱动六个可观测动作                     # 入库
├── probe_out.log              # STAGE-1 实跑输出（验收证据）                    # 入库
├── stage2_out.log             # STAGE-2 实跑输出（验收证据）                    # 入库
├── .gitignore                 # 忽略下面两类运行态（均由探针重建）              # 入库
├── .jsfw-home/                # 隔离运行态（OPENJIUWEN_HOME）—— 重建产物，gitignore
│   ├── ws/skills-visibility.json   # 框架按 agents.skills 自举，非手工输入
│   └── .agent_teams/team.db        # 隔离 DB（+ team.db-wal / -shm）
└── logs/                      # 框架默认日志（相对 CWD）—— 旁生产物，gitignore
```

> **入库边界**：上表标注「入库」的四个文件 + `.gitignore` 进仓库；`.jsfw-home/` 与 `logs/` 为**运行态/旁产生物**（跑前 `rm -rf .jsfw-home` 即重建），已由 `jsfw/.gitignore` 排除，不在仓库中保留（原先误留的 `logs/logs` 嵌套与其中 3 个空日志已清理，用途见 `scripts/bench/README.md §7`）。

> **【事实·隔离瑕疵】** 框架日志模块会在**进程 CWD** 下创建 `logs/logs/*.log`（`team.log`/`runner.log`/…）。本夹具把 CWD 设在 `jsfw/` 内，故日志未外泄；但若基准 harness 换 CWD，需一并约定。**未写 `/root/.dsh`、未触碰 `~/.jiuwenswarm`。**

### 1.3 可复现命令

```bash
cd /root/.jiuwenswarm/agent/workspace/work/jiuwen/dsh-swarm/scripts/bench/jsfw

# STAGE-1：构建 + 配置（无网络、无服务）
rm -rf .jsfw-home
/opt/openjiuwen/workswarm-venv/bin/python -u probe_min_team.py > probe_out.log 2>&1; echo "exit=$?"

# STAGE-2：驱动六个可观测动作（无模型）
rm -rf .jsfw-home
/opt/openjiuwen/workswarm-venv/bin/python -u probe_stage2_actions.py > stage2_out.log 2>&1; echo "exit=$?"
```

---

## 2. 实跑结果（验收证据）

### 2.1 STAGE-1 —— 隔离下构建 leader（exit=0）【事实】

`probe_out.log` 关键行：

```
[probe] OPENJIUWEN_HOME=/root/.jiuwenswarm/agent/workspace/work/jiuwen/dsh-swarm/scripts/bench/jsfw/.jsfw-home
[probe] resolved openjiuwen_home      = .../jsfw/.jsfw-home
[probe] resolved agent_teams_home      = .../jsfw/.jsfw-home/.agent_teams
...
WARNING | Failed to import online training rail factory: No module named 'redis'      # 优雅降级，非致命
WARNING | [DeepAgent] online training rail factory unavailable: No module named 'redis'
[probe] leader agent = TeamAgent role=TeamRole.LEADER member=team_leader
[probe] team_backend = TeamBackend team_name=jsfw_fixture
[probe] task_manager   = TeamTaskManager
[probe] message_manager= TeamMessageManager
[probe] harness        = TeamHarness
[probe] STAGE-1 OK: built+configured a minimal leader TeamAgent with no network/service.
```

- 只需 `ModelClientConfig(client_provider="OpenAI", api_key="sk-x", api_base="http://127.0.0.1:9/v1")` 占位即可构建（`:9` 端口**从未被连接**，全程无网络）。
- 源码链：`TeamAgentSpec.build()` → `blueprint.py:736` → new `TeamAgent` + `configure`（`team_agent.py:554`）→ `CoordinationKernel.setup`（`kernel.py:63`）→ `TeamHarness`（`harness/team_harness.py:52`）。
- `redis` 缺失只触发警告，**不是依赖阻塞**。

### 2.2 STAGE-2 —— 六个可观测动作（exit=0，零模型调用）【事实】

`stage2_out.log` 的 `[stage2]` 行（原样）：

```
[stage2] session_id=jsfw_fixture_sid backend=TeamBackend task_mgr=TeamTaskManager msg_mgr=TeamMessageManager
[stage2] build_team OK; roster=[]
[stage2] spawn_member(worker_a) ok=True
[stage2] spawn_member(reviewer_x) ok=True
[stage2] roster now=['worker_a', 'reviewer_x']
[stage2] DM message_id=80836c53-e428-4536-bb7c-a1bb004294aa
[stage2] broadcast message_id=32d9532e-3c30-43bd-a0d1-a357d7377ec7 unread=True
[stage2] add_graph ok=True reason=''
[stage2] after add: t1=pending t2=blocked            # DAG 依赖阻塞生效
[stage2] worker_a.claim(t1) ok=True -> in_progress
[stage2] worker_a.complete(t1) ok=True reason=''
[stage2] t2 after t1 completed = pending             # 依赖解锁生效
[stage2] add_graph(t3) ok=True
[stage2] worker_a.claim(t3) ok=True -> in_progress
[stage2] worker_a.complete(t3) ok=True -> status=in_review   # 带 reviewer → 进验证闸
[stage2] verify_task(pass) ok=True reason='' -> t3=completed # 评审通过
[stage2] STAGE-2 OK: drove create-team/member/DM/broadcast/task-DAG/review with NO model call.
```

对照源码：
- 建队/建成员：`TeamBackend.build_team`（`tools/team.py:1894`）、`spawn_member`（`tools/team.py:617`）
- DM/广播：`TeamMessageManager.send_message`（`tools/message_manager.py:60`）、`broadcast_message`（`:119`）
- 任务 DAG + 状态机：`TeamTaskManager.add_graph`（`tools/task_manager.py:174`）/`claim`（`:517`）/`complete`（`:602`）；状态迁移表 `schema/status.py:318-351`
- 评审闸：`complete` 见 reviewer → `_submit_for_review`（`:683`）；`verify_task`（`:710`）——**autonomous 模式首票即决**（`:711-720` docstring）

### 2.3 关键踩坑（供 harness 复用）【事实】

| 现象 | 命令/报错 | 根因（源码） | 解法（夹具已含） |
|---|---|---|---|
| `StorageSpec` 校验失败 | `type Field required` | `StorageSpec.type` 必填（`blueprint.py:124`） | 用 `type="sqlite"`；或干脆省略 `storage`，默认落隔离 HOME |
| `TeamAgentSpec.workspace` 校验失败 | `Input should be … TeamWorkspaceConfig` | spec 级 `workspace` 是 `TeamWorkspaceConfig` 非 `WorkspaceSpec`（`blueprint.py`） | 省略顶层 `workspace`，成员级用 `DeepAgentSpec.workspace` |
| DM 返回 `None`，broadcast 抛 `no such table: team_message_<hash>` | `sqlite3.OperationalError` | 消息表是**按会话的动态表**，仅当 contextvar 绑定了 session 才创建（`tools/database/__init__.py:40-41`、`:206`） | 先 `set_session_id("<sid>")` 再 `db.initialize()` + `create_cur_session_tables()` |
| `add_graph` 失败 | `Member team_leader is the team leader and cannot be assigned team tasks` | leader 不可被派任务（团队语义） | 任务指派给普通成员；用**成员级** `TeamTaskManager` 执行 claim/complete |
| `complete` 失败 | `cannot be completed from status 'pending' (must be in_progress)` | 状态机：PENDING 不能直接 COMPLETED（`status.py:318-351`） | 先 `claim`（→IN_PROGRESS）再 `complete` |
| 依赖任务的解锁 | 期望 t2 从 blocked→pending | `complete_task` 原子解锁下游 | 完成 t1 后自动解锁，已实测 |

> `【事实】`「成员级 TaskManager」是框架**自身**用于临时 reviewer 的同一模式：`scheduler.py:500` 用 `TeamTaskManager(member_name=<reviewer>)` 让身份守卫通过。夹具复用该模式，非 hack。

---

## 3. 未做到 / 明确边界（诚实清单）

| 项 | 状态 | 说明 |
|---|---|---|
| **真实模型端到端**（leader DeepAgent 自主调工具完成六动作） | **未做** | 需真实模型 + token；本轮按成本门禁先判可行性。**推断**可行：`Runner.run_agent_team_streaming` 会启动协调内核与 DeepAgent，给 leader 一条 query 即触发回合（`team_agent.py:747/810`）。 |
| **成员运行时真拉起**（`inprocess_spawn` 跑起 teammate 协程） | **未做** | 夹具只建成员 **DB 行**（`spawn_member`），未 `startup_member`。真拉起需 `Runner.run_agent_team(member=True)` 且依赖会话/事件循环（`spawn/inprocess_spawn.py:136`）。 |
| **子进程 / 外部 CLI / 跨进程（pyzmq/hybrid）** | **未做** | 夹具锁定 `spawn_mode="inprocess"`。跨进程形态需额外隔离 MQ，本轮不涉及。 |
| **真实并发/负载压测** | **未做** | 只验证「能跑通动作 + 状态正确」，未测吞吐/并发成员数。 |
| **消息实际投递到活成员** | **部分** | DM/广播写了 DB 行并置 `unread=True`；因无成员运行时，未验证「活成员消费」。 |

**token 消耗明细**：本轮 **0 token**（无任何模型调用；`grep` 确认日志无 `chat/completions` 等调用，`127.0.0.1:9` 从未被连接）。

---

## 4. 口径对齐：可比 / 不可比指标

### 4.1 「单位工作」的统一口径（关键）

**【设计主张】** 两边都把**单位工作（unit of work）**定义为**一次协作语义动作在编排层产生的可观测副作用**，**不含模型 token**：

| 动作 | 单位 | JiuwenSwarm 的对应实现 | DSH(dsh-swarm) 的对应实现 |
|---|---|---|---|
| 建成员 | 1 次 | `TeamBackend.spawn_member` | `ctx.teamCore` roster op |
| DM | 1 条 | `TeamMessageManager.send_message` | `ctx.teamBus` direct |
| 广播 | 1 次扇出到 N 成员 | `broadcast_message` | `team-bus` pub/sub fan-out |
| 任务状态迁移 | 1 次迁移 | `claim/complete/verify_task` | `team-scheduler` + `team-review` |
| 评审裁决 | 1 次 tally/settle | `verdict.judge`/`settle_review` | `team-review` |

- 源系统是 **Python**：`inprocess` = 同一事件循环的 `asyncio.Task`（`spawn/inprocess_spawn.py:148`），`process` = 子进程；两者**线程边界不同**。
- 目标系统是 **TS + Cordis**：进程内单事件循环的插件服务（`ctx.teamBus` 等），当前为**单进程**（阶段 3 才有 `team-distributed`）。
- **对齐规则**：只比较「同一协作动作」的 **①事件扇出放大比 ②DB 往返次数 ③状态迁移序列 ④单动作 CPU/墙钟**，且**限定同为进程内模式**（JiuwenSwarm `spawn_mode=inprocess` ↔ DSH 单进程）。**不比较进程数 / 内存 / 模型 token。**

### 4.2 可比指标（推荐纳入基准）

| # | 指标 | 定义 | 为什么可比 | 采集位置（JiuwenSwarm） |
|---|---|---|---|---|
| C1 | 广播扇出放大比 | 投递/写入次数 ÷ 成员数 | 纯编排逻辑，与语言无关 | `message_manager.broadcast_message`（`message_manager.py:119`）+ DB 行数 |
| C2 | 每动作 DB 往返数 | 一次动作触发的 SQL 语句数 | 可埋点，语义一致 | `DbSessions` 写锁 / DAO 调用计数 |
| C3 | 任务状态迁移序列 | 动作前后的状态串 | 状态机两边等价可测 | `status.py:318-351` 对照 |
| C4 | DAG 依赖正确性 | blocked↔pending 翻转 | 纯逻辑 | `add_graph`/`complete_task` |
| C5 | 幂等性 | 重复触发是否重复副作用 | CAS/幂等语义可比 | `startup_member` CAS（`tools/team.py:842`）、`start_task` |
| C6 | 空转/唤醒计数 | idle tick 产生的空回合数 | 轮询语义可比 | `EventBus._poll_loop` 30s（`event_bus.py:95,297`） |
| C7 | 评审裁决数学 | pass/fail 计票与 settle 结果 | 规则可枚举 | `verdict.judge`（`scheduling/verdict.py`） |
| C8 | 单动作 CPU / 墙钟 | 端到端时延 | 同机同模式可比 | 夹具计时 |

### 4.3 不可比指标（务必排除或标注）

| # | 指标 | 为什么不可比 |
|---|---|---|
| N1 | **绝对 token / 模型延迟** | 取决于模型与 prompt，**与编排实现无关**；只能「同模型同 prompt」下测，且属另一维度 |
| N2 | **进程/内存绝对值** | Python(GIL, asyncio) 与 Node(单线程 loop) 边界不同；inprocess/subprocess 形态不同；无同构部署则不可比 |
| N3 | **DB 引擎吞吐** | JiuwenSwarm 默认 SQLite（可换 PG/MySQL，`config.py:11-16`），DSH 用 `ctx.storage`；绝对 IOPS 不可比，**仅 C2 往返数可比** |
| N4 | **跨进程/分布式指标** | JiuwenSwarm 有 pyzmq/hybrid 后端，DSH 当前单进程（`team-distributed` 在阶段 3）；跨进程指标当前**不对齐** |
| N5 | **冷启动时间** | JiuwenSwarm import 需加载 parser/connector/DB 方言等（本夹具 STAGE-1 含大量非协作代码，~20s），DSH 为 bundle 加载；**不代表协作层开销** |
| N6 | **代码行数/包数** | 形态差异大（1 个 Python 包 vs 18 个 TS 包），非性能指标 |

---

## 5. 交给基准 harness 的接口约定

- 夹具脚本**机器可读**：向 stdout 打印 `[stage1]` / `[stage2]` 前缀行，`exit=0` 表示成功；harness 可据此判定。
- 每次跑前 `rm -rf .jsfw-home` 保证**冷启动可复现**。
- **公平对照的前置条件（供 leader / bench-qa-engineer）**：两侧**必须**用同一模型端点、同 prompt、同 5M/次 token 上限；本轮为**桩模式**，未使用任何模型额度，故不构成「已对齐的真实模型对照」。
- **【设计主张】** 若无法保证两侧模型/prompt 完全一致，则**只采信 C1–C7 的框架层微观指标**（它们是公平且与模型无关的），**不采信 N1** 的绝对 token 对比。

---

## 6. 结论

- **结局：可行。** 已交付一套**可重复、完全隔离、零模型消耗**的 JiuwenSwarm 侧夹具（两个脚本 + 两份实跑日志），能将「建队/建成员/DM/广播/任务 DAG/评审闸」六个协作动作在框架层可观测地跑通。
- **对照公平性**：C1–C8 为可比微观指标；N1–N6 不可比（尤其绝对 token、进程/内存、DB 吞吐、跨进程）。
- **未做到**：真实模型端到端、成员运行时真拉起、跨进程形态（§3）——均在**桩模式**下有意不做，符合成本门禁。
