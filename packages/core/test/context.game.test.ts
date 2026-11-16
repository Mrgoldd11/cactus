/**
 * Editing context on the files of the installed game. Without the game the tests are skipped.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firstDifference, searchRecords, validateMod, writeDataFile, type Layer } from '../src/index.ts';
import { findInstalledMod, hasGame, installedModFiles, loadModContext, loadVanillaLayers, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const SCF = 'Skeleton Cannibal Friend.mod';
const scfPath = game ? findInstalledMod(paths, SCF) : undefined;

let vanillaCache: Layer[] | undefined;
const vanilla = (): Layer[] => (vanillaCache ??= loadVanillaLayers(paths));

describe.skipIf(!game)('контекст на модах игры', () => {
  it('an untouched mod is rebuilt byte for byte (all installed mods)', () => {
    const bad: string[] = [];
    for (const m of installedModFiles(paths)) {
      const bytes = readFileSync(m.path);
      const { ctx } = loadModContext({ paths, modPath: m.path, dependencies: [], vanilla: vanilla(), schema: false, po: false });
      const diff = firstDifference(bytes, writeDataFile(ctx.buildModFile()));
      if (diff !== -1) bad.push(`${basename(m.path)}: байт ${diff}`);
    }
    expect(bad).toEqual([]);
  });

  it('vanilla layers: rebirth.mod changes gamedata.base records', () => {
    const { ctx } = loadModContext({ paths, dependencies: [], vanilla: vanilla(), schema: false, po: false });
    const o = ctx.origin('2604-gamedata.base')!;
    expect(o.status).toBe('base');
    expect(o.origin).toBe('gamedata.base');
    expect(o.layers.length).toBeGreaterThan(1);
  });

  describe.skipIf(!scfPath)(SCF, () => {
    const load = (): ReturnType<typeof loadModContext> => loadModContext({ paths, modPath: scfPath!, vanilla: vanilla() });

    it('statuses, search in Russian, validation without errors', () => {
      const { ctx, missingDependencies } = load();
      expect(missingDependencies).toEqual([]);
      const st = new Map<string, number>();
      for (const r of ctx.modRecords()) st.set(ctx.status(r.stringId)!, (st.get(ctx.status(r.stringId)!) ?? 0) + 1);
      expect(st.get('new')).toBeGreaterThan(200);
      expect(st.get('changed')).toBeGreaterThan(10);
      // "Людоед" exists only in the Russian names.
      const hits = searchRecords(ctx, { text: 'людоед', type: 'CHARACTER' });
      expect(hits.some((h) => h.localizedName !== undefined && h.stringId.endsWith('gamedata.base'))).toBe(true);
      expect(searchRecords(ctx, { modOnly: true, type: 'DIALOGUE' }).length).toBeGreaterThan(3);
      expect(validateMod(ctx).filter((i) => i.severity === 'error')).toEqual([]);
    });

    it('edit and undo give the file back byte for byte', () => {
      const { ctx } = load();
      const bytes = readFileSync(scfPath!);
      const sid = ctx.modRecords().find((r) => ctx.status(r.stringId) === 'changed')!.stringId;
      ctx.renameRecord(sid, 'временное имя');
      expect(firstDifference(bytes, writeDataFile(ctx.buildModFile()))).not.toBe(-1);
      ctx.undo();
      expect(firstDifference(bytes, writeDataFile(ctx.buildModFile()))).toBe(-1);
    });
  });
});
