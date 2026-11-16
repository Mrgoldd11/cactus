/**
 * Конфликты модов: одно поле — разные значения, удаление против изменения, `only`, touchedBy.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyRecord,
  encodeText,
  findConflicts,
  formatConflict,
  formatTouches,
  itemTypeId,
  removalMarker,
  REMOVED_REF_VALUE,
  touchedBy,
  type ConflictLayer,
  type GameRecord,
} from '../src/index.ts';

const WEAPON = itemTypeId('WEAPON')!;
const R = REMOVED_REF_VALUE;

function rec(sid: string, edit: (r: GameRecord) => void = () => undefined, name = 'Katana'): GameRecord {
  const r = emptyRecord(WEAPON, sid, encodeText(name));
  edit(r);
  return r;
}

function layer(name: string, ...records: GameRecord[]): ConflictLayer {
  return { name, file: { records } };
}

const vanilla = layer(
  'gamedata.base',
  rec('1-k', (r) => {
    r.floats.set('cut', 1);
    r.floats.set('weight', 5);
    r.refs.set('materials', [{ target: 'iron', v0: 1, v1: 0, v2: 0 }]);
  }),
  rec('2-s', (r) => r.floats.set('cut', 1), 'Sabre'),
);

describe('конфликты модов', () => {
  it('одно поле, разные значения: побеждает поздний; одинаковые значения — не конфликт', () => {
    const a = layer('A.mod', rec('1-k', (r) => { r.floats.set('cut', 1.5); r.floats.set('weight', 4); }));
    const b = layer('B.mod', rec('1-k', (r) => { r.floats.set('cut', 2); r.floats.set('weight', 4); }));
    const found = findConflicts([vanilla, a, b]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sid: '1-k', name: 'Katana', layers: ['A.mod', 'B.mod'] });
    expect(found[0]!.fields).toEqual([
      { id: 'floats:cut', kind: 'scalar', dict: 'floats', key: 'cut', base: '1', values: [{ layer: 'A.mod', value: '1.5' }, { layer: 'B.mod', value: '2' }], winner: 'B.mod' },
    ]);
    expect(formatConflict(found[0]!).join('\n')).toContain('wins B.mod');
    expect(formatConflict(found[0]!, undefined, 'ru').join('\n')).toContain('победит B.mod');
  });

  it('ссылки: разные цели в одной категории — не конфликт; одна цель, удалить против изменить — конфликт', () => {
    const a = layer('A.mod', rec('1-k', (r) => r.refs.set('materials', [{ target: 'steel', v0: 1, v1: 0, v2: 0 }, { target: 'iron', v0: R, v1: R, v2: R }])));
    const b = layer('B.mod', rec('1-k', (r) => r.refs.set('materials', [{ target: 'cloth', v0: 1, v1: 0, v2: 0 }, { target: 'iron', v0: 3, v1: 0, v2: 0 }])));
    const [c] = findConflicts([vanilla, a, b]);
    expect(c!.fields.map((f) => [f.id, f.base, f.values.map((v) => v.value), f.winner])).toEqual([['ref:materials:iron', '1 0 0', ['удалить', '3 0 0'], 'B.mod']]);
  });

  it('удаление записи против изменения', () => {
    const a = layer('A.mod', rec('2-s', (r) => r.floats.set('cut', 3), 'Sabre'));
    const b = layer('B.mod', removalMarker(rec('2-s', () => undefined, 'Sabre')));
    const [c] = findConflicts([vanilla, a, b]);
    expect(c!.fields[0]).toMatchObject({ id: 'record', base: 'есть', values: [{ layer: 'A.mod', value: 'изменить' }, { layer: 'B.mod', value: 'удалить' }], winner: 'B.mod' });
  });

  it('only: только записи и поля, которые задаёт этот мод; ваниль не участвует', () => {
    const a = layer('A.mod', rec('1-k', (r) => r.floats.set('cut', 1.5)));
    const b = layer('B.mod', rec('1-k', (r) => { r.floats.set('cut', 2); r.floats.set('weight', 9); }));
    const c = layer('C.mod', rec('1-k', (r) => r.floats.set('weight', 7)), rec('2-s', (r) => r.floats.set('cut', 4), 'Sabre'));
    const d = layer('D.mod', rec('2-s', (r) => r.floats.set('cut', 5), 'Sabre'));
    expect(findConflicts([vanilla, a, b, c, d]).map((x) => x.sid)).toEqual(['1-k', '2-s']);
    const onlyA = findConflicts([vanilla, a, b, c, d], { only: 'a.MOD' });
    expect(onlyA.map((x) => [x.sid, x.fields.map((f) => f.id)])).toEqual([['1-k', ['floats:cut']]]);
    expect(findConflicts([vanilla, a])).toEqual([]);
  });

  it('новая запись в двух модах: имя и поля сравниваются между собой', () => {
    const a = layer('A.mod', rec('9-new', (r) => r.ints.set('n', 1), 'Новая'));
    const b = layer('B.mod', rec('9-new', (r) => r.ints.set('n', 1), 'Другая'));
    const [c] = findConflicts([vanilla, a, b]);
    expect(c!.fields.map((f) => [f.id, f.base])).toEqual([['name', undefined]]);
  });

  it('touchedBy: что задаёт каждый мод, создание и удаление', () => {
    const a = layer('A.mod', rec('1-k', (r) => r.floats.set('cut', 1.5), 'Катана'));
    const b = layer('B.mod', removalMarker(rec('1-k')));
    const rep = touchedBy([vanilla, a, b], '1-k');
    expect(rep.base?.floats.get('cut')).toBe(1);
    expect(rep.touches.map((t) => [t.layer, t.removes, t.creates, t.fields.map((f) => `${f.id}=${f.value}`)])).toEqual([
      ['A.mod', false, false, ['name="Катана"', 'floats:cut=1.5']],
      ['B.mod', true, false, ['record=удалить']],
    ]);
    expect(formatTouches(rep).join('\n')).toContain('DELETES');
    expect(formatTouches(rep, undefined, 'ru').join('\n')).toContain('УДАЛЯЕТ');
    expect(touchedBy([vanilla], '1-k').touches).toEqual([]);
  });
});
