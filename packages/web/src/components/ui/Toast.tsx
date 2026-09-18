import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

/**
 * 轻提示。
 *
 * 用于「保存成功 / 删除成功」这类不需要用户决策的反馈；
 * 需要用户确认的操作请用 ConfirmDialog，需要就地展示的校验错误请用表单内的 Alert。
 */

export type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  push: (message: string, tone?: ToastTone) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_META: Record<ToastTone, { className: string; icon: ReactNode }> = {
  info: { className: 'border-line-strong bg-surface text-ink-soft', icon: <Info size={14} /> },
  success: { className: 'border-ochre/40 bg-ochre-soft text-ochre', icon: <CircleCheck size={14} /> },
  error: { className: 'border-danger/40 bg-danger-soft text-danger', icon: <CircleAlert size={14} /> },
};

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((prev) => [...prev, { id, tone, message }]);
      window.setTimeout(() => remove(id), tone === 'error' ? 5000 : 3200);
    },
    [remove],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (message: string) => push(message, 'success'),
      error: (message: string) => push(message, 'error'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-72 flex-col gap-2">
          {items.map((item) => {
            const meta = TONE_META[item.tone];
            return (
              <div
                key={item.id}
                role="status"
                className={cn(
                  'pointer-events-auto flex items-start gap-2 rounded-sm border px-3 py-2 font-sans text-xs leading-relaxed',
                  meta.className,
                )}
              >
                <span className="mt-px shrink-0">{meta.icon}</span>
                <span className="min-w-0 flex-1 break-words">{item.message}</span>
                <button
                  type="button"
                  aria-label="关闭提示"
                  onClick={() => remove(item.id)}
                  className="shrink-0 cursor-pointer opacity-60 hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return context;
}
