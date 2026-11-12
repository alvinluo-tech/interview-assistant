/*
 * UI 基础组件：shadcn 风格（Tailwind + 设计令牌），手写轻量实现。
 */
import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  type Ref,
  useRef,
  useState,
  type ChangeEvent,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
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

export function Input({ className = '', ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={`flex h-[42px] w-full rounded-md border border-line-control bg-surface-raised px-3 py-1 text-sm transition-[border-color,box-shadow] duration-[120ms] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:bg-[var(--mx-action-disabled-bg)] disabled:text-[var(--mx-action-disabled-text)] ${className}`}
      {...props}
    />
  );
}

export function Textarea({ className = '', ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      ref={ref}
      className={`flex min-h-[84px] w-full rounded-md border border-line-control bg-surface-raised px-3 py-2 text-sm leading-[22px] transition-[border-color,box-shadow] duration-[120ms] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:bg-[var(--mx-action-disabled-bg)] disabled:text-[var(--mx-action-disabled-text)] ${className}`}
      {...props}
    />
  );
}

type SelectOption = { value: string; label: ReactNode; text: string; disabled: boolean };
type SelectGroup = { label: string | null; options: SelectOption[] };

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

/** 把 `<option>` / `<optgroup>` 子节点读成可渲染的数据，保持原有 value 与顺序。 */
export function readSelectOptions(children: ReactNode): SelectGroup[] {
  const groups: SelectGroup[] = [];
  const push = (label: string | null, option: SelectOption) => {
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.options.push(option);
    else groups.push({ label, options: [option] });
  };
  const walk = (nodes: ReactNode, group: string | null) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as { value?: unknown; children?: ReactNode; disabled?: boolean; label?: string };
      if (child.type === 'option') {
        const value = props.value === undefined ? nodeText(props.children) : String(props.value);
        push(group, { value, label: props.children, text: nodeText(props.children), disabled: Boolean(props.disabled) });
      } else if (child.type === 'optgroup') {
        walk(props.children, props.label ?? '');
      } else if (child.type === Fragment) {
        walk(props.children, group);
      }
    });
  };
  walk(children, null);
  return groups;
}

/**
 * 选择器：原生 select 换成自绘 listbox（方案 A 的打开态合同）。
 * 保留 value/onChange/disabled/id/title/aria-label 语义，调用方无需改。
 * 选项超过 12 项时自动带搜索框（模型库有几百项）。
 */
export function Select({
  className = '',
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  title,
  id,
  'aria-label': ariaLabel,
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const groups = useMemo(() => readSelectOptions(children), [children]);
  const flat = useMemo(() => groups.flatMap((group) => group.options), [groups]);
  const [uncontrolled, setUncontrolled] = useState(() => (defaultValue === undefined ? '' : String(defaultValue)));
  const current = value === undefined ? uncontrolled : String(value);
  const selectedIndex = flat.findIndex((option) => option.value === current);
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : undefined;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const [rect, setRect] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const searchable = flat.length > 12;
  const trimmed = query.trim().toLowerCase();
  const visibleGroups = trimmed
    ? groups
        .map((group) => ({ ...group, options: group.options.filter((option) => option.text.toLowerCase().includes(trimmed)) }))
        .filter((group) => group.options.length > 0)
    : groups;
  const visible = visibleGroups.flatMap((group) => group.options);
  // 外部 className 里已经写了高度/宽度时以它为准（基础类与工具类的先后由产物 CSS 决定，不能赌顺序）。
  const hasHeight = /(^|\s)h-\S/.test(className);
  const hasWidth = /(^|\s)w-\S/.test(className);

  const place = () => {
    const node = triggerRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    setRect({ top: box.top, bottom: box.bottom, left: box.left, width: box.width });
  };

  useEffect(() => {
    if (!open) return;
    place();
    const follow = () => place();
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const focusedRef = useRef(false);
  useEffect(() => {
    // 弹层要等 rect 量好才会渲染，所以焦点也等它挂载后再给（否则 Esc 会落到 Dialog 上）。
    if (!open) {
      focusedRef.current = false;
      return;
    }
    if (!rect || focusedRef.current) return;
    const node = searchable ? searchRef.current : listRef.current;
    if (!node) return;
    focusedRef.current = true;
    node.focus({ preventScroll: true });
  }, [open, rect, searchable]);

  const commit = (next: string) => {
    if (value === undefined) setUncontrolled(next);
    setOpen(false);
    setQuery('');
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
    if (next !== current) {
      onChange?.({ target: { value: next } } as unknown as ChangeEvent<HTMLSelectElement>);
    }
  };

  const openList = () => {
    if (disabled) return;
    setQuery('');
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const move = (delta: number) => {
    if (visible.length === 0) return;
    let index = active;
    for (let step = 0; step < visible.length; step += 1) {
      index = (index + delta + visible.length) % visible.length;
      if (!visible[index].disabled) break;
    }
    setActive(index);
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement | HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // 只关自己：Dialog 的 Esc 处理挂在 document 上，这里先截断。
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation?.();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : visible.length - 1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.key === ' ' && searchable && event.target === searchRef.current) return;
      event.preventDefault();
      const option = visible[active];
      if (option && !option.disabled) commit(option.value);
      return;
    }
    if (event.key === 'Tab') setOpen(false);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openList();
    }
  };

  const spaceBelow = rect ? window.innerHeight - rect.bottom - 12 : 0;
  const spaceAbove = rect ? rect.top - 12 : 0;
  const flip = rect ? spaceBelow < 200 && spaceAbove > spaceBelow : false;
  const listStyle = rect
    ? {
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)),
        width: Math.max(rect.width, 180),
        maxHeight: Math.max(160, Math.min(320, flip ? spaceAbove : spaceBelow)),
        ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      }
    : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onTriggerKeyDown}
        className={`flex ${hasHeight ? '' : 'h-[42px]'} ${hasWidth ? '' : 'w-full'} items-center justify-between gap-2 rounded-md border border-line-control bg-surface-raised px-3 py-1 text-left text-sm transition-[border-color,box-shadow] duration-[120ms] focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:bg-[var(--mx-action-disabled-bg)] disabled:text-[var(--mx-action-disabled-text)] ${className}`}
      >
        <span className="truncate">{selected?.label ?? ''}</span>
        <ChevronDown size={14} className={`shrink-0 text-ink-muted transition-transform duration-[120ms] ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && rect && listStyle
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              data-modal-popup=""
              tabIndex={-1}
              onKeyDown={onListKeyDown}
              className="fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-line bg-surface-overlay p-1 shadow-popover outline-hidden"
              style={{ ...listStyle, borderRadius: 12 }}
            >
              {searchable && (
                <div className="px-1 pb-1">
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onListKeyDown}
                    aria-label={t('搜索选项')}
                    placeholder={t('搜索选项')}
                    className="h-8 w-full rounded-md border border-line-control bg-surface-base px-2 text-[13px] focus-visible:border-ring focus-visible:outline-hidden"
                  />
                </div>
              )}
              {visible.length === 0 ? (
                <div className="px-2 py-6 text-center text-[12px] text-ink-muted">{t('没有匹配的选项')}</div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={onListKeyDown}>
                  {visibleGroups.map((group, groupIndex) => (
                    <div key={`${group.label ?? ''}-${groupIndex}`} role="group" aria-label={group.label ?? undefined}>
                      {group.label && (
                        <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-ink-muted">{group.label}</div>
                      )}
                      {group.options.map((option) => {
                        const index = visible.indexOf(option);
                        const isActive = index === active;
                        const isSelected = option.value === current;
                        return (
                          <button
                            key={`${option.value}-${index}`}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            disabled={option.disabled}
                            data-value={option.value}
                            onMouseEnter={() => setActive(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => commit(option.value)}
                            className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 transition-colors duration-[120ms] ${
                              isActive ? 'bg-selection text-selection-fg' : 'text-ink'
                            } disabled:cursor-not-allowed disabled:opacity-45`}
                          >
                            <span className="truncate">{option.label}</span>
                            {isSelected && <Check size={13} className="shrink-0 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </div>,
            // 放在当前 Dialog 内部：模态的焦点陷阱只认自己的子树；
            // position: fixed 不会被 Dialog 的 overflow 裁掉。
            (triggerRef.current?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body,
          )
        : null}
    </>
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
    <div
      className={`relative flex h-6 w-full items-center rounded-full has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/35 ${className}`}
    >
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
        className="relative h-6 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow"
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
              className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-[120ms] hover:bg-[var(--mx-action-secondary-hover)] hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35"
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
    <div className="flex min-h-[62px] items-center justify-between gap-4 py-[13px]">
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && <span className="flex h-5 w-[14px] shrink-0 items-center justify-center text-muted-foreground">{icon}</span>}
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {desc && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{desc}</div>}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
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
