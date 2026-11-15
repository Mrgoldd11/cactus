/** Выбор текста по языку интерфейса для меню и диалогов главного процесса. */
import type { Lang } from '../shared/api.ts';

/** Text for the interface language; a new language needs its entry in every call (the type enforces it). */
export function pick<T>(lang: Lang, texts: Readonly<Record<Lang, T>>): T {
  return texts[lang];
}
