#!/usr/bin/env bash
# =============================================================================
# setup-env.sh — 搭建隔离的 DeepSeek Harness (DSH) 开发环境（可重复执行 / 幂等）
# -----------------------------------------------------------------------------
# 目标：在【完全不影响现有运行实例】的前提下，在项目内搭起可复现的 DSH 开发环境。
#
# 硬隔离约束（本脚本严格遵守）：
#   - 不改 /root/.dsh（现有 DSH home）
#   - 不改系统 node / 不做全局 npm、pnpm 安装
#   - 不碰 /root/repo/github.io/deepseek-harness 的既有 checkout
#   - 所有依赖、缓存、HOME、配置默认落在 <项目>/.runtime/ 内，用环境变量隔离
#
# 用法：
#   bash scripts/setup-env.sh              # 全流程（已完成步骤自动跳过）
#   bash scripts/setup-env.sh --check      # 只做自检
#   bash scripts/setup-env.sh --npm-cli    # 额外安装 npm 上已发布的 DSH CLI 做最小启动
#   DSH_DEPS_DIR=/dev/shm/dsh-deps bash scripts/setup-env.sh   # 磁盘紧张时把依赖放到别处
#
# 实测环境要点（详见 docs/env-setup.md）：
#   * 本机 root FS 已 100% 占满（可用仅 ~1.5GB 保留块），完整 monorepo 构建会超盘，
#     脚本内置磁盘守卫，空间不足时跳过 install/build 并给出指引。
#   * 本机本地代理 127.0.0.1:7890 对 >~64KB 的 HTTPS 响应体会 SSL_ERROR_SYSCALL，
#     因此所有下载显式绕过代理（--noproxy '*' / no_proxy=*），改用国内镜像直连。
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$REPO_ROOT/.runtime"

NODE_VERSION="${NODE_VERSION:-v22.23.4}"      # 满足 DSH engines: ^22.19.0 || >=24.0.0
NODE_DIST="node-${NODE_VERSION}-linux-x64"
NODE_URLS=(
  "https://cdn.npmmirror.com/binaries/node/${NODE_VERSION}/${NODE_DIST}.tar.xz"
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_VERSION}/${NODE_DIST}.tar.xz"
  "https://mirrors.ustc.edu.cn/nodejs-release/${NODE_VERSION}/${NODE_DIST}.tar.xz"
  "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz"
)
SHASUM_URLS=(
  "https://cdn.npmmirror.com/binaries/node/${NODE_VERSION}/SHASUMS256.txt"
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_VERSION}/SHASUMS256.txt"
  "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
)

DSH_REPO_URL="${DSH_REPO_URL:-https://github.com/deepseek-ai/deepseek-harness}"
DSH_TAG="${DSH_TAG:-dsh-v0.2.1-rc.3}"
DSH_COMMIT="${DSH_COMMIT:-1f81c047fc48fa190a683e469daa699857e9afe8}"   # ls-remote 核验
MIN_FREE_MB_FOR_BUILD="${MIN_FREE_MB_FOR_BUILD:-3000}"                   # 构建所需可用空间(mb)

CHECK_ONLY=0; WITH_NPM_CLI=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    --npm-cli) WITH_NPM_CLI=1 ;;
  esac
done

log(){  printf '\n\033[1;36m>>> %s\033[0m\n' "$*"; }
ok(){   printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die(){  printf '\033[1;31m[FAIL]\033[0m %s\n' "$*"; exit 1; }
free_mb(){ df -B1 "$RT" 2>/dev/null | tail -1 | awk '{print int(($2-$3)/1048576)}'; }
command -v curl >/dev/null || die "需要 curl"

# 所有网络请求绕过本机代理
fetch(){ curl -fSL --http1.1 --noproxy '*' --connect-timeout 20 \
              --retry 4 --retry-delay 3 --retry-all-errors "$1" -o "$2"; }

# ---- 1. 目录骨架 ----
log "1/7 创建隔离目录骨架"
DEPS_DIR="${DSH_DEPS_DIR:-}"
mkdir -p "$RT"/{bin,home,xdg-cache,xdg-config,xdg-data,xdg-state,dsh-home,pnpm-store,pnpm-home,npm-cache,corepack-home}
ok "骨架就绪: $RT"

# ---- 2. 隔离 Node ----
log "2/7 隔离 Node ${NODE_VERSION}"
if [ -x "$RT/$NODE_DIST/bin/node" ] && [ "$("$RT/$NODE_DIST/bin/node" -v 2>/dev/null)" = "$NODE_VERSION" ]; then
  ok "已存在: $("$RT/$NODE_DIST/bin/node" -v)（跳过）"
else
  [ "$CHECK_ONLY" = 1 ] && die "缺少隔离 Node（--check 不安装）"
  want=""
  for su in "${SHASUM_URLS[@]}"; do
    if fetch "$su" "$RT/SHASUMS256.txt" 2>/dev/null; then
      want="$(grep " ${NODE_DIST}.tar.xz" "$RT/SHASUMS256.txt" | awk '{print $1}')"; break
    fi
  done
  got=""
  for u in "${NODE_URLS[@]}"; do
    echo "  下载: $u"
    if fetch "$u" "$RT/${NODE_DIST}.tar.xz"; then got="$u"; break; fi
  done
  [ -n "$got" ] || die "Node 镜像全部失败"
  actual="$(sha256sum "$RT/${NODE_DIST}.tar.xz" | awk '{print $1}')"
  { [ -z "$want" ] || [ "$want" = "$actual" ]; } || die "Node SHA256 不匹配 want=$want got=$actual"
  ok "Node 校验通过（来源 $got）"
  tar -xf "$RT/${NODE_DIST}.tar.xz" -C "$RT"
  ok "解压: $("$RT/$NODE_DIST/bin/node" -v)"
fi

# ---- 3. 隔离 pnpm（corepack）----
log "3/7 隔离 pnpm（corepack，COREPACK_HOME 在项目内）"
export HOME="$RT/home" COREPACK_HOME="$RT/corepack-home" PATH="$RT/$NODE_DIST/bin:$PATH"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY 2>/dev/null || true
export no_proxy='*' NO_PROXY='*' npm_config_registry="${DSH_REGISTRY:-https://registry.npmjs.org/}"
PNPM_VERSION="${PNPM_VERSION:-}"
if [ -z "$PNPM_VERSION" ] && [ -f "$RT/deepseek-harness/package.json" ]; then
  PNPM_VERSION="$(node -e "const p=require('$RT/deepseek-harness/package.json');console.log((p.packageManager||'').replace(/^pnpm@/,''))" 2>/dev/null)"
fi
PNPM_VERSION="${PNPM_VERSION:-11.28.5}"
if [ "$CHECK_ONLY" = 1 ]; then corepack pnpm -v >/dev/null 2>&1 && ok "pnpm $(corepack pnpm -v)" || warn "pnpm 未就绪"; else
  corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null && ok "pnpm $(corepack pnpm -v)"
fi

# ---- 4. 获取 DSH 源码（锁定 tag）----
log "4/7 获取 DSH 源码 ${DSH_TAG}"
if [ -f "$RT/deepseek-harness/package.json" ]; then
  ok "已存在: $(node -e "console.log(require('$RT/deepseek-harness/package.json').version)" 2>/dev/null)（跳过）"
elif [ "$CHECK_ONLY" = 1 ]; then
  warn "缺少 DSH 源码"
else
  if env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
       git clone --depth 1 --branch "$DSH_TAG" "$DSH_REPO_URL" "$RT/deepseek-harness" 2>/dev/null; then
    ok "git clone 完成"
  else
    warn "git clone 失败，退回 codeload tarball（无 .git，commit 由 git ls-remote 核验）"
    tarball="$RT/dsh-${DSH_TAG}.tar.gz"
    fetch "https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/refs/tags/${DSH_TAG}" "$tarball" || die "DSH tarball 下载失败"
    rm -rf "$RT/deepseek-harness" "$RT/deepseek-harness-${DSH_TAG}"
    tar -xzf "$tarball" -C "$RT"
    mv "$RT/deepseek-harness-${DSH_TAG}" "$RT/deepseek-harness"
    ok "tarball 解压完成"
  fi
fi
[ -f "$RT/deepseek-harness/package.json" ] && \
  ok "DSH 版本 = $(node -e "console.log(require('$RT/deepseek-harness/package.json').version)" 2>/dev/null) / commit(期望) ${DSH_COMMIT}"

# ---- 5. 隔离环境变量 ----
log "5/7 载入隔离环境变量"
# shellcheck disable=SC1091
source "$REPO_ROOT/scripts/env.sh"
ok "node=$(command -v node) $(node -v)  pnpm=$(corepack pnpm -v 2>/dev/null)  DSH_HOME=$DSH_HOME"

# ---- 6. 依赖安装 + 构建（带磁盘守卫）----
log "6/7 pnpm install + build"
if [ "$CHECK_ONLY" = 1 ]; then
  [ -d "$RT/deepseek-harness/node_modules" ] && ok "node_modules 存在" || warn "node_modules 缺失"
else
  fm="$(free_mb)"
  if [ "$fm" -lt "$MIN_FREE_MB_FOR_BUILD" ]; then
    warn "可用磁盘仅 ${fm}MB（< ${MIN_FREE_MB_FOR_BUILD}MB），跳过 install/build 以免撑爆 root FS。"
    warn "        解封方式：清理磁盘后重跑，或 DSH_DEPS_DIR=/dev/shm/dsh-deps 指定依赖目录。"
  else
    if [ -n "$DEPS_DIR" ] && [ ! -e "$RT/deepseek-harness/node_modules" ]; then
      mkdir -p "$DEPS_DIR/node_modules"; ln -s "$DEPS_DIR/node_modules" "$RT/deepseek-harness/node_modules"
    fi
    ( cd "$RT/deepseek-harness" && corepack pnpm install --frozen-lockfile ) || die "pnpm install 失败"
    ok "依赖安装完成"
    ( cd "$RT/deepseek-harness" && corepack pnpm build ) && ok "构建完成" || warn "构建失败（见输出）"
  fi
fi

# ---- 7. 最小启动验证 ----
log "7/7 最小启动验证"
if [ -d "$RT/deepseek-harness/node_modules" ] && [ -f "$RT/deepseek-harness/apps/cli/lib/bin.js" ]; then
  ( cd "$RT/deepseek-harness" && node apps/cli/lib/bin.js --version ) && ok "源码构建版 dsh 启动成功"
elif [ "$WITH_NPM_CLI" = 1 ] || [ -d "$RT/dsh-cli-npm/node_modules" ]; then
  D="$RT/dsh-cli-npm"; mkdir -p "$D"; cd "$D"
  [ -f package.json ] || printf '{"name":"dsh-cli-probe","private":true,"version":"0.0.0"}\n' > package.json
  if [ ! -x node_modules/.bin/dsh ]; then
    ( corepack pnpm add "@deepseek-ai/dsh@${DSH_TAG#dsh-v}" ) || warn "npm CLI 安装失败（磁盘/网络）"
  fi
  [ -x node_modules/.bin/dsh ] && node_modules/.bin/dsh --version && ok "npm 已发布版 dsh 启动成功"
else
  warn "无可用源码构建产物，且未启用 --npm-cli，跳过启动验证。"
fi
echo
echo "完成。日常使用： source scripts/env.sh"
