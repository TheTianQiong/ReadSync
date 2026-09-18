import type { AuthResult, BootstrapStatus, PublicSettings, SessionUser } from '@readsync/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { UNAUTHORIZED_EVENT, api, clearTokens, getAccessToken, setTokens } from '../lib/api';
import { encryptPassword } from '../lib/crypto';

/**
 * 全局登录态。
 *
 * 这里同时持有「公开站点设置」和「是否已初始化」，因为二者与登录态共享同一段
 * 启动时序：App 必须在首屏就决定是渲染登录页、初始化引导页还是主界面，
 * 拆成多个 context 只会让这段顺序更难读。
 */

export interface LoginCredentials {
  username: string;
  password: string;
  totpCode?: string;
  remember?: boolean;
}

export interface RegisterPayload {
  username: string;
  email: string;
  password: string;
  inviteCode?: string;
  displayName?: string;
}

interface AuthContextValue {
  user: SessionUser | null;
  /** 公开设置；后端未就绪时为 null，调用方需容忍 */
  settings: PublicSettings | null;
  /** null 表示尚未探测出结果（启动中） */
  initialized: boolean | null;
  /** 首屏启动中：公开设置/引导状态/当前用户都还没确定 */
  loading: boolean;
  isAdmin: boolean;
  login: (credentials: LoginCredentials) => Promise<AuthResult>;
  register: (payload: RegisterPayload) => Promise<SessionUser>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  refreshUser: () => Promise<SessionUser | null>;
  /** 初始化完成后调用，让站点从「未初始化」切换到正常路由 */
  refreshSite: () => Promise<void>;
  /** 头像上传/资料修改后就地更新，避免整页刷新 */
  patchUser: (patch: Partial<SessionUser>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSite = useCallback(async () => {
    // 两个接口都不需要登录；任一失败都不阻塞首屏，用默认值兜底
    const [settingsResult, bootstrapResult] = await Promise.allSettled([
      api.get<PublicSettings>('/system/settings', undefined, { auth: false }),
      api.get<BootstrapStatus>('/system/bootstrap', undefined, { auth: false }),
    ]);

    setSettings(settingsResult.status === 'fulfilled' ? settingsResult.value : null);
    setInitialized(bootstrapResult.status === 'fulfilled' ? bootstrapResult.value.initialized : true);
  }, []);

  const refreshUser = useCallback(async (): Promise<SessionUser | null> => {
    if (!getAccessToken()) {
      setUser(null);
      return null;
    }
    try {
      const me = await api.get<SessionUser>('/auth/me');
      setUser(me);
      return me;
    } catch {
      // api.ts 已在 401 时清掉令牌；这里只需把内存状态也清空
      clearTokens();
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await Promise.all([loadSite(), refreshUser()]);
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [loadSite, refreshUser]);

  // api.ts 判定登录态失效后广播该事件，SPA 内完成登出（不整页刷新）
  useEffect(() => {
    const handle = (): void => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, handle);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handle);
  }, []);

  const login = useCallback(async (credentials: LoginCredentials): Promise<AuthResult> => {
    const password = await encryptPassword(credentials.password);
    const result = await api.post<AuthResult>(
      '/auth/login',
      {
        username: credentials.username,
        password,
        ...(credentials.totpCode ? { totpCode: credentials.totpCode } : {}),
        remember: credentials.remember ?? false,
      },
      // 密码错误也返回 UNAUTHORIZED，不能让它触发「跳登录页」把错误吞掉
      { auth: false, skipAuthRedirect: true },
    );

    if (result.accessToken) {
      setTokens(result.accessToken, result.refreshToken);
      setUser(result.user);
    }
    return result;
  }, []);

  const register = useCallback(async (payload: RegisterPayload): Promise<SessionUser> => {
    const password = await encryptPassword(payload.password);

    const result = await api.post<{ user?: SessionUser } & Partial<AuthResult>>(
      '/auth/register',
      {
        username: payload.username,
        email: payload.email,
        password,
        ...(payload.inviteCode ? { inviteCode: payload.inviteCode } : {}),
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
      },
      { auth: false, skipAuthRedirect: true },
    );

    // 后端可能直接下发令牌（注册即登录），也可能只返回用户对象
    if (result.accessToken && result.refreshToken && result.user) {
      setTokens(result.accessToken, result.refreshToken);
      setUser(result.user);
      return result.user;
    }

    if (result.user) {
      // 只返回了用户：用同一套凭据补一次登录，用户无需再输一遍
      try {
        const logged = await login({
          username: payload.username,
          password: payload.password,
          remember: true,
        });
        return logged.user;
      } catch {
        return result.user;
      }
    }

    const me = await refreshUser();
    if (!me) throw new Error('注册成功，但自动登录失败，请手动登录');
    return me;
  }, [login, refreshUser]);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } catch {
      // 令牌可能已过期；本地清理才是必须的
    }
    clearTokens();
    setUser(null);
  }, []);

  const logoutAll = useCallback(async (): Promise<void> => {
    try {
      await api.post('/auth/logout-all');
    } catch {
      /* 同上 */
    }
    clearTokens();
    setUser(null);
  }, []);

  const refreshSite = useCallback(async (): Promise<void> => {
    await loadSite();
  }, [loadSite]);

  const patchUser = useCallback((patch: Partial<SessionUser>): void => {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      settings,
      initialized,
      loading,
      isAdmin: user?.role === 'admin',
      login,
      register,
      logout,
      logoutAll,
      refreshUser,
      refreshSite,
      patchUser,
    }),
    [user, settings, initialized, loading, login, register, logout, logoutAll, refreshUser, refreshSite, patchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return context;
}
