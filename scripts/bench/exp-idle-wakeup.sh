#!/usr/bin/env bash
# =============================================================================
# exp-idle-wakeup.sh — 「空转唤醒」长驻实验一键入口（自动进入隔离环境）
# -----------------------------------------------------------------------------
#   bash scripts/bench/exp-idle-wakeup.sh --self-test
#   bash scripts/bench/exp-idle-wakeup.sh --arm both --members alice,bob,carol \
#        --token-cap 500000 --timeout-ms 600000 --out .runtime/bench/exp-idle-wakeup
#
# 真实模型模式复用 scripts/run-headless.sh（llm-pi-ai overlay），逐条流式施加
# token/轮次门禁（默认 cap=500000/arm，硬顶 5,000,000 不可上调）；密钥仅经环境变量注入，
# 不打印、不落盘。
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"

exec node "$REPO_ROOT/scripts/bench/exp-idle-wakeup.mjs" "$@"
