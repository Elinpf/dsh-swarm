#!/usr/bin/env bash
# =============================================================================
# run-headless.sh — 一键在【隔离环境】里跑 dsh headless，并自动挂上"真实模型"overlay
# -----------------------------------------------------------------------------
# 为什么需要它：DSH 内置的 dsh-llm-deepseek 对本环境 OpenAI 兼容端点返回 401；
# 实测必须用 llm-pi-ai 手写一条 openai-completions 路由（overlay）才能驱动真实模型。
# 本脚本把这条路固化下来：自动从本机既有配置里解析 baseURL/apiKey（**不打印 key**），
# 生成 overlay，再驱动 dsh。
#
# 用法：
#   bash scripts/run-headless.sh "Reply with exactly: PONG"
#   bash scripts/run-headless.sh --json "..."           # 透传给 dsh headless 的参数
#   DSH_PROFILE=web bash scripts/run-headless.sh ...    # 换 profile
#   DSH_MODEL_BASEURL=... DSH_MODEL_KEY=... bash ...     # 显式指定端点/密钥（优先）
#
# 凭据来源优先级：环境变量 DSH_MODEL_KEY/DSH_DEMO_KEY → 本机
#   /root/.jiuwenswarm/config/config.yaml 的 models.defaults[is_default=true]
# 仅注入隔离进程环境，不落盘、不打印。
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$REPO_ROOT/.runtime"

# 1) 进入隔离环境（bash）
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"

DSH="${DSH_BIN:-$RT/dsh-cli-npm/node_modules/.bin/dsh}"
PROFILE="${DSH_PROFILE:-headless}"
CFG="${DSH_SWARM_CONFIG:-/root/.jiuwenswarm/config/config.yaml}"
OVERLAY="$RT/model-overlay.yml"

[ -x "$DSH" ] || { echo "[FAIL] 找不到 dsh：$DSH（先跑 scripts/setup-env.sh --npm-cli）" >&2; exit 1; }

# 2) 解析模型端点与密钥（不打印）
BASEURL="${DSH_MODEL_BASEURL:-}"
KEY="${DSH_MODEL_KEY:-${DSH_DEMO_KEY:-}}"
MODEL="${DSH_MODEL_ID:-DeepSeek-Flash}"
if { [ -z "$BASEURL" ] || [ -z "$KEY" ]; } && [ -f "$CFG" ]; then
  eval "$(python3 - "$CFG" <<'PY'
import sys, re
path = sys.argv[1]
text = open(path, encoding="utf-8", errors="replace").read()
# 取 models.defaults 下第一条 is_default: true 的 model_client_config
m = re.search(r"models:\s*\n\s*defaults:\s*\n(?P<body>(?:.*\n)*?)  video:", text)
body = m.group("body") if m else text
# 找第一个 api_base/api_key/model_name 组合
b = re.search(r"api_base:\s*(\S+)", body)
k = re.search(r"api_key:\s*(\S+)", body)
n = re.search(r"model_name:\s*(\S+)", body)
def sh(v): return v.replace("'", "'\\''") if v else ""
print(f"__BU='{sh(b.group(1)) if b else ''}'")
print(f"__KY='{sh(k.group(1)) if k else ''}'")
print(f"__MD='{sh(n.group(1)) if n else ''}'")
PY
)" 2>/dev/null || true
  [ -z "$BASEURL" ] && BASEURL="$__BU"
  [ -z "$KEY" ] && KEY="$__KY"
  [ -n "$__MD" ] && [ -z "${DSH_MODEL_ID:-}" ] && MODEL="$__MD"
fi
[ -n "$BASEURL" ] && [ -n "$KEY" ] || { echo "[FAIL] 未能解析模型 baseURL/apiKey（可显式设置 DSH_MODEL_BASEURL / DSH_MODEL_KEY）" >&2; exit 1; }

# 3) 生成 overlay（llm-pi-ai + openai-completions）
cat > "$OVERLAY" <<YAML
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
echo "[info] overlay -> $OVERLAY (provider=dshdemo, model=$MODEL, baseURL=$BASEURL)"

# 4) 驱动 dsh（密钥仅经环境变量注入，不出现在命令行/日志）
export DSH_DEMO_KEY="$KEY"
exec "$DSH" --profile "$PROFILE" --patch "$OVERLAY" "$@"
