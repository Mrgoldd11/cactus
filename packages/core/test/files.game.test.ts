/**
 * Checks on the installed game's files. The path comes from KENSHI_DIR / kenshi-paths.json
 * (see README); without the game all tests here are skipped.
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
 * Mods that fail the round trip, with a diagnosis. Empty now: on 106 mods from
 * the Workshop and mods/ everything matches byte for byte.
 */
const KNOWN_MOD_EXCEPTIONS = new Map<string, string>();

/** Vanilla record types missing from fcs.def: FCS shows them in its own windows. */
// DIALOG_ACTION is not in fcs.def, its fields are built into the schema (builtin-enums.ts).
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
  describe('vanilla files are written byte for byte', () => {
    it.each((game ? vanillaFilePaths(paths) : []).map((p) => [basename(p), p]))('%s', (_, p) => {
      expectRoundTrip(p);
    });
  });

  describe('installed mods are written byte for byte', () => {
    const mods = game ? installedModFiles(paths) : [];
    it('mods found', () => {
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

  describe('schema', () => {
    const schema = game ? loadGameSchema(paths) : undefined;

    it('loads; warnings — only the known typo in fcs_enums.def', () => {
      expect(schema!.types.size).toBeGreaterThan(70);
      expect(schema!.enums.size).toBeGreaterThan(30);
      expect(schema!.layout.length).toBeGreaterThan(10);
      expect(schema!.warnings.map((w) => `${w.source}: ${w.message}`)).toEqual(['fcs_enums.def: значения без запятой: «CARAVAN. MILITARY»']);
    });

    it('fcs.def describes all vanilla types except known ones; with fields from the data — all', () => {
      const raw = analyzeCoverage(schema!, vanilla());
      expect(raw.typesWithoutSchema).toEqual(TYPES_WITHOUT_FCS_DEF);

      const full = withInferredFields(schema!, vanilla().map((v) => v.file));
      const covered = analyzeCoverage(full, vanilla());
      expect(covered.typesWithoutSchema).toEqual([]);
      expect(covered.missingInSchema).toEqual([]);
      for (const t of TYPES_WITHOUT_FCS_DEF) expect(full.types.get(t)?.inferred).toBe(true);
    });

    it('type numbers match the "Type:" comments in gamedata.po', () => {
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
