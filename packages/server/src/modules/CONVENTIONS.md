# 后端模块开发约定

本文件是 `packages/server/src/modules/*` 下所有模块必须遵循的写法约定。
新增模块前先读一遍，保持全仓库风格一致。

## 目录结构

```
modules/<模块名>/
├── routes.ts     # 路由注册：export async function registerXxxRoutes(app: FastifyInstance)
├── service.ts    # 业务逻辑（可选，逻辑简单时可直接写在 routes.ts）
└── <其它>.ts     # 该模块专属的实现（如 storage/adapters/*.ts）
```

`app.ts` 中按固定顺序调用各模块的 `registerXxxRoutes(app)`，模块**自行声明 prefix**，
不要把 prefix 写在 `app.ts` 里。

## 路由注册模板

```ts
import type { FastifyInstance } from 'fastify';
import { someSchema, type SomeResult } from '@readsync/shared';
import { getDb } from '../../db/index.js';
import { books } from '../../db/schema.js';
import { badRequest, notFound } from '../../errors.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';

export async function registerLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/books', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const query = listBooksQuerySchema.parse(req.query);
    // ... 业务逻辑
    return { ok: true, data: result } satisfies ApiSuccess<SomeResult>;
  });
}
```

## 硬性规则

1. **响应信封**：所有 `/api/*` 接口返回 `{ ok: true, data }` 或由错误处理器统一产出
   `{ ok: false, error }`。成功时用 `satisfies ApiSuccess<T>` 获得类型检查。
   **例外**：KOSync 兼容端点（`modules/sync/kosync.ts`）必须保持 KOReader 上游的
   原始响应格式（纯文本 `OK`、裸 JSON 对象、无信封），否则客户端无法解析。

2. **错误处理**：只抛 `AppError`，用 `errors.ts` 里的快捷构造函数
   （`badRequest` / `notFound` / `forbidden` / `conflict` / `storageError` ...）。
   不要在路由里写 `reply.status(400).send(...)` 来表达业务错误。

3. **参数校验**：一律用 `@readsync/shared` 里已定义的 zod schema。
   需要新 schema 时加到 shared 包对应文件，不要在后端就地 `z.object({...})`
   定义只在一处使用的结构 —— 前端也需要同一份。

4. **鉴权**：路由用 `preHandler: requireAuth`（登录即可）或 `requireAdmin`（管理员）。
   handler 内用 `currentUser(req)` 取当前用户，它保证非空。

5. **数据库**：`getDb()` 拿 Drizzle 实例。需要复杂聚合（图表统计）时可用
   `getRawDb()` 执行原生 SQL，但**必须用参数绑定**，不要拼字符串。

6. **敏感字段**：存储凭据、TOTP 密钥等需要还原成明文使用的字段，
   写入前用 `encryptConfig()` / `encryptString()`，读取时 `decryptConfig()` /
   `decryptString()`，返回给前端时用 `maskConfig()` 脱敏。密码只用
   `hashPassword()` 单向哈希，**永远不要**把密码或哈希放到任何响应里。

7. **审计**：涉及安全或数据变更的操作（登录、改密、增删用户、增删存储、
   上传/删除书籍、插件启停）调用 `recordAudit(action, auditContextFrom(req), {...})`。
   `action` 取自 shared 的 `AUDIT_ACTIONS`。

8. **日志**：`getModuleLogger('<模块名>')`。日志里禁止出现明文密码、令牌、
   完整凭据；logger 已配置 redact，但仍需自觉。错误日志用 `log.error({ err }, '...')`。

9. **时间**：数据库统一存 `Date` 对象（schema 里是 `timestamp_ms`），
   对外序列化成 RFC3339 字符串（`date.toISOString()`）。

10. **导入路径**：ESM + NodeNext，**相对导入必须带 `.js` 后缀**
    （`import { getDb } from '../../db/index.js'`）。shared 包用包名导入
    （`import { ... } from '@readsync/shared'`）。

11. **中文注释**：注释解释「为什么这么做」而不是「做了什么」，
    涉及安全权衡的地方必须写清楚理由。

## 分页

统一用 shared 的 `paginationQuerySchema` 解析，返回 `Paginated<T>`：

```ts
{ items, total, page, pageSize, totalPages }
```

## 可用的公共设施

| 用途 | 位置 |
|---|---|
| 配置 | `config.ts` → `loadConfig()` |
| 日志 | `logger.ts` → `getModuleLogger(name)` |
| 错误 | `errors.ts` |
| 数据库 | `db/index.ts` → `getDb()` / `getRawDb()`；表定义 `db/schema.ts` |
| 站点设置 | `lib/settings.ts` → `getSiteSettings()` / `patchSiteSettings()` |
| JWT | `lib/jwt.ts` |
| 审计 | `lib/audit.ts` |
| RSA 密钥与密码解密 | `crypto/keys.ts` → `resolvePassword()` |
| 密码哈希 | `crypto/password.ts` |
| 凭据加解密 | `crypto/secret-box.ts` |
| 鉴权中间件 | `middleware/auth.ts` |
| 存储适配器接口 | `modules/storage/types.ts` |
