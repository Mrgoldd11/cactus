import { useSyncExternalStore } from 'react';
import type { Project } from './project.ts';
import { errorText } from './i18n.ts';

/** Номер версии проекта: компонент перерисовывается после каждой правки, отмены и сохранения. */
export function useProjectVersion(p: Project): number {
  return useSyncExternalStore(
    (cb) => p.subscribe(cb),
    () => p.version,
  );
}

/** Выполнить правку; ошибку правки (EditError и др.) вернуть текстом. */
export function tryEdit(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    return errorText(e);
  }
}
