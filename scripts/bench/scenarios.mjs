/**
 * 基准场景集（S1–S5）——**声明式**，与执行后端解耦。
 *
 * 每个场景同时给出：
 *   - `stub`  : 离线桩后端的步骤计划（直接调用真实插件服务，零模型成本）；
 *   - `model` : 真实模型后端的中文指令（交给 dsh headless 的 lead 会话）。
 *
 * 口径纪律：场景一旦定义就固定，不允许为「让指标好看」而裁剪步骤或改指标定义。
 * 新增场景：在本文件 `SCENARIOS` 里加一项，两步都要给出（stub 计划 + model 指令），
 * 并在 `docs/benchmark.md` 记录基线。详见 scripts/bench/README.md。
 *
 * @module scripts/bench/scenarios
 */

/**
 * @typedef {Object} StubStep
 * @property {string} op
 * @property {Object} [args]
 */

/** 统一文本内容块构造（与插件内部一致）。 */
export const txt = (text) => [{ type: 'text', text }]

/** stub 计划里用到的操作语义（由 stub-runner 解释执行）：
 *  spawn{name,desc}
 *  dm{to,delivery,text}
 *  broadcast{topic,delivery,text}
 *  multicast{targets,delivery,text}
 *  taskCreate{ref,subject,blockedBy?}
 *  taskClaim{ref,owner}
 *  taskComplete{ref}
 *  taskSetDeps{ref,blockedBy}
 *  reviewSubmit{ref}
 *  reviewVote{ref,role,decision|value}
 *  scan{label?}             —— 调 teamScheduler.scan，记录 ScanReport
 *  sleep{ms}
 *  flakyDm{to,delivery,text,failTimes}  —— 前 failTimes 次投递抛错，之后成功（重试路径）
 *  wait{timeoutMs}          —— teamCore.waitForChange（超时路径）
 */

export const SCENARIOS = {
  S1: {
    id: 'S1',
    title: '单成员 spawn + 一次 DM',
    covers: '成员生命周期 + 点对点投递',
    stub: [
      { op: 'spawn', args: { name: 'alice', desc: 'worker' } },
      { op: 'dm', args: { to: 'alice', delivery: 'wakeup', text: 'hello from lead' } },
    ],
    model:
      "Do these in order and report each raw tool result verbatim: " +
      "1) spawn_teammate name='alice' description='worker' prompt='Reply with exactly ACK'; " +
      "2) send_message target='alice' message='hello from lead'; " +
      "3) list_agents.",
    modelExpect: { minToolCalls: 3, tools: ['spawn_teammate', 'send_message'] },
  },

  S2: {
    id: 'S2',
    title: '多成员广播（含被叫醒但无自己消息的空转成员）',
    covers: '广播扇出 + 空转唤醒结构计数',
    stub: [
      { op: 'spawn', args: { name: 'alice', desc: 'worker-a' } },
      { op: 'spawn', args: { name: 'bob', desc: 'worker-b' } },
      { op: 'spawn', args: { name: 'carol', desc: 'worker-c' } },
      { op: 'broadcast', args: { topic: 'team', delivery: 'wakeup', text: 'standup in 5' } },
    ],
    model:
      "Do these in order and report each raw tool result verbatim: " +
      "1) spawn_teammate name='alice' description='worker-a' prompt='Reply with exactly A'; " +
      "2) spawn_teammate name='bob' description='worker-b' prompt='Reply with exactly B'; " +
      "3) spawn_teammate name='carol' description='worker-c' prompt='Reply with exactly C'; " +
      "4) broadcast content='standup in 5' topic='team'; " +
      "5) list_agents.",
    modelExpect: { minToolCalls: 5, tools: ['spawn_teammate', 'broadcast'] },
  },

  S3: {
    id: 'S3',
    title: '任务 DAG：创建 → 阻塞 → 解锁 → 完成',
    covers: '任务看板状态流转 + 依赖解锁',
    stub: [
      { op: 'spawn', args: { name: 'alice', desc: 'worker' } },
      { op: 'taskCreate', args: { ref: 't1', subject: 'A: build' } },
      { op: 'taskCreate', args: { ref: 't2', subject: 'B: test', blockedBy: ['t1'] } },
      { op: 'taskClaim', args: { ref: 't1', owner: 'alice' } },
      { op: 'taskComplete', args: { ref: 't1' } },
      { op: 'taskClaim', args: { ref: 't2', owner: 'alice' } },
      { op: 'taskComplete', args: { ref: 't2' } },
    ],
    model:
      "Do these in order and report each raw tool result verbatim: " +
      "1) spawn_teammate name='alice' description='worker' prompt='Reply with exactly OK'; " +
      "2) team_task_create subject='A: build' description='first'; " +
      "3) team_task_create subject='B: test' description='second' blockedBy=['<taskA id>']; " +
      "4) team_task_list; 5) team_task_get id='<taskB id>'; 6) team_task_update id='<taskA id>' action='claim' owner='alice'; " +
      "7) team_task_update id='<taskA id>' action='complete'; 8) team_task_get id='<taskB id>'.",
    modelExpect: { minToolCalls: 8, tools: ['team_task_create', 'team_task_list', 'team_task_update'] },
  },

  S4: {
    id: 'S4',
    title: '评审闸往返（提交 → 评审 → 通过/返工）',
    covers: '验证闸 + 裁决数学 + 不可自验',
    stub: [
      { op: 'spawn', args: { name: 'alice', desc: 'author' } },
      { op: 'taskCreate', args: { ref: 't1', subject: 'review me' } },
      { op: 'taskClaim', args: { ref: 't1', owner: 'alice' } },
      { op: 'reviewSubmit', args: { ref: 't1' } },
      // 返工一轮：verifier 投 fail
      { op: 'reviewVote', args: { ref: 't1', role: 'verifier', decision: 'fail' } },
      { op: 'reviewVote', args: { ref: 't1', role: 'challenger', decision: 'pass' } },
      { op: 'reviewSettle', args: { ref: 't1' } },
      // 第二轮：全 pass
      { op: 'reviewVote', args: { ref: 't1', role: 'verifier', decision: 'pass' } },
      { op: 'reviewVote', args: { ref: 't1', role: 'challenger', decision: 'pass' } },
      { op: 'reviewSettle', args: { ref: 't1' } },
    ],
    model:
      "Do these in order and report each raw tool result verbatim (this profile may not expose review_* tools; " +
      "if a tool is missing, say so explicitly and continue): " +
      "1) spawn_teammate name='alice' description='author' prompt='Reply with exactly OK'; " +
      "2) team_task_create subject='review me' description='artifact'; " +
      "3) review_submit task_id='<id>'; 4) review_vote task_id='<id>' role='verifier' decision='fail'; " +
      "5) review_vote task_id='<id>' role='challenger' decision='pass'; 6) team_task_get id='<id>'.",
    modelExpect: { minToolCalls: 4, tools: ['team_task_create'] },
  },

  S5: {
    id: 'S5',
    title: '失败/卡住恢复（超时、重试、stale 自催）',
    covers: '超时等待 + 投递重试 + stale 自催/升级',
    scheduler: { staleClaimIdleMs: 40, staleEscalateStreak: 2 },
    stub: [
      { op: 'spawn', args: { name: 'alice', desc: 'slow-worker' } },
      // 超时路径
      { op: 'wait', args: { timeoutMs: 20 } },
      // 重试路径：前 2 次投递失败
      { op: 'flakyDm', args: { to: 'alice', delivery: 'wakeup', text: 'retry me', failTimes: 2 } },
      // 卡住：任务 in_progress 且久未推进
      { op: 'taskCreate', args: { ref: 't1', subject: 'stuck task' } },
      { op: 'taskClaim', args: { ref: 't1', owner: 'alice' } },
      { op: 'sleep', args: { ms: 60 } },
      { op: 'scan', args: { label: 'stale#1' } },
      { op: 'sleep', args: { ms: 60 } },
      { op: 'scan', args: { label: 'stale#2' } },
    ],
    model:
      "Do these in order and report each raw tool result verbatim: " +
      "1) spawn_teammate name='alice' description='slow-worker' prompt='Reply with exactly OK'; " +
      "2) team_task_create subject='stuck task' description='do it'; " +
      "3) team_task_update id='<id>' action='claim' owner='alice'; " +
      "4) wait_agent timeout_ms=1500; 5) list_agents; 6) send_message target='alice' message='please progress';",
    modelExpect: { minToolCalls: 5, tools: ['spawn_teammate', 'team_task_create'] },
  },
  S6: {
    id: 'S6',
    title: '任务自动派发（scheduler scheduled vs 无 scheduler）',
    covers: '一键自动派发：ready 任务 × 空闲成员 → 由调度器 claim 启动',
    stub: [
      { op: 'spawn', args: { name: 'alice', desc: 'worker-a' } },
      { op: 'spawn', args: { name: 'bob', desc: 'worker-b' } },
      { op: 'taskCreate', args: { ref: 't1', subject: 'job-1' } },
      { op: 'taskCreate', args: { ref: 't2', subject: 'job-2' } },
      { op: 'scan', args: { label: 'dispatch' } },
    ],
    model:
      "Do these in order and report each raw tool result verbatim: " +
      "1) spawn_teammate name='alice' description='worker-a' prompt='Reply with exactly A'; " +
      "2) spawn_teammate name='bob' description='worker-b' prompt='Reply with exactly B'; " +
      "3) team_task_create subject='job-1' description='x'; " +
      "4) team_task_create subject='job-2' description='y'; " +
      "5) team_task_list.",
    modelExpect: { minToolCalls: 5, tools: ['spawn_teammate', 'team_task_create'] },
  },
  S7: {
    id: 'S7',
    title: '空转唤醒探针：spawn→静置→广播（隔离广播的额外 LLM 轮）',
    covers: '被广播叫醒、且消息与自身无关时，是否仍耗 LLM 轮',
    stub: [
      { op: 'spawn', args: { name: 'alice', desc: 'idle-a' } },
      { op: 'spawn', args: { name: 'bob', desc: 'idle-b' } },
      { op: 'wait', args: { timeoutMs: 50 } },
      { op: 'broadcast', args: { topic: 'announce', delivery: 'wakeup', text: 'FYI only, no action needed' } },
    ],
    model:
      "Do these in order and report each raw tool result verbatim. " +
      "1) spawn_teammate name='alice' description='idle-a' prompt='Reply with exactly A and then stop. Do not do anything else.'; " +
      "2) spawn_teammate name='bob' description='idle-b' prompt='Reply with exactly B and then stop. Do not do anything else.'; " +
      "3) wait_agent timeout_ms=30000; 4) list_agents; " +
      "5) broadcast content='FYI only, no action needed' topic='announce'; " +
      "6) wait_agent timeout_ms=30000; 7) list_agents. " +
      "Do NOT send any direct messages to alice or bob.",
    modelExpect: { minToolCalls: 5, tools: ['spawn_teammate', 'broadcast', 'wait_agent'] },
  },
}

export const ALL_SCENARIO_IDS = Object.keys(SCENARIOS)

/** 真实模型模式的默认 token 门禁（用户指定：单次任务 5,000,000）。 */
export const DEFAULT_TOKEN_CAP = 5_000_000
/** token 上限绝不能超过的硬顶。 */
export const HARD_TOKEN_CAP = 5_000_000
