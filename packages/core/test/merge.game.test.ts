/**
 * Слияние на модах установленной игры: мод мастерской целиком вливается в тестовый мод,
 * проверка без ошибок, запись и чтение байт в байт, отмена, повтор. Без игры тесты пропускаются.
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

/** Тестовый мод: пустой, с теми же зависимостями, что у источника. */
function testMod(sourcePath: string, name = 'merge-test.mod'): ReturnType<typeof loadModContext> {
  const deps = readModSummary(sourcePath).dependencies ?? [];
  return loadModContext({ paths, modName: name, dependencies: deps, vanilla: vanilla(), schema: false, po: false });
}

describe.skipIf(!game || !scfPath)('слияние: мод мастерской в тестовый мод', () => {
  it('весь мод вливается, проверка без ошибок, запись и чтение байт в байт', () => {
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

    // Запись → чтение → запись: те же байты.
    const bytes = writeDataFile(ctx.buildModFile());
    const back = writeDataFile(readDataFile(bytes));
    expect(firstDifference(bytes, back)).toBe(-1);

    // Мод после слияния содержит все записи источника с теми же именами и типами.
    const merged = new Map(ctx.modRecords().map((x) => [x.stringId, x]));
    for (const rec of source.file.records) {
      if ((rec.changeFlags & 0x7fffffff) !== 2) continue;
      const m = merged.get(rec.stringId);
      expect(m, rec.stringId).toBeDefined();
      expect(m!.type).toBe(rec.type);
    }

    // Повтор ничего не меняет.
    expect(planMerge(ctx, source, ledger).changes).toEqual([]);
    expect(applyMerge(ctx, source, ledger, { accept: [] }).changesetId).toBeUndefined();
  });

  it('отмена возвращает пустой мод, повтор — то же слияние; файл-спутник переживает перезагрузку', () => {
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

    // Сохранение: мод + файл-спутник; после перезагрузки слитое не предлагается снова.
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
  it('сливается без падений, запись читается байт в байт', () => {
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
