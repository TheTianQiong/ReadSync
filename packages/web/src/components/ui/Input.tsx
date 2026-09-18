import type { ComponentPropsWithRef, ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '../../lib/utils';

/**
 * 表单控件。
 *
 * 只用 1px 边框区分层次，focus 时边框加深 + 外描边，
 * 不用 box-shadow 光晕（那是 Material 的语言，与墨水屏冲突）。
 */
const CONTROL_BASE =
  'w-full rounded-sm border border-line bg-surface px-2.5 py-1.5 font-sans text-sm text-ink ' +
  'placeholder:text-faint transition-colors outline-none ' +
  'hover:border-line-strong focus:border-accent focus-visible:outline-2 focus-visible:outline-accent ' +
  'disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted';

export function Input({ className, ...props }: ComponentPropsWithRef<'input'>): ReactNode {
  return <input {...props} className={cn(CONTROL_BASE, 'h-9', className)} />;
}

export function Textarea({ className, ...props }: ComponentPropsWithRef<'textarea'>): ReactNode {
  return <textarea {...props} className={cn(CONTROL_BASE, 'min-h-20 resize-y leading-relaxed', className)} />;
}

export function Select({ className, children, ...props }: ComponentPropsWithRef<'select'>): ReactNode {
  return (
    <select {...props} className={cn(CONTROL_BASE, 'h-9 cursor-pointer appearance-none pr-7', className)}>
      {children}
    </select>
  );
}

export interface FieldProps {
  label?: ReactNode;
  /** 字段说明，显示在控件下方 */
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** 把 label 与控件的 htmlFor/id 关联起来；不传时自动生成 */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** 标签 + 控件 + 提示/错误的组合，保证全站表单的间距与错误样式一致 */
export function Field({ label, hint, error, required, htmlFor, children, className }: FieldProps): ReactNode {
  const generated = useId();
  const id = htmlFor ?? generated;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={id} className="font-sans text-xs tracking-wide text-ink-soft">
          {label}
          {required ? <span className="ml-0.5 text-danger">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="font-sans text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="font-sans text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** 复选框：原生外观足以表达，只统一强调色 */
export function Checkbox({ className, ...props }: ComponentPropsWithRef<'input'>): ReactNode {
  return (
    <input
      {...props}
      type="checkbox"
      className={cn('size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed', className)}
    />
  );
}
