import { useEffect, useRef, useState } from 'react';

/** Two-click confirm for destructive buttons — Tauri webview doesn't
 *  reliably surface native confirm() dialogs, so we use an inline
 *  state instead. First click flips to a "Confirm?" button that reverts
 *  after 4s; second click within that window fires the action. */
export function useInlineConfirm(
  action: () => void | Promise<void>,
  timeoutMs = 4000,
): { pending: boolean; trigger: () => void } {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const trigger = (): void => {
    if (!pending) {
      setPending(true);
      timerRef.current = setTimeout(() => setPending(false), timeoutMs);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    setPending(false);
    void action();
  };
  return { pending, trigger };
}
