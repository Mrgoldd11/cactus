/**
 * Специальные редакторы (этап 5) на ванили установленной игры. Без игры тесты пропускаются.
 */
import { describe, expect, it } from 'vitest';
import { compareTable, factionMatrix, type Layer, type ModContext } from '../src/index.ts';
import { hasGame, loadModContext, loadVanillaLayers, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

let vanillaCache: Layer[] | undefined;
const vanilla = (): Layer[] => (vanillaCache ??= loadVanillaLayers(paths));
let ctxCache: ModContext | undefined;
const ctx = (): ModContext => (ctxCache ??= loadModContext({ paths, dependencies: [], vanilla: vanilla(), schema: false }).ctx);

describe.skipIf(!game)('специальные редакторы на ванили', () => {
  it('матрица отношений: Священная нация враждует с Объединёнными городами', () => {
    const m = factionMatrix(ctx());
    expect(m.factions.length).toBeGreaterThan(90);
    const hn = m.factions.find((f) => f.sid === '1083-gamedata.base')!;
    expect(hn.name).toBe('The Holy Nation');
    expect(m.cell('1083-gamedata.base', 'defaultEmpireFactionSID')).toMatchObject({ value: -100, explicit: true, kind: 'enemy' });
    // Ваниль — не «моды»: кто поменял — пусто.
    expect(m.layers).toEqual([]);
  });

  it('таблица сравнения оружия: столбцы из схемы, катана, диапазон урона', () => {
    const t = compareTable(ctx(), 'WEAPON');
    expect(t.rows.length).toBeGreaterThan(40);
    expect(t.defaultColumns).toContain('cut damage multiplier');
    const katana = t.rows.find((r) => r.sid === '476-gamedata.base')!;
    expect(katana.ru).toBeDefined();
    expect(katana.cells.get('cut damage multiplier')!.value).toBeGreaterThan(0);
    const r = t.range('cut damage multiplier')!;
    expect(r.max).toBeGreaterThan(r.min);
  });
});
