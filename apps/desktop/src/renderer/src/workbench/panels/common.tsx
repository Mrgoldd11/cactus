/** Общие мелочи панелей. */
import type { ReactNode } from 'react';
import { useT } from '../../i18n.ts';

/** Панели нечего показать: выбор ей не подходит. */
export function Empty({ text }: { text?: string }): ReactNode {
  const t = useT();
  return <div className="panel-empty muted">{text ?? t.nothingToShow}</div>;
}
