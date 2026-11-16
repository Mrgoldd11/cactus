/**
 * Stage 5 graphs: research (requirements, cost, what it unlocks, blueprints), crafting benches
 * (what they make and from what), squad and town makeup (who, how many, chance, faction residents) and
 * editing reference values as one undo, saving only the diff.
 */
import { describe, expect, it } from 'vitest';
import {
  craftingStations,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  ModContext,
  readDataFile,
  researchGraph,
  setLinkValues,
  squadComposition,
  townComposition,
  writeDataFile,
  type DataFile,
  type GameRecord,
} from '../src/index.ts';

const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

function rec(type: string, sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(itemTypeId(type)!, sid, encodeText(name));
  fill(r);
  return r;
}
const ref = (target: string, v0 = 0, v1 = 0, v2 = 0): { target: string; v0: number; v1: number; v2: number } => ({ target, v0, v1, v2 });

function make(): ModContext {
  return new ModContext({
    layers: [
      {
        name: 'gamedata.base',
        file: file([
          rec('ITEM', 'book', 'Book'),
          rec('ITEM', 'cloth', 'Cloth', (r) => r.refs.set('ingredients', [ref('hemp', 300)])),
          rec('ITEM', 'hemp', 'Hemp'),
          rec('ITEM', 'kit', 'First aid kit', (r) => {
            r.ints.set('production time', 3);
            r.refs.set('ingredients', [ref('cloth', 100), ref('hemp', 200)]);
          }),
          rec('RESEARCH', 'r1', 'Tech 1', (r) => r.refs.set('cost', [ref('book', 2)])),
          rec('RESEARCH', 'r2', 'Medicine', (r) => {
            r.ints.set('level', 2);
            r.strings.set('category', encodeText('Crafting'));
            r.refs.set('requirements', [ref('r1')]);
            r.refs.set('enable buildings', [ref('bench')]);
            r.refs.set('enable item', [ref('kit', 1)]);
            r.refs.set('blueprint item', [ref('book')]);
          }),
          rec('VENDOR_LIST', 'v1', 'Book shop', (r) => r.refs.set('blueprints', [ref('r2', 10)])),
          rec('BUILDING_FUNCTIONALITY', 'f1', 'medical crafting', (r) => {
            r.ints.set('tech level', 100);
            r.refs.set('item crafts', [ref('kit', 5)]);
            r.refs.set('consumes', [ref('cloth', 5, 100)]);
          }),
          rec('BUILDING_FUNCTIONALITY', 'f2', 'bed'),
          rec('BUILDING', 'bench', 'Medical bench', (r) => r.refs.set('functionality', [ref('f1')])),
          rec('BUILDING', 'bed', 'Bed', (r) => r.refs.set('functionality', [ref('f2')])),
          rec('CHARACTER', 'boss', 'Boss'),
          rec('CHARACTER', 'guard', 'Guard'),
          rec('CHARACTER', 'rare', 'Rare guy'),
          rec('SQUAD_TEMPLATE', 'sq', 'Guards', (r) => {
            r.bools.set('is trader', true);
            r.ints.set('num random chars', 1);
            r.ints.set('num random chars max', 2);
            r.refs.set('leader', [ref('boss', 1)]);
            r.refs.set('squad', [ref('guard', 2, 4)]);
            r.refs.set('choosefrom list', [ref('rare', 30)]);
            r.refs.set('vendors', [ref('v1', 50)]);
            r.refs.set('faction', [ref('fac')]);
          }),
          rec('SQUAD_TEMPLATE', 'bar', 'Drinkers'),
          rec('SQUAD_TEMPLATE', 'pol', 'Police'),
          rec('FACTION', 'fac', 'Union', (r) => r.refs.set('residents', [ref('pol', 3, 1)])),
          rec('TOWN', 'town', 'Bark', (r) => {
            r.ints.set('type', 2);
            r.refs.set('faction', [ref('fac')]);
            r.refs.set('residents', [ref('sq', 1, 2)]);
            r.refs.set('bar squads', [ref('bar', 1, 50)]);
          }),
        ]),
      },
    ],
    modName: 'Graphs.mod',
  });
}

describe('stage 5 graphs', () => {
  it('research: requirements, cost, what it unlocks, blueprint and where it is sold', () => {
    const g = researchGraph(make());
    expect(g.nodes.map((n) => n.sid)).toEqual(['r1', 'r2']);
    expect(g.categories).toEqual(['Core', 'Crafting']);
    const [r1, r2] = g.nodes;
    expect(r1).toMatchObject({ category: 'Core', level: 1, time: 12, cost: [{ sid: 'book', amount: 2 }], requires: [] });
    expect(r2!.requires).toEqual([{ from: 'r2', category: 'requirements', target: 'r1', values: [0, 0, 0], arity: 3 }]);
    expect(r2!.unlocks.map((u) => [u.field, u.sid, u.type])).toEqual([
      ['enable buildings', 'bench', 'BUILDING'],
      ['enable item', 'kit', 'ITEM'],
    ]);
    expect(r2!.blueprint?.sid).toBe('book');
    expect(r2!.soldBy.map((v) => v.sid)).toEqual(['v1']);
  });

  it('crafting: bench → items → ingredients; buildings without production are left out', () => {
    const ctx = make();
    const st = craftingStations(ctx);
    expect(st.map((s) => s.sid)).toEqual(['bench']);
    const s = st[0]!;
    expect(s.functionality.sid).toBe('f1');
    expect(s.techLevel).toBe(100);
    expect(s.consumes).toMatchObject([{ sid: 'cloth', amount: 1 }]);
    expect(s.products).toHaveLength(1);
    expect(s.products[0]).toMatchObject({ sid: 'kit', field: 'item crafts', hours: 3, link: { from: 'f1', category: 'item crafts', values: [5, 0, 0] } });
    expect(s.products[0]!.inputs.map((i) => [i.sid, i.amount])).toEqual([
      ['cloth', 1],
      ['hemp', 2],
    ]);
  });

  it('squad: who, how many, chance, trader; town: residents, bar and faction residents', () => {
    const ctx = make();
    const q = squadComposition(ctx, 'sq')!;
    expect(q.trader).toBe(true);
    expect(q.faction?.sid).toBe('fac');
    expect(q.randomChars).toEqual([1, 2]);
    expect(q.members.map((m) => [m.field, m.sid, m.min, m.max, m.chance])).toEqual([
      ['leader', 'boss', 1, 1, undefined],
      ['squad', 'guard', 2, 4, undefined],
      ['choosefrom list', 'rare', 0, 1, 30],
    ]);
    expect(q.vendors.map((v) => [v.sid, v.percent])).toEqual([['v1', 50]]);
    expect(squadComposition(ctx, 'town')).toBeUndefined();

    const t = townComposition(ctx, 'town')!;
    expect(t.usesFaction).toBe(true);
    expect(t.squads.map((s) => [s.field, s.sid, s.count, s.priority, s.chance, s.link.from])).toEqual([
      ['residents', 'sq', 1, 2, undefined, 'town'],
      ['faction residents', 'pol', 3, 1, undefined, 'fac'],
      ['bar squads', 'bar', 1, undefined, 50, 'town'],
    ]);
    // "residents override": own residents replace the faction residents.
    ctx.setField('town', 'bools', 'residents override', true);
    expect(townComposition(ctx, 'town')!.usesFaction).toBe(false);
  });

  it('editing reference values: one undo, place in the list, only the diff in the mod', () => {
    const ctx = make();
    const l = squadComposition(ctx, 'sq')!.members[1]!.link;
    setLinkValues(ctx, l, [3, 6]);
    expect(ctx.history().undo).toHaveLength(1);
    expect(describeChangeset(ctx, ctx.history().undo[0]!).text.ru).toBe('Изменено «squad» у «Guards»');
    expect(squadComposition(ctx, 'sq')!.members[1]).toMatchObject({ sid: 'guard', min: 3, max: 6 });
    const saved = readDataFile(writeDataFile(ctx.buildModFile()));
    expect(saved.records.map((r) => r.stringId)).toEqual(['sq']);
    expect([...saved.records[0]!.refs.keys()]).toEqual(['squad']);
    // No changes — no step; no such reference — error.
    setLinkValues(ctx, l, [3, 6]);
    expect(ctx.history().undo).toHaveLength(1);
    expect(() => {
      setLinkValues(ctx, { from: 'sq', category: 'squad', target: 'boss' }, [1]);
    }).toThrow(/has no reference/);
    expect(() => {
      setLinkValues(ctx, l, [1.5]);
    }).toThrow(/integer/);
    ctx.undo();
    expect(ctx.modRecords()).toHaveLength(0);
  });
});
