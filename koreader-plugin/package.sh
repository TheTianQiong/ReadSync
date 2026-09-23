#!/usr/bin/env bash
#
# 打包 KOReader 插件为可直接解压使用的 zip。
#
# 用法：bash koreader-plugin/package.sh
# 产物：koreader-plugin/readsync.koplugin.zip
#
# 解压到设备的 koreader/plugins/ 下即可（zip 内已含 readsync.koplugin 顶层目录）。

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="readsync.koplugin"
OUT="${SCRIPT_DIR}/${PLUGIN_NAME}.zip"

cd "${SCRIPT_DIR}"

[[ -d "${PLUGIN_NAME}" ]] || { echo "找不到 ${PLUGIN_NAME} 目录"; exit 1; }

# 如果本机有 Lua，先做一次语法检查再打包，避免把坏掉的插件推给用户
if command -v luac >/dev/null 2>&1; then
	echo "语法检查："
	for f in "${PLUGIN_NAME}"/*.lua; do
		printf '  %-24s' "$(basename "$f")"
		if luac -p "$f"; then echo "OK"; else echo "失败"; exit 1; fi
	done
else
	echo "提示：未找到 luac，跳过语法检查"
fi

rm -f "${OUT}"

# 优先用 zip；Windows 上通常没有，退回到 PowerShell 的 Compress-Archive。
# 两者产出的 zip 都能被 KOReader 所在平台正常解压。
# 校验产物确实是 zip（前两个字节为 "PK"）。
# 必须有这一步：GNU tar 的 -a 并不支持 zip（那是 bsdtar 的特性），
# 它会静默产出普通 tar —— 文件名看着像 zip，拷到设备上却解不开。
is_zip() {
	[ -f "$1" ] && [ "$(head -c 2 "$1" 2>/dev/null)" = "PK" ]
}

if command -v zip >/dev/null 2>&1; then
	# -X 不额外保存属性，保证各平台解压结果一致
	zip -r -X "${OUT}" "${PLUGIN_NAME}" -x '*.DS_Store' >/dev/null
fi

# zip 不可用或产出的不是 zip 时，退回 tar.gz —— 它是真正的压缩包，
# 不会给出「名为 zip 实为 tar」的误导性文件。
if ! is_zip "${OUT}"; then
	rm -f "${OUT}"
	OUT="${SCRIPT_DIR}/${PLUGIN_NAME}.tar.gz"
	rm -f "${OUT}"
	tar -czf "${OUT}" "${PLUGIN_NAME}"
	echo "未找到可用的 zip 命令，已改为生成 tar.gz"
	echo "（KOReader 设备通常需要 zip，可在电脑上执行："
	echo "  cd $(basename "${SCRIPT_DIR}") && zip -r ${PLUGIN_NAME}.zip ${PLUGIN_NAME} ）"
fi

echo ""
echo "已生成：${OUT}（$(wc -c < "${OUT}") 字节）"
echo ""
if is_zip "${OUT}"; then
	echo "安装：解压到 KOReader 的 plugins 目录，例如"
	echo "  unzip $(basename "${OUT}") -d /media/Kindle/koreader/plugins/"
else
	echo "安装：解压到 KOReader 的 plugins 目录，例如"
	echo "  tar xzf $(basename "${OUT}") -C /media/Kindle/koreader/plugins/"
fi
