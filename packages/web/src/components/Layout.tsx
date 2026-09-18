import type { ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Footer } from './Footer';
import { Navbar } from './Navbar';

/**
 * 登录后的主框架：顶部导航 + 内容区 + 页脚。
 * 内容区限宽在 6xl，墨水屏阅读体验下过宽的行长会显著降低可读性。
 */
export function Layout(): ReactNode {
  const location = useLocation();

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <Navbar />
      {/* key 跟随路径变化，让切换页面时内容区自然回到顶部并重挂载 */}
      <main key={location.pathname} className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
