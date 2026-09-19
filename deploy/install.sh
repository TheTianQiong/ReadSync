#!/usr/bin/env bash
#
# ReadSync 一键部署脚本（Linux）
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/ReadSync/main/deploy/install.sh | bash
#   或克隆仓库后：  sudo bash deploy/install.sh
#
# 脚本会：检测环境 → 安装 Node.js（如缺失）→ 安装依赖 → 构建 → 生成配置 →
#         初始化数据库 → 注册 systemd 服务并启动。
#
# 国内网络：脚本内置 GitHub 加速链接与 npm 国内镜像，默认自动选择可用节点。
# 可通过环境变量覆盖：
#   GITHUB_PROXY=https://ghfast.top   指定 GitHub 加速前缀（留空则直连）
#   NPM_REGISTRY=https://registry.npmmirror.com  指定 npm 源
#   READSYNC_DIR=/opt/readsync        指定安装目录
#   READSYNC_PORT=3000                指定端口

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

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "${major}" -ge 20 ]]
}

install_node() {
  if node_version_ok; then
    ok "已安装 Node.js $(node -v)，跳过安装"
    return
  fi

  info "安装 Node.js v${NODE_MAJOR}…"

  local version filename url tmp
  # 从 npmmirror 取最新版本号，取不到就退回一个已知可用的版本
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
  # 优先国内镜像；失败则走官方（官方源在国外，必要时经 GitHub 加速不适用，故单独处理）
  if ! curl -fL --connect-timeout 15 --retry 2 -o "${tmp}/${filename}" "${NODE_MIRROR_BASE}/${filename}"; then
    warn "国内镜像下载失败，尝试官方源 https://nodejs.org/dist/…"
    curl -fL --connect-timeout 20 --retry 3 -o "${tmp}/${filename}" "https://nodejs.org/dist/v${NODE_MAJOR}/${filename}" \
      || die "Node.js 下载失败。请手动安装后重试：https://nodejs.org/"
  fi

  tar -xJf "${tmp}/${filename}" -C "${tmp}"
  local extracted="${tmp}/${filename%.tar.xz}"
  [[ -d "${extracted}" ]] || die "解压失败：${extracted}"

  # 安装到 /usr/local，覆盖已有 node（若有）
  cp -rf "${extracted}/bin/." /usr/local/bin/
  cp -rf "${extracted}/include/." /usr/local/include/ 2>/dev/null || true
  cp -rf "${extracted}/lib/." /usr/local/lib/ 2>/dev/null || true
  cp -rf "${extracted}/share/." /usr/local/share/ 2>/dev/null || true

  rm -rf "${tmp}"
  hash -r

  node_version_ok || die "Node.js 安装后仍无法运行，请检查 /usr/local/bin 是否在 PATH 中。"

  ok "Node.js $(node -v) 安装完成"
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

build_project() {
  cd "${READSYNC_DIR}"

  info "配置 npm 镜像：${NPM_REGISTRY}"
  npm config set registry "${NPM_REGISTRY}" --location=project 2>/dev/null || true

  info "安装依赖（可能需要几分钟）…"
  # 原生模块（better-sqlite3）的预编译包默认从 GitHub 下载，这里指定国内二进制镜像
  npm ci --no-audit --no-fund \
    || npm install --no-audit --no-fund

  info "构建前后端…"
  npm run build

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
ExecStart=$(command -v node) ${READSYNC_DIR}/packages/server/dist/index.js
Restart=on-failure
RestartSec=5

# 安全加固：服务只需要写自己的数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
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
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${READSYNC_PORT}/api/system/health" >/dev/null 2>&1; then
      ok "服务已启动"
      return
    fi
    sleep 1
  done

  warn "服务未在 20 秒内就绪，请查看日志排查：journalctl -u readsync -n 50 --no-pager"
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
