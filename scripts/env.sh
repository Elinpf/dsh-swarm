#!/usr/bin/env bash
# DSH 隔离开发环境 —— 环境变量激活脚本（可 source）
# 用法：  source scripts/env.sh
#
# 设计原则（配合任务 P1-env-setup 的硬隔离要求）：
#   1. 绝不改动系统 node / 全局 npm / pnpm / /root/.dsh / 既有 DSH checkout
#   2. 所有运行时、缓存、配置、HOME 全部落在本项目 .runtime/ 下
#   3. 所有网络请求绕过本机本地代理（该代理对大体积 HTTPS body 会 SSL_ERROR_SYSCALL）
#
# 注意：脚本内所有路径都基于本文件自身位置推导，可在任意目录 source。

# 解析本脚本所在仓库根目录（scripts/ 的上一级）
_env_sh_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export DSH_SWARM_ROOT="$(cd "$_env_sh_dir/.." && pwd)"
unset _env_sh_dir

export DSH_RUNTIME="$DSH_SWARM_ROOT/.runtime"
export DSH_NODE_VERSION="v22.23.4"
export DSH_NODE="$DSH_RUNTIME/node-${DSH_NODE_VERSION}-linux-x64"
export DSH_SRC="$DSH_RUNTIME/deepseek-harness"

# ---- PATH：隔离 node / 隔离 pnpm shim 优先 ----
export PATH="$DSH_SWARM_ROOT/.runtime/bin:$DSH_NODE/bin:$PATH"

# ---- 隔离 HOME / XDG ----
export HOME="$DSH_RUNTIME/home"
export XDG_CACHE_HOME="$DSH_RUNTIME/xdg-cache"
export XDG_CONFIG_HOME="$DSH_RUNTIME/xdg-config"
export XDG_DATA_HOME="$DSH_RUNTIME/xdg-data"
export XDG_STATE_HOME="$DSH_RUNTIME/xdg-state"

# ---- DSH 自身数据目录（与 /root/.dsh 零交叠）----
export DSH_HOME="$DSH_RUNTIME/dsh-home"

# ---- Node 包管理器隔离 ----
export COREPACK_HOME="$DSH_RUNTIME/corepack-home"
export NPM_CONFIG_CACHE="$DSH_RUNTIME/npm-cache"
export PNPM_HOME="$DSH_RUNTIME/pnpm-home"
export PNPM_STORE_DIR="$DSH_RUNTIME/pnpm-store"
export npm_config_store_dir="$PNPM_STORE_DIR"
export npm_config_cache="$NPM_CONFIG_CACHE"

# ---- 网络：绕过失效代理，直连（npm 直连很快；代理对 >~64KB 的 HTTPS body 会失败）----
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY 2>/dev/null || true
export no_proxy="*"
export NO_PROXY="*"
export npm_config_proxy=""
export npm_config_https_proxy=""
unset npm_config_http_proxy 2>/dev/null || true

# ---- 注册表（直连 npmjs 速度快；如需国内加速可切 npmmirror）----
export npm_config_registry="${DSH_REGISTRY:-https://registry.npmjs.org/}"

# ---- 让 pnpm/corepack 静默一些非致命告警 ----
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
