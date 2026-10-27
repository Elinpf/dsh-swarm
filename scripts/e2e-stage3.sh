#!/usr/bin/env bash
# =============================================================================
# e2e-stage3.sh — 阶段 3（跨进程 + 人类席位）可重跑验证的一键入口（隔离环境）
# -----------------------------------------------------------------------------
# 依次执行：
#   1) 真实 profile 回归（离线）：scripts/e2e-profile.sh --no-model
#      —— 断言 14 行插件（含阶段3 transport/distributed/human）+ 无告警 + 原生接通；
#   2) 跨**真实 OS 进程**的 team-transport 验证：scripts/team-transport-xproc.mjs
#      —— V1 丢 ack→真杀进程→重连重放；V2 重复→恰好一次；V4 sinceSeq 增量补齐；有界队列；
#   3) team-distributed 崩溃恢复（真实进程重启 + journal 落盘）：scripts/team-distributed-journal-xproc.mjs
#   4) 人类席位验证：scripts/team-human-xproc.mjs
#      —— HITT 路由 + 阻塞询问（真实子进程输入）→ 继续 + 离线保留→补投。
#
# 证据落盘：.runtime/probe/e2e-*.yml|json（profile）、stdout（本脚本）。
# 用法：bash scripts/e2e-stage3.sh
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"
NODE="$DSH_NODE/bin/node"

pass=0; fail=0
run(){ # run <名称> <命令...>
  echo; echo "##### $1 #####"
  if "${@:2}"; then echo "[OK] $1"; pass=$((pass+1)); else echo "[FAIL] $1"; fail=$((fail+1)); fi
}

run "1/4 profile 回归 (--no-model)" bash "$REPO_ROOT/scripts/e2e-profile.sh" --no-model
run "2/4 跨进程 transport (真实子进程)" "$NODE" "$REPO_ROOT/scripts/team-transport-xproc.mjs"
run "3/4 distributed 崩溃恢复 (真实进程重启+journal)" "$NODE" "$REPO_ROOT/scripts/team-distributed-journal-xproc.mjs"
run "4/4 人类席位 (真实输入进程)" "$NODE" "$REPO_ROOT/scripts/team-human-xproc.mjs"

echo; echo "===== e2e-stage3 结果：PASS=$pass FAIL=$fail ====="
[ "$fail" -eq 0 ]
