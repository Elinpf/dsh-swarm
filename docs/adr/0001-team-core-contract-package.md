# ADR-0001：端口类型独立成包 `@dsh-swarm/team-core-contract`

- 状态：已采纳（Accepted）
- 日期：2026-10-26
- 决策人：team-leader（裁定方案 C）；提出人：dsh-plugin-dev
- 相关：`docs/implementation-spec.md` §4.1、`docs/package-layout.md`、任务 P4a-impl-libs / P4-impl-core

---

## 1. 背景与问题

实现规格（`implementation-spec.md` §4.1）把团队协作端口 `TeamCore` 的类型定义在 `@dsh-swarm/team-core` 包内，并约定其它插件「只通过 `ctx.teamCore` 端口交互，禁止直接依赖实验包类型」。

但在**实际排期**上出现了结构性矛盾：

- 任务 **P4a**（backend-独立包：`team-bus` / `team-prompt` / `team-scheduler` / `team-review` / `team-completion` / `tool-swarm`）被安排**先于** `team-core` 实现（理由是这些包不依赖 P3-spike 的 agent-team 实测结论）；
- 而它们**全部**要经 `ctx.teamCore` 通信，需要 `TeamCore` / `TaskView` / `MessageRange` / `TeamMembership` 等类型，以及 `ctx.teamCore` 的类型增强；
- 按 §4.1 这些类型都住在尚未创建的 `@dsh-swarm/team-core` 里 → 消费包 `import type { TeamCore } from '@dsh-swarm/team-core'` 无法解析，根 `pnpm build` / `typecheck` 必然失败，P4a 的验收（根 build/test 全绿）无法达成。

即：**端口的类型宿主在 P4a 开工时不存在**。

---

## 2. 候选方案

| 方案 | 做法 | 评价 |
|---|---|---|
| **A** | P4a 先把 `@dsh-swarm/team-core` 建成「仅端口类型 + 类型增强」的包，P4 再补 Service/后端 | 能解阻塞；但契约与实现仍同处**一个包**，消费方物理上仍可 `import '@dsh-swarm/team-core/src/internal'`，「禁止直连内部实现」只是约定、无编译期保障 |
| **B** | 把 `team-core` 整体提前进 P4a（合并 core 部分） | 违背「先做 backend-独立包、不等 P3-spike」的排期意图；且 P3-spike 未出时无法定后端 |
| **C（采纳）** | 新增独立包 `@dsh-swarm/team-core-contract`，**只含** §4.1 冻结类型 + `ctx.teamCore` 类型增强；6 个包与未来的 `team-core` 都只从这里取类型 | 契约与实现**物理分离**，约束在**编译期**成立；代价仅是多一个极小包 |

---

## 3. 决策

**采用方案 C。** 理由：

1. **编译期强制边界**：消费包只能 import `@dsh-swarm/team-core-contract`，无法触达 `team-core` 的内部实现——把团队硬约束「包间只经端口通信」从口头约定升级为类型系统保证。
2. **端口稳定、实现可换**：`team-core` 未来把后端从 `native` 换成 `owned`，或在 P3-spike 后调整实现，都不改动契约包，消费包零改动。
3. **成本极低**：契约包无运行时依赖、编译产物为空模块（`export {}`）。
4. **符合依赖倒置**：高层（各能力插件）依赖抽象（契约），实现（`team-core`）依赖抽象。

---

## 4. 后果

### 4.1 包清单修订（8 包 → 9 包）

在 `implementation-spec.md` / `package-layout.md` 原 8 包基础上**新增**：

| 包名 | 路径 | 角色 | 阶段 |
|---|---|---|---|
| `@dsh-swarm/team-core-contract` | `packages/team-core-contract/` | 端口类型 SSOT + `ctx.teamCore` 类型增强；**无实现** | 0（与 core 同阶段） |

> 本 ADR 只记录修订；`implementation-spec.md` / `package-layout.md` 由 migration-architect 维护，不在此就地修改，避免冲突。

### 4.2 约束（对后续实现强制）

- 6 个 backend-独立包**只从 `@dsh-swarm/team-core-contract` 取类型**，**禁止**从 `@dsh-swarm/team-core` import。
- `@dsh-swarm/team-core`（P4-impl-core）**依赖契约包**实现 `Service` 与 `native`/`owned` 后端；**不得在 `team-core` 内复制端口类型**（SSOT 唯一）。
- `ctx.teamCore` 的类型增强放在**契约包**，保证所有消费者（含 `team-core` 自身）都能解析该属性。
- 契约包内**不得**出现 Service、后端、运行时逻辑；`dependencies` 不含运行时依赖（仅 type-only peer）。

### 4.3 验证

- `packages/team-core-contract/tests/team-core-contract.spec.ts`：断言运行时零导出 + 用 `expectTypeOf` 冻结 §4.1 关键形状。
- `pnpm build` / `pnpm typecheck` 在 6 个消费包上通过即证明类型增强可解析。

---

## 5. 备选未被采纳的原因（一句话）

A 无法在编译期阻止「直连内部实现」；B 与排期意图冲突。选 C 以最小增量换来最强的边界保证。
