import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ReadSync 示例插件（最小可用）。
 *
 * 演示四件事：
 *  1. register(ctx) 是唯一入口，宿主加载时调用一次；
 *  2. ctx.getConfig() 读取用户在管理后台填写的配置（password 字段已自动解密）；
 *  3. ctx.dataDir 是插件专属数据目录（需声明 fs:data 权限，否则为空串）；
 *  4. ctx.on() 注册钩子 / ctx.registerSyncProtocol() 声明同步协议路由。
 *
 * 注意：插件代码以服务进程权限运行，没有沙箱。
 * 只安装可信来源的插件，并只声明真正需要的能力。
 */

/** @param {import('@readsync/shared').PluginContext} ctx */
export async function register(ctx) {
  const config = ctx.getConfig();
  const greeting = typeof config.greeting === 'string' ? config.greeting : 'Hello ReadSync';

  ctx.log.info('示例插件已加载', {
    greeting,
    // 只记录「是否配置了 API Key」，绝不把敏感值本身写进日志
    hasApiKey: typeof config.apiKey === 'string' && config.apiKey.length > 0,
  });

  // 数据目录：必须先在 plugin.json 的 permissions 里声明 fs:data
  if (ctx.dataDir) {
    const stateFile = path.join(ctx.dataDir, 'state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({ loadedAt: new Date().toISOString(), greeting }, null, 2),
      'utf8',
    );
    ctx.log.debug('已写入插件状态文件', { stateFile });
  } else {
    ctx.log.warn('未授予 fs:data 权限，跳过状态文件写入');
  }

  // 钩子：书籍上传完成后会收到事件。钩子抛错只记日志，不会影响主流程。
  ctx.on('onBookUpload', (payload) => {
    ctx.log.info('收到书籍上传事件', { payload });
  });

  // 同步协议路由：最终挂载在 /api/plugins/com.example.readsync-demo/demo
  ctx.registerSyncProtocol('demo', (app) => {
    app.get('/status', async () => ({
      ok: true,
      data: {
        plugin: ctx.pluginId,
        greeting,
        time: new Date().toISOString(),
      },
    }));
  });
}

/** 可选：停用/卸载时的清理逻辑 */
export function unregister() {
  // 这里没有需要释放的资源；真实插件可在此关闭连接、定时器等。
}
