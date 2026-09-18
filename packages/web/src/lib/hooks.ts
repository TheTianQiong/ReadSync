import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

/**
 * 页面级数据拉取。
 *
 * 后端模块正在并行实现，端点尚未上线是常态，因此这个 hook 把「加载失败」和
 * 「端点不存在（404）」区分开：前者提示错误，后者让页面直接降级成「暂无数据」，
 * 见 isMissingEndpoint。
 */
export interface AsyncResult<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  /** 手动重新拉取（保存成功后刷新列表等场景） */
  reload: () => void;
  /** 本地写回（乐观更新），不触发请求 */
  setData: (updater: T | null | ((prev: T | null) => T | null)) => void;
}

export interface AsyncOptions {
  /** false 时先不发请求，等调用方显式 reload() */
  immediate?: boolean;
}

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
  options: AsyncOptions = {},
): AsyncResult<T> {
  const { immediate = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  // 把 fn 放进 ref：调用方几乎总是写内联箭头函数，若作为依赖会导致死循环
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (!immediate) return undefined;

    let cancelled = false;
    setLoading(true);
    setError(null);

    fnRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', String(err), 0));
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, immediate]);

  return { data, loading, error, reload, setData };
}

/** 端点尚未实现时不该弹红色错误，而是走空状态 */
export function isMissingEndpoint(error: ApiError | null): boolean {
  return error !== null && error.isMissing;
}

/** 输入框防抖，用于书库搜索 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

/** 记录最近一次请求的错误并支持手动清除，表单提交场景用 */
export function useActionError(): {
  error: ApiError | null;
  setError: (error: unknown) => void;
  clear: () => void;
} {
  const [error, setError] = useState<ApiError | null>(null);

  const set = useCallback((err: unknown) => {
    setError(err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', String(err), 0));
  }, []);

  const clear = useCallback(() => setError(null), []);

  return { error, setError: set, clear };
}
