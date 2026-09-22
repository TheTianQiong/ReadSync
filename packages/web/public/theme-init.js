/*
 * 首帧主题初始化。
 *
 * 为什么是独立的 .js 文件而不是 index.html 里的内联 <script>：
 * 生产环境的 CSP 是 script-src 'self'（不含 'unsafe-inline'），内联脚本会被
 * 浏览器直接拦截，主题初始化失效。改成同源外部脚本既符合 CSP，又能保持
 * 「样式表加载前就把 .dark 打到 <html> 上」的时序 —— 否则深色模式下首帧
 * 会先按浅色渲染再翻转，闪一次白屏。
 *
 * 这个文件由 Vite 原样拷贝到构建产物根目录，不做打包（必须保持同步执行）。
 */
(function () {
  try {
    var pref = localStorage.getItem('readsync.theme') || 'system';
    var dark =
      pref === 'dark' ||
      (pref !== 'light' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.classList.toggle('dark', !!dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {
    /* 隐私模式禁用 localStorage 时忽略，交给 React 侧的默认值 */
  }
})();
