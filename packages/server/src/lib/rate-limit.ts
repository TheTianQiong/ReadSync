import { rateLimited } from '../errors.js';

/**
 * 按路由限流的配置工厂。
 *
 * 两件事值得说明：
 *
 *  - 计数按「客户端 IP + 路由」分桶（见 app.ts 的 keyGenerator）。若只用 IP，
 *    登录的 10 次/分钟会与注册、找回密码共享同一配额，用户在登录页试错几次后
 *    就再也收不到重置邮件了。
 *  - `READSYNC_RATE_LIMIT_FACTOR` 把配额整体放大，给自动化测试用（测试从同一个
 *    IP 打十几次登录，不改这个必然撞上限流，而限流本身也是被测对象，不该为了让
 *    测试通过就放宽产品默认值）。
 */
export function scaledLimit(max: number, timeWindow: string) {
  const factor = (() => {
    const raw = Number(process.env.READSYNC_RATE_LIMIT_FACTOR ?? '');
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  })();

  return {
    max: Math.max(1, Math.round(max * factor)),
    timeWindow,
    errorResponseBuilder: () => rateLimited('操作过于频繁，请稍后再试'),
  };
}
