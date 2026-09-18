# ReadSync 插件开发指南

本指南面向希望为 ReadSync 扩展存储驱动或同步协议的开发者。

插件系统的设计目标：**让不支持的协议通过插件接入，而无需修改内核代码**。

---

## 一、插件是什么

一个插件就是一个 **zip 包**，解压后根目录包含：

```
my-plugin.zip
├── plugin.json      # 必需：清单文件，内核据此识别与校验
├── index.js         # 必需：入口模块（文件名由 manifest.main 指定）
└── lib/             # 可选：其它模块
    └── helper.js
```

安装后会被解压到 `{数据目录}/plugins/{pluginId}/`。

---

## 二、最小示例

### plugin.json

```json
{
  "id": "com.example.hello",
  "name": "Hello 插件",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "一个演示插件",
  "apiVersion": ">=0.1.0 <0.2.0",
  "capabilities": ["notification"],
  "main": "index.js",
  "permissions": ["log"],
  "config": [
    {
      "key": "greeting",
      "label": "问候语",
      "type": "string",
      "required": false,
      "default": "你好",
      "placeholder": "输入一句问候语",
      "description": "插件启动时会打印这句话"
    }
  ]
}
```

### index.js

```js
/**
 * 插件入口。
 * 内核加载时会调用 register(ctx)，并把上下文 API 注入进来。
 *
 * @param {import('@readsync/shared').PluginContext} ctx
 */
export function register(ctx) {
  ctx.log.info('插件已加载');

  const config = ctx.getConfig();
  ctx.log.info(`配置的问候语是：${config.greeting ?? '(未设置)'}`);

  // 注册钩子：新用户注册时输出一行日志
  ctx.on('onUserRegister', (payload) => {
    ctx.log.info(`新用户注册：${payload.username}`);
  });
}

/** 可选：停用插件时调用，用于释放资源 */
export function unregister() {
  // 清理定时器、关闭连接等
}
```

打包：

```bash
zip -r my-plugin.zip plugin.json index.js lib/
```

然后在「管理后台 → 插件管理」上传，或使用 CLI：

```bash
readsync plugin install ./my-plugin.zip
readsync plugin enable com.example.hello
```

---

## 三、清单字段（plugin.json）

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 唯一标识，小写字母/数字/`.`/`_`/`-`，建议反向域名风格 |
| `name` | string | ✅ | 显示名称 |
| `version` | string | ✅ | 语义化版本，如 `1.0.0` |
| `apiVersion` | string | ✅ | 兼容的内核版本范围，如 `">=0.1.0 <0.2.0"`。不匹配时内核拒绝加载 |
| `capabilities` | string[] | ✅ | 声明能力，见下节 |
| `main` | string | | 入口文件，默认 `index.js` |
| `runtime` | string | | 目前只支持 `node` |
| `author` / `description` / `homepage` / `license` | string | | 元信息，展示在插件列表 |
| `permissions` | string[] | | 需要申请的宿主权限，见下节 |
| `config` | object[] | | 用户可配置项，内核据此自动渲染设置表单 |
| `storageDrivers` | object[] | | 提供存储驱动时声明（`capabilities` 含 `storage`） |
| `syncProtocols` | object[] | | 提供同步协议时声明（`capabilities` 含 `sync`） |

### capabilities（能力）

| 值 | 含义 |
|---|---|
| `storage` | 提供存储驱动（可作为书库的存储后端） |
| `sync` | 提供同步协议（暴露 HTTP 路由） |
| `auth` | 提供认证方式 |
| `notification` | 发送通知 |
| `metadata` | 抓取/补全书籍元数据 |
| `dashboard` | 向首页提供自定义图表卡片 |

### permissions（宿主权限）

内核实行**最小权限**：未在清单中声明的权限，对应 API 会被替换为抛错的桩函数，而不是「虽然声明了但没检查」。

| 值 | 授予的能力 |
|---|---|
| `http` | `ctx.fetch()` 可发起外部 HTTP 请求 |
| `fs:data` | `ctx.dataDir` 指向插件专属数据目录，可读写 |
| `fs:storage` | 可读写服务器存储目录 |
| `log` | `ctx.log` 输出日志 |
| `db:plugin` | 可使用 `plugin_data` 表中的专属键值存储 |

### config（配置项）

```json
{
  "key": "serverUrl",
  "label": "服务器地址",
  "type": "url",
  "required": true,
  "default": "https://example.com",
  "placeholder": "https://...",
  "description": "帮助文本，显示在输入框下方",
  "options": []
}
```

`type` 可选：`string` / `password` / `number` / `boolean` / `select` / `url`。

- `password` 类型的值会**加密存储**，接口返回时脱敏为 `••••••••`
- `select` 类型需要提供 `options`：`[{ "value": "a", "label": "选项 A" }]`

---

## 四、上下文 API（PluginContext）

`register(ctx)` 收到的 `ctx` 提供以下能力：

| 成员 | 说明 |
|---|---|
| `ctx.pluginId` | 当前插件 id |
| `ctx.log.debug/info/warn/error(msg, meta?)` | 结构化日志，自动带插件 id 前缀 |
| `ctx.getConfig<T>()` | 读取用户配置（`password` 字段已解密） |
| `ctx.dataDir` | 插件专属数据目录的绝对路径（需 `fs:data` 权限） |
| `ctx.fetch(input, init?)` | 发起 HTTP 请求（需 `http` 权限） |
| `ctx.registerStorageDriver(driverId, factory)` | 注册存储驱动 |
| `ctx.registerSyncProtocol(protocolId, handler)` | 注册同步协议处理器 |
| `ctx.on(hook, handler)` | 注册生命周期钩子 |

---

## 五、生命周期钩子

| 钩子 | 触发时机 | 回调参数 |
|---|---|---|
| `onLoad` | 插件加载完成 | 无 |
| `onUnload` | 插件停用/卸载 | 无 |
| `onConfigChange` | 用户在后台修改了插件配置 | `{ config }` |
| `onSyncPush` | 收到一次同步推送后 | `{ userId, document, percentage }` |
| `onBookUpload` | 书籍上传完成后 | `{ userId, bookId, md5, size }` |
| `onUserRegister` | 新用户注册后 | `{ userId, username }` |

**钩子执行是旁路**：钩子抛出的异常只会被记录到日志，不会影响主流程，也不会回滚已完成的操作。所以不要在钩子里做「必须成功」的关键业务。

---

## 六、提供存储驱动

声明 `capabilities: ["storage"]` 并在清单里描述驱动：

```json
{
  "capabilities": ["storage"],
  "permissions": ["http", "log"],
  "storageDrivers": [
    {
      "id": "my-cloud",
      "name": "我的网盘",
      "config": [
        { "key": "token", "label": "访问令牌", "type": "password", "required": true }
      ]
    }
  ]
}
```

在 `register()` 中注册工厂函数：

```js
export function register(ctx) {
  ctx.registerStorageDriver('my-cloud', {
    /**
     * 创建适配器实例。config 为该用户在存储设置里填写的配置。
     * 必须实现 StorageAdapter 接口（见 packages/server/src/modules/storage/types.ts）：
     *   test() / put() / get() / exists() / stat() / delete() / list()
     * 可选：getSignedUrl() / usedBytes()
     */
    create(config) {
      return {
        driver: 'plugin',
        description: '我的网盘',

        async test() {
          try {
            await ctx.fetch('https://api.mycloud.com/ping', {
              headers: { Authorization: `Bearer ${config.token}` },
            });
            return { ok: true, message: '连接正常' };
          } catch (err) {
            return { ok: false, message: `连接失败：${err.message}` };
          }
        },

        async put(key, data, options) {
          // 上传实现
        },

        async get(key) {
          // 下载实现，返回 { stream, size, contentType, etag }
        },

        async exists(key) { /* ... */ },
        async stat(key) { /* ... */ },
        async delete(key) { /* ... */ },
        async list(options) { /* ... */ },
      };
    },
  });
}
```

注册成功后，用户就能在「设置 → 存储管理」里看到「我的网盘」这个选项。

---

## 七、提供同步协议

声明 `capabilities: ["sync"]` 并描述协议路由：

```json
{
  "capabilities": ["sync"],
  "syncProtocols": [
    {
      "id": "my-protocol",
      "name": "我的同步协议",
      "mountPath": "/progress",
      "description": "供 XX 阅读器接入"
    }
  ]
}
```

路由最终挂载在 `/api/plugins/{pluginId}{mountPath}`，即 `/api/plugins/com.example.myplugin/progress`。

---

## 八、开发与调试

### 本地开发流程

```bash
# 1. 在插件目录里开发
mkdir my-plugin && cd my-plugin

# 2. 每次改完重新打包并安装
zip -r ../my-plugin.zip . -x '*.git*'
readsync plugin install ../my-plugin.zip
readsync plugin enable com.example.hello

# 3. 查看日志
journalctl -u readsync -f | grep 'plugin:com.example.hello'
# 或前台运行时直接观察控制台输出
```

### 调试技巧

- 用 `ctx.log.debug()` 打点，把 `READSYNC_LOG_LEVEL` 设为 `debug` 即可看到
- 插件加载失败时，错误信息会写进 `plugins.error` 字段，在「管理后台 → 插件管理」页面直接可见
- 修改插件代码后需要**先停用再启用**才能重新加载（ESM 模块有缓存）

### 常见拒绝原因

| 报错 | 原因 |
|---|---|
| `API 版本不兼容` | `apiVersion` 范围与当前内核版本不匹配 |
| `清单校验失败` | `plugin.json` 缺字段或字段格式不对，错误信息会指出具体字段 |
| `插件包包含非法路径` | zip 内有 `..`、绝对路径或盘符（Zip Slip 防护） |
| `插件包超出大小限制` | 解压后总大小 > 50MB 或文件数 > 500 |
| `id 不匹配` | zip 内的目录结构与 `manifest.id` 不一致 |

---

## 九、安全须知

插件运行在服务端进程内，**拥有与内核同等的进程权限**。因此：

1. **只安装你信任的插件**。插件可以读取进程内存、发起网络请求、读写数据目录（在声明的权限范围内）。
2. **权限模型是约束而非沙箱**。它防止插件意外越权，但无法抵御恶意代码 —— Node.js 没有真正的进程内沙箱。
3. 上架/分发插件时，请**明确告知用户插件会访问哪些数据**。
4. 若你需要更强的隔离，建议把外部服务做成独立进程，插件只做 HTTP 转发（声明 `http` 权限即可）。

---

## 十、参考

- 类型定义：`packages/shared/src/schemas/plugin.ts`（`PluginManifest` / `PluginContext` / `PluginModule`）
- 存储适配器接口：`packages/server/src/modules/storage/types.ts`
- 示例插件：`packages/server/plugins-samples/`
- 内核加载逻辑：`packages/server/src/modules/plugins/loader.ts`
