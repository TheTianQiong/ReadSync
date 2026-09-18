import { APP_NAME, VERSION } from '@readsync/shared';
import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * 页脚。
 *
 * README 要求「版本号显示在前端网页底部」：优先用后端 /api/system/settings 下发的
 * version（保证前后端版本一致，前者才是权威），后端不可用时回退到 shared 里的常量，
 * 这样离线/后端未启动时页脚也不会空着。
 */
export function Footer(): ReactNode {
  const { settings } = useAuth();

  const version = settings?.version ?? VERSION;
  const siteName = settings?.siteName ?? APP_NAME;
  const year = new Date().getFullYear();

  return (
    <footer className="mt-8 border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-1.5 px-4 py-4 text-center sm:flex-row sm:justify-between sm:text-left">
        <p className="font-sans text-[11px] text-muted">
          {settings?.footerText ? (
            settings.footerText
          ) : (
            <>
              © {year} {siteName}
            </>
          )}
        </p>
        <p className="font-mono text-[11px] text-faint">
          {APP_NAME} v{version}
        </p>
      </div>
    </footer>
  );
}
