import { APP_NAME_CN } from '@readsync/shared';
import {
  Activity,
  BookOpen,
  LayoutDashboard,
  Library,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings,
  Shield,
  Sun,
  User as UserIcon,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { THEME_LABELS } from '../lib/theme';
import { cn } from '../lib/utils';

/** README 要求 3：登录后顶部导航固定为这四项，管理员额外多一个后台入口 */
const NAV_ITEMS = [
  { to: '/', label: '首页', icon: LayoutDashboard, end: true },
  { to: '/status', label: '阅读状态', icon: Activity, end: false },
  { to: '/library', label: '个人书库', icon: Library, end: false },
  { to: '/settings', label: '设置', icon: Settings, end: false },
] as const;

const THEME_ORDER = ['light', 'dark', 'system'] as const;
const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

export function Navbar(): ReactNode {
  const { user, settings, isAdmin, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 路由变化后收起抽屉，否则移动端点完链接会看到菜单还盖在页面上
  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  // 点击用户菜单外部时收起
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const ThemeIcon = THEME_ICONS[theme];
  const cycleTheme = (): void => {
    const index = THEME_ORDER.indexOf(theme);
    const next = THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'system';
    setTheme(next);
  };

  const handleLogout = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  const siteName = settings?.siteName ?? APP_NAME_CN;

  const links = (onNavigate?: () => void): ReactNode =>
    NAV_ITEMS.map((item) => (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 font-sans text-sm transition-colors',
            isActive ? 'bg-raised text-ink' : 'text-muted hover:bg-raised hover:text-ink',
          )
        }
      >
        <item.icon size={14} />
        {item.label}
      </NavLink>
    ));

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-[2px]">
      <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-3 px-4">
        {/* 品牌区 */}
        <NavLink to="/" className="flex shrink-0 items-center gap-2 text-ink">
          <BookOpen size={17} />
          <span className="font-serif text-base leading-none">{siteName}</span>
        </NavLink>

        <nav className="hidden items-center gap-0.5 md:flex">{links()}</nav>

        <div className="ml-auto flex items-center gap-1.5">
          {isAdmin ? (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                cn(
                  'hidden items-center gap-1.5 rounded-sm border px-2 py-1 font-sans text-xs transition-colors sm:flex',
                  isActive
                    ? 'border-accent/40 bg-accent-soft text-accent'
                    : 'border-line text-muted hover:bg-raised hover:text-ink',
                )
              }
            >
              <Shield size={12} />
              管理后台
            </NavLink>
          ) : null}

          {/* 主题切换：单按钮循环 白天 → 夜晚 → 跟随系统 */}
          <button
            type="button"
            onClick={cycleTheme}
            title={`主题：${THEME_LABELS[theme]}`}
            aria-label={`切换主题，当前为${THEME_LABELS[theme]}`}
            className="flex size-8 cursor-pointer items-center justify-center rounded-sm border border-line text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <ThemeIcon size={14} />
          </button>

          {/* 用户菜单 */}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex cursor-pointer items-center gap-1.5 rounded-sm border border-line px-2 py-1 font-sans text-xs text-ink-soft transition-colors hover:bg-raised"
            >
              <UserIcon size={13} />
              <span className="hidden max-w-24 truncate sm:inline">
                {user?.displayName || user?.username || '未登录'}
              </span>
            </button>

            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 mt-1 w-44 rounded-sm border border-line-strong bg-surface py-1"
              >
                <div className="border-b border-line px-3 py-1.5">
                  <div className="truncate font-sans text-xs text-ink">{user?.username}</div>
                  <div className="truncate font-sans text-[11px] text-muted">{user?.email}</div>
                </div>
                <MenuItem
                  icon={<Settings size={13} />}
                  label="账号设置"
                  onClick={() => navigate('/settings/profile')}
                />
                {isAdmin ? (
                  <MenuItem
                    icon={<Shield size={13} />}
                    label="管理后台"
                    onClick={() => navigate('/admin')}
                  />
                ) : null}
                <MenuItem
                  icon={<LogOut size={13} />}
                  label="退出登录"
                  danger
                  onClick={() => void handleLogout()}
                />
              </div>
            ) : null}
          </div>

          {/* 移动端抽屉开关 */}
          <button
            type="button"
            onClick={() => setDrawerOpen((open) => !open)}
            aria-label="菜单"
            className="flex size-8 cursor-pointer items-center justify-center rounded-sm border border-line text-muted transition-colors hover:bg-raised hover:text-ink md:hidden"
          >
            {drawerOpen ? <X size={15} /> : <Menu size={15} />}
          </button>
        </div>
      </div>

      {/* 窄屏：导航折叠为下拉抽屉 */}
      {drawerOpen ? (
        <nav className="flex flex-col gap-0.5 border-t border-line px-4 py-2 md:hidden">
          {links()}
          {isAdmin ? (
            <NavLink
              to="/admin"
              className="flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 font-sans text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
            >
              <Shield size={14} />
              管理后台
            </NavLink>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-sans text-xs transition-colors hover:bg-raised',
        danger ? 'text-danger' : 'text-ink-soft',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
