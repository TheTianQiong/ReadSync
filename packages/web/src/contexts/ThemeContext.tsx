import type { ThemePreference, UserPreferences } from '@readsync/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import { applyTheme, getStoredTheme, storeTheme, watchSystemTheme } from '../lib/theme';
import { useAuth } from './AuthContext';

/**
 * 主题状态。
 *
 * 本地（localStorage）是权威来源 —— 未登录时也必须能切换，且刷新不丢。
 * 登录用户的偏好是第二来源：登录后从 /users/me/preferences 拉一次并应用，
 * 用户在本页切换时再回写服务端，实现换设备恢复。
 */

interface ThemeContextValue {
  /** 用户选择的偏好（含 system） */
  theme: ThemePreference;
  /** 实际生效的明暗 */
  resolved: 'light' | 'dark';
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const { user } = useAuth();
  const [theme, setThemeState] = useState<ThemePreference>(() => getStoredTheme());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => applyTheme(getStoredTheme()));

  // 记录「本次登录后是否已经从服务端同步过偏好」，避免每次 user 对象变化都覆盖本地选择
  const syncedForUser = useRef<number | null>(null);

  // 应用到 <html>
  useEffect(() => {
    setResolved(applyTheme(theme));
  }, [theme]);

  // 跟随系统：只在 theme === 'system' 时订阅，避免无谓的重渲染
  useEffect(() => {
    if (theme !== 'system') return undefined;
    return watchSystemTheme(() => setResolved(applyTheme('system')));
  }, [theme]);

  // 登录后拉取服务端偏好
  useEffect(() => {
    if (!user) {
      syncedForUser.current = null;
      return;
    }
    if (syncedForUser.current === user.id) return;
    syncedForUser.current = user.id;

    let cancelled = false;
    api
      .get<UserPreferences>('/users/me/preferences')
      .then((prefs) => {
        if (cancelled || !prefs?.theme) return;
        setThemeState(prefs.theme);
        storeTheme(prefs.theme);
      })
      .catch(() => {
        // 偏好接口尚未实现 / 首次登录无记录：保留本地主题即可
      });

    return () => {
      cancelled = true;
    };
  }, [user]);

  const setTheme = useCallback(
    (next: ThemePreference): void => {
      setThemeState(next);
      storeTheme(next);

      // 未登录时静默跳过；失败也不回滚，本地已经生效，主题不是关键数据
      if (user) {
        api.patch<UserPreferences>('/users/me/preferences', { theme: next }).catch(() => {});
      }
    },
    [user],
  );

  const value = useMemo<ThemeContextValue>(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme 必须在 <ThemeProvider> 内使用');
  return context;
}
