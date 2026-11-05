/**
 * Помощник перевода на настоящем RUS-патче мастерской: «Expanded Vanilla Armor RUS» поверх
 * «Expanded Vanilla Armor». Без игры или без этих модов тесты пропускаются.
 */
import { describe, expect, it } from 'vitest';
import {
  applyTranslationRows,
  decodeText,
  formatTranslationCsv,
  formatTranslationPo,
  parseTranslationFile,
  summarizeTranslation,
  translationExtras,
  translationRows,
  type Layer,
} from '../src/index.ts';
import { findInstalledMod, hasGame, loadModContext, loadVanillaLayers, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const ORIG = 'Expanded Vanilla Armor.mod';
const RUS = 'Expanded Vanilla Armor RUS.mod';
const rusPath = game ? findInstalledMod(paths, RUS) : undefined;
const origPath = game ? findInstalledMod(paths, ORIG) : undefined;

let vanillaCache: Layer[] | undefined;
const vanilla = (): Layer[] => (vanillaCache ??= loadVanillaLayers(paths));

describe.skipIf(!rusPath || !origPath)('перевод: RUS-патч мастерской', () => {
  it('статусы и проверка патча: почти всё переведено, кроме текстов ничего не меняет', () => {
    const { ctx } = loadModContext({ paths, modPath: rusPath!, vanilla: vanilla(), schema: false, po: false });
    expect(ctx.info.dependencies).toContain(ORIG);
    const s = summarizeTranslation(translationRows(ctx, ORIG));
    expect(s.total).toBeGreaterThan(500);
    expect(s.done / s.total).toBeGreaterThan(0.9);
    const ex = translationExtras(ctx, [ORIG]);
    expect(ex.nonText).toEqual([]);
    // Дописанные описания там, где у оригинала пусто.
    for (const o of ex.orphans) expect(o.field).toBe('description');
  });

  it('CSV и PO: выгрузка патча → загрузка в пустой мод-перевод даёт те же тексты', () => {
    const { ctx } = loadModContext({ paths, modPath: rusPath!, vanilla: vanilla(), schema: false, po: false });
    const rows = translationRows(ctx, ORIG);
    for (const file of [formatTranslationCsv(rows), formatTranslationPo(ORIG, rows)]) {
      const fresh = loadModContext({ paths, modName: 'test RUS.mod', dependencies: [ORIG], vanilla: vanilla(), schema: false, po: false }).ctx;
      const rep = applyTranslationRows(fresh, ORIG, parseTranslationFile(file).rows);
      expect(rep.stale).toEqual([]);
      expect(rep.unknown).toEqual([]);
      const bad: string[] = [];
      for (const r of rows) {
        if (r.translation === undefined) continue;
        const rec = fresh.get(r.id)!;
        const got = r.field === 'name' ? decodeText(rec.name) : decodeText(rec.strings.get(r.field) ?? new Uint8Array());
        if (got !== r.translation) bad.push(`${r.id} ${r.field}`);
      }
      expect(bad).toEqual([]);
      expect(rep.applied).toBe(rows.filter((r) => r.translation !== undefined).length);
      // Мод-перевод — только тексты.
      expect(translationExtras(fresh, [ORIG]).nonText).toEqual([]);
    }
  });
});
