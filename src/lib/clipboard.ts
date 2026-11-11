import {useCallback, useRef, useState} from 'react';

/**
 * Copy text through the Tauri clipboard plugin, falling back to the web API.
 * Returns whether the copy succeeded so the caller can show feedback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const {writeText} = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Copy-on-demand state with a short "copied" window.
 * `getText` is read at click time so streaming content stays current.
 */
export function useCopyFeedback(getText: () => string, holdMs = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const copy = useCallback(() => {
    void copyText(getText()).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), holdMs);
    });
  }, [getText, holdMs]);
  return {copied, copy};
}
