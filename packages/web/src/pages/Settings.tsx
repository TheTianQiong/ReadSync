import { Cloud, KeyRound, Link2, MonitorSmartphone, UserCog } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '../lib/utils';

/**
 * 设置页外壳（README 要求 8）。
 *
 * 用子路由而不是单页标签：每个设置分区都可以直接分享链接
 * （例如出问题时让用户打开 /settings/sync 自查），刷新后也停在原地。
 */
const SECTIONS = [
  { to: 'profile', label: '基础设置', description: '资料、时区与主题', icon: UserCog },
  { to: 'security', label: '账号安全', description: '密码、两步验证、登录设备', icon: KeyRound },
  { to: 'platforms', label: '阅读平台', description: '管理用于统计的平台标识', icon: MonitorSmartphone },
  { to: 'storages', label: '存储管理', description: 'WebDAV、对象存储、本地目录', icon: Cloud },
  { to: 'sync', label: '同步账号', description: 'KOSync 与接入令牌', icon: Link2 },
] as const;

export function Settings(): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-serif text-xl text-ink">设置</h1>
        <p className="mt-0.5 font-sans text-xs text-muted">账号、安全、存储与同步配置</p>
      </header>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 窄屏横向滚动，宽屏固定侧栏 */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto pb-1 lg:w-52 lg:flex-col lg:overflow-visible lg:pb-0">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.to}
              to={section.to}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-sm border px-2.5 py-2 transition-colors lg:items-start',
                  isActive
                    ? 'border-line-strong bg-raised text-ink'
                    : 'border-transparent text-muted hover:bg-raised hover:text-ink',
                )
              }
            >
              <section.icon size={14} className="mt-0.5 shrink-0" />
              <span className="flex flex-col">
                <span className="font-sans text-sm whitespace-nowrap">{section.label}</span>
                <span className="hidden font-sans text-[11px] text-muted lg:block">
                  {section.description}
                </span>
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
