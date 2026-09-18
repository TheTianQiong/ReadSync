import { FileClock, Globe, Plug, Ticket, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../../lib/utils';

/**
 * 管理后台外壳（README 要求 9）。
 *
 * 仅管理员可达 —— 权限判断在路由层由 ProtectedRoute adminOnly 完成，
 * 这里只负责布局，不再重复鉴权（否则非管理员会看到两套跳转逻辑）。
 */
const SECTIONS = [
  { to: '/admin', label: '网站管理', icon: Globe, end: true },
  { to: '/admin/users', label: '用户管理', icon: Users, end: false },
  { to: '/admin/invites', label: '邀请码', icon: Ticket, end: false },
  { to: '/admin/plugins', label: '插件管理', icon: Plug, end: false },
  { to: '/admin/audit', label: '审计日志', icon: FileClock, end: false },
] as const;

export function AdminLayout(): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <header className="border-b border-line pb-3">
        <h1 className="font-serif text-xl text-ink">管理后台</h1>
        <p className="mt-0.5 font-sans text-xs text-muted">仅管理员可见，所有操作都会记入审计日志</p>
      </header>

      <nav className="flex gap-1 overflow-x-auto pb-1">
        {SECTIONS.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            end={section.end}
            className={({ isActive }) =>
              cn(
                'flex shrink-0 items-center gap-1.5 rounded-sm border px-2.5 py-1.5 font-sans text-sm transition-colors',
                isActive
                  ? 'border-line-strong bg-raised text-ink'
                  : 'border-transparent text-muted hover:bg-raised hover:text-ink',
              )
            }
          >
            <section.icon size={14} />
            {section.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
