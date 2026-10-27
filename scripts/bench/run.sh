#!/usr/bin/env bash
# =============================================================================
# run.sh — 基准 harness 一键入口（自动进入隔离环境，不碰 /root/.dsh）
# -----------------------------------------------------------------------------
# 用法：
#   bash scripts/bench/run.sh --no-model --scenario S1,S2,S3 --repeat 3
#   bash scripts/bench/run.sh --scenario S1 --token-cap 20000     # 真实模型（默认上限 5M）
#   bash scripts/bench/run.sh --list
#
# 真实模型模式复用已跑通的 scripts/run-headless.sh（llm-pi-ai overlay），
# 并对累计 token / LLM 轮次施加门禁：超限立即中止子进程并报告实际消耗。
# 密码/token 仅经环境变量注入，不打印、不落盘。
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 进入隔离环境（bash）：隔离 node / HOME / DSH_HOME / 无代理直连
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"

exec node "$REPO_ROOT/scripts/bench/bench-run.mjs" "$@"
