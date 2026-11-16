/**
 * Translation of record texts from `locale/<language>/<language>.translation`, a file in the same format as
 * `.mod`: one record per translated game record, strings `textN` (translation) and
 * `_original_textN` (the English text it was translated from). This is how the game translates dialogue
 * lines: they are not in `gamedata.po`.
 */
import { decodeText } from '../text.ts';
import type { DataFile } from '../format/types.ts';

export interface TextTranslation {
  text: string;
  /** English text it was translated from (`_original_<field>`). */
  original?: string;
}

/** Record string id → field → translation. */
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
 * Field translation, if there is one made from the same English text (`current`). If the text
 * in the data was changed by a mod, the old translation does not fit it: undefined.
 */
export function translatedText(index: TranslationIndex | undefined, stringId: string, field: string, current: string): string | undefined {
  const tr = index?.get(stringId)?.get(field);
  if (!tr || tr.text === '') return undefined;
  if (tr.original !== undefined && tr.original !== current) return undefined;
  return tr.text;
}
