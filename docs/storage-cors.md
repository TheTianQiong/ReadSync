# 对象存储 CORS 配置（预签名直传必读）

> 本文只讲**桶那一侧**的 CORS。ReadSync **这一侧**怎么建 S3 存储、各字段填什么，见 [存储后端配置指南](storage-setup.md)。

用「预签名直传」时，**浏览器会直接向对象存储发 PUT 请求**，而不是发给你自己的服务器。这属于跨域请求，对象存储必须在桶上声明允许，否则请求会被浏览器拦掉。

拦掉的表现很有迷惑性：浏览器控制台报 CORS 错误，页面上则显示「无法连接对象存储」——看起来像网络不通，其实是桶上少了一段配置。

---

## 一、为什么要配

| | 普通上传 | 预签名直传 |
|---|---|---|
| 请求发往 | 你的服务器（同源） | 对象存储（跨域） |
| 需要 CORS | 否 | **是** |

预签名 URL 里的签名只证明「这个链接是服务端发的」，它管不了浏览器的同源策略。两件事必须都成立：签名有效 **且** 桶允许该来源跨域访问。

---

## 二、Cloudflare R2

控制台 → R2 → 选择桶 → **Settings → CORS Policy → Add CORS policy**：

```json
[
  {
    "AllowedOrigins": ["https://read.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

- `AllowedOrigins` 换成**你实际访问 ReadSync 的地址**（含协议与端口，如 `https://read.example.com:8443`）。用 `http://localhost:3000` 本地调试时也要单独加一条。
- `AllowedMethods` 里的 `PUT` 是直传用的；`GET`/`HEAD` 是下载与校验用的。
- `AllowedHeaders` 至少要放行 `content-type`——预签名时把 Content-Type 签进去了，浏览器会先发预检问它能不能带。
- `ExposeHeaders` 里的 `etag` 不是必须的：服务端是**自己**去 HEAD 对象取 ETag 做校验的，不依赖浏览器读它。写上只是为了排查时方便。

> 不要图省事写 `"AllowedOrigins": ["*"]`。预签名 URL 本身就是一张可写入的凭据，放开来源等于把「谁都能拿着它写桶」的门槛又降了一档。

### R2 还需要一个 API 令牌

「存储管理 → 新建存储 → S3 兼容」里要填的凭据，来自 R2 的 **Manage R2 API Tokens**：

| ReadSync 字段 | R2 控制台 |
|---|---|
| Endpoint | `https://<账户 ID>.r2.cloudflarestorage.com` |
| Bucket | 你的桶名 |
| Access Key ID | 令牌的 Access Key ID |
| Secret Access Key | 令牌的 Secret Access Key |
| 区域 | `auto` |
| 寻址风格 | Path（R2 支持，Path 更省事） |

令牌权限选 **Object Read & Write**，并限定到具体的桶。

---

## 三、阿里云 OSS

控制台 → Bucket → **数据安全 → 跨域设置 → 创建规则**：

- 来源：`https://read.example.com`
- 允许 Methods：`PUT`、`GET`、`HEAD`
- 允许 Headers：`content-type`、`x-oss-*`（OSS 的签名头需要）
- 暴露 Headers：`ETag`

---

## 四、腾讯云 COS

控制台 → Bucket → **安全管理 → 跨域访问 CORS 设置 → 添加规则**：

- 来源 Origin：`https://read.example.com`
- 操作 Methods：`PUT`、`GET`、`HEAD`
- Allow-Headers：`content-type`、`x-cos-*`

---

## 五、MinIO

```bash
# 用 mc 配置
mc admin config set myminio api cors_allow_origin="https://read.example.com"
mc admin service restart myminio
```

或直接在桶上应用 CORS 规则（MinIO 支持 S3 的 PutBucketCors API）：

```bash
cat > cors.json <<'EOF'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://read.example.com"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
EOF
mc cors set myminio/my-bucket cors.json
```

---

## 六、验证

配完先确认浏览器能直连对象存储。在**打开了 ReadSync 页面的**浏览器控制台里执行：

```js
fetch('https://<你的存储 endpoint>/<bucket>/cors-probe.txt', {
  method: 'PUT',
  headers: { 'content-type': 'text/plain' },
  body: 'hello',
}).then(r => console.log('状态', r.status)).catch(e => console.error('被拦下了：', e));
```

- 报 CORS 错误 → 桶的 CORS 规则没生效或来源写错了（注意协议、端口、结尾不能带 `/`）。
- 返回 403 → CORS 通了，是凭据或桶权限的问题，去查 API 令牌。

这条探测会真的往桶里写一个 `cors-probe.txt`，验完记得删掉。

---

## 七、还是不通？

| 现象 | 多半是 |
|---|---|
| 控制台报 CORS，页面提示「无法连接对象存储」 | 桶的 CORS 规则没生效 / 来源写错 |
| 预检（OPTIONS）通过，PUT 返回 403 | API 令牌权限不足，或签名里的 endpoint/区域与实际不符 |
| 上传成功但确认时报「找不到刚上传的文件」 | 存储配置里的 `prefix`（对象键前缀）与实际不符，服务端回查的位置和写进去的位置不一致 |
| 确认时报「内容与声明的 MD5 不一致」 | 传输过程中内容被改动（少见）。服务端已把这一个对象删掉，重传即可 |
| 干脆用不了预签名 | 存储不是对象存储（本地磁盘、WebDAV 没有预签名概念）。前端会自动回退到分片上传 |
