import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PageSpinner } from './ui/Spinner';

/**
 * 路由守卫。
 *
 * README 要求 2：未登录访问首页要跳到「登录/注册」。
 * 同时把来源路径塞进 location.state，登录成功后可以回到用户原本想去的页面。
 *
 * adminOnly 用于管理后台：非管理员直接送回首页，而不是显示一个 403 页面 ——
 * 后台入口本就不该出现在普通用户的导航里，直接跳走更少困惑。
 */
export function ProtectedRoute({ adminOnly = false }: { adminOnly?: boolean }): ReactNode {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <PageSpinner label="正在确认登录状态…" />;

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (adminOnly && user.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
