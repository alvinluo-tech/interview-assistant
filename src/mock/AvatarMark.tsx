/** 面试官头像（矢量占位） */
import { t } from '@/lib/i18n';

export function AvatarMark({ size = 32 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-emerald-500/30 to-sky-500/30 text-neutral-200 ring-1 ring-white/10"
      style={{ width: size, height: size }}
      aria-label={t('面试官')}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="8.5" r="3.6" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="M4.8 20c.7-3.7 3.7-6 7.2-6s6.5 2.3 7.2 6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
