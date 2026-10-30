/*
 * UI 基础组件：shadcn 风格（Tailwind + 设计令牌），手写轻量实现。
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { X } from 'lucide-react';
import { bus } from '../lib/events';

// ---------------- Button ----------------

type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variantClass: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  secondary: 'bg-secondary text-secondary-foreground hover:opacity-80',
  outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
  link: 'text-primary underline-offset-4 hover:underline',
};

const sizeClass: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-10 px-6 text-sm',
  icon: 'h-9 w-9',
};

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 ${variantClass[variant]} ${sizeClass[size]} ${className}`}
      {...props}
    />
  );
}

// ---------------- Input / Textarea / Select ----------------

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 ${className}`}
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
      className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm transition-colors disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-input'
      }`}
    >
      <span
        className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
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
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[hsl(var(--primary))] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary ${className}`}
    />
  );
}

// ---------------- Dialog ----------------

const DialogCtx = createContext<{ close: () => void }>({ close: () => {} });
export function useDialogClose() {
  return useContext(DialogCtx).close;
}

export function Dialog({
  open,
  onClose,
  children,
  className = '',
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  dismissable?: boolean;
}) {
  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div
        className="absolute inset-0"
        onClick={dismissable ? onClose : undefined}
      />
      <div
        className={`relative z-10 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-5 text-card-foreground shadow-xl ${className}`}
      >
        <DialogCtx.Provider value={{ close: onClose }}>
          {dismissable && (
            <button
              type="button"
              onClick={onClose}
              className="absolute right-3 top-3 rounded p-1 text-muted-foreground hover:bg-accent"
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          )}
          {children}
        </DialogCtx.Provider>
      </div>
    </div>
  );
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-1 pr-6 text-base font-semibold">{children}</h2>;
}
export function DialogDesc({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-sm text-muted-foreground">{children}</p>;
}

// ---------------- Toast（对齐原版：底部居中，最多 3 条，4s 消失） ----------------

export interface ToastItem {
  id: number;
  type: 'error' | 'success' | 'info' | 'warning';
  title: string;
  description?: string;
}

let toastSeq = 1;
const toastListeners = new Set<(items: ToastItem[]) => void>();
let toasts: ToastItem[] = [];

export function showToast(t: { type?: ToastItem['type']; title: string; description?: string }) {
  const item: ToastItem = {
    id: toastSeq++,
    type: t.type ?? 'info',
    title: t.title,
    description: t.description,
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
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto w-full rounded-md border px-4 py-2.5 text-sm shadow-lg ${
            t.type === 'error'
              ? 'border-destructive/30 bg-destructive text-destructive-foreground'
              : t.type === 'success'
                ? 'border-primary/30 bg-primary text-primary-foreground'
                : 'bg-card text-card-foreground'
          }`}
        >
          <div className="font-medium">{t.title}</div>
          {t.description && <div className="mt-0.5 text-xs opacity-80">{t.description}</div>}
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
    default: 'bg-primary/10 text-primary border-primary/20',
    secondary: 'bg-secondary text-secondary-foreground border-transparent',
    outline: 'border-input text-foreground',
    destructive: 'bg-destructive/10 text-destructive border-destructive/20',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  }[variant];
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium ${cls} ${className}`}>
      {children}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border bg-card text-card-foreground shadow-sm ${className}`}>{children}</div>
  );
}

export function SectionHeader({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {right}
    </div>
  );
}

/** 设置行（原版 Tz：图标 + 标题 + 描述 + 控件） */
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
  confirmText = '删除',
}: {
  open: boolean;
  title: string;
  body: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
}) {
  return (
    <Dialog open={open} onClose={onCancel} className="max-w-sm">
      <DialogTitle>{title}</DialogTitle>
      <p className="mb-4 text-sm text-muted-foreground">{body}</p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm}>
          {confirmText}
        </Button>
      </div>
    </Dialog>
  );
}

/** 点击外部关闭的容器 */
export function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside();
      }
    };
    window.setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onOutside]);
  return ref;
}
