# 读记服务器 ReadSync

**自托管的阅读进度同步与书库管理服务器。** 支持 WebDAV、对象存储、KOSync（KOReader）等多种协议，其余协议可通过插件扩展。

墨水屏风格界面 · 阅读数据可视化 · 多端进度同步 · 完整的 CLI 与插件体系

[![Version](https://img.shields.io/badge/version-0.1.0-1a1a1a)](#版本管理)
[![License](https://img.shields.io/badge/license-MIT-1a1a1a)](#许可证)

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [配置](#配置)
- [命令行工具](#命令行工具)
- [阅读器接入](#阅读器接入)
- [插件开发](#插件开发)
- [架构](#架构)
- [开发](#开发)
- [安全](#安全)
- [文档索引](#文档索引)

---

## 特性

### 同步与书库

- **KOSync 协议兼容** —— KOReader 开箱即用，无需改客户端
- **统一同步接口** —— 标准 REST + Bearer 令牌，方便其他阅读软件接入，附带[完整接口参考](docs/api-reference.md)
- **多存储后端** —— 本地磁盘 / WebDAV（坚果云、Nextcloud）/ S3 兼容对象存储（阿里云 OSS、腾讯云 COS、MinIO、R2）/ 插件自定义
- **书库元数据与版本管理** —— 本地只存 MD5、书目信息与版本记录，书籍文件放在外部网盘；支持秒传去重、版本历史与回滚
- **文件中转** —— S3 走预签名 URL 直连下载，其余后端由服务端中转

### 阅读统计

- 阅读时长趋势（日 / 周 / 月 / 年）
- 平台分布、星期 × 小时热力图
- 阅读状态总览：当前在读、今日 / 本周 / 本月 / 累计时长、连续阅读天数
- 首页组件可自由开关排序，**点击任意图表下钻到会话明细**

### 账号与安全

- 密码 **RSA-OAEP 加密传输**（明文不出浏览器）+ **Argon2id 单向哈希存储**
- 两步验证：TOTP 验证器（含一次性恢复码）+ 通行密钥（WebAuthn / Passkey）
- Refresh token 轮换与重放检测，支持「登出所有设备」与登录设备管理
- 第三方凭据（WebDAV 密码、S3 SecretKey）以 AES-256-GCM 加密落库，接口返回一律脱敏

### 管理后台

站点设置（注册开关、邀请码、上传大小与类型限制、用户配额、页脚）、用户管理（增删 / 角色 / 禁用 / 重置密码）、邀请码、插件管理、审计日志、邮件服务配置（Resend / SMTP）

### 界面

Tailwind CSS v4 编写的**墨水屏风格**：纸白墨黑、细边框、低饱和、衬线正文。支持白天 / 夜晚 / 跟随系统三种模式。

### 部署与运维

Docker 多阶段构建 · 一键 Shell 部署脚本（内置 GitHub 加速）· 完整 CLI · pino 结构化日志 · 版本号同步显示在前端底部与后端启动横幅

---

## 快速开始

### 方式一：一键脚本（Linux 服务器）

```bash
git clone https://github.com/TheTianQiong/ReadSync.git
cd ReadSync
sudo bash deploy/install.sh
```

脚本会自动完成：检测环境 → 检测/安装 Node.js → 安装依赖 → 构建 → 生成 `.env` 与随机主密钥 → 注册 systemd 服务并启动。

**已装好 Node.js 的机器不会重复下载**：脚本除了查 root 的 `PATH`，还会搜索 sudo 调用者的 `nvm` / `fnm` / `volta` 目录（这些位置 root 通常看不到，是「明明装了却重新下载」的常见原因）。仅当找不到、版本低于 v20、或缺少 npm 时才会下载安装。已装但版本过低时会额外安装一份到 `/usr/local`，不会删除原有版本。

```bash
# 需要强制重装 Node.js 时
FORCE_NODE_INSTALL=1 sudo -E bash deploy/install.sh
```

**国内网络**：脚本会自动探测可用的 GitHub 加速节点，并使用 npmmirror 作为 npm 源与原生模块二进制源。也可手动指定：

```bash
GITHUB_PROXY=https://ghfast.top \
NPM_REGISTRY=https://registry.npmmirror.com \
sudo -E bash deploy/install.sh
```

### 方式二：Docker

```bash
# 国内构建加速
NPM_REGISTRY=https://registry.npmmirror.com docker compose build
docker compose up -d
```

带 HTTPS（自动申请证书）：

```bash
READSYNC_DOMAIN=read.example.com docker compose --profile proxy up -d
```

### 方式三：手动部署

```bash
# 需要 Node.js 20.11+
npm ci --ignore-scripts   # 用 ci 而非 install：严格按 lock 文件安装，更可靠
node scripts/check-deps.mjs   # 依赖完整性自检（可选但推荐）
npm run build
cp .env.example .env      # 按需修改
npm start
```

启动后访问 `http://localhost:3000`，首次访问会引导创建管理员账号。

> **为什么用 `npm ci --ignore-scripts`**
>
> - `npm ci` 严格按 `package-lock.json` 安装并校验一致性，`npm install` 则可能改写依赖树。网络中断时 `npm install` 容易留下「半装」的 `node_modules`（目录在但文件缺失），且再跑一次未必修复。
> - `--ignore-scripts` 跳过安装脚本。本项目所有原生模块都自带各平台预编译产物，无需现场编译；反之若允许执行脚本，npm 会因 `better-sqlite3` 带 `binding.gyp` 而调用 node-gyp，在没有编译工具链的机器上直接失败。

### 方式四：配置 HTTPS

服务端很多功能依赖**安全上下文**（HTTPS 或 localhost）—— 浏览器的 WebCrypto 只在安全上下文可用，密码加密、通行密钥都基于它。若你只能用 `http://<IP>:3000` 访问，需要补上 HTTPS。

**有域名**：见 **[HTTPS 配置指南](docs/https-setup.md)**，涵盖

| 情况 | 方案 | 端口 |
|---|---|---|
| 域名已备案 | Caddy 自动 HTTPS（最省心，配置仅数行） | 443 |
| 域名未备案（大陆服务器） | 云厂商免费证书 + Nginx，或 acme.sh DNS 验证 | 8443 等非标准端口 |

> 大陆服务器上 **80/443 要求域名完成 ICP 备案**，未备案会被拦截；其他端口不受限制。而 Let's Encrypt 的自动签发需要 80 或 443 做域名验证 —— 未备案时必须改用 DNS 验证。仓库里已备好可直接用的 [Nginx 配置](deploy/https/nginx-nonstandard-port.conf) 与 [Caddyfile](deploy/https/Caddyfile.standard)。

**没有域名**：用 Cloudflare Tunnel，见下。

#### Cloudflare Tunnel（免费 HTTPS，无需公网 IP 与证书）

```bash
# 1. 安装 cloudflared（Debian/Ubuntu）
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# 2. 登录并创建隧道
cloudflared tunnel login
cloudflared tunnel create readsync

# 3. 指向本地服务（注意用 127.0.0.1，见下方说明）
cloudflared tunnel --url http://127.0.0.1:3000
```

然后在 `.env` 中按隧道域名调整，并**重启服务**：

```bash
READSYNC_BASE_URL=https://read.example.com   # 换成你的隧道域名
READSYNC_TRUST_PROXY=true                    # 让服务采信 X-Forwarded-* 拿到真实客户端 IP
```

> **为什么源站地址建议用 `127.0.0.1` 而不是 `localhost`**
>
> `localhost` 在不少系统上会优先解析到 IPv6 的 `::1`。服务端默认按双栈监听（`::`）已能兼容两种解析；但如果你此前把 `READSYNC_HOST` 设成了 `0.0.0.0`（纯 IPv4）或用了别的反向代理，写 `127.0.0.1` 最省事。
>
> 若隧道报 **502 Bad Gateway**，按顺序排查：
> 1. 源站地址写成 `http://`（不是 `https://`）且端口正确；
> 2. 应用是否在跑：`curl -I http://127.0.0.1:3000/api/system/health`；
> 3. 上面那条 IPv6 问题 —— 改用 `127.0.0.1` 试试；
> 4. `cloudflared` 若跑在 Docker 里，`localhost` 指向的是容器自身，应改用宿主机地址。

### 部署后自检

服务起来之后，建议跑一次验收脚本确认核心链路真的通（只依赖 HTTP，三种部署方式通用）：

```bash
node scripts/verify-deploy.mjs http://localhost:3000
```

它会检查健康接口、前端页面、RSA 公钥、初始化管理员、登录、明文密码是否被正确拒绝、存储、同步、统计与 KOSync 协议，共 17 项。

### 常见问题

**`npm ci` 报 `gyp ERR!` / 需要 python3、make、g++**

安装原生模块时走了源码编译。本项目所有原生依赖都自带预编译产物（better-sqlite3 的 `prebuilds/`、`@node-rs/argon2` 与 esbuild 的平台包），无需编译：

```bash
npm ci --ignore-scripts
```

一键脚本已内置该参数。若确实需要现场编译，再装 `python3 make g++`。

**构建报 `TS2339: Property 'ok' does not exist on type 'Response'`，或启动报 `Cannot find package '.../byte-length/dist/index.js'`**

这两个错误**都不是代码问题**，而是 `node_modules` 安装不完整：类型包（`undici-types`）或传递依赖（`byte-length`，`webdav` 的依赖）文件缺失，导致类型推断退化、运行时找不到模块。

安装被中断（网络超时、中途 Ctrl+C、前一次安装报错）就会这样，而且再跑 `npm install` 未必修复。做一次干净的重新安装即可：

```bash
rm -rf node_modules packages/*/node_modules
npm ci --ignore-scripts
node scripts/check-deps.mjs   # 确认全部依赖就位
npm run build
```

`scripts/check-deps.mjs` 会逐个实际加载关键依赖（含曾出问题的 `byte-length`、`undici-types`），能在构建前就发现这类问题。

**一键脚本提示「部署完成」但访问不了**

现在脚本在服务未就绪时会**明确报错并打印 systemd 状态、日志与排查方向**，不会再打印成功横幅。按输出提示处理即可。

**`ProtectHome` 导致服务起不来（项目放在 /root 或 /home 下）**

systemd 的 `ProtectHome=true` 会让服务看不到 `/home`、`/root`。若把项目 clone 到这些位置（例如用 root 登录后直接 `git clone`），服务会读不到自己的代码。脚本会自动检测并放宽为 `read-only` 并给出提示。

更稳妥的做法是放到 `/opt`：

```bash
sudo mv ~/ReadSync /opt/readsync && cd /opt/readsync && sudo bash deploy/install.sh
```

**用 `http://<服务器IP>:3000` 打开是空白页，F12 里元素很少**

如果 `http://localhost:3000` 正常、换成 IP 就白屏，那是 CSP 的 `upgrade-insecure-requests` 造成的：它会把页面内所有子资源请求强制升级为 HTTPS，而 IP 地址不属于浏览器的「可信来源」（只有 HTTPS 与 localhost 是），于是浏览器去请求 `https://<ip>:3000/assets/*.js` —— 服务端只提供 HTTP，请求失败，JS 不执行，页面就只剩一个空的 `<div id="root">`。

现在该指令只会在 `READSYNC_BASE_URL` 为 `https://` 时下发。请确认：

```bash
grep READSYNC_BASE_URL .env
```

若你是用 HTTP 访问，保持 `http://<实际地址>:3000` 即可。改完 `.env` 需重启服务。

**页面提示「前端尚未构建」**

后端起来了但 `packages/web/dist` 不存在。注意 `npm run build` 是 `build:shared && build:server && build:web` 串行执行，**只要前一步失败，后面的前端构建就不会执行**。请确认 `npm run build` 整体成功，再重启服务。

**能用页面，但一到「创建管理员 / 登录」就失败，提示不支持 WebCrypto**

说明你在用 `http://<IP>:3000` 访问 —— 这不是安全上下文，浏览器不提供 WebCrypto，前端无法加密密码。有三种解决办法，按推荐顺序：

1. **配 HTTPS**（推荐）：有域名见 [HTTPS 配置指南](docs/https-setup.md)，没有域名见 [Cloudflare Tunnel](#cloudflare-tunnel免费-https无需公网-ip-与证书)；
2. **改用 `http://localhost:3000`** 在本机浏览器访问（localhost 属于安全上下文）；
3. **确实只能走 HTTP 时**，在 `.env` 中显式开启明文降级后重启：

```bash
READSYNC_ALLOW_PLAINTEXT_PASSWORD=true
```

   开启后页面上会显示醒目警告，密码将以明文提交。**仅限内网 / VPN 等可信链路**，公网部署请勿使用。

**Cloudflare Tunnel 报 502 Bad Gateway**

见 [Cloudflare Tunnel](#cloudflare-tunnel免费-https无需公网-ip-与证书) 的排查清单。最常见的是源站地址写成 `https://`、端口不对，或 `localhost` 被解析到 IPv6 而源站只监听了 IPv4 —— 后者改用 `http://127.0.0.1:3000` 即可。

**KOReader 报「未知服务器错误」，或 Reeden 等 App 报「连接失败」**

**先跑一条命令定位**——它模拟 KOReader 的登录过程，直接告诉你密码能不能通过：

```bash
readsync user kosync-check <用户名或邮箱> -p <你填进 KOReader 的密码>
```

输出会明确区分「密码能过」/「密码不一致」/「账号没设过同步密码」。若能过但 KOReader 仍失败，就是地址或用户名的问题。

服务端日志里也会记录每次 KOSync 认证失败的原因（`journalctl -u readsync -f | grep KOSync`）。

其余排查点：

1. **服务端是否可达**：`curl -I http://127.0.0.1:3000/api/system/health`。
2. **用户名可以填用户名或邮箱，且忽略大小写**（电子墨水屏键盘容易打错大小写，现已兼容）。
3. **密码填的是「KOSync 同步密码」**：网页端「设置 → 账号安全 → KOSync 同步密码」，或
   ```bash
   readsync user sync-password <用户名>            # 随机生成并显示
   readsync user sync-password <用户名> --status   # 只看是否已设置
   ```
   设置过同步密码后，**主密码不再能用于 KOSync**（这是有意为之，避免主密码摘要外泄）。
4. **Reeden 等 Android 应用报「连接失败」**：Android 默认禁止明文 HTTP 流量，这类应用通常只能用 **HTTPS** 地址。请先按 [HTTPS 配置指南](docs/https-setup.md) 配上证书。

**Reeden 等 App 报「该地址不是 KOReader 同步服务器」**

这是**地址探测失败，与账号密码无关**——同样的账号在 KOReader 上可能完全正常。这类客户端在保存服务器地址前会先探测 `GET /healthcheck`，判定条件是响应体里出现 `"state":"OK"`（与官方 `koreader-sync-server` 自带的探活脚本一致）：

```bash
curl -s http://<你的服务器地址>:3000/healthcheck
# 期望输出：{"state":"OK"}
```

- 没有输出或报连接失败 → 地址/端口/反代的问题，不是账号问题。
- 输出是 `{"ok":false,...}` 或 404 → 服务器版本过旧，升级到含 `/healthcheck` 的版本即可。

**上传书籍失败，提示「上传失败，网络连接中断」**

网页端已改为**分片上传**，每个请求都很小，正常情况下不会再触发反向代理的体积与超时限制。若仍失败：

- 提示「无法连接服务器」→ 链路根本没通，查地址/端口/防火墙。
- 提示「第 N/M 片上传失败」→ 连接是通的，中间被切断了。查代理：Nginx 的 `client_max_body_size`（默认仅 1 MB）、Cloudflare 橙云与 Tunnel 的体积/超时上限。
- 上行特别慢（< 1 Mbps）时可减小分片：`READSYNC_UPLOAD_CHUNK_SIZE=2097152`。

完整排查表见 [HTTPS 配置指南](docs/https-setup.md#七常见问题)。选文件时若已超过本站单文件上限（默认 200 MB），页面会立即提示，不会白传一场。

**改了 `.env` 但不生效**

服务启动时会自动读取工作目录下的 `.env`（已存在的环境变量优先）。注意要在项目根目录启动，且 systemd 方式下修改 `.env` 后需 `systemctl restart readsync`。

### 版本管理

版本号定义在 `packages/shared/src/version.ts`，是唯一来源。它会：

- 显示在前端页面底部
- 打印在后端启动横幅中

发布新版本时只需修改该文件并打 git tag。

---

## 配置

全部配置通过环境变量注入，完整列表见 [.env.example](.env.example)。最常改动的几项：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `READSYNC_PORT` | `3000` | 监听端口 |
| `READSYNC_BASE_URL` | `http://localhost:3000` | **对外访问地址**。影响邮件重置链接与通行密钥的 origin 校验，用域名或反代时务必修改 |
| `READSYNC_DATA_DIR` | `./data` | 数据目录（数据库、密钥、插件、本地存储） |
| `READSYNC_SECRET` | 自动生成 | 主密钥，用于加密第三方凭据。留空则生成到 `data/secret.key` |
| `READSYNC_TRUST_PROXY` | `false` | 部署在反向代理后才设为 `true`，否则可伪造 IP 绕过登录限流 |
| `READSYNC_LOG_LEVEL` | `info` | 日志级别 |

> ⚠️ **备份**：`data/` 目录包含数据库、`secret.key`（凭据加密密钥）与 `keys/private.pem`（密码传输解密密钥）。**三者必须一同备份** —— 丢失 `secret.key` 后已保存的 WebDAV / S3 密码将无法恢复。

---

## 命令行工具

需求要求「前端能操作的功能，后端也应可以通过指令实现」，因此 CLI 覆盖了全部管理能力。

```bash
# 直接用 tsx 运行（开发）
npm run cli -- <命令>

# 或构建后使用
npm run build:server
node packages/server/dist/cli.js <命令>
```

### 常用命令

```bash
# 系统信息
readsync info

# 用户管理
readsync user list
readsync user create alice -e alice@example.com -p 'Passw0rd!' -r admin
readsync user reset-password alice -p 'NewPassw0rd!'
readsync user set-role alice admin
readsync user disable alice
readsync user delete alice --yes

# KOSync 排查：模拟 KOReader 登录，确认密码能否通过
readsync user kosync-check alice -p '你的同步密码'
readsync user sync-password alice --status
readsync user sync-password alice              # 随机生成并显示

# 站点设置
readsync settings show
readsync settings set registrationEnabled false
readsync settings upload-limit --size-mb 500 --extensions epub,pdf,zip,json

# 邀请码
readsync invite create --max-uses 5 --days 30 --note "给朋友"
readsync invite list

# 第三方接入令牌
readsync sync-token create -u alice -n "我的阅读器" --scopes sync
readsync sync-token list

# 插件
readsync plugin list
readsync plugin install ./my-plugin.zip
readsync plugin enable com.example.myplugin

# 书库与审计
readsync book:list -u alice
readsync audit --limit 50 --action user.login

# 运维
readsync keys      # 查看 / 初始化 RSA 密钥对
readsync secret    # 检查主密钥来源（确认备份完整性）
```

所有命令都支持 `--json` 输出，便于脚本处理。

---

## 阅读器接入

### KOReader（KOSync 协议）

在 KOReader 中打开「工具 → 云存储 → 进度同步」，填写：

- **自定义同步服务器**：`http://<你的服务器>:3000`
- **用户名 / 密码**：站点账号

> KOReader 固定发送 `md5(密码)` 作为认证凭据，这是协议限制。建议在「设置 → 账号安全 → **KOSync 同步密码**」里单独设置一个与主密码不同的同步密码，避免主密码的 MD5 泄露后被撞库；忘记时可在同一处随机重置。详见 [security.md](docs/security.md#二kosync-协议的同步密码)。

#### 可选：用专用插件（推荐）

内置同步在出错时提示很含糊（例如「未知服务器错误」）。仓库提供了 [KOReader 插件](koreader-plugin/README.md)：用访问令牌认证、上报阅读时长、给出具体的中文错误原因。

```bash
readsync sync-token create -u 你的用户名 -n "KOReader"   # 创建访问令牌
bash koreader-plugin/package.sh                          # 打包插件
```

### 其他阅读软件（统一同步接口）

1. 在「设置 → 同步账号」创建接入令牌，或用 CLI：`readsync sync-token create -u <用户名> -n <设备名>`
2. 按 [接口参考](docs/api-reference.md#四统一同步接口第三方接入) 调用：

```bash
curl -X PUT https://your-server/api/sync/progress \
  -H "Authorization: Bearer rs_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "document": "books/42/abc123.epub",
    "progress": "epubcfi(/6/14!/4/2/2/1:0)",
    "percentage": 0.4275,
    "platform": "myreader",
    "readingSeconds": 300
  }'
```

`percentage` 是 **0-1 的小数**；`readingSeconds` 会被累加进阅读统计。

---

## 插件开发

插件是一个 zip 包，根目录含 `plugin.json` 清单与入口 JS：

```
my-plugin.zip
├── plugin.json
└── index.js
```

```js
// index.js
export function register(ctx) {
  ctx.log.info('插件已加载');
  const config = ctx.getConfig();

  ctx.on('onBookUpload', ({ bookId, md5 }) => {
    ctx.log.info(`新书上传：${bookId} (${md5})`);
  });

  // 也可以注册自定义存储驱动或同步协议
  // ctx.registerStorageDriver('my-cloud', { create(config) { /* ... */ } });
}
```

```bash
readsync plugin install ./my-plugin.zip
readsync plugin enable com.example.myplugin
```

完整的清单字段、权限模型、钩子列表与调试技巧见 **[插件开发指南](docs/plugin-development.md)**。示例插件见 `packages/server/plugins-samples/demo-plugin/`。

> 插件运行在服务端进程内。权限声明（`http`、`fs:data` 等）会真实影响注入的能力，但它**不是沙箱** —— 只安装你信任的插件。

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器（React 19 + Tailwind v4 墨水屏主题）                  │
│  首页 · 阅读状态 · 个人书库 · 设置 · 管理后台                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ /api/*  （统一响应信封 + Bearer 认证）
┌───────────────────────────┴─────────────────────────────────┐
│  Fastify 服务端                                              │
│                                                              │
│  auth     登录 / 注册 / 2FA / 通行密钥 / 令牌轮换             │
│  users    个人资料 / 偏好 / 阅读平台 / 登录设备               │
│  storage  存储驱动：local · webdav · s3 · plugin             │
│  library  书库 · 秒传 · 版本历史 · 文件中转                   │
│  sync     统一同步接口 + KOSync 兼容层                        │
│  stats    阅读统计聚合与下钻                                  │
│  plugins  插件加载器 / 权限模型 / 钩子                        │
│  admin    站点设置 / 用户 / 邀请码 / 审计 / 邮件              │
│                                                              │
│  middleware/auth · crypto（RSA / Argon2 / AES-GCM）          │
│  db（Drizzle + SQLite WAL）· lib（settings/mail/audit/jwt）   │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   SQLite (WAL)      本地磁盘 / 插件目录    WebDAV · S3 对象存储
```

### 目录结构

```
ReadSync/
├── packages/
│   ├── shared/          # 前后端共享：类型、zod schema、枚举常量、版本号
│   ├── server/          # Fastify 后端 + CLI
│   │   ├── src/
│   │   │   ├── modules/ # 业务模块（auth/users/storage/library/sync/stats/plugins/admin/system）
│   │   │   ├── crypto/  # RSA 密钥、Argon2 密码、AES-GCM 凭据加密
│   │   │   ├── db/      # Drizzle schema 与迁移
│   │   │   ├── lib/     # settings / mail / jwt / audit / users
│   │   │   └── scripts/ # 冒烟测试
│   │   ├── drizzle/     # 迁移 SQL（提交进仓库）
│   │   └── plugins-samples/
│   └── web/             # React 前端
├── deploy/              # Dockerfile / docker-compose / install.sh / Caddyfile
├── docs/                # API 参考、插件指南、安全说明、原始需求
└── data/                # 运行时数据（git 忽略）
```

### 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Fastify 5 + TypeScript | 性能好、schema 校验内建、生态成熟 |
| 数据库 | SQLite（better-sqlite3 + Drizzle） | 自托管场景零配置、单文件易备份；Drizzle 提供类型安全与迁移 |
| 前端 | React 19 + Vite 8 + Tailwind v4 | 单一 TS 工具链，可与后端共享类型 |
| 图表 | Recharts 3 | 声明式、易定制成墨水屏配色 |
| 密码 | Argon2id（@node-rs/argon2） | 当前密码哈希推荐算法；napi 预编译包在国内可直连 npm 安装 |
| 令牌 | jose (JWT) + 数据库哈希 refresh token | 无状态校验 + 可即时吊销 |

---

## 开发

```bash
npm install

# 同时启动后端（:3000）与前端（:5173，/api 自动代理到后端）
npm run dev

# 分别启动
npm run dev:server
npm run dev:web

# 类型检查 / 构建
npm run typecheck
npm run build

# 数据库迁移（修改 schema 后）
npm run db:generate --workspace @readsync/server
```

### 冒烟测试

```bash
cd packages/server

# 加密与数据库基础自检
READSYNC_DATA_DIR=./data-smoke npx tsx src/scripts/smoke-crypto.ts
READSYNC_DATA_DIR=./data-smoke npx tsx src/scripts/smoke-db.ts

# 端到端集成测试（102 项断言：认证 / 2FA / 恢复码 / 上传 / 分片上传 / 同步 / 统计 / KOSync / 权限隔离）
READSYNC_DATA_DIR=./data-e2e npx tsx src/scripts/smoke-e2e.ts

# 真实 socket 的大文件整体上传（冒烟测试走进程内 inject，照不出传输层问题）
READSYNC_DATA_DIR=./data-repro npx tsx src/scripts/repro-upload.ts 64

# 验证服务端会等完整请求体（file 字段在前、文本字段在后的真实顺序）
READSYNC_DATA_DIR=./data-repro npx tsx src/scripts/repro-socket.ts 8 2

# 在「限制请求体大小的代理」后面，对比整体上传与分片上传（分片能穿过，整体被挡）
READSYNC_DATA_DIR=./data-repro npx tsx src/scripts/repro-proxy-limit.ts 16 8
```

端到端测试使用独立的 `data-e2e` 目录，并带有路径护栏，不会误伤生产数据。

排查「上传失败」类问题时，`repro-upload.ts` 是关键工具：它真的监听端口、真的发 HTTP，能区分失败发生在服务端还是链路中间 —— 而 `smoke-e2e.ts` 用的是 `app.inject()`，进程内直调，永远看不到网络层的失败。

### 模块开发约定

新增后端模块前请阅读 [`packages/server/src/modules/CONVENTIONS.md`](packages/server/src/modules/CONVENTIONS.md)，其中规定了路由注册方式、错误处理、参数校验、鉴权、审计与敏感字段处理的统一写法。

---

## 安全

核心设计：

- **密码**：RSA-OAEP(SHA-256) 加密传输 → Argon2id 单向哈希存储。明文密码既不落网络日志也不落库
- **第三方凭据**：AES-256-GCM 加密存储，主密钥来自 `READSYNC_SECRET` 或 `data/secret.key`
- **令牌**：access token 为短效 JWT；refresh token 只存哈希，每次刷新轮换，检测到重放即吊销整个令牌家族
- **上传**：路径穿越防护（key 校验 + resolve 后二次确认）、扩展名白名单、大小与配额限制、流式处理不占内存
- **插件**：Zip Slip 防护、解压体积与文件数限制、权限声明模型

**部署检查清单**与完整的威胁分析见 **[docs/security.md](docs/security.md)**。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/api-reference.md](docs/api-reference.md) | 完整 API 参考，含统一同步接口与 KOSync 协议细节 |
| [docs/plugin-development.md](docs/plugin-development.md) | 插件清单、上下文 API、钩子、存储驱动与同步协议扩展 |
| [koreader-plugin/README.md](koreader-plugin/README.md) | KOReader 同步插件：安装、配置、故障排查 |
| [docs/https-setup.md](docs/https-setup.md) | 自有域名配置 HTTPS：备案判断、Caddy / Nginx / acme.sh 三种方案 |
| [docs/security.md](docs/security.md) | 安全设计与权衡、部署检查清单 |
| [docs/requirements.md](docs/requirements.md) | 原始需求文档与实现对照表（含已知差异） |
| [packages/server/src/modules/CONVENTIONS.md](packages/server/src/modules/CONVENTIONS.md) | 后端模块开发约定 |

---

## 许可证

MIT
