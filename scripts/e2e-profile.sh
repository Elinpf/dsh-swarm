#!/usr/bin/env bash
# =============================================================================
# e2e-profile.sh — 在【真实 DSH profile】上做端到端联调（可重复执行）
# -----------------------------------------------------------------------------
# 覆盖：
#   1) 幂等装齐 headless profile + 接入 @elinpf/dsh-swarm-bundle
#   2) `--dump-config` 断言：9 行团队插件出现、4 行 legacy tool-subagent* 为 disabled
#   3) 真实模型驱动的最小团队交互（spawn_teammate + send_message(DM) + team_task_*）
#   4) interrupt_agent 真机探针
#
# 用法：
#   bash scripts/e2e-profile.sh                 # 全流程（含真实模型调用）
#   bash scripts/e2e-profile.sh --no-model      # 只做 profile 与 dump-config 断言
#   DSH_PROFILE=web bash scripts/e2e-profile.sh
#
# 证据落盘：.runtime/probe/e2e-*.yml / e2e-*.json（真实命令输出）
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$REPO_ROOT/.runtime"
PROBE="$RT/probe"
mkdir -p "$PROBE"

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"

DSH="${DSH_BIN:-$RT/dsh-cli-npm/node_modules/.bin/dsh}"
PROFILE="${DSH_PROFILE:-headless}"
AGENT_TEAM_PROFILE="@deepseek-ai/dsh-experimental-agent-team-profile@0.2.1-rc.3"
NO_MODEL=0
[ "${1:-}" = "--no-model" ] && NO_MODEL=1

pass=0; fail=0
ck(){ if [ "$1" = 1 ]; then echo "  [PASS] $2"; pass=$((pass+1)); else echo "  [FAIL] $2"; fail=$((fail+1)); fi; }

echo ">>> [1/4] 确保 profile 与团队 bundle 已接入"
[ -x "$DSH" ] || { echo "[FAIL] 找不到 dsh: $DSH"; exit 1; }
prof_pkg="$DSH_HOME/profiles/$PROFILE/package.json"
need_agent_team=1; need_bundle=1
if [ -f "$prof_pkg" ]; then
  grep -q "@deepseek-ai/dsh-experimental-agent-team-profile" "$prof_pkg" && need_agent_team=0
  grep -q "@elinpf/dsh-swarm-bundle" "$prof_pkg" && need_bundle=0
fi
[ "$need_agent_team" = 1 ] && "$DSH" plugin --profile "$PROFILE" add "$AGENT_TEAM_PROFILE" >"$PROBE/e2e-plugin-agentteam.log" 2>&1
[ "$need_bundle" = 1 ] && "$DSH" plugin --profile "$PROFILE" add "$REPO_ROOT/packages/bundle" >"$PROBE/e2e-plugin-bundle.log" 2>&1
echo "  agent-team-profile in profile: $([ "$need_agent_team" = 0 ] && echo yes || echo added)"
echo "  @elinpf/dsh-swarm-bundle   in profile: $([ "$need_bundle" = 0 ] && echo yes || echo added)"

echo ">>> [2/4] --dump-config 断言"
DUMP="$PROBE/e2e-dump-config.yml"
"$DSH" --profile "$PROFILE" --dump-config > "$DUMP" 2>"$PROBE/e2e-dump-config.err"
# @elinpf/dsh-swarm-bundle 段落内的 9 行
sec=$(awk '/^# == @elinpf\/dsh-swarm-bundle/{f=1} f&&/^# ==/&&!/@elinpf\/dsh-swarm-bundle/{if(f>1)exit} f{print} f&&/^# == @elinpf\/dsh-swarm-bundle/{f=2}' "$DUMP")
rows=$(printf '%s\n' "$sec" | grep -cE "^- id: (team-core|team-prompt|team-bus|team-review|team-scheduler|team-completion|tool-swarm)$")
ck $([ "$rows" -eq 7 ] && echo 1 || echo 0) "@elinpf/dsh-swarm-bundle 自身插入行数 = $rows (期望 7)"
# 原生团队域由 agent-team-profile 提供（bundle 不再重复插入）：确认它们在 dump 中确实存在
nat=0
grep -qE "^- id: agent-team$" "$DUMP" && nat=$((nat+1))
grep -qE "^- id: tool-agent-team$" "$DUMP" && nat=$((nat+1))
ck $([ "$nat" -eq 2 ] && echo 1 || echo 0) "原生 agent-team / tool-agent-team 行存在（来自 agent-team-profile） = $nat (期望 2)"
# 4 行 legacy disabled
dis=$(grep -cE "^- id: (tool-subagent|tool-subagent-control|tool-subagent-list-agents|tool-subagent-fork)$" "$DUMP")
# 逐个确认 disabled: true 紧随其后
leg=0
for id in tool-subagent tool-subagent-control tool-subagent-list-agents tool-subagent-fork; do
  if grep -A6 "^- id: $id$" "$DUMP" | grep -q "disabled: true"; then leg=$((leg+1)); fi
done
ck $([ "$leg" -eq 4 ] && echo 1 || echo 0) "legacy tool-subagent* 为 disabled 的行数 = $leg (期望 4)"
grep -iE "disabl|incompat|did not activate" "$PROBE/e2e-dump-config.err" | head -5 && \
  ck 0 "dump-config 出现禁用时告警（见上）" || ck 1 "dump-config 无禁用/不兼容告警"

if [ "$NO_MODEL" = 1 ]; then
  echo ">>> [3/4][4/4] 跳过真实模型调用（--no-model）"
  echo; echo "结果：PASS=$pass FAIL=$fail"
  [ "$fail" -eq 0 ] || exit 1; exit 0
fi

echo ">>> [3/4] 真实模型：最小团队交互（spawn + DM + 任务看板）"
run-headless() { bash "$REPO_ROOT/scripts/run-headless.sh" --json "$1"; }
run-headless "Do these in order and report each raw tool result verbatim: 1) spawn_teammate name='alice' description='e2e' prompt='Reply with exactly ACK'; 2) send_message target='alice' message='hello from lead'; 3) team_task_create subject='e2e-task' description='probe'; 4) team_task_list." \
  > "$PROBE/e2e-team-interaction.json" 2>"$PROBE/e2e-team-interaction.err"
tc=$(grep -c '"type":"tool_call"' "$PROBE/e2e-team-interaction.json")
ck $([ "$tc" -ge 4 ] && echo 1 || echo 0) "团队交互工具调用数 = $tc (期望 >=4)"
grep -qE '"tool":"spawn_teammate"' "$PROBE/e2e-team-interaction.json" && ck 1 "spawn_teammate 被调用" || ck 0 "spawn_teammate 未调用"
grep -q 'sent\\":true' "$PROBE/e2e-team-interaction.json" && ck 1 "send_message 返回 sent:true" || ck 0 "send_message 未成功"
grep -q 'task-1' "$PROBE/e2e-team-interaction.json" && ck 1 "team_task_create 返回 task-1" || ck 0 "任务创建失败"

echo ">>> [4/4] 真实模型：interrupt_agent 探针"
run-headless "Do these in order and report each raw tool result verbatim: 1) spawn_teammate name='dave' description='interrupt' prompt='Count from 1 to 300, one number per line, then write DONE.' 2) immediately call interrupt_agent target='dave'. 3) list_agents." \
  > "$PROBE/e2e-interrupt.json" 2>"$PROBE/e2e-interrupt.err"
grep -q 'previousStatus' "$PROBE/e2e-interrupt.json" && grep -q 'running' "$PROBE/e2e-interrupt.json" && ck 1 "interrupt_agent 返回 previousStatus:running" || ck 0 "interrupt_agent 未确认"

echo
echo "结果：PASS=$pass FAIL=$fail"
echo "证据目录：$PROBE"
[ "$fail" -eq 0 ]
