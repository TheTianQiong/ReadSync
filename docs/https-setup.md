# HTTPS 配置指南（自有域名）

ReadSync 的部分功能**依赖安全上下文**（HTTPS 或 localhost）—— 浏览器的 WebCrypto 只在安全上下文可用，密码加密与通行密钥都基于它。本文介绍如何用自有域名配上 HTTPS，不使用 Cloudflare Tunnel。

---

## 一、先判断你属于哪种情况

大陆服务器上，**80 与 443 端口要求域名已完成 ICP 备案**，未备案的域名在这两个端口会被拦截；**其他端口（如 8443）未备案也可正常使用**。

这直接决定了能否用 Let's Encrypt 的自动签发 —— 它的域名验证需要 80（HTTP-01）或 443（TLS-ALPN-01）：

| 你的情况 | 可选方案 | 端口 |
|---|---|---|
| 域名**已备案** | Caddy 自动 HTTPS / certbot | 443（标准） |
| 域名**未备案**（大陆服务器） | ① 云厂商免费证书 ② acme.sh DNS 验证 | 8443 等非标准端口 |
| 服务器在**境外** | 同「已备案」，不受此限制 | 443（标准） |

> 不确定域名是否已备案：在服务器上执行 `curl -I http://你的域名` —— 若返回阿里云/运营商的拦截页面而非你的服务，就是未备案。

无论哪种情况，都需要先把域名解析到服务器 IP（A 记录）。

---

## 二、方案 A：域名已备案 —— Caddy 自动 HTTPS（最省心）

Caddy 会自动申请并续期证书，配置只有几行。

```bash
# 安装 Caddy（Debian/Ubuntu）
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# 使用仓库里的示例配置
sudo cp deploy/https/Caddyfile.standard /etc/caddy/Caddyfile
sudo sed -i 's/read.example.com/你的域名/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

配置内容（见 `deploy/https/Caddyfile.standard`）：

```caddyfile
read.example.com {
	encode zstd gzip
	request_body { max_size 2GB }
	reverse_proxy 127.0.0.1:3000 {
		header_up X-Real-IP {remote_host}
		flush_interval -1
	}
}
```

Caddy 会自动完成证书申请、续期与 HTTP→HTTPS 跳转。

---

## 三、方案 B：域名未备案 —— 云厂商免费证书 + 非标准端口

未备案时 80/443 被拦截，但**申请证书本身不需要备案**（用 DNS 验证即可），只要把服务跑在非标准端口上。

### 1. 申请证书（以阿里云为例）

1. 控制台 → **SSL 证书** → 免费证书 → 创建证书
2. 填写域名，验证方式选 **DNS 验证**（不需要 80/443）
3. 按提示添加 DNS 解析记录，等待签发（通常几分钟）
4. 下载 **Nginx 格式**，得到 `域名.pem` 与 `域名.key`

> 免费证书为单域名 DV 证书，不支持通配符；一个账号通常可签发 20 张。

### 2. 上传证书并配置 Nginx

```bash
sudo mkdir -p /etc/nginx/ssl
# 把下载的两个文件上传到该目录
sudo chmod 600 /etc/nginx/ssl/*.key

sudo cp deploy/https/nginx-nonstandard-port.conf /etc/nginx/conf.d/readsync.conf
sudo sed -i 's/read.example.com/你的域名/g' /etc/nginx/conf.d/readsync.conf
sudo nginx -t && sudo systemctl reload nginx
```

配置要点（完整见 `deploy/https/nginx-nonstandard-port.conf`）：

- 监听 **8443** 而非 443（非标准端口不受未备案拦截）
- 证书链要完整（用下载包里的 `.pem`，它已含中间证书）
- `client_max_body_size 2g` —— 书籍文件可能很大
- `proxy_request_buffering off` —— 上传大文件时不要缓冲到磁盘
- 传递 `X-Forwarded-For` / `X-Forwarded-Proto`

### 3. 放行端口

阿里云控制台 → 安全组 → 放行 **8443**（以及你要用的其它端口）。

---

## 四、方案 C：acme.sh + DNS 验证（未备案，但想要自动续期）

不想每 90 天手动换证书的话，用 acme.sh 的 DNS 验证 —— 它同样不需要 80/443。

```bash
# 安装（国内可用 gitee 镜像）
curl https://get.acme.sh | sh -s email=你的邮箱@example.com

# 阿里云 DNS：先在控制台创建 RAM 子账号并授予 AliyunDNSFullAccess，
# 拿到 AccessKey 后导出为环境变量
export Ali_Key="你的AccessKeyId"
export Ali_Secret="你的AccessKeySecret"

# 签发（DNS 验证，无需开放 80/443）
~/.acme.sh/acme.sh --issue --dns dns_ali -d read.example.com

# 安装证书到 Nginx 目录，并设置续期后自动 reload
~/.acme.sh/acme.sh --install-cert -d read.example.com \
  --key-file       /etc/nginx/ssl/read.example.com.key \
  --fullchain-file /etc/nginx/ssl/read.example.com.pem \
  --reloadcmd      "systemctl reload nginx"
```

acme.sh 会自动创建定时任务续期，之后无需人工干预。

> 其他 DNS 服务商把 `dns_ali` 换成对应的（`dns_dp` 腾讯、`dns_cf` Cloudflare 等）。首次签发后建议执行 `acme.sh --upgrade --auto-upgrade` 以自动升级脚本。

---

## 五、配置 ReadSync

无论用哪种方案，**这几项必须改对**，否则会出现「页面能开但登录/通行密钥异常」：

```bash
# .env
READSYNC_BASE_URL=https://read.example.com:8443   # 必须与浏览器地址栏完全一致
READSYNC_TRUST_PROXY=true                         # 位于反向代理之后，采信 X-Forwarded-*
```

改完重启服务：`sudo systemctl restart readsync`（手动部署则重启 `npm start`）。

> **`READSYNC_BASE_URL` 为什么必须精确**
>
> 通行密钥（WebAuthn）会校验页面的 origin 是否与预期的 RP ID / origin 一致。若 BASE_URL 写成 `https://read.example.com` 而实际访问的是 `https://read.example.com:8443`，通行密钥注册与登录都会失败（浏览器报 origin 不匹配）。端口、协议、域名三者都要对上。

同时，服务端检测到 BASE_URL 为 `https://` 时会自动下发 `Strict-Transport-Security` 与 CSP 的 `upgrade-insecure-requests`；用 HTTP 时则不会下发（否则会把页面资源请求升级到不存在的 TLS 端口，导致白屏）。

---

## 六、验证

```bash
# 1. 证书是否生效、是否含完整证书链
curl -vI https://read.example.com:8443 2>&1 | grep -E "subject:|issuer:|SSL certificate verify"

# 2. 安全响应头（HTTPS 下应出现这两条）
curl -sI https://read.example.com:8443/ | grep -iE "strict-transport|upgrade-insecure"

# 3. 站点功能验收（17 项）
node scripts/verify-deploy.mjs https://read.example.com:8443
```

浏览器打开后，地址栏应显示锁标志；进入「设置 → 账号安全」可以正常开启通行密钥。

---

## 七、常见问题

**浏览器提示「您的连接不是私密连接」**

证书链不完整。Nginx 的 `ssl_certificate` 要指向**包含中间证书的 fullchain**（云厂商下载包里的 `.pem` 通常是完整的），而不是只有服务器证书的那个文件。

**页面能打开，但登录按钮点了没反应**

`READSYNC_BASE_URL` 与实际访问地址不一致，或漏了 `READSYNC_TRUST_PROXY=true`。检查浏览器 F12 的 Network 面板，看 `/api/auth/login` 的状态码与响应。

**通行密钥注册失败**

同上：WebAuthn 严格要求 origin 一致。`READSYNC_BASE_URL` 必须写成浏览器地址栏里那一串（含端口）。

**80/443 上的服务被拦截，页面显示运营商提示**

域名未备案。改用非标准端口（方案 B / C），或完成 ICP 备案。

**上传书籍传到一半失败，提示「上传失败，网络连接中断」**

这是**反向代理掐断了连接**，不是 ReadSync 的问题 —— 服务端遇到超限会明确返回 413，不会无声断连。按代理类型排查：

| 代理 | 限制 | 处理 |
|---|---|---|
| Nginx | `client_max_body_size` **默认仅 1 MB** | 在 `server` 或 `location` 块设 `client_max_body_size 2g;`，然后 `nginx -t && systemctl reload nginx` |
| Caddy | 无默认体积限制 | 一般无需处理 |
| Cloudflare（**橙云**代理） | 请求体与请求时长都有上限，且**免费版调不了** | 只能绕开，见下 |
| **Cloudflare Tunnel** | 同橙云，**且无法用灰云绕开** | 见下 |

判断方法：上传失败时前端会显示**中断在百分之几**。

- 显示「无法连接服务器」（0%）→ 链路根本没通，查地址/端口/防火墙。
- 显示「上传在 xx% 处中断」→ 连接是通的，是中途被切的，按上表查代理。

#### Cloudflare Tunnel 为什么不能靠灰云绕过

Cloudflare 官方对长耗时请求的建议是「移到**未代理的子域（DNS-only，灰云）**」。但这条**对 Tunnel 不适用**：

Tunnel 的 DNS 记录是一条 CNAME，指向 `<UUID>.cfargotunnel.com`。官方文档明确写着，这个子域**只为同一 Cloudflare 账号内的记录做代理**——它不是一个可从公网直接回源的地址，本质上就是 Cloudflare 边缘的入口。把这条记录改成灰云，等于让浏览器直接去连 `cfargotunnel.com`，隧道随即失效（报 1016 或解析失败）。

也就是说：**灰云 = 完全不经过 Cloudflare，那时 Tunnel 本身就多余了**。二者不能共存。

#### 可行的两条路

**路线一：上传走一条不经过 Cloudflare 的通道（改动最小）**

用一条灰云 A 记录直接指向服务器公网 IP，配上自有证书并监听非标准端口（本指南的方案 B / C）。这条通道不经 Cloudflare 边缘，因此没有请求体与超时限制。

代价是要自己维护证书（acme.sh 可自动续期），且非标准端口需要在云厂商安全组放行。

**路线二：改成分片上传（保留 Tunnel）**

前端把文件切成若干小块逐个上传，服务端按序落盘后合并。每个请求都很小、很快，天然躲开请求体上限与超时限制。

> 当前版本用的是整体上传，尚未支持分片。如果你必须在 Cloudflare Tunnel 后面传大文件，请提 issue。

#### 先确认是不是代理的问题

```bash
# 在服务器本机上直接打后端，绕过一切代理：应当能正常上传
curl -X POST http://127.0.0.1:3000/api/books/upload \
  -H "Authorization: Bearer <令牌>" -F "file=@一本大书.epub" -F "title=测试"
```

直连正常、走域名失败 → 确定是代理那一层；两边都失败 → 问题在服务端或存储配置（看 `journalctl -u readsync -f`）。

另外，**选文件时若已超过本站单文件上限，前端会立即提示**（上限由「站点管理 → 站点设置 → 上传 → 单文件上限」控制，默认 200 MB），不会再让你白传一场。
