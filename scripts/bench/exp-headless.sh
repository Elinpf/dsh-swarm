#!/usr/bin/env bash
# =============================================================================
# exp-headless.sh — 通用「真实 headless profile + 配置 overlay + 自定义提示词」跑手
# -----------------------------------------------------------------------------
# 用于 #6 计划闸/评审闸象限：可开/关 team-core.planGate、tool-swarm.enableReview。
# 自带两个 --patch（模型 overlay + 协作配置 overlay）。密钥仅经环境变量注入，不打印。
#
# 用法：
#   bash scripts/bench/exp-headless.sh --plan-gate on|off --enable-review on|off \
#        --prompt-file <path> --out <dir>
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RT="$REPO_ROOT/.runtime"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"

DSH="${DSH_BIN:-$RT/dsh-cli-npm/node_modules/.bin/dsh}"
PROFILE="${DSH_PROFILE:-headless}"
CFG="${DSH_SWARM_CONFIG:-/root/.jiuwenswarm/config/config.yaml}"

PLAN_GATE=off; ENABLE_REVIEW=off; PROMPT_FILE=""; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan-gate) PLAN_GATE="$2"; shift 2;;
    --enable-review) ENABLE_REVIEW="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    *) echo "[FAIL] 未知参数 $1" >&2; exit 2;;
  esac
done
[ -n "$OUT" ] && [ -n "$PROMPT_FILE" ] || { echo "[FAIL] 需要 --out 与 --prompt-file" >&2; exit 2; }
mkdir -p "$OUT"
[ -x "$DSH" ] || { echo "[FAIL] 找不到 dsh" >&2; exit 1; }

# 模型端点/密钥（同 run-headless.sh；不打印）
BASEURL="${DSH_MODEL_BASEURL:-}"; KEY="${DSH_MODEL_KEY:-${DSH_DEMO_KEY:-}}"; MODEL="${DSH_MODEL_ID:-DeepSeek-Flash}"
if { [ -z "$BASEURL" ] || [ -z "$KEY" ]; } && [ -f "$CFG" ]; then
  eval "$(python3 - "$CFG" <<'PY'
import sys, re
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r"models:\s*\n\s*defaults:\s*\n(?P<body>(?:.*\n)*?)  video:", text)
body = m.group("body") if m else text
b = re.search(r"api_base:\s*(\S+)", body); k = re.search(r"api_key:\s*(\S+)", body); n = re.search(r"model_name:\s*(\S+)", body)
def sh(v): return v.replace("'", "'\\''") if v else ""
print(f"__BU='{sh(b.group(1)) if b else ''}'"); print(f"__KY='{sh(k.group(1)) if k else ''}'"); print(f"__MD='{sh(n.group(1)) if n else ''}'")
PY
)" 2>/dev/null || true
  [ -z "$BASEURL" ] && BASEURL="$__BU"; [ -z "$KEY" ] && KEY="$__KY"
  [ -n "$__MD" ] && [ -z "${DSH_MODEL_ID:-}" ] && MODEL="$__MD"
fi
[ -n "$BASEURL" ] && [ -n "$KEY" ] || { echo "[FAIL] 未能解析模型端点/密钥" >&2; exit 1; }

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

CFG_OVERLAY="$OUT/cfg-overlay.yml"
{
  echo "- id: team-core"
  echo "  config:"
  echo "    backend: auto"
  echo "    maxMembers: 8"
  echo "    maxTasks: 256"
  echo "    maxMessageBytes: 65536"
  echo "    planGate: $([ "$PLAN_GATE" = on ] && echo true || echo false)"
  echo "- id: tool-swarm"
  echo "  config:"
  echo "    enableBroadcast: true"
  echo "    enableReview: $([ "$ENABLE_REVIEW" = on ] && echo true || echo false)"
} > "$CFG_OVERLAY"

echo "[info] planGate=$PLAN_GATE enableReview=$ENABLE_REVIEW out=$OUT"
export DSH_DEMO_KEY="$KEY"
"$DSH" --profile "$PROFILE" --patch "$MODEL_OVERLAY" --patch "$CFG_OVERLAY" headless --json "$(cat "$PROMPT_FILE")" \
  > "$OUT/raw.jsonl" 2>"$OUT/stderr.log"
echo "[info] exit=$? out=$OUT/raw.jsonl"
