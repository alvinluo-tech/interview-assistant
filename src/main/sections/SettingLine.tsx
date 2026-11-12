import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

type IconType = (props: { size?: number; className?: string }) => ReactNode;

export function SettingLine({
  icon: Icon,
  title,
  desc,
  align = 'start',
  children,
}: {
  icon: IconType;
  title: string;
  desc?: string;
  align?: 'start' | 'center';
  children: ReactNode;
}) {
  return (
    <div className={`flex justify-between gap-6 px-4 py-3 ${align === 'center' ? 'items-center' : 'items-start'}`}>
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={15} className="mt-0.5 shrink-0 text-ink-muted" />
        <div className="min-w-0">
          <div className="whitespace-nowrap text-[13px] font-medium">{title}</div>
          {desc && <div className="mt-0.5 text-[11px] leading-[18px] text-ink-muted">{desc}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function DisclosureLine({
  icon: Icon,
  title,
  desc,
  open,
  onToggle,
}: {
  icon: IconType;
  title: string;
  desc: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center justify-between gap-6 px-4 py-3 text-left transition-colors hover:bg-[var(--mx-action-secondary-hover)]">
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={15} className="mt-0.5 shrink-0 text-ink-muted" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{title}</div>
          <div className="mt-0.5 truncate text-[11px] leading-[18px] text-ink-muted">{desc}</div>
        </div>
      </div>
      <ChevronRight size={15} className={`shrink-0 text-ink-muted transition-transform duration-[120ms] ${open ? 'rotate-90' : ''}`} />
    </button>
  );
}
