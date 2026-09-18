/**
 * 全局版本号唯一来源。
 *
 * 版本信息会在两处展示（见 README 要求 1.2）：
 *  - 后端启动日志（packages/server/src/logger.ts 启动横幅）
 *  - 前端网页底部（packages/web 的 Footer 组件）
 *
 * 修改版本号时只需改这里，前端通过 Vite define 注入，后端直接引用。
 */
export const VERSION = '0.1.0';

/** 产品名，用于日志横幅、OTP 发行方、邮件标题等 */
export const APP_NAME = 'ReadSync';

/** 中文产品名（读记服务器） */
export const APP_NAME_CN = '读记服务器';

/** 版本号展示文本，例如 "ReadSync v0.1.0" */
export const VERSION_LABEL = `${APP_NAME} v${VERSION}`;

/** 构建时间戳，由打包时注入；开发环境回退为运行时未知值 */
export const BUILD_TIME: string = '__BUILD_TIME__';
