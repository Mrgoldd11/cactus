/**
 * Record names in the data language. The project's context holds the names of one game locale
 * (see `Project.setDataLocale`), so the translated name is simply the one it has; without a data
 * language or a translation the original name is shown.
 */
import { useEffect, useState } from 'react';
import type { ModContext, TranslationIndex } from '@kenshi-editor/core';
import { useDataLocale } from './i18n.ts';
import type { Project } from './project.ts';

/** Name to show: translated, else `fallback`, else the original, else the id. */
export function recordName(ctx: ModContext, sid: string, fallback?: string): string {
  return ctx.localizedName(sid) ?? fallback ?? (ctx.name(sid) || sid);
}

/**
 * Translation of the game texts (dialogue lines) of the data language: null while loading,
 * undefined — none. Reloads when the data language changes.
 */
export function useGameTexts(project: Project): TranslationIndex | undefined | null {
  const dataLocale = useDataLocale();
  const [tr, setTr] = useState<TranslationIndex | undefined | null>(null);
  useEffect(() => {
    let alive = true;
    project.translation().then(
      (x) => {
        if (alive) setTr(x);
      },
      () => {
        if (alive) setTr(undefined);
      },
    );
    return () => {
      alive = false;
    };
  }, [project, dataLocale]);
  return tr;
}
