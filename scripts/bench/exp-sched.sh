#!/usr/bin/env bash
# =============================================================================
# exp-sched.sh — #5 scheduler 三臂（real profile）：scheduled / autonomous / off
# -----------------------------------------------------------------------------
# 目的：在**真实 headless profile** 下，配置 team-scheduler 的 mode，观察
#       「ready 任务 × 空闲成员」是否被**自动派发**（任务 pending → in_progress）。
#
# 与 run-headless.sh 的关系：本脚本自带**两个 --patch**（模型 overlay + scheduler overlay），
# 而 run-headless.sh 只挂一个，故独立实现（不改 run-headless.sh）。
#
# 用法：
#   bash scripts/bench/exp-sched.sh --mode scheduled  --out .runtime/bench/p33-sched/scheduled
#   bash scripts/bench/exp-sched.sh --mode autonomous --out .../autonomous
#   bash scripts/bench/exp-sched.sh --mode off        --out .../off
#
# 说明：--mode off 用 overlay 把 team-scheduler 禁用（disabled: true）。
# 密钥仅经环境变量注入，不打印、不落盘。
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RT="$REPO_ROOT/.runtime"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"

DSH="${DSH_BIN:-$RT/dsh-cli-npm/node_modules/.bin/dsh}"
PROFILE="${DSH_PROFILE:-headless}"
CFG="${DSH_SWARM_CONFIG:-/root/.jiuwenswarm/config/config.yaml}"

MODE=scheduled
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    *) echo "[FAIL] 未知参数 $1" >&2; exit 2;;
  esac
done
[ -n "$OUT" ] || { echo "[FAIL] 需要 --out" >&2; exit 2; }
mkdir -p "$OUT"

[ -x "$DSH" ] || { echo "[FAIL] 找不到 dsh：$DSH" >&2; exit 1; }

# ── 解析模型端点/密钥（同 run-headless.sh；不打印）────────────────────────────
BASEURL="${DSH_MODEL_BASEURL:-}"
KEY="${DSH_MODEL_KEY:-${DSH_DEMO_KEY:-}}"
MODEL="${DSH_MODEL_ID:-DeepSeek-Flash}"
if { [ -z "$BASEURL" ] || [ -z "$KEY" ]; } && [ -f "$CFG" ]; then
  eval "$(python3 - "$CFG" <<'PY'
import sys, re
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r"models:\s*\n\s*defaults:\s*\n(?P<body>(?:.*\n)*?)  video:", text)
body = m.group("body") if m else text
b = re.search(r"api_base:\s*(\S+)", body); k = re.search(r"api_key:\s*(\S+)", body); n = re.search(r"model_name:\s*(\S+)", body)
def sh(v): return v.replace("'", "'\\''") if v else ""
print(f"__BU='{sh(b.group(1)) if b else ''}'")
print(f"__KY='{sh(k.group(1)) if k else ''}'")
print(f"__MD='{sh(n.group(1)) if n else ''}'")
PY
)" 2>/dev/null || true
  [ -z "$BASEURL" ] && BASEURL="$__BU"; [ -z "$KEY" ] && KEY="$__KY"
  [ -n "$__MD" ] && [ -z "${DSH_MODEL_ID:-}" ] && MODEL="$__MD"
fi
[ -n "$BASEURL" ] && [ -n "$KEY" ] || { echo "[FAIL] 未能解析模型端点/密钥" >&2; exit 1; }

# ── overlay 1：模型路由（llm-pi-ai + openai-completions）──────────────────────
MODEL_OVERLAY="$OUT/model-overlay.yml"
cat > "$MODEL_OVERLAY" <<YAML
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      dshdemo:
        apiKeyEnv: DSH_DEMO_KEY
        api: openai-completions
        baseURL: ${BASEURL}
        models:
          - id: ${MODEL}
            contextWindow: 1048576
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: dshdemo
    model: ${MODEL}
YAML

# ── overlay 2：scheduler 配置（mode / 禁用）──────────────────────────────────
SCHED_OVERLAY="$OUT/sched-overlay.yml"
if [ "$MODE" = "off" ]; then
  cat > "$SCHED_OVERLAY" <<'YAML'
- id: team-scheduler
  disabled: true
YAML
else
  cat > "$SCHED_OVERLAY" <<YAML
- id: team-scheduler
  config:
    mode: ${MODE}
    pollMs: 3000
    staleClaimIdleMs: 600000
    staleEscalateStreak: 3
    busyTaskStatuses:
      - pending
      - in_progress
YAML
fi

# ── 提示词：spawn 2 空闲成员 + 建 2 个 ready 任务 → 长驻等待 → 列任务 ───────────
PROMPT="You are the team lead. Execute these steps IN ORDER, one tool call at a time, reporting each raw tool result verbatim.
1) spawn_teammate name='alice' description='idle-a' prompt='Reply with exactly A, then stop. Do nothing else.'
2) spawn_teammate name='bob' description='idle-b' prompt='Reply with exactly B, then stop. Do nothing else.'
3) team_task_create subject='job-1' description='x'.
4) team_task_create subject='job-2' description='y'.
5) Then keep the run resident: call wait_agent timeout_ms=10000 at least 3 times (keep calling while timedOut=false).
6) team_task_list.
7) Reply exactly DONE."

echo "[info] mode=$MODE out=$OUT"
export DSH_DEMO_KEY="$KEY"
"$DSH" --profile "$PROFILE" --patch "$MODEL_OVERLAY" --patch "$SCHED_OVERLAY" headless --json "$PROMPT" \
  > "$OUT/raw.jsonl" 2>"$OUT/stderr.log"
echo "[info] exit=$? raw=$OUT/raw.jsonl"
