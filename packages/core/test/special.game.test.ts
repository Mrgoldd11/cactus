/**
 * Специальные редакторы (этап 5) на ванили установленной игры. Без игры тесты пропускаются.
 */
import { describe, expect, it } from 'vitest';
import { applyBulk, compareTable, factionMatrix, parseFieldFilter, previewBulk, type Layer, type ModContext } from '../src/index.ts';
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

  it('массовая правка: цена оружия от 300 × 2 — одна правка, в моде только поле value', () => {
    const c = loadModContext({ paths, dependencies: [], vanilla: vanilla(), schema: false }).ctx;
    const p = previewBulk(c, { type: 'WEAPON', fields: [parseFieldFilter('value>=300')] }, { kind: 'mul', field: 'value', value: '2' });
    expect(p.matched).toBeGreaterThan(5);
    expect(p.changes).toHaveLength(p.matched);
    expect(c.modRecords()).toHaveLength(0);
    applyBulk(c, p);
    expect(c.history().undo).toHaveLength(1);
    const recs = c.buildModFile().records;
    expect(recs).toHaveLength(p.changes.length);
    for (const r of recs) expect([...r.ints.keys()]).toEqual(['value']);
    c.undo();
    expect(c.modRecords()).toHaveLength(0);
  });
});
