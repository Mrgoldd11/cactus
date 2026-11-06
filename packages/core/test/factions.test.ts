/**
 * Матрица отношений фракций: значения по умолчанию, цвет, асимметрия, «кто поменял», правка
 * одной отменой, сохранение только разницы.
 */
import { describe, expect, it } from 'vitest';
import {
  describeChangeset,
  emptyRecord,
  encodeText,
  factionMatrix,
  FileType,
  itemTypeId,
  ModContext,
  readDataFile,
  relationKind,
  REMOVED_REF_VALUE,
  setFactionRelation,
  writeDataFile,
  type DataFile,
  type GameRecord,
} from '../src/index.ts';

const FACTION = itemTypeId('FACTION')!;
const R = REMOVED_REF_VALUE;

function fac(sid: string, name: string, fill: (r: GameRecord) => void = () => undefined): GameRecord {
  const r = emptyRecord(FACTION, sid, encodeText(name));
  fill(r);
  return r;
}
const rel = (target: string, v0: number) => ({ target, v0, v1: 0, v2: 0 });
const file = (records: GameRecord[]): DataFile => ({ fileType: FileType.Data, lastId: 0, records, tail: new Uint8Array() });

function base(): DataFile {
  return file([
    fac('hn', 'Holy Nation', (r) => r.refs.set('relations', [rel('uc', -100), rel('dc', 0)])),
    fac('uc', 'United Cities', (r) => r.refs.set('relations', [rel('hn', -50)])),
    fac('dc', 'Deadcat', (r) => {
      r.ints.set('default relation', -100);
      r.ints.set('enemy classification', -50);
    }),
  ]);
}

function ctxOf(mods: { name: string; records: GameRecord[] }[] = [], mod?: DataFile): ModContext {
  return new ModContext({
    layers: [{ name: 'gamedata.base', file: base() }, ...mods.map((m) => ({ name: m.name, file: file(m.records) }))],
    modName: 'My.mod',
    ...(mod ? { mod } : {}),
  });
}

describe('матрица отношений', () => {
  it('значение из списка или по умолчанию; цвет по enemy classification и порогу 50', () => {
    const m = factionMatrix(ctxOf());
    expect(m.factions.map((f) => f.sid)).toEqual(['hn', 'uc', 'dc']);
    expect(m.cell('hn', 'uc')).toMatchObject({ value: -100, explicit: true, kind: 'enemy' });
    expect(m.cell('hn', 'dc')).toMatchObject({ value: 0, explicit: true, kind: 'neutral' });
    expect(m.cell('dc', 'hn')).toMatchObject({ value: -100, explicit: false, kind: 'enemy' });
    expect(m.cell('uc', 'dc')).toMatchObject({ value: 0, explicit: false });
    expect(relationKind(-20, -50)).toBe('neutral');
    expect(relationKind(-10)).toBe('enemy');
    expect(relationKind(50)).toBe('ally');
    expect(m.asymmetry('hn', 'uc')).toBe(-50);
    expect(m.asymmetry('hn', 'dc')).toBe(-100);
    expect(m.layers).toEqual([]);
  });

  it('видно, какой мод что поменял (и убрал)', () => {
    const a = { name: 'A.mod', records: [fac('hn', 'Holy Nation', (r) => r.refs.set('relations', [rel('uc', 20)]))] };
    const b = { name: 'B.mod', records: [fac('hn', 'Holy Nation', (r) => r.refs.set('relations', [{ target: 'uc', v0: R, v1: R, v2: R }, rel('dc', 60)]))] };
    const m = factionMatrix(ctxOf([a, b]));
    // Итог: B убрал hn → uc (снова по умолчанию 0), hn → dc = 60.
    expect(m.cell('hn', 'uc')).toMatchObject({ value: 0, explicit: false });
    expect(m.cell('hn', 'dc').value).toBe(60);
    expect(m.cell('hn', 'uc').touches).toEqual([{ layer: 'A.mod', value: 20 }, { layer: 'B.mod' }]);
    expect(m.cell('hn', 'dc').touches).toEqual([{ layer: 'B.mod', value: 60 }]);
    expect(m.layers).toEqual(['A.mod', 'B.mod']);
    expect(m.layersOf('hn')).toEqual(['A.mod', 'B.mod']);
    expect(m.layersOf('uc')).toEqual([]);
  });

  it('вернули исходное значение — отношение не считается тронутым, шаги в истории остаются', () => {
    const ctx = ctxOf();
    setFactionRelation(ctx, 'hn', 'dc', 5, { both: true });
    expect(factionMatrix(ctx).cell('hn', 'dc').touches).toEqual([{ layer: 'My.mod', value: 5 }]);
    setFactionRelation(ctx, 'hn', 'dc', 0, { both: true });
    const m = factionMatrix(ctx);
    // hn → dc в ваниле 0 — вернули, не тронуто. dc → hn было −100 (default relation dc), стало 0 — это правда правка.
    expect(m.cell('hn', 'dc')).toMatchObject({ value: 0, touches: [] });
    expect(m.cell('dc', 'hn').touches).toEqual([{ layer: 'My.mod', value: 0 }]);
    expect(ctx.history().undo).toHaveLength(2);
    expect(m.layersOf('hn')).toEqual([]);
  });

  it('правка: одна отмена, обе стороны, сброс; в мод — только разница; понятное название шага', () => {
    const ctx = ctxOf();
    setFactionRelation(ctx, 'hn', 'uc', 20, { both: true });
    expect(ctx.history().undo).toHaveLength(1);
    let m = factionMatrix(ctx);
    expect(m.cell('hn', 'uc').value).toBe(20);
    expect(m.cell('uc', 'hn').value).toBe(20);
    expect(m.cell('hn', 'uc').touches).toEqual([{ layer: 'My.mod', value: 20 }]);
    const t = describeChangeset(ctx, ctx.history().undo.at(-1)!);
    expect(t.ru).toBe('Отношение «Holy Nation» ⇄ «United Cities»: 20');
    expect(t.en).toBe('Relation «Holy Nation» ⇄ «United Cities»: 20');

    setFactionRelation(ctx, 'dc', 'hn', 75);
    expect(factionMatrix(ctx).cell('dc', 'hn')).toMatchObject({ value: 75, explicit: true, kind: 'ally' });
    setFactionRelation(ctx, 'hn', 'dc', undefined);
    m = factionMatrix(ctx);
    expect(m.cell('hn', 'dc')).toMatchObject({ value: 0, explicit: false });
    expect(describeChangeset(ctx, ctx.history().undo.at(-1)!).en).toBe('Relation «Holy Nation» → «Deadcat»: default');

    // В мод — только изменённые ссылки; снятие ванильной — маркер «убрать».
    const saved = readDataFile(writeDataFile(ctx.buildModFile()));
    const hn = saved.records.find((r) => r.stringId === 'hn')!;
    expect(hn.refs.get('relations')).toEqual([rel('uc', 20), { target: 'dc', v0: R, v1: R, v2: R }]);
    expect(saved.records.find((r) => r.stringId === 'dc')!.refs.get('relations')).toEqual([rel('hn', 75)]);

    ctx.undo();
    ctx.undo();
    ctx.undo();
    expect(ctx.modRecords()).toHaveLength(0);
  });

  it('ошибки: не фракция, значение вне диапазона', () => {
    const ctx = ctxOf();
    expect(() => { setFactionRelation(ctx, 'hn', 'nope', 1); }).toThrow(/нет/);
    expect(() => { setFactionRelation(ctx, 'hn', 'uc', 101); }).toThrow(/−100/);
    expect(() => { setFactionRelation(ctx, 'hn', 'uc', 1.5); }).toThrow(/целое/);
    expect(ctx.history().undo).toHaveLength(0);
  });
});
