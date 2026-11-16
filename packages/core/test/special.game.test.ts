/**
 * Special editors (stage 5) on the installed game's vanilla. Without the game the tests are skipped.
 */
import { describe, expect, it } from 'vitest';
import { applyBulk, censusNoPackage, compareTable, craftingStations, npcCensus, factionMatrix, parseFieldFilter, previewBulk, researchGraph, squadComposition, townComposition, type Layer, type ModContext } from '../src/index.ts';
import { hasGame, loadModContext, loadVanillaLayers, resolveGamePaths } from '../src/node/index.ts';

const paths = resolveGamePaths();
const game = hasGame(paths);

let vanillaCache: Layer[] | undefined;
const vanilla = (): Layer[] => (vanillaCache ??= loadVanillaLayers(paths));
let ctxCache: ModContext | undefined;
const ctx = (): ModContext => (ctxCache ??= loadModContext({ paths, dependencies: [], vanilla: vanilla(), schema: false }).ctx);

describe.skipIf(!game)('специальные редакторы на ванили', () => {
  it('relation matrix: the Holy Nation is hostile to the United Cities', () => {
    const m = factionMatrix(ctx());
    expect(m.factions.length).toBeGreaterThan(90);
    const hn = m.factions.find((f) => f.sid === '1083-gamedata.base')!;
    expect(hn.name).toBe('The Holy Nation');
    expect(m.cell('1083-gamedata.base', 'defaultEmpireFactionSID')).toMatchObject({ value: -100, explicit: true, kind: 'enemy' });
    // Vanilla is not "mods": who changed it — empty.
    expect(m.layers).toEqual([]);
  });

  it('weapon comparison table: columns from the schema, katana, damage range', () => {
    const t = compareTable(ctx(), 'WEAPON');
    expect(t.rows.length).toBeGreaterThan(40);
    expect(t.defaultColumns).toContain('cut damage multiplier');
    const katana = t.rows.find((r) => r.sid === '476-gamedata.base')!;
    expect(katana.localized).toBeDefined();
    expect(katana.cells.get('cut damage multiplier')!.value).toBeGreaterThan(0);
    const r = t.range('cut damage multiplier')!;
    expect(r.max).toBeGreaterThan(r.min);
  });

  it('bulk edit: weapon price from 300 × 2 — one edit, only the value field in the mod', () => {
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

  it('graphs: research with requirements and cost, crafting benches, makeup of Bark and a cannibal squad', () => {
    const g = researchGraph(ctx());
    expect(g.nodes.length).toBeGreaterThan(150);
    expect(g.categories).toContain('Defence');
    const walls = g.nodes.find((n) => n.sid === '2915-gamedata.base')!;
    expect(walls.requires.map((l) => l.target)).toContain('2910-gamedata.base');
    expect(walls.cost.length).toBeGreaterThan(0);
    expect(walls.unlocks.length).toBeGreaterThan(0);

    const st = craftingStations(ctx());
    expect(st.length).toBeGreaterThan(50);
    expect(st.find((s) => s.sid === '2929-gamedata.base')!.products.length).toBeGreaterThan(20);

    const bark = townComposition(ctx(), '1076-gamedata.base')!;
    expect(bark.usesFaction).toBe(true);
    expect(bark.squads.some((s) => s.field === 'residents')).toBe(true);
    expect(bark.squads.some((s) => s.field === 'faction residents' && s.link.from === 'defaultEmpireFactionSID')).toBe(true);
    expect(bark.squads.some((s) => s.field === 'bar squads')).toBe(true);

    const cannibals = squadComposition(ctx(), '2609-gamedata.base')!;
    expect(cannibals.members.some((m) => m.field === 'leader')).toBe(true);
    expect(cannibals.members.some((m) => m.field === 'squad' && m.max > m.min)).toBe(true);
  });

  it('NPC census: hundreds of characters, Bark and the United Cities in groups, weight by towns', () => {
    const c = npcCensus(ctx());
    expect(c.chars.length).toBeGreaterThan(500);
    expect(c.chars.some((x) => x.unique)).toBe(true);
    expect(c.chars.some(censusNoPackage)).toBe(true);
    const uc = c.byFaction.find((g) => g.key === 'defaultEmpireFactionSID')!;
    expect(uc.chars.length).toBeGreaterThan(10);
    const bark = c.byTown.find((g) => g.key === '1076-gamedata.base')!;
    expect(bark.chars.length).toBeGreaterThan(5);
    expect(c.byFaction.map((g) => g.weight)).toEqual([...c.byFaction.map((g) => g.weight)].sort((a, b) => b - a));
  });
});
