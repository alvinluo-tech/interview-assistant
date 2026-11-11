import { useCallback, useState } from 'react';
import { ConfirmDialog } from '@/ui/primitives';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmText?: string;
}

/**
 * In-app replacement for `window.confirm`: same `await` shape, but it renders
 * the shared dialog so destructive actions look like the rest of the app.
 */
export function useConfirm() {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      }),
    [],
  );
  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.options.title ?? ''}
      body={pending?.options.body}
      confirmText={pending?.options.confirmText}
      onCancel={() => settle(false)}
      onConfirm={() => settle(true)}
    />
  );
  return [confirm, dialog] as const;
}
