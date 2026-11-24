import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { Project } from './project.ts';
import { errorText } from './i18n.ts';

/** Project version number: the component re-renders after every edit, undo and save. */
export function useProjectVersion(p: Project): number {
  return useSyncExternalStore(
    (cb) => p.subscribe(cb),
    () => p.version,
  );
}

/** Run an edit; return an edit error (EditError etc.) as text. */
export function tryEdit(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return errorText(e);
  }
}

/**
 * While `open`, close a popup on a mouse press outside `ref` or on Esc. `onClose` may change between
 * renders; the listeners always call the latest one.
 */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) close.current();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, ref]);
}
