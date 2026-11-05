/**
 * Перевод текстов записей из `locale/<язык>/<язык>.translation` — файл того же формата, что
 * `.mod`: запись на каждую переведённую запись игры, строки `textN` (перевод) и
 * `_original_textN` (английский текст, с которого переводили). Так игра переводит реплики
 * диалогов: в `gamedata.po` их нет.
 */
import { decodeText } from '../text.ts';
import type { DataFile } from '../format/types.ts';

export interface TextTranslation {
  text: string;
  /** Английский текст, с которого переведено (`_original_<поле>`). */
  original?: string;
}

/** Строковый id записи → поле → перевод. */
export type TranslationIndex = Map<string, Map<string, TextTranslation>>;

const ORIGINAL = '_original_';

export function indexTranslation(file: DataFile): TranslationIndex {
  const index: TranslationIndex = new Map();
  for (const rec of file.records) {
    const fields = new Map<string, TextTranslation>();
    for (const [k, v] of rec.strings) {
      if (k.startsWith(ORIGINAL)) continue;
      const tr: TextTranslation = { text: decodeText(v) };
      const orig = rec.strings.get(ORIGINAL + k);
      if (orig !== undefined) tr.original = decodeText(orig);
      fields.set(k, tr);
    }
    if (fields.size > 0) index.set(rec.stringId, fields);
  }
  return index;
}

/**
 * Перевод поля, если он есть и сделан с того же английского текста (`current`). Если текст
 * в данных изменён модом, старый перевод к нему не подходит — undefined.
 */
export function translatedText(index: TranslationIndex | undefined, stringId: string, field: string, current: string): string | undefined {
  const tr = index?.get(stringId)?.get(field);
  if (!tr || tr.text === '') return undefined;
  if (tr.original !== undefined && tr.original !== current) return undefined;
  return tr.text;
}
