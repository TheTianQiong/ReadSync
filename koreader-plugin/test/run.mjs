/**
 * KOReader 插件的逻辑测试入口。
 *
 * 用 fengari（JS 里实现的 Lua 虚拟机）加载插件本体，配合 plugin_test.lua 里的
 * KOReader 模块桩，把「每 N 页自动推送」这类纯逻辑真正跑一遍。
 *
 * 为什么需要它：插件平时只能靠人眼读代码 —— 没有真机就没法验证「每读 5 页推
 * 一次」到底是不是每 5 页推一次，也没有自动化能兜住 Lua 的坑（比如
 * `x or 0 == 0` 会被解析成 `x or (0 == 0)`，恒为真）。
 *
 * 用法：npm run test:plugin（在仓库根目录）
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..', 'readsync.koplugin');

let fengari;
try {
  const require = createRequire(import.meta.url);
  fengari = require('fengari');
} catch {
  console.error('缺少依赖 fengari。先安装它再跑：');
  console.error('  npm install --no-save fengari');
  process.exit(1);
}

const { lua, lauxlib, lualib, to_luastring } = fengari;

// 插件必须存在 —— 路径写错时宁可立刻报错，也不要假装「0 项断言全过」
if (!existsSync(path.join(pluginDir, 'main.lua'))) {
  console.error(`找不到插件入口：${path.join(pluginDir, 'main.lua')}`);
  process.exit(1);
}

const L = lauxlib.luaL_newstate();
lualib.luaL_openlibs(L);

// plugin_test.lua 通过全局 ARG 拿插件目录（dofile 的 ... 取不到命令行参数）
lua.lua_pushstring(L, to_luastring(pluginDir));
lua.lua_setglobal(L, to_luastring('ARG'));

const entry = path.join(here, 'plugin_test.lua');
if (lauxlib.luaL_dofile(L, to_luastring(entry)) !== lua.LUA_OK) {
  console.error(lua.lua_tojsstring(L, -1));
  process.exit(1);
}
