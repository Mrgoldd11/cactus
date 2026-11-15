/** Выбор текста по языку интерфейса для меню и диалогов главного процесса. */
import type { Lang } from '../shared/api.ts';

export function pick<T>(lang: Lang, ru: T, en: T, zh: T): T {
  return lang === 'ru' ? ru : lang === 'zh' ? zh : en;
}
