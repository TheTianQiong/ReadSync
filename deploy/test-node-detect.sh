#!/usr/bin/env bash
#
# install.sh 的 Node.js 检测逻辑回归测试。
#
# 覆盖曾经的真实缺陷：脚本以 root 运行，`command -v node` 只能看到 root 的 PATH，
# 于是用户通过 nvm/fnm 安装的 Node 被判定为「未安装」，脚本重新下载安装包。
#
# 用法：bash deploy/test-node-detect.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="${SCRIPT_DIR}/install.sh"

[[ -f "${INSTALL_SH}" ]] || { echo "找不到 ${INSTALL_SH}"; exit 1; }

# 只加载函数定义，不执行 main（main 是文件最后一行）
# shellcheck disable=SC1090
source <(sed '$d' "${INSTALL_SH}")

PASS=0
FAIL=0
check() {
  local name="$1" ok="$2"
  if [[ "${ok}" == "1" ]]; then
    echo "  [OK]   ${name}"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${name}"
    FAIL=$((FAIL + 1))
  fi
}

# 造一个假 node/npm，让它对 -v 输出指定版本
make_fake_node() {
  local dir="$1" version="$2"
  mkdir -p "${dir}"
  printf '#!/bin/sh\ncase "$1" in -v|--version) echo "%s";; *) exit 0;; esac\n' "${version}" > "${dir}/node"
  printf '#!/bin/sh\ncase "$1" in -v|--version) echo "10.9.0";; *) exit 0;; esac\n' > "${dir}/npm"
  chmod +x "${dir}/node" "${dir}/npm"
}

ORIGINAL_PATH="${PATH}"

echo "1. 当前 PATH 中已有 Node 时应直接复用"
if detect_node; then
  check "检出 Node ${NODE_FOUND_VERSION}（${NODE_BIN}）" "1"
  check "同时检出 npm（${NPM_BIN}）" "$([[ -n "${NPM_BIN}" && -x "${NPM_BIN}" ]] && echo 1 || echo 0)"
  check "版本达标时不标记 too_old" "$([[ "${NODE_TOO_OLD}" == "0" ]] && echo 1 || echo 0)"
else
  check "检出 Node（未找到，too_old=${NODE_TOO_OLD}）" "0"
fi

echo
echo "2. 模拟 root 看不到用户 nvm 目录的机器（原缺陷场景）"
FAKE_HOME="$(mktemp -d)"
make_fake_node "${FAKE_HOME}/.nvm/versions/node/v18.20.0/bin" "v18.20.0"
make_fake_node "${FAKE_HOME}/.nvm/versions/node/v22.9.0/bin" "v22.9.0"

# 把 PATH 收窄到不含 node 的目录，模拟 root 的环境
export PATH="/usr/bin:/bin"
export SUDO_USER="fakeuser"
# 让家目录解析指向我们的假目录（真实环境由 getent 提供）
# shellcheck disable=SC2317
user_home_dir() { printf '%s' "${FAKE_HOME}"; }

if detect_node; then
  check "在 nvm 目录中找到 Node（${NODE_BIN}）" "1"
  check "选中较新的版本 v22.9.0 而非 v18.20.0" "$([[ "${NODE_FOUND_VERSION}" == "v22.9.0" ]] && echo 1 || echo 0)"
  check "同时找到 npm" "$([[ -n "${NPM_BIN}" ]] && echo 1 || echo 0)"
else
  check "在 nvm 目录中找到 Node（未找到，too_old=${NODE_TOO_OLD}）" "0"
fi

# NODE_FROM_HOME 直接测判定函数：假家目录在 /tmp 下（Git Bash 的 mktemp 行为），
# 用 Linux 的真实路径形态验证，不依赖文件系统布局
echo
echo "2b. ProtectHome 判定（决定 systemd 服务能否访问到解释器）"
# shellcheck disable=SC2317
is_under_home "/home/alice/.nvm/versions/node/v22.9.0/bin/node" && r=1 || r=0
check "识别 /home 下的 Node" "${r}"
# shellcheck disable=SC2317
is_under_home "/root/.nvm/versions/node/v22.9.0/bin/node" && r=1 || r=0
check "识别 /root 下的 Node" "${r}"
# shellcheck disable=SC2317
is_under_home "/usr/local/bin/node" && r=1 || r=0
check "/usr/local/bin 不需要放宽保护" "$([[ "${r}" == "0" ]] && echo 1 || echo 0)"
# shellcheck disable=SC2317
is_under_home "/usr/bin/node" && r=1 || r=0
check "/usr/bin 不需要放宽保护" "$([[ "${r}" == "0" ]] && echo 1 || echo 0)"

echo
echo "3. 已有 Node 但版本过低时应标记 too_old 并去安装新版"
FAKE_HOME_OLD="$(mktemp -d)"
make_fake_node "${FAKE_HOME_OLD}/.nvm/versions/node/v18.20.0/bin" "v18.20.0"
# shellcheck disable=SC2317
user_home_dir() { printf '%s' "${FAKE_HOME_OLD}"; }

if detect_node; then
  check "低版本不应被当作可用" "0"
else
  check "低版本被识别为不达标" "1"
  check "NODE_TOO_OLD=1（触发安装新版本）" "$([[ "${NODE_TOO_OLD}" == "1" ]] && echo 1 || echo 0)"
fi

echo
echo "4. 完全没有 Node 时应返回未找到"
EMPTY_HOME="$(mktemp -d)"
# shellcheck disable=SC2317
user_home_dir() { printf '%s' "${EMPTY_HOME}"; }
if detect_node; then
  check "空环境下不应误报已安装" "0"
else
  check "空环境正确返回未找到" "1"
fi

export PATH="${ORIGINAL_PATH}"
rm -rf "${FAKE_HOME}" "${FAKE_HOME_OLD}" "${EMPTY_HOME}"

echo
echo "────────────────────────────────"
echo "通过 ${PASS} 项，失败 ${FAIL} 项"
[[ "${FAIL}" -eq 0 ]] || exit 1
echo "全部通过"
