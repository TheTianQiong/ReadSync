#!/usr/bin/env bash
#
# ReadSync 一键部署脚本（Linux）
#
# 推荐用法（克隆后执行，国内网络下最可靠）：
#   git clone https://github.com/TheTianQiong/ReadSync.git
#   cd ReadSync && sudo bash deploy/install.sh
#
# 也可以用一行命令直接跑。注意 raw.githubusercontent.com 在国内常被墙，
# 因此提供加速前缀写法（加速节点本身失效时，改用上面的 clone 方式）：
#   curl -fsSL https://ghfast.top/https://raw.githubusercontent.com/TheTianQiong/ReadSync/main/deploy/install.sh | bash
#
# 脚本会：检测环境 → 检测/安装 Node.js → 安装依赖 → 构建 → 生成配置 →
#         初始化数据库 → 注册 systemd 服务并启动。
#
# Node.js 检测：会在 root 的 PATH 之外，额外搜索 sudo 调用者的 nvm / fnm / volta
# 目录，因此**已经装好 Node 和 npm 的机器不会再下载安装包**。
# 仅当找不到、版本低于 v20、或缺少 npm 时才会下载。
# 已装但版本过低时会额外装一份到 /usr/local（不删除原有版本）。
#
# 国内网络：脚本内置 GitHub 加速链接与 npm 国内镜像，默认自动选择可用节点。
# 可通过环境变量覆盖：
#   GITHUB_PROXY=https://ghfast.top   指定 GitHub 加速前缀（留空则直连）
#   NPM_REGISTRY=https://registry.npmmirror.com  指定 npm 源
#   READSYNC_DIR=/opt/readsync        指定安装目录
#   READSYNC_PORT=3000                指定端口
#   FORCE_NODE_INSTALL=1              强制重新下载安装 Node.js（默认复用已有的）
#   NODE_MAJOR=22                     需要安装的 Node 主版本

set -Eeuo pipefail

# ------------------------------- 外观 -------------------------------

readonly C_RESET='\033[0m'
readonly C_INFO='\033[0;36m'
readonly C_OK='\033[0;32m'
readonly C_WARN='\033[0;33m'
readonly C_ERR='\033[0;31m'

info()  { printf "${C_INFO}[信息]${C_RESET} %s\n" "$*"; }
ok()    { printf "${C_OK}[完成]${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_WARN}[警告]${C_RESET} %s\n" "$*" >&2; }
err()   { printf "${C_ERR}[错误]${C_RESET} %s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

# 出错时打印行号，便于定位
trap 'err "脚本在第 $LINENO 行失败，已中止"' ERR

# ------------------------------ 配置项 ------------------------------

READSYNC_DIR="${READSYNC_DIR:-/opt/readsync}"
READSYNC_PORT="${READSYNC_PORT:-3000}"
READSYNC_USER="${READSYNC_USER:-readsync}"
NODE_MAJOR="${NODE_MAJOR:-22}"
# 本项目要求的最低 Node 主版本。低于此版本才会去下载安装新版本。
NODE_MAJOR_MIN="${NODE_MAJOR_MIN:-20}"

# 设为 1 可强制重新下载安装 Node.js（默认在已有可用版本时跳过）
FORCE_NODE_INSTALL="${FORCE_NODE_INSTALL:-0}"

# 是否要求安装为 systemd 服务
INSTALL_SERVICE="${INSTALL_SERVICE:-auto}"

# GitHub 加速前缀。留空表示直连；设为 "auto" 则自动探测可用节点。
GITHUB_PROXY="${GITHUB_PROXY:-auto}"

# npm 源
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

# 候选 GitHub 加速节点（按经验可用性排序）
GITHUB_MIRRORS=(
  "https://ghfast.top"
  "https://gh-proxy.com"
  "https://ghproxy.net"
  "https://mirror.ghproxy.com"
)

# Node.js 国内镜像（npmmirror 提供完整的 Node 发行版镜像，比走 GitHub 快且稳定）
NODE_MIRROR_BASE="${NODE_MIRROR_BASE:-https://npmmirror.com/mirrors/node}"

# ------------------------------ 环境检测 ------------------------------

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "请用 root 权限运行：sudo bash $0"
  fi
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  [[ "${os}" == "Linux" ]] || die "本脚本仅支持 Linux。Windows 请使用 Docker 部署，macOS 请手动执行 npm 命令。"

  case "${arch}" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    armv7l) NODE_ARCH="armv7l" ;;
    *) die "不支持的 CPU 架构：${arch}" ;;
  esac

  # 判断是否有 systemd
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    HAS_SYSTEMD=1
  else
    HAS_SYSTEMD=0
    warn "未检测到 systemd，将不会注册开机自启服务，请自行用 nohup / supervisor 等方式守护进程。"
  fi

  ok "检测到平台：Linux ${arch}（Node 架构标识：${NODE_ARCH}）"
}

# 探测可用的 GitHub 加速节点
resolve_github_proxy() {
  if [[ "${GITHUB_PROXY}" != "auto" ]]; then
    [[ -n "${GITHUB_PROXY}" ]] && info "使用指定的 GitHub 加速：${GITHUB_PROXY}" \
                               || info "按配置直连 GitHub"
    return
  fi

  info "正在探测 GitHub 加速节点…"
  local m
  for m in "${GITHUB_MIRRORS[@]}"; do
    # 探测一个体积很小的公开文件，5 秒超时
    if curl -fsSL --max-time 5 --range 0-100 -o /dev/null "${m}/https://raw.githubusercontent.com/nodejs/release-keys/main/README.md" 2>/dev/null; then
      GITHUB_PROXY="${m}"
      ok "选用加速节点：${m}"
      return
    fi
  done

  GITHUB_PROXY=""
  warn "未找到可用的 GitHub 加速节点，将直连 GitHub（可能较慢）。"
  warn "可手动指定：GITHUB_PROXY=https://ghfast.top bash $0"
}

# 带加速前缀地下载 GitHub 资源
gh_download() {
  local url="$1" out="$2"
  if [[ -n "${GITHUB_PROXY}" && "${url}" == https://github.com/* ]]; then
    url="${GITHUB_PROXY}/${url}"
  fi
  curl -fL --connect-timeout 15 --retry 3 --retry-delay 2 -o "${out}" "${url}"
}

# ------------------------------ 依赖安装 ------------------------------

install_base_packages() {
  local pkgs=(curl ca-certificates tar xz-utils)
  info "检查基础工具…"

  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "${pkgs[@]}" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates tar xz
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl ca-certificates tar xz
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates tar xz
  else
    warn "未识别的包管理器，请自行确保已安装：${pkgs[*]}"
  fi

  ok "基础工具就绪"
}

# ---------------------- Node.js 检测 ----------------------
#
# 为什么不能只用 `command -v node`：
# 本脚本要求以 root 运行，而 root 的 PATH 通常不包含普通用户通过
# nvm / fnm / volta 安装的 Node。结果就是「机器上明明装好了 Node 和 npm，
# 脚本却判定未安装并重新下载」。下面改为在多个候选目录中查找。

# 检测结果（全局）：保存绝对路径，后续不再依赖 PATH
NODE_BIN=""
NPM_BIN=""
NODE_FOUND_VERSION=""
NODE_TOO_OLD=0
NODE_FROM_HOME=0

# 取用户家目录。优先 getent，缺失时退回家目录展开（busybox 环境可能没有 getent）
user_home_dir() {
  local user="$1" home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "${user}" 2>/dev/null | cut -d: -f6)"
  fi
  if [[ -z "${home}" ]]; then
    home="$(eval echo "~${user}" 2>/dev/null || true)"
    # 展开失败时会原样返回 ~user，这种结果没有意义
    [[ "${home}" == "~"* ]] && home=""
  fi
  printf '%s' "${home}"
}

# 列出目录下按版本号排序的最后一个条目。sort -V 在 busybox 上可能不支持，故做降级
latest_version_dir() {
  local dir="$1" out=""
  out="$(ls -1 "${dir}" 2>/dev/null | sort -V 2>/dev/null | tail -1)"
  [[ -z "${out}" ]] && out="$(ls -1 "${dir}" 2>/dev/null | sort | tail -1)"
  printf '%s' "${out}"
}

# 判断路径是否落在 systemd 的 ProtectHome 会屏蔽的范围内。
#
# ProtectHome=true 会隐藏 /home、/root、/run/user —— 通过 nvm/fnm 安装的 Node
# 正好在这些位置，若不放宽保护，服务会因找不到解释器而启动失败。
# 抽成独立函数是为了能脱离文件系统直接测试。
is_under_home() {
  case "$1" in
    /home/*|/root/*|/run/user/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 输出 Node.js 的候选搜索目录，每行一个
node_search_dirs() {
  local dirs=()

  # 1) sudo 调用者的环境 —— nvm / fnm / volta / 用户本地 bin
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    local home latest
    home="$(user_home_dir "${SUDO_USER}")"
    if [[ -n "${home}" && -d "${home}" ]]; then
      # nvm 可能装了多个版本，取版本号最大的那个
      if [[ -d "${home}/.nvm/versions/node" ]]; then
        latest="$(latest_version_dir "${home}/.nvm/versions/node")"
        [[ -n "${latest}" ]] && dirs+=("${home}/.nvm/versions/node/${latest}/bin")
      fi
      # fnm
      if [[ -d "${home}/.local/share/fnm/node-versions" ]]; then
        latest="$(latest_version_dir "${home}/.local/share/fnm/node-versions")"
        [[ -n "${latest}" ]] && dirs+=("${home}/.local/share/fnm/node-versions/${latest}/installation/bin")
      fi
      dirs+=("${home}/.volta/bin" "${home}/.local/bin" "${home}/bin")
    fi
  fi

  # 2) 当前 PATH
  local p
  while IFS= read -r p; do
    [[ -n "${p}" ]] && dirs+=("${p}")
  done < <(printf '%s' "${PATH}" | tr ':' '\n')

  # 3) 系统常见安装位置
  dirs+=("/usr/local/bin" "/usr/bin" "/bin" "/usr/local/node/bin" "/opt/node/bin")

  printf '%s\n' "${dirs[@]}"
}

# 在候选目录中查找可执行文件，成功时输出其绝对路径
find_tool() {
  local name="$1" dir
  while IFS= read -r dir; do
    if [[ -n "${dir}" && -x "${dir}/${name}" && ! -d "${dir}/${name}" ]]; then
      printf '%s' "${dir}/${name}"
      return 0
    fi
  done < <(node_search_dirs)
  return 1
}

# 检测已有的 Node.js 与 npm。
# 返回 0 表示找到版本达标且自带 npm 的 Node，可直接复用、无需下载。
detect_node() {
  NODE_BIN=""; NPM_BIN=""; NODE_FOUND_VERSION=""; NODE_TOO_OLD=0; NODE_FROM_HOME=0

  local found_node
  found_node="$(find_tool node || true)"
  [[ -n "${found_node}" ]] || return 1

  local version major
  version="$("${found_node}" -v 2>/dev/null || true)"
  major="${version#v}"; major="${major%%.*}"

  # 版本号解析不出来时不要盲信，交给下载流程处理
  if ! [[ "${major}" =~ ^[0-9]+$ ]]; then
    warn "检测到 ${found_node}，但无法解析版本号（输出：${version:-空}），将忽略它"
    return 1
  fi

  NODE_FOUND_VERSION="${version}"

  if (( major < NODE_MAJOR_MIN )); then
    NODE_TOO_OLD=1
    NODE_BIN="${found_node}"
    return 1
  fi

  # npm 通常与 node 同目录，也允许在其它候选目录中找到
  local found_npm
  found_npm="$(find_tool npm || true)"
  if [[ -z "${found_npm}" && -x "$(dirname "${found_node}")/npm" ]]; then
    found_npm="$(dirname "${found_node}")/npm"
  fi

  NODE_BIN="${found_node}"
  NPM_BIN="${found_npm}"

  # 家目录下的 Node 会被 systemd 的 ProtectHome 挡住，注册服务时需放宽
  if is_under_home "${found_node}"; then
    NODE_FROM_HOME=1
  fi

  return 0
}

# 复用了已有 Node 时，提示可能影响后续运维的细节
report_node_location() {
  if (( NODE_FROM_HOME == 1 )); then
    warn "该 Node 位于用户家目录：$(dirname "${NODE_BIN}")"
    warn "systemd 的 ProtectHome 会阻止服务访问它，注册服务时将自动放宽该限制"
    warn "若之后通过 nvm 升级或删除该版本，需要重新运行本脚本更新服务配置"
  fi
}

# 仅在「Node 达标但缺少 npm」时尝试补装。
# Debian 系把 nodejs 与 npm 拆成了两个包，因此这种情况确实存在。
install_npm_only() {
  info "尝试通过系统包管理器补装 npm…"
  local pm=""
  command -v apt-get >/dev/null 2>&1 && pm="apt-get"
  [[ -z "${pm}" ]] && command -v dnf >/dev/null 2>&1 && pm="dnf"
  [[ -z "${pm}" ]] && command -v yum >/dev/null 2>&1 && pm="yum"
  [[ -z "${pm}" ]] && command -v apk >/dev/null 2>&1 && pm="apk"
  [[ -n "${pm}" ]] || return 1

  case "${pm}" in
    apt-get) DEBIAN_FRONTEND=noninteractive apt-get install -y -qq npm >/dev/null 2>&1 || return 1 ;;
    dnf)     dnf install -y -q npm >/dev/null 2>&1 || return 1 ;;
    yum)     yum install -y -q npm >/dev/null 2>&1 || return 1 ;;
    apk)     apk add --no-cache npm >/dev/null 2>&1 || return 1 ;;
  esac

  # 装上了不代表能用，实测一次
  local candidate
  candidate="$(find_tool npm || true)"
  [[ -n "${candidate}" ]] && "${candidate}" -v >/dev/null 2>&1
}

# 下载官方预编译包并安装到 /usr/local
download_and_install_node() {
  info "安装 Node.js v${NODE_MAJOR}…"

  local version filename tmp
  # 从 npmmirror 取最新版本号，取不到就退回官方源
  version="$(curl -fsSL --max-time 10 "${NODE_MIRROR_BASE}/latest-v${NODE_MAJOR}.x/" 2>/dev/null \
    | grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${NODE_ARCH}\.tar\.xz" \
    | head -1 || true)"

  if [[ -z "${version}" ]]; then
    warn "无法从 ${NODE_MIRROR_BASE} 获取版本列表，尝试官方源…"
    version="$(curl -fsSL --max-time 10 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" 2>/dev/null \
      | grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${NODE_ARCH}\.tar\.xz" \
      | head -1 || true)"
  fi

  [[ -n "${version}" ]] || die "无法确定 Node.js 版本号，请手动安装 Node.js ${NODE_MAJOR}+ 后重试。"

  filename="${version}"
  info "下载 ${filename}"

  tmp="$(mktemp -d)"
  # 优先国内镜像；失败则走官方源（官方源在国外，GitHub 加速不适用，故单独处理）
  if ! curl -fL --connect-timeout 15 --retry 2 -o "${tmp}/${filename}" "${NODE_MIRROR_BASE}/${filename}"; then
    warn "国内镜像下载失败，尝试官方源 https://nodejs.org/dist/…"
    curl -fL --connect-timeout 20 --retry 3 -o "${tmp}/${filename}" "https://nodejs.org/dist/v${NODE_MAJOR}/${filename}" \
      || die "Node.js 下载失败。请手动安装后重试：https://nodejs.org/"
  fi

  tar -xJf "${tmp}/${filename}" -C "${tmp}"
  local extracted="${tmp}/${filename%.tar.xz}"
  [[ -d "${extracted}" ]] || die "解压失败：${extracted}"

  # 用 -a 而非 -rf：官方包里的 npm/npx 是指向 lib/node_modules/npm 的
  # 符号链接，-a 会保留链接关系，-r 可能把它们展开成普通文件
  cp -a "${extracted}/bin/." /usr/local/bin/
  cp -a "${extracted}/include/." /usr/local/include/ 2>/dev/null || true
  cp -a "${extracted}/lib/." /usr/local/lib/ 2>/dev/null || true
  cp -a "${extracted}/share/." /usr/local/share/ 2>/dev/null || true

  rm -rf "${tmp}"
  hash -r

  # 刚装到 /usr/local，直接指定它，避免候选目录里更靠前的旧版本被再次选中
  NODE_BIN="/usr/local/bin/node"
  NPM_BIN="/usr/local/bin/npm"
  NODE_FROM_HOME=0

  [[ -x "${NODE_BIN}" ]] || die "安装后未找到 ${NODE_BIN}。"
  [[ -x "${NPM_BIN}" ]] || die "安装后未找到 ${NPM_BIN}（npm 随 Node 一同安装）。"
}

install_node() {
  if [[ "${FORCE_NODE_INSTALL}" == "1" ]]; then
    warn "FORCE_NODE_INSTALL=1，跳过检测，强制重新安装 Node.js"
    download_and_install_node
    ok "Node.js $("${NODE_BIN}" -v) 安装完成"
    return
  fi

  if detect_node; then
    ok "检测到 Node.js ${NODE_FOUND_VERSION}：${NODE_BIN}"

    if [[ -n "${NPM_BIN}" ]]; then
      ok "检测到 npm $("${NPM_BIN}" -v 2>/dev/null || echo '?')：${NPM_BIN}"
      ok "版本满足要求（>= v${NODE_MAJOR_MIN}），跳过下载与安装"
      report_node_location
      return
    fi

    warn "检测到 Node.js 但未找到 npm（部分发行版把 nodejs 与 npm 拆成两个包）"
    if install_npm_only; then
      NPM_BIN="$(find_tool npm || true)"
      ok "npm $("${NPM_BIN}" -v) 已就绪：${NPM_BIN}"
      report_node_location
      return
    fi
    warn "补装 npm 失败，改为安装一份自带 npm 的 Node.js v${NODE_MAJOR}"
  fi

  if (( NODE_TOO_OLD == 1 )); then
    warn "已安装的 Node.js ${NODE_FOUND_VERSION} 低于要求的 v${NODE_MAJOR_MIN}：${NODE_BIN}"
    warn "将额外安装 v${NODE_MAJOR} 到 /usr/local（不删除原有版本，但 /usr/local/bin 优先级更高）"
  fi

  download_and_install_node
  ok "Node.js $("${NODE_BIN}" -v) 与 npm $("${NPM_BIN}" -v) 安装完成"
}

# ------------------------------ 获取源码 ------------------------------

prepare_source() {
  # 已经是仓库目录（脚本在 deploy/ 下）时直接用当前仓库
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local repo_root
  repo_root="$(dirname "${script_dir}")"

  if [[ -f "${repo_root}/package.json" && -d "${repo_root}/packages" ]]; then
    info "检测到本地仓库：${repo_root}"
    READSYNC_DIR="${repo_root}"
    return
  fi

  # 否则从 GitHub 拉取
  local repo_url="${READSYNC_REPO:-https://github.com/TheTianQiong/ReadSync.git}"
  if [[ -n "${GITHUB_PROXY}" ]]; then
    repo_url="${GITHUB_PROXY}/${repo_url}"
    info "使用加速地址克隆仓库：${repo_url}"
  fi

  command -v git >/dev/null 2>&1 || die "需要 git 来拉取源码，请先安装：apt install git"

  if [[ -d "${READSYNC_DIR}/.git" ]]; then
    info "更新已有仓库：${READSYNC_DIR}"
    git -C "${READSYNC_DIR}" pull --ff-only
  else
    info "克隆仓库到 ${READSYNC_DIR}"
    mkdir -p "$(dirname "${READSYNC_DIR}")"
    git clone --depth 1 "${repo_url}" "${READSYNC_DIR}"
  fi
}

# ------------------------------ 构建 ------------------------------

# 依赖完整性自检。
#
# npm 安装被中断时会留下「半装」的 node_modules（目录在但入口文件缺失），
# 之后再跑 npm install 也未必修复，最终表现为各种看似是代码 bug 的错误。
# 这里在构建前就把问题挡下来，避免排查方向被带偏。
#
# 因为安装时用了 --ignore-scripts，同时也要确认原生模块的预编译产物确实可用。
verify_native_modules() {
  local script="${READSYNC_DIR}/scripts/check-deps.mjs"
  [[ -f "${script}" ]] || { warn "未找到 ${script}，跳过依赖自检"; return; }

  if ! "${NODE_BIN}" "${script}"; then
    echo ""
    warn "依赖安装不完整。常见原因是安装过程中网络中断。"
    warn "可先安装编译工具链后重试（若预编译产物不可用）："
    warn "  apt-get install -y python3 make g++   # Debian/Ubuntu"
    die "依赖自检未通过，构建中止。"
  fi
}

build_project() {
  cd "${READSYNC_DIR}"

  # 用检测阶段确定的绝对路径，避免 PATH 里存在多个 node 时用错版本
  [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]] || die "未确定 Node.js 路径，无法继续。"
  [[ -n "${NPM_BIN}" && -x "${NPM_BIN}" ]] || die "未确定 npm 路径，无法继续。"
  export PATH="$(dirname "${NODE_BIN}"):${PATH}"

  info "使用 Node.js $("${NODE_BIN}" -v) / npm $("${NPM_BIN}" -v)"

  info "配置 npm 镜像：${NPM_REGISTRY}"
  "${NPM_BIN}" config set registry "${NPM_REGISTRY}" --location=project 2>/dev/null || true

  info "安装依赖（可能需要几分钟）…"
  #
  # 必须加 --ignore-scripts：
  # npm 10（随 Node 22 附带的版本）不会拦截安装脚本，遇到带 binding.gyp 的包会
  # 自动调用 node-gyp 做源码编译，而服务器上通常没有 python3/make/g++，
  # 于是 `npm ci` 直接失败 —— 这是「一键部署跑不起来」的主要原因。
  #
  # 跳过脚本是安全的：本项目用到的原生模块都自带各平台预编译产物
  #   better-sqlite3   → prebuilds/linux-x64.node
  #   @node-rs/argon2  → @node-rs/argon2-linux-x64-gnu 等平台包
  #   esbuild/rolldown → 平台专用可选依赖
  # 安装后下面还会实测这几个模块能否加载，真出问题会给出明确提示。
  "${NPM_BIN}" ci --ignore-scripts --no-audit --no-fund \
    || "${NPM_BIN}" install --ignore-scripts --no-audit --no-fund

  verify_native_modules

  info "构建前后端…"
  "${NPM_BIN}" run build

  [[ -f "${READSYNC_DIR}/packages/server/dist/index.js" ]] \
    || die "后端构建产物缺失，构建可能失败。"
  [[ -f "${READSYNC_DIR}/packages/web/dist/index.html" ]] \
    || warn "前端构建产物缺失，将只能使用 API。"

  ok "构建完成"
}

# ------------------------------ 配置 ------------------------------

setup_env() {
  cd "${READSYNC_DIR}"

  local data_dir="${READSYNC_DIR}/data"
  mkdir -p "${data_dir}"

  if [[ -f .env ]]; then
    ok "已存在 .env，保留现有配置（如需重置请手动删除）"
  else
    info "生成 .env 配置"

    # 生成主密钥（用于加密存储凭据）
    local secret
    if command -v openssl >/dev/null 2>&1; then
      secret="$(openssl rand -base64 48 | tr -d '\n')"
    else
      secret="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
    fi

    # 推断对外访问地址
    local host_ip
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"
    [[ -n "${host_ip}" ]] || host_ip="localhost"

    cat > .env <<EOF
# 由 deploy/install.sh 于 $(date '+%Y-%m-%d %H:%M:%S') 自动生成
NODE_ENV=production
READSYNC_PORT=${READSYNC_PORT}
READSYNC_HOST=0.0.0.0
READSYNC_BASE_URL=http://${host_ip}:${READSYNC_PORT}
READSYNC_DATA_DIR=${data_dir}
READSYNC_SECRET=${secret}
READSYNC_LOG_LEVEL=info
READSYNC_LOG_PRETTY=false
READSYNC_AUTO_MIGRATE=true
READSYNC_SERVE_WEB=true
EOF

    chmod 600 .env
    ok "已生成 .env（含随机主密钥，请勿泄露）"
    warn "若通过域名或反向代理访问，请把 READSYNC_BASE_URL 改为真实地址，否则通行密钥无法使用。"
  fi
}

# ------------------------------ 服务注册 ------------------------------

setup_user() {
  if id "${READSYNC_USER}" >/dev/null 2>&1; then
    return
  fi
  info "创建系统用户 ${READSYNC_USER}"
  useradd --system --shell /usr/sbin/nologin --home-dir "${READSYNC_DIR}" "${READSYNC_USER}" 2>/dev/null || true
}

setup_service() {
  if [[ "${INSTALL_SERVICE}" == "false" || "${HAS_SYSTEMD}" -eq 0 ]]; then
    return
  fi

  info "注册 systemd 服务"

  setup_user
  chown -R "${READSYNC_USER}:${READSYNC_USER}" "${READSYNC_DIR}" 2>/dev/null || true

  # ProtectHome=true 会让服务看不到 /home、/root、/run/user 下的任何内容。
  #
  # 只要 **Node 解释器** 或 **应用目录** 任一落在这些位置就必须放宽，否则：
  #   - Node 在 nvm 目录  → 服务找不到解释器
  #   - 应用在 /root/ReadSync 或 /home/<用户>/ReadSync（git clone 的常见位置，
  #     尤其是直接用 root 登录的服务器）→ 服务读不到自己的代码
  #     甚至 systemd 连 EnvironmentFile 都加载不了，直接启动失败。
  local home_reason=""
  if (( NODE_FROM_HOME == 1 )); then
    home_reason="Node 位于家目录 ${NODE_BIN}"
  fi
  if is_under_home "${READSYNC_DIR}/"; then
    home_reason="${home_reason:+${home_reason}；}应用目录位于 ${READSYNC_DIR}"
  fi

  if [[ -n "${home_reason}" ]]; then
    HOME_PROTECTION="# ProtectHome 已放宽为 read-only：${home_reason}
# 完全隔离会导致服务无法访问上述路径而启动失败"
    HOME_PROTECTION_VALUE="ProtectHome=read-only"
    warn "应用或 Node 位于家目录，systemd 服务已放宽 ProtectHome（${home_reason}）"
    warn "更稳妥的做法是把项目放到 /opt 下，例如：sudo mv ${READSYNC_DIR} /opt/readsync"
  else
    HOME_PROTECTION="# 安全加固：服务只需要写自己的数据目录"
    HOME_PROTECTION_VALUE="ProtectHome=true"
  fi

  # 让服务能读取 .env
  cat > /etc/systemd/system/readsync.service <<EOF
[Unit]
Description=ReadSync 读记服务器
Documentation=https://github.com/TheTianQiong/ReadSync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${READSYNC_USER}
WorkingDirectory=${READSYNC_DIR}
EnvironmentFile=${READSYNC_DIR}/.env
ExecStart=${NODE_BIN} ${READSYNC_DIR}/packages/server/dist/index.js
Restart=on-failure
RestartSec=5

${HOME_PROTECTION}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
${HOME_PROTECTION_VALUE}
ReadWritePaths=${READSYNC_DIR}/data

# 日志走 journald
StandardOutput=journal
StandardError=journal
SyslogIdentifier=readsync

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable readsync >/dev/null 2>&1
  systemctl restart readsync

  info "等待服务启动…"
  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${READSYNC_PORT}/api/system/health" >/dev/null 2>&1; then
      ok "服务已启动"
      return
    fi
    sleep 1
  done

  # 启动失败时必须明确失败。
  # 之前这里只 warn 一句就继续往下打印「部署完成」横幅，
  # 用户看到的是成功提示、实际服务根本没起来，排查方向完全被误导。
  err "服务未能在 30 秒内就绪，部署失败。"
  echo ""
  echo "── systemd 服务状态 ──────────────────────────"
  systemctl status readsync --no-pager -l 2>&1 | head -20 || true
  echo ""
  echo "── 服务日志（最后 30 行）──────────────────────"
  journalctl -u readsync -n 30 --no-pager 2>&1 || true
  echo ""
  echo "── 常见原因 ──────────────────────────────────"
  echo "  1. 端口 ${READSYNC_PORT} 被占用：ss -lntp | grep ${READSYNC_PORT}"
  echo "  2. 数据目录不可写：${READSYNC_DIR}/data 的属主应为 ${READSYNC_USER}"
  echo "  3. 配置文件有误：检查 ${READSYNC_DIR}/.env"
  echo ""
  die "请根据以上信息修复后重新运行本脚本。"
}

# ------------------------------ 收尾 ------------------------------

print_summary() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"
  [[ -n "${ip}" ]] || ip="localhost"

  local version="unknown"
  if [[ -f "${READSYNC_DIR}/package.json" ]]; then
    version="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "${READSYNC_DIR}/package.json" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo unknown)"
  fi

  printf "\n"
  printf "${C_OK}════════════════════════════════════════════════════════${C_RESET}\n"
  printf "${C_OK}  ReadSync 读记服务器 v%s 部署完成${C_RESET}\n" "${version}"
  printf "${C_OK}════════════════════════════════════════════════════════${C_RESET}\n\n"
  printf "  访问地址   : ${C_INFO}http://%s:%s${C_RESET}\n" "${ip}" "${READSYNC_PORT}"
  printf "  安装目录   : %s\n" "${READSYNC_DIR}"
  printf "  数据目录   : %s/data\n" "${READSYNC_DIR}"
  printf "  配置文件   : %s/.env\n" "${READSYNC_DIR}"
  printf "  Node.js    : %s\n" "${NODE_FOUND_VERSION:-$("${NODE_BIN}" -v 2>/dev/null || echo '未知')}（${NODE_BIN}）"
  printf "  npm        : %s\n" "${NPM_BIN}"
  printf "\n"
  printf "  首次访问会引导你创建管理员账号。\n\n"

  if [[ "${HAS_SYSTEMD}" -eq 1 && "${INSTALL_SERVICE}" != "false" ]]; then
    printf "  常用命令：\n"
    printf "    查看状态   systemctl status readsync\n"
    printf "    查看日志   journalctl -u readsync -f\n"
    printf "    重启服务   systemctl restart readsync\n"
    printf "    停止服务   systemctl stop readsync\n"
  else
    printf "  手动启动：\n"
    printf "    cd %s && npm start\n" "${READSYNC_DIR}"
  fi
  printf "\n"
  printf "  ${C_WARN}请务必定期备份 %s/data 目录（含数据库与密钥）${C_RESET}\n\n" "${READSYNC_DIR}"
}

# ------------------------------ 主流程 ------------------------------

main() {
  printf "\n${C_INFO}ReadSync 读记服务器 · 一键部署${C_RESET}\n\n"

  need_root
  detect_platform
  install_base_packages
  resolve_github_proxy
  install_node
  prepare_source
  build_project
  setup_env
  setup_service
  print_summary
}

main "$@"
