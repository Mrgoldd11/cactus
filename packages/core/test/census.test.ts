/**
 * Перепись NPC: фракция (своя, отряда или города), города через отряды (в том числе жители
 * фракции), группы с весом «сколько городов», отметка «уже в моде» и выдача пакета диалогов
 * одной отменой.
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

describe('перепись NPC', () => {
  it('фракция, города через отряды и жителей фракции, клик-диалоги, группы с весом', () => {
    const c = npcCensus(make());
    const by = new Map(c.chars.map((x) => [x.sid, x]));
    expect(by.get('boss')).toMatchObject({ unique: true, factions: ['fac'], towns: ['a', 'b'], squads: ['sq'], packages: ['pk'], talks: 1 });
    // Своей фракции нет и у отряда нет — берётся фракция городов.
    expect(by.get('guard')).toMatchObject({ unique: false, factions: ['fac'], towns: ['a', 'b'], talks: 0 });
    // Жители фракции живут во всех её городах.
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

  it('пакет диалогов выбранным: одна отмена, «уже в моде», в моде только ссылки', () => {
    const ctx = make();
    expect(addDialoguePackage(ctx, ['guard', 'boss', 'cop'], 'pk')).toBe(2);
    expect(ctx.history().undo).toHaveLength(1);
    expect(describeChangeset(ctx, ctx.history().undo[0]!).ru).toBe('Пакет диалогов «Talk» → 2 персонажам');
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
    // Повтор — некому добавлять; не пакет — ошибка.
    expect(addDialoguePackage(ctx, ['guard'], 'pk')).toBe(0);
    expect(ctx.history().undo).toHaveLength(1);
    expect(() => addDialoguePackage(ctx, ['guard'], 'd1')).toThrow(/не пакет/);
    ctx.undo();
    expect(ctx.modRecords()).toHaveLength(0);
  });
});
