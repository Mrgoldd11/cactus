/** Small shared panel helpers. */
import type { ReactNode } from 'react';
import { useT } from '../../i18n.ts';

/** The panel has nothing to show: the selection does not suit it. */
export function Empty({ text, types }: { text?: string; types?: readonly string[] | undefined }): ReactNode {
  const t = useT();
  // Name the record types the panel follows, so the user knows what to pick.
  const fallback = types?.length ? t.nothingToShowOf(types.join(', ')) : t.nothingToShow;
  return <div className="panel-empty muted">{text ?? fallback}</div>;
}
