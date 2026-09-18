import { BookOpen } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Spinner } from './components/ui/Spinner';
import { ToastProvider } from './components/ui/Toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { Audit } from './pages/admin/Audit';
import { AdminLayout } from './pages/admin/AdminLayout';
import { Invites } from './pages/admin/Invites';
import { Plugins } from './pages/admin/Plugins';
import { SiteSettings } from './pages/admin/SiteSettings';
import { Users } from './pages/admin/Users';
import { BookDetail } from './pages/BookDetail';
import { Bootstrap } from './pages/Bootstrap';
import { Dashboard } from './pages/Dashboard';
import { ForgotPassword } from './pages/ForgotPassword';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { ReadingStatus } from './pages/ReadingStatus';
import { Settings } from './pages/Settings';
import { Profile } from './pages/settings/Profile';
import { Security } from './pages/settings/Security';
import { Platforms } from './pages/settings/Platforms';
import { Storages } from './pages/settings/Storages';
import { SyncAccount } from './pages/settings/SyncAccount';

/**
 * 应用根组件。
 *
 * Provider 顺序有讲究：
 *  - BrowserRouter 最外层，AuthProvider 内部要用 navigate 相关的状态；
 *  - ThemeProvider 依赖 AuthContext（登录后同步服务端主题偏好），所以必须在它内层。
 */
export function App(): ReactNode {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * 路由表。
 *
 * README 要求 2 的两条分支在这里体现：
 *  - 站点未初始化（initialized === false）→ 只渲染 Bootstrap，其它路由不可达；
 *  - 未登录 → ProtectedRoute 统一重定向到 /login。
 */
function AppRoutes(): ReactNode {
  const { loading, initialized } = useAuth();

  if (loading) return <BootScreen />;

  // 站点还没有管理员：先完成初始化，避免出现没有任何管理员的半可用站点
  if (initialized === false) {
    return (
      <Routes>
        <Route path="*" element={<Bootstrap />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* 未登录可达 */}
      <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
      <Route path="/forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />

      {/* 已登录区域 */}
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="status" element={<ReadingStatus />} />
          <Route path="library" element={<Library />} />
          <Route path="library/:id" element={<BookDetail />} />

          <Route path="settings" element={<Settings />}>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<Profile />} />
            <Route path="security" element={<Security />} />
            <Route path="platforms" element={<Platforms />} />
            <Route path="storages" element={<Storages />} />
            <Route path="sync" element={<SyncAccount />} />
          </Route>
        </Route>

        {/* 管理后台：再套一层 adminOnly 守卫 */}
        <Route element={<ProtectedRoute adminOnly />}>
          <Route path="/admin" element={<Layout />}>
            <Route element={<AdminLayout />}>
              <Route index element={<SiteSettings />} />
              <Route path="users" element={<Users />} />
              <Route path="invites" element={<Invites />} />
              <Route path="plugins" element={<Plugins />} />
              <Route path="audit" element={<Audit />} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** 已登录用户不该停在登录/注册页 */
function GuestOnly({ children }: { children: ReactNode }): ReactNode {
  const { user } = useAuth();
  return user ? <Navigate to="/" replace /> : <>{children}</>;
}

/** 首屏启动态：公开设置与当前用户都还没确定，先给一个居中的标识，避免白屏闪动 */
function BootScreen(): ReactNode {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-paper">
      <BookOpen size={26} className="text-ink" />
      <Spinner size={18} />
    </div>
  );
}
