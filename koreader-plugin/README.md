# ReadSync 同步插件（KOReader）

把 KOReader 的阅读进度同步到自建的 ReadSync 服务器。

与 KOReader 内置的「进度同步」相比：

| | 内置进度同步（KOSync） | 本插件 |
|---|---|---|
| 认证方式 | `md5(密码)`，主密码的摘要会发给服务器 | 访问令牌 `rs_xxx`，与密码无关 |
| 阅读时长 | 不上报 | 上报，服务端统计图表覆盖 KOReader |
| 出错提示 | 多数情况静默失败 | 明确的中文提示（超时 / 拒连 / 令牌无效 / 服务端已有更新进度） |

---

## 一、先在服务端准备

### 1. 创建访问令牌

任选一种方式：

**网页**：登录 ReadSync → 「设置 → 同步账号」→ 创建令牌，复制形如 `rs_xxxxxxxx` 的字符串（**只显示一次**）。

**命令行**：

```bash
readsync sync-token create -u 你的用户名 -n "KOReader" --scopes sync
```

### 2. 确认服务器地址

插件需要填的是**浏览器能访问到的地址**：

- 配了 HTTPS：`https://read.example.com` 或 `https://read.example.com:8443`
- 只有内网：`http://192.168.1.10:3000`

> KOReader 可以访问纯 HTTP 地址，但**建议配 HTTPS** —— 见仓库的 [HTTPS 配置指南](../docs/https-setup.md)。用 HTTP 时令牌会在网络中明文传输。

---

## 二、安装插件

把整个 `readsync.koplugin` 目录放到 KOReader 的插件目录：

| 设备 | 路径 |
|---|---|
| Kindle / Kobo | `koreader/plugins/` |
| Android | `/sdcard/koreader/plugins/` |
| 桌面版（Linux/macOS/Windows） | `koreader/plugins/` |

```bash
# 电脑上操作（以 Kindle 为例，假设挂载在 /media/Kindle）
cp -r koreader-plugin/readsync.koplugin /media/Kindle/koreader/plugins/
```

或者直接用仓库里的脚本打包：

```bash
bash koreader-plugin/package.sh          # 生成 readsync.koplugin.zip
```

然后重启 KOReader。插件会在「工具」菜单里出现 **ReadSync 同步**。

---

## 三、配置

打开任意一本书 → 菜单 → 工具 → **ReadSync 同步**：

| 项 | 说明 |
|---|---|
| 服务器地址 | 例如 `https://read.example.com` |
| 访问令牌 | 第一步里创建的 `rs_xxx` |
| 设备名称 | 留空则用设备型号，多设备时便于在服务端区分 |
| **测试连接** | 建议先点一次，会依次校验服务器可达性与令牌有效性 |
| 立即推送进度 | 手动推送当前书的进度 |
| 拉取并跳转到远端进度 | 从服务器取回进度并跳转（远端更靠前时才会跳） |
| 关闭书籍时自动推送 | 默认开启 |
| 休眠时自动推送 | 默认开启 |
| 上报阅读时长 | 默认开启，用于服务端统计 |

---

## 四、常见问题

**菜单里没有「ReadSync 同步」**

- 确认目录名严格为 `readsync.koplugin`（含 `.koplugin` 后缀）
- 确认 `main.lua` 与 `_meta.lua` 在**该目录的根下**，而不是多套了一层
- 重启 KOReader；仍不行则查看 `koreader/crash.log`

**「无法连接服务器：connection refused」**

地址或端口不对，或服务没在跑。在服务器上执行 `curl -I http://127.0.0.1:3000/api/system/health` 确认。

**「连接服务器超时」**

- 服务器地址填成了内网 IP，但设备连的是另一个网络；
- 只填了域名没填端口（非标准端口必须写全，如 `:8443`）；
- 服务器防火墙 / 云安全组没放行该端口。

**「服务器可达，但令牌校验失败」**

令牌复制不完整或已被删除。到「设置 → 同步账号」重新创建。

**推送时提示「服务端已有更新的进度，本次未覆盖」**

这是正常的冲突保护：服务器上那条记录比本机更新，插件不会用旧进度覆盖它。想强制覆盖时，先「拉取并跳转到远端进度」。

**拉取后提示「远端进度并不比本机靠前」**

同样是保护逻辑，避免把已经读到后面的人拽回去。

**HTTPS 服务器报连接失败**

KOReader 需要能加载 `ssl.https`。多数正式版本都自带；若你的版本缺少，可先用 HTTP + 反向代理，或升级 KOReader。日志里会打印 `ReadSync: 未能加载 ssl.https` 便于确认。

---

## 五、它是怎么工作的

插件调用服务端的**统一同步接口**（[接口文档](../docs/api-reference.md#四统一同步接口第三方接入)）：

```
PUT  /api/sync/progress             推送进度
GET  /api/sync/progress/{document}  拉取进度
GET  /api/auth/me                   校验令牌（「测试连接」用）
```

- 文档标识优先用 KOReader 生成的 `partial_md5_checksum`，同一本书在不同设备上一致，因此能跨设备对上；取不到时退回文件名 md5。
- 阅读位置用 KOReader 的原生 `xpointer`（或页码），服务端只做字符串存储，不做解释。
- `percentage` 是 0-1 的小数，`readingSeconds` 是本次会话的阅读秒数。

---

## 六、开发与调试

```bash
# 语法检查（需要 lua 或 luac）
luac -p readsync.koplugin/*.lua

# 打包
bash package.sh
```

调试时把 KOReader 的日志级别调到 debug，插件会输出：

```
ReadSync: 插件已加载，服务器 = https://...
```

> **模块命名**：KOReader 会把插件目录加入 `package.path`，所以同目录模块用
> `require("ReadSyncClient")` 引用。注意模块名是**全局的**，因此文件名带了
> `ReadSync` 前缀，避免与其它插件的同名文件（如 `client.lua`）冲突。
