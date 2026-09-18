import type { ThemePreference } from '@readsync/shared';

/**
 * 主题读写。
 *
 * 主题是「本地优先」的：即使未登录也必须能立刻切换，所以 localStorage 是权威来源，
 * 登录用户的偏好再由 AuthContext 额外同步到服务端（换设备时恢复）。
 * 这里不引入 React，index.html 里的首帧脚本也用同一套约定（同一个 storage key）。
 */

export const THEME_STORAGE_KEY = 'readsync.theme';
const DARK_MEDIA = '(prefers-color-scheme: dark)';

export function getStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* 隐私模式 */
  }
  return 'system';
}

export function storeTheme(theme: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 忽略 */
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_MEDIA).matches
    : false;
}

export function resolveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

/** 把主题落到 <html>；返回实际生效的明暗值 */
export function applyTheme(theme: ThemePreference): 'light' | 'dark' {
  const resolved = resolveTheme(theme);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  // 让原生控件（滚动条、日期选择器）跟随
  root.style.colorScheme = resolved;
  return resolved;
}

/** 订阅系统配色变化；仅在 theme === 'system' 时才有必要调用 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(DARK_MEDIA);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  light: '白天',
  dark: '夜晚',
  system: '跟随系统',
};
