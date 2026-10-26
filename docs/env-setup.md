# DSH 隔离开发环境搭建记录（env-setup）

> 任务：P1-env-setup ｜ 负责人：dsh-env-engineer ｜ 执行时间：2026-10-26
> 目标：在**完全不影响现有运行实例**的前提下，搭起一套可复现、可验证的 DeepSeek Harness（DSH）开发环境。
> 配套脚本：`scripts/setup-env.sh`（幂等）、`scripts/env.sh`（环境变量激活）

---

## 0. 结论速览

| 项目 | 结果 |
|---|---|
| 隔离 Node | ✅ `v22.23.4`（官方 tar.xz 本地解压，SHA256 校验通过） |
| 隔离 pnpm | ✅ `11.28.5`（corepack 安装，`COREPACK_HOME` 在项目内） |
| DSH 源码 | ✅ 已获取并锁定 `tag=dsh-v0.2.1-rc.3`（版本 `0.2.1-rc.3`，commit `1f81c047`） |
| 隔离 DSH_HOME | ✅ `项目/.runtime/dsh-home`，与 `/root/.dsh` 零交叠 |
| 最小启动 | ✅ **实跑通**：`dsh --version` → `0.2.1-rc.3`；`--help`、`--profile web --dump-config` 均正常 |
| 源码 install+build | ⚠️ **被磁盘阻塞**（root FS 已 100% 占满，详见 §7），已实测记录卡点与备选方案 |
| 隔离性证据 | ✅ 全过程 `/root/.dsh` 时间戳零变化；`/root/repo/.../deepseek-harness` HEAD 未动 |
| 推送凭证 | ✅ 已验证可用（`git push --dry-run` 通过，未落任何 ref） |

---

## 1. 隔离方案设计

### 1.1 目录布局（全部在项目内）

```
<项目根> = /root/.jiuwenswarm/agent/workspace/work/jiuwen/dsh-swarm
├── scripts/
│   ├── setup-env.sh          # 幂等搭建脚本
│   └── env.sh                # source 本文件即进入隔离环境
├── docs/
│   └── env-setup.md          # 本文档
└── .runtime/                 # 所有运行时/依赖/缓存/HOME（唯一落点）
    ├── node-v22.23.4-linux-x64/   # 隔离 Node 发行版
    ├── corepack-home/             # corepack 管理的 pnpm（11.28.5）
    ├── home/                      # 隔离 HOME
    ├── xdg-cache/ xdg-config/ xdg-data/ xdg-state/   # 隔离 XDG
    ├── dsh-home/                  # DSH_HOME（DSH 自身数据目录）
    ├── pnpm-home/                 # pnpm 自身目录（含 CAS store）
    ├── pnpm-store/ npm-cache/     # 包缓存
    └── deepseek-harness/          # DSH 源码（锁定 tag）
```

### 1.2 环境变量隔离（`scripts/env.sh`）

```bash
HOME=$DSH_RUNTIME/home
XDG_CACHE_HOME=$DSH_RUNTIME/xdg-cache
XDG_CONFIG_HOME=$DSH_RUNTIME/xdg-config
XDG_DATA_HOME=$DSH_RUNTIME/xdg-data
XDG_STATE_HOME=$DSH_RUNTIME/xdg-state
DSH_HOME=$DSH_RUNTIME/dsh-home          # ← 关键：DSH 数据目录
COREPACK_HOME=$DSH_RUNTIME/corepack-home
NPM_CONFIG_CACHE=$DSH_RUNTIME/npm-cache
PNPM_HOME=$DSH_RUNTIME/pnpm-home
PNPM_STORE_DIR=$DSH_RUNTIME/pnpm-store
PATH=$DSH_RUNTIME/node-.../bin:$PATH     # 隔离 node 优先
# 网络：绕过失效代理，直连
unset http_proxy https_proxy ...
no_proxy=*  NO_PROXY=*  npm_config_proxy=
```

### 1.3 如何保证与 `/root/.dsh` 零交叠

* DSH 数据目录由 **`DSH_HOME`** 显式指向 `项目/.runtime/dsh-home`，DSH 运行时只会读写这里；
* `HOME`、`XDG_*` 全部改到项目内，避免任何工具默认写 `~/.dsh`、`~/.cache`、`~/.local`；
* 实测：跑完 `dsh --version/--help/--dump-config` 后，配置树落在 `.runtime/dsh-home/profiles/web`，
  而 `/root/.dsh` 全目录时间戳无任何变化（见 §6）。

---

## 2. 版本锁定

| 组件 | 锁定值 | 来源 |
|---|---|---|
| Node | `v22.23.4` | DSH `engines: ^22.19.0 || >=24.0.0`，取 22.x LTS 最新且满足下限 |
| pnpm | `11.28.5` | DSH 根 `package.json` → `"packageManager": "pnpm@11.28.5"` |
| DSH 源码 | `tag = dsh-v0.2.1-rc.3`，版本 `0.2.1-rc.3` | 远端最新 tag |
| DSH commit | `1f81c047fc48fa190a683e469daa699857e9afe8` | `git ls-remote` 核验 |

> 远端 tag 全量排序后最新即为 `dsh-v0.2.1-rc.3`（上一档为 `0.2.1-rc.2`）。
> **注意**：本地 `/root/repo/github.io/deepseek-harness` 是旧版 `0.1.0-rc.8`（commit `141eb6fe`），
> 本次**未使用、未改动**它。

---

## 3. 实际执行命令与输出摘要

### 3.1 环境侦察

```console
$ uname -m                                            # x86_64
$ node -v                                             # v18.19.1  （系统 node，不满足要求）
$ pnpm -v                                             # 10.33.0   （系统 pnpm，未使用）
$ df -h /                                             # 244G 已用 243G，Avail 0，100%  ← 关键约束
```

### 3.2 隔离 Node（官方 tar.xz 本地解压 + 校验）

```console
$ curl -fsSL https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v22.23.4/SHASUMS256.txt | grep linux-x64.tar.xz
1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce  node-v22.23.4-linux-x64.tar.xz
$ sha256sum node-v22.23.4-linux-x64.tar.xz
1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce  node-v22.23.4-linux-x64.tar.xz   # ✅ 一致
$ tar -xf node-v22.23.4-linux-x64.tar.xz -C .runtime/
$ .runtime/node-v22.23.4-linux-x64/bin/node -v
v22.23.4
```

### 3.3 隔离 pnpm（corepack）

```console
$ corepack --version
0.36.0
$ COREPACK_HOME=.runtime/corepack-home corepack prepare pnpm@11.28.5 --activate
Preparing pnpm@11.28.5 for immediate activation...
$ corepack pnpm -v
11.28.5
```

### 3.4 获取 DSH 源码（锁定 tag）

```console
$ git ls-remote --tags --refs https://github.com/deepseek-ai/deepseek-harness | sed 's#.*refs/tags/##' | sort -V | tail -3
dsh-v0.2.1-rc.1
dsh-v0.2.1-rc.2
dsh-v0.2.1-rc.3
$ git ls-remote https://github.com/deepseek-ai/deepseek-harness dsh-v0.2.1-rc.3
1f81c047fc48fa190a683e469daa699857e9afe8    refs/tags/dsh-v0.2.1-rc.3
```

获取方式：`git clone` 直连在 33MB pack 传输中被中断（本机直连 GitHub 约 20KB/s），
改用 **codeload tag tarball** 下载并解压（完整性 `gzip -t` 通过）：

```console
$ curl -fSL --http1.1 --noproxy '*' -o dsh.tar.gz \
    https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/refs/tags/dsh-v0.2.1-rc.3
... 100 33.1M ... DONE size=34808179
$ gzip -t dsh.tar.gz && echo GZIP_OK
GZIP_OK
$ tar -xzf dsh.tar.gz && mv deepseek-harness-dsh-v0.2.1-rc.3 deepseek-harness
$ node -e "const p=require('./package.json');console.log(p.name,p.version,p.packageManager,p.engines)"
@deepseek-ai/dsh-root 0.2.1-rc.3 pnpm@11.28.5 { node: '^22.19.0 || >=24.0.0' }
```

> 说明：tarball 方式不含 `.git`，因此 commit hash 以 `git ls-remote` 结果为准（`1f81c047...`）。
> 需保留 `.git` 时，在网速允许的机器上改用 `scripts/setup-env.sh`（脚本默认优先 `git clone`）。

---

## 4. ⚠️ 网络注意事项（重要：为什么**不能**挂本机代理）

本机有一个本地代理 `127.0.0.1:7890`（clash）。**本环境实测它对大体积 HTTPS 响应体会失败**，
只有 HEAD/小请求可用。因此本方案统一采用「**绕过代理 + 国内镜像直连**」。

实测对比证据：

| 请求 | 经代理 | 直连 |
|---|---|---|
| `registry.npmjs.org/.../pnpm-11.7.0.tgz`（4.5MB） | ❌ `curl (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL` | ✅ 2.8s 完成 |
| `nodejs.org/.../node-v22.23.4-linux-x64.tar.xz`（30MB） | ❌ 同上 | ⏳ 慢；改清华/npmmirror 镜像秒下 |
| `codeload.github.com/.../dsh-v0.2.1-rc.3.tar.gz`（33MB） | ❌ 同上 | ✅ 稳定（~20KB/s，HTTP/1.1） |
| `HEAD`（任意上述 URL） | ✅ 正常返回 200 | ✅ 正常 |

要点：
* 代理对 **body** 会中断，对 **HEAD** 正常——不要被 `curl -I` 成功误导；
* 大文件请显式 `--noproxy '*'`（curl）或 `no_proxy=*`（env），并在 git 中 `env -u http_proxy ...`；
* Node 二进制优先用国内镜像：`cdn.npmmirror.com/binaries/node/...`（实测 ~540KB/s）或清华 `mirrors.tuna...`；
* npm 包直连 `registry.npmjs.org` 已很快；如需加速可切 `registry.npmmirror.com`。

---

## 5. 最小启动验证（实跑通）

由于**源码构建被磁盘阻塞**（见 §7），本机采用 **npm 上已发布的同版本 CLI** 在隔离环境中完成最小启动，
这同样证明了「隔离 Node + 隔离 pnpm + 隔离 DSH_HOME」这套环境是可用的、且能真实启动 DSH：

```console
$ source scripts/env.sh
$ cd .runtime/dsh-cli-npm
$ node_modules/.bin/dsh --version
0.2.1-rc.3
$ node_modules/.bin/dsh --help
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>
...
$ node_modules/.bin/dsh --profile web --dump-config | head -5
# == @deepseek-ai/dsh-base
- id: tool-plugin-manager
  name: '@deepseek-ai/dsh-plugin-manager/tools'
  disabled: true
...
```

* `dsh --version` → `0.2.1-rc.3`（与源码锁定版本一致）
* `--help` / `--profile web --help` / `--profile web --dump-config` 正常，说明 profile 组合引擎可加载
* 运行后配置树写入 `DSH_HOME=.runtime/dsh-home/profiles/web`（证明隔离 DSH_HOME 生效）

`setup-env.sh --check` 幂等自检输出：

```console
$ bash scripts/setup-env.sh --check
[OK] 已存在: v22.23.4（跳过）
[OK] pnpm 11.28.5
[OK] 已存在: 0.2.1-rc.3（跳过）
[OK] DSH 版本 = 0.2.1-rc.3 / commit(期望) 1f81c047fc48fa190a683e469daa699857e9afe8
...
0.2.1-rc.3
[OK] npm 已发布版 dsh 启动成功
```

---

## 6. 隔离性证据

### 6.1 `/root/.dsh` 未被修改（时间戳对比）

搭建开始前（首次侦察）：

```console
$ ls -la /root/.dsh
drwx------ 12 root root 4096 Oct 23 11:28 .          # settings.yaml 等最新 mtime = 2026-10-23
-rw-------  1 root root 1473 Oct 23 11:28 settings.yaml
```

全部安装与启动验证跑完后：

```console
$ ls -la --time-style=full-iso /root/.dsh/settings.yaml
-rw------- 1 root root 1473 2026-10-23 11:28:58.459730944 +0800 /root/.dsh/settings.yaml
$ stat -c '%y %n' /root/.dsh
2026-10-23 11:28:58.467731132 +0800 /root/.dsh
```

→ 目录与内部文件 mtime 完全停留在 **10-23**（早于本次 10-26 的全部操作），**零写入**。

### 6.2 既有 DSH checkout 未被动

```console
$ git -C /root/repo/github.io/deepseek-harness rev-parse HEAD
141eb6fef83422698aef7a981029e843e8161534     # 与搭建前一致
```

### 6.3 系统 node/pnpm 未被使用或修改

* PATH 内 `node` 解析到项目内隔离版本：`.runtime/node-v22.23.4-linux-x64/bin/node`；
* 未执行任何全局 `npm i -g` / `pnpm add -g`；pnpm 由 corepack 装到项目内 `COREPACK_HOME`。

---

## 7. ⚠️ 磁盘阻塞说明（源码 install/build 未能完成）

**根因**：本机 root FS（`/dev/mapper/ubuntu--vg-ubuntu--lv`，244G）已 **100% 占满**，
系统级「可用」为 0，仅有约 **1.5GB 的 ext4 保留块**对 root 可用。

实测数据：

```console
$ df -B1 / | tail -1
... total=261770801152 used=260975390720 free≈0.74~1.5GB（且随机器上其他活动浮动）
```

已尝试的 install 方案与结果：

| 方案 | 结果 |
|---|---|
| `pnpm install --filter "@deepseek-ai/dsh..." --frozen-lockfile`（CLI 闭包全量） | 下载 1117 包后，可用空间跌至 **120MB**，触发磁盘守卫被中止（避免撑爆 root FS） |
| 同上 `--prod`（仅生产依赖） | 链接完成，`node_modules=537MB`；但仍无法运行/构建，且剩余空间不足以再装 dev 依赖 |
| `@deepseek-ai/dsh@0.2.1-rc.3`（npm 已发布版，543MB） | ✅ 安装并**成功运行**（见 §5） |

**为何不能就地构建**：该仓库是 TypeScript monorepo（330+ workspace 包），
包的入口指向构建产物（`packages/*/package.json` → `"main": "lib/index.js"`），
因此「运行源码」必须先 `pnpm install`（含 dev：typescript/tsdown 等）+ `pnpm build`，
构建产物与依赖合计需 ≥ 2–3GB，超出当前可用空间。**强行安装会把 root FS 撑满，可能波及其他运行实例，故主动中止。**

**解封建议（任选其一）**：
1. 清理磁盘（释放 ≥ 3GB）后重跑 `bash scripts/setup-env.sh`；
2. 用其它盘承载依赖：`DSH_DEPS_DIR=/path/with/space bash scripts/setup-env.sh`（脚本会把 `node_modules` 软链到该目录）；
3. 仅做 SDK/插件联调时，可沿用 npm 已发布版 CLI（本机已验证可用）。

> 本环境**未伪造任何成功**：可跑的（隔离环境、最小启动、凭证、隔离性）均已实测通过；
> 不可跑的（源码构建）如实记录为上表卡点。

---

## 8. 推送凭证结论（供 P2 复用）

目标远端：`https://github.com/Elinpf/dsh-swarm`（当前为空仓库，匿名可读、`ls-remote` 返回 rc=0 无 ref）。

已配置凭证：`/root/.git-credentials` 中存在 `https://Elinpf:***@github.com` 条目（store helper）。
**凭证内容不在本报告中出现。**

验证方式（**非破坏性**，`--dry-run` 不写任何 ref）：

```console
$ git init -q -b main && git commit -qm probe && \
  git push --dry-run https://github.com/Elinpf/dsh-swarm main
To https://github.com/Elinpf/dsh-swarm
 * [new branch]      main -> main        # ✅ 认证+写权限可用
$ git ls-remote https://github.com/Elinpf/dsh-swarm   # 远端仍为空，确认 dry-run 未落 ref
（无输出, rc=0）
```

> 注：若后续 push 时报「store 凭证助手取不到锁」（`/root` 可能只读），
> 可改用团队提供的助手：`git -c credential.helper=/root/repo/jiuwen/.proxy-config/git-cred-helper.sh push`。
> 实际首次提交/推 main 由 P2 骨架任务执行。

---

## 9. 新机器如何复现

前置：Linux x86_64、可访问外网（或内网镜像）、`curl`/`tar`/`xz`/`git`。

```bash
# 1) 取脚本（本项目内）
cd <项目>/dsh-swarm

# 2) 一键搭建（幂等；已完成的步骤自动跳过）
bash scripts/setup-env.sh

# 3) 进入隔离环境
source scripts/env.sh
node -v            # v22.23.4
pnpm -v            # 11.28.5
echo $DSH_HOME     # <项目>/.runtime/dsh-home

# 4) 自检
bash scripts/setup-env.sh --check
```

可调参数（环境变量）：`NODE_VERSION`、`PNPM_VERSION`、`DSH_TAG`、`DSH_COMMIT`、
`DSH_DEPS_DIR`（依赖目录位置）、`MIN_FREE_MB_FOR_BUILD`、`DSH_REGISTRY`（npm 源）。

磁盘充足（≥3GB 可用）时，脚本会执行源码 `pnpm install` + `pnpm build` 并优先用
**源码构建版** `apps/cli/lib/bin.js` 做启动验证；磁盘不足时自动跳过并提示解封方式。

---

## 10. 已知限制

1. 本机因磁盘满，**源码构建未完成**；启动验证使用的是 npm 已发布版 CLI（同版本 `0.2.1-rc.3`）。
2. `/dev/shm` 仅 16GB 且为易失内存，作为 `DSH_DEPS_DIR` 只是应急，重启即失效，不推荐长期使用。
3. 源码为 tarball 方式获取，无 `.git`；如需仓库历史请在网络允许时 `git clone`。
4. 本机本地代理对大 body 失效，是**环境特性**，不是 DSH 的问题；换机器若代理正常可忽略 §4。
