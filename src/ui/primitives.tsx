/*
 * UI 基础组件：shadcn 风格（Tailwind + 设计令牌），手写轻量实现。
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { bus } from '../lib/events';
import { isTopModal, useModalFocus } from './useModalFocus';
import { t } from '@/lib/i18n';

// ---------------- Button ----------------

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variantClass: Record<Variant, string> = {
  default:
    'bg-primary text-primary-foreground hover:bg-[var(--mx-action-primary-hover)] active:bg-[var(--mx-action-primary-pressed)]',
  secondary:
    'bg-secondary text-secondary-foreground hover:bg-[var(--mx-action-secondary-hover)] active:bg-[var(--mx-action-secondary-hover)]',
  outline:
    'border border-line-control bg-surface-raised hover:bg-[var(--mx-action-secondary-hover)] aria-expanded:bg-[var(--mx-action-secondary-hover)]',
  ghost: 'hover:bg-[var(--mx-action-secondary-hover)] active:bg-[var(--mx-action-secondary-hover)]',
  destructive:
    'bg-destructive text-destructive-foreground hover:bg-[var(--mx-status-error-text)] hover:brightness-95 active:brightness-90',
  link: 'text-primary underline-offset-4 hover:underline',
};

const sizeClass: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-[42px] px-4 text-sm',
  lg: 'h-11 px-6 text-sm',
  icon: 'h-[42px] w-[42px]',
};

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow] duration-[120ms] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:bg-[var(--mx-action-disabled-bg)] disabled:text-[var(--mx-action-disabled-text)] ${variantClass[variant]} ${sizeClass[size]} ${className}`}
      {...props}
    />
  );
}

// ---------------- Input / Textarea / Select ----------------

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`flex h-[42px] w-full rounded-md border border-line-control bg-surface-raised px-3 py-1 text-sm transition-[border-color,box-shadow] duration-[120ms] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:bg-[var(--mx-action-disabled-bg)] disabled:text-[var(--mx-action-disabled-text)] ${className}`}
      {...props}
    />
  );
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`flex min-h-[84px] w-full rounded-md border border-line-control bg-surface-raised px-3 py-2 text-sm leading-[22px] transition-[border-color,box-shadow] duration-[120ms] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:bg-[var(--mx-action-disabled-bg)] disabled:text-[var(--mx-action-disabled-text)] ${className}`}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`flex h-[42px] w-full rounded-md border border-line-control bg-surface-raised px-3 py-1 text-sm transition-[border-color,box-shadow] duration-[120ms] focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:bg-[var(--mx-action-disabled-bg)] disabled:text-[var(--mx-action-disabled-text)] ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

// ---------------- Switch ----------------

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-[120ms] before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-[''] disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-[var(--mx-border-control)]'
      }`}
    >
      <span
        className={`block h-[18px] w-[18px] rounded-full bg-white shadow-xs transition-transform duration-[120ms] ${
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

// ---------------- Slider ----------------

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  className = '',
  ariaLabel,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={`relative flex h-6 w-full items-center ${className}`}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 h-1 rounded-full"
        style={{
          background: `linear-gradient(to right, hsl(var(--primary)) 0%, hsl(var(--primary)) ${progress}%, hsl(var(--muted)) ${progress}%, hsl(var(--muted)) 100%)`,
        }}
      />
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="relative h-6 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow"
      />
    </div>
  );
}

// ---------------- Dialog ----------------

const DialogCtx = createContext<{ close: () => void; titleId?: string; root?: RefObject<HTMLElement|null> }>({ close: () => {} });
export function useDialogClose() {
  return useContext(DialogCtx).close;
}

export function Dialog({
  open,
  onClose,
  children,
  className = '',
  dismissable = true,
  width,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  dismissable?: boolean;
  width?: number;
}) {
  const root = useRef<HTMLDivElement>(null), parent = useContext(DialogCtx), titleId = useId();
  useModalFocus(root,open,dismissable?onClose:undefined,undefined,parent.root);
  if (!open) return null;
  const dismiss = () => {if(dismissable && isTopModal(root.current))onClose();};
  return createPortal(
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{background:'var(--mx-scrim)'}}>
      <div
        className="absolute inset-0"
        onClick={dismiss}
      />
      <div
        className={`relative z-10 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-surface-overlay p-6 text-card-foreground shadow-popover ${className}`}
        style={width ? { maxWidth: width } : undefined}
      >
        <DialogCtx value={{ close: onClose, titleId, root }}>
          {dismissable && (
            <button
              type="button"
              onClick={dismiss}
              className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-accent"
              aria-label={t('关闭')}
            >
              <X size={16} />
            </button>
          )}
          {children}
        </DialogCtx>
      </div>
    </div>,document.body,
  );
}

export function DialogTitle({ children }: { children: ReactNode }) {
  const {titleId} = useContext(DialogCtx);
  return <h2 id={titleId} className="mb-1 pr-6 text-[17px] font-semibold leading-6">{children}</h2>;
}
export function DialogDesc({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-sm text-muted-foreground">{children}</p>;
}

// ---------------- Toast（底部居中，最多 3 条，4s 消失） ----------------

export interface ToastItem {
  id: number;
  type: 'error' | 'success' | 'info' | 'warning';
  title: string;
  description?: string;
}

let toastSeq = 1;
const toastListeners = new Set<(items: ToastItem[]) => void>();
let toasts: ToastItem[] = [];

export function showToast(input: { type?: ToastItem['type']; title: string; description?: string }) {
  const item: ToastItem = {
    id: toastSeq++,
    type: input.type ?? 'info',
    title: input.title,
    description: input.description,
  };
  toasts = [...toasts.slice(-2), item];
  toastListeners.forEach((l) => l(toasts));
  window.setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== item.id);
    toastListeners.forEach((l) => l(toasts));
  }, 4000);
}

export function ToastViewport() {
  const [items, setItems] = useState<ToastItem[]>(toasts);
  useEffect(() => {
    toastListeners.add(setItems);
    const off=bus.on<Parameters<typeof showToast>[0]>('toast',showToast);
    return () => {
      off();
      toastListeners.delete(setItems);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[1000] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4">
      {items.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto w-full rounded-md border px-4 py-3 text-sm shadow-popover ${
            item.type === 'error'
              ? 'border-[var(--mx-status-error-border)] bg-[var(--mx-status-error-bg)] text-[var(--mx-status-error-text)]'
              : item.type === 'success'
                ? 'border-[var(--mx-status-success-border)] bg-[var(--mx-status-success-bg)] text-[var(--mx-status-success-text)]'
                : item.type === 'warning'
                  ? 'border-[var(--mx-status-warning-border)] bg-[var(--mx-status-warning-bg)] text-[var(--mx-status-warning-text)]'
                  : 'border-line bg-surface-overlay text-card-foreground'
          }`}
        >
          <div className="font-medium">{item.title}</div>
          {item.description && <div className="mt-0.5 text-xs opacity-80">{item.description}</div>}
        </div>
      ))}
    </div>
  );
}

// ---------------- Badge / Card ----------------

export function Badge({
  children,
  variant = 'default',
  className = '',
}: {
  children: ReactNode;
  variant?: 'default' | 'secondary' | 'outline' | 'destructive' | 'amber';
  className?: string;
}) {
  const cls = {
    default: 'bg-selection text-selection-fg border-transparent',
    secondary: 'bg-secondary text-secondary-foreground border-transparent',
    outline: 'border-input text-foreground',
    destructive: 'bg-destructive/10 text-destructive border-destructive/20',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  }[variant];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium ${cls} ${className}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-line bg-surface-raised text-card-foreground shadow-card ${className}`}>{children}</div>
  );
}

export function SectionHeader({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold leading-5">{title}</h3>
        {desc && <p className="mt-1 text-xs leading-[18px] text-muted-foreground">{desc}</p>}
      </div>
      {right}
    </div>
  );
}

/** 设置行（图标 + 标题 + 描述 + 控件） */
export function SettingRow({
  icon,
  title,
  desc,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="mt-0.5 text-muted-foreground">{icon}</span>}
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {desc && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{desc}</div>}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

// ---------------- 确认框 ----------------

export function ConfirmDialog({
  open,
  title,
  body,
  onConfirm,
  onCancel,
  confirmText = t('删除'),
}: {
  open: boolean;
  title: string;
  body?: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
}) {
  return (
    <Dialog open={open} onClose={onCancel} className="max-w-sm">
      <DialogTitle>{title}</DialogTitle>
      {body ? <p className="mb-4 text-sm text-muted-foreground">{body}</p> : <div className="mb-4" />}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('取消')}
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          {confirmText}
        </Button>
      </div>
    </Dialog>
  );
}

/** 点击外部关闭的容器 */
export function useEscapeKey(enabled: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onEscape(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled, onEscape]);
}

export function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside();
      }
    };
    let disposed = false;
    const timer = window.setTimeout(() => {if(!disposed)document.addEventListener('mousedown', handler);}, 0);
    return () => {disposed=true;window.clearTimeout(timer);document.removeEventListener('mousedown', handler);};
  }, [onOutside]);
  return ref;
}
