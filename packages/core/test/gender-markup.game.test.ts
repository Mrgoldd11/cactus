/** Gender markup on the real `ru_RU/gamedata.po` and `ru_RU.translation`. Skipped without the game. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { indexTranslation, readDataFile, stripGenderMarkup } from '../src/index.ts';
import { gamedataPoPath, hasGame, loadGamedataPo, resolveGamePaths, translationFilePath } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const po = game && existsSync(gamedataPoPath(paths, 'ru_RU'));
const tr = game && existsSync(translationFilePath(paths, 'ru_RU'));
const LEFT = /\/[а-яё]+\d?\//i;

describe.skipIf(!po)('ru_RU gamedata.po names', () => {
  it('no Cyrillic markup is left in any translated name', () => {
    const file = loadGamedataPo(paths, 'ru_RU');
    const marked = file.entries.map((e) => e.msgstr[0] ?? '').filter((s) => LEFT.test(s));
    expect(marked.length).toBeGreaterThan(50);
    expect(marked.map(stripGenderMarkup).filter((s) => LEFT.test(s) || s.includes('/'))).toEqual([]);
  });
});

describe.skipIf(!tr)('ru_RU.translation lines', () => {
  it('every gender token of the lines is decoded (full words in slashes may stay)', () => {
    const index = indexTranslation(readDataFile(readFileSync(translationFilePath(paths, 'ru_RU'))));
    const left = new Set<string>();
    for (const fields of index.values())
      for (const t of fields.values())
        for (const m of stripGenderMarkup(t.text).matchAll(/\/([а-яё]+)\d?\//gi)) left.add(m[1]!);
    // Translated substitution words such as /брат/ are left: they are not gender markup.
    for (const w of left) expect(w.length, w).toBeGreaterThan(3);
  });
});
