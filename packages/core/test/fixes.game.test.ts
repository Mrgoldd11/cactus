/**
 * The new checks (type changed, id taken, too many references) on the installed game's vanilla files:
 * each vanilla file as the mod over the files below it gives no such issue. Planning fixes and a cleanup
 * scan change nothing: the file still writes byte for byte. Without the game the tests are skipped.
 */
import { describe, expect, it } from 'vitest';
import { firstDifference, ModContext, planFixes, scanCleanup, validateMod, writeDataFile } from '../src/index.ts';
import { hasGame, loadGameSchema, loadVanillaLayers, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const NEW = new Set(['type-changed', 'id-taken', 'too-many-refs']);

describe.skipIf(!game)('fixes and cleanup on vanilla', () => {
  it('no new-check issues on vanilla; scanning and planning keep the bytes', () => {
    const layers = loadVanillaLayers(paths);
    const schema = loadGameSchema(paths);
    for (let i = 1; i < layers.length; i++) {
      const ctx = new ModContext({ layers: layers.slice(0, i), mod: layers[i]!.file, modName: layers[i]!.name, schema });
      const before = writeDataFile(ctx.buildModFile());
      const issues = validateMod(ctx);
      expect(issues.filter((x) => NEW.has(x.code)), layers[i]!.name).toEqual([]);
      planFixes(ctx, issues);
      scanCleanup(ctx);
      expect(firstDifference(writeDataFile(ctx.buildModFile()), before)).toBe(-1);
    }
  }, 120_000);
});
