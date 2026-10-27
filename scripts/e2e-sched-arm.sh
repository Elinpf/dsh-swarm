#!/usr/bin/env bash
# =============================================================================
# e2e-sched-arm.sh — 真实 profile 下 scheduler **自装配 arming** 的断言（P38b）
# -----------------------------------------------------------------------------
# 断言：headless profile 下，建一条 ready 任务后**限时内**任务从 pending → in_progress
#       （scheduled 派发；证明 teamScheduler 被 arm 并真在扫描）。
#
# 「先红后绿」：`--auto-arm false` 复现修复前「无人 arm」→ 任务保持 pending（红）；
#              默认 `--auto-arm true`（自装配）→ 任务被派发（绿）。
#
# 与 scripts/bench/exp-sched.sh 的关系：同法起 profile（模型 overlay + scheduler overlay），
# 但本脚本**不改 bench**、且聚焦单一断言 + 先红后绿开关。
#
# 用法：
#   bash scripts/e2e-sched-arm.sh --auto-arm true  --expect in_progress
#   bash scripts/e2e-sched-arm.sh --auto-arm false --expect pending
# 无模型端点/密钥时：SKIP（退出码 0，打印原因）。
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$REPO_ROOT/.runtime"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"

DSH="${DSH_BIN:-$RT/dsh-cli-npm/node_modules/.bin/dsh}"
PROFILE="${DSH_PROFILE:-headless}"
CFG="${DSH_SWARM_CONFIG:-/root/.jiuwenswarm/config/config.yaml}"
AUTO_ARM=true
EXPECT=in_progress
OUT="${RT}/probe/sched-arm"

while [ $# -gt 0 ]; do
  case "$1" in
    --auto-arm) AUTO_ARM="$2"; shift 2;;
    --expect) EXPECT="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    *) echo "[FAIL] 未知参数 $1" >&2; exit 2;;
  esac
done
mkdir -p "$OUT"

if [ ! -x "$DSH" ]; then
  echo "[SKIP] 找不到 dsh CLI：$DSH"
  exit 0
fi

# ── 解析模型端点/密钥（不打印）────────────────────────────────────────────────
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
if [ -z "$BASEURL" ] || [ -z "$KEY" ]; then
  echo "[SKIP] 无模型端点/密钥（DSH_MODEL_BASEURL/KEY 或 $CFG）→ 无法跑真实 profile 断言"
  exit 0
fi

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

SCHED_OVERLAY="$OUT/sched-overlay.yml"
cat > "$SCHED_OVERLAY" <<YAML
- id: team-scheduler
  config:
    mode: scheduled
    pollMs: 1000
    autoArm: ${AUTO_ARM}
    staleClaimIdleMs: 600000
    staleEscalateStreak: 3
    busyTaskStatuses:
      - pending
      - in_progress
YAML

PROMPT="You are the team lead. Execute IN ORDER, one tool call at a time, reporting each raw result verbatim.
1) spawn_teammate name='alice' description='idle' prompt='Reply with exactly A, then stop.'
2) team_task_create subject='arm-job' description='x'.
3) Keep resident: call wait_agent timeout_ms=10000 at least 3 times.
4) team_task_list.
5) Reply exactly DONE."

echo "[info] autoArm=$AUTO_ARM expect=$EXPECT out=$OUT"
export DSH_DEMO_KEY="$KEY"
DUMP="$OUT/run.jsonl"
"$DSH" --profile "$PROFILE" --patch "$MODEL_OVERLAY" --patch "$SCHED_OVERLAY" headless --json "$PROMPT" \
  >"$DUMP" 2>"$OUT/run.err" || true

# ── 断言：arm-job 的最终状态 ──────────────────────────────────────────────────
STATUS="$(python3 - "$DUMP" <<'PY'
import sys, json
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
status = None

def walk(o):
    global status
    if isinstance(o, dict):
        if o.get("subject") == "arm-job" and "status" in o:
            status = o.get("status")
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)

for line in text.splitlines():
    s = line.strip()
    if not s.startswith("{"):
        continue
    try:
        obj = json.loads(s)
    except Exception:
        continue
    walk(obj)
    if obj.get("type") == "tool_result" and isinstance(obj.get("result"), str):
        try:
            walk(json.loads(obj["result"]))
        except Exception:
            pass
print(status or "unknown")
PY
)"

echo "[info] arm-job 最终状态 = $STATUS (期望 $EXPECT)"
if [ "$STATUS" = "$EXPECT" ]; then
  echo "[PASS] scheduler arming：状态符合期望（autoArm=$AUTO_ARM）"
  exit 0
else
  echo "[FAIL] scheduler arming：状态 $STATUS != 期望 $EXPECT"
  exit 1
fi
