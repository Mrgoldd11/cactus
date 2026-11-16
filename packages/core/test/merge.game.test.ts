/**
 * Merging on the installed game's mods: a Workshop mod is merged whole into a test mod,
 * check without errors, write and read byte for byte, undo, redo. Without the game the tests are skipped.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMerge,
  checkMergeSource,
  firstDifference,
  MergeLedger,
  planMerge,
  readDataFile,
  validateMod,
  writeDataFile,
  type Layer,
} from '../src/index.ts';
import {
  findInstalledMod,
  hasGame,
  installedModFiles,
  loadMergeLedger,
  loadModContext,
  loadVanillaLayers,
  readMergeSource,
  readModSummary,
  resolveGamePaths,
  saveMergeLedger,
} from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);
const SCF = 'Skeleton Cannibal Friend.mod';
const scfPath = game ? findInstalledMod(paths, SCF) : undefined;

let vanillaCache: Layer[] | undefined;
const vanilla = (): Layer[] => (vanillaCache ??= loadVanillaLayers(paths));

const tmp = mkdtempSync(join(tmpdir(), 'kedit-merge-'));
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

/** Test mod: empty, with the same dependencies as the source. */
function testMod(sourcePath: string, name = 'merge-test.mod'): ReturnType<typeof loadModContext> {
  const deps = readModSummary(sourcePath).dependencies ?? [];
  return loadModContext({ paths, modName: name, dependencies: deps, vanilla: vanilla(), schema: false, po: false });
}

describe.skipIf(!game || !scfPath)('слияние: мод мастерской в тестовый мод', () => {
  it('the whole mod merges, check without errors, write and read byte for byte', () => {
    const source = readMergeSource(scfPath!);
    const { ctx } = testMod(scfPath!);
    checkMergeSource(ctx, source.name);
    const ledger = new MergeLedger();
    const plan = planMerge(ctx, source, ledger);
    expect(plan.counts.new).toBeGreaterThan(200);
    expect(plan.counts.conflicts).toBe(0);

    const r = applyMerge(ctx, source, ledger, { accept: plan.changes.filter((c) => !c.blocked).map((c) => c.sid), recursive: true, fixReferences: true });
    expect(r.changesetId).toBeDefined();
    expect(r.created).toBeGreaterThan(200);
    expect(r.dangling).toEqual([]);
    expect(validateMod(ctx).filter((i) => i.severity === 'error')).toEqual([]);

    // Write → read → write: the same bytes.
    const bytes = writeDataFile(ctx.buildModFile());
    const back = writeDataFile(readDataFile(bytes));
    expect(firstDifference(bytes, back)).toBe(-1);

    // After merging the mod contains all source records with the same names and types.
    const merged = new Map(ctx.modRecords().map((x) => [x.stringId, x]));
    for (const rec of source.file.records) {
      if ((rec.changeFlags & 0x7fffffff) !== 2) continue;
      const m = merged.get(rec.stringId);
      expect(m, rec.stringId).toBeDefined();
      expect(m!.type).toBe(rec.type);
    }

    // A repeat changes nothing.
    expect(planMerge(ctx, source, ledger).changes).toEqual([]);
    expect(applyMerge(ctx, source, ledger, { accept: [] }).changesetId).toBeUndefined();
  });

  it('undo returns the empty mod, redo — the same merge; the sidecar file survives a reload', () => {
    const source = readMergeSource(scfPath!);
    const { ctx } = testMod(scfPath!);
    const ledger = new MergeLedger();
    const empty = writeDataFile(ctx.buildModFile());
    const plan = planMerge(ctx, source, ledger);
    applyMerge(ctx, source, ledger, { accept: plan.changes.map((c) => c.sid), recursive: true });
    const merged = writeDataFile(ctx.buildModFile());
    expect(firstDifference(merged, empty)).not.toBe(-1);

    ctx.undo();
    expect(firstDifference(writeDataFile(ctx.buildModFile()), empty)).toBe(-1);
    expect(planMerge(ctx, source, ledger).changes.length).toBe(plan.changes.length);
    ctx.redo();
    expect(firstDifference(writeDataFile(ctx.buildModFile()), merged)).toBe(-1);

    // Saving: mod + sidecar file; after reloading the merged items are not offered again.
    const modPath = join(tmp, 'merge-test.mod');
    writeFileSync(modPath, merged);
    expect(saveMergeLedger(ctx, ledger, modPath)).toBeDefined();
    const again = loadModContext({
      paths,
      modPath,
      dependencies: readModSummary(scfPath!).dependencies ?? [],
      vanilla: vanilla(),
      schema: false,
      po: false,
    });
    expect(firstDifference(readFileSync(modPath), writeDataFile(again.ctx.buildModFile()))).toBe(-1);
    const ledger2 = loadMergeLedger(modPath);
    const left = planMerge(again.ctx, source, ledger2);
    expect(left.changes).toEqual([]);
    expect(left.counts.alreadyMerged + left.counts.identical).toBeGreaterThan(200);
  });
});

describe.skipIf(!game)('слияние: каждый установленный мод в пустой тестовый', () => {
  it('merges without crashing, the written file reads byte for byte', () => {
    const bad: string[] = [];
    let n = 0;
    for (const m of installedModFiles(paths)) {
      if (n >= 6) break;
      let source;
      try {
        source = readMergeSource(m.path);
      } catch {
        continue;
      }
      n++;
      const { ctx } = testMod(m.path);
      try {
        checkMergeSource(ctx, source.name);
      } catch {
        continue;
      }
      const ledger = new MergeLedger();
      const plan = planMerge(ctx, source, ledger);
      applyMerge(ctx, source, ledger, { accept: plan.changes.filter((c) => !c.blocked).map((c) => c.sid), recursive: true });
      const bytes = writeDataFile(ctx.buildModFile());
      const diff = firstDifference(bytes, writeDataFile(readDataFile(bytes)));
      if (diff !== -1) bad.push(`${basename(m.path)}: байт ${diff}`);
    }
    expect(bad).toEqual([]);
  });
});
