import { useEffect, useRef, useState } from 'react';

export type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface UseAutoSaveOptions<T> {
  /** The value to watch. When it changes (after mount), the save is triggered. */
  value: T;
  /** The async function to call to persist the value. */
  onSave: (value: T) => Promise<void>;
  /** Debounce delay in ms. Defaults to 600. */
  delay?: number;
  /** Skip saving on the very first render (initial data load). Defaults to true. */
  skipInitial?: boolean;
}

/**
 * Debounced auto-save hook. Fires `onSave` after the value has stopped
 * changing for `delay` ms. Guards against stale closures by always reading
 * the latest value from a ref, and skips the initial mount to avoid
 * overwriting server data on load.
 *
 * Returns { saveState } — 'idle' | 'saving' | 'saved' | 'error'
 */
export function useAutoSave<T>({
  value,
  onSave,
  delay = 600,
  skipInitial = true,
}: UseAutoSaveOptions<T>): { saveState: AutoSaveState } {
  const [saveState, setSaveState] = useState<AutoSaveState>('idle');

  // Always hold the latest value and save function without triggering re-runs
  const valueRef = useRef(value);
  const onSaveRef = useRef(onSave);
  const isFirstRender = useRef(skipInitial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs current
  useEffect(() => {
    valueRef.current = value;
  });
  useEffect(() => {
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Clear any pending timers
    if (timerRef.current) clearTimeout(timerRef.current);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);

    setSaveState('saving');

    timerRef.current = setTimeout(async () => {
      try {
        await onSaveRef.current(valueRef.current);
        setSaveState('saved');
        feedbackTimerRef.current = setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        setSaveState('error');
        feedbackTimerRef.current = setTimeout(() => setSaveState('idle'), 3000);
      }
    }, delay);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay]);

  return { saveState };
}
