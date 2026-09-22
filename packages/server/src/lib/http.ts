/**
 * 与依赖版本无关的最小 HTTP 客户端视图。
 *
 * 为什么不直接用全局的 `fetch` / `Response` 类型：
 * `@types/node` 各版本对全局 `fetch` 返回值的声明并不完全一致。本项目在
 * 本地（Node 24 + @types/node 26.6.1）编译正常，而在用户的服务器上
 * （Node 26）报：
 *     src/lib/mail.ts:123:12 - error TS2339: Property 'ok' does not exist on type 'Response'.
 *     src/modules/plugins/loader.ts:361:27 - error TS2322: Type 'Promise<Response>' is not assignable ...
 * 这类「换个环境就编不过」的问题不该由使用者承担。
 *
 * 做法：把用到的成员收敛成一个显式签名，并用一次类型断言把全局 fetch
 * 适配过来。运行时行为完全不变（就是原生 fetch），但编译结果不再受
 * 依赖版本摆布。
 */

/** 只声明我们真正用到的响应成员 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type HttpFetch = (input: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/**
 * 全局 fetch 的显式视图。
 *
 * 断言是安全的：原生 fetch 必然提供 ok / status / text / json，
 * 这里只是让类型系统不再依赖 @types/node 的具体声明方式。
 */
export const http: HttpFetch = (input, init) =>
  (globalThis.fetch as unknown as HttpFetch)(input, init);

/** 运行时自检：确认当前 Node 确实提供 fetch（Node 18+ 才有） */
export function assertFetchAvailable(): void {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      `当前 Node.js（${process.version}）不提供全局 fetch，请升级到 Node 18 以上版本。`,
    );
  }
}
