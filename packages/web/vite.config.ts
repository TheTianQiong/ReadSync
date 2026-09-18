import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Tailwind v4 走 `@tailwindcss/vite` 插件，样式入口在 src/index.css，
 * 因此这里没有 tailwind.config.js —— v4 的配置是 CSS-first 的。
 *
 * 开发时代理到后端（默认 3000 端口）：
 *  - /api    站点自身接口
 *  - /users  KOSync 兼容端点的认证部分（KOReader 用）
 *  - /syncs  KOSync 兼容端点的进度部分
 * 生产环境由后端或反向代理托管静态资源，同源部署无需代理。
 */
const BACKEND = process.env.READSYNC_BACKEND ?? 'http://localhost:3000';

const proxyTarget = (): { target: string; changeOrigin: boolean } => ({
  target: BACKEND,
  changeOrigin: true,
});

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': proxyTarget(),
      '/users': proxyTarget(),
      '/syncs': proxyTarget(),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // recharts 及其 d3 依赖体积可观，而只有首页/阅读状态用到图表；
    // 拆成独立 chunk，登录页与书库页就不必先下载它。
    // Vite 8 底层是 rolldown，manualChunks 只接受函数形式。
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'charts';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
