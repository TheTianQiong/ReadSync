# ReadSync API 参考

本文档面向两类读者：

- **前端 / CLI 开发者**：了解站点自身接口的约定。
- **第三方阅读软件开发者**：只需要看 [统一同步接口](#四统一同步接口第三方接入) 与 [KOSync 兼容协议](#五kosync-兼容协议koreader) 两节，即可把阅读进度接入本服务器。

---

## 一、通用约定

### 1.1 响应信封

除 KOSync 兼容端点外，所有 `/api/*` 接口都返回统一信封：

```jsonc
// 成功
{ "ok": true, "data": { /* ... */ } }

// 失败
{
  "ok": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "请求参数校验失败",
    "details": [ /* 可选，字段级错误 */ ]
  }
}
```

### 1.2 错误码

| code | HTTP | 含义 |
|---|---|---|
| `BAD_REQUEST` | 400 | 请求不合法 |
| `VALIDATION_FAILED` | 400 | 参数校验失败，`details` 含字段级信息 |
| `UNAUTHORIZED` | 401 | 未登录或登录已过期 |
| `FORBIDDEN` | 403 | 已登录但无权限 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 冲突（重名、秒传命中、版本冲突） |
| `PAYLOAD_TOO_LARGE` | 413 | 上传超过站点限制 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 文件类型不在白名单 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `STORAGE_ERROR` | 500 | 存储后端操作失败 |
| `PLUGIN_ERROR` | 500 | 插件执行失败 |
| `INTERNAL_ERROR` | 500 | 服务端内部错误 |

### 1.3 认证

两种方式，都通过 `Authorization` 头传递：

```
Authorization: Bearer <access_token>     # 浏览器登录态（JWT）
Authorization: Bearer rs_xxxxxxxxxxxx    # 第三方接入令牌（前缀 rs_）
```

也接受 `X-Auth-Token: <token>`（部分阅读器不便设置标准头时使用）。

### 1.4 密码传输

**明文密码永不出浏览器。** 流程：

1. `GET /api/system/public-key` 取服务端 RSA 公钥；
2. 前端用 WebCrypto 以 `RSA-OAEP` + `SHA-256` 加密密码，得到 ciphertext；
3. 请求体里传 `{ "ciphertext": "<base64>", "encrypted": true }`。

服务端用本地私钥解密后，立即以 Argon2id 单向哈希入库。详见 [security.md](./security.md)。

### 1.5 分页

请求：`?page=1&pageSize=20`（`pageSize` 上限 100）

响应：

```jsonc
{
  "ok": true,
  "data": {
    "items": [],
    "total": 0,
    "page": 1,
    "pageSize": 20,
    "totalPages": 0
  }
}
```

---

## 二、系统接口

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/system/health` | 否 | 健康检查，供 Docker healthcheck 使用 |
| GET | `/api/system/version` | 否 | 版本号（前端底部展示） |
| GET | `/api/system/public-key` | 否 | RSA 公钥（加密密码用） |
| GET | `/api/system/settings` | 否 | 公开设置：站点名、是否开放注册、是否需邀请码、默认主题、版本号 |
| GET | `/api/system/bootstrap` | 否 | 站点是否已初始化（是否已有管理员） |
| POST | `/api/system/bootstrap` | 否 | **仅在无管理员时可用**，创建初始管理员 |
| GET | `/api/system/info` | 管理员 | 版本、运行时、各表数据量、公钥指纹 |
| GET | `/api/system/ping` | 是 | 验证登录态是否有效 |

---

## 三、站点接口

### 3.1 认证 `/api/auth`

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| POST | `/api/auth/register` | 否 | 注册（受站点注册开关与邀请码设置约束） |
| POST | `/api/auth/login` | 否 | 登录，限流 10 次/分钟；账号开启 2FA 时需带 `totpCode` |
| POST | `/api/auth/refresh` | 否 | 刷新令牌（自动轮换；检测到重放会吊销整个令牌家族） |
| POST | `/api/auth/logout` | 是 | 退出当前会话 |
| POST | `/api/auth/logout-all` | 是 | 退出所有设备 |
| GET | `/api/auth/me` | 是 | 当前登录用户 |
| POST | `/api/auth/change-password` | 是 | 修改密码（踢掉其它设备并邮件通知） |
| POST | `/api/auth/forgot-password` | 否 | 发送重置验证码（无论邮箱是否存在都返回相同文案） |
| POST | `/api/auth/reset-password` | 否 | 用验证码重置密码 |
| POST | `/api/auth/2fa/setup` | 是 | 生成 TOTP 密钥与 otpauth URI |
| POST | `/api/auth/2fa/enable` | 是 | 校验验证码后开启，返回一次性恢复码 |
| POST | `/api/auth/2fa/disable` | 是 | 关闭 2FA（需验证码 + 密码） |
| GET | `/api/auth/passkeys` | 是 | 列出通行密钥 |
| POST | `/api/auth/passkeys/register/options` | 是 | 通行密钥注册 challenge |
| POST | `/api/auth/passkeys/register/verify` | 是 | 完成注册 |
| POST | `/api/auth/passkeys/login/options` | 否 | 通行密钥登录 challenge |
| POST | `/api/auth/passkeys/login/verify` | 否 | 完成登录 |
| DELETE | `/api/auth/passkeys/:id` | 是 | 删除通行密钥 |

### 3.2 个人设置 `/api/users`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / PATCH | `/api/users/me` | 读取 / 更新个人资料 |
| GET / PATCH | `/api/users/me/preferences` | 主题、首页组件布局、分页大小、时区 |
| GET / POST | `/api/users/me/platforms` | 列出 / 新增阅读平台 |
| DELETE | `/api/users/me/platforms/:platformId` | 删除自定义平台（内置平台不可删） |
| GET | `/api/users/me/sessions` | 登录设备列表 |
| DELETE | `/api/users/me/sessions/:id` | 撤销指定设备 |
| POST | `/api/users/me/avatar` | 上传头像 |
| GET | `/api/users/avatar/:userId` | 读取头像（无需登录） |

### 3.3 存储管理 `/api/storages`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/storages` | 列出存储配置（凭据脱敏） |
| POST | `/api/storages` | 新增（local / webdav / s3 / plugin） |
| GET / PATCH / DELETE | `/api/storages/:id` | 详情 / 更新 / 删除 |
| POST | `/api/storages/:id/test` | 连通性测试 |
| GET | `/api/storages/:id/browse` | 浏览目录（一次一层，见下） |
| POST | `/api/storages/:id/mkdir` | 新建目录 |

#### 浏览目录

```
GET /api/storages/:id/browse?prefix=books/1/
```

`prefix` 省略或为空表示根目录。返回**一层**条目，目录在前、文件在后，各自按名称排序：

```json
{
  "ok": true,
  "data": {
    "prefix": "books/1/",
    "entries": [
      { "name": "ab", "path": "books/1/ab/", "isDir": true,  "size": null,   "lastModified": null },
      { "name": "d41d8cd9.epub", "path": "books/1/d41d8cd9.epub", "isDir": false, "size": 1048576, "lastModified": "2026-09-23T11:20:31.206Z" }
    ],
    "truncated": false
  }
}
```

- `path` 是完整 key；**目录以 `/` 结尾，可直接作为下次请求的 `prefix`**。
- 底层适配器的 `list()` 返回的是扁平对象列表（S3 风格，只有文件、没有目录概念）。把 key 前缀收敛成目录条目这件事在服务端完成，调用方不必自己从 key 反推目录结构。
- `truncated` 为 true 表示条目被截断（目录很大时只返回前 `limit` 条，默认 100）。

### 3.4 个人书库 `/api/books`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/books` | 列表，支持搜索/过滤/排序 |
| POST | `/api/books` | 登记书籍元数据 |
| GET / PATCH / DELETE | `/api/books/:id` | 详情（含版本历史）/ 更新 / 删除 |
| POST | `/api/books/check` | **秒传**：按 MD5 检查是否已存在 |
| POST | `/api/books/upload` | 上传（multipart，边传边算 MD5） |
| GET | `/api/books/:id/download` | 下载（S3 直连预签名 URL，其余走服务端中转） |
| GET / POST | `/api/books/:id/versions` | 版本历史 / 上传新版本 |
| POST | `/api/books/:id/versions/:versionId/restore` | 回滚到历史版本 |

### 3.5 统计 `/api/stats`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/stats/trend` | 阅读时长趋势（day/week/month/year） |
| GET | `/api/stats/platforms` | 平台分布 |
| GET | `/api/stats/heatmap` | 星期 × 小时热力图 |
| GET | `/api/stats/library` | 书库概览 |
| GET | `/api/stats/status` | 阅读状态卡片（含连续阅读天数） |
| GET | `/api/stats/dashboard` | 首页聚合数据 |
| GET | `/api/stats/sessions` | **图表下钻**：阅读会话明细 |
| GET / PUT | `/api/stats/preferences` | 首页组件布局 |

### 3.6 插件 `/api/plugins`

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/plugins` | 登录 | 已安装插件列表 |
| POST | `/api/plugins/install` | 管理员 | 上传 zip 安装 |
| DELETE | `/api/plugins/:id` | 管理员 | 卸载 |
| POST | `/api/plugins/:id/enable` / `disable` | 管理员 | 启用 / 停用 |
| GET / PATCH | `/api/plugins/:id/config` | 管理员 | 读取 / 更新配置 |
| GET | `/api/plugins/:id/data` | 管理员 | 插件键值数据 |

插件若声明了同步协议，其路由挂载在 `/api/plugins/{pluginId}{mountPath}`。

### 3.7 管理后台 `/api/admin`

全部需要管理员权限。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / PATCH | `/api/admin/settings` | 站点设置（上传大小/类型限制、注册开关、邀请码开关等） |
| GET / PUT | `/api/admin/mail` | 邮件服务配置（Resend / SMTP） |
| POST | `/api/admin/mail/test` | 发送测试邮件 |
| GET / POST | `/api/admin/users` | 用户列表 / 创建用户 |
| GET / PATCH / DELETE | `/api/admin/users/:id` | 用户详情 / 更新 / 删除 |
| POST | `/api/admin/users/:id/reset-password` | 重置密码 |
| GET / POST | `/api/admin/invites` | 邀请码列表 / 创建 |
| DELETE | `/api/admin/invites/:id` | 删除邀请码 |
| GET | `/api/admin/audit` | 审计日志 |
| GET | `/api/admin/system` | 系统信息（含数据目录占用） |

---

## 四、统一同步接口（第三方接入）

这是为「方便其他阅读软件开发者接入自己软件」而设计的接口。相比 KOSync，它使用标准信封与 Bearer 令牌认证，并支持上报阅读时长以便统计。

### 4.1 获取接入令牌

用户在「设置 → 同步账号」页面创建令牌，或在服务端用 CLI：

```bash
readsync sync-token create --user alice --name "MyReader" --scopes sync
```

令牌形如 `rs_xxxxxxxx`，**仅在创建时显示一次**。

### 4.2 推送进度

```http
PUT /api/sync/progress
Authorization: Bearer rs_xxxxxxxx
Content-Type: application/json

{
  "document": "books/42/abc123.epub",
  "title": "示例书籍",
  "progress": "epubcfi(/6/14!/4/2/2/1:0)",
  "percentage": 0.4275,
  "platform": "koreader",
  "device": "Kindle Paperwhite",
  "deviceId": "abcd-1234",
  "readingSeconds": 300,
  "clientTime": "2026-09-18T12:00:00.000Z"
}
```

响应：

```jsonc
{
  "ok": true,
  "data": {
    "accepted": true,
    "current": { /* 服务端当前条目 */ }
  }
}
```

`accepted=false` 表示服务端已有更新的进度（默认 `latest-wins` 策略），此时 `current` 是服务端版本，客户端可据此决定是否覆盖。

### 4.3 拉取进度

```http
GET /api/sync/progress/{document}
Authorization: Bearer rs_xxxxxxxx
```

### 4.4 批量补传

离线阅读后一次补传多条：

```http
POST /api/sync/batch
Authorization: Bearer rs_xxxxxxxx

{ "entries": [ /* 最多 200 条，字段同 4.2 */ ] }
```

### 4.5 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `document` | 是 | 文档唯一标识。**同一本书在不同设备上必须一致**，建议用书籍文件路径或文件 MD5 |
| `progress` | 是 | 阅读位置，格式由客户端自定义（CFI、xpointer、页码均可），服务端只做字符串存储 |
| `percentage` | 是 | 进度百分比，**0-1 的小数**（注意不是 0-100） |
| `platform` | 否 | 平台标识，用于统计。内置值见 `BUILTIN_PLATFORMS`，也可自定义 |
| `readingSeconds` | 否 | 本次新增阅读秒数，服务端累加进统计。单次上限 86400 |
| `clientTime` | 否 | 客户端本地时间，用于离线补传时判定新旧 |

### 4.6 其它端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sync/entries` | 列出全部同步条目（分页） |
| DELETE | `/api/sync/progress/:document` | 删除某文档的同步记录 |
| GET / POST | `/api/sync/tokens` | 列出 / 创建接入令牌 |
| DELETE | `/api/sync/tokens/:id` | 删除令牌 |

---

## 五、KOSync 兼容协议（KOReader）

KOReader 内置的进度同步协议。**这些端点不遵循上面的响应信封**，必须保持上游格式，否则 KOReader 无法解析。

### 5.1 认证

KOReader 固定发送两个请求头：

| 头 | 值 |
|---|---|
| `x-auth-user` | 用户名 |
| `x-auth-key` | **密码的 MD5 十六进制串**（不是明文，也不是 bcrypt/Argon2） |

> **安全说明**：协议由客户端固定，服务端无法要求它改用更安全的方式。因此服务端为每个用户单独保存一份「同步密钥」（`users.kosyncKey`）。你可以在「设置 → 账号安全」里设置一个**与主密码不同的同步密码**，这样即使该 MD5 泄露也不会危及主账号。

### 5.2 端点

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/healthcheck` | 无（无需认证） | `{ "state": "OK" }` |
| GET | `/users/auth` | 仅请求头 | `200` `{ "authorized": "OK" }` / `401` `{ "message": "..." }` |
| POST | `/users/create` | `{ "username": "...", "password": "<md5>" }` | `201` `{ "username": "..." }` / `402` 用户名已存在 |
| PUT | `/users/password` | 仅请求头 + `{ "password": "<新md5>" }` | `200` `{ "updated": true }` |
| PUT | `/syncs/progress` | `{ document, progress, percentage, device, device_id }` | `{ "document": "...", "timestamp": 1789737720 }` |
| GET | `/syncs/progress/{document}` | 仅请求头 | 裸 JSON，见下 |
| DELETE | `/users/me` | — | `501`，**有意不实现**，见 5.5 |

`GET /syncs/progress/{document}` 响应（**未找到时返回 `{}` 而非 404**，这是 KOReader 的预期行为）：

```json
{
  "document": "abc123",
  "progress": "/body/DocFragment[5]/body/div/p[12]/text().0",
  "percentage": 0.4275,
  "device": "Kindle",
  "device_id": "abcd-1234",
  "timestamp": 1789737720
}
```

注意 `percentage` 是 **0-1 小数**，`timestamp` 是 **Unix 秒**。

### 5.3 探活

部分客户端在保存服务器地址前会先探测。官方服务器自带的探活脚本判定条件就是 `GET /healthcheck` 的响应体中出现 `"state":"OK"`：

```bash
curl -sf -k -H "Accept: application/vnd.koreader.v1+json" \
  https://<你的服务器地址>/healthcheck | grep -q '"state":"OK"'
```

如果客户端报「该地址不是 KOReader 同步服务器」，先用上面这条命令确认服务端这一层是否正常——它能区分「地址/网络问题」和「账号密码问题」。

### 5.4 响应格式

**成功响应改成了 JSON。** 上游 sync.koreader.rocks 在 `/users/auth` 与 `/users/create` 上返回的是纯文本 `OK`。本服务器改为返回 JSON，原因是有第三方客户端（如 Reeden）在填写自定义同步地址时会解析响应体，拿到非 JSON 就判定「该地址不是 KOReader 同步服务器，请检查服务器地址」——与账号密码无关，用户完全无从排查。KOReader 本身只看状态码，因此这一改动对它无影响。

**失败响应一律是 `{"message": "..."}`**，绝不返回 `ApiResponse` 信封（`{ ok: false, error: {...} }`）。KOReader 客户端的代码是：

```lua
text = body and body.message or _("Unknown server error")
```

拿不到 `message` 字段时，界面上只会显示「未知服务器错误」，用户无法判断是密码错了、账号被禁用还是服务端故障。因此本文件里所有失败路径都直接 `reply`，不抛异常——全局错误处理器会把任何异常转成信封，那样客户端就读不到 `message` 了。

认证失败的 `message` 会区分具体原因（用户名不存在 / 账号被禁用 / 未设置同步密码 / 密码不匹配），因为电子墨水屏上输入账号极易出错，笼统回一句「密码不正确」会让这些情况无从判断。服务端日志同时记录失败原因与用户名，但**不记录密钥本身**。

### 5.5 未实现的端点

| 方法 | 路径 | 本服务器行为 |
|---|---|---|
| DELETE | `/users/me` | `501` + 说明文案 |

官方的 `DELETE /users/me` 用于注销账号。在官方服务器里账号就等于同步账号，删除只影响同步数据；而本项目的账号还持有网页登录、书库元数据、存储配置与阅读统计。让阅读器里一次「删除同步账号」把整站账号连同书库一起抹掉，影响远超用户预期且不可恢复，因此这里返回 `501` 并说明应到网页端操作，而不是默默照做。

### 5.6 KOReader 配置

在 KOReader 里打开「工具 → 云存储 → 进度同步」，填写：

- 自定义同步服务器：`http://<你的服务器地址>:3000`
- 用户名 / 密码：站点账号（或你单独设置的同步密码）

若使用本项目自带的插件（见 `koreader-plugin/`），则可在插件菜单里直接登录，无需手动填写。

---

## 六、分片上传

> **网页端默认就走这条路径，你不需要手动调用。** 本节面向自行接入的开发者。

整份文件一次 `POST /api/books/upload` 在直连时更省事，但只要客户端与服务端之间隔着反向代理就不可靠：Nginx 的 `client_max_body_size` 默认只有 1 MB，Cloudflare 橙云（含 Tunnel）对请求体大小和请求时长都有上限且免费版调不了。这些限制服务端绕不过去，只能把请求切小。

### 6.1 流程

| 步骤 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | POST | `/api/uploads` | 建会话，返回 `uploadId`、`chunkSize`、`totalChunks` |
| 2 | PUT | `/api/uploads/{uploadId}/parts/{index}` | 上传第 index 片（从 0 开始），**原始二进制** |
| 3 | POST | `/api/uploads/{uploadId}/complete` | 合并、校验 MD5、入库 |
| — | DELETE | `/api/uploads/{uploadId}` | 放弃上传并清理已落盘的分片 |

### 6.2 建会话

```json
POST /api/uploads
{
  "filename": "book.epub",
  "size": 52428800,
  "md5": "d41d8cd98f00b204e9800998ecf8427e",
  "mode": "create",
  "chunkSize": 2097152,
  "fields": { "title": "书名", "author": "作者", "format": "epub", "storageId": "1" }
}
```

- `size` 必填且必须准确：服务端据此算分片数，并在合并时校验。
- `md5` 可选；给了就会在合并后比对，不一致直接拒绝。
- `mode` 为 `version` 时必须带 `bookId`，用于给已有书籍上传新版本。
- `fields` 就是整体上传时那些表单字段（title/author/format/storageId/tags/note…）。
- `chunkSize` 可选，省略则用服务端默认值（4 MiB）。会被夹到 `256 KiB ~ 64 MiB`。

> **分片大小拿不准就先不传，失败了再减半重来。** 一片能不能在这个链路上传完取决于用户上行到源站的实际速度，事前猜不准 —— 同一个 4 MiB 在光纤上几百毫秒，绕经 Cloudflare 的慢链路上就会超过它的 100 秒超时（表现为 `524`）。网页端就是这么做的：遇到 524/504/408/413 或连接被重置时，把分片减半、**重新建会话**再传（分片布局是建会话时定死的，不能中途改）。

响应：

```json
{ "ok": true, "data": { "uploadId": "a1b2…", "chunkSize": 4194304, "totalChunks": 13 } }
```

**分片大小以服务端返回的 `chunkSize` 为准**，不要自己定 —— 服务端才知道自己的 `bodyLimit` 与部署环境能承受多大的请求。

### 6.3 上传分片

```http
PUT /api/uploads/{uploadId}/parts/0
Content-Type: application/octet-stream
Authorization: Bearer <令牌>

<该片的原始字节>
```

- 除最后一片外，每片**必须正好** `chunkSize` 字节；最后一片是剩余部分。大小不符会被拒绝（这样客户端切分逻辑写错能立刻发现，而不是合并出一个损坏的文件）。
- 分片**可以乱序上传，也可以重传覆盖**：服务端按 `index × chunkSize` 定位写入。
- 服务端不信任客户端上报的内容，合并时会流式重算 MD5 与大小。

### 6.4 合并入库

```http
POST /api/uploads/{uploadId}/complete
```

返回与整体上传相同的 `BookDetail`（命中秒传时返回已有书籍）。合并成功后会话立即失效。

**缺片会被明确拒绝**，并在错误信息里点出缺哪几片：

```json
{ "ok": false, "error": { "code": "BAD_REQUEST", "message": "还有分片未上传（如第 1、3 片），请补传后再合并" } }
```

此时可以补传缺失的分片再重试 `complete`（会话仍在）。会话保留 24 小时，超时由服务端自动清理。

---

## 七、速率限制

| 接口 | 限制 |
|---|---|
| `POST /api/auth/login` | 10 次 / 分钟 / IP |
| `POST /api/auth/register` | 5 次 / 小时 / IP |
| `POST /api/auth/forgot-password` | 3 次 / 小时 / IP |
| 同步接口 | 默认不限流（阅读器同步频率高，限流会丢进度） |

超过限制返回 `429` 与 `RATE_LIMITED` 错误码。
