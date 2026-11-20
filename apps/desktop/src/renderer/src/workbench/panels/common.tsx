/** Small shared panel helpers. */
import type { ReactNode } from 'react';
import { typeWords, uiText } from '@kenshi-editor/core';
import { useLang, useT } from '../../i18n.ts';

/** The panel has nothing to show: the selection does not suit it. */
export function Empty({ text, types }: { text?: string; types?: readonly string[] | undefined }): ReactNode {
  const t = useT();
  const lang = useLang();
  // Name the record types the panel follows, in words, so the user knows what to pick.
  const words = types?.map((x) => uiText(typeWords(x), lang).toLowerCase());
  const fallback = words?.length ? t.emptyPickOf(words) : t.nothingToShow;
  return (
    <div className="panel-empty muted" {...(types?.length ? { title: types.join(', ') } : {})}>
      {text ?? fallback}
    </div>
  );
}
