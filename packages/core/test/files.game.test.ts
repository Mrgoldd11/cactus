/**
 * Проверки на файлах установленной игры. Путь берётся из KENSHI_DIR / kenshi-paths.json
 * (см. README); если игры нет, все тесты здесь пропускаются.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeCoverage,
  firstDifference,
  indexPoByRecord,
  itemTypeName,
  readDataFile,
  withInferredFields,
  writeDataFile,
  type DataFile,
} from '../src/index.ts';
import { hasGame, installedModFiles, loadGameSchema, loadGamedataPo, resolveGamePaths, vanillaFilePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

/**
 * Моды, которые не проходят round-trip, с диагнозом. Сейчас пусто: на 106 модах из
 * мастерской и mods/ всё сходится байт в байт.
 */
const KNOWN_MOD_EXCEPTIONS = new Map<string, string>();

/** Типы записей ванили, которых нет в fcs.def: FCS показывает их своими окнами. */
// DIALOG_ACTION в fcs.def нет, его поля встроены в схему (builtin-enums.ts).
const TYPES_WITHOUT_FCS_DEF = ['CAMERA', 'DAY_SCHEDULE', 'FOLIAGE_BUILDING', 'ROAD'];

function expectRoundTrip(path: string): DataFile {
  const bytes = readFileSync(path);
  const file = readDataFile(bytes);
  const out = writeDataFile(file);
  const diff = firstDifference(bytes, out);
  expect(diff, `${path}: первое расхождение на байте ${diff} (длины ${bytes.length} и ${out.length})`).toBe(-1);
  return file;
}

let vanillaCache: { label: string; file: DataFile }[] | undefined;
function vanilla(): { label: string; file: DataFile }[] {
  vanillaCache ??= vanillaFilePaths(paths).map((p) => ({ label: basename(p), file: readDataFile(readFileSync(p)) }));
  return vanillaCache;
}

describe.skipIf(!game)(`игра: ${paths.kenshi}`, () => {
  describe('ванильные файлы пишутся байт в байт', () => {
    it.each((game ? vanillaFilePaths(paths) : []).map((p) => [basename(p), p]))('%s', (_, p) => {
      expectRoundTrip(p);
    });
  });

  describe('установленные моды пишутся байт в байт', () => {
    const mods = game ? installedModFiles(paths) : [];
    it('моды найдены', () => {
      expect(mods.length).toBeGreaterThan(0);
    });
    it.each(mods.map((m) => [`${m.source}/${basename(dirname(m.path))}/${basename(m.path)}`, m.path]))('%s', (name, p) => {
      const known = KNOWN_MOD_EXCEPTIONS.get(name);
      if (known !== undefined) {
        expect(() => {
          expectRoundTrip(p);
        }, known).toThrow();
        return;
      }
      expectRoundTrip(p);
    });
  });

  describe('схема', () => {
    const schema = game ? loadGameSchema(paths) : undefined;

    it('загружается; предупреждения — только известная опечатка в fcs_enums.def', () => {
      expect(schema!.types.size).toBeGreaterThan(70);
      expect(schema!.enums.size).toBeGreaterThan(30);
      expect(schema!.layout.length).toBeGreaterThan(10);
      expect(schema!.warnings.map((w) => `${w.source}: ${w.message}`)).toEqual(['fcs_enums.def: значения без запятой: «CARAVAN. MILITARY»']);
    });

    it('fcs.def описывает все типы ванили, кроме известных; с полями из данных — все', () => {
      const raw = analyzeCoverage(schema!, vanilla());
      expect(raw.typesWithoutSchema).toEqual(TYPES_WITHOUT_FCS_DEF);

      const full = withInferredFields(schema!, vanilla().map((v) => v.file));
      const covered = analyzeCoverage(full, vanilla());
      expect(covered.typesWithoutSchema).toEqual([]);
      expect(covered.missingInSchema).toEqual([]);
      for (const t of TYPES_WITHOUT_FCS_DEF) expect(full.types.get(t)?.inferred).toBe(true);
    });

    it('номера типов совпадают с комментариями «Type:» в gamedata.po', () => {
      const po = loadGamedataPo(paths, 'ru_RU');
      expect(po.warnings).toEqual([]);
      const byId = new Map<string, string>();
      for (const { file } of vanilla()) for (const r of file.records) byId.set(r.stringId, itemTypeName(r.type));
      const index = indexPoByRecord(po);
      let checked = 0;
      const wrong: string[] = [];
      for (const rec of index.values()) {
        const actual = byId.get(rec.stringId);
        if (rec.type === undefined || actual === undefined) continue;
        checked++;
        if (actual !== rec.type) wrong.push(`${rec.stringId}: po ${rec.type}, в данных ${actual}`);
      }
      expect(checked).toBeGreaterThan(1000);
      expect(wrong).toEqual([]);
    });
  });
});
