import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import {
  pluginConfigUpdateSchema,
  type ApiSuccess,
  type PluginConfigField,
  type PluginSummary,
} from '@readsync/shared';
import { badRequest, unsupportedMediaType } from '../../errors.js';
import { auditContextFrom, recordAudit } from '../../lib/audit.js';
import { currentUser, requireAdmin, requireAuth } from '../../middleware/auth.js';
import { mountPluginRoutes } from './loader.js';
import {
  disablePlugin,
  enablePlugin,
  getPluginConfig,
  installPlugin,
  listPluginData,
  listPlugins,
  uninstallPlugin,
  updatePluginConfig,
} from './service.js';

/**
 * 插件管理接口（前缀 /api/plugins）。
 *
 * 读接口登录即可，写接口（安装/卸载/启停/改配置）一律要求管理员：
 * 插件代码以服务进程权限运行，安装插件等价于获得服务器执行权限。
 *
 * 安装走 multipart，但注意本模块自行限制 zip 体积与解压后大小，
 * app.ts 里 2GB 的 multipart 上限是给书籍上传用的。
 */
export async function registerPluginRoutes(app: FastifyInstance): Promise<void> {
  /** 列出已安装插件（配置脱敏，登录用户可见） */
  app.get('/api/plugins', { preHandler: requireAuth }, async () => {
    return { ok: true, data: listPlugins() } satisfies ApiSuccess<PluginSummary[]>;
  });

  /** 上传 zip 安装 / 覆盖升级插件 */
  app.post('/api/plugins/install', { preHandler: requireAdmin }, async (req) => {
    const file = await req.file();
    if (!file) {
      throw badRequest('未收到上传的插件包（multipart 字段名应为 file）');
    }
    assertLooksLikeZip(file);

    const buffer = await readUploadWithLimit(file, MAX_UPLOAD_BYTES);
    const user = currentUser(req);
    const summary = await installPlugin(buffer, user.id);

    recordAudit('plugin.install', auditContextFrom(req), {
      target: summary.id,
      // 安装成功与否以最终运行状态为准：清单合法但代码加载失败时 status='error'
      success: summary.status !== 'error',
      meta: { version: summary.version, status: summary.status, error: summary.error },
    });

    return { ok: true, data: summary } satisfies ApiSuccess<PluginSummary>;
  });

  /** 卸载插件（内置插件不可卸载） */
  app.delete<{ Params: { id: string } }>(
    '/api/plugins/:id',
    { preHandler: requireAdmin },
    async (req) => {
      const pluginId = req.params.id;
      await uninstallPlugin(pluginId);

      recordAudit('plugin.uninstall', auditContextFrom(req), { target: pluginId });

      return { ok: true, data: { id: pluginId } } satisfies ApiSuccess<{ id: string }>;
    },
  );

  /** 启用并加载插件 */
  app.post<{ Params: { id: string } }>(
    '/api/plugins/:id/enable',
    { preHandler: requireAdmin },
    async (req) => {
      const pluginId = req.params.id;
      const summary = await enablePlugin(pluginId);

      recordAudit('plugin.enable', auditContextFrom(req), {
        target: pluginId,
        success: summary.status !== 'error',
        meta: summary.error ? { error: summary.error } : null,
      });

      return { ok: true, data: summary } satisfies ApiSuccess<PluginSummary>;
    },
  );

  /** 停用并卸载插件 */
  app.post<{ Params: { id: string } }>(
    '/api/plugins/:id/disable',
    { preHandler: requireAdmin },
    async (req) => {
      const pluginId = req.params.id;
      const summary = await disablePlugin(pluginId);

      recordAudit('plugin.disable', auditContextFrom(req), { target: pluginId });

      return { ok: true, data: summary } satisfies ApiSuccess<PluginSummary>;
    },
  );

  /** 读取配置（敏感字段脱敏） */
  app.get<{ Params: { id: string } }>(
    '/api/plugins/:id/config',
    { preHandler: requireAdmin },
    async (req) => {
      const data = getPluginConfig(req.params.id);
      return {
        ok: true,
        data,
      } satisfies ApiSuccess<{ config: Record<string, unknown>; configFields: PluginConfigField[] }>;
    },
  );

  /**
   * 更新配置。
   * 前端把脱敏读到的值原样提交时，掩码会被服务端识别为「不修改」并保留原密文。
   */
  app.patch<{ Params: { id: string } }>(
    '/api/plugins/:id/config',
    { preHandler: requireAdmin },
    async (req) => {
      const input = pluginConfigUpdateSchema.parse(req.body);
      const config = await updatePluginConfig(req.params.id, input.config);
      return {
        ok: true,
        data: { config },
      } satisfies ApiSuccess<{ config: Record<string, unknown> }>;
    },
  );

  /** 列出插件在 plugin_data 表中的键值（db:plugin 权限的数据） */
  app.get<{ Params: { id: string } }>(
    '/api/plugins/:id/data',
    { preHandler: requireAdmin },
    async (req) => {
      const items = listPluginData(req.params.id);
      return {
        ok: true,
        data: { items },
      } satisfies ApiSuccess<{ items: ReturnType<typeof listPluginData> }>;
    },
  );

  /**
   * 挂载插件声明的同步协议路由。
   * 必须在这里做：loadPlugins() 在 buildApp() 之前执行，那时还没有 Fastify 实例。
   */
  await mountPluginRoutes(app);
}

/** 与 service 层保持一致的上传上限（在此处先做一次快速拦截，避免把大文件读进内存） */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'multipart/x-zip',
]);

/** 宽松校验上传类型：宁可让后续 zip 解析报错，也不要误拒不同浏览器/工具的实现 */
function assertLooksLikeZip(file: MultipartFile): void {
  const filename = file.filename ?? '';
  if (filename.toLowerCase().endsWith('.zip')) return;
  if (file.mimetype && ALLOWED_MIME_TYPES.has(file.mimetype)) return;
  throw unsupportedMediaType('插件包必须是 .zip 文件');
}

/** 流式读取上传内容并强制大小上限，避免大文件把内存吃满 */
async function readUploadWithLimit(file: MultipartFile, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of file.file) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw badRequest(`插件包不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    }
    chunks.push(buf);
  }

  if (file.file.truncated) {
    throw badRequest('插件包超过服务器允许的上传大小');
  }
  return Buffer.concat(chunks);
}
