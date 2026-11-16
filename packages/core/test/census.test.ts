/**
 * NPC census: faction (own, squad or town), towns via squads (including faction
 * residents), groups weighted by "how many towns", the "already in mod" mark and granting a dialogue package
 * as one undo.
 */
import { describe, expect, it } from 'vitest';
import {
  addDialoguePackage,
  censusNoPackage,
  describeChangeset,
  emptyRecord,
  encodeText,
  FileType,
  itemTypeId,
  ModContext,
  npcCensus,
  readDataFile,
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
          rec('CHARACTER', 'guard', 'Guard'),
          rec('CHARACTER', 'boss', 'Boss', (r) => {
            r.bools.set('unique', true);
            r.refs.set('faction', [ref('fac')]);
            r.refs.set('dialogue package', [ref('pk')]);
          }),
          rec('CHARACTER', 'hermit', 'Hermit'),
          rec('CHARACTER', 'cop', 'Cop'),
          rec('DIALOGUE_PACKAGE', 'pk', 'Talk', (r) => r.refs.set('dialogs', [ref('d1', 1)])),
          rec('DIALOGUE', 'd1', 'Hello'),
          rec('SQUAD_TEMPLATE', 'sq', 'Guards', (r) => {
            r.refs.set('leader', [ref('boss', 1)]);
            r.refs.set('squad', [ref('guard', 2, 4)]);
          }),
          rec('SQUAD_TEMPLATE', 'pol', 'Police', (r) => r.refs.set('squad', [ref('cop', 2)])),
          rec('FACTION', 'fac', 'Union', (r) => r.refs.set('residents', [ref('pol', 3, 1)])),
          rec('TOWN', 'a', 'Alpha', (r) => {
            r.refs.set('faction', [ref('fac')]);
            r.refs.set('residents', [ref('sq', 1, 2)]);
          }),
          rec('TOWN', 'b', 'Beta', (r) => {
            r.refs.set('faction', [ref('fac')]);
            r.refs.set('residents', [ref('sq', 1, 2)]);
          }),
        ]),
      },
    ],
    modName: 'Census.mod',
  });
}

describe('NPC census', () => {
  it('faction, towns via squads and faction residents, click dialogues, weighted groups', () => {
    const c = npcCensus(make());
    const by = new Map(c.chars.map((x) => [x.sid, x]));
    expect(by.get('boss')).toMatchObject({ unique: true, factions: ['fac'], towns: ['a', 'b'], squads: ['sq'], packages: ['pk'], talks: 1 });
    // No own faction and none on the squad — the towns' faction is taken.
    expect(by.get('guard')).toMatchObject({ unique: false, factions: ['fac'], towns: ['a', 'b'], talks: 0 });
    // Faction residents live in all of its towns.
    expect(by.get('cop')!.towns).toEqual(['a', 'b']);
    expect(by.get('hermit')).toMatchObject({ factions: [], towns: [], squads: [] });
    expect(censusNoPackage(by.get('guard')!)).toBe(true);
    expect(censusNoPackage(by.get('boss')!)).toBe(false);

    expect(c.byFaction.map((g) => [g.key, g.chars.length, g.weight])).toEqual([
      ['fac', 3, 6],
      ['', 1, 1],
    ]);
    expect(c.byTown.map((g) => [g.key, g.weight])).toEqual([
      ['a', 6],
      ['b', 6],
      ['', 1],
    ]);
  });

  it('dialogue package to the selected: one undo, "already in mod", only references in the mod', () => {
    const ctx = make();
    expect(addDialoguePackage(ctx, ['guard', 'boss', 'cop'], 'pk')).toBe(2);
    expect(ctx.history().undo).toHaveLength(1);
    expect(describeChangeset(ctx, ctx.history().undo[0]!).text.ru).toBe('Пакет диалогов «Talk» → 2 персонажам');
    const c = npcCensus(ctx);
    expect(c.chars.filter((x) => x.status).map((x) => [x.sid, x.status])).toEqual([
      ['guard', 'changed'],
      ['cop', 'changed'],
    ]);
    const saved = readDataFile(writeDataFile(ctx.buildModFile()));
    expect(saved.records.map((r) => [r.stringId, [...r.refs.keys()]])).toEqual([
      ['guard', ['dialogue package']],
      ['cop', ['dialogue package']],
    ]);
    // Repeat — nobody to add to; not a package — error.
    expect(addDialoguePackage(ctx, ['guard'], 'pk')).toBe(0);
    expect(ctx.history().undo).toHaveLength(1);
    expect(() => addDialoguePackage(ctx, ['guard'], 'd1')).toThrow(/not a dialogue package/);
    ctx.undo();
    expect(ctx.modRecords()).toHaveLength(0);
  });
});
