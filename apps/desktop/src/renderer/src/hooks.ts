import { useSyncExternalStore } from 'react';
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
