# DSH Team 模式调查报告 · 索引

> **归档说明**：本目录原为仓库根的未跟踪目录 `investigation/`，由 `bench-qa-engineer`（P50）归并入 `docs/investigation/` 并提交入库。
> 文中 `docs/investigation/…` 即归档后位置；原始「未跟踪状态」的旁述（如 `00-overview.md`）为当时记录，保留不改。
> **未入库**：`05-verify-tmp/session-*.jsonl`（约 2MB 原始会话日志，含会话内容、体积大，且可经 `evidence/04-extract-session.mjs` 从 `.runtime` 复现）。

本目录是**一次由 Agent Teams 自身完成的调查**：调查对象是 DSH（DeepSeek Harness）的 team 模式，
而调查过程本身就在 team 模式里跑（Lead + 4 名成员 + 共享任务板）。
因此本目录同时是「报告」和「样本」。

## 阅读顺序

| 顺序 | 文档 | 一句话摘要 |
| --- | --- | --- |
| ① | [00-overview.md](00-overview.md) | **总览**：TL;DR、两代码根心智模型、完整生命周期、14 条关键结论、缺口清单、核验处置、上手路径 |
| ② | [01-core-model.md](01-core-model.md) | 核心模型：隐式 Team、成员三层状态、生命周期状态机、任务板 CAS/依赖/writeScope、内存态 vs 持久态 |
| ③ | [02-tools-and-messaging.md](02-tools-and-messaging.md) | 工具面与消息：19 个工具的来源/开关/并集差集、一条消息的真实路径、`wait_agent` 语义、11 条「描述 vs 实现」出入 |
| ④ | [03-ui-wiring-and-docs.md](03-ui-wiring-and-docs.md) | UI 与装配：`agentTeam` 投影如何到达 Web 面板、本实例 212 条 entry 的实际装配、native 与 dsh-swarm 的能力边界 |
| ⑤ | [04-live-session-evidence.md](04-live-session-evidence.md) | 运行期活证据：本会话的 `team/member`/`team/task` 事件、inbox splice、`wait_agent` 实测、可复现命令 |
| ⑥ | [05-verification.md](05-verification.md) | **独立对抗式核验**：28 条承重论断的判定表（23 CORRECT / 3 WRONG / 2 IMPRECISE）+ 未通过项的替代措辞 |

想快速理解结论：读 ① 与 ⑤ 即可。想做代码级追证：读 ②③ + 对应证据文件。

## 证据文件

- `evidence/01-vitest-attempt.log` —— harness 自带 vitest 无法实跑的原始报错（缺 `dsh-agent-loop-testkit`）。
- `evidence/02-tool-registry-raw.md`、`evidence/02-delivery-and-wait-raw.md`、`evidence/02-live-observation.md` —— 工具注册表、投递/等待语义、活体探针原始记录。
- `evidence/03-file-fingerprints.txt` —— 引用文件的 sha256/mtime 快照（行号结论的定版依据）。
- `evidence/03-composed-entries.txt`、`evidence/03-instance-assembly.txt`、`evidence/03-bundle-patch-snapshot.txt`、`evidence/03-compose-probe.mjs` —— 只读复现本 profile 装配的脚本与输出。
- `evidence/04-extract-session.mjs`、`evidence/04-team-timeline.mjs` —— 解压多帧 zstd 会话日志、抽取 `team/*` 时间线的可复现脚本。
- `05-verify-tmp/` —— 核验员的检验产物（`check1-pure.mjs` 纯函数断言、`check2-live.mjs` 会话/投影交叉验证）。
- `dsh-team-mode/` —— **另一轮并行调查小组**（成员名 `arch-core`/`bus-messaging`/`ui-wiring`）的分节副本，
  其终稿在 `docs/dsh-team-mode-investigation.md`；不是本小组的交付物，阅读请以其自身引用为准。

## 证据等级约定（重要）

所有文档遵循同一约定：

- `[H]` = 上游 harness checkout `.runtime/deepseek-harness`（只读，0.2.1-rc.3）；
- `[S]` = 本仓 `packages/` 产品层；
- `[W]` = 工作区根文档/脚本；`[P]` = 运行 profile `.runtime/dsh-home/profiles/dsh-swarm-demo`；
- **模型侧工具描述文本不作为行为证据**，只作为「描述 vs 实现」比较的对象；
- 无法证实者一律标 `UNVERIFIED` 并写明原因与「为何不能回答」；
- 引用的行号以 03 的指纹快照为准；工作区在调查期间被并发写入者改动过（见 00 §8）。

## 调查小组与任务板（本次调查的实际执行）

| 任务 | 负责人 | 交付 | 状态 |
| --- | --- | --- | --- |
| task-1 核心模型 | `core-model` | 01（242 行，15 处行号/表述更正） | completed |
| task-2 工具面与消息 | `tools-messaging` | 02（432 行，19 项更正） | completed（核验后按 FIX-1 复审） |
| task-3 UI 与接线 | `wiring-ui` | 03（302 行，17 项更正） | completed（核验后按 FIX-2/4 复审） |
| task-5 运行期活证据 | `lead` | 04（256 行，16 条观测事实） | completed |
| task-4 独立核验 | `auditor` | 05（211 行，28 条判定 + 2 项可运行检验 + round-2 复验 7/7 RESOLVED） | completed |
| task-6 汇总终稿 | `lead` | 00（185 行）+ 本索引 | completed |
| task-7 修复后复验 | `auditor` | 05 §7（round 2） | completed |

> 结论的**判定权**在 05：00–04 中凡与 05 判定冲突之处，以 05 为准（本轮 5 项未通过已全部修复）。
